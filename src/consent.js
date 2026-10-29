// 准入台：陌生人 / 机器人 → 挂一条待确认 → GUI 卡片 → 主人拍板。
//
// 两类决策共用一张待确认表，靠 kind 区分：
//   kind='user'：别人想跟本鱼说话（批准写 cfg.grants）
//   kind='bot' ：服务器里的机器人说话了（批准写 cfg.botPolicy）
//                分两级：accept = 收不收它的消息，chat = 要不要真的回它
//
// 三条规矩照旧：
//   1. 待确认只在内存里，超时（consentTimeoutMs，默认 10 分钟）自动作废；
//   2. 批准写进 cfg.grants / cfg.botPolicy（由 index.js 落盘到 discord-bridge.json）；
//   3. 拒绝不写任何东西 —— 下次再来再问一次，不静默拉黑。
//
// 同一个人在同一个服务器里重复触发，不重复弹卡片，只更新那条的摘要。

import { randomUUID } from 'node:crypto'

export function createConsentDesk({ cfg, log }) {
  /** id → { id, kind, userId, userName, guildId, channelId, messageId, snippet, createdAt } */
  const pending = new Map()

  function sweep() {
    const now = Date.now()
    for (const [id, entry] of pending) {
      if (now - entry.createdAt > cfg.consentTimeoutMs) {
        pending.delete(id)
        log(`确认过期作废：${entry.userName}（${entry.userId}）`)
      }
    }
  }

  /** 已批准的人才有 grant；只认 chat === true。 */
  function grantOf(userId) {
    const grant = cfg.grants[String(userId)]
    return grant && grant.chat === true ? grant : undefined
  }

  /** 这个机器人被批准过才有策略；没批准过（或只拒绝过）就是 undefined。 */
  function botPolicyOf(botId) {
    const policy = cfg.botPolicy && cfg.botPolicy[String(botId)]
    return policy && policy.accept === true ? policy : undefined
  }

  /**
   * 挂一条待确认。
   * @returns {{entry:object, fresh:boolean}} fresh=false 表示复用了已有的那条
   */
  function request({
    kind = 'user',
    userId,
    userName,
    guildId,
    channelId,
    messageId,
    snippet,
  }) {
    sweep()
    for (const entry of pending.values()) {
      if (
        entry.kind === kind &&
        entry.userId === String(userId) &&
        entry.guildId === (guildId ? String(guildId) : null)
      ) {
        entry.snippet = snippet
        entry.createdAt = Date.now()
        return { entry, fresh: false }
      }
    }
    const entry = {
      id: randomUUID().slice(0, 8),
      kind,
      userId: String(userId),
      userName: String(userName || '未知用户'),
      guildId: guildId ? String(guildId) : null,
      channelId: String(channelId),
      messageId: messageId ?? null,
      snippet: String(snippet || '').slice(0, 200),
      createdAt: Date.now(),
    }
    pending.set(entry.id, entry)
    return { entry, fresh: true }
  }

  function list() {
    sweep()
    return [...pending.values()].map((entry) => ({ ...entry }))
  }

  /**
   * 主人拍板。
   * @param {string} id
   * @param {{allow:boolean, requireMention?:boolean, chat?:boolean}} decision
   */
  function decide(id, decision = {}) {
    sweep()
    const entry = pending.get(String(id))
    if (!entry) return { ok: false, error: '这条确认已经过期或不存在了' }
    pending.delete(entry.id)

    if (entry.kind === 'bot') {
      if (decision.allow !== true) {
        log(`拒绝理这个机器人：${entry.userName}（${entry.userId}）`)
        return { ok: true, allow: false, kind: 'bot', entry }
      }
      if (!cfg.botPolicy || typeof cfg.botPolicy !== 'object') cfg.botPolicy = {}
      const policy = {
        name: entry.userName,
        accept: true,
        chat: decision.chat === true,
        at: new Date().toISOString(),
      }
      cfg.botPolicy[entry.userId] = policy
      log(`批准机器人：${entry.userName}（${entry.userId}）回它=${policy.chat}`)
      return { ok: true, allow: true, kind: 'bot', entry, policy }
    }

    if (decision.allow !== true) {
      log(`拒绝准入：${entry.userName}（${entry.userId}）`)
      return { ok: true, allow: false, kind: 'user', entry }
    }

    const grant = {
      name: entry.userName,
      chat: true,
      requireMention: decision.requireMention !== false,
      at: new Date().toISOString(),
    }
    cfg.grants[entry.userId] = grant
    log(`批准准入：${entry.userName}（${entry.userId}）每次都要@=${grant.requireMention}`)
    return { ok: true, allow: true, kind: 'user', entry, grant }
  }

  function revoke(userId, kind = 'user') {
    const key = String(userId)
    const table = kind === 'bot' ? cfg.botPolicy : cfg.grants
    if (!table || !table[key]) return false
    delete table[key]
    log(kind === 'bot' ? `撤销机器人：${key}` : `撤销准入：${key}`)
    return true
  }

  return { request, list, decide, revoke, grantOf, botPolicyOf }
}
