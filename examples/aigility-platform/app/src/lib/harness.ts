/**
 * aigility-harness 网关接入（与 fde-workbench 的 harness.ts 同构）：
 *   - 配置解析：localStorage > 服务端注入 window.AIGILITY_GATEWAY（静态托管时自动写入）
 *   - 对话链路：OpenAI 兼容 SSE 逐帧解析
 *     · streamAigilityChat → /api/aigility-chat（@persona/aigility-agent：工厂技能 + 平台管家）
 *     · streamPersonaChat → /api/aigility/p/<key>/chat（引擎 layer-persona 原生角色）
 *   - 封装 API（同源, 需 AppBase 登录会话）：注册表 / 技能发布 / 能力总线 / 模型上游 / 指标 / TiMEM
 */

import { authJsonFetch, getCurrentUser } from './api'

export interface HarnessCfg {
  url?: string
  key?: string
}

const KEY = 'aigility-harness-cfg'

declare global {
  interface Window {
    /** 服务端注入的网关缺省配置（examples/aigility-platform 静态托管时自动写入） */
    AIGILITY_GATEWAY?: { url?: string; key?: string }
  }
}

/** 配置优先级：localStorage（用户手工配置）> 服务端注入 window.AIGILITY_GATEWAY > 空 */
export function getHarnessCfg(): HarnessCfg {
  let saved: HarnessCfg = {}
  try {
    saved = JSON.parse(localStorage.getItem(KEY) ?? '{}')
  } catch {
    saved = {}
  }
  const injected = typeof window !== 'undefined' ? window.AIGILITY_GATEWAY : undefined
  const merged: HarnessCfg = {
    url: saved.url || injected?.url,
    key: saved.key || injected?.key,
  }
  if (!localStorage.getItem(KEY) && merged.url) saveHarnessCfg(merged)
  return merged
}

export function saveHarnessCfg(cfg: HarnessCfg) {
  localStorage.setItem(KEY, JSON.stringify(cfg))
}

// ── OpenAI 兼容 SSE 逐帧解析 ─────────────────────────────────────

/** 逐帧解析 OpenAI 兼容 SSE，onToken 回调累计全文；失败抛错由调用方回退 */
async function pumpOpenAiSse(res: Response, onToken: (full: string) => void): Promise<string> {
  if (!res.ok || !res.body) throw new Error(`网关响应 ${res.status}`)
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

export interface AigilityChatBody {
  user_input: string
  /** 智能体工厂发布的技能 id（缺省走平台管家） */
  skill_id?: string
  session_id?: string
  user_key?: string
  history?: Array<{ role: 'user' | 'assistant'; content: string }>
}

/** 数字员工对话 → /api/aigility-chat（@persona/aigility-agent，记忆按技能隔离） */
export async function streamAigilityChat(
  cfg: HarnessCfg,
  body: AigilityChatBody,
  onToken: (full: string) => void,
): Promise<string> {
  const res = await fetch(`${gatewayBase(cfg)}/api/aigility-chat`, {
    method: 'POST',
    headers: gatewayHeaders(cfg),
    body: JSON.stringify({ ...body, stream: true }),
  })
  return pumpOpenAiSse(res, onToken)
}

/** 引擎原生角色对话 → /api/aigility/p/<key>/chat（registry 下发的 route） */
export async function streamPersonaChat(
  cfg: HarnessCfg,
  route: string,
  body: { user_input: string; session_id?: string; user_key?: string },
  onToken: (full: string) => void,
): Promise<string> {
  const res = await fetch(`${gatewayBase(cfg)}${route}`, {
    method: 'POST',
    headers: gatewayHeaders(cfg),
    body: JSON.stringify({ ...body, stream: true }),
  })
  return pumpOpenAiSse(res, onToken)
}

// ── 封装 API（Web 同源 :1236, 全部要求 AppBase 登录会话）──────────

export interface PersonaInfo {
  personaId: string
  route: string
  name: string
  cat: string
  desc: string
  source: 'harness'
}

export interface SkillInfo {
  id: string
  name: string
  category: string
  description: string
  tags: string[]
  modelId: string
  prompt: string
  temperature: number
  knowledge: string[]
  tools: string[]
  visibility: string
  releaseNote: string
  status: '已发布'
  updatedAt: string
  usage: number
}

export interface RegistryPayload {
  personas: PersonaInfo[]
  skills: SkillInfo[]
  llm: string
}

export async function fetchRegistry(): Promise<RegistryPayload> {
  return authJsonFetch<RegistryPayload>('/api/aigility/registry')
}

export interface PublishSkillInput {
  id?: string
  name: string
  category: string
  description: string
  tags: string[]
  modelId: string
  prompt: string
  temperature: number
  knowledge: string[]
  tools: string[]
  visibility: string
  releaseNote: string
}

/** 智能体工厂「发布」→ 服务端 skill-registry 真注册，发布后立即可对话 */
export async function publishSkill(skill: PublishSkillInput): Promise<SkillInfo> {
  const j = await authJsonFetch<{ skill?: SkillInfo; error?: string }>('/api/aigility/skills', {
    method: 'POST',
    body: JSON.stringify(skill),
  })
  if (!j.skill) throw new Error(j.error ?? '发布失败')
  return j.skill
}

export async function deleteSkill(id: string): Promise<boolean> {
  const j = await authJsonFetch<{ ok?: boolean }>(`/api/aigility/skills/${encodeURIComponent(id)}`, { method: 'DELETE' })
  return j.ok ?? false
}

// ── 真接口：引擎能力总线 / 模型上游 / 运行指标 / TiMEM 记忆 ──────

export interface CapabilityInfo {
  id: string
  layer: string
  layerName: string
  description: string
}

/** 引擎能力总线（真）：内核已装配插件的全部 Provider */
export async function fetchCapabilities(): Promise<CapabilityInfo[]> {
  const j = await authJsonFetch<{ capabilities: CapabilityInfo[] }>('/api/aigility/capabilities')
  return j.capabilities
}

export interface LlmStatus {
  provider: string
  model: string
  baseUrl: string
  degraded: boolean
}

/** 模型管理（真）：当前引擎推理上游 */
export async function fetchLlmStatus(): Promise<LlmStatus> {
  return authJsonFetch<LlmStatus>('/api/aigility/llm')
}

export interface MetricsPayload {
  uptimeMs: number
  personas: number
  skills: number
  skillUsage: Record<string, number>
  butlerChats: number
  llm: string
}

/** 运营驾驶舱（真）：平台实时指标 */
export async function fetchMetrics(): Promise<MetricsPayload> {
  return authJsonFetch<MetricsPayload>('/api/aigility/metrics')
}

export interface TimemStatus {
  configured: boolean
  ok: boolean
  baseUrl: string
  latencyMs?: number
  error?: string
}

/** TiMEM 连接状态（真）：未配置 / 可达性探测 */
export async function fetchTimemStatus(): Promise<TimemStatus> {
  return authJsonFetch<TimemStatus>('/api/aigility/timem/status')
}

export interface DshToolInfo {
  name: string
  description: string
  parameters: unknown
}

export interface DshToolsPayload {
  ok: boolean
  hostAlive: boolean
  toolsMounted: boolean
  tools?: DshToolInfo[]
  error?: string
}

/** DSH ctx.tools 工具清单（真）：dsh-mcp-client 注册的 MCP 工具经 @action/dsh-tool 桥枚举 */
export async function fetchDshTools(): Promise<DshToolsPayload> {
  return authJsonFetch<DshToolsPayload>('/api/aigility/dsh/tools')
}

/** 直调一个 DSH 侧工具（args 为该工具 inputSchema 的 JSON 值） */
export async function callDshTool(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; value?: unknown; error?: string }> {
  return authJsonFetch('/api/aigility/dsh/tools/call', {
    method: 'POST',
    body: JSON.stringify({ name, args }),
  })
}

// ── 真接口：Token 用量 / 审计 / 团队 / 积分 / 文档工人 ────────────

export interface UsageGroup {
  key: string
  calls: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export interface UsageSummary {
  total: number
  calls: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  measuredCalls: number
  estimatedCalls: number
  byUser: UsageGroup[]
  byModel: UsageGroup[]
  byDay: UsageGroup[]
}

export interface UsageRecent {
  userId: string
  model: string
  promptTokens: number
  completionTokens: number
  totalTokens: number
  at: string
}

export interface UsagePayload {
  ok: boolean
  summary: UsageSummary | null
  recent: UsageRecent[]
  error?: string
}

/** Token 用量（真）：D1 token-metering 共享账本（D2 每次推理自动上报） */
export async function fetchUsage(): Promise<UsagePayload> {
  return authJsonFetch<UsagePayload>('/api/aigility/usage')
}

export interface AuditEntry {
  at: string
  actor: string
  action: string
  target: string
  detail: string
}

/** 审计日志（真）：AppBase audit_log（登录/管理操作留痕） */
export async function fetchAudit(): Promise<AuditEntry[]> {
  const j = await authJsonFetch<{ ok: boolean; entries: AuditEntry[] }>('/api/aigility/audit')
  return j.entries
}

export interface TeamMember {
  email: string
  isAdmin: boolean
  createdAt?: string
}

/** 平台成员（真）：users × app_members */
export async function fetchTeam(): Promise<TeamMember[]> {
  const j = await authJsonFetch<{ ok: boolean; members: TeamMember[] }>('/api/aigility/team')
  return j.members
}

export interface CreditPayload {
  ok: boolean
  userId?: string
  balance?: number | string
  error?: string
}

/** 积分余额（真）：D1 credit 账务（PgCreditStore），按邮箱归集 */
export async function fetchCredit(): Promise<CreditPayload> {
  return authJsonFetch<CreditPayload>('/api/aigility/credit')
}

export interface DocBlock {
  type: 'heading' | 'paragraph' | 'bullets'
  text?: string
  level?: number
  items?: string[]
}

/** 服务端 /api/aigility/doc（@action/doc-worker）生成真实 .docx 并下载 */
export async function generateDoc(doc: { title: string; subtitle?: string; blocks: DocBlock[] }): Promise<{ filename: string; bytes: number }> {
  const j = await authJsonFetch<{ ok?: boolean; filename?: string; base64?: string; bytes?: number; error?: string }>(
    '/api/aigility/doc',
    { method: 'POST', body: JSON.stringify({ ...doc, creator: getCurrentUser()?.email }) },
  )
  if (!j.ok || !j.base64 || !j.filename) throw new Error(j.error ?? 'doc-worker 返回为空')
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

export interface TimemMemoryHit {
  content: string
  score?: number
  memory_id?: string
}

/** TiMEM 记忆检索（真, 走 Seam → @action/timem-memory） */
export async function timemSearch(query: string, agentId?: string, limit = 5): Promise<TimemMemoryHit[]> {
  const j = await authJsonFetch<{ ok: boolean; data?: { results?: TimemMemoryHit[] }; error?: string }>(
    '/api/aigility/timem/search',
    { method: 'POST', body: JSON.stringify({ query, agent_id: agentId, limit }) },
  )
  if (!j.ok) throw new Error(j.error ?? 'TiMEM 检索失败')
  return j.data?.results ?? []
}
