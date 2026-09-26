/** aigility-harness 接入：同源会话代理（默认）+ 手工网关覆盖 + 连接探测 + OpenAI 兼容 SSE 流式客户端 */

import { getToken } from './api'

export interface HarnessCfg {
  /** 留空 = 走同源会话代理（推荐, 服务端持有主密钥）；填写 = 直连自备网关（用户自有 key） */
  url?: string
  key?: string
  /** dev 链路 (/v1/chat/completions) 使用的模型名；agent 链路由服务端 persona 决定，无需填写 */
  model?: string
}

/**
 * localStorage 存储 key 用 v2：旧 key 曾被早期版本的页面注入逻辑自动写入网关主密钥,
 * 换 key 使遗留缓存整体失效, 所有会话回落到安全的同源代理默认路径。
 */
const KEY = 'timem-harness-cfg-v2'

/** 仅读用户手工配置（本版本起服务端不再注入 window.FDE_GATEWAY） */
export function getHarnessCfg(): HarnessCfg {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as HarnessCfg
  } catch {
    return {}
  }
}

export function saveHarnessCfg(cfg: HarnessCfg) {
  localStorage.setItem(KEY, JSON.stringify(cfg))
}

/** 探测本地网关是否在线（no-cors，能连上即视为在线） */
export async function testHarnessConnection(url: string, timeoutMs = 2500): Promise<boolean> {
  try {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), timeoutMs)
    await fetch(url, { mode: 'no-cors', signal: ctl.signal })
    clearTimeout(t)
    return true
  } catch {
    return false
  }
}

export interface HarnessChatMsg {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** 逐帧解析 OpenAI 兼容 SSE，onToken 回调累计全文；失败抛错由调用方回退 */
async function pumpOpenAiSse(res: Response, onToken: (full: string) => void): Promise<string> {
  if (res.status === 401) throw new Error('登录已过期，请重新登录')
  if (!res.ok || !res.body) throw new Error(`gateway responded ${res.status}`)
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let full = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) {
      const s = line.trim()
      if (!s.startsWith('data:')) continue
      const data = s.slice(5).trim()
      if (data === '[DONE]') return full
      let j: unknown
      try {
        j = JSON.parse(data)
      } catch {
        continue // 心跳/注释等非 JSON 帧
      }
      const errText = (j as { error?: unknown }).error
      if (errText) throw new Error(typeof errText === 'string' ? errText : JSON.stringify(errText))
      const delta: string = (j as { choices?: Array<{ delta?: { content?: string } }> }).choices?.[0]?.delta?.content ?? ''
      if (delta) {
        full += delta
        onToken(full)
      }
    }
  }
  return full
}

function gatewayHeaders(cfg: HarnessCfg): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...(cfg.key ? { Authorization: `Bearer ${cfg.key}` } : {}),
  }
}

/** 登录会话请求头（同源代理路由据此校验 AppBase 会话） */
function sessionHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
  }
}

/** agent 链路目标：手工配置了网关 → 直连（用户自有 key）；缺省 → 同源会话代理（主密钥仅服务端） */
function agentTarget(cfg: HarnessCfg, path: string): { url: string; headers: Record<string, string> } {
  if (cfg.url) return { url: `${cfg.url.replace(/\/+$/, '')}${path}`, headers: gatewayHeaders(cfg) }
  return { url: path, headers: sessionHeaders() }
}

/**
 * dev 链路：OpenAI 兼容 /v1/chat/completions（stream:true）。
 * 直接打 LLM（协议适配 → 认知层），不经 persona，适合通用客户端与调试。
 * 仅在手工配置了网关时可用（dev 链路不走同源代理，密钥为用户自备）。
 */
export async function streamHarnessChat(
  cfg: HarnessCfg,
  messages: HarnessChatMsg[],
  onToken: (full: string) => void,
): Promise<string> {
  if (!cfg.url) throw new Error('dev 链路需在网关配置中手工填写地址与 key')
  const res = await fetch(`${cfg.url.replace(/\/+$/, '')}/v1/chat/completions`, {
    method: 'POST',
    headers: gatewayHeaders(cfg),
    body: JSON.stringify({ model: cfg.model || 'glm-4.6', messages, stream: true }),
  })
  return pumpOpenAiSse(res, onToken)
}

/** agent 链路请求体：@persona/fde-assistant 契约（见 packages/layer-persona/src/fde-assistant.ts） */
export interface FdeChatBody {
  user_input: string
  user_key?: string
  session_id?: string
  business_context?: string
  history?: Array<{ role: 'user' | 'assistant'; content: string }>
}

/**
 * agent 链路：数字员工开放问答 → /api/fde-chat（@persona/fde-assistant）。
 * 缺省走同源会话代理（服务端注入工作台业务上下文与 TiMEM 记忆），流式回包为 OpenAI 兼容 SSE；
 * 手工配置网关时直连该网关。
 */
export async function streamFdeChat(
  cfg: HarnessCfg,
  body: FdeChatBody,
  onToken: (full: string) => void,
): Promise<string> {
  const t = agentTarget(cfg, '/api/fde-chat')
  const res = await fetch(t.url, {
    method: 'POST',
    headers: t.headers,
    body: JSON.stringify({ ...body, stream: true }),
  })
  return pumpOpenAiSse(res, onToken)
}

// ── D5 文档工人：结构化块 → 服务端 docx ──────────────────────────

export type DocBlock =
  | { type: 'heading'; text: string; level?: 1 | 2 | 3 }
  | { type: 'paragraph'; text: string; bold?: boolean }
  | { type: 'bullets'; items: string[] }
  | { type: 'table'; header: string[]; rows: string[][] }

export interface FdeDocPayload {
  title: string
  subtitle?: string
  creator?: string
  basename?: string
  blocks: DocBlock[]
}

/** 服务端 /api/fde-doc（@action/doc-worker）生成真实 .docx 并触发浏览器下载（缺省同源会话代理） */
export async function generateProposalDocx(
  cfg: HarnessCfg,
  doc: FdeDocPayload,
): Promise<{ filename: string; bytes: number }> {
  const t = agentTarget(cfg, '/api/fde-doc')
  const res = await fetch(t.url, {
    method: 'POST',
    headers: t.headers,
    body: JSON.stringify(doc),
  })
  if (!res.ok) throw new Error(`doc-worker responded ${res.status}`)
  const j = (await res.json()) as { ok?: boolean; filename?: string; bytes?: number; base64?: string; error?: string }
  if (!j.ok || !j.base64 || !j.filename) throw new Error(j.error ?? 'doc-worker returned no payload')
  const bin = atob(j.base64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = j.filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 3000)
  return { filename: j.filename, bytes: j.bytes ?? blob.size }
}
