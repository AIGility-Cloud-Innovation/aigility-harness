/**
 * 平台封装 API 客户端（全部同源 :1236, 均要求 AppBase 登录会话）：
 *   - 对话链路：同源会话代理（服务端校验会话后持主密钥转发网关, SSE 透传;
 *     网关主密钥仅服务端持有, 不进浏览器）, OpenAI 兼容 SSE 逐帧解析
 *     · streamAigilityChat → /api/aigility/chat →（服务端）→ /api/aigility-chat（@persona/aigility-agent：工厂技能 + 平台管家）
 *     · streamPersonaChat → /api/aigility/p/<key>/chat →（服务端）→ 引擎 layer-persona 原生角色
 *   - 封装 API（同源, 需 AppBase 登录会话）：注册表 / 技能发布 / 能力总线 / 模型上游 / 指标 / TiMEM
 */

import { authJsonFetch, getToken, getCurrentUser, clearToken } from './api'

// ── 会话 SSE 客户端（同源代理）───────────────────────────────────

/** 登录会话请求头（服务端代理据此校验 AppBase 会话, 401 统一清会话切登录屏） */
function sessionHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
  }
}

/** 逐帧解析 OpenAI 兼容 SSE，onToken 回调累计全文；失败抛错由调用方回退 */
async function pumpOpenAiSse(res: Response, onToken: (full: string) => void): Promise<string> {
  if (res.status === 401) {
    clearToken()
    window.dispatchEvent(new CustomEvent('aigility-unauth'))
    throw new Error('登录已过期，请重新登录')
  }
  if (!res.ok || !res.body) throw new Error(`对话代理响应 ${res.status}`)
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

export interface AigilityChatBody {
  user_input: string
  /** 智能体工厂发布的技能 id（缺省走平台管家） */
  skill_id?: string
  session_id?: string
  user_key?: string
  history?: Array<{ role: 'user' | 'assistant'; content: string }>
  /** 请求级模型覆盖（对话三件套·模型设置；'' 或缺省 = 跟随平台/技能偏好） */
  llm?: { model?: string }
  /** 思考等级（对话三件套）：auto=不覆盖；off/low/medium/high 翻译为上游参数直通 */
  thinking?: { level: ThinkingLevel; parameter?: Record<string, unknown> }
  /** 本地工作区（对话三件套）：服务端白名单内目录，作为数字员工能力边界 */
  workspace?: string
}

/** 把「思考等级」档位组装为对话请求体字段（auto = 不覆盖，交由模型默认/平台配置） */
export function buildChatThinking(level: ThinkingLevel, model: string): { level: ThinkingLevel; parameter?: Record<string, unknown> } | undefined {
  if (level === 'auto') return undefined
  return { level, parameter: thinkingToParameter(level, model) }
}

/** 思考等级 → 上游直通参数（按模型族适配；litellm drop_params 会忽略不支持的） */
export function thinkingToParameter(level: string, model: string): Record<string, unknown> {
  const isGlm = /glm/i.test(model)
  const isQwen = /qwen/i.test(model)
  const isDeepseek = /deepseek/i.test(model)
  const thinkingOn = level !== 'off' && level !== 'auto'
  const out: Record<string, unknown> = {}
  if (isGlm) {
    // 智谱 Anthropic/OpenAI 兼容端点：thinking.type 是官方开关（本机 bigmodel-glm-* 已实测生效）
    out['thinking'] = { type: thinkingOn ? 'enabled' : 'disabled' }
    if (thinkingOn) out['reasoning_effort'] = level === 'low' ? 'low' : level === 'high' ? 'high' : 'medium'
  } else if (isQwen) {
    // DashScope Qwen3 系：enable_thinking 开关 + thinking_budget 档位
    out['enable_thinking'] = thinkingOn
    if (thinkingOn) out['thinking_budget'] = level === 'low' ? 512 : level === 'high' ? 4096 : 1024
  } else if (isDeepseek) {
    // DeepSeek 系：reasoning 是模型固有属性，等级 → 提示词档位（agent 侧已注入），
    // 参数层给 reasoning_effort（支持的供应商会应用，不支持的被 drop）
    if (thinkingOn) out['reasoning_effort'] = level === 'low' ? 'low' : level === 'high' ? 'high' : 'medium'
  } else {
    // 通用模型：只带 reasoning_effort（不支持的被 drop_params 静默忽略）
    if (thinkingOn) out['reasoning_effort'] = level === 'low' ? 'low' : level === 'high' ? 'high' : 'medium'
  }
  return out
}

/** 数字员工对话 → 同源 /api/aigility/chat（服务端代理 → @persona/aigility-agent，记忆按技能隔离） */
export async function streamAigilityChat(
  body: AigilityChatBody,
  onToken: (full: string) => void,
): Promise<string> {
  const res = await fetch('/api/aigility/chat', {
    method: 'POST',
    headers: sessionHeaders(),
    body: JSON.stringify({ ...body, stream: true }),
  })
  return pumpOpenAiSse(res, onToken)
}

/** 引擎原生角色对话 → 同源 /api/aigility/p/<key>/chat（registry 下发的 route, 服务端代理 → 网关） */
export async function streamPersonaChat(
  route: string,
  body: { user_input: string; session_id?: string; user_key?: string },
  onToken: (full: string) => void,
): Promise<string> {
  const res = await fetch(route, {
    method: 'POST',
    headers: sessionHeaders(),
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
  source: 'harness' | 'local'
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

/** 可见范围单独更新（管理员）：企业内 = 上架智能体市场，仅自己 = 撤下 */
export async function setSkillVisibility(id: string, visibility: '企业内' | '仅自己'): Promise<SkillInfo> {
  const j = await authJsonFetch<{ skill?: SkillInfo; error?: string }>(`/api/aigility/skills/${encodeURIComponent(id)}/visibility`, {
    method: 'PUT',
    body: JSON.stringify({ visibility }),
  })
  if (!j.skill) throw new Error(j.error ?? '更新失败')
  return j.skill
}

// ── 智能体市场数据模式（站点级，管理员配置） ──

export type MarketDataMode = 'mock' | 'real'

export async function fetchMarketConfig(): Promise<{ dataMode: MarketDataMode }> {
  return authJsonFetch<{ dataMode: MarketDataMode }>('/api/aigility/market-config')
}

export async function saveMarketConfig(dataMode: MarketDataMode): Promise<void> {
  const j = await authJsonFetch<{ ok?: boolean; error?: string }>('/api/aigility/market-config', {
    method: 'PUT',
    body: JSON.stringify({ dataMode }),
  })
  if (!j.ok) throw new Error(j.error ?? '保存失败')
}

// ── 真接口：角色能力注册表（DSH 渠道 role → skills/MCP, roles.json 热生效） ──

export interface RoleMcpServer {
  serverName: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
  failOnStartupError?: boolean
}

export interface RoleCapabilityConfig {
  label?: string
  skills?: string[]
  mcpServers?: RoleMcpServer[]
}

export interface RolesPayload {
  skillsRoot?: string
  roles: Record<string, RoleCapabilityConfig>
  routes: Record<string, string>
  missingSkills?: Record<string, string[]>
  registryFile?: string
}

export async function fetchRoles(): Promise<RolesPayload> {
  return authJsonFetch<RolesPayload>('/api/aigility/roles')
}

export async function saveRole(
  id: string,
  config: { label?: string; skills?: string[]; mcpServers?: RoleMcpServer[] },
): Promise<void> {
  const j = await authJsonFetch<{ ok?: boolean; error?: string }>('/api/aigility/roles', {
    method: 'POST',
    body: JSON.stringify({ id, ...config }),
  })
  if (!j.ok) throw new Error(j.error ?? '保存失败')
}

export async function deleteRole(id: string): Promise<boolean> {
  const j = await authJsonFetch<{ ok?: boolean }>(`/api/aigility/roles/${encodeURIComponent(id)}`, { method: 'DELETE' })
  return j.ok ?? false
}

export async function saveRoleRoute(chatKey: string, roleId: string): Promise<RolesPayload['routes']> {
  const j = await authJsonFetch<{ ok?: boolean; routes?: RolesPayload['routes']; error?: string }>(
    '/api/aigility/roles/routes',
    { method: 'POST', body: JSON.stringify({ chatKey, roleId }) },
  )
  if (!j.ok) throw new Error(j.error ?? '路由保存失败')
  return j.routes ?? {}
}

export interface DshSkillInfo {
  dir: string
  name: string
  description: string
  path: string
}

export async function fetchDshSkills(): Promise<{ skillsRoot: string; skills: DshSkillInfo[] }> {
  return authJsonFetch<{ skillsRoot: string; skills: DshSkillInfo[] }>('/api/aigility/dsh-skills')
}

/** 工厂「同步为 DSH 技能」：写 skillsRoot/<slug>/SKILL.md，可同时挂到角色 */
export async function createDshSkill(input: {
  name: string
  description: string
  prompt: string
  attachRole?: string
}): Promise<{ skill: DshSkillInfo; attached: string | null }> {
  const j = await authJsonFetch<{ ok?: boolean; skill?: DshSkillInfo; attached?: string | null; error?: string }>(
    '/api/aigility/dsh-skills',
    { method: 'POST', body: JSON.stringify(input) },
  )
  if (!j.skill) throw new Error(j.error ?? '创建失败')
  return { skill: j.skill, attached: j.attached ?? null }
}

export async function attachSkillToRole(roleId: string, skill: string): Promise<void> {
  const j = await authJsonFetch<{ ok?: boolean; error?: string }>(
    `/api/aigility/roles/${encodeURIComponent(roleId)}/attach-skill`,
    { method: 'POST', body: JSON.stringify({ skill }) },
  )
  if (!j.ok) throw new Error(j.error ?? '挂载失败')
}

export interface McpShelfItem extends RoleMcpServer {
  usedBy: string[]
}

export async function fetchMcpShelf(): Promise<McpShelfItem[]> {
  const j = await authJsonFetch<{ servers: McpShelfItem[] }>('/api/aigility/mcp-shelf')
  return j.servers
}

// ── 站点即时微调（改进专员 live_fix 的持久化与重放） ──────────────

export interface SiteTweak {
  id: string
  type: 'text' | 'hide' | 'style'
  selector: string
  value?: string
  reason?: string
  createdBy: string
  createdAt: string
}

export async function fetchSiteTweaks(): Promise<SiteTweak[]> {
  const j = await authJsonFetch<{ tweaks: SiteTweak[] }>('/api/aigility/site-tweaks')
  return j.tweaks ?? []
}

export async function saveSiteTweak(t: { type: SiteTweak['type']; selector: string; value?: string; reason?: string; user_key?: string }): Promise<SiteTweak> {
  const j = await authJsonFetch<{ ok?: boolean; tweak?: SiteTweak; error?: string }>('/api/aigility/site-tweaks', {
    method: 'POST',
    body: JSON.stringify(t),
  })
  if (!j.tweak) throw new Error(j.error ?? '保存失败')
  return j.tweak
}

export async function deleteSiteTweak(id: string): Promise<boolean> {
  const j = await authJsonFetch<{ ok?: boolean }>(`/api/aigility/site-tweaks/${encodeURIComponent(id)}`, { method: 'DELETE' })
  return j.ok ?? false
}

/**
 * 把 tweaks 应用到当前 DOM（幂等：同一元素不重复改）。
 * React 重渲染可能还原 text/style —— 需要在页面切换后重新调用。
 */
export function applySiteTweaks(tweaks: SiteTweak[]): number {
  let applied = 0
  for (const t of tweaks) {
    try {
      const el = document.querySelector(t.selector) as HTMLElement | null
      if (!el || el.hasAttribute('data-site-tweak-applied')) continue
      if (t.type === 'hide') el.style.display = 'none'
      else if (t.type === 'text') el.textContent = t.value ?? ''
      else if (t.type === 'style') el.style.cssText += `;${t.value ?? ''}`
      el.setAttribute('data-site-tweak-applied', t.id)
      applied++
    } catch { /* 单条失效不拖垮其余 */ }
  }
  return applied
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

// ── 数字员工对话三件套（真 · per-user 持久化）：模型 / 思考等级 / 本地工作区 ──

export type ThinkingLevel = 'auto' | 'off' | 'low' | 'medium' | 'high'

export interface ChatPrefs {
  model: string
  thinking: ThinkingLevel
  workspace: string
  updatedAt: string
}

/** 读取当前用户的对话偏好 */
export async function fetchChatPrefs(): Promise<ChatPrefs> {
  const r = await authJsonFetch<{ ok: true; prefs: ChatPrefs }>('/api/aigility/chat/prefs')
  return r.prefs
}

/** 保存当前用户的对话偏好（模型/思考等级/工作区，均为三元组可选更新） */
export async function saveChatPrefs(prefs: Partial<Pick<ChatPrefs, 'model' | 'thinking' | 'workspace'>>): Promise<ChatPrefs> {
  const r = await authJsonFetch<{ ok: true; prefs: ChatPrefs }>('/api/aigility/chat/prefs', {
    method: 'PUT',
    body: JSON.stringify(prefs),
  })
  return r.prefs
}

export interface WorkspaceRoot {
  path: string
  label: string
  readable: boolean
  writable: boolean
}

export interface WorkspaceEntry {
  name: string
  path: string
  isDir: boolean
  readable: boolean
  writable: boolean
  isGitRoot: boolean
}

export interface WorkspaceBrowse {
  ok: boolean
  path: string
  parent: string | null
  root: string | null
  entries: WorkspaceEntry[]
  error?: string
}

/** 工作区根白名单（服务端：用户主目录 / 智悦仓库 / tmp） */
export async function fetchWorkspaceRoots(): Promise<WorkspaceRoot[]> {
  const r = await authJsonFetch<{ ok: true; roots: WorkspaceRoot[] }>('/api/aigility/workspace/roots')
  return r.roots
}

/** 浏览服务端目录（只列子目录；路径 realpath 后校验在白名单根内） */
export async function fetchWorkspaceBrowse(path: string): Promise<WorkspaceBrowse> {
  return authJsonFetch<WorkspaceBrowse>(`/api/aigility/workspace/browse?path=${encodeURIComponent(path)}`)
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
  userId: string
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
  type: 'heading' | 'paragraph' | 'bullets' | 'table'
  text?: string
  level?: number
  items?: string[]
  /** table 块 */
  header?: string[]
  rows?: string[][]
}

export type DocFormat = 'docx' | 'pdf' | 'xlsx' | 'html'

const DOC_MIME: Record<DocFormat, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  html: 'text/html; charset=utf-8',
}

export interface DocArtifact {
  filename: string
  bytes: number
  base64: string
  mime: string
  format: DocFormat
}

/** base64 → Blob（预览/下载共用） */
export function base64ToBlob(base64: string, mime: string): Blob {
  const bin = atob(base64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}

/** 服务端 /api/aigility/doc（@action/doc-worker）：结构化块 → 四格式文档，返回 base64+mime 供预览/下载 */
export async function generateDocRaw(doc: { title: string; subtitle?: string; blocks: DocBlock[]; format?: DocFormat }): Promise<DocArtifact> {
  const j = await authJsonFetch<{ ok?: boolean; filename?: string; base64?: string; bytes?: number; error?: string; mime?: string; format?: string }>(
    '/api/aigility/doc',
    { method: 'POST', body: JSON.stringify({ ...doc, creator: getCurrentUser()?.email }) },
  )
  if (!j.ok || !j.base64 || !j.filename) throw new Error(j.error ?? 'doc-worker 返回为空')
  const format = (j.format ?? doc.format ?? 'docx') as DocFormat
  return { filename: j.filename, bytes: j.bytes ?? 0, base64: j.base64, mime: j.mime ?? DOC_MIME[format], format }
}

/** 触发浏览器下载一份文档产物 */
export function downloadArtifact(artifact: DocArtifact): void {
  const url = URL.createObjectURL(base64ToBlob(artifact.base64, artifact.mime))
  const el = document.createElement('a')
  el.href = url
  el.download = artifact.filename
  document.body.appendChild(el)
  el.click()
  el.remove()
  setTimeout(() => URL.revokeObjectURL(url), 3000)
}

/** 既有便捷：生成 .docx 并直接下载 */
export async function generateDoc(doc: { title: string; subtitle?: string; blocks: DocBlock[] }): Promise<{ filename: string; bytes: number }> {
  const a0 = await generateDocRaw({ ...doc, format: 'docx' })
  downloadArtifact(a0)
  return { filename: a0.filename, bytes: a0.bytes }
}

// ── 任务板（真 · task 表 + 执行器路由）────────────────────────────

export interface TaskItem {
  id: string
  title: string
  detail: string
  executor: string
  status: string
  priority: string
  dueAt: string | null
  createdBy: string
  result: unknown
  createdAt: string
  updatedAt: string
}

export interface TaskResult {
  kind?: 'text' | 'file' | 'error'
  text?: string
  error?: string
  filename?: string
  base64?: string
  bytes?: number
}

/** 任务列表（可按状态/是否本人过滤） */
export async function fetchTasks(opts?: { status?: string; mine?: boolean }): Promise<TaskItem[]> {
  const q = new URLSearchParams()
  if (opts?.status) q.set('status', opts.status)
  if (opts?.mine) q.set('mine', '1')
  const j = await authJsonFetch<{ ok: boolean; tasks: TaskItem[] }>(`/api/aigility/tasks?${q}`)
  return j.tasks
}


// ── 统一台账（TaskRegistry） ─────────────────────────────────────

export interface RegistryTask {
  uid: string
  title: string
  description: string
  status: string
  projectRef: string
  originProvider: string
  assignee: string
  executor: string
  reviewer: string
  reviewVia: string
  review?: { by: string; via: string; at: number; note?: string }
  links: Record<string, { guid?: string; url?: string }>
  createdAt: number
  updatedAt: number
}

/** 拉取统一台账任务（TaskRegistry → 智悦平台看板） */
export async function fetchRegistryTasks(): Promise<RegistryTask[]> {
  const j = await authJsonFetch<{ ok: boolean; tasks: RegistryTask[] }>('/api/aigility/registry-tasks')
  return j.tasks
}

export interface NewTaskInput {
  title: string
  detail?: string
  executor: string
  priority?: string
}

/** 发布任务：human 留 open；content/docx 服务端自动派发执行器 */
export async function createTask(t: NewTaskInput): Promise<TaskItem> {
  const j = await authJsonFetch<{ ok: boolean; task: TaskItem; error?: string }>('/api/aigility/tasks', {
    method: 'POST',
    body: JSON.stringify(t),
  })
  return j.task
}

/** 任务状态流转（open→done / review→done|rejected，CAS） */
export async function transitionTask(id: string, to: string): Promise<TaskItem> {
  const j = await authJsonFetch<{ ok: boolean; task: TaskItem; error?: string }>(
    `/api/aigility/tasks/${encodeURIComponent(id)}/transition`,
    { method: 'POST', body: JSON.stringify({ to }) },
  )
  return j.task
}

/** 下载 agent 产出的 docx 文件 */
export async function downloadTaskFile(result: { filename: string; base64: string }): Promise<void> {
  const bin = atob(result.base64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = result.filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 3000)
}

// ── 报告模板（真存储 · AppBase /app/data JSONB 原语）──────────────

export interface ReportTemplate {
  rowId?: string
  name: string
  title: string
  subtitle: string
  content: string
}

const TPL_Q = 'app=aigility-platform'
const TPL_TABLE = 'report_templates'

export async function fetchReportTemplates(): Promise<ReportTemplate[]> {
  const j = await authJsonFetch<{ rows: Array<{ id: string; data: { name?: string; title?: string; subtitle?: string; content?: string } }> }>(
    `/app/data/${TPL_TABLE}?${TPL_Q}`, {})
  return j.rows.map(r => ({
    rowId: r.id,
    name: r.data.name ?? '未命名模板',
    title: r.data.title ?? '',
    subtitle: r.data.subtitle ?? '',
    content: r.data.content ?? '',
  }))
}

export async function saveReportTemplate(t: Omit<ReportTemplate, 'rowId'>, rowId?: string): Promise<void> {
  const payload = JSON.stringify({ data: { name: t.name, title: t.title, subtitle: t.subtitle, content: t.content } })
  if (rowId) {
    await authJsonFetch(`/app/data/${TPL_TABLE}/${rowId}?${TPL_Q}`, { method: 'PUT', body: payload })
  } else {
    await authJsonFetch(`/app/data/${TPL_TABLE}?${TPL_Q}`, { method: 'POST', body: payload })
  }
}

export async function deleteReportTemplate(rowId: string): Promise<void> {
  await authJsonFetch(`/app/data/${TPL_TABLE}/${rowId}?${TPL_Q}`, { method: 'DELETE' })
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

// ── 项目小助理（feishu-task-loop）进程管理 ─────────────────────

export type TaskLoopState = 'running' | 'stopped' | 'stale'

export interface TaskLoopLockInfo {
  exists: boolean
  pid?: number
  path: string
  stale: boolean
}

export interface TaskLoopLogTail {
  file: string
  lines: string[]
}

export interface TaskLoopConfig {
  llmModel?: string
  pipelineIntervalMs?: number
  autoDispatch?: boolean
  notifyEnabled?: boolean
  /** 飞书应用 App ID（覆盖仓库 .env） */
  feishuAppId?: string
  /** App Secret：读取只回 '******'（另有 feishuAppSecretMasked 回显）；PUT '******' 表示不修改 */
  feishuAppSecret?: string
  feishuAppSecretMasked?: string
  /** 播报目标群（如「机器人群」）：配置后静默收集的汇总/澄清播报只发该群 */
  notifyChatId?: string
  notifyChatName?: string
  featureFlags: Record<string, boolean>
  env: Record<string, string>
}

export interface FeishuChatItem {
  chatId: string
  name: string
}

/** 枚举机器人所在飞书群（凭证用传入值，否则用已保存配置/.env），供选择「机器人群」 */
export async function fetchFeishuChats(credentials?: { appId?: string; appSecret?: string }): Promise<{ ok: boolean; chats: FeishuChatItem[]; error?: string }> {
  const j = await authJsonFetch<{ ok: boolean; chats: FeishuChatItem[]; error?: string }>(
    '/api/aigility/task-loop/feishu/chats',
    { method: 'POST', body: JSON.stringify(credentials ?? {}) },
  )
  return { ok: j.ok, chats: j.chats ?? [], error: j.error }
}

export interface TaskLoopStatus {
  state: TaskLoopState
  pid?: number
  lock: TaskLoopLockInfo
  managedByPlatform: boolean
  logs: { stdout: TaskLoopLogTail; stderr: TaskLoopLogTail }
  config: TaskLoopConfig
}

/** 项目小助理状态（含锁、日志尾部、配置回显） */
export async function fetchTaskLoopStatus(tail = 30): Promise<TaskLoopStatus> {
  const j = await authJsonFetch<{ ok: boolean; status: TaskLoopStatus }>(`/api/aigility/task-loop/status?tail=${tail}`)
  return j.status
}

export interface TaskLoopOpResult {
  ok: boolean
  state?: TaskLoopState
  pid?: number
  message: string
}

/** 启动 feishu-task-loop（pnpm --filter feishu-task-loop start） */
export async function startTaskLoop(): Promise<TaskLoopOpResult> {
  const j = await authJsonFetch<TaskLoopOpResult>('/api/aigility/task-loop/start', { method: 'POST' })
  return j
}

/** 停止：SIGTERM → 8s 超时 SIGKILL */
export async function stopTaskLoop(): Promise<TaskLoopOpResult> {
  const j = await authJsonFetch<TaskLoopOpResult>('/api/aigility/task-loop/stop', { method: 'POST' })
  return j
}

/** 重启 = 停止（若在跑）→ 启动 */
export async function restartTaskLoop(): Promise<TaskLoopOpResult> {
  const j = await authJsonFetch<TaskLoopOpResult>('/api/aigility/task-loop/restart', { method: 'POST' })
  return j
}

/** 读取项目小助理配置（data/task-loop.json） */
export async function fetchTaskLoopConfig(): Promise<TaskLoopConfig> {
  const j = await authJsonFetch<{ ok: boolean; config: TaskLoopConfig }>('/api/aigility/task-loop/config')
  return j.config
}

/** 保存配置（注意：运行中进程不热加载，需重启生效） */
export async function updateTaskLoopConfig(config: Partial<TaskLoopConfig>): Promise<TaskLoopConfig> {
  const j = await authJsonFetch<{ ok: boolean; config: TaskLoopConfig }>(
    '/api/aigility/task-loop/config',
    { method: 'PUT', body: JSON.stringify(config) },
  )
  return j.config
}

/** 读取日志尾部（tail 上限 1000） */
export async function fetchTaskLoopLogs(tail = 200): Promise<{ stdout: TaskLoopLogTail; stderr: TaskLoopLogTail }> {
  const j = await authJsonFetch<{ ok: boolean; stdout: TaskLoopLogTail; stderr: TaskLoopLogTail }>(
    `/api/aigility/task-loop/logs?tail=${tail}`,
  )
  return { stdout: j.stdout, stderr: j.stderr }
}

// ── 项目小助理 · 任务看板（使用界面）────────────────────────────

export interface TaskLoopBoardIssue {
  repo: string
  number: number
  title: string
  state: 'open' | 'closed'
  assignees: string[]
  labels: string[]
  htmlUrl: string
  createdAt: string
  updatedAt: string
}

/** 任务看板数据：聚合仓库池内的 Gitea 工单（归属确认后由流水线落单） */
export async function fetchTaskLoopBoard(): Promise<{
  ok: boolean
  repos: string[]
  issues: TaskLoopBoardIssue[]
  errors?: string[]
}> {
  return authJsonFetch<{ ok: boolean; repos: string[]; issues: TaskLoopBoardIssue[]; errors?: string[] }>(
    '/api/aigility/task-loop/board',
  )
}

// ── 团队记忆总结（team-memory-console 收编）────────────────────

export type TeamMemoryJobKind = 'report' | 'morning'
export type TeamMemoryRunStatus = 'ok' | 'failed' | 'timeout' | 'running'

export interface TeamMemoryRun {
  kind: TeamMemoryJobKind
  startedAt: string
  finishedAt?: string
  status: TeamMemoryRunStatus
  exitCode?: number
  trigger: 'manual' | 'schedule'
  error?: string
  outputTail?: string
}

export interface TeamMemoryLogTail {
  file: string
  lines: string[]
}

export interface TeamMemoryConfig {
  enabled: boolean
  dailyReportTime: string
  morningReportTime: string
  timemApiKey?: string
  timemApiKeyMasked?: string
  timemBaseUrl?: string
  feishuAppId?: string
  feishuAppSecret?: string
  feishuAppSecretMasked?: string
  reportChatId?: string
  reportChatName?: string
  litellmUrl?: string
  litellmKey?: string
  litellmKeyMasked?: string
  summaryModel?: string
  env: Record<string, string>
}

export interface TeamMemoryStatus {
  schedulerRunning: boolean
  enabled: boolean
  lastTickAt: string | null
  nextRun: { kind: TeamMemoryJobKind; at: string } | null
  runs: TeamMemoryRun[]
  config: TeamMemoryConfig
  logs: { stdout: TeamMemoryLogTail; stderr: TeamMemoryLogTail }
}

export async function fetchTeamMemoryStatus(tail = 30): Promise<TeamMemoryStatus> {
  const j = await authJsonFetch<{ ok: boolean; status: TeamMemoryStatus }>(`/api/aigility/team-memory/status?tail=${tail}`)
  return j.status
}

export async function fetchTeamMemoryConfig(): Promise<TeamMemoryConfig> {
  const j = await authJsonFetch<{ ok: boolean; config: TeamMemoryConfig }>('/api/aigility/team-memory/config')
  return j.config
}

/** 保存配置（掩码/留空 = 不修改已保存 Secret；调度时刻保存即生效） */
export async function updateTeamMemoryConfig(config: Partial<TeamMemoryConfig>): Promise<TeamMemoryConfig> {
  const j = await authJsonFetch<{ ok: boolean; config: TeamMemoryConfig }>(
    '/api/aigility/team-memory/config',
    { method: 'PUT', body: JSON.stringify(config) },
  )
  return j.config
}

/** 立即生成并推送一次日报/晨报（同步等待，最长 5 分钟） */
export async function runTeamMemoryJob(kind: TeamMemoryJobKind): Promise<{
  ok: boolean
  status: TeamMemoryRunStatus
  message: string
  exitCode?: number
  stdoutTail: string
  stderrTail: string
}> {
  return authJsonFetch('/api/aigility/team-memory/run', { method: 'POST', body: JSON.stringify({ kind }) })
}

export async function fetchTeamMemoryLogs(tail = 200): Promise<{ stdout: TeamMemoryLogTail; stderr: TeamMemoryLogTail }> {
  const j = await authJsonFetch<{ ok: boolean; stdout: TeamMemoryLogTail; stderr: TeamMemoryLogTail }>(
    `/api/aigility/team-memory/logs?tail=${tail}`,
  )
  return { stdout: j.stdout, stderr: j.stderr }
}

export async function fetchTeamMemoryChats(credentials?: { appId: string; appSecret: string }): Promise<{
  ok: boolean
  chats: FeishuChatItem[]
  error?: string
}> {
  return authJsonFetch<{ ok: boolean; chats: FeishuChatItem[]; error?: string }>(
    '/api/aigility/team-memory/feishu/chats',
    { method: 'POST', body: JSON.stringify(credentials ?? {}) },
  )
}

// ── 模块装配（真 · app_modules/app_module_presets，装配底座）────────────

export interface ModulePresetInfo {
  id: string
  name: string
  enabledIds: string[]
  createdBy?: string
  createdAt?: string
}

export interface ModulesPayload {
  ok: boolean
  /** 模块 id → 是否装配（服务端合并缺省与 DB 覆盖） */
  state: Record<string, boolean>
  presets: ModulePresetInfo[]
  /** 模块 id → 是否隐藏于导航（per-user · user_module_nav，多端一致） */
  navHidden?: Record<string, boolean>
}

/** 装配状态与预设清单（登录后拉取，替代 localStorage 单机持久化） */
export async function fetchModules(): Promise<ModulesPayload> {
  return authJsonFetch<ModulesPayload>('/api/aigility/modules')
}

/** 模块开关（服务端校验 core/available，写 audit_log） */
export async function saveModuleState(id: string, enabled: boolean): Promise<void> {
  await authJsonFetch(`/api/aigility/modules/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify({ enabled }),
  })
}

/**
 * 导航可见偏好落库（多端一致；返回服务端合并后的隐藏集）。
 * 权限：仅管理员可写（普通用户 403 —— 布局现阶段由管理员统一配置）。
 * userId 缺省 = 操作自己的偏好；管理员传他人 userId 可代为调整。
 */
export async function saveModuleNav(id: string, hidden: boolean, userId?: string): Promise<Record<string, boolean>> {
  const j = await authJsonFetch<{ ok: boolean; navHidden?: Record<string, boolean>; error?: string }>(
    `/api/aigility/modules/${encodeURIComponent(id)}/nav`,
    { method: 'PUT', body: JSON.stringify({ hidden, ...(userId ? { userId } : {}) }) },
  )
  if (!j.ok) throw new Error(j.error ?? '保存导航偏好失败')
  return j.navHidden ?? {}
}

export interface NavPref {
  userId: string
  email: string
  isAdmin: boolean
  /** 模块 id → 是否隐藏于导航 */
  navHidden: Record<string, boolean>
}

/** 管理员视图：全部成员的导航偏好（非管理员 403） */
export async function fetchNavPrefs(): Promise<NavPref[]> {
  const j = await authJsonFetch<{ ok: boolean; prefs?: NavPref[]; error?: string }>('/api/aigility/nav-prefs')
  if (!j.ok) throw new Error(j.error ?? '仅管理员可查看成员导航偏好')
  return j.prefs ?? []
}

export async function saveModulePreset(name: string, enabledIds: string[]): Promise<ModulePresetInfo> {
  const j = await authJsonFetch<{ ok: boolean; preset: ModulePresetInfo; error?: string }>('/api/aigility/modules/presets', {
    method: 'POST',
    body: JSON.stringify({ name, enabledIds }),
  })
  if (!j.preset) throw new Error(j.error ?? '保存预设失败')
  return j.preset
}

/** 套用预设 = 完整工作台形态替换，返回新装配状态 */
export async function applyModulePreset(id: string): Promise<Record<string, boolean>> {
  const j = await authJsonFetch<{ ok: boolean; state: Record<string, boolean> }>(
    `/api/aigility/modules/presets/${encodeURIComponent(id)}/apply`,
    { method: 'POST' },
  )
  return j.state
}

export async function deleteModulePreset(id: string): Promise<void> {
  await authJsonFetch(`/api/aigility/modules/presets/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

// ── 工具插件安装（真 · dsh_plugins 注册表 + dsh-host 热装卸）────────────

export interface InstalledPlugin {
  name: string
  package: string
  exportName: string
  description: string
  enabled: boolean
  config: Record<string, unknown>
  createdAt?: string
  /** 运行态：装载时间 / 错误信息 */
  runtime: { at?: string; error?: string }
}

export async function fetchInstalledPlugins(): Promise<InstalledPlugin[]> {
  const j = await authJsonFetch<{ ok: boolean; plugins: InstalledPlugin[] }>('/api/aigility/plugins')
  return j.plugins ?? []
}

/** 安装插件（MCP server 即一条 dsh-mcp-client 行：package=@deepseek-ai/dsh-mcp-client, config={transport,serverName,command,args}） */
export async function installPlugin(input: {
  name: string
  package: string
  exportName?: string
  description?: string
  config?: Record<string, unknown>
  enable?: boolean
}): Promise<{ loaded: boolean; error?: string }> {
  const j = await authJsonFetch<{ ok: boolean; loaded: boolean; error?: string }>('/api/aigility/plugins', {
    method: 'POST',
    body: JSON.stringify(input),
  })
  return { loaded: j.loaded ?? false, error: j.error }
}

export async function togglePlugin(name: string, enabled: boolean): Promise<{ loaded: boolean; error?: string }> {
  const j = await authJsonFetch<{ ok: boolean; loaded: boolean; error?: string }>(
    `/api/aigility/plugins/${encodeURIComponent(name)}`,
    { method: 'PUT', body: JSON.stringify({ enabled }) },
  )
  return { loaded: j.loaded ?? false, error: j.error }
}

export async function uninstallPlugin(name: string): Promise<void> {
  await authJsonFetch(`/api/aigility/plugins/${encodeURIComponent(name)}`, { method: 'DELETE' })
}

// ── 日志监察员（log-monitor 收编）──────────────────────────────

export type LogMonitorState = 'running' | 'stopped'

export interface LogMonitorAuto {
  id?: string
  host: string
  p: string
  s?: string
  n?: number
  interval?: number
  on?: boolean
  checking?: boolean
  lastAt?: number
  lastErr?: string
}

export interface LogMonitorDaemonStatus {
  pid: number
  startedAt: number
  checkCount: number
  time: number
  autos: LogMonitorAuto[]
  errs: { t: string; src: string; line: string }[]
}

export interface LogMonitorDaemonConfig {
  webhook: string
  keywords: string
  autos: LogMonitorAuto[]
}

export interface LogMonitorStatus {
  state: LogMonitorState
  port: number
  managedByPlatform: boolean
  daemon: LogMonitorDaemonStatus | null
  config: LogMonitorDaemonConfig | null
  error?: string
}

export async function fetchLogMonitorStatus(errs = 20): Promise<LogMonitorStatus> {
  const j = await authJsonFetch<{ ok: boolean; status: LogMonitorStatus }>(`/api/aigility/log-monitor/status?errs=${errs}`)
  return j.status
}

/** 下发配置到运行中的 daemon（即时生效；daemon 落盘持久化） */
export async function updateLogMonitorConfig(cfg: Partial<LogMonitorDaemonConfig>): Promise<LogMonitorDaemonConfig> {
  const j = await authJsonFetch<{ ok: boolean; config: LogMonitorDaemonConfig }>('/api/aigility/log-monitor/config', {
    method: 'PUT',
    body: JSON.stringify(cfg),
  })
  return j.config
}

export type LogMonitorOp = 'start' | 'stop' | 'restart'

export async function operateLogMonitor(
  op: LogMonitorOp,
): Promise<{ ok: boolean; state?: LogMonitorState; pid?: number; message: string }> {
  return authJsonFetch(`/api/aigility/log-monitor/${op}`, { method: 'POST' })
}

export interface LogMonitorLogTail {
  file: string
  lines: string[]
}

export async function fetchLogMonitorLogs(tail = 200): Promise<{ stdout: LogMonitorLogTail; stderr: LogMonitorLogTail }> {
  const j = await authJsonFetch<{ ok: boolean; stdout: LogMonitorLogTail; stderr: LogMonitorLogTail }>(
    `/api/aigility/log-monitor/logs?tail=${tail}`,
  )
  return { stdout: j.stdout, stderr: j.stderr }
}

// ── 社区插件发现（npm registry 检索 dsh-plugin 生态）────────────

export interface DiscoverPluginItem {
  name: string
  version: string
  description: string
  date: string
  repo: string
  npm: string
  keywords: string[]
}

export async function discoverPlugins(q = 'dsh-plugin'): Promise<{ ok: boolean; items: DiscoverPluginItem[]; error?: string }> {
  return authJsonFetch(`/api/aigility/plugins/discover?q=${encodeURIComponent(q)}`)
}

// ── 身份对齐（花名册自动匹配 + 审查）────────────────────────

export type IdentityAxisView = 'feishu' | 'wecom' | 'gitea' | 'web' | 'timem'
export type IdentityMatchSource = 'manual' | 'auto'

export interface IdentityMemberView {
  member_id: string
  name: string
  aliases: string[]
  timem_user_ids: string[]
  feishu_open_ids: string[]
  gitea_usernames: string[]
  wecom_user_ids: string[]
  web_emails: string[]
  match_source?: Partial<Record<IdentityAxisView, IdentityMatchSource>>
  role?: string
}

export interface IdentityCandidateView {
  id: string
  name?: string
  source: 'gitea' | 'feishu'
  org?: string
}

export interface IdentitySuggestionView {
  member_id: string
  axis: 'feishu' | 'gitea'
  id: string
  name?: string
  score: number
  reason: string
}

export interface IdentityOverview {
  ok: boolean
  members: IdentityMemberView[]
  candidates: IdentityCandidateView[]
  suggestions: IdentitySuggestionView[]
  feishu_error?: string
  orgs: string[]
}

export interface IdentityAutoMatchResult {
  ok: boolean
  bound: Array<{ member_id: string; name: string; axis: 'feishu' | 'gitea'; id: string; score: number; reason: string }>
  suggestions: IdentitySuggestionView[]
  feishu_error?: string
}

export function fetchIdentityOverview(): Promise<IdentityOverview> {
  return authJsonFetch<IdentityOverview>('/api/aigility/identity/overview')
}

export function runIdentityAutoMatch(): Promise<IdentityAutoMatchResult> {
  return authJsonFetch<IdentityAutoMatchResult>('/api/aigility/identity/auto-match', { method: 'POST' })
}

export function identityBind(body: {
  memberId: string
  axis: IdentityAxisView
  id: string
  op: 'bind' | 'unbind' | 'confirm'
}): Promise<{ ok: boolean; error?: string }> {
  return authJsonFetch<{ ok: boolean; error?: string }>('/api/aigility/identity/bind', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

// ── 通道与角色（角色 manifest v2 · 声明面）──────────────────────

export interface ChannelAppBindingView {
  app: string
  chats?: string[]
  mention_only?: boolean
}

export interface ChannelPlanApp {
  platform: 'feishu' | 'wecom'
  appId: string
  agentRoutes: Record<string, string>
  perceptionId: string
  roleIds: string[]
  memoryAgentIds: string[]
}

export interface ChannelPlan {
  mode: string
  apps: ChannelPlanApp[]
  issues: string[]
  webOnlyRoleIds: string[]
}


// ── 模型池（真 · 网关 /v1/models 代理）与工作流清单（D4 编排委托）──

/** 平台可用模型池（网关上游模型列表；不可达时返回空 + 说明） */
export interface GatewayModelEntry { id: string; provider: string; maxIn?: number; maxOut?: number }

export async function fetchLlmModels(): Promise<{ ok: boolean; models: string[]; entries?: GatewayModelEntry[]; health?: { healthy: number; unhealthy: number }; error?: string }> {
  return authJsonFetch('/api/aigility/llm/models')
}

export interface WorkflowInfo { id: string; name: string; source: string }

/** 数据面工作流清单（executor-dispatch + Plan 拆解产物） */
export async function fetchWorkflows(): Promise<WorkflowInfo[]> {
  const j = await authJsonFetch<{ ok: boolean; workflows: WorkflowInfo[] }>('/api/aigility/workflows')
  return j.workflows ?? []
}

// ── 编排管理（真 · 数据面工作流 YAML）────────────────────────

export interface FlowInfo { id: string; name: string; source: string; builtin: boolean }

export async function fetchFlows(): Promise<FlowInfo[]> {
  const j = await authJsonFetch<{ ok: boolean; flows: FlowInfo[] }>('/api/aigility/flows')
  return j.flows ?? []
}

export async function fetchFlowYaml(id: string): Promise<string> {
  const j = await authJsonFetch<{ ok: boolean; yaml: string }>(`/api/aigility/flows/${encodeURIComponent(id)}`)
  return j.yaml
}

/** 保存工作流 YAML（服务端结构校验, 非法拒绝写盘） */
export async function saveFlowYaml(id: string, yaml: string): Promise<void> {
  const j = await authJsonFetch<{ ok: boolean; error?: string }>(`/api/aigility/flows/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify({ yaml }),
  })
  if (!j.ok) throw new Error(j.error ?? '保存失败')
}

// ── LLM 节点可视化配置（D2 模型算力层 · 移植自 hire llm_node）──────

export interface LlmProviderInfo { id: number; name: string; tag: string; apiKey: string; apiBase: string; enabled: boolean }
export interface LlmNodeInfo {
  id: number; name: string; description: string; serviceModule: string; functionName: string;
  modelName: string; parameter: Record<string, unknown>; providerId: number; isStream: boolean;
  /** 停用 = 业务侧解析不到该节点，自动退回 env 兜底（改错了可一键回滚） */
  enabled: boolean;
}

export async function fetchLlmNodes(): Promise<{ nodes: LlmNodeInfo[]; providers: LlmProviderInfo[] }> {
  const j = await authJsonFetch<{ ok: boolean; nodes: LlmNodeInfo[]; providers: LlmProviderInfo[] }>('/api/aigility/llm/nodes')
  if (!j.ok) throw new Error('加载失败')
  return { nodes: j.nodes ?? [], providers: j.providers ?? [] }
}

export async function createLlmNode(n: Omit<LlmNodeInfo, 'id'>): Promise<LlmNodeInfo> {
  const j = await authJsonFetch<{ ok: boolean; node: LlmNodeInfo; error?: string }>('/api/aigility/llm/nodes', { method: 'POST', body: JSON.stringify(n) })
  if (!j.ok) throw new Error(j.error ?? '创建失败')
  return j.node
}

export async function updateLlmNode(id: number, patch: Partial<LlmNodeInfo>): Promise<void> {
  const j = await authJsonFetch<{ ok: boolean; error?: string }>(`/api/aigility/llm/nodes/${id}`, { method: 'PUT', body: JSON.stringify(patch) })
  if (!j.ok) throw new Error(j.error ?? '保存失败')
}

export async function deleteLlmNode(id: number): Promise<void> {
  const j = await authJsonFetch<{ ok: boolean; error?: string }>(`/api/aigility/llm/nodes/${id}`, { method: 'DELETE' })
  if (!j.ok) throw new Error(j.error ?? '删除失败')
}

export async function createLlmProvider(p: { name: string; tag: string; apiKey?: string; apiBase?: string }): Promise<LlmProviderInfo> {
  const j = await authJsonFetch<{ ok: boolean; provider: LlmProviderInfo; error?: string }>('/api/aigility/llm/providers', { method: 'POST', body: JSON.stringify(p) })
  if (!j.ok) throw new Error(j.error ?? '创建失败')
  return j.provider
}

export async function resolveLlmNode(name: string): Promise<{ node: string; model: string; baseUrl: string; apiKey: string; isStream: boolean; parameter: Record<string, unknown> }> {
  const j = await authJsonFetch<{ ok: boolean; resolved: { node: string; model: string; baseUrl: string; apiKey: string; isStream: boolean; parameter: Record<string, unknown> } }>(`/api/aigility/llm/nodes/${encodeURIComponent(name)}/resolve`)
  if (!j.ok) throw new Error('解析失败')
  return j.resolved
}

export interface LlmNodeProbeResult {
  ok: boolean
  model?: string
  baseUrl?: string
  ms?: number
  finishReason?: string
  sample?: string
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
  error?: string
}

/** 试调用：真发一次极短请求（max_tokens 很小），用于配错立刻可见，而非等生产日志冒出空响应 */
export async function probeLlmNode(name: string): Promise<LlmNodeProbeResult> {
  const j = await authJsonFetch<LlmNodeProbeResult>(`/api/aigility/llm/nodes/${encodeURIComponent(name)}/probe`, { method: 'POST' })
  return j
}

// ── 项目小助理数据面工作流（chat-briefing.yaml 可视化编排数据源）──

export async function fetchTaskLoopWorkflow(): Promise<string> {
  const j = await authJsonFetch<{ ok: boolean; yaml: string }>('/api/aigility/task-loop/workflow')
  if (!j.ok) throw new Error('加载失败')
  return j.yaml
}

export async function saveTaskLoopWorkflow(yaml: string): Promise<string> {
  const j = await authJsonFetch<{ ok: boolean; error?: string; hint?: string }>('/api/aigility/task-loop/workflow', {
    method: 'PUT',
    body: JSON.stringify({ yaml }),
  })
  if (!j.ok) throw new Error(j.error ?? '保存失败')
  return j.hint ?? '已保存'
}

// ── 角色包（roles/ 目录 · role-kit：工厂的可移植角色单元）─────────

export interface RolePackageCommand { pattern: string; action: string; summary?: string }

export interface RolePackageSchedule { name: string; trigger: string; action: string; summary?: string; enabled?: boolean }

export interface RolePackageManifest {
  role_id: string
  identity: { name: string; signature?: string; capability_ref?: string }
  sources: { channels?: Array<{ platform: 'feishu' | 'wecom'; apps: ChannelAppBindingView[] }>; data?: string[] }
  actions: {
    tools?: string[]
    workflows?: string[]
    commands?: RolePackageCommand[]
    schedules?: RolePackageSchedule[]
    engine?: string
  }
  outbound: { reply?: 'same-channel'; push?: string[] }
  memory: { agent_id: string; legacy_agent_ids?: string[] }
}

export type RoleOrigin = 'published' | 'site' | 'template' | 'engine'

export interface RolePackageInfo {
  id: string
  layer: 'public' | 'site'
  dir: string
  name: string
  description: string
  prompt: string
  manifest: RolePackageManifest
  issues: string[]
  /** 生命周期来源：已发布 / 站点定制 / 底座模板 / 引擎原生 */
  origin?: RoleOrigin
  /** 引擎原生未包化（虚拟卡）：定制副本后落为站点包 */
  virtual?: boolean
  published?: { category?: string; tags?: string[]; modelId?: string; visibility?: string; owner?: string | null }
  personaRoute?: string
  personaDesc?: string
}

export function fetchRolePackages(): Promise<RolePackageInfo[]> {
  return authJsonFetch<{ ok: boolean; packages: RolePackageInfo[] }>('/api/aigility/role-packages')
    .then((j) => j.packages ?? [])
}

/** 导出 ElizaOS character file（官方 schema 结构，aigility 溯源在 settings.aigility） */
export async function fetchRoleEliza(id: string): Promise<Record<string, unknown>> {
  const j = await authJsonFetch<{ ok: boolean; character: Record<string, unknown> }>(`/api/aigility/role-packages/${encodeURIComponent(id)}/eliza`)
  if (!j.ok) throw new Error('导出失败')
  return j.character
}

/** 导入角色文件：自动识别 aigility 角色包 JSON / ElizaOS character file，落为站点角色包 */
export async function importRoleFile(text: string): Promise<string> {
  const parsed = JSON.parse(text) as Record<string, unknown>
  if (parsed.format === 'aigility-role-package' && parsed.manifest) {
    const body = parsed as { manifest: RolePackageManifest; prompt?: string }
    await saveRolePackage(body.manifest.role_id, { manifest: body.manifest, prompt: body.prompt })
    return body.manifest.role_id
  }
  const j = await authJsonFetch<{ ok: boolean; error?: string; id?: string }>('/api/aigility/role-packages/import-eliza', {
    method: 'POST',
    body: JSON.stringify({ character: parsed }),
  })
  if (!j.ok) throw new Error(j.error ?? '导入失败')
  return j.id ?? ''
}

/** 保存角色包：编辑公共模板 = copy-on-override 站点化（返回 siteOverride 供提示） */
export async function saveRolePackage(id: string, body: { manifest: RolePackageManifest; prompt?: string }): Promise<{ siteOverride: boolean }> {
  const j = await authJsonFetch<{ ok: boolean; error?: string; siteOverride?: boolean }>(`/api/aigility/role-packages/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  })
  if (!j.ok) throw new Error(j.error ?? '保存失败')
  return { siteOverride: j.siteOverride ?? false }
}

/** 恢复出厂：删除站点定制版，解析回落底座模板 */
export async function revertRolePackage(id: string): Promise<void> {
  const j = await authJsonFetch<{ ok: boolean; error?: string }>(`/api/aigility/role-packages/${encodeURIComponent(id)}`, { method: 'DELETE' })
  if (!j.ok) throw new Error(j.error ?? '恢复失败')
}
