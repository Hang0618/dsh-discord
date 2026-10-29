// dsh-discord：在 Discord 私聊里跟 DSH 里的助手聊天。
//
// 结构很小，四件事：
//   1. Gateway 收消息 → 白名单校验 → 变成 UserMessage → agent.followup
//   2. agent 的 assistant-stream 增量 → 编辑同一条 Discord 消息（流式）
//   3. 固定 SessionId → 记忆、人设跟 GUI 那边共用同一套
//   4. /new /stop /status 三个小命令，别的一律当聊天
//
// 安全：只认 ownerIds 里的人；只（默认）响应私聊；token 只从配置文件读，
// 不写进源码、不进日志、不回显。

import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { resolveConfig, resolveBudget, INTENTS, DEFAULT_CONFIG_PATH } from './config.js'
import { DiscordRest } from './rest.js'
import { DiscordGateway } from './gateway.js'
import { StreamWriter } from './outbound.js'
import { acquireAgent, seedMemory, neutralizeOwnerName } from './session.js'
import { createConsentDesk } from './consent.js'
import { createBudgetDesk, costOf } from './budget.js'
import { log as writeLog } from './log.js'

export const name = 'dsh-discord'
// agentDefaultModel 必须 inject：否则 ctx.agentDefaultModel 是 undefined，
// create 出来的 agent 没有 model，prompt 里的 {{model}} 变量组装失败、整轮报错。
export const inject = ['agents', 'agentDefaultModel', 'agentPresets']

/** 日志里带版本号，方便确认热重载到底有没有换成新代码 */
const VERSION = '0.4.1'

const HELP_TEXT = [
  '**我在呢。** 直接说话就行，别的都不用管。',
  '',
  '私聊里随便说；服务器里 @ 我，或者主人在群里提到我，我才接话。',
  '`/new` 开一段新对话（记忆还在，只是上下文重来）',
  '`/stop` 打断我正在打的字',
  '`/status` 看现在用的模型和会话',
].join('\n')

export function apply(ctx, config = {}) {
  const log = (...parts) => writeLog(...parts)
  const cfg = resolveConfig(config, log)

  if (!cfg.token) {
    log('🔴 没有 bot token —— 在 discord-bridge.json 里填 token，或设 DISCORD_BOT_TOKEN')
    return
  }

  const rest = new DiscordRest({ token: cfg.token, log })

  /** 陌生人准入台：只在服务器里有人 @ 我时用得上 */
  const consentDesk = createConsentDesk({ cfg, log })

  /** 余额预算台：全局 / 私聊 / 某个服务器各一条线，跌破了就先闭嘴 */
  const budgetDesk = createBudgetDesk({ cfg, ctx, log })

  /** 把设置写回 discord-bridge.json（准入表 + 余额预算 + 见过的服务器名，保留文件里别的字段）。 */
  function persistAccess() {
    try {
      let raw = {}
      try {
        raw = JSON.parse(readFileSync(cfg.configPath, 'utf8'))
        if (!raw || typeof raw !== 'object') raw = {}
      } catch (error) {
        if (error?.code !== 'ENOENT') log(`读配置文件失败，只重写准入表：${error.message}`)
      }
      raw.grants = cfg.grants
      raw.botPolicy = cfg.botPolicy
      raw.budget = cfg.budget
      raw.spend = cfg.spend
      raw.guildNames = cfg.guildNames
      const tmp = `${cfg.configPath}.tmp`
      writeFileSync(tmp, JSON.stringify(raw, null, 2), 'utf8')
      renameSync(tmp, cfg.configPath)
      log('准入名单已落盘')
    } catch (error) {
      log(`准入名单落盘失败：${error?.message || error}`)
    }
  }
  /**
   * GUI 侧的确认接口：/api/dsh-discord/pending 看有没有人在等，
   * /api/dsh-discord/decide 拍板。只给本机（GUI 同源）用。
   */
  function installConsentRoutes() {
    const sendJson = (res, status, payload) => {
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      res.end(JSON.stringify(payload))
    }
    const readBody = (req) =>
      new Promise((resolve) => {
        let raw = ''
        req.on('data', (chunk) => {
          raw += chunk
          if (raw.length > 64 * 1024) req.destroy()
        })
        req.on('end', () => {
          try {
            resolve(JSON.parse(raw || '{}'))
          } catch {
            resolve({})
          }
        })
        req.on('error', () => resolve({}))
      })
    const isLocal = (req) => {
      const addr = String(req.socket?.remoteAddress || '')
      return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
    }

    ctx.inject(['webServer'], (scoped) => {
      const server = scoped.webServer
      scoped.effect(
        () =>
          server.register({
            kind: 'prefix',
            path: '/api/dsh-discord',
            handler: (req, res) => {
              void (async () => {
                if (!isLocal(req)) return sendJson(res, 403, { ok: false, error: '仅限本机' })
                const url = new URL(req.url ?? '/', 'http://localhost')
                const action = url.pathname.slice('/api/dsh-discord'.length).replace(/\/+$/, '') || '/'
                const method = String(req.method || 'GET').toUpperCase()

                if (action === '/pending' && method === 'GET') {
                  return sendJson(res, 200, { ok: true, pending: consentDesk.list() })
                }
                if (action === '/grants' && method === 'GET') {
                  return sendJson(res, 200, {
                    ok: true,
                    grants: cfg.grants,
                    botPolicy: cfg.botPolicy,
                  })
                }
                if (action === '/decide' && method === 'POST') {
                  const body = await readBody(req)
                  const result = consentDesk.decide(body.id, {
                    allow: body.allow === true,
                    requireMention: body.requireMention !== false,
                    chat: body.chat === true,
                  })
                  if (result.ok && result.allow) persistAccess()
                  if (result.ok) {
                    const entry = result.entry
                    let reply
                    if (result.kind === 'bot') {
                      reply = result.allow
                        ? result.policy.chat
                          ? `主人说可以，${entry.userName}，我就来跟你聊两句～`
                          : `主人说先收着你的话，${entry.userName}，但暂时不接话。`
                        : `主人这次不想理你，${entry.userName}。`
                    } else {
                      reply = result.allow
                        ? `主人点头啦，${entry.userName}，我记住你了～`
                        : `主人这次没同意，${entry.userName}，先别戳我啦。`
                    }
                    void rest.sendMessage(entry.channelId, reply).catch(() => {})
                  }
                  return sendJson(res, 200, result)
                }
                if (action === '/revoke' && method === 'POST') {
                  const body = await readBody(req)
                  const revoked = consentDesk.revoke(
                    body.userId,
                    body.kind === 'bot' ? 'bot' : 'user',
                  )
                  if (revoked) persistAccess()
                  return sendJson(res, 200, { ok: true, revoked })
                }
                if (action === '/budget' && method === 'GET') {
                  // 面板 5 秒轮一次，默认只读缓存；显式 ?refresh=1 才真的去问一次账号
                  if (url.searchParams.get('refresh') === '1') await budgetDesk.balance(true)
                  else if (!budgetDesk.status().balance) await budgetDesk.balance(false)
                  else void budgetDesk.balance(false)
                  return sendJson(res, 200, {
                    ok: true,
                    ...budgetDesk.status(),
                    guilds: budgetDesk.guildList(),
                    notice: state.lastPause,
                  })
                }
                if (action === '/budget' && method === 'POST') {
                  const body = await readBody(req)
                  const src = body?.budget && typeof body.budget === 'object' ? body.budget : body || {}
                  const current = cfg.budget || {}
                  cfg.budget = resolveBudget({
                    enabled: typeof src.enabled === 'boolean' ? src.enabled : current.enabled,
                    global: src.global !== undefined ? src.global : current.global,
                    dm: src.dm !== undefined ? src.dm : current.dm,
                    globalQuota:
                      src.globalQuota !== undefined ? src.globalQuota : current.globalQuota,
                    dmQuota: src.dmQuota !== undefined ? src.dmQuota : current.dmQuota,
                    guilds: src.guilds !== undefined ? src.guilds : current.guilds,
                    refreshMs: current.refreshMs,
                    remindMs: current.remindMs,
                  })
                  if (src.guildNames && typeof src.guildNames === 'object') {
                    cfg.guildNames = { ...(cfg.guildNames || {}), ...src.guildNames }
                  }
                  budgetDesk.resetReminders()
                  persistAccess()
                  await budgetDesk.balance(true)
                  const lineText = (v) =>
                    v === null || v === undefined ? '跟全局' : v > 0 ? String(v) : '不限'
                  log(
                    `预算已更新：${cfg.budget.enabled ? '开' : '关'} ` +
                      `余额线 全局=${cfg.budget.global > 0 ? cfg.budget.global : '不限'} ` +
                      `私聊=${lineText(cfg.budget.dm)} ` +
                      `服务器=${Object.keys(cfg.budget.guilds).length} 个；` +
                      `消费额度 全局=${lineText(cfg.budget.globalQuota)} ` +
                      `私聊=${lineText(cfg.budget.dmQuota)}`,
                  )
                  return sendJson(res, 200, {
                    ok: true,
                    ...budgetDesk.status(),
                    guilds: budgetDesk.guildList(),
                    notice: state.lastPause,
                  })
                }
                if (action === '/spend-reset' && method === 'POST') {
                  const body = await readBody(req)
                  const key = typeof body?.key === 'string' && body.key ? body.key : ''
                  budgetDesk.resetSpend(key || undefined)
                  budgetDesk.resetReminders()
                  persistAccess()
                  log(`花费账本已清零${key ? `（${key}）` : '（全部）'}`)
                  return sendJson(res, 200, {
                    ok: true,
                    ...budgetDesk.status(),
                    guilds: budgetDesk.guildList(),
                    notice: state.lastPause,
                  })
                }
                return sendJson(res, 404, { ok: false, error: '没有这个接口' })
              })().catch((error) => {
                log(`准入接口出错：${error?.stack || error}`)
                try {
                  sendJson(res, 500, { ok: false, error: String(error?.message || error) })
                } catch {}
              })
            },
          }),
        'dsh-discord: consent routes',
      )
    })
  }
  installConsentRoutes()

  const writer = new StreamWriter({
    rest,
    chunkLimit: cfg.chunkLimit,
    editIntervalMs: cfg.editIntervalMs,
    stream: cfg.stream,
    log,
  })
  const gateway = new DiscordGateway({
    token: cfg.token,
    intents:
      INTENTS.GUILDS |
      INTENTS.DIRECT_MESSAGES |
      INTENTS.GUILD_MESSAGES |
      INTENTS.MESSAGE_CONTENT,
    log,
    onDispatch,
    onReady: (user) => {
      state.botUserId = user.id
      log(`上线了：${user.username}（${user.id}）`)
    },
    onResumed: () => log('重连完成，继续待命'),
  })

  /** 当前 Discord 侧的状态 */
  const state = {
    agent: null,
    handle: null,
    botUserId: null,
    channelId: null,
    // 这一轮是谁在说话：{ id, name, isOwner, isDM, isBot, guildId } —— 称呼就跟着它走
    speaker: null,
    // 防机器人互刷：botId → { count, since }，人类一说话就清空
    botStreak: new Map(),
    // 已经问过名字的服务器（避免每条消息都打一次 REST）
    guildProbed: new Set(),
    // 排队投喂：主人插队，别人排后面（同一时间只喂一条，保证主人先被回复）
    pending: [],
    pumping: false,
    pumpTimer: null,
    // 最近一次因为余额被暂停的现场，给 DSH 面板弹通知用
    lastPause: null,
    // 这一轮花了多少（累加 assistant/message 的 usage，turn/end 时结算）
    turnCost: 0,
    // 这一轮的花费算在谁头上：{ isDM, guildId }
    chargeScope: null,
    typingTimer: null,
    initPromise: null,
    lastError: null,
    startedAt: Date.now(),
  }

  // 花费记账：Discord 会话每来一次 assistant/message，就按 usage 折算成钱；
  // 到这一轮 turn/end 时结算到当时说话人所在的作用域（私聊 / 某个服务器）。
  ctx.effect(
    () => {
      const off = ctx.on('session/event', (session, event) => {
        try {
          if (!session || session.id !== cfg.sessionId) return
          const type = event?.type
          if (type === 'assistant/message') {
            const usage = event.data?.usage
            if (!usage) return
            const model = event.data?.message?.source?.model || ''
            const { cost } = costOf(usage, model)
            if (cost > 0) state.turnCost += cost
            return
          }
          if (type !== 'turn/end') return
          const cost = state.turnCost
          state.turnCost = 0
          const scope = state.chargeScope
          if (cost <= 0 || !scope) return
          const spent = budgetDesk.addSpend(scope, cost)
          persistAccess()
          const where = scope.isDM ? '私聊' : `服务器 ${scope.guildId || ''}`
          log(`这一轮花了 ${cost.toFixed(6)} 元，${where}累计 ${spent.toFixed(6)} 元`)
        } catch {}
      })
      return () => off?.()
    },
    'dsh-discord: spend metering',
  )

  // ---------- agent 生命周期 ----------

  /** Discord 显示名：服务器昵称 > 全局显示名 > 用户名（都没有就用 id）。 */
  function speakerNameOf(data, fallbackId) {
    const raw =
      data?.member?.nick ||
      data?.author?.global_name ||
      data?.author?.username ||
      fallbackId
    const name = String(raw)
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim()
      .slice(0, 40)
    return name || String(fallbackId)
  }

  /**
   * 把「Discord 专属人设补丁」挂到 agent 的 system prompt 上。
   *
   * 全局 AGENTS.md 对 GUI 和 Discord 是同一份，想只改 Discord 的口味就写进
   * discord-bridge.json 的 systemPromptExtra —— order 排在记忆(900)之后，
   * 相当于最后补一句，优先级最高。
   */
  function injectExtraPrompt(agent) {
    if (!cfg.systemPromptExtra) return
    if (agent.__discordExtraInjected) return
    try {
      const systemPrompt = agent.ctx?.systemPrompt
      if (!systemPrompt?.context) {
        log('拿不到 systemPrompt.context，额外人设没注入（人设还是全局那套）')
        return
      }
      systemPrompt.context({
        name: 'discord-extra',
        order: 950,
        interpolate: false,
        text: cfg.systemPromptExtra,
      })
      agent.__discordExtraInjected = true
      log(`额外人设已注入（${cfg.systemPromptExtra.length} 字）`)
    } catch (error) {
      log(`注入额外人设失败：${error?.message || error}`)
    }
  }

  /**
   * 「这一轮跟你说话的是谁」—— 挂成 systemPrompt.context，追加在对话末尾。
   *
   * 为什么不能写进 fish-memory 的会话称呼：一个 Discord 会话里主人和别人共用
   * 同一段上下文，会话级称呼只可能是某一个人的，钉死「主人」就会在服务器里
   * 叫错人（2026-10-29 用户反馈）。所以称呼跟着**每条消息的说话人**走。
   *
   * 用 context 而不是 section：context 只在内容真的变了才追加一条，
   * 换个说话人才刷一次，不会每轮把系统提示词的缓存全废掉。
   */
  function speakerPromptText() {
    const s = state.speaker
    if (!s) return ''
    if (s.isBot) {
      // 机器人说话：主人已经批准过才走到这儿。不是人、更不是主人
      return (
        `【Discord】现在是服务器频道，跟你说话的是机器人账号「${s.name}」` +
        `——不是人，也不是主人。主人批准过跟它聊，回它简短、直接一点，` +
        `别叫它「主人」，也别把它当成主人。`
      )
    }
    if (s.isDM) {
      // 私聊本来就只认主人 —— 保持原来的称呼
      return '【Discord】现在是私聊，对面是主人本人。照旧叫他「主人」。'
    }
    if (s.isOwner) {
      // 主人本人的称呼**永远不改**：私聊、服务器都照旧叫「主人」（2026-10-29 他亲口定的）
      return (
        `【Discord】现在是服务器频道（公开场合），跟你说话的是主人本人` +
        `（Discord 昵称「${s.name}」）。照旧叫他「主人」——主人怎么称呼都不变；` +
        `只有别人搭话时才用对方的 Discord 昵称。`
      )
    }
    return (
      `【Discord】现在是服务器频道（公开场合），跟你说话的是服务器成员「${s.name}」` +
      `——不是主人，只是主人批准过可以跟你聊天的人。回话直接叫他「${s.name}」，` +
      `绝对不要叫「主人」，也别把他当成主人。`
    )
  }

  function injectSpeakerPrompt(agent) {
    if (agent.__discordSpeakerInjected) return
    try {
      const systemPrompt = agent.ctx?.systemPrompt
      if (!systemPrompt?.context) {
        log('拿不到 systemPrompt.context，说话人称呼没注入（可能还会叫「主人」）')
        return
      }
      systemPrompt.context({
        name: 'discord-speaker',
        // ⚠ order 必须排到 DSH 自己的人设／工具说明之后（那些段一直排到 10200），
        //   否则全局人设里的「用户是主人」会压过这里，服务器里还是叫「主人」。
        //   取 20000：在 persona(≤10200) 之后、fish-memory(89990) 之前。
        order: 20000,
        interpolate: false, // 昵称里可能有 {{ }}，别让宿主当模板解析
        text: speakerPromptText,
      })
      agent.__discordSpeakerInjected = true
      log('说话人称呼已挂上（每轮按当前说话人取 Discord 昵称）')
    } catch (error) {
      log(`注入说话人称呼失败：${error?.message || error}`)
    }
  }

  async function ensureReady() {
    if (state.agent) return state.agent
    if (state.initPromise) return state.initPromise
    state.initPromise = (async () => {
      if (cfg.seedMemory && cfg.seedMemoryFrom) {
        seedMemory({ fromSession: cfg.seedMemoryFrom, toSession: cfg.sessionId, log })
      }
      // 老版本把称呼写死成「主人」并落盘了，这里顺手洗掉（幂等）
      neutralizeOwnerName(cfg.sessionId, log)
      const { agent, handle } = await acquireAgent(ctx, cfg, log)
      state.agent = agent
      state.handle = handle
      state.lastError = null
      injectExtraPrompt(agent)
      injectSpeakerPrompt(agent)
      log(
        `agent 就绪（${cfg.sessionId}），状态：${agent.status} ` +
          `模型：${agent.options?.provider || '?'}/${agent.options?.model || '?'}`,
      )
      return agent
    })()
      .catch((error) => {
        state.lastError = error
        log(`agent 起不来：${error?.stack || error?.message || error}`)
        throw error
      })
      .finally(() => {
        state.initPromise = null
      })
    return state.initPromise
  }

  /**
   * /new：真的开一段新会话（新 SessionId）。
   *
   * ⚠️ 以前这里只是 dispose + resume **同一个** sessionId —— 持久化的上下文原样读回来，
   * 等于什么都没清。现在换 id：旧会话留盘上不动，新会话把记忆文件复制一份过去，
   * 于是「记忆还在、上下文从头」，并把新 id 写回配置，重启也接着用。
   */
  async function startFreshSession() {
    const old = state.agent
    const oldHandle = state.handle
    state.agent = null
    state.handle = null
    try {
      old?.cancel?.({ kind: 'user' })
    } catch {}
    try {
      await oldHandle?.dispose?.()
    } catch (error) {
      log(`销毁旧会话失败：${error?.message || error}`)
    }
    writer.reset()

    const from = cfg.sessionId
    // 固定前缀 + 时间戳，避免 /new 几次之后 id 越拼越长
    const base = from.split('-').slice(0, 2).join('-') || 'session-discord'
    const next = `${base}-${Date.now().toString(36)}`
    seedMemory({ fromSession: from, toSession: next, log })
    cfg.sessionId = next
    persistSessionId(next)
    await ensureReady()
    return next
  }

  /** 把新 sessionId 写回 discord-bridge.json（原子写，其它字段原样保留）。 */
  function persistSessionId(sessionId) {
    try {
      const path = DEFAULT_CONFIG_PATH
      if (!existsSync(path)) return
      const raw = JSON.parse(readFileSync(path, 'utf8')) || {}
      raw.sessionId = sessionId
      const tmp = `${path}.tmp`
      writeFileSync(tmp, JSON.stringify(raw, null, 2), 'utf8')
      renameSync(tmp, path)
      log(`sessionId 已写回配置：${sessionId}`)
    } catch (error) {
      log(`写回 sessionId 失败（重启后会回到旧会话）：${error?.message || error}`)
    }
  }

  async function restartAgent() {
    const old = state.agent
    const oldHandle = state.handle
    state.agent = null
    state.handle = null
    try {
      old?.cancel?.({ kind: 'user' })
    } catch {}
    try {
      await oldHandle?.dispose?.()
    } catch (error) {
      log(`销毁旧会话失败：${error?.message || error}`)
    }
    writer.reset()
    return ensureReady()
  }

  // ---------- typing ----------

  function startTyping(channelId) {
    if (!cfg.typing) return
    stopTyping()
    void rest.sendTyping(channelId)
    state.typingTimer = setInterval(() => void rest.sendTyping(channelId), 8000)
  }

  function stopTyping() {
    if (state.typingTimer) {
      clearInterval(state.typingTimer)
      state.typingTimer = null
    }
  }

  // ---------- 服务器名字（面板里显示得好看些）----------

  function rememberGuildName(guildId) {
    const id = String(guildId || '')
    if (!id) return
    const names = (cfg.guildNames ||= {})
    if (names[id] || state.guildProbed.has(id)) return
    state.guildProbed.add(id)
    void rest
      .request('GET', `/guilds/${id}`)
      .then((guild) => {
        if (!guild?.name) return
        cfg.guildNames[id] = String(guild.name)
        persistAccess()
        log(`记下服务器名字：${cfg.guildNames[id]}（${id}）`)
      })
      .catch(() => {})
  }

  // ---------- 出站：assistant-stream ----------

  const offStream = ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    if (!state.agent || agent !== state.agent) return
    if (!state.channelId) return

    if (frame.type === 'start') {
      writer.beginAttempt(frame.turn, frame.step)
      stopTyping()
      return
    }

    if (frame.type === 'chunk') {
      const chunk = frame.chunk
      if (chunk && chunk.type === 'text-delta' && chunk.text) writer.push(chunk.text)
      return
    }

    if (frame.type === 'end') {
      void writer.endAttempt().catch((error) => log(`收尾失败：${error?.message || error}`))
    }
  })

  // agent 回到 idle：停 typing，收掉还没推上去的尾巴
  const offStatus = ctx.on('agent/status', ({ agent, status }) => {
    if (!state.agent || agent !== state.agent) return
    log(`agent 状态：${status}`)
    if (status === 'idle') {
      stopTyping()
      void writer.endTurn().catch(() => {})
    } else if (status === 'running') {
      if (state.channelId) startTyping(state.channelId)
    }
  })

  // 一轮出错（比如模型没配好、prompt 变量缺值）：至少让人知道自己被听见了
  const offSession = ctx.on('session/event', (session, event) => {
    if (!state.agent || session !== state.agent.session) return
    if (event?.type !== 'turn/end') return
    const reason = event.data?.reason
    if (reason?.kind !== 'error') return
    const message = reason.error?.message || '未知错误'
    log(`turn 出错：${message}`)
    if (state.channelId && !writer.producedAnyText) {
      void rest
        .sendMessage(state.channelId, `我这轮卡住了：\`${message.slice(0, 300)}\``)
        .catch(() => {})
    }
  })

  // ---------- 入站：MESSAGE_CREATE ----------

  /** 去掉 mention 标记、只留文字；命令判定和「是不是空消息」用它。 */
  function cleanContent(raw) {
    return String(raw || '')
      .replace(/<@!?(\d+)>/g, '')
      .trim()
  }

  /**
   * 投喂给模型的内容：把 <@id> / <@!id> 换成 @显示名，让我知道在跟谁说话。
   * cleanContent 会把 mention 整个抹掉，模型就永远看不到「@了谁」——主人指认人时全靠这个。
   * 顺带把「回复/引用」到的那条消息也带进来，不然模型只看得到「你看！」看不到「看什么」。
   */
  function renderContent(data) {
    const raw = String(data?.content || '')
    const names = new Map()
    for (const user of Array.isArray(data?.mentions) ? data.mentions : []) {
      const id = String(user?.id || '')
      if (!id) continue
      names.set(id, String(user.global_name || user.username || id).slice(0, 40))
    }
    if (state.botUserId && names.has(String(state.botUserId))) {
      names.set(String(state.botUserId), '你')
    }
    const body = raw
      .replace(/<@!?(\d+)>/g, (whole, id) => (names.has(id) ? `@${names.get(id)}` : whole))
      .trim()
    const quoted = renderQuoted(data, names)
    return body ? `${quoted ? `${quoted}\n` : ''}${body}` : quoted
  }

  /** 被「回复/引用」的那条消息，渲染成一行带进上下文。 */
  function renderQuoted(data, names) {
    const ref = data?.referenced_message
    if (!ref) {
      return data?.message_reference?.message_id
        ? '[回复了一条已经删掉、或者我看不到的消息]'
        : ''
    }
    const refAuthorId = String(ref.author?.id || '')
    const isMe = Boolean(state.botUserId && refAuthorId === String(state.botUserId))
    // 引用消息自己的 mentions 里才有它 @ 过的人（当前消息的 mentions 未必包含）
    const refNames = new Map(names)
    for (const user of Array.isArray(ref.mentions) ? ref.mentions : []) {
      const id = String(user?.id || '')
      if (!id) continue
      refNames.set(id, String(user.global_name || user.username || id).slice(0, 40))
    }
    if (state.botUserId && refNames.has(String(state.botUserId))) {
      refNames.set(String(state.botUserId), '你')
    }
    const name = isMe
      ? '你'
      : names.get(refAuthorId) ||
        String(ref.author?.global_name || ref.author?.username || refAuthorId || '某人')
    const text = String(ref.content || '')
      .replace(/<@!?(\d+)>/g, (whole, id) => (refNames.has(id) ? `@${refNames.get(id)}` : whole))
      .trim()
    const clipped = text.length > 500 ? `${text.slice(0, 500)}…` : text
    return `[回复 / 引用了 ${name} 的消息：「${clipped || '（没有文字，可能只是图片或附件）'}」]`
  }

  function makeUserMessage(text) {
    return Object.freeze({
      id: randomUUID(),
      role: 'user',
      content: Object.freeze([{ type: 'text', text }]),
      source: Object.freeze({ kind: 'user' }),
    })
  }

  // ---------- 投喂队列：主人优先 ----------

  const FLUSH_DELAY_MS = 500
  const MAX_PENDING = 8
  const NON_OWNER_TTL_MS = 120_000

  /** 塞进队列：主人的话插到所有别人的话前面，别人的排后面。 */
  function enqueueChat(job) {
    job.at = Date.now()
    if (job.isOwner) {
      const idx = state.pending.findIndex((item) => !item.isOwner)
      if (idx === -1) state.pending.push(job)
      else state.pending.splice(idx, 0, job)
    } else {
      state.pending.push(job)
    }
    // 积压太多就丢别人的话，主人的一条都不丢
    while (state.pending.length > MAX_PENDING) {
      const idx = state.pending.findIndex((item) => !item.isOwner)
      const [dropped] = state.pending.splice(idx === -1 ? state.pending.length - 1 : idx, 1)
      log(
        `排队太多，先丢掉一条${dropped?.isOwner ? '主人的' : '别人的'}：` +
          `「${String(dropped?.content ?? '').slice(0, 20)}」`,
      )
    }
    scheduleFlush()
  }

  /** 攒一下再一起处理，这样「同时说话」时能按优先级排序。 */
  function scheduleFlush() {
    if (state.pumpTimer) return
    state.pumpTimer = setTimeout(() => {
      state.pumpTimer = null
      void flushQueue()
    }, FLUSH_DELAY_MS)
    state.pumpTimer.unref?.()
  }

  /** 等 agent 把手上这轮忙完（最多 timeoutMs），避免两个人在同一轮里抢话。 */
  async function waitAgentIdle(timeoutMs) {
    const deadline = Date.now() + timeoutMs
    const startedAt = Date.now()
    while (Date.now() < deadline) {
      const agent = state.agent
      if (!agent) return true
      // 刚投喂的 1.5 秒内不算空闲——不然还没起步就被判成「已经结束」
      if (agent.status !== 'running' && Date.now() - startedAt > 1500) return true
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    return false
  }

  async function flushQueue() {
    if (state.pumping) return
    state.pumping = true
    try {
      while (state.pending.length > 0) {
        const job = state.pending[0]
        if (!job.isOwner && Date.now() - job.at > NON_OWNER_TTL_MS) {
          state.pending.shift()
          log('别人的话排太久了（超过 2 分钟），先跳过')
          continue
        }
        const idle = await waitAgentIdle(15 * 60_000)
        if (!idle) log('等 agent 忙完超时，先继续排下一条')
        // 等的过程中可能又插进来主人的话，重新挑队首
        if (state.pending[0] !== job) continue
        state.pending.shift()
        await deliver(job)
      }
    } finally {
      state.pumping = false
      if (state.pending.length > 0) scheduleFlush()
    }
  }

  async function deliver(job) {
    const { content, channelId, isDM, speaker, replyToId } = job
    state.speaker = speaker
    state.channelId = channelId
    // 这一轮的花费记到谁头上（私聊 / 某个服务器）
    state.chargeScope = { isDM, guildId: speaker?.guildId ?? null }
    state.turnCost = 0
    writer.setTarget(channelId, cfg.replyToUser ? replyToId : null)
    try {
      const agent = await ensureReady()
      if (agent.status !== 'running') startTyping(channelId)
      agent.followup(makeUserMessage(content))
      log(
        `已投喂 agent（status=${agent.status}，${job.isOwner ? '主人' : '别人'}）：` +
          `「${content.slice(0, 40)}」`,
      )
    } catch (error) {
      stopTyping()
      await rest
        .sendMessage(
          channelId,
          `我还没接通：${error?.message || error}\n（看 \`discord-bridge.log\` 里最新的几行）`,
        )
        .catch(() => {})
    }
  }

  async function onMessageCreate(data) {
    if (!data || !data.author) return
    log(
      `收到消息：author=${data.author.id}(bot=${Boolean(data.author.bot)}) ` +
        `guild=${data.guild_id || 'DM'} channel=${data.channel_id} 内容长度=${String(data.content || '').length}`,
    )
    const senderId = String(data.author.id)
    const isBot = Boolean(data.author.bot)
    if (isBot && state.botUserId && String(state.botUserId) === senderId) {
      log('忽略：自己发的')
      return
    }

    const channelId = data.channel_id
    const isDM = !data.guild_id
    const isOwner = cfg.ownerIds.includes(senderId)
    const rawContent = String(data.content || '')
    const botMentioned = state.botUserId
      ? new RegExp(`<@!?${state.botUserId}>`).test(rawContent)
      : false
    const otherMentions = [...rawContent.matchAll(/<@!?(\d+)>/g)]
      .map((match) => match[1])
      .filter((id) => id !== String(state.botUserId))
    // 「回复/引用」的那条消息，网关偶尔不带完整内容（被删、或暂时缺字段）——补拉一次，
    // 不然引用回复就变成睁眼瞎：只知道「回复了」，不知道「回复的是哪句」。
    if (!data.referenced_message && data.message_reference?.message_id && channelId) {
      try {
        data.referenced_message = await rest.request(
          'GET',
          `/channels/${channelId}/messages/${data.message_reference.message_id}`,
        )
      } catch (error) {
        log(`补拉被引用的消息失败：${error?.status || ''} ${error?.message || error}`)
      }
    }
    // 用 Discord 的「回复/引用」功能回了我某条消息 —— 就算没 @ 也算在跟我说话
    const referenced = data.referenced_message
    const repliesToBot = Boolean(
      referenced && state.botUserId && String(referenced.author?.id) === String(state.botUserId),
    )
    if (repliesToBot) log('这条是引用回复我的消息（不用 @ 也算）')

    // 渠道闸门：私聊只认主人；群聊默认关，开了才进
    if (isDM) {
      if (!isOwner) {
        log('忽略：私聊只认主人')
        return
      }
    } else {
      if (!cfg.guildChat || cfg.dmOnly) {
        log('忽略：群聊没开（guildChat=false 或 dmOnly=true）')
        return
      }
      if (cfg.allowedGuildIds.length > 0 && !cfg.allowedGuildIds.includes(String(data.guild_id))) {
        log('忽略：这个服务器不在 allowedGuildIds 里')
        return
      }
    }

    // 人类一说话，机器人连聊计数就归零（防两个 bot 互相刷屏）
    if (!isBot) state.botStreak.clear()

    // 机器人发言：先让主人拍板「收不收」「要不要继续聊」，同一个 bot 只问一次
    if (isBot) {
      const policy = consentDesk.botPolicyOf(senderId)
      if (!policy) {
        const { entry, fresh } = consentDesk.request({
          kind: 'bot',
          userId: senderId,
          userName: data.author.global_name || data.author.username || senderId,
          guildId: data.guild_id,
          channelId,
          messageId: data.id,
          snippet: cleanContent(data.content),
        })
        if (fresh) {
          await rest
            .sendMessage(
              channelId,
              // 故意不 @ 它：@ 可能把对方 bot 叫醒，两个 bot 就自己聊起来了
              `有个机器人「${speakerNameOf(data, senderId)}」在说话，要不要理它？我先去问主人～`,
            )
            .catch(() => {})
        }
        log(`等主人确认（机器人）：${entry.userName}（${senderId}）`)
        return
      }
      if (!policy.chat) {
        log(`忽略：主人只让收着机器人的话，不接话（${policy.name}）`)
        return
      }
      // 别的机器人：只有明确对着我说话（@我 / 引用我）才接。
      // 它们互相聊天、或者点名别人时我不凑热闹——否则三个 bot 会开茶话会。
      if (!botMentioned && !repliesToBot) {
        log(`忽略：机器人 ${policy.name} 没点名我，不凑热闹（${senderId}）`)
        return
      }
      const streak = state.botStreak.get(senderId) || { count: 0, since: Date.now() }
      if (Date.now() - streak.since > 5 * 60_000) {
        streak.count = 0
        streak.since = Date.now()
      }
      if (streak.count >= 4) {
        log(`机器人 ${policy.name} 已经连聊 ${streak.count} 轮，先停一停防互刷`)
        state.botStreak.set(senderId, streak)
        return
      }
      streak.count += 1
      state.botStreak.set(senderId, streak)
      log(`主人批准过跟机器人 ${policy.name} 聊（本轮第 ${streak.count} 条），继续处理`)
    }

    // 主人 @ 别人 = 主动把这个人指给我看（介绍/指认/让他搭话），要放行；
    // 别人 @ 别人 = 在跟别人聊天，我不插嘴。
    const ownerHandsOver =
      !isDM && isOwner && otherMentions.length > 0 && !botMentioned && !repliesToBot
    if (ownerHandsOver) {
      log(`主人 @ 了别人（${otherMentions.join(',')}），算在跟我说话`)
    }
    if (!isDM && !isBot && !isOwner && otherMentions.length > 0 && !botMentioned && !repliesToBot) {
      log(`有人 @ 了别人，不插话（sender=${senderId}）`)
      return
    }

    // 群里的外部用户：必须先批准。
    // 「每次都要 @」= 必须 @ 或引用；「不用每次 @」= @/引用之外，叫到 triggerWords 里的名字也行。
    // 但都不再「随便说一句就接」——不然群里两个人聊天，我句句都要回一嘴。
    if (!isDM && !isOwner && !isBot) {
      const grant = consentDesk.grantOf(senderId)
      const addressed = botMentioned || repliesToBot
      const named =
        Boolean(grant) &&
        grant.requireMention === false &&
        cfg.triggerWords.some(
          (word) => word && cleanContent(data.content).toLowerCase().includes(word.toLowerCase()),
        )
      const canChat = Boolean(grant) && (addressed || named)
      if (!canChat) {
        if (!addressed) {
          log(`忽略：没叫我（${grant ? '批准过但没叫' : '陌生人'}，sender=${senderId}）`)
          return
        }
        const content = cleanContent(data.content)
        const { entry, fresh } = consentDesk.request({
          userId: senderId,
          userName: data.author.global_name || data.author.username || senderId,
          guildId: data.guild_id,
          channelId,
          messageId: data.id,
          snippet: content,
        })
        if (fresh) {
          await rest
            .sendMessage(
              channelId,
              `主人还没决定要不要让我跟 <@${senderId}> 聊天，我先去问一下～`,
            )
            .catch(() => {})
        }
        log(`等主人确认：${entry.userName}（${senderId}）`)
        return
      }
    }

    // 命令只认主人：群里获批的人也不能用 /new /stop 这些
    if (!isOwner && cleanContent(data.content).startsWith('/')) {
      log('忽略：非主人发的命令')
      return
    }

    // 主人的群聊：没 @ 我、没引用我、也没提到关键词，就安静待着
    if (!isDM && isOwner && !botMentioned && !repliesToBot && !ownerHandsOver) {
      const content = cleanContent(data.content)
      const hit = cfg.triggerWords.some(
        (word) => word && content.toLowerCase().includes(word.toLowerCase()),
      )
      if (!hit) {
        log('群里没提到我，不插话')
        return
      }
      log('主人提到了关键词，主动插一句')
    }

    state.channelId = channelId
    if (!isDM) rememberGuildName(data.guild_id)
    // 称呼跟着这条消息的说话人走：别人搭话叫昵称，主人本人在群里也叫昵称
    state.speaker = {
      id: senderId,
      name: speakerNameOf(data, senderId),
      isOwner,
      isDM,
      isBot,
      guildId: data.guild_id ? String(data.guild_id) : null,
    }
    const content = renderContent(data)
    const command = cleanContent(data.content)

    // 纯附件（图片/文件）：一期不处理，明确回一句（只对主人/私聊，群里别刷屏）
    const hasAttachments = Array.isArray(data.attachments) && data.attachments.length > 0
    if (!content) {
      if (hasAttachments && (isOwner || isDM)) {
        await rest.sendMessage(channelId, '图片和文件我还看不懂啦，先跟我说话嘛。')
      }
      return
    }

    // 命令只认主人：群里别人发 /stop 不能把我停了
    if (isOwner && (command === '/help' || command === '/开始')) {
      await rest.sendMessage(channelId, HELP_TEXT)
      return
    }

    if (isOwner && command === '/status') {
      const status = state.agent?.status || 'offline'
      const model = state.agent?.options
        ? `${state.agent.options.provider}/${state.agent.options.model}`
        : '未连接'
      const bal = await budgetDesk.balance(false)
      const line = budgetDesk.thresholdOf({ isDM, guildId: state.speaker?.guildId })
      const quota = budgetDesk.quotaOf({ isDM, guildId: state.speaker?.guildId })
      const spent = budgetDesk.spendOf({ isDM, guildId: state.speaker?.guildId })
      const budgetLine =
        bal.ok
          ? `余额：\`${bal.total} ${bal.currency || 'CNY'}\`（${line.label}的线 ${line.min || '不限'}）`
          : `余额：读不到（${bal.error || '原因未知'}）`
      const quotaLine = `已花：\`${Number(spent).toFixed(4)} ${bal.currency || 'CNY'}\`（额度 ${quota.quota || '不限'}）`
      await rest.sendMessage(
        channelId,
        `**状态**\n会话：\`${cfg.sessionId}\`\n模型：\`${model}\`\nagent：\`${status}\`\n记忆：${cfg.seedMemory ? '已过继（首次启动）' : '未预置'}\n${budgetLine}\n${quotaLine}`,
      )
      return
    }

    if (isOwner && command === '/stop') {
      try {
        state.agent?.cancel?.({ kind: 'user' })
      } catch {}
      await writer.abort('已停止')
      stopTyping()
      await rest.sendMessage(channelId, '好——我停了。')
      return
    }

    if (isOwner && command === '/new') {
      try {
        const next = await startFreshSession()
        await rest.sendMessage(
          channelId,
          `开了段新的（\`${next}\`）。记忆我还留着，上下文从头来。`,
        )
      } catch (error) {
        await rest.sendMessage(channelId, `换新上下文没成功：${error?.message || error}`)
      }
      return
    }

    // 余额预算：跌到主人画的那条线以下就先闭嘴，别再烧 token
    const budgetGate = await budgetDesk.check({ isDM, guildId: state.speaker.guildId })
    if (budgetGate.paused) {
      const fromText =
        budgetGate.from === 'own' ? '专属线' : budgetGate.from === 'global' ? '全局线' : '不限'
      const quotaText =
        budgetGate.quotaFrom === 'own'
          ? '专属额度'
          : budgetGate.quotaFrom === 'global'
            ? '全局额度'
            : '不限'
      const byQuota = budgetGate.reason === 'quota'
      log(
        byQuota
          ? `花费到额度暂停：${budgetGate.label} 已花 ${budgetGate.spent} ` +
              `≥ 额度 ${budgetGate.quota}（${quotaText}）`
          : `余额不足暂停：${budgetGate.label} 余额 ${budgetGate.total} ${budgetGate.currency} ` +
              `≤ 线 ${budgetGate.min}（${fromText}）`,
      )
      // 记下现场，DSH 面板会轮询这个字段弹通知。
      // 同一个地方连续停着就别刷时间戳，免得前端每 15 秒弹一次。
      const prevPause = state.lastPause
      const sameSpot =
        prevPause &&
        prevPause.key === budgetGate.key &&
        prevPause.reason === budgetGate.reason &&
        Date.now() - Number(prevPause.at || 0) < 10 * 60_000
      state.lastPause = {
        at: sameSpot ? prevPause.at : Date.now(),
        reason: budgetGate.reason,
        key: budgetGate.key,
        label: budgetGate.label,
        total: budgetGate.total,
        currency: budgetGate.currency,
        min: budgetGate.min,
        from: budgetGate.from,
        quota: budgetGate.quota,
        quotaFrom: budgetGate.quotaFrom,
        spent: budgetGate.spent,
      }
      if (budgetDesk.shouldRemind(budgetGate.key)) {
        const text = byQuota
          ? `我先歇一下——主人给${budgetGate.label}划的花费额度是 ` +
            `**${budgetGate.quota} ${budgetGate.currency}**，已经花掉 **${budgetGate.spent} ${budgetGate.currency}** 了。` +
            `要把账本清零、或者把额度调大，我才会接着说。`
          : `我先歇一下——余额只剩 **${budgetGate.total} ${budgetGate.currency}**，` +
            `主人给${budgetGate.label}画的线是 **${budgetGate.min} ${budgetGate.currency}**。` +
            `充值以后我自己就醒，不用叫。`
        await rest.sendMessage(channelId, text).catch(() => {})
      }
      return
    }

    // 普通聊天：先排队，主人优先（同一时间只喂一条，别人不能插在主人前面）
    enqueueChat({
      content,
      channelId,
      isDM,
      isOwner,
      speaker: state.speaker,
      replyToId: data.id,
    })
  }

  const seenDispatches = new Set()
  function onDispatch(type, data) {
    if (type === 'MESSAGE_CREATE') {
      void onMessageCreate(data).catch((error) => log(`处理消息出错：${error?.stack || error}`))
      return
    }
    if (type === 'READY') return
    if (type === 'INTERACTION_CREATE') {
      // 一期没做按钮；留着这个分支，以后审批/提问走这里
      return
    }
    if (!seenDispatches.has(type)) {
      seenDispatches.add(type)
      log(`收到 dispatch：${type}`)
    }
  }

  // ---------- 启动 ----------

  ctx.effect(() => {
    void ensureReady()
      .then(() => gateway.start())
      .catch((error) => {
        log(`启动失败（先起网关，消息来了会重试）：${error?.message || error}`)
        gateway.start()
      })

    return () => {
      log('插件卸载，收工')
      stopTyping()
      writer.reset()
      offStream?.()
      offStatus?.()
      offSession?.()
      gateway.stop()
      try {
        state.agent?.cancel?.({ kind: 'user' })
      } catch {}
      try {
        state.handle?.dispose?.()
      } catch {}
    }
  })

  log(
    `dsh-discord v${VERSION} 已加载：owner=${cfg.ownerIds.join(',') || '（未配置，谁都不理）'} ` +
      `dmOnly=${cfg.dmOnly} 群聊=${cfg.guildChat ? '开' : '关'} ` +
      `已批准=${Object.keys(cfg.grants).length} 人/机器人=${Object.keys(cfg.botPolicy).length} 会话=${cfg.sessionId} 预设=${cfg.agentPreset || '（无）'} cwd=${cfg.cwd}` +
      ` 余额线=${cfg.budget.enabled ? `全局:${cfg.budget.global || '不限'}/私聊:${cfg.budget.dm === null || cfg.budget.dm === undefined ? '跟全局' : cfg.budget.dm || '不限'}/服务器:${Object.keys(cfg.budget.guilds).length}个` : '关'}`,
  )
  // 诊断：列一下这个 profile 里注册了哪些 preset，确认要用的那个真的存在
  void (async () => {
    try {
      const rows = (await ctx.agentPresets?.list?.()) || []
      log(`可用预设：${rows.map((r) => r.id).join(', ') || '（一个都没有）'}`)
    } catch (error) {
      log(`列预设失败：${error?.message || error}`)
    }
  })()
  // 诊断：agent-instructions 依赖 fs 服务 + workingDirectory.ensure(agent) 拿 cwd，
  // 任何一环拿不到就静默不注入 AGENTS.md（人设丢失就是这个原因）
  void (async () => {
    try {
      await ensureReady()
      const fsSvc = typeof ctx.get === 'function' ? ctx.get('fs') : undefined
      const wd = typeof ctx.get === 'function' ? ctx.get('workingDirectory') : undefined
      log(`诊断：fs=${fsSvc ? '有' : '无'} workingDirectory=${wd ? '有' : '无'}`)
      if (wd && state.agent) {
        const cwd = await wd.ensure(state.agent)
        log(`诊断：agent cwd = ${cwd}`)
      }
      // 看 standard preset 到底挂了哪些插件（agent-instructions 在不在里面）
      try {
        const preset = await ctx.agentPresets?.resolve?.('standard')
        log(`诊断：preset standard = ${JSON.stringify(preset).slice(0, 1200)}`)
      } catch (error) {
        log(`诊断：resolve preset 失败：${error?.message || error}`)
      }
      // 关键：agent 的 ctx 到底绑没绑上 preset（没绑 = 插件都没挂 = 人设/记忆全无）
      try {
        const bound = ctx.agentPresets?.composedPreset?.(state.agent?.ctx)
        log(`诊断：agent 实际绑定的 preset = ${bound ?? '（没有绑定！）'}`)
      } catch (error) {
        log(`诊断：composedPreset 失败：${error?.message || error}`)
      }
      // 看 pre-step 是否真的会到 host ctx（waterfall，必须把 next() 还回去）
      const seen = new Set()
      ctx.effect(() => {
        const off = ctx.on('agent/pre-step', async (payload, next) => {
          const sid = payload?.agent?.session?.id
          if (sid && !seen.has(sid)) {
            seen.add(sid)
            log(`诊断：收到 pre-step，session=${sid}`)
          }
          return next()
        })
        return () => off?.()
      })
    } catch (error) {
      log(`诊断失败：${error?.message || error}`)
    }
  })()
}
