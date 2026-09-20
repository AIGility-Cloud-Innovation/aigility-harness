import { useMemo, useState } from 'react'
import { useStore } from '@/store/AppContext'
import { cn } from '@/lib/utils'
import type { Activity } from '@/types'
import { Input } from '@/components/ui/input'
import { ScrollText, Search, ChevronRight } from 'lucide-react'

const MODULE_META: Record<Activity['page'], { label: string; cls: string }> = {
  lead: { label: '线索', cls: 'border-blue-200 bg-blue-50 text-[#3370ff]' },
  proposal: { label: '方案', cls: 'border-violet-200 bg-violet-50 text-violet-600' },
  contracts: { label: '合同/续费', cls: 'border-emerald-200 bg-emerald-50 text-emerald-600' },
  deployments: { label: '部署台账', cls: 'border-sky-200 bg-sky-50 text-sky-600' },
  channels: { label: '渠道伙伴', cls: 'border-amber-200 bg-amber-50 text-amber-700' },
  performance: { label: '绩效提成', cls: 'border-rose-200 bg-rose-50 text-rose-600' },
  import: { label: '数据导入', cls: 'border-indigo-200 bg-indigo-50 text-indigo-600' },
  ontology: { label: '企业本体', cls: 'border-cyan-200 bg-cyan-50 text-cyan-600' },
  system: { label: '系统', cls: 'border-slate-200 bg-slate-50 text-slate-500' },
}

/** 审计日志：每个模块的每次改动都留痕，可按模块/关键词追溯 */
export function Audit() {
  const { activities, navigate } = useStore()
  const [mod, setMod] = useState<Activity['page'] | 'all'>('all')
  const [kw, setKw] = useState('')

  const filtered = useMemo(() => activities.filter(a =>
    (mod === 'all' || a.page === mod) && (!kw.trim() || a.text.includes(kw.trim()) || a.source.includes(kw.trim())),
  ), [activities, mod, kw])

  const today = new Date()
  const todayTag = `${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  const todayCount = activities.filter(a => a.time.startsWith(todayTag)).length
  const modsUsed = [...new Set(activities.map(a => a.page))]

  const go = (a: Activity) => {
    if (a.page === 'lead' && a.refId) navigate({ name: 'lead', id: a.refId })
    else if (a.page === 'proposal' && a.refId) navigate({ name: 'proposal', id: a.refId })
    else if (a.page === 'deployments') navigate({ name: 'deployments' })
    else if (a.page === 'contracts') navigate({ name: 'contracts' })
    else if (a.page === 'channels') navigate({ name: 'channels' })
    else if (a.page === 'performance') navigate({ name: 'performance' })
    else if (a.page === 'import') navigate({ name: 'import' })
    else if (a.page === 'ontology') navigate({ name: 'ontology' })
  }

  return (
    <div className="space-y-7">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-[18px] font-bold text-slate-900">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-50"><ScrollText className="h-[18px] w-[18px] text-[#3370ff]" /></span>
            审计日志
          </h2>
          <p className="mt-1.5 text-[12px] text-slate-400">线索 / 方案 / 合同 / 部署 / 渠道 / 绩效 / 导入 —— 每个模块的每次改动都有时间、操作人与出处</p>
        </div>
        <span className="tnum rounded-full border border-slate-200 bg-white px-3 py-1 text-[12px] text-slate-500">
          共 {activities.length} 条 · 今日 {todayCount} 条 · 覆盖 {modsUsed.length} 个模块
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => setMod('all')}
          className={cn('rounded-full border px-3 py-1 text-[12px] font-medium transition-colors',
            mod === 'all' ? 'border-[#3370ff] bg-[#3370ff] text-white' : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300')}
        >全部</button>
        {(Object.keys(MODULE_META) as Activity['page'][]).map(k => (
          <button
            key={k}
            onClick={() => setMod(k)}
            className={cn('rounded-full border px-3 py-1 text-[12px] font-medium transition-colors',
              mod === k ? 'border-[#3370ff] bg-[#3370ff] text-white' : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300')}
          >{MODULE_META[k].label}</button>
        ))}
        <div className="relative ml-auto">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
          <Input value={kw} onChange={e => setKw(e.target.value)} placeholder="搜索内容 / 操作人" className="h-8 w-48 pl-8 text-[12px]" />
        </div>
      </div>

      <div className="rounded-2xl border border-slate-200/60 bg-white shadow-sm p-5">
        {filtered.length === 0 ? (
          <p className="py-10 text-center text-[13px] text-slate-400">没有匹配的日志</p>
        ) : (
          <div className="space-y-1.5">
            {filtered.map(a => (
              <button
                key={a.id}
                onClick={() => go(a)}
                className="group flex w-full items-center gap-3 rounded-xl border border-transparent px-3 py-2.5 text-left transition-colors hover:border-[#3370ff]/30 hover:bg-blue-50/40"
              >
                <span className="tnum w-24 shrink-0 text-[11px] text-slate-400">{a.time}</span>
                <span className={cn('shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium', MODULE_META[a.page].cls)}>{MODULE_META[a.page].label}</span>
                <span className="min-w-0 flex-1 truncate text-[13px] text-slate-700">{a.text}</span>
                <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">{a.source}</span>
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-slate-300 transition-transform group-hover:translate-x-0.5 group-hover:text-[#3370ff]" />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
