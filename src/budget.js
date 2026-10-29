// 预算：两条独立的闸门，哪条踩线都先闭嘴。
//
//   ① 余额线：余额跌到线以下（<=）就暂停——「快花光了，停一下」。
//   ② 消费额度：这个私聊/这个服务器**累计花掉**多少就暂停——「这里最多给它花 X 元」。
//
// 余额从哪儿来：
//   1. 首选 DSH 自己的账号服务 `ctx.get('deepseekAccount').getBalance(...)`
//      —— 只登录客户端、没配 API key 的账号也读得到（充值钱包 + 赠金一起算）；
//   2. 读不到时退回 dsh-whale-widget 维护的账本 `.dshw-usage.json` 的 lastBalance
//      （只在文件足够新鲜时用，超过 30 分钟就当它过期了）。
//   3. 两条路都失败 → fail-open：照常聊天，但在面板上标红说明「余额读不到」。
//      宁可漏停，也不因为一次网络抽风把主人关在门外。
//
// 花费从哪儿来：插件自己监听会话事件（`assistant/message` 带 usage），按官方价目表折算成 CNY，
// 结算到当前说话人所在的作用域（私聊 / 服务器）。只统计 Discord 这个会话，GUI 那边不算。
//
// 阈值语义（余额线和消费额度都一样）：
//   - 留空 / null = 跟着全局走（继承）；
//   - 填 0 = 这条线自己不限（可以拿它让私聊或某个服务器豁免全局线）；
//   - 余额 <= 线、或累计花费 >= 额度，就暂停。充值/清零后自动恢复，不用手动开关。

import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const LEDGER_PATH = join(DSH_HOME, '.dshw-usage.json')
// 账本是别的插件写的，超过这个岁数就不信它了（它自己 25 秒刷一次）
const LEDGER_MAX_AGE_MS = 30 * 60_000

// DeepSeek 官方价（CNY / 百万 token）：[空闲时段价, 高峰时段价]。
// 高峰 = 北京时间周一至周五 9:00-12:00、14:00-18:00（节假日按谷价，这里不细分，误差极小）。
// Flash：命中 0.02/0.04，未命中 1/2，输出 4/8；Pro 是 Flash 的 3 倍（0.15/0.3、4.5/9、13.5/27）。
const PRICE_FLASH = { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] }
const PRICE_PRO = { hit: [0.15, 0.3], miss: [4.5, 9], out: [13.5, 27] }

/** 作用域标识：'dm' | 'guild:<id>' */
export function scopeKeyOf({ isDM, guildId }) {
  if (isDM) return 'dm'
  return guildId ? `guild:${String(guildId)}` : 'dm'
}

function asMoney(value) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1e6) / 1e6 : 0
}

/** 可继承的线：null/空 = 跟着全局走；填了就是自己的数，0 = 这条线自己不设限。 */
function asMoneyOrInherit(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' && value.trim() === '') return null
  return asMoney(value)
}

function priceFor(model) {
  const m = String(model || '').toLowerCase()
  if (m.includes('pro')) return PRICE_PRO
  return PRICE_FLASH
}

/** 北京时间周一~周五的 9-12、14-18 是高峰价。 */
function isPeak(nowMs = Date.now()) {
  const d = new Date(nowMs + 8 * 3_600_000)
  const day = d.getUTCDay()
  if (day === 0 || day === 6) return false
  const hour = d.getUTCHours()
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18)
}

/**
 * 一次 LLM 请求花掉多少钱（元）。
 * usage 形如 { inputTokens, cacheReadTokens, outputTokens }（reasoning 已含在 output 里）。
 */
export function costOf(usage, model, nowMs = Date.now()) {
  const input = Number(usage?.inputTokens) || 0
  const cache = Number(usage?.cacheReadTokens) || 0
  const output = Number(usage?.outputTokens) || 0
  const p = priceFor(model)
  const off = isPeak(nowMs) ? 1 : 0
  const cost = (cache / 1e6) * p.hit[off] + (input / 1e6) * p.miss[off] + (output / 1e6) * p.out[off]
  return {
    cost: Math.round(cost * 1e8) / 1e8,
    tokens: input + cache + output,
    model: String(model || ''),
  }
}

/** 从账号服务返回的钱包里挑一个币种，把同币种的钱包加起来（CNY 优先）。 */
function totalFromWallets(result) {
  const accNum = (v) => {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  const normal = Array.isArray(result?.value) ? result.value : []
  const bonus = Array.isArray(result?.bonusWallets) ? result.bonusWallets : []
  const all = normal.concat(bonus).filter((w) => w && accNum(w.balance) !== null)
  if (all.length === 0) return null
  const curOf = (w) => String((w && w.currency) || 'CNY').toUpperCase()
  const nonZero = all.filter((w) => Number(w.balance) > 0)
  const pick =
    nonZero.find((w) => curOf(w) === 'CNY') ||
    nonZero[0] ||
    all.find((w) => curOf(w) === 'CNY') ||
    all[0]
  const currency = curOf(pick)
  const total = all
    .filter((w) => curOf(w) === currency)
    .reduce((sum, w) => sum + Number(w.balance), 0)
  return { total: asMoney(total), currency }
}

/**
 * @param {object} options
 * @param {object} options.cfg - resolveConfig 出来的配置（要用 cfg.budget / cfg.spend / cfg.configPath）
 * @param {object} options.ctx - 插件 ctx（只为拿可选服务 deepseekAccount）
 * @param {(msg:string)=>void} options.log
 */
export function createBudgetDesk({ cfg, ctx, log }) {
  let cache = null
  let inflight = null
  const remindedAt = new Map()

  function budget() {
    const b = cfg.budget || {}
    return {
      enabled: b.enabled !== false,
      global: asMoney(b.global),
      dm: asMoneyOrInherit(b.dm),
      globalQuota: asMoneyOrInherit(b.globalQuota),
      dmQuota: asMoneyOrInherit(b.dmQuota),
      guilds: b.guilds && typeof b.guilds === 'object' ? b.guilds : {},
      refreshMs: Math.max(15_000, Number(b.refreshMs) || 60_000),
      remindMs: Math.max(60_000, Number(b.remindMs) || 10 * 60_000),
    }
  }

  function spendBook() {
    if (!cfg.spend || typeof cfg.spend !== 'object') cfg.spend = {}
    return cfg.spend
  }

  /** 这个作用域累计花了多少。 */
  function spendOf(scope) {
    const key = scopeKeyOf(scope)
    const entry = spendBook()[key]
    return asMoney(typeof entry === 'object' && entry ? entry.spent : entry)
  }

  /** 记一笔花费（返回记完之后的累计值）。 */
  function addSpend(scope, cost) {
    const amount = Number(cost)
    if (!Number.isFinite(amount) || amount <= 0) return spendOf(scope)
    const key = scopeKeyOf(scope)
    const book = spendBook()
    const prev = book[key]
    const spent = asMoney(asMoney(typeof prev === 'object' && prev ? prev.spent : prev) + amount)
    book[key] = { spent, updatedAt: Date.now(), since: (prev && prev.since) || Date.now() }
    return spent
  }

  /** 清零：不给 key 就全清。 */
  function resetSpend(key) {
    const book = spendBook()
    if (!key) {
      for (const k of Object.keys(book)) delete book[k]
      return
    }
    delete book[key]
  }

  function guildMeta(key) {
    const b = budget()
    const guildId = key.startsWith('guild:') ? key.slice('guild:'.length) : null
    if (!guildId) return { guildId: null, entry: null, ownMin: b.dm, ownQuota: b.dmQuota, label: '私聊' }
    const entry = b.guilds[guildId]
    const name = (entry && typeof entry === 'object' && entry.name) || cfg.guildNames?.[guildId] || guildId
    return {
      guildId,
      entry,
      ownMin: asMoneyOrInherit(typeof entry === 'object' && entry ? entry.min : entry),
      ownQuota: asMoneyOrInherit(typeof entry === 'object' && entry ? entry.quota : null),
      label: `服务器「${name}」`,
    }
  }

  /** 这条消息该按哪条余额线算：服务器专属 > 私聊专属 > 全局（专属留空才继承全局）。 */
  function thresholdOf(scope) {
    const b = budget()
    const key = scopeKeyOf(scope)
    const meta = guildMeta(key)
    const inherited = meta.ownMin === null || meta.ownMin === undefined
    const min = inherited ? b.global : meta.ownMin
    return {
      key,
      label: meta.label,
      own: inherited ? null : meta.ownMin,
      min,
      from: inherited ? (b.global > 0 ? 'global' : 'none') : 'own',
      currency: 'CNY',
    }
  }

  /** 这条消息该按哪条消费额度算（语义同余额线）。 */
  function quotaOf(scope) {
    const b = budget()
    const key = scopeKeyOf(scope)
    const meta = guildMeta(key)
    const inherited = meta.ownQuota === null || meta.ownQuota === undefined
    const quota = inherited ? b.globalQuota : meta.ownQuota
    const limit = quota === null || quota === undefined ? 0 : quota
    return {
      key,
      label: meta.label,
      own: inherited ? null : meta.ownQuota,
      quota: limit,
      from: inherited ? (b.globalQuota > 0 ? 'global' : 'none') : 'own',
      currency: 'CNY',
    }
  }

  function readLedger() {
    try {
      const info = statSync(LEDGER_PATH)
      if (Date.now() - info.mtimeMs > LEDGER_MAX_AGE_MS) return null
      const raw = JSON.parse(readFileSync(LEDGER_PATH, 'utf8'))
      const total = Number(raw?.lastBalance)
      if (!Number.isFinite(total)) return null
      return { total: asMoney(total), currency: 'CNY', source: 'ledger', at: info.mtimeMs }
    } catch {
      return null
    }
  }

  async function fetchBalance() {
    let diag = ''
    try {
      const account = typeof ctx?.get === 'function' ? ctx.get('deepseekAccount') : null
      if (account && typeof account.getBalance === 'function') {
        const result = await account.getBalance({
          version: String(process.env.DSH_CLIENT_VERSION || process.env.DSH_VERSION || '') || 'unknown',
          locale: String(process.env.DSH_LOCALE || '') || 'zh_CN',
          timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
        })
        if (result && result.status === 'ready') {
          const parsed = totalFromWallets(result)
          if (parsed) {
            return { ok: true, ...parsed, source: 'account', at: Date.now() }
          }
          diag = '账号里没有可用钱包'
        } else {
          diag = `账号余额未就绪（${String(result?.status || 'unknown')}）`
        }
      } else {
        diag = '当前宿主没有 deepseekAccount 服务'
      }
    } catch (error) {
      diag = `账号余额接口失败：${String(error?.message || error).slice(0, 120)}`
    }
    const ledger = readLedger()
    if (ledger) return { ok: true, ...ledger }
    return { ok: false, error: diag || '读不到余额', at: Date.now() }
  }

  /** 带缓存 + 并发去重的余额读取；force=true 时忽略缓存（面板手动刷新用）。 */
  async function balance(force = false) {
    const ttl = budget().refreshMs
    if (!force && cache && Date.now() - cache.at < ttl) return cache
    if (inflight) return inflight
    inflight = (async () => {
      const next = await fetchBalance()
      cache = next
      inflight = null
      if (!next.ok) log(`余额读不到：${next.error}`)
      return next
    })()
    return inflight
  }

  /**
   * 判断这条消息能不能继续聊（余额线 + 消费额度，谁踩线都算暂停）。
   * @returns {Promise<{paused:boolean,reason:string|null,key:string,label:string,min:number,quota:number,spent:number,total:number|null,currency:string,error?:string}>}
   */
  async function check(scope) {
    const line = thresholdOf(scope)
    const quota = quotaOf(scope)
    const spent = spendOf(scope)
    const base = { ...line, quota: quota.quota, quotaFrom: quota.from, spent, currency: line.currency }

    if (!budget().enabled) {
      return { paused: false, reason: null, ...base, total: cache?.ok ? cache.total : null }
    }

    // ① 消费额度：不需要联网，纯本地账本
    if (quota.quota > 0 && spent >= quota.quota) {
      return {
        paused: true,
        reason: 'quota',
        ...base,
        total: cache?.ok ? cache.total : null,
      }
    }

    // ② 余额线：没设线就不用查余额
    if (line.min <= 0) {
      return { paused: false, reason: null, ...base, total: cache?.ok ? cache.total : null }
    }
    const bal = await balance(false)
    if (!bal.ok) {
      return { paused: false, reason: null, ...base, total: null, error: bal.error }
    }
    return {
      paused: bal.total <= line.min,
      reason: bal.total <= line.min ? 'balance' : null,
      ...base,
      total: bal.total,
      currency: bal.currency,
    }
  }

  /** 同一个作用域，提醒过就别刷屏（remindMs 内只提醒一次）。 */
  function shouldRemind(key, now = Date.now()) {
    const last = remindedAt.get(key) || 0
    if (now - last < budget().remindMs) return false
    remindedAt.set(key, now)
    return true
  }

  function resetReminders() {
    remindedAt.clear()
  }

  /** 面板要的：配置 + 最近一次读到的余额（不等网络）+ 各作用域已花。 */
  function status() {
    const b = budget()
    const book = spendBook()
    const spend = {}
    for (const [key, entry] of Object.entries(book)) {
      spend[key] = {
        spent: asMoney(typeof entry === 'object' && entry ? entry.spent : entry),
        updatedAt: (entry && entry.updatedAt) || null,
      }
    }
    return {
      budget: b,
      balance: cache
        ? {
            ok: cache.ok,
            total: cache.ok ? cache.total : null,
            currency: cache.currency || 'CNY',
            source: cache.source || null,
            error: cache.error || null,
            at: cache.at,
          }
        : null,
      spend,
      guildNames: cfg.guildNames && typeof cfg.guildNames === 'object' ? cfg.guildNames : {},
    }
  }

  /** 面板里的服务器清单：既有配置里的，也有最近见过的（带名字）。 */
  function guildList() {
    const b = budget()
    const out = new Map()
    const put = (id, entry) => {
      const key = `guild:${id}`
      const book = spendBook()[key]
      out.set(id, {
        id,
        name: (entry && typeof entry === 'object' && entry.name) || cfg.guildNames?.[id] || id,
        min: asMoneyOrInherit(typeof entry === 'object' && entry ? entry.min : entry),
        quota: asMoneyOrInherit(typeof entry === 'object' && entry ? entry.quota : null),
        spent: asMoney(typeof book === 'object' && book ? book.spent : book),
      })
    }
    for (const [id, entry] of Object.entries(b.guilds)) put(String(id), entry)
    for (const [id, name] of Object.entries(cfg.guildNames || {})) {
      if (!out.has(String(id))) put(String(id), { name })
    }
    return [...out.values()]
  }

  return {
    budget,
    thresholdOf,
    quotaOf,
    balance,
    check,
    shouldRemind,
    resetReminders,
    status,
    guildList,
    spendOf,
    addSpend,
    resetSpend,
    asMoney,
  }
}
