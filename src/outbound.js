// 流式输出：把模型的增量文本「编辑」进同一条 Discord 消息。
//
// 为什么不是每个 chunk 发一条：Discord 的编辑限流比发送宽松得多，而且一条
// 消息边写边长，读起来才是「她在打字」。所以这里的策略是：
//   - 第一个 delta 进来后 ~300ms 先发一条占位消息（避免空消息被 400）；
//   - 之后按 editIntervalMs 节流 PATCH，绝不打满限流；
//   - 内容超过 1900 字就定型前一截、下一截开新消息，切分交给 chunker；
//   - 一个 turn 内可能有多次 attempt（工具调用后接着说话），每次 attempt 一段，
//     段与段是连续的新消息，不会互相覆盖。

import { splitMessage } from './chunker.js'

// 模型偶尔会把 DeepSeek 的工具调用协议碎片（<｜｜DSML｜｜ … >）当正文吐出来。
// 这些标记绝对不能原样发进 Discord：宁可整条丢掉，也不能让用户看见协议。
const INTERNAL_MARKER_RE = /<\/?｜｜DSML｜｜[^>]*>/g

export function stripInternalMarkers(text) {
  return String(text ?? '').replace(INTERNAL_MARKER_RE, '')
}

// 模型判断「这条不是跟我说话」时约定的沉默标记：整条只回这个，就一个字都不发。
const SILENT_RE = /^[\s。.!！?？~～]*\[SILENT\][\s。.!！?？~～]*$/i

export function isSilentReply(text) {
  return SILENT_RE.test(String(text ?? ''))
}

// Discord 里真人发消息是「一条连着写」的，不会一行一句。模型却习惯用空行分段，
// 看起来就像客服机器人。这里把普通正文里的换行压掉（代码块、引用、列表、表格例外）。
const KEEP_LINEBREAK_RE = /```|^>\s|^\s*[-*+]\s|^\s*\d+\.\s|^\|.*\|/m

export function compactForDiscord(text) {
  const value = String(text ?? '')
  if (!value || KEEP_LINEBREAK_RE.test(value)) return value
  return value
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n+/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

export class StreamWriter {
  /**
   * @param {{rest: any, chunkLimit: number, editIntervalMs: number, log: Function}} options
   */
  constructor({ rest, chunkLimit, editIntervalMs, log, stream = true }) {
    this.rest = rest
    this.chunkLimit = chunkLimit
    this.editIntervalMs = editIntervalMs
    this.log = log
    // stream=false：整个过程只在最后发一条完整消息（Discord 不会挂「已编辑」角标）
    this.stream = stream

    this.channelId = null
    this.replyTo = null
    this.turn = null
    this.group = null
    this.lastFlushAt = 0
    this.timer = null
    this.idleTimer = null
    // 一轮对话里到底吐出过字没有（用来判断要不要发「没话说」兜底）
    this.producedAnyText = false
    // flush 串行用的 promise 链（见 flush()）
    this.chain = Promise.resolve()
    // 最后一条真正落地的消息（群聊收尾时用来补「本轮 token / 余额」）
    this.lastSent = null
  }

  /** 新的用户消息进来时设定回复目标（频道 + 可选引用）。 */
  setTarget(channelId, replyTo = null) {
    this.channelId = channelId
    this.replyTo = replyTo
    // 新一轮消息：上一轮最后那条消息的引用作废，避免把「本轮信息」追加到旧消息上
    this.lastSent = null
  }

  beginTurn(turn) {
    if (this.turn === turn && this.group) return
    this.turn = turn
    this.group = {
      text: '',
      sent: [],
      // 这条 group 的第一条消息发出去之后，就不再需要 replyTo
      replyTo: this.replyTo,
    }
  }

  /**
   * 一个 attempt 开始。
   *
   * 关键：**同一 turn 内不重置 group**。DSH 会把同一轮拆成很多 attempt/step
   * （每个 step、每次 revision 重放都会来一帧 start），早期版本在这里新建
   * group，结果每次 flush 都 sendMessage —— 一条回答被刷成十几条。
   * 现在按「一轮 = 一条消息」处理：text 累加，flush 走 edit。
   */
  beginAttempt(turn, step) {
    if (this.turn !== turn) {
      this.turn = turn
      this.group = null
    }
    if (!this.group) {
      this.group = { text: '', sent: [], replyTo: this.replyTo, step }
    }
  }

  push(text) {
    if (!this.group || !text) return
    this.group.text += text
    this.producedAnyText = true
    this.onContent?.(this.group.text)
    // 不流式时只累积，等 endTurn 一次性发出去 —— 否则 Discord 会显示「已编辑」
    if (this.stream) this.schedule()
  }

  schedule(delay) {
    if (this.timer) return
    const wait = delay ?? Math.max(0, this.editIntervalMs - (Date.now() - this.lastFlushAt))
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush(false)
    }, wait)
  }

  /** 结束当前 attempt：把未落盘的内容推上去。group 保留 —— 同一轮后面还有 attempt。 */
  async endAttempt() {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    // 不流式：中间过程一律不发，等 endTurn 一次发完
    if (!this.stream) return
    await this.flush(true)
  }

  /** 整轮结束：推完最后一版，然后清掉草稿，下一条用户消息从新 group 开始。 */
  async endTurn() {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    await this.flush(true)
    this.group = null
  }

  /**
   * 把当前草稿推上去。
   *
   * ⚠️ 必须**串行排队**，不能"忙就直接返回"：
   *   之前写成 `if (this.flushing) { this.pendingFlush = true; return }`，
   *   endAttempt/endTurn 正好撞上 timer 那次 send 在跑，于是两次都"瞬间返回"，
   *   endTurn 紧接着把 group 清空 —— 排队的那次 flush 再来时 this.group 已经是
   *   null，直接 return。表现就是：Discord 里只剩第一次 flush 发出去的那两个字，
   *   后面模型说的全是"会话里有、Discord 里没有"，而且一条错误日志都不打。
   */
  flush(force) {
    const run = () => this._flush(force)
    this.chain = (this.chain ?? Promise.resolve()).then(run, run)
    return this.chain
  }

  async _flush(force) {
    if (!this.group || !this.channelId) return
    const raw = this.group.text
    // 工具调用协议碎片不是给用户看的：整条都是就丢弃，夹在正文里就剥掉
    const text = compactForDiscord(stripInternalMarkers(raw))
    // 模型判断「这条不是跟我说话」，整条只回了 [SILENT]：一个字都不发
    if (isSilentReply(text)) {
      this.log('[silent] 这一轮判断不该插话，没发消息')
      return
    }
    if (!text.trim()) {
      if (raw.trim()) this.log(`[sanitize] 整条回复都是工具调用残留（${raw.length} 字），丢弃`)
      return
    }

    const segments = splitMessage(text, this.chunkLimit)
    if (!segments.length) return

    const group = this.group
    for (let index = 0; index < segments.length; index += 1) {
      const desired = segments[index]
      const existing = group.sent[index]
      try {
        if (!existing) {
          const message = await this.rest.sendMessage(this.channelId, desired, {
            replyTo: index === 0 ? group.replyTo : null,
          })
          group.sent.push({ id: message.id, content: desired })
        } else if (existing.content !== desired) {
          await this.rest.editMessage(this.channelId, existing.id, desired)
          existing.content = desired
        }
      } catch (error) {
        this.log(`发送/编辑失败（第 ${index + 1} 段）：${error?.message || error}`)
        // 单段失败不要连累后面的段，但整组标记一下，避免无限重试
        if (!existing) break
      }
    }
    if (group.sent.length) this.lastSent = group.sent[group.sent.length - 1]
    this.lastFlushAt = Date.now()
    if (force) {
      // 收尾时打一条：能看出「模型出了多少字」和「Discord 上最终是多少段」
      this.log(`[flush] 草稿 ${text.length} 字 → ${segments.length} 段，已落地 ${group.sent.length} 段`)
    }
    if (this.stream && force && group === this.group && text !== group.text) {
      // 期间又来了新内容（极少见），再排一次
      this.schedule(this.editIntervalMs)
    }
  }

  /**
   * 在「本轮最后一条已落地的消息」末尾补一行小字（群聊的 token / 余额）。
   *
   * 只编辑，不发送新消息：满屏统计比一句「本轮 800 tokens」更吵。
   * 超过单条允许长度就放弃 —— 宁可少一行小字，也不要把消息截断。
   */
  async appendFooter(footer) {
    const text = String(footer || '').trim()
    const last = this.lastSent
    if (!text || !last) return
    const next = `${last.content}\n${text}`
    if (next.length > this.chunkLimit) {
      this.log(`[footer] 追加后 ${next.length} 字超过单条上限，跳过`)
      return
    }
    try {
      await this.rest.editMessage(this.channelId, last.id, next)
      last.content = next
    } catch (error) {
      this.log(`[footer] 追加上轮信息失败：${error?.message || error}`)
    }
  }

  /** 用户说 /stop 或 turn 被取消：停掉定时器，保持已写内容。 */
  async abort(message) {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.group && this.group.sent.length > 0 && message) {
      const last = this.group.sent[this.group.sent.length - 1]
      try {
        await this.rest.editMessage(this.channelId, last.id, `${last.content}\n\n*${message}*`)
        last.content = `${last.content}\n\n*${message}*`
      } catch {}
    }
    this.group = null
  }

  reset() {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.turn = null
    this.group = null
    this.producedAnyText = false
    this.chain = Promise.resolve()
    this.lastSent = null
  }
}
