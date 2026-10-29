// Discord Gateway v10 客户端（零依赖，用 Node 内置的全局 WebSocket）。
//
// 只实现聊天需要的那部分协议：
//   HELLO(10) → IDENTIFY(2) → READY → 心跳(1/11) → 断线 RESUME(6) 或重连(7/9)
//
// 几个必须做对的点（做错了表现为「用一会儿就不回消息了」）：
//   - 心跳要**带 seq**，seq 为 null 时不带 d 字段（Discord 会 400 掉非法心跳）；
//   - 收到 HELLO 后第一次心跳要带随机抖动，别整点打卡；
//   - 两次心跳都没 ACK ⇒ 连接已经假死（zombie），必须主动断开重连，不能干等；
//   - RESUME 失败（op 9 d=false）要清 session_id 重新 IDENTIFY；
//   - 重连指数退避，别把 Discord 的 identify 限流撞爆（1 次 / 5 秒）。

const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json'
const ZOMBIE_LIMIT = 2

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export class DiscordGateway {
  /**
   * @param {{
   *   token: string,
   *   intents: number,
   *   log: Function,
   *   onDispatch: (type: string, data: any) => void,
   *   onReady?: (user: any) => void,
   *   onResumed?: () => void,
   * }} options
   */
  constructor({ token, intents, log, onDispatch, onReady, onResumed }) {
    this.token = token
    this.intents = intents
    this.log = log
    this.onDispatch = onDispatch
    this.onReady = onReady
    this.onResumed = onResumed

    this.ws = null
    this.seq = null
    this.sessionId = null
    this.resumeUrl = null
    this.user = null

    this.heartbeatTimer = null
    this.heartbeatInterval = null
    this.awaitingAck = 0
    this.connected = false
    this.closed = false
    this.reconnectAttempts = 0
    this.reconnectTimer = null
  }

  start() {
    this.closed = false
    this.connect(false)
  }

  stop() {
    this.closed = true
    this.clearTimers()
    if (this.ws) {
      try {
        this.ws.close(1000, 'plugin unload')
      } catch {}
      this.ws = null
    }
  }

  clearTimers() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  connect(resume) {
    if (this.closed) return
    const useResume = Boolean(resume && this.sessionId && this.resumeUrl)
    const url = useResume ? `${this.resumeUrl}/?v=10&encoding=json` : GATEWAY_URL

    this.log(useResume ? `Gateway 重连（RESUME，seq=${this.seq}）` : 'Gateway 连接中…')
    let ws
    try {
      ws = new WebSocket(url)
    } catch (error) {
      this.log(`WebSocket 建不起来：${error?.message || error}`)
      this.scheduleReconnect()
      return
    }
    this.ws = ws

    ws.addEventListener('open', () => {
      this.log('Gateway 已连接，等 HELLO')
    })

    ws.addEventListener('message', (event) => {
      let payload
      try {
        payload = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))
      } catch {
        return
      }
      this.handlePayload(payload || {})
    })

    ws.addEventListener('close', (event) => {
      this.connected = false
      this.clearHeartbeat()
      if (this.closed) return
      this.log(`Gateway 断开（code=${event.code}${event.reason ? `, ${event.reason}` : ''}）`)
      // 4004 = 鉴权失败，重连没用，直接把错误抛给上层
      if (event.code === 4004) {
        this.closed = true
        this.log('🔴 token 无效（4004）—— 检查 discord-bridge.json 里的 token')
        return
      }
      // 4014 = 要了没被允许的 intent。最常见是 MESSAGE CONTENT 没开。
      // 主人去开发者后台打开后不用重启 DSH，这里慢慢重试就会自己连上。
      if (event.code === 4014) {
        this.reconnectAttempts = 5 // 直接拉到最长退避（30s），别刷屏
        if (!this.intentWarned) {
          this.intentWarned = true
          this.log(
            '🔴 4014 Disallowed intent(s)：Discord 开发者后台 → Bot → Privileged Gateway Intents，' +
              '把「MESSAGE CONTENT INTENT」打开（保存后 30 秒内会自动连上，不用重启）',
          )
        }
        this.scheduleReconnect()
        return
      }
      this.scheduleReconnect()
    })

    ws.addEventListener('error', (event) => {
      // 'error' 之后必然跟着 'close'，这里只记一笔，重连交给 close
      this.log(`Gateway 错误：${event?.message || 'unknown'}`)
    })
  }

  handlePayload(payload) {
    if (typeof payload.s === 'number') this.seq = payload.s

    switch (payload.op) {
      case 10: {
        // HELLO
        this.heartbeatInterval = payload.d.heartbeat_interval
        this.startHeartbeat()
        if (this.sessionId) this.sendResume()
        else this.sendIdentify()
        break
      }
      case 11: {
        this.awaitingAck = 0
        break
      }
      case 1: {
        // 服务端要求立刻心跳
        this.sendHeartbeat()
        break
      }
      case 7: {
        this.log('Gateway 要求重连（op 7）')
        this.reconnectWithResume()
        break
      }
      case 9: {
        const resumable = payload.d === true
        this.log(`Gateway session 无效（op 9，可续=${resumable}）`)
        if (!resumable) {
          this.sessionId = null
          this.seq = null
        }
        this.reconnectWithResume(resumable)
        break
      }
      case 0: {
        const type = payload.t
        const data = payload.d
        if (type === 'READY') {
          this.connected = true
          this.reconnectAttempts = 0
          this.sessionId = data.session_id
          this.resumeUrl = data.resume_gateway_url
          this.user = data.user
          this.log(`connected as ${data.user.username}#${data.user.discriminator}（${data.user.id}）`)
          this.onReady?.(data.user)
          return
        }
        if (type === 'RESUMED') {
          this.connected = true
          this.reconnectAttempts = 0
          this.log('Gateway 已恢复（RESUMED）')
          this.onResumed?.()
          return
        }
        this.onDispatch?.(type, data)
        break
      }
      default:
        break
    }
  }

  startHeartbeat() {
    this.clearHeartbeat()
    if (!this.heartbeatInterval) return
    const jitter = Math.floor(this.heartbeatInterval * Math.random())
    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), this.heartbeatInterval)
    setTimeout(() => {
      if (!this.closed && this.ws && this.ws.readyState === 1) this.sendHeartbeat()
    }, jitter)
  }

  clearHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  sendHeartbeat() {
    if (!this.ws || this.ws.readyState !== 1) return
    if (this.awaitingAck >= ZOMBIE_LIMIT) {
      this.log(`连续 ${this.awaitingAck} 次心跳无 ACK —— 连接假死，强制重连`)
      this.reconnectWithResume(true)
      return
    }
    this.awaitingAck += 1
    this.send({ op: 1, d: this.seq })
  }

  sendIdentify() {
    this.send({
      op: 2,
      d: {
        token: this.token,
        intents: this.intents,
        properties: { os: process.platform, browser: 'dsh-discord', device: 'dsh-discord' },
        presence: { status: 'online', afk: false },
      },
    })
  }

  sendResume() {
    this.log(`发送 RESUME（session=${this.sessionId}, seq=${this.seq}）`)
    this.send({
      op: 6,
      d: { token: this.token, session_id: this.sessionId, seq: this.seq },
    })
  }

  send(payload) {
    if (!this.ws || this.ws.readyState !== 1) return
    try {
      this.ws.send(JSON.stringify(payload))
    } catch (error) {
      this.log(`发送失败：${error?.message || error}`)
    }
  }

  reconnectWithResume(resumable = true) {
    const keep = Boolean(resumable && this.sessionId)
    this.clearHeartbeat()
    if (this.ws) {
      try {
        this.ws.close(4000, 'reconnect')
      } catch {}
      this.ws = null
    }
    this.connected = false
    if (!keep) {
      this.sessionId = null
      this.seq = null
    }
    this.scheduleReconnect(keep)
  }

  scheduleReconnect(resume = Boolean(this.sessionId)) {
    if (this.closed) return
    if (this.reconnectTimer) return
    const attempt = Math.min(this.reconnectAttempts, 5)
    this.reconnectAttempts += 1
    const delay = Math.min(30_000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 500)
    this.log(`Gateway ${(delay / 1000).toFixed(1)}s 后重连（第 ${this.reconnectAttempts} 次）`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect(resume)
    }, delay)
  }
}

export { GATEWAY_URL, sleep }
