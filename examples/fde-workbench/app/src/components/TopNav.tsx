import { useEffect, useState } from 'react'
import { useStore } from '@/store/AppContext'
import { cn } from '@/lib/utils'
import { Bot, Bell, ChevronDown, CheckCircle2, LogOut, Menu } from 'lucide-react'
import type { Page } from '@/types'
import { ROLES } from '@/data/mock'
import { NAV_ITEMS, SidebarNav } from '@/components/Sidebar'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'

/** 顶栏页标题 */
export function pageTitle(page: Page): { title: string; sub: string } {
  if (page.name === 'lead') return { title: '线索详情', sub: '客户全景 · 访谈 · 跟进' }
  if (page.name === 'proposal') return { title: '方案详情', sub: '三件套 · 报价 · 版本迭代' }
  const nav = NAV_ITEMS.find(n => n.name === page.name)
  if (nav) return { title: nav.label, sub: nav.sub }
  return { title: 'TiMEM FDE 工作台', sub: '' }
}

/** 通知提醒面板 */
function NotificationSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { reminders, completeReminder, navigate } = useStore()
  const pending = reminders.filter(r => !r.done)
  const done = reminders.filter(r => r.done)

  return (
    <Sheet open={open} onOpenChange={v => !v && onClose()}>
      <SheetContent side="right" className="w-full sm:w-[400px] sm:max-w-[400px] bg-[#f5f6f7] p-0">
        <SheetHeader className="border-b border-slate-200 bg-white px-5 py-4">
          <SheetTitle className="flex items-center gap-2 text-[15px]">
            <Bell className="h-4 w-4 text-[#3370ff]" />提醒与通知
            <span className="tnum rounded-full bg-blue-50 border border-blue-200 px-2 py-0.5 text-[11px] font-medium text-[#3370ff]">{pending.length} 条待处理</span>
          </SheetTitle>
        </SheetHeader>
        <div className="overflow-y-auto p-4 space-y-2.5" style={{ maxHeight: 'calc(100vh - 73px)' }}>
          {pending.length === 0 && (
            <div className="rounded-lg border border-dashed border-slate-300 bg-white py-10 text-center text-sm text-slate-400">提醒都处理完了</div>
          )}
          {pending.map(r => (
            <div key={r.id} className="rounded-lg border border-slate-200 border-l-[3px] border-l-[#3370ff] bg-white p-3.5">
              <div className="flex items-start justify-between gap-2">
                <p className="text-[13px] leading-relaxed text-slate-700">{r.title}</p>
                <span className={cn('tnum shrink-0 rounded border px-1.5 py-0.5 text-[11px] font-medium',
                  r.due === '今天' ? 'border-rose-200 bg-rose-50 text-rose-600' : 'border-amber-200 bg-amber-50 text-amber-700')}>{r.due}</span>
              </div>
              <div className="mt-2.5 flex items-center gap-2">
                {r.leadId && (
                  <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => { onClose(); navigate({ name: 'lead', id: r.leadId! }) }}>
                    查看线索
                  </Button>
                )}
                <Button size="sm" className="h-7 text-xs bg-[#3370ff] hover:bg-[#2952cc]" onClick={() => completeReminder(r.id)}>
                  <CheckCircle2 className="h-3 w-3 mr-1" />完成
                </Button>
                {r.auto && <span className="ml-auto text-[11px] text-slate-400">系统自动创建</span>}
              </div>
            </div>
          ))}
          {done.length > 0 && (
            <>
              <p className="pt-3 text-xs font-medium text-slate-400">已完成</p>
              {done.map(r => (
                <div key={r.id} className="rounded-lg border border-slate-200/60 bg-white shadow-sm/60 p-3.5 opacity-60">
                  <p className="text-[13px] leading-relaxed text-slate-500 line-through">{r.title}</p>
                </div>
              ))}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

/** 顶栏：桌面 + 移动统一（页标题 / 通知 / 数字员工 / 账号）；移动端经汉堡按钮打开左侧抽屉导航 */
export function TopNav() {
  const { page, setChatOpen, knowledge, reminders, role, setRole, logout } = useStore()
  const [notifOpen, setNotifOpen] = useState(false)
  const [navOpen, setNavOpen] = useState(false)
  const pendingCount = knowledge.filter(k => k.status === '待审阅').length
  const reminderCount = reminders.filter(r => !r.done).length
  const { title, sub } = pageTitle(page)

  useEffect(() => {
    const open = () => setNotifOpen(true)
    window.addEventListener('open-notifications', open)
    return () => window.removeEventListener('open-notifications', open)
  }, [])

  return (
    <header className="sticky top-0 z-40 border-b border-slate-200/80 bg-white/90 backdrop-blur">
      <div className="flex h-[60px] items-center gap-3 px-4 md:px-8">
        {/* 移动端：汉堡按钮打开抽屉导航 */}
        <button
          onClick={() => setNavOpen(true)}
          className="flex md:hidden h-9 w-9 items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100 transition-colors"
          aria-label="打开导航"
        >
          <Menu className="h-5 w-5" />
        </button>

        {/* 移动端页标题 */}
        <div className="md:hidden min-w-0 leading-none">
          <h1 className="truncate text-[15px] font-semibold text-slate-900">{title}</h1>
          {sub && <p className="mt-1 truncate text-[11px] text-slate-400">{sub}</p>}
        </div>

        {/* 桌面端页标题 */}
        <div className="hidden md:block min-w-0 leading-none">
          <h1 className="truncate text-[15px] font-semibold text-slate-900">{title}</h1>
          {sub && <p className="mt-1 truncate text-[11px] text-slate-400">{sub}</p>}
        </div>

        <div className="ml-auto flex items-center gap-2 md:gap-2.5 shrink-0">
          <button
            onClick={() => setNotifOpen(true)}
            className="relative flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-[#3370ff] transition-colors"
            aria-label="提醒与通知"
          >
            <Bell className="h-[18px] w-[18px]" />
            {reminderCount > 0 && (
              <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-bold text-white tnum">
                {reminderCount}
              </span>
            )}
          </button>
          <button
            onClick={() => setChatOpen(true)}
            className="relative flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 pl-3 pr-3.5 py-1.5 text-[13px] font-medium text-[#3370ff] hover:bg-blue-100 transition-colors"
          >
            <span className="relative flex h-2 w-2">
              <span className="pulse-dot absolute inline-flex h-full w-full rounded-full bg-[#3370ff]" />
            </span>
            <Bot className="h-4 w-4" />
            <span className="hidden sm:inline">数字员工</span>
            {pendingCount > 0 && (
              <span className="absolute -top-1.5 -right-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-bold text-white">
                {pendingCount}
              </span>
            )}
          </button>

          {/* 账号菜单 */}
          <DropdownMenu>
            <DropdownMenuTrigger className="flex items-center gap-1.5 rounded-lg py-1 pl-1 pr-1.5 hover:bg-slate-100 transition-colors">
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[#3370ff] text-[11px] font-semibold text-white">{role.name[0]}</span>
              <ChevronDown className="h-3 w-3 text-slate-400" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <p className="px-2 py-1.5 text-[11px] text-slate-400">当前：{role.name} · {role.title}</p>
              <p className="px-2 py-1 text-[11px] text-slate-400">切换视角</p>
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
      </div>
      <NotificationSheet open={notifOpen} onClose={() => setNotifOpen(false)} />

      {/* 移动端抽屉导航（与桌面侧边栏同一份导航） */}
      <Sheet open={navOpen} onOpenChange={setNavOpen}>
        <SheetContent side="left" className="w-[284px] p-0 flex flex-col">
          <div className="flex items-center gap-2.5 px-5 pt-6 pb-5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#3370ff] text-[14px] font-bold text-white">忆</div>
            <div className="leading-none">
              <div className="text-[14px] font-bold text-slate-900 tracking-tight">TiMEM FDE 工作台</div>
              <div className="mt-1 text-[10px] text-slate-400 tracking-wide">从线索到交付 · 越用越聪明</div>
            </div>
          </div>
          <SidebarNav onNavigate={() => setNavOpen(false)} />
        </SheetContent>
      </Sheet>
    </header>
  )
}
