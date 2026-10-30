// dsh-discord 的 GUI 侧：设置页里的「Discord 准入」卡片。
//
// Host 会把陌生人的 @ 和机器人说的话挂成一条待确认（/api/dsh-discord/pending），
// 这里列出来让主人拍板：
//   人：允许 / 拒绝，以及「这个人是不是每次都要 @ 我」；
//   机器人：接不接收、要不要真的跟它聊（拒绝就再也不理它）。
// 只走同源接口，不做任何跨域请求。

window.__ModuleLoader__.load({
  id: 'dsh-discord',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const API = '/api/dsh-discord'
    const h = react.createElement

    const S = {
      card: {
        display: 'grid',
        gap: '10px',
        padding: '14px 16px',
        borderRadius: '12px',
        border: '1px solid rgba(127,127,127,0.28)',
        background: 'rgba(127,127,127,0.06)',
        fontSize: '13px',
      },
      empty: { opacity: 0.7 },
      row: {
        display: 'grid',
        gap: '6px',
        padding: '10px 12px',
        borderRadius: '10px',
        border: '1px solid rgba(127,127,127,0.22)',
      },
      head: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      name: { fontWeight: 600 },
      user: { opacity: 0.65, fontSize: '12px' },
      snippet: { opacity: 0.75, fontSize: '12px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
      actions: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '2px' },
      btn: {
        padding: '5px 10px',
        borderRadius: '8px',
        border: '1px solid rgba(127,127,127,0.35)',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontSize: '12px',
        cursor: 'pointer',
      },
      allow: { borderColor: 'rgba(46,160,67,0.6)' },
      deny: { borderColor: 'rgba(220,80,80,0.55)' },
      grantRow: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', opacity: 0.85 },
      hint: { opacity: 0.6, fontSize: '12px', lineHeight: 1.5 },
    }

    async function jget(path) {
      const response = await fetch(API + path, { headers: { accept: 'application/json' } })
      return response.json()
    }

    async function jpost(path, body) {
      const response = await fetch(API + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      return response.json()
    }

    // ---------- 余额通知：跌破线时在 DSH 里弹一条（不依赖设置面板开着） ----------

    let noticeSeenAt = 0
    let noticeEl = null
    let noticeTimer = null

    function showNotice(text) {
      try {
        // 浏览器系统通知（有权限才弹）
        if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
          try {
            new Notification('我先歇一下', { body: text })
          } catch {}
        }
        // 页面右下角浮条：没权限也能看见
        if (!noticeEl) {
          noticeEl = document.createElement('div')
          noticeEl.setAttribute('data-dsh-discord-notice', '1')
          noticeEl.style.cssText = [
            'position:fixed',
            'right:18px',
            'bottom:18px',
            'z-index:2147483000',
            'max-width:340px',
            'padding:12px 15px',
            'border-radius:12px',
            'border:1px solid rgba(220,80,80,0.55)',
            'background:rgba(38,20,22,0.96)',
            'color:#ffe8e8',
            'font:13px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif',
            'box-shadow:0 10px 30px rgba(0,0,0,0.35)',
            'cursor:pointer',
            'white-space:pre-wrap',
          ].join(';')
          document.body.appendChild(noticeEl)
        }
        noticeEl.textContent = text
        noticeEl.style.display = 'block'
        if (noticeTimer) clearTimeout(noticeTimer)
        noticeTimer = setTimeout(() => {
          try {
            noticeEl && (noticeEl.style.display = 'none')
          } catch {}
        }, 15000)
      } catch {}
    }

    async function pollNotice() {
      try {
        const res = await jget('/budget')
        const notice = res?.notice
        if (!notice || !notice.at || notice.at <= noticeSeenAt) return
        noticeSeenAt = notice.at
        const who = notice.label ? `${notice.label}` : '这边'
        const cur = notice.currency || 'CNY'
        if (notice.reason === 'quota') {
          showNotice(
            `主人给${who}划的花费额度是 ${notice.quota} ${cur}，已经花到 ${notice.spent} ${cur}，` +
              `Discord 聊天先暂停了。\n把账本清零、或者把额度调大，我才接着说。`,
          )
        } else {
          showNotice(
            `余额 ${notice.total} ${cur} 已经跌到${who}的线 ${notice.min} ${cur}，` +
              `Discord 聊天先暂停了。\n充值以后我自己就醒，不用管。`,
          )
        }
      } catch {}
    }

    function installNotice(ctx) {
      const timer = setInterval(() => void pollNotice(), 15000)
      void pollNotice()
      ctx.effect(
        () => () => {
          clearInterval(timer)
          if (noticeTimer) clearTimeout(noticeTimer)
          try {
            noticeEl && noticeEl.remove()
          } catch {}
          noticeEl = null
        },
        'dsh-discord: budget notice',
      )
    }

    function AccessPanel() {
      const [pending, setPending] = react.useState([])
      const [grants, setGrants] = react.useState({})
      const [botPolicy, setBotPolicy] = react.useState({})
      const [busy, setBusy] = react.useState('')
      const [error, setError] = react.useState('')

      const reload = react.useCallback(async () => {
        try {
          const [p, g] = await Promise.all([jget('/pending'), jget('/grants')])
          setPending(Array.isArray(p?.pending) ? p.pending : [])
          setGrants(g?.grants && typeof g.grants === 'object' ? g.grants : {})
          setBotPolicy(g?.botPolicy && typeof g.botPolicy === 'object' ? g.botPolicy : {})
          setError('')
        } catch (err) {
          setError(String(err?.message || err))
        }
      }, [])

      react.useEffect(() => {
        void reload()
        const timer = setInterval(() => void reload(), 5000)
        return () => clearInterval(timer)
      }, [reload])

      const decide = async (entry, decision) => {
        if (busy) return
        setBusy(entry.id)
        try {
          const result = await jpost('/decide', { id: entry.id, ...decision })
          if (result?.ok !== true) setError(result?.error || '拍板失败')
          await reload()
        } catch (err) {
          setError(String(err?.message || err))
        } finally {
          setBusy('')
        }
      }

      const revoke = async (userId, kind) => {
        if (busy) return
        setBusy('revoke:' + userId)
        try {
          await jpost('/revoke', { userId, kind: kind === 'bot' ? 'bot' : 'user' })
          await reload()
        } catch (err) {
          setError(String(err?.message || err))
        } finally {
          setBusy('')
        }
      }

      const grantEntries = Object.entries(grants)
      const botEntries = Object.entries(botPolicy)

      const personRow = (entry) =>
        h(
          'div',
          { key: entry.id, style: S.row },
          h(
            'div',
            { style: S.head },
            h('span', { style: S.name }, entry.userName || entry.userId),
            h('span', { style: S.user }, entry.userId),
            entry.guildId ? h('span', { style: S.user }, `服务器 ${entry.guildId}`) : null,
          ),
          entry.snippet ? h('div', { style: S.snippet }, `「${entry.snippet}」`) : null,
          h(
            'div',
            { style: S.actions },
            h(
              'button',
              {
                type: 'button',
                style: { ...S.btn, ...S.allow },
                disabled: Boolean(busy),
                onClick: () => void decide(entry, { allow: true, requireMention: false }),
              },
              '允许，名字/@ 都行',
            ),
            h(
              'button',
              {
                type: 'button',
                style: S.btn,
                disabled: Boolean(busy),
                onClick: () => void decide(entry, { allow: true, requireMention: true }),
              },
              '允许，每次都要 @',
            ),
            h(
              'button',
              {
                type: 'button',
                style: { ...S.btn, ...S.deny },
                disabled: Boolean(busy),
                onClick: () => void decide(entry, { allow: false }),
              },
              '拒绝',
            ),
          ),
        )

      const botRow = (entry) =>
        h(
          'div',
          { key: entry.id, style: S.row },
          h(
            'div',
            { style: S.head },
            h('span', { style: S.name }, entry.userName || entry.userId),
            h('span', { style: S.user }, '机器人'),
            h('span', { style: S.user }, entry.userId),
            entry.guildId ? h('span', { style: S.user }, `服务器 ${entry.guildId}`) : null,
          ),
          entry.snippet ? h('div', { style: S.snippet }, `「${entry.snippet}」`) : null,
          h(
            'div',
            { style: S.actions },
            h(
              'button',
              {
                type: 'button',
                style: { ...S.btn, ...S.allow },
                disabled: Boolean(busy),
                onClick: () => void decide(entry, { allow: true, chat: true }),
              },
              '接收，并跟它聊',
            ),
            h(
              'button',
              {
                type: 'button',
                style: S.btn,
                disabled: Boolean(busy),
                onClick: () => void decide(entry, { allow: true, chat: false }),
              },
              '只接收，不主动回',
            ),
            h(
              'button',
              {
                type: 'button',
                style: { ...S.btn, ...S.deny },
                disabled: Boolean(busy),
                onClick: () => void decide(entry, { allow: false }),
              },
              '拒绝',
            ),
          ),
        )

      return h(
        'div',
        { style: S.card },
        h('div', { style: S.head }, h('span', { style: S.name }, 'Discord 准入'),
          h('span', { style: S.user }, pending.length > 0 ? `${pending.length} 个在等我回话` : '暂时没人等着')),
        h(
          'div',
          { style: S.hint },
          '私聊永远只认主人。服务器里别人想跟我说话，得先 @ 我，再由这里点头；',
          '「每次都要 @」= 以后必须 @ 或引用我；「不用每次 @」= @ 之外，叫我的名字（关键词）也叫得动，但不会每句都接。',
          ' 别的机器人说话也会先挂在这儿：可以选「接收并跟它聊」或「只接收、不主动回」，决定会记住。',
        ),
        error ? h('div', { style: { ...S.snippet, color: 'rgb(220,110,110)' } }, error) : null,
        pending.length === 0
          ? h('div', { style: S.empty }, '没有待确认的。')
          : pending.map((entry) => (entry.kind === 'bot' ? botRow(entry) : personRow(entry))),
        grantEntries.length > 0
          ? h(
              'div',
              { style: { display: 'grid', gap: '6px', marginTop: '4px' } },
              h('div', { style: S.name }, '已批准的人'),
              grantEntries.map(([userId, grant]) =>
                h(
                  'div',
                  { key: userId, style: S.grantRow },
                  h('span', null, grant?.name || userId),
                  h('span', { style: S.user }, userId),
                  h('span', { style: S.user }, grant?.requireMention === false ? '名字/@ 都行' : '每次都要 @'),
                  h(
                    'button',
                    {
                      type: 'button',
                      style: S.btn,
                      disabled: Boolean(busy),
                      onClick: () => void revoke(userId, 'user'),
                    },
                    '撤回',
                  ),
                ),
              ),
            )
          : null,
        botEntries.length > 0
          ? h(
              'div',
              { style: { display: 'grid', gap: '6px', marginTop: '4px' } },
              h('div', { style: S.name }, '已批准的机器人'),
              botEntries.map(([botId, policy]) =>
                h(
                  'div',
                  { key: botId, style: S.grantRow },
                  h('span', null, policy?.name || botId),
                  h('span', { style: S.user }, botId),
                  h('span', { style: S.user }, policy?.chat === true ? '会跟它聊' : '只接收，不主动回'),
                  h(
                    'button',
                    {
                      type: 'button',
                      style: S.btn,
                      disabled: Boolean(busy),
                      onClick: () => void revoke(botId, 'bot'),
                    },
                    '撤回',
                  ),
                ),
              ),
            )
          : null,
      )
    }

    function BudgetPanel() {
      const [data, setData] = react.useState(null)
      const [error, setError] = react.useState('')
      const [busy, setBusy] = react.useState('')
      const [draft, setDraft] = react.useState({
        enabled: true,
        global: '',
        dm: '',
        globalQuota: '',
        dmQuota: '',
      })
      const [guildDraft, setGuildDraft] = react.useState({})
      const [newGuild, setNewGuild] = react.useState({ id: '', min: '', quota: '' })
      const [dirty, setDirty] = react.useState(false)
      const [notifyState, setNotifyState] = react.useState(
        typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
      )

      const syncDraft = react.useCallback((next) => {
        const b = next?.budget || {}
        const asText = (v) => (v === null || v === undefined ? '' : String(v))
        setDraft({
          enabled: b.enabled !== false,
          skipOwners: b.skipOwners !== false,
          global: b.global ? String(b.global) : '',
          dm: asText(b.dm),
          globalQuota: asText(b.globalQuota),
          dmQuota: asText(b.dmQuota),
          guildHistoryLimit: asText(next?.guildHistoryLimit ?? 10),
        })
        const rows = Array.isArray(next?.guilds) ? next.guilds : []
        const map = {}
        for (const row of rows) map[row.id] = { min: asText(row.min), quota: asText(row.quota) }
        setGuildDraft(map)
      }, [])

      const reload = react.useCallback(
        async (force) => {
          try {
            const res = await jget('/budget' + (force ? '?refresh=1' : ''))
            if (res?.ok) {
              setData(res)
              setError('')
              if (!dirty) syncDraft(res)
            } else {
              setError(res?.error || '读不到余额设置')
            }
          } catch (err) {
            setError(String(err?.message || err))
          }
        },
        [dirty, syncDraft],
      )

      react.useEffect(() => {
        void reload(false)
        const timer = setInterval(() => void reload(false), 10000)
        return () => clearInterval(timer)
      }, [reload])

      const patchDraft = (patch) => {
        setDirty(true)
        setDraft((prev) => ({ ...prev, ...patch }))
      }

      const save = async () => {
        if (busy) return
        setBusy('save')
        try {
          const textOf = (v) => String(v === null || v === undefined ? '' : v).trim()
          const gRow = (id) => guildDraft[id] || { min: '', quota: '' }
          const guilds = {}
          const names = {}
          for (const row of Array.isArray(data?.guilds) ? data.guilds : []) {
            if (row.name) names[row.id] = row.name
            const entry = {}
            const minRaw = textOf(gRow(row.id).min)
            const quotaRaw = textOf(gRow(row.id).quota)
            if (minRaw !== '') entry.min = Number(minRaw) // 留空 = 跟全局走
            if (quotaRaw !== '') entry.quota = Number(quotaRaw)
            if (Object.keys(entry).length > 0) guilds[row.id] = { name: row.name || '', ...entry }
          }
          const manualId = textOf(newGuild.id)
          if (manualId) {
            const entry = {}
            const minRaw = textOf(newGuild.min)
            const quotaRaw = textOf(newGuild.quota)
            if (minRaw !== '') entry.min = Number(minRaw)
            if (quotaRaw !== '') entry.quota = Number(quotaRaw)
            if (Object.keys(entry).length > 0) {
              guilds[manualId] = { name: names[manualId] || '', ...entry }
            } else {
              guilds[manualId] = { name: names[manualId] || '', min: null }
            }
          }
          const res = await jpost('/budget', {
            enabled: draft.enabled,
            skipOwners: draft.skipOwners !== false,
            guildHistoryLimit:
              textOf(draft.guildHistoryLimit) === '' ? 0 : Number(draft.guildHistoryLimit),
            global: textOf(draft.global) === '' ? 0 : Number(draft.global),
            dm: textOf(draft.dm) === '' ? null : Number(draft.dm),
            globalQuota: textOf(draft.globalQuota) === '' ? null : Number(draft.globalQuota),
            dmQuota: textOf(draft.dmQuota) === '' ? null : Number(draft.dmQuota),
            guilds,
            guildNames: names,
          })
          if (res?.ok) {
            setDirty(false)
            setNewGuild({ id: '', min: '', quota: '' })
            await reload(true)
          } else {
            setError(res?.error || '保存失败')
          }
        } catch (err) {
          setError(String(err?.message || err))
        } finally {
          setBusy('')
        }
      }

      const askNotify = async () => {
        try {
          if (typeof Notification === 'undefined') {
            setNotifyState('unsupported')
            showNotice('这个环境没有系统通知，我改用页面右下角的红条提醒主人（这个能看到）。')
            return
          }
          let perm = Notification.permission
          if (perm !== 'granted') perm = await Notification.requestPermission()
          setNotifyState(perm)
          showNotice(
            perm === 'granted'
              ? '系统通知已经开了 ✅ 我踩到预算线时会这样提醒主人。'
              : `系统通知被拒了（${perm}），我改用页面右下角红条提醒，一样能看到。`,
          )
        } catch (err) {
          setNotifyState('error')
          showNotice(`通知没开成：${err?.message || err}。不过页面红条照旧能用。`)
        }
      }

      const resetSpend = async (key) => {
        if (busy) return
        setBusy('reset')
        try {
          const res = await jpost('/spend-reset', key ? { key } : {})
          if (res?.ok) {
            setData(res)
            setError('')
          } else {
            setError(res?.error || '清零失败')
          }
        } catch (err) {
          setError(String(err?.message || err))
        } finally {
          setBusy('')
        }
      }

      const bal = data?.balance
      const balText = !bal
        ? '读取中…'
        : bal.ok
          ? `${bal.total} ${bal.currency || 'CNY'}`
          : `读不到（${bal.error || '原因未知'}）`
      const balBad = Boolean(bal && bal.ok && data?.budget?.global > 0 && bal.total <= data.budget.global)
      const spendMap = data?.spend || {}
      const spentOf = (key) => Number(spendMap?.[key]?.spent || 0)
      const totalSpent = Object.values(spendMap).reduce((sum, v) => sum + Number(v?.spent || 0), 0)
      const currency = bal?.currency || 'CNY'
      const money = (v) => Number(v || 0).toFixed(4)

      const numInput = (value, onChange, placeholder, step) =>
        h('input', {
          type: 'number',
          min: '0',
          step: step || '0.01',
          value,
          placeholder: placeholder || '留空 = 跟全局',
          onChange: (e) => onChange(e.target.value),
          style: {
            width: '110px',
            padding: '4px 8px',
            borderRadius: '8px',
            border: '1px solid rgba(127,127,127,0.35)',
            background: 'transparent',
            color: 'inherit',
            font: 'inherit',
            fontSize: '12px',
          },
        })

      const guildRows = Array.isArray(data?.guilds) ? data.guilds : []

      return h(
        'div',
        { style: S.card },
        h(
          'div',
          { style: S.head },
          h('span', { style: S.name }, '余额预算'),
          h(
            'span',
            { style: { ...S.user, color: balBad ? 'rgb(220,110,110)' : undefined } },
            balBad
              ? `余额 ${balText}！跌破线了`
              : `余额 ${balText} · 已花 ${money(totalSpent)} ${currency}`,
          ),
          h(
            'button',
            {
              type: 'button',
              style: S.btn,
              disabled: Boolean(busy),
              onClick: () => void reload(true),
            },
            '刷新余额',
          ),
          h(
            'button',
            {
              type: 'button',
              style: S.btn,
              onClick: () => void askNotify(),
            },
            notifyState === 'granted' ? '通知已开启 · 测一下' : '开启桌面通知',
          ),
          h(
            'button',
            {
              type: 'button',
              style: S.btn,
              disabled: Boolean(busy),
              onClick: () => void resetSpend(''),
            },
            '花费清零',
          ),
        ),
        h(
          'div',
          { style: S.hint },
          '两道闸门：①余额跌到线以下（≤）就停，充值回升自动恢复；②花费到了额度也停，要清零或调大额度才继续。',
          '额度只管服务器里的其他人；主人自己聊天默认不卡额度（上面有开关）。',
          '「全局」管所有地方；「私聊」「某个服务器」留空 = 跟全局走，填 0 = 这里不限（可拿它豁免全局）。',
          '花费按 DeepSeek 官方价折算（缓存命中/未命中/输出），高峰时段按高峰价。',
        ),
        h(
          'div',
          { style: S.head },
          h('span', null, '总开关'),
          h('input', {
            type: 'checkbox',
            checked: draft.enabled !== false,
            onChange: (e) => patchDraft({ enabled: e.target.checked }),
          }),
          h('span', { style: S.user }, bal?.ok && bal.at ? `上次读到：${new Date(bal.at).toLocaleTimeString()}` : ''),
        ),
        h(
          'div',
          { style: S.actions },
          h('span', null, '主人聊天不计额度'),
          h('input', {
            type: 'checkbox',
            checked: draft.skipOwners !== false,
            onChange: (e) => patchDraft({ skipOwners: e.target.checked }),
          }),
          h(
            'span',
            { style: S.user },
            draft.skipOwners !== false
              ? '开：只有服务器里的其他人会碰到额度，主人自己聊天不受限制'
              : '关：主人自己也会被额度卡住',
          ),
        ),
        h(
          'div',
          { style: S.actions },
          h('span', null, '群聊先读几条历史'),
          numInput(
            draft.guildHistoryLimit,
            (v) => patchDraft({ guildHistoryLimit: v }),
            '0 = 不读，默认 10',
            '1',
          ),
          h('span', { style: S.user }, '只对服务器生效；私聊不读历史'),
        ),
        h(
          'div',
          { style: S.actions },
          h('span', null, '全局余额线'),
          numInput(draft.global, (v) => patchDraft({ global: v })),
          h('span', null, '私聊余额线'),
          numInput(draft.dm, (v) => patchDraft({ dm: v })),
        ),
        h(
          'div',
          { style: S.actions },
          h('span', null, '全局额度'),
          numInput(draft.globalQuota, (v) => patchDraft({ globalQuota: v })),
          h('span', null, '私聊额度'),
          numInput(draft.dmQuota, (v) => patchDraft({ dmQuota: v })),
        ),
        h(
          'div',
          { style: { display: 'grid', gap: '6px', marginTop: '4px' } },
          h('div', { style: S.name }, '某个服务器'),
          guildRows.length === 0
            ? h('div', { style: S.empty }, '还没见过服务器。先在服务器里说句话，我记下名字就出现了。')
            : guildRows.map((row) => {
                const g = guildDraft[row.id] || { min: '', quota: '' }
                const setG = (patch) => {
                  setDirty(true)
                  setGuildDraft((prev) => ({
                    ...prev,
                    [row.id]: { ...(prev[row.id] || { min: '', quota: '' }), ...patch },
                  }))
                }
                return h(
                  'div',
                  { key: row.id, style: S.grantRow },
                  h('span', null, row.name || row.id),
                  h('span', { style: S.user }, `已花 ${money(row.spent)} ${currency}`),
                  h('span', { style: S.user }, '余额线'),
                  numInput(g.min, (v) => setG({ min: v })),
                  h('span', { style: S.user }, '额度'),
                  numInput(g.quota, (v) => setG({ quota: v })),
                  h(
                    'button',
                    {
                      type: 'button',
                      style: S.btn,
                      disabled: Boolean(busy),
                      onClick: () => void resetSpend(`guild:${row.id}`),
                    },
                    '清零',
                  ),
                )
              }),
          h(
            'div',
            { style: S.grantRow },
            h('span', { style: S.user }, '手动加'),
            h('input', {
              type: 'text',
              value: newGuild.id,
              placeholder: '服务器 id',
              onChange: (e) => setNewGuild((prev) => ({ ...prev, id: e.target.value })),
              style: {
                width: '190px',
                padding: '4px 8px',
                borderRadius: '8px',
                border: '1px solid rgba(127,127,127,0.35)',
                background: 'transparent',
                color: 'inherit',
                font: 'inherit',
                fontSize: '12px',
              },
            }),
            numInput(newGuild.min, (v) => setNewGuild((prev) => ({ ...prev, min: v }))),
            numInput(newGuild.quota, (v) => setNewGuild((prev) => ({ ...prev, quota: v }))),
          ),
        ),
        error ? h('div', { style: { ...S.snippet, color: 'rgb(220,110,110)' } }, error) : null,
        h(
          'div',
          { style: S.actions },
          h(
            'button',
            {
              type: 'button',
              style: { ...S.btn, ...S.allow },
              disabled: Boolean(busy) || !dirty,
              onClick: () => void save(),
            },
            dirty ? '保存预算' : '已保存',
          ),
        ),
      )
    }

    function SettingsCard() {
      return h('div', { style: { display: 'grid', gap: '14px' } }, h(AccessPanel), h(BudgetPanel))
    }

    function apply(ctx) {
      installNotice(ctx)
      ctx.effect(
        () =>
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              {
                name: 'settings.section',
                id: 'discord-access',
                order: 60,
                label: () => 'Discord',
              },
              () => h(SettingsCard),
            ),
          ),
        'dsh-discord: settings section',
      )
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})
