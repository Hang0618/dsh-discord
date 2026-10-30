// 0.5.0 新功能的离线测试：配置默认值、暗号匹配、额度只管别人、历史条数解析。
// 直接跑：node tests-v050.mjs
import { resolveConfig, resolveBudget, DEFAULT_CONFIG_PATH } from './src/config.js'
import { createBudgetDesk } from './src/budget.js'

let passed = 0
let failed = 0
function ok(name, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`)
  }
}

// 1. 配置默认值
const cfg = resolveConfig({ token: 'x', configPath: '/nonexistent/discord-bridge.json' }, () => {})
ok('默认群聊历史 10 条', cfg.guildHistoryLimit === 10, String(cfg.guildHistoryLimit))
ok('默认跳过主人额度', cfg.budget.skipOwners === true)
ok('默认暗号两条', Object.keys(cfg.emojiReplies).length === 2, JSON.stringify(cfg.emojiReplies))
ok('默认群聊会话前缀', cfg.guildSessionPrefix === 'session-discord-guild-')
ok('默认群聊会话表为空', Object.keys(cfg.guildSessions).length === 0)
const cfgCustom = resolveConfig(
  { token: 'x', configPath: '/nonexistent/x.json', guildHistoryLimit: 0, guildSessions: { '1': 's1' } },
  () => {},
)
ok('历史条数可配置为 0', cfgCustom.guildHistoryLimit === 0, String(cfgCustom.guildHistoryLimit))
ok('群聊会话可显式指定', cfgCustom.guildSessions['1'] === 's1')

// 2. 暗号匹配（跟 index.js 里同逻辑）
const EMOJI_SHORTCODES = {
  raised_hand: '✋',
  rage: '😡',
  raised_back_of_hand: '🤚',
  smiling_imp: '😈',
  wave: '👋',
}
function emojiShortcodeToUnicode(text) {
  return String(text).replace(/:([a-z0-9_+-]+):/g, (whole, name) =>
    EMOJI_SHORTCODES[name] !== undefined ? EMOJI_SHORTCODES[name] : whole,
  )
}
function normalizeEmoji(text) {
  return String(text)
    .replace(/[\uFE0F\u200D]/g, '')
    .replace(/\u{1F590}/gu, '\u270B')
}
function matchEmojiReply(content, replies) {
  const plain = normalizeEmoji(content)
  for (const [trigger, reply] of Object.entries(replies || {})) {
    if (!trigger) continue
    const variants = [trigger, emojiShortcodeToUnicode(trigger)]
    if (variants.some((variant) => variant && plain.includes(normalizeEmoji(variant)))) {
      return emojiShortcodeToUnicode(reply)
    }
  }
  return null
}
const replies = cfg.emojiReplies
ok(
  '短码暗号命中',
  matchEmojiReply('token来:raised_hand::rage::raised_back_of_hand:', replies) ===
    'token回！✋😡🤚',
  String(matchEmojiReply('token来:raised_hand::rage::raised_back_of_hand:', replies)),
)
ok(
  'Unicode 暗号命中',
  matchEmojiReply('token来🖐️😡🤚', replies) === 'token回！✋😡🤚',
  String(matchEmojiReply('token来🖐️😡🤚', replies)),
)
ok(
  '第二组暗号命中',
  matchEmojiReply('token来🖐️😈🤚', replies) === 'token回！👋 😈👋',
  String(matchEmojiReply('token来🖐️😈🤚', replies)),
)
ok('✋ 版第二组暗号命中', matchEmojiReply('token来✋😈🤚', replies) === 'token回！👋 😈👋',
  String(matchEmojiReply('token来✋😈🤚', replies)))
ok('🖐️ 版也命中（两种画法归一）', matchEmojiReply('token来🖐️😈🤚', replies) === 'token回！👋 😈👋',
  String(matchEmojiReply('token来🖐️😈🤚', replies)))
ok('普通消息不命中', matchEmojiReply('今天吃什么', replies) === null)
ok('单表情不误伤', matchEmojiReply('🖐️', replies) === null)

// 3. 额度只管服务器里的其他人
function deskWithQuota(quota) {
  const cfg2 = {
    budget: resolveBudget({ enabled: true, globalQuota: quota, global: 0, remindMs: 60000 }),
    spend: { 'guild:100': { spent: quota, updatedAt: Date.now() }, dm: { spent: quota, updatedAt: Date.now() } },
    guildNames: { '100': '测试服' },
    configPath: '/nonexistent/y.json',
  }
  return createBudgetDesk({ cfg: cfg2, ctx: null, log: () => {} })
}
const desk = deskWithQuota(0.01)
const ownerGate = await desk.check({ isOwner: true, isDM: false, guildId: '100' })
const otherGate = await desk.check({ isOwner: false, isDM: false, guildId: '100' })
ok('主人聊天不暂停（额度已用完）', ownerGate.paused === false, JSON.stringify(ownerGate))
ok('服务器里的其他人到额度会暂停', otherGate.paused === true && otherGate.reason === 'quota', JSON.stringify(otherGate))
const ownerDM = await desk.check({ isOwner: true, isDM: true, guildId: null })
ok('主人私聊也不暂停', ownerDM.paused === false)
const cfgNoSkip = resolveBudget({ enabled: true, globalQuota: 0.01, skipOwners: false })
ok('skipOwners=false 时开关可恢复旧行为', cfgNoSkip.skipOwners === false)

// 4. 历史渲染条数（同 index.js 的截断思路）
function trimHistory(text, limit) {
  return text.split('\n').slice(0, limit)
}
ok('历史条数上限生效', trimHistory('a\nb\nc\nd\ne', 3).length === 3)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
