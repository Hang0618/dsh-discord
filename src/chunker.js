// Markdown 感知的消息切分。
//
// Discord 单条上限 2000 字符，按 1900 留余量切。切得漂亮很重要：
//   - 切在代码块中间 → 两边都渲染成乱糟糟的灰底文本；
//   - 切在表格/列表中间 → 读起来断片。
// 所以优先按「段落 → 换行 → 空格 → 硬切」退让，并且**保证代码块在段内闭合**：
// 切点落在 ``` 里面时，本段末尾补一个 ```，下一段开头再补一个。

const FENCE_RE = /^\s*```/m

function countFences(text) {
  let count = 0
  let index = text.indexOf('```')
  while (index !== -1) {
    count += 1
    index = text.indexOf('```', index + 3)
  }
  return count
}

function pickCut(window) {
  const length = window.length
  const minKeep = Math.floor(length * 0.5)

  // 代码块优先：窗口里 ``` 是奇数 ⇒ 切点会落在代码块内部
  const fences = countFences(window)
  if (fences % 2 === 1) {
    const lastFence = window.lastIndexOf('```')
    if (lastFence >= minKeep) return lastFence
  }

  const para = window.lastIndexOf('\n\n')
  if (para >= minKeep) return para

  const nl = window.lastIndexOf('\n')
  if (nl >= minKeep) return nl

  const sp = window.lastIndexOf(' ')
  if (sp >= minKeep) return sp

  return length
}

/**
 * 把一段长文本切成若干条，每条不超过 limit。
 * @param {string} text
 * @param {number} [limit]
 * @returns {string[]}
 */
export function splitMessage(text, limit = 1900) {
  const source = String(text ?? '')
  if (!source.trim()) return []
  if (source.length <= limit) return [source]

  const parts = []
  let rest = source
  // 留 8 个字符给可能补上的 ``` 和换行
  const windowSize = Math.max(200, limit - 8)

  while (rest.length > limit) {
    const window = rest.slice(0, windowSize)
    const cut = Math.max(1, pickCut(window))
    let head = rest.slice(0, cut)
    let tail = rest.slice(cut)

    const openFences = countFences(head) % 2 === 1
    if (openFences) {
      head += '\n```'
      tail = '```\n' + tail
    }

    parts.push(head.replace(/\s+$/, ''))
    rest = tail.replace(/^\n+/, '')
  }

  if (rest.trim()) parts.push(rest)
  return parts.filter((part) => part.trim().length > 0)
}

/** 给消息加一个「续」标记，让长回复读起来有接续感（可选）。 */
export function withContinuation(part, index, total) {
  if (total <= 1) return part
  const tail = `\n\n*（${index + 1}/${total}）*`
  return part.length + tail.length <= 1990 ? part + tail : part
}

export { FENCE_RE }
