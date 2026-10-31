// 0.5.0 新功能的离线测试：配置默认值、暗号匹配、额度只管别人、历史条数解析。
// 直接跑：node tests-v050.mjs
import { resolveConfig, resolveBudget, DEFAULT_CONFIG_PATH, mentionsTriggerWord, matchTokenReply, isFarewellText } from './src/config.js'
import { createBudgetDesk } from './src/budget.js'
import { isSilentReply, compactForDiscord } from './src/outbound.js'

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
ok('默认群聊历史 1 分钟', cfg.guildHistoryMinutes === 1, String(cfg.guildHistoryMinutes))
ok('默认跳过主人额度', cfg.budget.skipOwners === true)
ok('默认暗号两条', Object.keys(cfg.emojiReplies).length === 2, JSON.stringify(cfg.emojiReplies))
ok('默认群聊会话前缀', cfg.guildSessionPrefix === 'session-discord-guild-')
ok('默认群聊会话表为空', Object.keys(cfg.guildSessions).length === 0)
const cfgCustom = resolveConfig(
  { token: 'x', configPath: '/nonexistent/x.json', guildHistoryMinutes: 0, guildSessions: { '1': 's1' } },
  () => {},
)
ok('历史分钟可配置为 0', cfgCustom.guildHistoryMinutes === 0, String(cfgCustom.guildHistoryMinutes))
ok('群聊会话可显式指定', cfgCustom.guildSessions['1'] === 's1')
// 狂暴催问模式：默认关，开了之后 1 秒 / 0.5 秒一次
ok('狂暴模式默认关', cfg.pingBack.rageEnabled === false)
ok('狂暴模式默认 1 秒后开始', cfg.pingBack.rageAfterMs === 1000, String(cfg.pingBack.rageAfterMs))
ok('狂暴模式默认每 0.5 秒一次', cfg.pingBack.rageIntervalMs === 500, String(cfg.pingBack.rageIntervalMs))
const cfgRage = resolveConfig(
  { token: 'x', configPath: '/nonexistent/r.json', pingBack: { rageEnabled: true } },
  () => {},
)
ok('狂暴模式可打开', cfgRage.pingBack.rageEnabled === true)
ok('狂暴模式最多持续 30 秒', cfg.pingBack.rageDurationMs === 30000, String(cfg.pingBack.rageDurationMs))
ok('普通催问默认跑 3 大次', cfg.pingBack.rounds === 3, String(cfg.pingBack.rounds))

// 2. 暗号匹配（跟 index.js 里同逻辑）
const EMOJI_SHORTCODES = {
  raised_hand: '✋',
  rage: '😡',
  raised_back_of_hand: '🤚',
  smiling_imp: '😈',
  wave: '👋',
}
const pick = (n) => () => n
ok(
  '短码暗号命中（跟表情）',
  matchTokenReply('token来:raised_hand::rage::raised_back_of_hand:', pick(0)) === 'token回！✋😡🤚',
  String(matchTokenReply('token来:raised_hand::rage::raised_back_of_hand:', pick(0))),
)
ok(
  '🖐️ 归一成 ✋',
  matchTokenReply('token来🖐️😡🤚', pick(0)) === 'token回！✋😡🤚',
  String(matchTokenReply('token来🖐️😡🤚', pick(0))),
)
ok('😈 那组跟着回 ✋😈🤚', matchTokenReply('token来✋😈🤚', pick(0)) === 'token回！✋😈🤚',
  String(matchTokenReply('token来✋😈🤚', pick(0))))
ok('👋😈👋 那组也跟着回', matchTokenReply('token来👋😈👋', pick(0)) === 'token回！👋😈👋',
  String(matchTokenReply('token来👋😈👋', pick(0))))
ok('没表情 → 随机组 1（✋😈🤚）', matchTokenReply('token来', pick(0)) === 'token回！✋😈🤚',
  String(matchTokenReply('token来', pick(0))))
ok('没表情 → 随机组 2（✋😡🤚）', matchTokenReply('token来', pick(0.5)) === 'token回！✋😡🤚',
  String(matchTokenReply('token来', pick(0.5))))
ok('没表情 → 随机组 3（👋😈👋）', matchTokenReply('token来', pick(0.99)) === 'token回！👋😈👋',
  String(matchTokenReply('token来', pick(0.99))))
ok('token来！带感叹号也触发', matchTokenReply('token来！✋😡🤚', pick(0)) === 'token回！✋😡🤚',
  String(matchTokenReply('token来！✋😡🤚', pick(0))))
ok('token回 → 回 token来！+同组', matchTokenReply('token回✋😡🤚', pick(0)) === 'token来！✋😡🤚',
  String(matchTokenReply('token回✋😡🤚', pick(0))))
ok('token回！带感叹号也回 token来！', matchTokenReply('token回！✋😡🤚', pick(0)) === 'token来！✋😡🤚',
  String(matchTokenReply('token回！✋😡🤚', pick(0))))
ok('token回 没表情也随机', matchTokenReply('token回', pick(0.99)) === 'token来！👋😈👋',
  String(matchTokenReply('token回', pick(0.99))))
ok(
  '发两遍回两遍（连着写，跟各自表情）',
  matchTokenReply('token来✋😈🤚token来👋😈👋', pick(0)) === 'token回！✋😈🤚token回！👋😈👋',
  JSON.stringify(matchTokenReply('token来✋😈🤚token来👋😈👋', pick(0))),
)
ok(
  '两遍无表情各自随机',
  (() => { const seq = [0, 0.99]; let i = 0; return matchTokenReply('token来token来', () => seq[i++ % seq.length]) })() ===
    'token回！✋😈🤚token回！👋😈👋',
)
ok('两种方向混着发', matchTokenReply('token来✋😡🤚token回✋😡🤚', pick(0)) === 'token回！✋😡🤚token来！✋😡🤚',
  String(matchTokenReply('token来✋😡🤚token回✋😡🤚', pick(0))))
ok('普通消息不命中', matchTokenReply('今天吃什么', pick(0)) === null)
ok('只发表情不触发', matchTokenReply('✋😡🤚', pick(0)) === null)

// 2.5 沉默标记（模型判断「不是跟我说话」时不发消息）
ok('整条 [SILENT] → 不发', isSilentReply('[SILENT]') === true)
ok('[SILENT] 带标点/空白 → 不发', isSilentReply('  [SILENT]。 ') === true)
ok('正常文字 → 照发', isSilentReply('好的，我在。') === false)
ok('文字里夹 [SILENT] → 照发', isSilentReply('这题我会 [SILENT] 然后继续') === false)

// 2.6 正文里叫到 triggerWords（@ 之外的叫法，机器人/群友/主人都用这一套）
ok('正文叫到名字也算点名', mentionsTriggerWord('诶——小助手是吧', ['小助手']) === true)
ok('关键词不区分大小写', mentionsTriggerWord('HELLO 助手', ['助手']) === true)
ok('没叫到 → false', mentionsTriggerWord('今天吃什么', ['小助手', '助手']) === false)
ok('空词表 → false', mentionsTriggerWord('小助手', []) === false)

// 2.7 告别语：以「晚安/再见」这类话收尾时，对方本来就不需要回，催问不该催
ok('晚安收尾 → 不催', isFarewellText('好呀，那晚安啦～') === true)
ok('再见收尾 → 不催', isFarewellText('那就这样，再见！') === true)
ok('拜拜收尾 → 不催', isFarewellText('你先忙，拜拜') === true)
ok('两句里的告别语 → 也认', isFarewellText('晚安啦。灯给你留一盏，明儿见。') === true)
ok('告别语在句中逗号后 → 也认', isFarewellText('哼，突然这么肉麻。晚安啦，那句本鱼收下了。') === true)
ok('晚安只是句中的一个短语 → 也认', isFarewellText('好啦好啦，晚安，睡吧。') === true)
ok('明儿见 → 不催', isFarewellText('那我先溜了，明儿见') === true)
ok('先这样吧（带语气词）→ 不催', isFarewellText('好，先这样吧') === true)
ok('问句结尾 → 照催', isFarewellText('我们明天见吗？') === false)
ok('普通问句 → 照催', isFarewellText('你觉得这样行吗？') === false)
ok('正文中间提到晚安 → 不误伤', isFarewellText('我在写晚安曲的作业') === false)

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

// 2.7 排版：普通正文压掉换行（代码块/引用/列表例外）
ok('普通正文换行压成空格', compactForDiscord('第一句。\n第二句。') === '第一句。 第二句。', JSON.stringify(compactForDiscord('第一句。\n第二句。')))
ok('空行也压掉', compactForDiscord('a\n\nb') === 'a b')
ok('代码块保留换行', compactForDiscord('```\ncode\n```').includes('\n'))
ok('列表保留换行', compactForDiscord('- a\n- b').includes('\n'))
ok('空文本返回空', compactForDiscord('') === '')

// 5. footer 里的额度提示（同 index.js appendTurnFooter 的算法）
function footerQuotaPart({ enabled, quota, line, spent, balance }) {
  if (!enabled) return ''
  if (quota > 0) return `可使用设置额度还剩${Math.max(0, quota - spent).toFixed(2)}`
  if (Number(line) > 0) {
    const now = balance == null ? '读不到' : balance.toFixed(2)
    return `余额线是${Number(line).toFixed(2)} 目前是${now}`
  }
  return ''
}
ok('总开关关 → footer 不提额度', footerQuotaPart({ enabled: false, quota: 0.5, line: 5, spent: 0.5 }) === '')
ok('开 + 设了额度 → 显示剩余（花完为 0）', footerQuotaPart({ enabled: true, quota: 0.5, line: 0, spent: 0.5 }) === '可使用设置额度还剩0.00')
ok('开 + 设了余额线 → 余额线是xx 目前是xx', footerQuotaPart({ enabled: true, quota: 0, line: 5, spent: 0, balance: 3.2 }) === '余额线是5.00 目前是3.20')
ok('开但没设额度/余额线 → 不提额度', footerQuotaPart({ enabled: true, quota: 0, line: 0, spent: 0 }) === '')
ok('余额读不到时写「读不到」', footerQuotaPart({ enabled: true, quota: 0, line: 5, spent: 0, balance: null }) === '余额线是5.00 目前是读不到')

// 6. 催问节奏：20 秒后第一次 @，之后每 30 秒一次，最多 3 次
function pingBackPlan({ afterMs = 20000, intervalMs = 30000, maxTimes = 3 } = {}) {
  const times = []
  let t = afterMs
  for (let i = 0; i < maxTimes; i++) {
    times.push(t)
    t += intervalMs
  }
  return times
}
ok('催问 3 次落在 20s/50s/80s', JSON.stringify(pingBackPlan()) === '[20000,50000,80000]', JSON.stringify(pingBackPlan()))
ok('催问次数可配置', pingBackPlan({ maxTimes: 1 }).length === 1)
ok('催问间隔可配置', JSON.stringify(pingBackPlan({ afterMs: 5000, intervalMs: 10000, maxTimes: 2 })) === '[5000,15000]')
ok('第 3 次催问后再等 30 秒收尾', pingBackPlan()[2] + 30000 === 110000)

// 6.1 升级链：一大次 = 20s 首 @ + 每 30s 共 3 次 + 30s 收尾 = 110s；大次之间再等 20s；
//     3 大次后（390s）自动升狂暴，1 秒后首 @，最多持续 30 秒
function pingBackUpgradePlan({
  afterMs = 20000,
  intervalMs = 30000,
  maxTimes = 3,
  giveUpAfterMs = 30000,
  rounds = 3,
} = {}) {
  const roundMs = afterMs + (maxTimes - 1) * intervalMs + giveUpAfterMs
  const starts = Array.from({ length: rounds }, (_, i) => i * (roundMs + afterMs))
  const rageStart = (rounds - 1) * (roundMs + afterMs) + roundMs + afterMs
  return { starts, rageStart }
}
ok('三大次起点在 0/130/260 秒', JSON.stringify(pingBackUpgradePlan().starts) === '[0,130000,260000]', JSON.stringify(pingBackUpgradePlan().starts))
ok('三大次后 390 秒自动升狂暴', pingBackUpgradePlan().rageStart === 390000, String(pingBackUpgradePlan().rageStart))
ok('狂暴 1 秒后首 @，最多 30 秒就停', pingBackUpgradePlan().rageStart + 1000 === 391000)

// 7. 输入中提示：累计输出还是 [SILENT] 的前缀时，先不显示「正在输入」
const SILENT_PREFIX_RE = /^[\s。.!！?？~～]*\[?[SILENT]*\]?[\s。.!！?？~～]*$/i
const silentPrefix = (text) => SILENT_PREFIX_RE.test(String(text || ''))
ok('还是空白 → 不显示输入中', silentPrefix('') === true)
ok('刚打出 [ → 不显示', silentPrefix('[') === true)
ok('打到 [SIL → 不显示', silentPrefix('[SIL') === true)
ok('整条 [SILENT] → 不显示', silentPrefix('[SILENT]') === true)
ok('[SILENT] 带标点 → 不显示', silentPrefix(' [SILENT]。') === true)
ok('开始写正文 → 显示', silentPrefix('哼') === false)
ok('[SILENT] 后接正文 → 显示', silentPrefix('[SILENT] 哼') === false)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
