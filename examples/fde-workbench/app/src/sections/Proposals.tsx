import { useMemo, useState } from 'react'
import { useStore } from '@/store/AppContext'
import { Money, PageHeader, EmptyState } from '@/components/bits'
import { FileStack, ChevronRight, LayoutList, FolderTree, Sparkles, BrainCircuit } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Proposal } from '@/types'

/** 行业 → 知识库自动关联关键词 */
const INDUSTRY_TAGS: Record<string, string[]> = {
  '石油化工': ['化工', '工业', '报警降噪', '流程工业'],
  '能源电力': ['电力', '能源', '央企', '工业'],
  '电信运营商': ['渠道', '工业', '跟进节奏'],
  '医疗器械': ['医疗', '合规', '法务'],
  '家装服务': ['家装', '施工'],
  '教育政务': ['政府', '教育', '拜访节奏'],
}

export function Proposals() {
  const { proposals, leads, knowledge, navigate } = useStore()
  const [view, setView] = useState<'list' | 'industry'>('industry')

  const groups = useMemo(() => {
    const map = new Map<string, Proposal[]>()
    for (const p of proposals) {
      const lead = leads.find(l => l.id === p.leadId)
      const ind = lead?.industry ?? '其他'
      if (!map.has(ind)) map.set(ind, [])
      map.get(ind)!.push(p)
    }
    return [...map.entries()]
      .map(([industry, list]) => {
        const keys = INDUSTRY_TAGS[industry] ?? [industry]
        const related = knowledge.filter(k =>
          k.tags.some(t => keys.some(kw => t.includes(kw))) ||
          keys.some(kw => k.title.includes(kw) || k.content.includes(kw))
        )
        return {
          industry,
          list: [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
          customerCount: new Set(list.map(p => p.leadId)).size,
          total: list.reduce((s, p) => s + p.total, 0),
          related,
        }
      })
      .sort((a, b) => b.list.length - a.list.length || b.total - a.total)
  }, [proposals, leads, knowledge])

  const renderRow = (p: Proposal) => {
    const lead = leads.find(l => l.id === p.leadId)
    const pendingFb = p.feedbacks.filter(f => f.status === '待处理').length
    return (
      <button key={p.id} onClick={() => navigate({ name: 'proposal', id: p.id })}
        className="group flex w-full flex-wrap items-center gap-3 sm:gap-4 rounded-xl border border-slate-200/60 bg-white shadow-sm px-4 sm:px-5 py-4 text-left transition-all hover:border-[#3370ff]/50 hover:shadow-sm">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-blue-50">
          <FileStack className="h-5 w-5 text-[#3370ff]" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2.5">
            <span className="truncate text-[15px] font-semibold text-slate-900">{p.title}</span>
            <span className={cn('shrink-0 rounded border px-1.5 py-0.5 text-[11px] font-medium',
              p.status === '已确认' ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-amber-200 bg-amber-50 text-amber-700')}>
              {p.status}
            </span>
            <span className="shrink-0 rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[11px] text-slate-500 tnum">v{p.version}</span>
            {pendingFb > 0 && (
              <span className="shrink-0 rounded border border-orange-200 bg-orange-50 px-1.5 py-0.5 text-[11px] font-medium text-orange-600 tnum">{pendingFb} 条意见待响应</span>
            )}
          </div>
          <p className="mt-1 text-xs text-slate-400">
            客户：{lead?.name ?? '—'} · 生成于 {p.createdAt} · 甲方反馈 {p.feedbacks.length} 条 · 引用素材 {p.materials.length} 项
          </p>
        </div>
        <div className="text-right shrink-0">
          <Money value={p.total} className="text-lg text-slate-900" />
          <p className="text-xs text-slate-400">报价总额</p>
        </div>
        <ChevronRight className="hidden sm:block h-4 w-4 shrink-0 text-slate-300 transition-transform group-hover:translate-x-0.5 group-hover:text-[#3370ff]" />
      </button>
    )
  }

  return (
    <div>
      <PageHeader
        title="方案生成"
        desc="一键生成方案 PPT / 解决方案 Word / 报价 Excel · 过往方案按行业自动关联整理"
        actions={
          <div className="flex rounded-lg border border-slate-200/60 bg-white shadow-sm p-0.5">
            <button onClick={() => setView('industry')} className={cn('flex items-center gap-1 rounded-md px-3 py-1.5 text-xs font-medium', view === 'industry' ? 'bg-[#3370ff] text-white' : 'text-slate-500')}>
              <FolderTree className="h-3.5 w-3.5" />按行业
            </button>
            <button onClick={() => setView('list')} className={cn('flex items-center gap-1 rounded-md px-3 py-1.5 text-xs font-medium', view === 'list' ? 'bg-[#3370ff] text-white' : 'text-slate-500')}>
              <LayoutList className="h-3.5 w-3.5" />全部
            </button>
          </div>
        }
      />

      {proposals.length === 0 ? (
        <EmptyState hint="还没有方案，从线索详情页发起「一键生成三件套」" action="去线索管理" onAction={() => navigate({ name: 'leads' })} />
      ) : view === 'list' ? (
        <div className="space-y-3">{proposals.map(renderRow)}</div>
      ) : (
        <div className="space-y-7">
          <p className="flex items-center gap-1.5 text-xs text-slate-400">
            <Sparkles className="h-3.5 w-3.5 text-[#3370ff]" />
            系统按客户所属行业自动归集过往方案，并关联同行业的案例、规则与模板，服务下一个客户时直接复用
          </p>
          {groups.map(g => (
            <div key={g.industry} className="rounded-2xl border border-slate-200/60 bg-white shadow-sm p-4 sm:p-5">
              <div className="flex flex-wrap items-center gap-2.5">
                <h2 className="text-[15px] font-bold text-slate-900">{g.industry}</h2>
                <span className="tnum rounded-full bg-blue-50 border border-blue-200 px-2 py-0.5 text-[11px] font-medium text-[#3370ff]">{g.list.length} 份方案 · {g.customerCount} 家客户</span>
                <span className="tnum text-xs text-slate-400">累计报价 <Money value={g.total} className="text-xs text-slate-600" /></span>
                <button onClick={() => navigate({ name: 'knowledge' })} className="ml-auto flex items-center gap-1 text-xs font-medium text-[#3370ff] hover:underline">
                  <BrainCircuit className="h-3.5 w-3.5" />行业知识库
                </button>
              </div>

              {/* 自动关联的行业资产 */}
              {g.related.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {g.related.slice(0, 5).map(k => (
                    <button key={k.id} onClick={() => navigate({ name: 'knowledge' })}
                      className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] text-slate-600 transition-colors hover:border-[#3370ff] hover:text-[#3370ff]">
                      {k.title}
                    </button>
                  ))}
                  {g.related.length > 5 && <span className="px-1.5 py-1 text-[11px] text-slate-400">+{g.related.length - 5} 条</span>}
                </div>
              )}

              <div className="mt-3.5 space-y-2.5">
                {g.list.map(renderRow)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
