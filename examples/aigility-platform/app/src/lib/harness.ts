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
