import { useState, type ReactNode } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import type { LeadStage } from '@/types'
import { fmtMoney } from '@/types'
import { Check, Pencil, X, Sparkles, ArrowLeft } from 'lucide-react'
import { useStore } from '@/store/AppContext'

export const stageColor: Record<LeadStage, string> = {
  '新线索': 'bg-slate-100 text-slate-600 border-slate-200',
  '已联系': 'bg-sky-50 text-sky-700 border-sky-200',
  '拜访中': 'bg-blue-50 text-blue-700 border-blue-200',
  '方案中': 'bg-indigo-50 text-indigo-700 border-indigo-200',
  '报价中': 'bg-amber-50 text-amber-700 border-amber-200',
  '谈判中': 'bg-orange-50 text-orange-700 border-orange-200',
  '已签约': 'bg-emerald-50 text-emerald-700 border-emerald-200',
  '已交付': 'bg-teal-50 text-teal-700 border-teal-200',
  '已流失': 'bg-rose-50 text-rose-600 border-rose-200',
}

export function StageBadge({ stage, className }: { stage: LeadStage; className?: string }) {
  return (
    <span className={cn('inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium whitespace-nowrap', stageColor[stage], className)}>
      {stage}
    </span>
  )
}

export function Money({ value, className }: { value: number; className?: string }) {
  return <span className={cn('tnum font-semibold', className)}>{fmtMoney(value)}</span>
}

export function PageHeader({ title, desc, actions, back = true }: { title: string; desc?: string; actions?: ReactNode; back?: boolean }) {
  const { navigate } = useStore()
  return (
    <div className="mb-8">
      {back && (
        <button onClick={() => navigate({ name: 'dashboard' })} className="mb-2 flex items-center gap-1 text-[13px] text-slate-400 hover:text-[#3370ff] transition-colors">
          <ArrowLeft className="h-3.5 w-3.5" />返回仪表盘
        </button>
      )}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-bold text-slate-900 tracking-tight">{title}</h1>
          {desc && <p className="text-sm text-slate-500 mt-1">{desc}</p>}
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
    </div>
  )
}

export function EmptyState({ hint, action, onAction }: { hint: string; action?: string; onAction?: () => void }) {
  return (
    <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50/60 py-10 text-center">
      <p className="text-sm text-slate-500">{hint}</p>
      {action && (
        <Button variant="outline" size="sm" className="mt-3" onClick={onAction}>{action}</Button>
      )}
    </div>
  )
}

/** 数字员工产出卡片：左侧蓝色强调边 + 采纳/修改/拒绝 人在回路操作 */
export function AIReviewCard({
  title, basis, body, status, reason, onRespond, footer,
}: {
  title: string
  basis?: string
  body: ReactNode
  status: 'pending' | 'adopted' | 'rejected' | 'modified'
  reason?: string
  onRespond?: (action: 'adopted' | 'rejected' | 'modified', reason?: string) => void
  footer?: ReactNode
}) {
  const [rejectOpen, setRejectOpen] = useState(false)
  const [modifyOpen, setModifyOpen] = useState(false)
  const [text, setText] = useState('')
  const statusMeta = {
    pending: { label: '需要你确认', cls: 'bg-blue-50 text-blue-700 border-blue-200' },
    adopted: { label: '已采纳', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
    modified: { label: '已修改采纳', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
    rejected: { label: '已拒绝', cls: 'bg-rose-50 text-rose-600 border-rose-200' },
  }[status]

  return (
    <div className={cn(
      'rounded-lg border bg-white pl-4 pr-4 py-4 border-l-[3px]',
      status === 'pending' ? 'border-l-[#3370ff] border-slate-200' :
      status === 'rejected' ? 'border-l-rose-400 border-slate-200' : 'border-l-emerald-500 border-slate-200'
    )}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className="relative flex h-2 w-2 shrink-0">
            <span className={cn('absolute inline-flex h-full w-full rounded-full', status === 'pending' ? 'bg-[#3370ff] pulse-dot' : status === 'rejected' ? 'bg-rose-400' : 'bg-emerald-500')} />
          </span>
          <Sparkles className="h-3.5 w-3.5 text-[#3370ff] shrink-0" />
          <span className="text-sm font-semibold text-slate-800 truncate">{title}</span>
        </div>
        <span className={cn('inline-flex shrink-0 items-center rounded-md border px-2 py-0.5 text-xs font-medium', statusMeta.cls)}>{statusMeta.label}</span>
      </div>
      <div className="mt-2 text-sm leading-relaxed text-slate-700">{body}</div>
      {basis && <p className="mt-2 text-xs text-slate-400">{basis}</p>}
      {reason && status === 'rejected' && <p className="mt-2 text-xs text-rose-500">拒绝原因：{reason}</p>}
      {footer}
      {status === 'pending' && onRespond && (
        <div className="mt-3 flex items-center gap-2">
          <Button size="sm" className="h-7 text-xs bg-[#3370ff] hover:bg-[#2952cc]" onClick={() => onRespond('adopted')}>
            <Check className="h-3 w-3 mr-1" />采纳
          </Button>
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => { setText(''); setModifyOpen(true) }}>
            <Pencil className="h-3 w-3 mr-1" />修改
          </Button>
          <Button size="sm" variant="ghost" className="h-7 text-xs text-slate-500 hover:text-rose-600" onClick={() => { setText(''); setRejectOpen(true) }}>
            <X className="h-3 w-3 mr-1" />拒绝
          </Button>
        </div>
      )}

      <Dialog open={rejectOpen} onOpenChange={setRejectOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>拒绝这条建议</DialogTitle>
            <DialogDescription>填写拒绝原因，将回流沉淀用于改进后续推荐。</DialogDescription>
          </DialogHeader>
          <Textarea value={text} onChange={e => setText(e.target.value)} placeholder="例如：客户已明确表示本周无时间接待…" rows={3} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectOpen(false)}>取消</Button>
            <Button variant="destructive" disabled={!text.trim()} onClick={() => { onRespond?.('rejected', text.trim()); setRejectOpen(false) }}>确认拒绝</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={modifyOpen} onOpenChange={setModifyOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>修改后采纳</DialogTitle>
            <DialogDescription>写下你的修改意见，系统将按修改后版本执行并沉淀差异。</DialogDescription>
          </DialogHeader>
          <Textarea value={text} onChange={e => setText(e.target.value)} placeholder="例如：把拜访时间改到下周三，先送参数比对材料…" rows={3} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setModifyOpen(false)}>取消</Button>
            <Button className="bg-[#3370ff] hover:bg-[#2952cc]" disabled={!text.trim()} onClick={() => { onRespond?.('modified', text.trim()); setModifyOpen(false) }}>修改并采纳</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export function StatBadge({ children, tone = 'blue' }: { children: ReactNode; tone?: 'blue' | 'green' | 'amber' | 'slate' }) {
  const cls = {
    blue: 'bg-blue-50 text-blue-700 border-blue-200',
    green: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    amber: 'bg-amber-50 text-amber-700 border-amber-200',
    slate: 'bg-slate-100 text-slate-600 border-slate-200',
  }[tone]
  return <Badge variant="outline" className={cn('font-normal', cls)}>{children}</Badge>
}
