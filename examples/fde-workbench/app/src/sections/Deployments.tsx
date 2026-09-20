import { useState } from 'react'
import { useStore } from '@/store/AppContext'
import { cn } from '@/lib/utils'
import type { Deployment } from '@/types'
import {
  Globe, GitBranch, Rocket, ChevronDown, ChevronRight, Plus, History,
  TriangleAlert, Radar, Package, Boxes, ExternalLink,
} from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'

const ENV_CLS: Record<Deployment['env'], string> = {
  '演示': 'border-blue-200 bg-blue-50 text-[#3370ff]',
  '试用': 'border-amber-200 bg-amber-50 text-amber-700',
  '正式': 'border-emerald-200 bg-emerald-50 text-emerald-600',
}

/** 兼容 'YYYY-MM-DD' 与 'MM-DD'（新登记条目）两种格式 */
const parseDay = (date: string) => new Date(/^\d{2}-\d{2}$/.test(date) ? `2026-${date}` : date).getTime()
const daysUntil = (date: string) => Math.ceil((parseDay(date) - Date.now()) / 86400000)
const daysSince = (date: string) => Math.floor((Date.now() - parseDay(date)) / 86400000)

/** 部署台账：方案演示站/正式站的域名、仓库与版本日志，主动预警与半成品沉淀 */
export function Deployments() {
  const { deployments, modules, addVersionLog, addReminder, depositModule, navigate } = useStore()
  const [openId, setOpenId] = useState<string | null>(null)
  const [logFor, setLogFor] = useState<Deployment | null>(null)
  const [version, setVersion] = useState('')
  const [note, setNote] = useState('')
  const [depFor, setDepFor] = useState<Deployment | null>(null)
  const [depName, setDepName] = useState('')
  const [depDesc, setDepDesc] = useState('')
  const [reminded, setReminded] = useState<string[]>([])

  const moduleName = (id: string) => modules.find(m => m.id === id)?.name ?? id

  /** 主动性：域名到期 / 版本陈旧 预警 */
  const alerts = deployments.flatMap(d => {
    const list: { key: string; level: 'warn' | 'info'; text: string; leadId?: string }[] = []
    const left = daysUntil(d.domainExpire)
    if (d.status === '运行中' && left <= 30 && left >= 0) {
      list.push({ key: `${d.id}-domain`, level: 'warn', text: `域名 ${d.domain} 还有 ${left} 天到期（${d.domainExpire}），影响「${d.customer}」${d.env}站访问`, leadId: d.leadId })
    }
    const stale = daysSince(d.updatedAt)
    if (d.status === '运行中' && d.env !== '正式' && stale >= 14) {
      list.push({ key: `${d.id}-stale`, level: 'info', text: `「${d.site}」已 ${stale} 天未更新，建议主动联系客户同步最新能力或收集反馈`, leadId: d.leadId })
    }
    return list
  })

  const submitLog = () => {
    if (!logFor || !version.trim() || !note.trim()) return
    addVersionLog(logFor.id, version.trim(), note.trim())
    setLogFor(null); setVersion(''); setNote('')
  }

  const submitDeposit = () => {
    if (!depFor || !depName.trim() || !depDesc.trim()) return
    depositModule(depFor.id, depName.trim(), depDesc.trim())
    setDepFor(null); setDepName(''); setDepDesc('')
  }

  return (
    <div className="space-y-7">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-[18px] font-bold text-slate-900">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-50"><Rocket className="h-[18px] w-[18px] text-[#3370ff]" /></span>
            部署台账
          </h2>
          <p className="mt-1.5 text-[12px] text-slate-400">现场/回来方案后部署的站点全在这里 · 域名 + 仓库 + 版本日志 · 优势来自记忆规则知识沉淀</p>
        </div>
        <span className="tnum rounded-full border border-slate-200 bg-white px-3 py-1 text-[12px] text-slate-500">
          运行中 {deployments.filter(d => d.status === '运行中').length} · 演示 {deployments.filter(d => d.env === '演示').length} · 试用 {deployments.filter(d => d.env === '试用').length} · 正式 {deployments.filter(d => d.env === '正式').length}
        </span>
      </div>

      {/* 主动预警 */}
      {alerts.length > 0 && (
        <div className="rounded-2xl border border-amber-200/70 bg-amber-50/50 shadow-sm p-5">
          <p className="flex items-center gap-2 text-[13px] font-semibold text-amber-800">
            <Radar className="h-4 w-4" />主动提醒 · 数字员工巡检发现 {alerts.length} 项
          </p>
          <div className="mt-3 space-y-2">
            {alerts.map(a => (
              <div key={a.key} className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-100 bg-white px-4 py-3">
                <TriangleAlert className={cn('h-4 w-4 shrink-0', a.level === 'warn' ? 'text-amber-500' : 'text-sky-500')} />
                <p className="min-w-0 flex-1 text-[13px] leading-snug text-slate-700">{a.text}</p>
                {reminded.includes(a.key) ? (
                  <span className="text-[11px] text-emerald-600">已转提醒</span>
                ) : (
                  <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => { addReminder(a.text, '今天', a.leadId); setReminded(prev => [...prev, a.key]) }}>
                    转为跟进提醒
                  </Button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 台账卡片 */}
      <div className="space-y-5">
        {deployments.map(d => {
          const open = openId === d.id
          const left = daysUntil(d.domainExpire)
          return (
            <div key={d.id} className="rounded-2xl border border-slate-200/60 bg-white shadow-sm p-6">
              <div className="flex flex-wrap items-center gap-2.5">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-[15px] font-semibold text-slate-900">{d.site}</h3>
                    <span className={cn('rounded border px-1.5 py-0.5 text-[11px] font-medium', ENV_CLS[d.env])}>{d.env}</span>
                    <span className={cn('rounded border px-1.5 py-0.5 text-[11px] font-medium',
                      d.status === '运行中' ? 'border-emerald-200 bg-emerald-50 text-emerald-600' : 'border-slate-200 bg-slate-50 text-slate-400')}>{d.status}</span>
                  </div>
                  {d.leadId ? (
                    <button onClick={() => navigate({ name: 'lead', id: d.leadId! })} className="mt-1 flex items-center gap-1 text-[12px] text-slate-400 hover:text-[#3370ff]">
                      {d.customer}<ChevronRight className="h-3 w-3" />
                    </button>
                  ) : (
                    <p className="mt-1 flex items-center gap-1 text-[12px] text-slate-400">{d.customer}</p>
                  )}
                </div>
                <span className="tnum rounded-lg bg-slate-900 px-2.5 py-1 text-[12px] font-bold text-white">{d.currentVersion}</span>
              </div>

              {/* 域名 / 仓库 / 模块 */}
              <div className="mt-4 grid gap-3 md:grid-cols-2">
                <div className="rounded-xl border border-slate-100 bg-slate-50/60 px-4 py-3">
                  <p className="flex items-center gap-1.5 text-[11px] text-slate-400"><Globe className="h-3 w-3" />域名</p>
                  <p className="tnum mt-1 flex items-center gap-1.5 text-[13px] font-medium text-slate-800">
                    {d.domain}<ExternalLink className="h-3 w-3 text-slate-300" />
                  </p>
                  <p className={cn('tnum mt-1 text-[11px]', left <= 30 ? 'font-medium text-amber-600' : 'text-slate-400')}>
                    到期 {d.domainExpire}{left <= 30 && left >= 0 ? `（剩 ${left} 天）` : ''}
                  </p>
                </div>
                <div className="rounded-xl border border-slate-100 bg-slate-50/60 px-4 py-3">
                  <p className="flex items-center gap-1.5 text-[11px] text-slate-400"><GitBranch className="h-3 w-3" />代码仓库</p>
                  <p className="tnum mt-1 text-[13px] font-medium text-slate-800">{d.repo}</p>
                  <p className="mt-1 text-[11px] text-slate-400">{d.platform === 'gitea' ? 'Gitea 私有仓 · 内网' : 'GitHub · 组织私有仓'}</p>
                </div>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] text-slate-400">组装模块：</span>
                {d.modules.map(id => (
                  <button key={id} onClick={() => navigate({ name: 'modules' })}
                    className="rounded-md border border-blue-100 bg-blue-50/70 px-1.5 py-0.5 text-[10px] font-medium text-[#3370ff] hover:bg-blue-100">
                    {moduleName(id)}
                  </button>
                ))}
                <span className="tnum ml-auto text-[11px] text-slate-400">最近更新 {d.updatedAt}</span>
              </div>

              {/* 操作行 */}
              <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-4">
                <button onClick={() => setOpenId(open ? null : d.id)}
                  className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-[12px] font-medium text-slate-600 hover:border-[#3370ff] hover:text-[#3370ff] transition-colors">
                  <History className="h-3.5 w-3.5" />版本日志（{d.logs.length}）
                  <ChevronDown className={cn('h-3 w-3 transition-transform', open && 'rotate-180')} />
                </button>
                <button onClick={() => { setLogFor(d); setVersion(''); setNote('') }}
                  className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-[12px] font-medium text-slate-600 hover:border-[#3370ff] hover:text-[#3370ff] transition-colors">
                  <Plus className="h-3.5 w-3.5" />登记版本更新
                </button>
                <button onClick={() => { setDepFor(d); setDepName(''); setDepDesc('') }}
                  className="flex items-center gap-1.5 rounded-lg border border-dashed border-violet-300 bg-violet-50/50 px-3 py-1.5 text-[12px] font-medium text-violet-600 hover:bg-violet-50 transition-colors">
                  <Boxes className="h-3.5 w-3.5" />沉淀为半成品模块
                </button>
              </div>

              {/* 版本日志时间线 */}
              {open && (
                <div className="mt-4 rounded-xl border border-slate-100 bg-slate-50/40 p-4">
                  <div className="space-y-0">
                    {d.logs.map((l, i) => (
                      <div key={l.version} className="relative flex gap-3.5 pb-5 last:pb-0">
                        {i < d.logs.length - 1 && <div className="absolute left-[15px] top-8 bottom-0 w-px bg-slate-200" />}
                        <span className={cn('tnum relative flex h-8 w-14 shrink-0 items-center justify-center rounded-lg text-[11px] font-bold',
                          i === 0 ? 'bg-[#3370ff] text-white' : 'bg-white border border-slate-200 text-slate-500')}>{l.version}</span>
                        <div className="min-w-0">
                          <p className="text-[13px] leading-snug text-slate-700">{l.note}</p>
                          <p className="tnum mt-1 text-[11px] text-slate-400">{l.date} · {l.by}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* 登记版本更新 */}
      <Dialog open={!!logFor} onOpenChange={v => !v && setLogFor(null)}>
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle className="text-[15px]">登记版本更新 · {logFor?.site}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Input value={version} onChange={e => setVersion(e.target.value)} placeholder={`版本号，如 ${bump(logFor?.currentVersion)}`} />
            <Textarea value={note} onChange={e => setNote(e.target.value)} rows={3} placeholder="本次更新内容：新功能 / 规则库更新 / 应甲方反馈的修改…" />
            <Button className="w-full bg-[#3370ff] hover:bg-[#2952cc]" onClick={submitLog} disabled={!version.trim() || !note.trim()}>登记到版本日志</Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 沉淀为半成品模块 */}
      <Dialog open={!!depFor} onOpenChange={v => !v && setDepFor(null)}>
        <DialogContent className="sm:max-w-[460px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-[15px]">
              <Package className="h-4 w-4 text-violet-500" />沉淀为半成品模块 · {depFor?.site}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="rounded-lg bg-violet-50/60 border border-violet-100 px-3 py-2 text-[12px] leading-relaxed text-slate-600">
              把这个站点里验证过的能力沉淀成内部半成品，进产品模块库，后续项目方案可直接积木式组装。
            </p>
            <Input value={depName} onChange={e => setDepName(e.target.value)} placeholder="模块名称，如：处置留痕审计面板" />
            <Textarea value={depDesc} onChange={e => setDepDesc(e.target.value)} rows={3} placeholder="这个能力解决什么问题、在哪个版本验证过" />
            <Button className="w-full bg-[#3370ff] hover:bg-[#2952cc]" onClick={submitDeposit} disabled={!depName.trim() || !depDesc.trim()}>
              沉淀入库（成熟度：沉淀中）
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function bump(v?: string) {
  if (!v) return 'v1.1'
  const m = v.match(/^v(\d+)\.(\d+)$/)
  return m ? `v${m[1]}.${Number(m[2]) + 1}` : 'v1.1'
}
