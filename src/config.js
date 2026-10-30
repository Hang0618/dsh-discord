// 配置解析：cordis patch 里的 config < 独立配置文件 < 环境变量
//
// 🔴 token 三条铁律：
//   1. **绝不写进插件源码**（插件包以后可能推 GitHub，一推就废号）；
//   2. 优先读 <DSH_HOME>/discord-bridge.json（不进 git、权限收紧）；
//   3. 日志里永远不出现 token。
//
// 一期只支持单主人白名单：ownerIds 里没你的 id，消息一律不理（连"你没权限"
// 都不回，避免被扫号的摸清 bot 在线）。

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
export const DEFAULT_CONFIG_PATH = join(DSH_HOME, 'discord-bridge.json')

/** Discord Gateway intent 位（只用得到这四个） */
export const INTENTS = {
  GUILDS: 1 << 0,
  // 服务器频道里的消息：群聊要开就必须带这个，否则 DM 之外的 MESSAGE_CREATE 根本不会推过来
  GUILD_MESSAGES: 1 << 9,
  DIRECT_MESSAGES: 1 << 12,
  MESSAGE_CONTENT: 1 << 15,
}

function asArray(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean)
  if (typeof value === 'string') return value.split(/[,\s]+/).map((v) => v.trim()).filter(Boolean)
  return []
}

/** 钱：非负数字，取 6 位小数；填了乱七八糟的东西就当 0（= 这条线不设限）。 */
function asMoney(value) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1e6) / 1e6 : 0
}

/** 可继承的钱：没填（null/undefined/空串）→ null 表示「跟着全局走」；填了就按数字算，0 = 这条线自己不限。 */
function asMoneyOrInherit(value) {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'string' && value.trim() === '') return null
  return asMoney(value)
}

// 暗号：常见表情的 :shortcode: → Unicode。聊天里发出来的是 Unicode，
// 配置里写短码更顺手，所以两边的写法都认。
export const EMOJI_SHORTCODES = {
  // Discord 的 :raised_hand: 客户端渲染成 ✋(U+270B)；🖐️(U+1F590) 是它的另一种画法，
  // 匹配时在 normalizeEmoji 里统一归一到 ✋，两种手掌都认。
  raised_hand: '✋',
  rage: '😡',
  raised_back_of_hand: '🤚',
  smiling_imp: '😈',
  wave: '👋',
}

/** 默认暗号表：键 = 触发串，值 = 回什么。谁发都认，不调模型。 */
export const DEFAULT_EMOJI_REPLIES = {
  ':raised_hand::rage::raised_back_of_hand:': 'token回！:raised_hand::rage::raised_back_of_hand:',
  ':raised_hand::smiling_imp::raised_back_of_hand:': 'token回！:wave: :smiling_imp::wave:',
}

/** 数 needle 在 haystack 里出现几次（不重叠）。 */
function countOccurrences(haystack, needle) {
  if (!needle) return 0
  let count = 0
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    count += 1
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}

/** :raised_hand: 这类短码 → 真 emoji；不认识的短码原样保留。 */
export function emojiShortcodeToUnicode(text) {
  return String(text).replace(/:([a-z0-9_+-]+):/g, (whole, name) =>
    EMOJI_SHORTCODES[name] !== undefined ? EMOJI_SHORTCODES[name] : whole,
  )
}

/** ✋(U+270B) 和 🖐️(U+1F590) 是同一个手势的两种画法，统一归一到 ✋。 */
export function normalizeEmoji(text) {
  return String(text)
    .replace(/[\uFE0F\u200D]/g, '')
    .replace(/\u{1F590}/gu, '\u270B')
}

/**
 * token 暗号：文字方向（token来 / token回，感叹号可有可无）是必须项，
 * 表情组只用来挑回哪一套——光发表情不算。
 *   带表情：跟着出现的表情组原样回（token来 ✋😈🤚 → token回！✋😈🤚）
 *   不带表情：从三组里随机挑一组（token来 → token回！+ 随机一组）
 *   token回 同理，方向反过来（回 token来！+ 同一组）
 * 发几遍回几遍（连着写，不换行）；没有方向词返回 null。
 */
export const TOKEN_EMOJI_GROUPS = ['✋😈🤚', '✋😡🤚', '👋😈👋']

export function matchTokenReply(content, random = Math.random) {
  const plain = normalizeEmoji(emojiShortcodeToUnicode(content))
  // 感叹号不参与判断：token来！/ token来 / token回！ 都算
  const noBang = plain.replace(/[!！]/g, '')
  const pieces = []
  let cursor = 0
  while (cursor < noBang.length) {
    const inAt = noBang.indexOf('token来', cursor)
    const outAt = noBang.indexOf('token回', cursor)
    if (inAt === -1 && outAt === -1) break
    const isIn = inAt !== -1 && (outAt === -1 || inAt < outAt)
    const at = isIn ? inAt : outAt
    const word = isIn ? 'token来' : 'token回'
    // 这一遍紧跟着的那段（到下一个方向词为止）里带了哪组表情，就跟着哪组
    const nextIn = noBang.indexOf('token来', at + word.length)
    const nextOut = noBang.indexOf('token回', at + word.length)
    const nextAt = Math.min(
      ...[nextIn, nextOut].filter((index) => index !== -1),
      noBang.length,
    )
    const rest = noBang.slice(at + word.length, nextAt)
    const seen = TOKEN_EMOJI_GROUPS.find((group) => rest.includes(group)) || null
    const group = seen || TOKEN_EMOJI_GROUPS[Math.floor(random() * TOKEN_EMOJI_GROUPS.length)]
    pieces.push(`${isIn ? 'token回！' : 'token来！'}${group}`)
    cursor = at + word.length
  }
  return pieces.length ? pieces.join('') : null
}

/**
 * 余额/消费预算配置：
 *   { enabled, global, dm, globalQuota, dmQuota, guilds:{ [guildId]: {name,min,quota} }, refreshMs, remindMs }
 * guilds 里允许写数字简写（`"123": 5`），读出来统一成 {name,min}。
 * 语义：global 是总闸；dm / 某服务器的 min、quota 留空（null）= 跟全局走，填 0 = 这条线自己不设限（豁免全局）。
 */
export function resolveBudget(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const guilds = {}
  if (src.guilds && typeof src.guilds === 'object' && !Array.isArray(src.guilds)) {
    for (const [id, entry] of Object.entries(src.guilds)) {
      const key = String(id).trim()
      if (!key) continue
      const min = asMoneyOrInherit(typeof entry === 'object' && entry ? entry.min : entry)
      const quota = asMoneyOrInherit(typeof entry === 'object' && entry ? entry.quota : null)
      const name = typeof entry === 'object' && entry && entry.name ? String(entry.name) : ''
      if (min !== null || quota !== null || name) {
        guilds[key] = { name: name || guilds[key]?.name || '', min, quota }
      }
    }
  }
  return {
    // 默认开着；但阈值默认全是 0 = 不设限，主人填了数字才真的会暂停
    enabled: src.enabled !== false,
    // 主人自己聊天不计额度：额度只管服务器里的其他人（面板上能关）
    skipOwners: src.skipOwners !== false,
    global: asMoney(src.global),
    dm: asMoneyOrInherit(src.dm),
    // 消费额度：这个私聊/服务器累计最多花多少（null = 跟全局走，0 = 不限）
    globalQuota: asMoneyOrInherit(src.globalQuota),
    dmQuota: asMoneyOrInherit(src.dmQuota),
    guilds,
    refreshMs: Math.max(15_000, Number(src.refreshMs) || 60_000),
    remindMs: Math.max(60_000, Number(src.remindMs) || 10 * 60_000),
  }
}

function readConfigFile(path, log) {
  try {
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch (error) {
    if (error && error.code !== 'ENOENT') log?.(`配置文件读不了（${path}）：${error.code || error.message}`)
    return {}
  }
}

/**
 * 正文里有没有叫到配置的名字（不区分大小写）。
 * 用来判断「@ 之外的叫法」：主人/群友/别的机器人，在正文里提到 triggerWords 也算叫了它。
 * triggerWords 为空时永远返回 false。
 */
export function mentionsTriggerWord(content, words) {
  const text = String(content ?? '').toLowerCase()
  if (!text) return false
  return (Array.isArray(words) ? words : []).some((word) => {
    const needle = String(word ?? '').trim().toLowerCase()
    return needle.length > 0 && text.includes(needle)
  })
}

/**
 * 合并出最终配置。
 * @param {object} raw - cordis patch 传进来的 config
 * @param {(msg:string)=>void} log
 */
export function resolveConfig(raw = {}, log) {
  const filePath = raw.configPath || DEFAULT_CONFIG_PATH
  const fromFile = readConfigFile(filePath, log)
  // 文件优先于 patch（patch 里写字面量 token 容易被顺手 commit）
  const merged = { ...raw, ...fromFile }

  const token = String(
    process.env.DISCORD_BOT_TOKEN || merged.token || '',
  ).trim()

  // 白名单默认空：宁可不理人，也不让陌生人把你 bot 当免费接口
  const ownerIds = asArray(process.env.DISCORD_OWNER_IDS || merged.ownerIds || merged.ownerId || '')
  const allowedGuildIds = asArray(merged.allowedGuildIds ?? merged.allowedGuildId ?? '')

  return {
    token,
    ownerIds,
    allowedGuildIds,
    // 群聊总闸之一：dmOnly=true 时群聊整个关掉（老配置保持「只私聊」的语义）。
    // 要开群聊必须同时 guildChat:true 且 dmOnly:false。
    dmOnly: merged.dmOnly !== false,
    // 群聊总开关：服务器里跟人聊天（默认关；开了还要 GUILD_MESSAGES intent）
    guildChat: merged.guildChat === true,
    // 主人没 @ 我、但话里提到这些词时，我主动插一句
    triggerWords: asArray(merged.triggerWords || ''),
    // 已批准的外部用户：{ userId: { name, chat, requireMention, at } }
    grants:
      merged.grants && typeof merged.grants === 'object' && !Array.isArray(merged.grants)
        ? merged.grants
        : {},
    // 机器人的去留：{ botId: { name, accept, chat, at } }
    //   accept=true 才收它的消息；chat=true 才会真的回它（聊天会耗 token）
    botPolicy:
      merged.botPolicy && typeof merged.botPolicy === 'object' && !Array.isArray(merged.botPolicy)
        ? merged.botPolicy
        : {},
    // 陌生人 @ 之后，确认卡片在 GUI 里等多久；超时自动作废
    consentTimeoutMs: Math.max(30_000, Number(merged.consentTimeoutMs) || 10 * 60_000),
    // 余额预算：跌到线以下就自动暂停（详见 budget.js）
    budget: resolveBudget(merged.budget),
    // 累计花费账本：{ 'dm' | 'guild:<id>': { spent, updatedAt, since } }
    // 插件自己按会话事件结算（见 budget.js 的 addSpend），面板上能清零
    spend:
      merged.spend && typeof merged.spend === 'object' && !Array.isArray(merged.spend)
        ? merged.spend
        : {},
    // 见过的服务器 id → 名字（面板上显示得好看些；由消息自动补全）
    guildNames:
      merged.guildNames && typeof merged.guildNames === 'object' && !Array.isArray(merged.guildNames)
        ? merged.guildNames
        : {},
    // 要不要把回复「引用」到对面那条消息上（Discord 的 reply）。
    // 默认开：一眼能看出我在回哪句话；不想要就在配置里写 replyToUser: false
    replyToUser: merged.replyToUser !== false,
    sessionId: String(merged.sessionId || 'session-discord-main'),
    // 群聊会话和私聊分开：每个服务器一个自己的会话，互不串上下文。
    // 没指定时按前缀自动生成，运行时写回配置文件。
    guildSessionPrefix: String(merged.guildSessionPrefix || 'session-discord-guild-'),
    guildSessions:
      merged.guildSessions && typeof merged.guildSessions === 'object' && !Array.isArray(merged.guildSessions)
        ? { ...merged.guildSessions }
        : {},
    // 群聊里先读最近多少分钟内的聊天记录（0 = 不读；只对服务器生效，私聊不读；支持小数，0.5 = 30 秒）
    guildHistoryMinutes: Math.max(0, Math.min(1440, Number(merged.guildHistoryMinutes ?? 1) || 0)),
    // 别的机器人连续说话时，最多接几轮（防两个 bot 互相刷屏；人类一说话计数就归零）
    botStreakLimit: Math.max(1, Math.min(50, Math.floor(Number(merged.botStreakLimit) || 10))),
    // 暗号：谁发这些表情串，就回一句固定的，不调模型
    emojiReplies:
      merged.emojiReplies && typeof merged.emojiReplies === 'object' && !Array.isArray(merged.emojiReplies)
        ? { ...DEFAULT_EMOJI_REPLIES, ...merged.emojiReplies }
        : { ...DEFAULT_EMOJI_REPLIES },
    // 催问：回完某人、对方 20 秒不理就 @ 一次，之后每 30 秒一次、最多 3 次；
    // 3 次都叫不动、再等 30 秒还没回，就留一句「人跑了」的收尾话收工（只对群聊生效）
    pingBack: {
      enabled: merged.pingBack?.enabled !== false,
      afterMs: Math.max(1000, Number(merged.pingBack?.afterMs) || 20_000),
      intervalMs: Math.max(1000, Number(merged.pingBack?.intervalMs) || 30_000),
      maxTimes: Math.max(1, Math.min(10, Math.floor(Number(merged.pingBack?.maxTimes) || 3))),
      giveUpAfterMs: Math.max(1000, Number(merged.pingBack?.giveUpAfterMs) || 30_000),
      giveUpText: String(
        merged.pingBack?.giveUpText || '好像没人在了，那我先不打扰啦。',
      ),
    },

    cwd: String(merged.cwd || process.cwd()),
    // agent preset：决定这个 agent 挂哪一套插件（人设 AGENTS.md、提示词分段、工具集）。
    // GUI 主会话用的是 standard；不传就只有裸 agent，人设和记忆注入全都没有。
    agentPreset: merged.agentPreset === null ? '' : String(merged.agentPreset || 'standard'),
    provider: merged.provider ? String(merged.provider) : undefined,
    model: merged.model ? String(merged.model) : undefined,
    reasoningEffort: merged.reasoningEffort ? String(merged.reasoningEffort) : undefined,
    // 流式：true = 边出边编辑同一条消息（Discord 会显示「已编辑」）；
    //       false（默认）= 整轮结束一次性发完整消息，没有「已编辑」角标
    stream: merged.stream === true,
    chunkLimit: Math.min(1990, Math.max(500, Number(merged.chunkLimit) || 1900)),
    editIntervalMs: Math.max(700, Number(merged.editIntervalMs) || 1200),
    typing: merged.typing !== false,
    // 记忆预置：首次启动把主会话的记忆复制一份给 Discord 会话。
    // seedMemoryFrom 不写默认值（开源版不假设任何人本机的 session id）；留空 = 不预置。
    seedMemory: merged.seedMemory !== false,
    seedMemoryFrom: String(merged.seedMemoryFrom || ''),
    systemPromptExtra: String(merged.systemPromptExtra || ''),
    maxSessionAgeMs: Math.max(5 * 60 * 1000, Number(merged.maxSessionAgeMs) || 6 * 60 * 60 * 1000),
    configPath: filePath,
  }
}
