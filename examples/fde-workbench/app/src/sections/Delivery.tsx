import { useState } from 'react'
import { useStore } from '@/store/AppContext'
import { cn } from '@/lib/utils'
import type { Delivery, DeliveryStatus } from '@/types'
import { fmtMoney } from '@/types'
import {
  PackageCheck, Flag, Database, Cog, FlaskConical, Rocket, ClipboardCheck,
  CheckCircle2, Circle, PhoneCall, Plus, User, FileText, ChevronRight,
} from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'

const STATUS_CLS: Record<DeliveryStatus, string> = {
  '待启动': 'border-slate-200 bg-slate-50 text-slate-500',
  '交付中': 'border-blue-200 bg-blue-50 text-[#3370ff]',
  '已验收': 'border-emerald-200 bg-emerald-50 text-emerald-600',
  '已回访': 'border-violet-200 bg-violet-50 text-violet-600',
}

const MILESTONE_ICON = [Flag, Database, Cog, FlaskConical, ClipboardCheck]

function milestoneIcon(name: string, idx: number) {
  if (name.includes('启动')) return Flag
  if (name.includes('数据')) return Database
  if (name.includes('联调')) return Cog
  if (name.includes('试运行') || name.includes('培训')) return FlaskConical
  if (name.includes('验收')) return ClipboardCheck
  return MILESTONE_ICON[idx % MILESTONE_ICON.length] ?? Rocket
}

/** 交付管理：签约后的里程碑推进、验收材料与回访续约 */
export function DeliveryPage() {
  const { deliveries, contracts, proposals, modules, completeMilestone, toggleAcceptance, addRevisit, navigate } = useStore()
  const [revisitFor, setRevisitFor] = useState<Delivery | null>(null)
  const [content, setContent] = useState('')
  const [next, setNext] = useState('')

  const contractOf = (id: string) => contracts.find(c => c.id === id)
  /** 交付涉及的模块：合同 → 线索 → 方案组装的模块 */
  const modulesOf = (contractId: string) => {
    const c = contractOf(contractId)
    const p = proposals.find(x => x.leadId === c?.leadId)
    return (p?.modules ?? []).map(id => modules.find(m => m.id === id)).filter(Boolean) as typeof modules
  }
  const progress = (d: Delivery) => Math.round(d.milestones.filter(m => m.status === '已完成').length / d.milestones.length * 100)

  const submitRevisit = () => {
    if (!revisitFor || !content.trim()) return
    addRevisit(revisitFor.id, content.trim(), next.trim() || undefined)
    setRevisitFor(null); setContent(''); setNext('')
  }

  return (
    <div className="space-y-7">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-[18px] font-bold text-slate-900">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-50"><PackageCheck className="h-[18px] w-[18px] text-[#3370ff]" /></span>
            交付管理
          </h2>
          <p className="mt-1.5 text-[12px] text-slate-400">签约后自动生成交付项目 · 里程碑 → 验收材料 → 回访续约</p>
        </div>
        <span className="tnum shrink-0 rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-[12px] font-semibold text-[#3370ff]">
          {deliveries.filter(d => d.status === '交付中').length} 个交付中 · {deliveries.length} 个项目
        </span>
      </div>

      <div className="space-y-4">
        {deliveries.map(d => {
          const c = contractOf(d.contractId)
          const pct = progress(d)
          const acceptanceDone = d.acceptance.filter(a => a.done).length
          return (
            <div key={d.id} className="rounded-2xl border border-slate-200/60 bg-white shadow-sm p-4 md:p-6">
              {/* 头部 */}
              <div className="flex flex-wrap items-center gap-2.5">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-[15px] font-semibold text-slate-900">{d.customer}</h3>
                    <span className={cn('rounded border px-1.5 py-0.5 text-[11px] font-medium', STATUS_CLS[d.status])}>{d.status}</span>
                  </div>
                  <p className="mt-1 text-[12px] text-slate-400">
                    {d.name} · 合同 {c?.code} · 金额 ¥{c ? fmtMoney(c.amount) : '—'} ·
                    <User className="mx-1 inline h-3 w-3" />负责人 {d.owner}
                  </p>
                  {modulesOf(d.contractId).length > 0 && (
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <span className="text-[11px] text-slate-400">组装模块：</span>
                      {modulesOf(d.contractId).map(m => (
                        <span key={m.id} className="rounded-md border border-blue-100 bg-blue-50/70 px-1.5 py-0.5 text-[10px] font-medium text-[#3370ff]">{m.name}</span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  <div className="text-right">
                    <p className="tnum text-[15px] font-bold text-slate-800">{pct}%</p>
                    <p className="text-[10px] text-slate-400">交付进度</p>
                  </div>
                  <div className="h-9 w-24 overflow-hidden rounded-full bg-slate-100">
                    <div className="h-full rounded-full bg-[#3370ff] transition-all" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              </div>

              {/* 里程碑时间线 */}
              <div className="mt-5 flex gap-0 overflow-x-auto pb-1">
                {d.milestones.map((m, i) => {
                  const Icon = milestoneIcon(m.name, i)
                  const doing = m.status === '进行中'
                  return (
                    <div key={m.id} className="relative min-w-[128px] flex-1 pr-3">
                      {i < d.milestones.length - 1 && (
                        <div className={cn('absolute top-[15px] left-8 right-0 h-0.5', m.status === '已完成' ? 'bg-[#3370ff]' : 'bg-slate-200')} />
                      )}
                      <div className={cn('relative flex h-8 w-8 items-center justify-center rounded-full border-2',
                        m.status === '已完成' ? 'border-[#3370ff] bg-[#3370ff] text-white'
                          : doing ? 'border-[#3370ff] bg-white text-[#3370ff]' : 'border-slate-200 bg-white text-slate-300')}>
                        {m.status === '已完成' ? <CheckCircle2 className="h-4 w-4" /> : <Icon className="h-3.5 w-3.5" />}
                      </div>
                      <p className={cn('mt-2 text-[12px] font-medium', m.status === '未开始' ? 'text-slate-400' : 'text-slate-800')}>{m.name}</p>
                      <p className="tnum mt-0.5 text-[10px] text-slate-400">{m.date}</p>
                      {m.note && <p className="mt-1 text-[10px] leading-relaxed text-slate-400 line-clamp-2">{m.note}</p>}
                      {doing && (
                        <Button size="sm" className="mt-2 h-7 bg-[#3370ff] text-xs hover:bg-[#2952cc]" onClick={() => completeMilestone(d.id, m.id)}>
                          标记完成
                        </Button>
                      )}
                    </div>
                  )
                })}
              </div>

              {/* 验收材料 + 回访 */}
              <div className="mt-5 grid gap-4 md:grid-cols-2">
                <div className="rounded-xl border border-slate-100 bg-slate-50/60 p-3.5">
                  <p className="flex items-center gap-1.5 text-[12px] font-semibold text-slate-700">
                    <FileText className="h-3.5 w-3.5 text-slate-400" />验收材料
                    <span className="tnum ml-auto text-[11px] font-medium text-slate-400">{acceptanceDone}/{d.acceptance.length} 已归档</span>
                  </p>
                  <div className="mt-2.5 space-y-1.5">
                    {d.acceptance.map((a, i) => (
                      <button key={i} onClick={() => toggleAcceptance(d.id, i)} className="flex w-full items-center gap-2 text-left">
                        {a.done ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" /> : <Circle className="h-3.5 w-3.5 shrink-0 text-slate-300" />}
                        <span className={cn('text-[12px]', a.done ? 'text-slate-400 line-through' : 'text-slate-600')}>{a.item}</span>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="rounded-xl border border-slate-100 bg-slate-50/60 p-3.5">
                  <p className="flex items-center gap-1.5 text-[12px] font-semibold text-slate-700">
                    <PhoneCall className="h-3.5 w-3.5 text-slate-400" />回访与续约线索
                    <button
                      onClick={() => { setRevisitFor(d); setContent(''); setNext('') }}
                      className="ml-auto flex items-center gap-1 rounded-md border border-blue-200 bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-[#3370ff] hover:bg-blue-100"
                    >
                      <Plus className="h-3 w-3" />登记回访
                    </button>
                  </p>
                  {d.revisits.length === 0 ? (
                    <p className="mt-2.5 text-[12px] text-slate-400">暂无回访记录{d.status === '已验收' ? '，验收后建议 2 周内首次回访' : ''}</p>
                  ) : (
                    <div className="mt-2.5 space-y-2">
                      {d.revisits.map(r => (
                        <div key={r.id} className="rounded-lg border border-violet-100 bg-violet-50/50 p-2.5">
                          <p className="text-[12px] leading-relaxed text-slate-700"><span className="tnum mr-1.5 text-[10px] text-violet-500">{r.date}</span>{r.content}</p>
                          {r.next && (
                            <button onClick={() => navigate({ name: 'leads' })} className="mt-1.5 flex items-center gap-1 text-[11px] font-medium text-[#3370ff] hover:underline">
                              后续机会：{r.next}<ChevronRight className="h-3 w-3" />
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {/* 登记回访 */}
      <Dialog open={!!revisitFor} onOpenChange={v => !v && setRevisitFor(null)}>
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle className="text-[15px]">登记回访 · {revisitFor?.customer}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Textarea value={content} onChange={e => setContent(e.target.value)} placeholder="回访内容：使用情况、客户反馈、新问题…" rows={3} />
            <Input value={next} onChange={e => setNext(e.target.value)} placeholder="后续机会 / 续约线索（可选）" />
            <Button className="w-full bg-[#3370ff] hover:bg-[#2952cc]" onClick={submitRevisit} disabled={!content.trim()}>保存回访记录</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
