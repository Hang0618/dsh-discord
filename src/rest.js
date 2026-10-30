// Discord REST v10 的最小封装。
//
// 只用原生 fetch（零依赖），自己做三件事：
//   1. 429 按 retry_after 睡够了再重试（Discord 的限流是"惩罚式"的，硬顶会越限越狠）；
//   2. 5xx 指数退避（网关抖动，重试即可）；
//   3. 4xx 直接抛，带 Discord 给的 code/message，方便一眼看出是权限还是参数问题。
//
// 顺带两个安全细节：
//   - allowed_mentions 永远 parse: []，模型吐出 @everyone 也不会真的 ping 人；
//   - 日志里不打印 URL 里的 token（这里 token 走 header，本来也不会进 URL）。

const API_BASE = 'https://discord.com/api/v10'
const USER_AGENT = 'DiscordBot (https://github.com/Hang0618/dsh-discord, 0.6.15)'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export class DiscordError extends Error {
  constructor(message, { status, code, body } = {}) {
    super(message)
    this.name = 'DiscordError'
    this.status = status
    this.code = code
    this.body = body
  }
}

export class DiscordRest {
  /**
   * @param {{token: string, log: Function, baseUrl?: string}} options
   */
  constructor({ token, log, baseUrl = API_BASE }) {
    this.token = token
    this.log = log
    this.baseUrl = baseUrl
    this.me = null
  }

  get authorization() {
    return `Bot ${this.token}`
  }

  /**
   * @param {string} method
   * @param {string} path - 以 / 开头
   * @param {{body?: object, retries?: number, query?: Record<string,string>}} [options]
   */
  async request(method, path, options = {}) {
    const retries = options.retries ?? 4
    const url = new URL(this.baseUrl + path)
    for (const [key, value] of Object.entries(options.query || {})) url.searchParams.set(key, value)

    let attempt = 0
    for (;;) {
      attempt += 1
      let response
      try {
        response = await fetch(url, {
          method,
          headers: {
            Authorization: this.authorization,
            'User-Agent': USER_AGENT,
            ...(options.body ? { 'Content-Type': 'application/json' } : {}),
          },
          body: options.body ? JSON.stringify(options.body) : undefined,
        })
      } catch (error) {
        // 网络层炸了：退避重试（DNS / 连接重置都走这里）
        if (attempt > retries) throw new DiscordError(`网络错误：${error?.message || error}`, { code: 'network' })
        await sleep(500 * 2 ** (attempt - 1))
        continue
      }

      if (response.status === 429) {
        let retryAfter = 1
        try {
          const payload = await response.json()
          retryAfter = Number(payload.retry_after) || 1
        } catch {}
        if (attempt > retries) throw new DiscordError('被 Discord 限流', { status: 429, code: 'rate_limited' })
        this.log?.(`REST 429，等 ${retryAfter.toFixed(2)}s 重试：${method} ${path}`)
        await sleep(Math.min(30_000, retryAfter * 1000 + 150))
        continue
      }

      if (response.status >= 500) {
        if (attempt > retries) throw new DiscordError(`Discord 服务端错误 ${response.status}`, { status: response.status })
        await sleep(500 * 2 ** (attempt - 1))
        continue
      }

      const text = await response.text()
      let data = null
      if (text) {
        try {
          data = JSON.parse(text)
        } catch {
          data = text
        }
      }

      if (!response.ok) {
        const message = data && typeof data === 'object' ? data.message : String(data || '')
        throw new DiscordError(`Discord API ${response.status}：${message || '未知错误'}`, {
          status: response.status,
          code: data && typeof data === 'object' ? data.code : undefined,
          body: data,
        })
      }

      // 顺带记一下配额剩余，方便排查「为什么突然不回了」
      const remaining = response.headers.get('x-ratelimit-remaining')
      if (remaining === '0') {
        const resetAfter = Number(response.headers.get('x-ratelimit-reset-after')) || 1
        if (resetAfter > 0.9) await sleep(Math.min(5000, resetAfter * 1000))
      }

      return data
    }
  }

  async getMe() {
    const me = await this.request('GET', '/users/@me')
    this.me = me
    return me
  }

  async sendMessage(channelId, content, { replyTo } = {}) {
    return this.request('POST', `/channels/${channelId}/messages`, {
      body: {
        content,
        allowed_mentions: { parse: [], replied_user: false },
        ...(replyTo ? { message_reference: { message_id: replyTo, fail_if_not_exists: false } } : {}),
      },
    })
  }

  async editMessage(channelId, messageId, content) {
    return this.request('PATCH', `/channels/${channelId}/messages/${messageId}`, {
      body: { content, allowed_mentions: { parse: [], replied_user: false } },
    })
  }

  async deleteMessage(channelId, messageId) {
    return this.request('DELETE', `/channels/${channelId}/messages/${messageId}`)
  }

  async sendTyping(channelId) {
    try {
      await this.request('POST', `/channels/${channelId}/typing`)
    } catch {
      // typing 失败无所谓，别把主流程带崩
    }
  }

  /** 取频道信息：DM 频道 type=1，缺 info 时用来判断是不是私聊。 */
  async getChannel(channelId) {
    return this.request('GET', `/channels/${channelId}`)
  }
}
