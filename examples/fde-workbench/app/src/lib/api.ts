/** 平台 API 客户端：复用 AppBase app-backend（同源 :1234 挂载的 /app/* 路由） */

const TOKEN_KEY = 'fde-token'

export interface PlatformUser {
  id: string
  email: string
  isAdmin: boolean
}

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? ''
}

export function setToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token)
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY)
}

function authHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
  }
}

async function jsonFetch<T>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`)
  return body as T
}

// ── 账号（AppBase users 表, token 与 AppBase 互通）────────────────

export async function apiLogin(email: string, password: string): Promise<PlatformUser> {
  const r = await jsonFetch<{ token: string; user: PlatformUser }>('/app/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  setToken(r.token)
  return r.user
}

export async function apiRegister(email: string, password: string): Promise<PlatformUser> {
  const r = await jsonFetch<{ token: string; user: PlatformUser }>('/app/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, next: '/apps/fde-workbench' }),
  })
  setToken(r.token)
  return r.user
}

export async function apiMe(): Promise<PlatformUser> {
  if (!getToken()) throw new Error('未登录')
  return (await jsonFetch<{ user: PlatformUser }>('/app/auth/me', { headers: authHeaders() })).user
}

export async function apiLogout(): Promise<void> {
  try { await fetch('/app/auth/logout', { method: 'POST', headers: authHeaders() }) } catch { /* 尽力而为 */ }
  clearToken()
}

// ── 业务数据（/app/data/:table?app=fde-workbench — 应用共享 JSONB）──

/** 工作台业务数据挂应用虚拟 owner, 登录成员共享读写 */
const APP_Q = 'app=fde-workbench'
const TABLE_PREFIX = 'fde_'

export interface SliceRow {
  rowId: string
  items: unknown[]
}

/** 读一个业务分片（整片存一行 data.items）; 无行返回 null（首次初始化由调用方写入种子） */
export async function fetchSlice(slice: string): Promise<SliceRow | null> {
  const r = await jsonFetch<{ rows: Array<{ id: string; data: { items?: unknown[] } }> }>(
    `/app/data/${TABLE_PREFIX}${slice}?${APP_Q}`, { headers: authHeaders() })
  const row = r.rows[0]
  if (!row) return null
  return { rowId: row.id, items: Array.isArray(row.data?.items) ? row.data.items : [] }
}

/** 创建分片行（首次初始化） */
export async function createSlice(slice: string, items: unknown[]): Promise<string> {
  const r = await jsonFetch<{ id: string }>(`/app/data/${TABLE_PREFIX}${slice}?${APP_Q}`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ data: { items } }),
  })
  return r.id
}

/** 整片覆盖写（rowId 缺失时降级为创建） */
export async function saveSlice(slice: string, rowId: string | undefined, items: unknown[]): Promise<string> {
  if (!rowId) return createSlice(slice, items)
  await jsonFetch<{ ok: boolean }>(`/app/data/${TABLE_PREFIX}${slice}/${rowId}?${APP_Q}`, {
    method: 'PUT',
    headers: authHeaders(),
    body: JSON.stringify({ data: { items } }),
  })
  return rowId
}
