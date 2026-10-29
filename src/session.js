// 会话管理：给 Discord 一个**固定**的 SessionId。
//
// 固定 id 是为一件事服务的：记忆。fish-memory 按 <sessionId>.json 存一份记忆，
// 只要 id 不变，Discord 那边和 GUI 那边读到的是同一套人设、同一份记忆。
//
// 首次启动时做一次「记忆过继」：
//   把主会话的记忆文件复制成 session-discord-main.json，
//   并把这个会话显式写进 fish-memory 的开关表（默认虽然是开，写明确一点更保险）。
// 只复制一次（目标已存在就跳过），之后两边各长各的，互不覆盖。

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')

/**
 * 把主会话的记忆过继给 Discord 会话。
 * @returns {'seeded' | 'exists' | 'missing' | 'error'}
 */
export function seedMemory({ fromSession, toSession, log }) {
  const dir = join(DSH_HOME, 'fish-memory')
  const targetFile = join(dir, `${toSession}.json`)
  if (existsSync(targetFile)) {
    log?.(`记忆已在（${toSession}.json），跳过过继`)
    return 'exists'
  }
  const sourceFile = join(dir, `${fromSession}.json`)
  if (!existsSync(sourceFile)) {
    log?.(`主会话记忆不存在（${fromSession}.json），这次先不预置`)
    return 'missing'
  }
  try {
    mkdirSync(dir, { recursive: true })
    copyFileSync(sourceFile, targetFile)
    log?.(`记忆过继完成：${fromSession} → ${toSession}`)
    tagOwnerNames(toSession, log)
    return 'seeded'
  } catch (error) {
    log?.(`记忆过继失败：${error?.message || error}`)
    return 'error'
  }
}

/**
 * 把「主人」这个钉死的会话称呼清掉。
 *
 * 0.3.0 及以前 seedMemory 会把 Discord 会话的称呼写成「主人」，而配置文件里已经
 * 落了盘 —— 只改写入逻辑救不了老会话，所以启动时顺手洗一次（幂等）。
 *
 * 为什么要清：Discord 是「一个会话、多人说话」，会话级称呼只可能是某一个人的，
 * 钉死之后服务器里别人搭话也会被叫「主人」（2026-10-29 用户反馈）。
 * 留空 → fish-memory 回退到全局代词；到底叫谁、叫什么，由 dsh-discord 每轮按
 * 当前说话人的 Discord 昵称注入（discord-speaker context）。
 */
function clearPinnedOwnerName(cfg, sessionId) {
  const names = cfg.ownerNames
  if (!names || typeof names !== 'object') return false
  if (names[sessionId] !== '主人') return false
  delete names[sessionId]
  return true
}

/** 把历史版本钉死在 fish-memory 里的「主人」清掉（启动时跑一次，幂等）。 */
export function neutralizeOwnerName(sessionId, log) {
  const cfgPath = join(DSH_HOME, 'fish-memory-config.json')
  try {
    if (!existsSync(cfgPath)) return
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) || {}
    if (!clearPinnedOwnerName(cfg, sessionId)) return
    const tmp = `${cfgPath}.dsh-discord.tmp`
    writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8')
    renameSync(tmp, cfgPath)
    log?.(`已把 ${sessionId} 的称呼从「主人」清掉（改由每轮说话人的 Discord 昵称决定）`)
  } catch (error) {
    log?.(`清理旧称呼失败（不影响使用）：${error?.message || error}`)
  }
}

/** 顺手在 fish-memory 配置里把这个会话标成「开」，并把称呼补上。 */
function tagOwnerNames(sessionId, log) {
  const cfgPath = join(DSH_HOME, 'fish-memory-config.json')
  try {
    const raw = existsSync(cfgPath) ? readFileSync(cfgPath, 'utf8') : '{}'
    const cfg = JSON.parse(raw) || {}
    cfg.sessions = cfg.sessions && typeof cfg.sessions === 'object' ? cfg.sessions : {}
    cfg.sessions[sessionId] = true
    cfg.ownerNames = cfg.ownerNames && typeof cfg.ownerNames === 'object' ? cfg.ownerNames : {}
    cfg.selfNames = cfg.selfNames && typeof cfg.selfNames === 'object' ? cfg.selfNames : {}
    // ⚠ 以前这里写死 '主人'。但一个 Discord 会话里主人和批准的人共用上下文，
    //   钉死称呼就会在服务器里叫错人 → 现在留空，让 dsh-discord 每轮按说话人注入。
    clearPinnedOwnerName(cfg, sessionId)
    if (!cfg.selfNames[sessionId]) cfg.selfNames[sessionId] = '蓝色大肥鱼'
    const tmp = `${cfgPath}.dsh-discord.tmp`
    writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8')
    renameSync(tmp, cfgPath)
  } catch (error) {
    log?.(`写 fish-memory 开关失败（不影响使用）：${error?.message || error}`)
  }
}

/**
 * 把 preset 真正挂到 agent 上。
 *
 * `meta.agentPreset` 只是写进 session header 的「记录」，**不会**把 preset 里的插件
 * 装到 agent.ctx 上 —— 不调 select 的话，agent 就是个裸模型：没有 dsh-agent-instructions
 * （AGENTS.md 人设）、没有记忆注入，问它什么都不知道。踩过这个坑。
 *
 * select 只能在第一轮之前调（`lastTurn > 0` 会被 agent-preset/locked 拒掉），
 * 所以老会话只能删掉重建。
 */
async function bindPreset(ctx, agent, presetId, log) {
  if (!presetId) {
    log?.('没配 agentPreset，跳过预设绑定（人设不会继承）')
    return
  }
  try {
    const already = ctx.agentPresets?.composedPreset?.(agent.ctx)
    if (already === presetId) {
      log?.(`预设已绑定：${already}`)
      return
    }
    if (typeof ctx.agentPresets?.select !== 'function') {
      log?.('这个 profile 没有 agentPresets.select，预设绑不上')
      return
    }
    const got = await ctx.agentPresets.select(agent, presetId)
    log?.(`预设已绑定：${got}${got === presetId ? '' : `（要的是 ${presetId}，给的是 ${got}）`}`)
  } catch (error) {
    // select 有「会话已开跑就锁死」的限制（agent-preset/locked）。插件重载 → agent 被
    // 重建 → 只能 resume，而 resume 出来的是裸 ctx，于是每次重载都会丢人设。
    // 退路：直接走 registry 的 recompose（没有 locked 检查），把 preset 重新挂上去。
    const first = error?.message || error
    try {
      if (typeof ctx.agentPresets?.recompose !== 'function') throw new Error('没有 recompose 可用')
      const snapshot = await ctx.agentPresets.recompose(agent.ctx, presetId)
      const id = snapshot?.id ?? snapshot
      log?.(`select 不行（${first}），改用 recompose 强制挂载：${id}`)
    } catch (second) {
      log?.(
        `绑定预设失败：${first}；强制挂载也失败：${second?.message || second}` +
          `（人设/记忆不会生效；删掉 ${agent.session?.id ?? ''} 的会话目录重建）`,
      )
    }
  }
}

/**
 * 拿到（或新建）Discord 用的 agent。
 *
 * 顺序：内存里已有同 id → 直接复用；否则 create；create 报「已存在」（说明是
 * 落过盘的会话）→ 用 resume 接回来；都不行 → 把错误抛给上层，由入口决定降级。
 */
export async function acquireAgent(ctx, cfg, log) {
  const sessionId = cfg.sessionId

  const existing = ctx.agents.get?.(sessionId)
  if (existing) {
    log(`复用内存里已有的会话 ${sessionId}`)
    return { agent: existing, sessionId, handle: null }
  }

  const agentOptions = {}
  if (cfg.provider) agentOptions.provider = cfg.provider
  if (cfg.model) agentOptions.model = cfg.model
  if (cfg.reasoningEffort) agentOptions.reasoningEffort = cfg.reasoningEffort

  // 没指定就用 profile 的默认模型
  if (!agentOptions.provider || !agentOptions.model) {
    try {
      const selection = ctx.agentDefaultModel?.currentSelection?.()
      if (selection) {
        agentOptions.provider = agentOptions.provider || selection.provider
        agentOptions.model = agentOptions.model || selection.model
        agentOptions.reasoningEffort = agentOptions.reasoningEffort || selection.reasoningEffort
      }
    } catch (error) {
      log(`读默认模型失败：${error?.message || error}`)
    }
  }

  // 没有模型就别建了：建出来也会在 prompt 组装那一步炸（{{model}} 没值）
  if (!agentOptions.provider || !agentOptions.model) {
    throw new Error(
      'agentDefaultModel.currentSelection() 没给出 provider/model —— 先在 DSH 界面里选好模型，' +
        '或者在 discord-bridge.json 里直接写 provider + model',
    )
  }

  try {
    const meta = { cwd: cfg.cwd }
    // ⭐ 关键：带上 agentPreset。GUI 主会话的 header 里是 `agentPreset: "standard"`，
    //    预设决定的是「这个 agent 挂哪一套插件」—— AGENTS.md 人设（dsh-agent-instructions）、
    //    提示词分段、工具集都在里面。不传就只有一个裸 agent：没有"蓝色大肥鱼"，也不认得主人。
    if (cfg.agentPreset) meta.agentPreset = cfg.agentPreset
    const handle = await ctx.agents.create({
      sessionId,
      meta,
      agentOptions,
    })
    log(`会话已创建：${sessionId}（模型 ${agentOptions.provider || '?'}/${agentOptions.model || '?'}，预设 ${cfg.agentPreset || '（无）'}）`)
    // ⭐ 光传 meta.agentPreset 不够，必须真的 select 一次，preset 的插件才会挂上 agent.ctx
    await bindPreset(ctx, handle.agent, cfg.agentPreset, log)
    return { agent: handle.agent, sessionId, handle }
  } catch (error) {
    log(`create 失败（${error?.message || error}），尝试 resume`)
  }

  try {
    const handle = await ctx.agents.resume({ resumeSessionId: sessionId, agentOptions })
    log(`会话已恢复：${sessionId}`)
    // 老会话：如果还没跑过轮次，补绑一次；跑过了会被 locked，只能重建
    await bindPreset(ctx, handle.agent, cfg.agentPreset, log)
    return { agent: handle.agent, sessionId, handle }
  } catch (error) {
    log(`resume 也失败：${error?.message || error}`)
    throw error
  }
}
