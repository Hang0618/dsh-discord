// 极简日志：控制台 + 滚动文件。
//
// 为什么不用 console 完事：插件跑在桌面版 GUI 里，主人看不到 stdout；
// 出问题只能翻文件。日志写到 <DSH_HOME>/discord-bridge.log，
// **绝不写 token**（调用方自己负责脱敏，这里再做一层兜底）。

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const LOG_PATH = join(DSH_HOME, 'discord-bridge.log')
const MAX_BYTES = 2 * 1024 * 1024
const SECRETS = [/[A-Za-z0-9_\-]{24,}\.[A-Za-z0-9_\-]{6}\.[A-Za-z0-9_\-]{27,}/g]

function scrub(text) {
  let out = String(text)
  for (const re of SECRETS) out = out.replace(re, '<token>')
  return out
}

export function log(...parts) {
  const line = `${new Date().toISOString()} ${parts.map((p) => (typeof p === 'string' ? p : safeJson(p))).join(' ')}`
  const clean = scrub(line)
  try {
    console.log('[dsh-discord]', clean)
  } catch {}
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true })
    if (existsSync(LOG_PATH) && statSync(LOG_PATH).size > MAX_BYTES) {
      renameSync(LOG_PATH, `${LOG_PATH}.1`)
    }
    appendFileSync(LOG_PATH, `${clean}\n`, 'utf8')
  } catch {}
}

function safeJson(value) {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export { LOG_PATH }
