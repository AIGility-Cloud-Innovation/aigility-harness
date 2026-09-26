/** 平台 API 客户端：复用 AppBase app-backend（同源 :1236 挂载的 /app/* 路由, token 与 AppBase 互通） */

const TOKEN_KEY = 'aigility-token'
const USER_KEY = 'aigility-user'

export interface PlatformUser {
  id: string
  email: string
  isAdmin: boolean
}

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? ''
}

/** 当前登录用户（登录/注册/me 时写入, 退出清除） */
export function getCurrentUser(): PlatformUser | null {
  try {
    const raw = localStorage.getItem(USER_KEY)
    return raw ? (JSON.parse(raw) as PlatformUser) : null
  } catch {
    return null
  }
}

function storeUser(user: PlatformUser) {
  localStorage.setItem(USER_KEY, JSON.stringify(user))
}

export function setToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token)
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(USER_KEY)
}

function authHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
  }
}

/** 401 统一处理：清会话并广播, App 门禁监听后切登录屏 */
function onUnauthorized() {
  clearToken()
  window.dispatchEvent(new CustomEvent('aigility-unauth'))
}

async function jsonFetch<T>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  if (res.status === 401) {
    onUnauthorized()
    throw new Error('登录已过期，请重新登录')
  }
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`)
  return body as T
}

/** 带会话的 JSON 请求（封装 API /api/aigility/* 通用; 401 统一走 onUnauthorized） */
export async function authJsonFetch<T>(url: string, init: RequestInit = {}): Promise<T> {
  return jsonFetch<T>(url, {
    ...init,
    headers: { ...authHeaders(), ...(init.headers as Record<string, string> | undefined) },
  })
}

// ── 账号（AppBase users 表, token 与 AppBase 互通）────────────────

export async function apiLogin(email: string, password: string): Promise<PlatformUser> {
  const r = await jsonFetch<{ token: string; user: PlatformUser }>('/app/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  setToken(r.token)
  storeUser(r.user)
  return r.user
}

export async function apiRegister(email: string, password: string): Promise<PlatformUser> {
  const r = await jsonFetch<{ token: string; user: PlatformUser }>('/app/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, next: '/' }),
  })
  setToken(r.token)
  storeUser(r.user)
  return r.user
}

export async function apiMe(): Promise<PlatformUser> {
  if (!getToken()) throw new Error('未登录')
  const u = (await jsonFetch<{ user: PlatformUser }>('/app/auth/me', { headers: authHeaders() })).user
  storeUser(u)
  return u
}

export async function apiLogout(): Promise<void> {
  try { await fetch('/app/auth/logout', { method: 'POST', headers: authHeaders() }) } catch { /* 尽力而为 */ }
  clearToken()
}
