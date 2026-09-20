import { useMemo, useState } from 'react'
import { useStore } from '@/store/AppContext'
import { StageBadge, PageHeader, EmptyState } from '@/components/bits'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { STAGE_ORDER, type LeadSource, type LeadScale } from '@/types'
import { Plus, ArrowUpDown } from 'lucide-react'
import { cn } from '@/lib/utils'

const SOURCES: LeadSource[] = ['转介绍', '微信', '电话', '官网', '会议', '其他']

export function Leads() {
  const { scopedLeads, navigate, addLead, page, role } = useStore()
  const stageFilter = page.name === 'leads' ? page.stage : undefined
  const [stage, setStage] = useState<string>(stageFilter ?? '全部')
  const [source, setSource] = useState<string>('全部')
  const [sortDesc, setSortDesc] = useState(true)
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({ name: '', industry: '', scale: '中小' as LeadScale, source: '电话' as LeadSource, referrer: '', background: '', reminderDays: 1 })

  const filtered = useMemo(() => {
    let list = scopedLeads
    if (stage !== '全部') list = list.filter(l => l.stage === stage)
    if (source !== '全部') list = list.filter(l => l.source === source)
    return [...list].sort((a, b) => sortDesc ? b.lastTouchAt.localeCompare(a.lastTouchAt) : a.lastTouchAt.localeCompare(b.lastTouchAt))
  }, [scopedLeads, stage, source, sortDesc])

  const submit = () => {
    if (!form.name.trim()) return
    const id = addLead({
      name: form.name.trim(), industry: form.industry || '其他', scale: form.scale,
      source: form.source, referrer: form.referrer || '—', background: form.background,
      reminderDays: form.reminderDays,
    })
    setOpen(false)
    setForm({ name: '', industry: '', scale: '中小', source: '电话', referrer: '', background: '', reminderDays: 1 })
    navigate({ name: 'lead', id })
  }

  const stageCounts = useMemo(() => {
    const m = new Map<string, number>()
    scopedLeads.forEach(l => m.set(l.stage, (m.get(l.stage) ?? 0) + 1))
    return m
  }, [scopedLeads])

  return (
    <div>
      <PageHeader
        title="线索管理"
        desc="阶段只能顺序推进或标记流失；流失原因自动沉淀为候选规则"
        actions={<Button className="bg-[#3370ff] hover:bg-[#2952cc]" onClick={() => setOpen(true)}><Plus className="h-4 w-4 mr-1.5" />录入线索</Button>}
      />

      {/* 角色视野提示 */}
      {role.scope !== 'all' && (
        <div className="mb-4 rounded-lg border border-blue-200 bg-blue-50/70 px-4 py-2.5 text-[13px] text-[#3370ff]">
          当前视角：{role.name}（{role.title}）· 仅显示你{role.scope === 'team' ? '负责行业及' : ''}参与的 {scopedLeads.length} 条线索
        </div>
      )}

      {/* 阶段筛选 */}
      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        {['全部', ...STAGE_ORDER, '已流失'].map(s => (
          <button key={s} onClick={() => setStage(s)}
            className={cn(
              'rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
              stage === s ? 'border-[#3370ff] bg-[#3370ff] text-white' : 'border-slate-200 bg-white text-slate-600 hover:border-[#3370ff]/50 hover:text-[#3370ff]'
            )}>
            {s}
            <span className="tnum ml-1.5 opacity-70">{s === '全部' ? scopedLeads.length : (stageCounts.get(s as any) ?? 0)}</span>
          </button>
        ))}
        <div className="ml-auto flex items-center gap-2">
          <Select value={source} onValueChange={setSource}>
            <SelectTrigger className="h-8 w-[110px] text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              {['全部', ...SOURCES].map(s => <SelectItem key={s} value={s}>{s === '全部' ? '全部来源' : s}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => setSortDesc(v => !v)}>
            <ArrowUpDown className="h-3 w-3 mr-1" />按触点时间{sortDesc ? '↓' : '↑'}
          </Button>
        </div>
      </div>

      {/* 列表：桌面表格 */}
      {filtered.length === 0 ? (
        <EmptyState hint="当前筛选条件下暂无线索" action="录入第一条线索" onAction={() => setOpen(true)} />
      ) : (
        <>
        {/* 移动端卡片 */}
        <div className="space-y-3 md:hidden">
          {filtered.map(l => (
            <button key={l.id} onClick={() => navigate({ name: 'lead', id: l.id })}
              className="w-full rounded-xl border border-slate-200/60 bg-white shadow-sm p-4 text-left active:bg-blue-50/40">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-[15px] font-semibold text-slate-900 leading-snug">{l.name}</p>
                  <p className="mt-1 text-xs text-slate-500">{l.industry} · {l.scale} · {l.source}{l.referrer !== '—' && ` · ${l.referrer}`}</p>
                </div>
                <StageBadge stage={l.stage} />
              </div>
              <p className="mt-2.5 line-clamp-2 rounded-md bg-blue-50/70 px-2.5 py-1.5 text-xs leading-relaxed text-slate-600">
                <span className="font-medium text-[#3370ff]">下一步：</span>{l.suggestion.text}
              </p>
              <div className="tnum mt-2.5 flex items-center justify-between text-xs text-slate-400">
                <span>{l.owner}</span>
                <span>最近触点 {l.lastTouchAt}</span>
              </div>
            </button>
          ))}
        </div>
        {/* 桌面端表格 */}
        <div className="hidden md:block overflow-hidden rounded-xl border border-slate-200/60 bg-white shadow-sm">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/80 text-left text-xs text-slate-500">
                <th className="px-4 py-3 font-medium">客户</th>
                <th className="px-3 py-3 font-medium">行业 / 规模</th>
                <th className="px-3 py-3 font-medium">来源</th>
                <th className="px-3 py-3 font-medium">介绍人</th>
                <th className="px-3 py-3 font-medium">阶段</th>
                <th className="px-3 py-3 font-medium">下一步建议</th>
                <th className="px-3 py-3 font-medium">负责人</th>
                <th className="px-3 py-3 font-medium text-right">最近触点</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(l => (
                <tr key={l.id} onClick={() => navigate({ name: 'lead', id: l.id })}
                  className="cursor-pointer border-b border-slate-100 transition-colors last:border-0 hover:bg-blue-50/40">
                  <td className="px-4 py-3.5 font-medium text-slate-900">{l.name}</td>
                  <td className="px-3 py-3.5 text-slate-600">{l.industry} · {l.scale}</td>
                  <td className="px-3 py-3.5 text-slate-600">{l.source}</td>
                  <td className="px-3 py-3.5 text-slate-600">{l.referrer}</td>
                  <td className="px-3 py-3.5"><StageBadge stage={l.stage} /></td>
                  <td className="max-w-[220px] px-3 py-3.5">
                    <span className="block truncate text-slate-500" title={l.suggestion.text}>{l.suggestion.text}</span>
                  </td>
                  <td className="px-3 py-3.5 text-slate-600">{l.owner}</td>
                  <td className="tnum px-3 py-3.5 text-right text-slate-500">{l.lastTouchAt}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        </>
      )}

      {/* 录入线索 */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader><DialogTitle>录入新线索</DialogTitle></DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className="mb-1 block text-xs text-slate-500">客户名称 *</label>
              <Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="例如：某化工集团" />
            </div>
            <div>
              <label className="mb-1 block text-xs text-slate-500">行业</label>
              <Input value={form.industry} onChange={e => setForm(f => ({ ...f, industry: e.target.value }))} placeholder="石油化工 / 医疗…" />
            </div>
            <div>
              <label className="mb-1 block text-xs text-slate-500">企业规模</label>
              <Select value={form.scale} onValueChange={v => setForm(f => ({ ...f, scale: v as LeadScale }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{(['央企', '上市', '中小', '政府'] as LeadScale[]).map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div>
              <label className="mb-1 block text-xs text-slate-500">线索来源</label>
              <Select value={form.source} onValueChange={v => setForm(f => ({ ...f, source: v as LeadSource }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{SOURCES.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div>
              <label className="mb-1 block text-xs text-slate-500">{form.source === '转介绍' ? '介绍人' : '联系方式/备注人'}</label>
              <Input value={form.referrer} onChange={e => setForm(f => ({ ...f, referrer: e.target.value }))} placeholder="选填" />
            </div>
            <div className="col-span-2">
              <label className="mb-1 block text-xs text-slate-500">登记后自动提醒</label>
              <Select value={String(form.reminderDays)} onValueChange={v => setForm(f => ({ ...f, reminderDays: Number(v) }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">明天提醒我首次联系</SelectItem>
                  <SelectItem value="3">3 天后提醒我跟进</SelectItem>
                  <SelectItem value="7">1 周后提醒我跟进</SelectItem>
                </SelectContent>
              </Select>
              <p className="mt-1 text-[11px] text-slate-400">提醒会出现在右上角铃铛和仪表盘，逾期不消失</p>
            </div>
            <div className="col-span-2">
              <label className="mb-1 block text-xs text-slate-500">客户背景</label>
              <Textarea value={form.background} onChange={e => setForm(f => ({ ...f, background: e.target.value }))} rows={3} placeholder="业务情况、痛点、决策链…" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>取消</Button>
            <Button className="bg-[#3370ff] hover:bg-[#2952cc]" disabled={!form.name.trim()} onClick={submit}>录入</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
