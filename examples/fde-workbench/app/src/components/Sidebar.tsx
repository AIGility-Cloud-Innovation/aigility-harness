import { useStore } from '@/store/AppContext'
import { cn } from '@/lib/utils'
import { type Page } from '@/types'
import { ROLES } from '@/data/mock'
import {
  LayoutDashboard, ListTodo, Medal, Users, FileStack, FileText, PackageCheck, Rocket, Network, BrainCircuit, Blocks,
  Upload, ScrollText, Plug2, Waypoints,
  ChevronDown, CheckCircle2, LogOut, type LucideIcon,
} from 'lucide-react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'

export interface NavItem {
  name: string
  label: string
  icon: LucideIcon
  sub: string
  step: string
  adminOnly: boolean
}

/** 导航按 FDE 业务流程分组：获客跟进 → 方案报价 → 签约交付 → 沉淀复用 */
export const NAV_GROUPS: { group: string; items: NavItem[] }[] = [
  {
    group: '总览',
    items: [
      { name: 'dashboard', label: '仪表盘', icon: LayoutDashboard, sub: '全盘作战视图', step: '', adminOnly: false },
      { name: 'tasks', label: '待办中心', icon: ListTodo, sub: '需要人拍板的事项', step: '', adminOnly: false },
      { name: 'performance', label: '绩效提成', icon: Medal, sub: '贡献度 · 奖金分配', step: '', adminOnly: false },
    ],
  },
  {
    group: '数字孪生',
    items: [
      { name: 'ontology', label: '企业本体', icon: Waypoints, sub: '数据孪生 · 主动决策', step: '', adminOnly: false },
    ],
  },
  {
    group: '业务流程',
    items: [
      { name: 'leads', label: '线索管理', icon: Users, sub: '获客 · 拜访 · 跟进', step: '01', adminOnly: false },
      { name: 'proposals', label: '方案生成', icon: FileStack, sub: '三件套 · 报价迭代', step: '02', adminOnly: false },
      { name: 'contracts', label: '合同管理', icon: FileText, sub: '签约 · 采购 · 回款', step: '03', adminOnly: false },
      { name: 'delivery', label: '交付管理', icon: PackageCheck, sub: '里程碑 · 验收 · 回访', step: '04', adminOnly: false },
      { name: 'deployments', label: '部署台账', icon: Rocket, sub: '域名 · 仓库 · 版本日志', step: '05', adminOnly: false },
      { name: 'channels', label: '渠道与伙伴', icon: Network, sub: '获客分佣 · 交付伙伴', step: '06', adminOnly: true },
    ],
  },
  {
    group: '沉淀复用',
    items: [
      { name: 'knowledge', label: '知识沉淀', icon: BrainCircuit, sub: '规则 · 记忆 · 太忆空间三池', step: '07', adminOnly: false },
      { name: 'modules', label: '产品模块库', icon: Blocks, sub: '模块沉淀 · 标准产品 SKU', step: '08', adminOnly: false },
    ],
  },
  {
    group: '系统与审计',
    items: [
      { name: 'import', label: '数据导入', icon: Upload, sub: '解析 · 审阅 · 审批录入', step: '', adminOnly: false },
      { name: 'mcp', label: 'MCP 连接器', icon: Plug2, sub: '对外开放 · 工具封装', step: '', adminOnly: false },
      { name: 'audit', label: '审计日志', icon: ScrollText, sub: '留痕 · 可追溯 · 可问责', step: '', adminOnly: true },
    ],
  },
]

export const NAV_ITEMS = NAV_GROUPS.flatMap(g => g.items)

const activeFor = (page: Page): string => {
  if (page.name === 'lead') return 'leads'
  if (page.name === 'proposal') return 'proposals'
  return page.name
}

/** 导航主体：桌面侧边栏与移动端抽屉共用 */
export function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const { page, navigate, scopedLeads, proposals, contracts, knowledge, role, reminders, deliveries, importBatches, teamTasks } = useStore()
  const active = activeFor(page)
  const pendingKnowledge = knowledge.filter(k => k.status === '待审阅').length
  const reminderCount = reminders.filter(r => !r.done).length
  const taskCount =
    proposals.filter(p => p.status === '待审阅').length +
    proposals.reduce((s, p) => s + p.feedbacks.filter(f => f.status === '待处理').length, 0) +
    scopedLeads.reduce((s, l) => s + l.interviews.filter(iv => iv.status === '待确认').length, 0) +
    contracts.reduce((s, c) => s + c.payments.filter(p => !p.done).length, 0) +
    deliveries.filter(d => d.status === '交付中' || d.status === '待启动').length +
    pendingKnowledge + reminderCount +
    teamTasks.filter(t => t.status !== '已完成').length

  const badgeFor = (name: string): number => {
    if (name === 'tasks') return taskCount
    if (name === 'leads') return scopedLeads.filter(l => l.stage !== '已流失' && l.stage !== '已交付').length
    if (name === 'proposals') return proposals.filter(p => p.status === '待审阅').length
    if (name === 'contracts') return contracts.filter(c => c.status !== '已回款').length
    if (name === 'delivery') return deliveries.filter(d => d.status === '交付中' || d.status === '待启动').length
    if (name === 'knowledge') return pendingKnowledge
    if (name === 'import') return importBatches.filter(b => b.status === '待审阅').reduce((s, b) => s + b.rows.filter(r => r.status === '待审').length, 0)
    return 0
  }

  const go = (p: Page) => { navigate(p); onNavigate?.() }

  return (
    <nav className="flex-1 overflow-y-auto px-3 pb-4">
      {NAV_GROUPS.map(g => (
        <div key={g.group} className="mt-5 first:mt-2">
          <p className="px-2.5 pb-1.5 text-[10px] font-medium tracking-widest text-slate-400">{g.group}</p>
          <div className="space-y-0.5">
            {g.items.filter(n => !n.adminOnly || role.scope === 'all').map(item => {
              const badge = badgeFor(item.name)
              const isActive = active === item.name
              return (
                <button
                  key={item.name}
                  onClick={() => go({ name: item.name } as Page)}
                  title={item.sub}
                  className={cn(
                    'group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-left transition-colors',
                    isActive ? 'bg-blue-50' : 'hover:bg-slate-50'
                  )}
                >
                  <item.icon className={cn('h-4 w-4 shrink-0', isActive ? 'text-[#3370ff]' : 'text-slate-400 group-hover:text-slate-600')} />
                  <span className={cn('flex min-w-0 flex-1 items-center gap-1.5 text-[13px]', isActive ? 'font-medium text-[#3370ff]' : 'text-slate-600')}>
                    {item.step && <span className={cn('tnum text-[10px]', isActive ? 'text-[#3370ff]/60' : 'text-slate-300')}>{item.step}</span>}
                    <span className="truncate">{item.label}</span>
                  </span>
                  {badge > 0 && (
                    <span className={cn('tnum shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold',
                      isActive ? 'bg-[#3370ff] text-white' : 'bg-slate-100 text-slate-500')}>{badge}</span>
                  )}
                </button>
              )
            })}
          </div>
        </div>
      ))}
    </nav>
  )
}

/** 桌面端侧边栏 */
export function Sidebar() {
  const { navigate, role, setRole, logout } = useStore()

  return (
    <aside className="sticky top-0 hidden h-screen w-[248px] shrink-0 flex-col border-r border-slate-200/80 bg-white md:flex">
      {/* Logo */}
      <button onClick={() => navigate({ name: 'dashboard' })} className="flex items-center gap-2.5 px-5 pt-6 pb-5 text-left">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#3370ff] text-[14px] font-bold text-white">忆</div>
        <div className="leading-none">
          <div className="text-[14px] font-bold text-slate-900 tracking-tight">TiMEM FDE 工作台</div>
          <div className="mt-1 text-[10px] text-slate-400 tracking-wide">从线索到交付 · 越用越聪明</div>
        </div>
      </button>

      <SidebarNav />

      {/* 底部用户卡片（通知与数字员工统一在顶部栏右上角） */}
      <div className="border-t border-slate-100 p-4">
        <DropdownMenu>
          <DropdownMenuTrigger className="flex w-full items-center gap-2.5 rounded-xl border border-slate-200/70 bg-white px-3 py-2.5 text-left hover:border-[#3370ff] transition-colors">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#3370ff] text-[11px] font-semibold text-white">{role.name[0]}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12px] font-medium text-slate-800">{role.name}</span>
              <span className="block truncate text-[10px] text-slate-400">{role.title}</span>
            </span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-400" />
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" className="w-60">
            <p className="px-2 py-1.5 text-[11px] text-slate-400">切换视角（演示不同角色看到的数据范围）</p>
            {ROLES.map(r => (
              <DropdownMenuItem key={r.id} onClick={() => setRole(r.id)} className="flex flex-col items-start gap-0.5 py-2">
                <span className="flex items-center gap-2 text-[13px] font-medium">
                  {r.name}
                  {r.id === role.id && <CheckCircle2 className="h-3.5 w-3.5 text-[#3370ff]" />}
                </span>
                <span className="text-[11px] text-slate-400">{r.title}</span>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={logout} className="flex items-center gap-2 py-2 text-[13px] font-medium text-rose-600 focus:text-rose-600">
              <LogOut className="h-3.5 w-3.5" />退出登录
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </aside>
  )
}
