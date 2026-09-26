import { useEffect, useMemo, useRef, useState } from 'react'
import Dashboard from './pages/Dashboard'
import DataIngest from './pages/DataIngest'
import GraphPage from './pages/GraphPage'
import AgentPage from './pages/AgentPage'
import SpacePage from './pages/SpacePage'
import ProcessPage from './pages/ProcessPage'
import SettingsPage from './pages/SettingsPage'
import ModulePage from './pages/ModulePage'
import AuthPage from './pages/AuthPage'
import MarketPage from './pages/MarketPage'
import AppCenterPage from './pages/AppCenterPage'
import OpsPage from './pages/OpsPage'
import WorkspacePage from './pages/WorkspacePage'
import StudioPage from './pages/StudioPage'
import ModelsPage from './pages/ModelsPage'
import ToolsPage from './pages/ToolsPage'
import LoginGate from './components/LoginGate'
import { apiMe, apiLogout, getToken, clearToken, type PlatformUser } from './lib/api'
import {
  skills as initialSkills, moduleRegistry, tenants, defaultBranding, wsMessages,
  marketAgents, centerApps, knowledgeBases, pluginTools, mcpTools, models,
  type Skill, type Branding,
} from './mock/data'
import {
  LayoutDashboard, Database, Network, Bot, BrainCircuit, GitBranch, Settings, Blocks, ShieldCheck, Zap,
  Store, LayoutGrid, Gauge, Briefcase, Factory, Cpu, Wrench, Search, Bell, ChevronDown, Hexagon,
  CheckCircle2, User, LogOut, Building2, CircleHelp,
} from 'lucide-react'

const moduleIcon: Record<string, any> = {
  workspace: Briefcase, agent: Bot, market: Store, apps: LayoutGrid, studio: Factory,
  ingest: Database, graph: Network, space: BrainCircuit, process: GitBranch,
  tools: Wrench, models: Cpu, ops: Gauge,
}

const groupMeta: { cat: string; label: string }[] = [
  { cat: '平台层', label: '平台' },
  { cat: 'TiMEM 上下文层', label: 'TiMEM 上下文基础设施' },
  { cat: '平台能力', label: '平台能力' },
]

const systemNav = [
  { id: 'modules', label: '模块装配', icon: Blocks },
  { id: 'auth', label: '权限管理', icon: ShieldCheck },
  { id: 'settings', label: '平台配置', icon: Settings },
]

export type { Branding }

const hexA = (hex: string, a: number) => {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
}

const loadLs = <T,>(key: string, fallback: T): T => {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback } catch { return fallback }
}

export default function App() {
  const [page, setPage] = useState('home')
  const [skillList, setSkillList] = useState<Skill[]>(initialSkills)
  const [enabledModules, setEnabledModules] = useState<Set<string>>(
    new Set(moduleRegistry.filter(m => m.available).map(m => m.id))
  )
  const [branding, setBranding] = useState<Branding>(() => ({ ...defaultBranding, ...loadLs('zy_branding_v2', defaultBranding) }))
  const [tenantId, setTenantId] = useState(() => loadLs('zy_tenant', 'standard'))

  // ── 登录会话（AppBase 平台账号）──
  const [user, setUser] = useState<PlatformUser | null>(null)
  const [authChecked, setAuthChecked] = useState(false)
  useEffect(() => {
    if (getToken()) {
      apiMe().then(setUser).catch(() => { clearToken() }).finally(() => setAuthChecked(true))
    } else {
      setAuthChecked(true)
    }
    const onUnauth = () => setUser(null)
    window.addEventListener('aigility-unauth', onUnauth)
    return () => window.removeEventListener('aigility-unauth', onUnauth)
  }, [])
  const logout = () => { void apiLogout(); setUser(null) }

  // 顶部工具条状态
  const [searchOpen, setSearchOpen] = useState(false)
  const [kw, setKw] = useState('')
  const [msgOpen, setMsgOpen] = useState(false)
  const [msgs, setMsgs] = useState(wsMessages)
  const [tenantOpen, setTenantOpen] = useState(false)
  const [userOpen, setUserOpen] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => { localStorage.setItem('zy_branding_v2', JSON.stringify(branding)) }, [branding])
  useEffect(() => { localStorage.setItem('zy_tenant', JSON.stringify(tenantId)) }, [tenantId])
  useEffect(() => { if (searchOpen) searchRef.current?.focus() }, [searchOpen])

  const tenant = tenants.find(t => t.id === tenantId) || tenants[0]

  const switchTenant = (id: string) => {
    const t = tenants.find(x => x.id === id)!
    setTenantId(id)
    setBranding(() => {
      // 白标切换：以默认品牌为底叠加租户配置；租户未定义英文名时不继承（避免串牌）
      const next: Branding = { ...defaultBranding, ...t.branding }
      if (!t.branding.englishName) next.englishName = undefined
      return next
    })
    setTenantOpen(false)
  }

  const toggleModule = (id: string) =>
    setEnabledModules(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })

  const addSkill = (nodeName: string) => {
    setSkillList(list => list.some(s => s.name === nodeName) ? list : [{
      id: `gen-${nodeName}`,
      name: nodeName,
      role: '由流程节点自动生成',
      scope: '流程上下文 + TiMEM 空间',
      steps: nodeName === '报价审批' ? ['读取客户面积与工艺包', '匹配单价系数', '生成报价单', '设计师人审']
        : nodeName === '施工派单' ? ['读取签约订单', '匹配班组与档期', '生成派工单', '项目经理确认']
        : ['对照验收标准知识库', '生成验收清单', '质检填报', '整改回路触发'],
      usage: 0,
      status: '草稿',
      from: '流程节点生成',
    }, ...list])
  }

  const activeModules = moduleRegistry.filter(m => m.available && enabledModules.has(m.id))
  const moduleDisabled = moduleRegistry.some(m => m.page === page && !enabledModules.has(m.id))
  const unread = msgs.filter(m => !m.read).length

  // 全局搜索
  const results = useMemo(() => {
    if (!kw.trim()) return []
    const k = kw.trim()
    const hit = (s: string) => s.toLowerCase().includes(k.toLowerCase())
    const out: { type: string; name: string; desc: string; page: string }[] = []
    marketAgents.filter(a => hit(a.name) || a.tags.some(hit)).slice(0, 3).forEach(a => out.push({ type: '智能体', name: a.name, desc: a.desc, page: 'market' }))
    centerApps.filter(a => hit(a.name)).slice(0, 2).forEach(a => out.push({ type: '应用', name: a.name, desc: a.desc, page: 'apps' }))
    knowledgeBases.filter(x => hit(x.name)).slice(0, 2).forEach(x => out.push({ type: '知识库', name: x.name, desc: `${x.docs} 文档 · 命中率 ${x.hit}`, page: 'space' }))
    pluginTools.filter(t => hit(t.name)).slice(0, 2).forEach(t => out.push({ type: '工具', name: t.name, desc: t.description, page: 'tools' }))
    mcpTools.filter(t => hit(t.name)).slice(0, 2).forEach(t => out.push({ type: '工具', name: t.name, desc: t.desc, page: 'tools' }))
    models.filter(m => hit(m.name)).slice(0, 2).forEach(m => out.push({ type: '模型', name: m.name, desc: m.description, page: 'models' }))
    return out.slice(0, 8)
  }, [kw])

  const go = (p: string) => { setPage(p); setSearchOpen(false); setKw('') }

  const renderPage = () => {
    if (moduleDisabled) {
      const mod = moduleRegistry.find(m => m.page === page)!
      return (
        <div className="bg-white rounded-xl border border-slate-200/80 p-16 text-center max-w-xl mx-auto mt-16">
          <div className="w-14 h-14 rounded-2xl bg-slate-100 flex items-center justify-center mx-auto mb-4"><Zap size={24} className="text-slate-400" /></div>
          <h3 className="font-semibold text-slate-800">「{mod.name}」模块未装配</h3>
          <p className="text-sm text-slate-400 mt-2 mb-5">到模块装配中打开开关，导航与功能即时生效</p>
          <button onClick={() => setPage('modules')} className="text-sm px-4 py-2 rounded-lg text-white" style={{ background: branding.primary }}>去模块装配</button>
        </div>
      )
    }
    switch (page) {
      case 'home': return <Dashboard go={setPage} branding={branding} />
      case 'workspace': return <WorkspacePage go={setPage} />
      case 'ingest': return <DataIngest go={setPage} />
      case 'graph': return <GraphPage go={setPage} />
      case 'agent': return <AgentPage skillList={skillList} />
      case 'space': return <SpacePage />
      case 'process': return <ProcessPage onGenerateSkill={addSkill} go={setPage} generatedSkills={skillList.map(s => s.name)} />
      case 'market': return <MarketPage go={setPage} />
      case 'apps': return <AppCenterPage />
      case 'studio': return <StudioPage />
      case 'tools': return <ToolsPage />
      case 'models': return <ModelsPage />
      case 'ops': return <OpsPage />
      case 'modules': return <ModulePage enabled={enabledModules} toggle={toggleModule} />
      case 'auth': return <AuthPage />
      case 'settings': return <SettingsPage branding={branding} setBranding={setBranding} tenantId={tenantId} />
      default: return <Dashboard go={setPage} branding={branding} />
    }
  }

  const NavBtn = ({ n }: { n: { id: string; label: string; icon: any } }) => {
    const active = page === n.id
    return (
      <button onClick={() => setPage(n.id)}
        className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm transition ${active ? 'font-medium' : 'text-slate-600 hover:bg-slate-50'}`}
        style={active ? { background: hexA(branding.primary, 0.09), color: branding.primary } : undefined}>
        <n.icon size={17} style={{ color: active ? branding.primary : '#94A3B8' }} />
        {n.label}
      </button>
    )
  }

  const logoGradient = { background: `linear-gradient(135deg, ${branding.primary}, ${branding.accent})` }

  // ── 整站门禁（置于全部 hooks 之后, 保证 hook 顺序稳定）──
  if (!authChecked) {
    return <div className="min-h-screen bg-[#F6F7F9]" />
  }
  if (!user) {
    return <LoginGate onSuccess={() => { apiMe().then(setUser).catch(() => { clearToken() }) }} />
  }

  return (
    <div className="min-h-screen bg-[#F6F7F9] flex">
      {/* 移动端顶栏 */}
      <div className="md:hidden fixed top-0 inset-x-0 z-30 bg-white border-b border-slate-200/70">
        <div className="flex items-center gap-2 px-4 py-3">
          <div className="w-7 h-7 rounded-lg text-white flex items-center justify-center text-xs font-bold" style={logoGradient}>{branding.logoText}</div>
          <span className="text-sm font-semibold text-slate-800">{branding.platformName}</span>
        </div>
        <div className="flex gap-1 px-3 pb-2 overflow-x-auto">
          {[{ id: 'home', label: '首页' }, ...activeModules.map(m => ({ id: m.page, label: m.name })), ...systemNav].map(n => (
            <button key={n.id} onClick={() => setPage(n.id)}
              className={`whitespace-nowrap text-xs px-3 py-1.5 rounded-full ${page === n.id ? 'text-white' : 'bg-slate-100 text-slate-600'}`}
              style={page === n.id ? { background: branding.primary } : undefined}>{n.label}</button>
          ))}
        </div>
      </div>

      {/* 侧边栏 */}
      <aside className="hidden md:flex w-56 shrink-0 bg-white border-r border-slate-200/70 flex-col fixed inset-y-0 z-20">
        <div className="px-5 py-5 flex items-center gap-2.5 border-b border-slate-100">
          <div className="w-9 h-9 rounded-xl text-white flex items-center justify-center text-sm font-bold" style={logoGradient}>{branding.logoText}</div>
          <div>
            <div className="text-sm font-semibold text-slate-800 leading-tight">{branding.platformName}</div>
            <div className="text-[10px] text-slate-400">{branding.englishName && <span className="mr-1">{branding.englishName} ·</span>}TiMEM 上下文基础设施驱动</div>
          </div>
        </div>
        <nav className="flex-1 px-3 py-3 space-y-0.5 overflow-y-auto">
          <NavBtn n={{ id: 'home', label: '首页', icon: LayoutDashboard }} />
          {groupMeta.map(g => {
            const items = activeModules.filter(m => m.category === g.cat)
            if (!items.length) return null
            return (
              <div key={g.cat}>
                <div className="pt-3 pb-1 px-3 text-[10px] font-medium text-slate-300 tracking-wider">{g.label}</div>
                {items.map(m => <NavBtn key={m.id} n={{ id: m.page, label: m.name, icon: moduleIcon[m.id] || Blocks }} />)}
              </div>
            )
          })}
          <div className="pt-3 pb-1 px-3 text-[10px] font-medium text-slate-300 tracking-wider">系统管理</div>
          {systemNav.map(n => <NavBtn key={n.id} n={n} />)}
        </nav>
        <div className="p-4 border-t border-slate-100">
          <div className="rounded-xl p-4 text-white" style={{ background: 'linear-gradient(135deg,#1E293B,#0F172A)' }}>
            <div className="text-xs font-medium mb-1 flex items-center gap-1.5"><Hexagon size={12} className="text-sky-300" />TiMEM 上下文层已接入</div>
            <p className="text-[11px] text-slate-300 leading-relaxed">图谱 · 记忆 · 规则 · 知识中间件统一供能，平台越用越聪明</p>
          </div>
          <div className="flex items-center gap-2.5 mt-4 px-1">
            <div className="w-8 h-8 rounded-full text-white flex items-center justify-center text-xs font-semibold" style={{ background: branding.primary }}>{user.email[0].toUpperCase()}</div>
            <div className="min-w-0">
              <div className="text-xs font-medium text-slate-700 truncate">{user.email}</div>
              <div className="text-[10px] text-slate-400">{user.isAdmin ? '平台管理员' : '平台成员'} · {tenant.name}</div>
            </div>
          </div>
        </div>
      </aside>

      {/* 主区 */}
      <main className="flex-1 md:ml-56 p-4 md:p-7 pt-[104px] md:pt-5 max-w-[1400px] w-full">
        {/* 顶部工具条（桌面端） */}
        <div className="hidden md:flex items-center gap-3 mb-5">
          {/* 全局搜索 */}
          <div className="relative flex-1 max-w-md">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input ref={searchRef} value={kw} onFocus={() => setSearchOpen(true)}
              onChange={e => { setKw(e.target.value); setSearchOpen(true) }}
              placeholder="全局搜索：智能体、应用、知识库、工具、模型…"
              className="w-full pl-9 pr-3 py-2 text-sm bg-white border border-slate-200/80 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-300" />
            {searchOpen && kw.trim() && (
              <>
                <div className="fixed inset-0 z-30" onClick={() => setSearchOpen(false)} />
                <div className="absolute top-full mt-2 inset-x-0 bg-white rounded-xl border border-slate-200 shadow-xl z-40 overflow-hidden" style={{ animation: 'fadeSlide .2s ease' }}>
                  {results.length === 0 ? (
                    <div className="px-4 py-6 text-center text-xs text-slate-400">没有找到「{kw}」相关的内容</div>
                  ) : results.map((r, i) => (
                    <button key={i} onClick={() => go(r.page)} className="w-full text-left px-4 py-2.5 hover:bg-slate-50 flex items-center gap-3 border-b border-slate-50 last:border-0">
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-600 w-12 text-center shrink-0">{r.type}</span>
                      <div className="min-w-0">
                        <div className="text-xs font-medium text-slate-700">{r.name}</div>
                        <div className="text-[11px] text-slate-400 truncate">{r.desc}</div>
                      </div>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          <div className="flex items-center gap-1.5 ml-auto">
            <button className="w-9 h-9 rounded-lg hover:bg-white flex items-center justify-center text-slate-400 hover:text-slate-600" title="帮助中心"><CircleHelp size={17} /></button>
            {/* 通知 */}
            <div className="relative">
              <button onClick={() => { setMsgOpen(true); setTenantOpen(false); setUserOpen(false) }}
                className="w-9 h-9 rounded-lg hover:bg-white flex items-center justify-center text-slate-400 hover:text-slate-600 relative">
                <Bell size={17} />
                {unread > 0 && <span className="absolute top-1.5 right-1.5 w-4 h-4 rounded-full bg-red-500 text-white text-[9px] flex items-center justify-center">{unread}</span>}
              </button>
            </div>
            {/* 租户切换 */}
            <div className="relative">
              <button onClick={() => { setTenantOpen(o => !o); setUserOpen(false) }}
                className="flex items-center gap-1.5 text-xs text-slate-600 bg-white border border-slate-200/80 rounded-lg px-3 py-2 hover:border-slate-300">
                <Building2 size={13} className="text-slate-400" />{tenant.name}<ChevronDown size={12} className="text-slate-400" />
              </button>
              {tenantOpen && (
                <>
                  <div className="fixed inset-0 z-30" onClick={() => setTenantOpen(false)} />
                  <div className="absolute right-0 top-full mt-2 w-56 bg-white rounded-xl border border-slate-200 shadow-xl z-40 overflow-hidden">
                    <div className="px-4 py-2.5 text-[10px] text-slate-400 border-b border-slate-50">切换租户（联动品牌名称与主题色）</div>
                    {tenants.map(t => (
                      <button key={t.id} onClick={() => switchTenant(t.id)}
                        className="w-full text-left px-4 py-2.5 hover:bg-slate-50 flex items-center gap-2.5">
                        <span className="w-6 h-6 rounded-md text-white text-[10px] font-bold flex items-center justify-center shrink-0" style={{ background: t.branding.primary }}>{t.branding.logoText}</span>
                        <div className="flex-1">
                          <div className="text-xs font-medium text-slate-700">{t.name}</div>
                          <div className="text-[10px] text-slate-400">{t.branding.platformName} · {t.plan}</div>
                        </div>
                        {t.id === tenantId && <CheckCircle2 size={14} className="text-emerald-500" />}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
            {/* 用户菜单 */}
            <div className="relative">
              <button onClick={() => { setUserOpen(o => !o); setTenantOpen(false) }}
                className="w-8 h-8 rounded-full text-white flex items-center justify-center text-xs font-semibold ml-1" style={{ background: branding.primary }}>{user.email[0].toUpperCase()}</button>
              {userOpen && (
                <>
                  <div className="fixed inset-0 z-30" onClick={() => setUserOpen(false)} />
                  <div className="absolute right-0 top-full mt-2 w-44 bg-white rounded-xl border border-slate-200 shadow-xl z-40 overflow-hidden py-1">
                    <div className="px-4 py-2 border-b border-slate-50">
                      <div className="text-xs font-medium text-slate-700">{user.email}</div>
                      <div className="text-[10px] text-slate-400">{user.isAdmin ? '平台管理员' : '平台成员'} · AppBase 账号</div>
                    </div>
                    {([['个人中心', User], ['租户设置', Building2]] as const).map(([l, I]) => (
                      <button key={l} onClick={() => setUserOpen(false)} className="w-full text-left px-4 py-2 text-xs text-slate-600 hover:bg-slate-50 flex items-center gap-2"><I size={13} className="text-slate-400" />{l}</button>
                    ))}
                    <button onClick={() => { setUserOpen(false); logout() }} className="w-full text-left px-4 py-2 text-xs text-slate-600 hover:bg-slate-50 flex items-center gap-2"><LogOut size={13} className="text-slate-400" />退出登录</button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        {renderPage()}

        {/* 通知抽屉 */}
        {msgOpen && (
          <div className="fixed inset-0 z-40 flex justify-end" onClick={() => setMsgOpen(false)}>
            <div className="absolute inset-0 bg-slate-900/20" />
            <div className="relative w-full max-w-sm bg-white h-full shadow-2xl p-5 overflow-y-auto" onClick={e => e.stopPropagation()} style={{ animation: 'slideIn .25s ease' }}>
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-semibold text-slate-800">消息通知</h3>
                <button onClick={() => setMsgs(list => list.map(m => ({ ...m, read: true })))} className="text-xs text-blue-600 hover:underline">全部已读</button>
              </div>
              <div className="space-y-3">
                {msgs.map(m => (
                  <button key={m.id} onClick={() => setMsgs(list => list.map(x => x.id === m.id ? { ...x, read: true } : x))}
                    className={`w-full text-left rounded-xl border p-3.5 transition ${m.read ? 'border-slate-100 opacity-60' : 'border-slate-200 bg-slate-50/50'}`}>
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`w-1.5 h-1.5 rounded-full ${m.read ? 'bg-slate-300' : 'bg-blue-500'}`} />
                      <span className="text-xs font-medium text-slate-700">{m.title}</span>
                      <span className={`text-[10px] px-1.5 rounded ${m.type === '审批' ? 'bg-amber-50 text-amber-600' : m.type === '运行' ? 'bg-blue-50 text-blue-600' : 'bg-slate-100 text-slate-500'}`}>{m.type}</span>
                      <span className="text-[10px] text-slate-300 ml-auto">{m.time}</span>
                    </div>
                    <p className="text-[11px] text-slate-500 leading-relaxed pl-3.5">{m.content}</p>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </main>
      <style>{`@keyframes fadeSlide { from { opacity: 0; transform: translateY(4px);} to { opacity: 1; transform: none; } } @keyframes slideIn { from { transform: translateX(40px); opacity: 0; } to { transform: none; opacity: 1; } }`}</style>
    </div>
  )
}
