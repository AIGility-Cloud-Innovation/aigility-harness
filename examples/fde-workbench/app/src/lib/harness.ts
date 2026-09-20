/** aigility-harness 本地网关接入：配置解析 + 连接探测 + OpenAI 兼容 SSE 流式客户端 */

export interface HarnessCfg {
  url?: string
  key?: string
  /** dev 链路 (/v1/chat/completions) 使用的模型名；agent 链路由服务端 persona 决定，无需填写 */
  model?: string
}

const KEY = 'timem-harness-cfg'

declare global {
  interface Window {
    /** 服务端注入的网关缺省配置（examples/fde-workbench 静态托管时自动写入） */
    FDE_GATEWAY?: { url?: string; key?: string }
  }
}

/** 配置优先级：localStorage（用户手工配置）> 服务端注入 window.FDE_GATEWAY > 空 */
export function getHarnessCfg(): HarnessCfg {
  let saved: HarnessCfg = {}
  try {
    saved = JSON.parse(localStorage.getItem(KEY) ?? '{}')
  } catch {
    saved = {}
  }
  const injected = typeof window !== 'undefined' ? window.FDE_GATEWAY : undefined
  const merged: HarnessCfg = {
    url: saved.url || injected?.url,
    key: saved.key || injected?.key,
    model: saved.model,
  }
  // 服务端注入的配置视为已连接环境，缓存到 localStorage 便于探测逻辑统一
  if (!localStorage.getItem(KEY) && merged.url) saveHarnessCfg(merged)
  return merged
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

const gatewayBase = (cfg: HarnessCfg) => (cfg.url ?? '').replace(/\/+$/, '')

/**
 * dev 链路：OpenAI 兼容 /v1/chat/completions（stream:true）。
 * 直接打 LLM（协议适配 → 认知层），不经 persona，适合通用客户端与调试。
 */
export async function streamHarnessChat(
  cfg: HarnessCfg,
  messages: HarnessChatMsg[],
  onToken: (full: string) => void,
): Promise<string> {
  const res = await fetch(`${gatewayBase(cfg)}/v1/chat/completions`, {
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
 * 服务端注入工作台业务上下文与 TiMEM 记忆，流式回包为 OpenAI 兼容 SSE。
 */
export async function streamFdeChat(
  cfg: HarnessCfg,
  body: FdeChatBody,
  onToken: (full: string) => void,
): Promise<string> {
  const res = await fetch(`${gatewayBase(cfg)}/api/fde-chat`, {
    method: 'POST',
    headers: gatewayHeaders(cfg),
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

/** 服务端 /api/fde-doc（@action/doc-worker）生成真实 .docx 并触发浏览器下载 */
export async function generateProposalDocx(
  cfg: HarnessCfg,
  doc: FdeDocPayload,
): Promise<{ filename: string; bytes: number }> {
  const res = await fetch(`${gatewayBase(cfg)}/api/fde-doc`, {
    method: 'POST',
    headers: gatewayHeaders(cfg),
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
