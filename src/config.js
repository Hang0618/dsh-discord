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
    // 主人没 @ 本鱼、但话里提到这些词时，本鱼主动插一句
    triggerWords: asArray(merged.triggerWords || '鲸鱼娘,大肥鱼,肥鱼,本鱼,小鲸鱼,鱼鱼,鲸鱼'),
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
    // 默认开：一眼能看出本鱼在回哪句话；不想要就在配置里写 replyToUser: false
    replyToUser: merged.replyToUser !== false,
    sessionId: String(merged.sessionId || 'session-discord-main'),
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
