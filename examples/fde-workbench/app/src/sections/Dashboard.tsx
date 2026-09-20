
import { useStore } from '@/store/AppContext'
import { PageHeader } from '@/components/bits'
import { fmtMoneyFull } from '@/types'
import { stageIndex } from '@/data/mock'
import { ArrowRight, ChevronRight, CircleDollarSign, FileStack, Network, BrainCircuit, Users, Handshake, FileText, PackageCheck, BellRing, Activity as ActivityIcon, Filter } from 'lucide-react'

const PIPELINE = [
  { label: '线索', icon: Users, test: () => true },
  { label: '拜访', icon: Handshake, test: (i: number) => i >= 2 },
  { label: '方案', icon: FileStack, test: (i: number) => i >= 3 },
  { label: '报价', icon: CircleDollarSign, test: (i: number) => i >= 4 },
  { label: '合同', icon: FileText, test: (i: number) => i >= 6 },
  { label: '交付', icon: PackageCheck, test: (i: number) => i >= 7 },
]

export function Dashboard() {
  const { scopedLeads, proposals, contracts, knowledge, activities, navigate, reminders, completeReminder, role } = useStore()

  const active = scopedLeads.filter(l => l.stage !== '已流失')
  const pipelineCounts = PIPELINE.map(p => active.filter(l => p.test(stageIndex(l.stage))).length)

  const inFlightAmount = contracts.filter(c => c.status !== '已回款').reduce((s, c) => s + c.amount, 0)
  const monthProposals = proposals.length
  const commissionInFlight = contracts
    .filter(c => c.channelId && c.status !== '已回款')
    .reduce((s, c) => s + c.amount * c.commissionRate, 0)
  const directCount = contracts.filter(c => c.salesType === '直接').length

  const funnel = PIPELINE.map((p, i) => ({
    label: p.label,
    count: pipelineCounts[i],
    rate: i === 0 ? null : pipelineCounts[0] ? Math.round((pipelineCounts[i] / pipelineCounts[i - 1]) * 100) : 0,
  }))
  const maxFunnel = Math.max(...funnel.map(f => f.count), 1)
  const pendingReminders = reminders.filter(r => !r.done)

  const metrics = [
    { icon: CircleDollarSign, label: '在途合同总额', value: fmtMoneyFull(inFlightAmount), sub: `${contracts.filter(c => c.status !== '已回款').length} 份合同履约推进中`, go: () => navigate({ name: 'contracts' }) },
    { icon: FileStack, label: '已生成方案', value: `${monthProposals} 套`, sub: `PPT ${monthProposals} · Word ${monthProposals} · Excel ${monthProposals}`, go: () => navigate({ name: 'proposals' }) },
    { icon: Network, label: '渠道分佣在途额', value: fmtMoneyFull(Math.round(commissionInFlight)), sub: `直接 ${directCount} 单 · 间接 ${contracts.length - directCount} 单`, go: () => navigate({ name: 'channels' }) },
    { icon: BrainCircuit, label: '记忆沉淀条目', value: `${128 + 24 + 87 + 46} 条`, sub: `本周新增 ${knowledge.filter(k => k.date >= '09-01' || k.date >= '2026-09').length + 9} 条 · ${knowledge.filter(k => k.status === '待审阅').length} 条待审阅`, go: () => navigate({ name: 'knowledge' }) },
  ]

  return (
    <div>
      <PageHeader
        title="仪表盘"
        desc={role.scope === 'all' ? '从线索到交付的全盘作战视图 · 数据实时来自工作台' : `当前视角：${role.name}（${role.title}）· 仅显示你参与的 ${scopedLeads.length} 条线索`}
        back={false}
      />

      {/* 转化管道 */}
      <div className="rounded-2xl border border-slate-200/60 bg-white shadow-sm p-7">
        <div className="mb-5 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-[15px] font-semibold text-slate-900">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-50"><ActivityIcon className="h-4 w-4 text-[#3370ff]" /></span>
            销售转化管道
          </h2>
          <span className="hidden sm:flex items-center gap-1 text-xs font-medium text-[#3370ff]">点击任意环节可下钻到对应列表 <ChevronRight className="h-3 w-3" /></span>
        </div>
        <div className="grid grid-cols-3 gap-3 sm:flex sm:items-stretch">
          {PIPELINE.map((p, i) => (
            <div key={p.label} className="flex flex-1 items-center gap-2">
              <button
                onClick={() => navigate({ name: 'leads' })}
                className="group w-full sm:flex-1 rounded-xl border border-slate-200 bg-slate-50/60 px-4 py-4 text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-[#3370ff] hover:bg-blue-50/60 hover:shadow-md cursor-pointer"
              >
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1.5 text-xs text-slate-500 group-hover:text-[#3370ff]">
                    <p.icon className="h-3.5 w-3.5" />{p.label}
                  </span>
                  <ChevronRight className="h-3 w-3 text-slate-300 group-hover:text-[#3370ff] transition-transform group-hover:translate-x-0.5" />
                </div>
                <div className="tnum mt-2.5 text-[26px] sm:text-[30px] font-bold leading-none text-slate-900 group-hover:text-[#3370ff]">{pipelineCounts[i]}</div>
                <div className="mt-2 text-[11px] font-medium text-[#3370ff] opacity-0 transition-opacity group-hover:opacity-100">查看明细 →</div>
              </button>
              {i < PIPELINE.length - 1 && <ArrowRight className="hidden sm:block h-4 w-4 shrink-0 text-slate-300" />}
            </div>
          ))}
        </div>
      </div>

      {/* 指标卡 */}
      <div className="mt-7 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
        {metrics.map(m => (
          <button key={m.label} onClick={m.go}
            className="group rounded-2xl border border-slate-200/60 bg-white shadow-sm p-6 text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-[#3370ff]/50 hover:shadow-md">
            <div className="flex items-center gap-2.5 text-[13px] text-slate-500">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-50 transition-colors group-hover:bg-blue-100">
                <m.icon className="h-4 w-4 text-[#3370ff]" />
              </span>
              {m.label}
            </div>
            <div className="tnum mt-3.5 text-[26px] sm:text-[28px] font-bold leading-none text-slate-900 break-all">{m.value}</div>
            <div className="mt-2.5 text-xs leading-relaxed text-slate-400">{m.sub}</div>
            <div className="mt-3 flex items-center gap-0.5 text-[12px] font-medium text-[#3370ff]">
              查看详情 <ChevronRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5" />
            </div>
          </button>
        ))}
      </div>

      <div className="mt-7 grid grid-cols-1 gap-7 lg:grid-cols-5">
        {/* 漏斗 */}
        <div className="rounded-2xl border border-slate-200/60 bg-white shadow-sm p-6 lg:col-span-2">
          <h2 className="flex items-center gap-2 text-[15px] font-semibold text-slate-900">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-50"><Filter className="h-4 w-4 text-[#3370ff]" /></span>
            销售漏斗
          </h2>
          <div className="mt-6 space-y-4">
            {funnel.map((f, i) => (
              <div key={f.label}>
                <div className="mb-1.5 flex items-center justify-between text-xs">
                  <span className="text-slate-600">{f.label}</span>
                  <span className="tnum text-slate-500">
                    {f.count} 条{f.rate !== null && <span className="ml-2 text-slate-400">转化 {f.rate}%</span>}
                  </span>
                </div>
                <div className="h-7 w-full overflow-hidden rounded-lg bg-slate-100">
                  <div
                    className="flex h-full items-center justify-end rounded-lg pr-2 transition-all duration-500"
                    style={{
                      width: `${Math.max((f.count / maxFunnel) * 100, 8)}%`,
                      background: `linear-gradient(90deg, rgba(0,112,201,${0.35 + i * 0.1}), rgba(0,112,201,${0.55 + i * 0.08}))`,
                    }}
                  >
                    <span className="tnum text-[11px] font-semibold text-white">{f.count}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <p className="mt-5 text-xs leading-relaxed text-slate-400">漏斗数量与线索列表筛选结果实时一致；流失线索不计入。</p>
        </div>

        {/* 最近动态 */}
        <div className="rounded-2xl border border-slate-200/60 bg-white shadow-sm p-6 lg:col-span-3">
          <h2 className="flex items-center gap-2 text-[15px] font-semibold text-slate-900">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-50"><BellRing className="h-4 w-4 text-[#3370ff]" /></span>
            最近动态
          </h2>
          <div className="mt-5 space-y-1">
            {activities.slice(0, 8).map((a, i) => (
              <button
                key={a.id}
                onClick={() => {
                  if (a.page === 'lead' && a.refId) navigate({ name: 'lead', id: a.refId })
                  else if (a.page === 'proposal' && a.refId) navigate({ name: 'proposal', id: a.refId })
                  else navigate({ name: 'contracts' })
                }}
                className="group flex w-full items-start gap-3 rounded-lg px-2 py-2.5 text-left transition-colors hover:bg-slate-50"
              >
                <div className="flex flex-col items-center pt-1.5">
                  <span className={`h-2 w-2 rounded-full ${i === 0 ? 'bg-[#3370ff]' : 'bg-slate-300'}`} />
                  {i < 7 && <span className="mt-1 h-full w-px bg-slate-200" />}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] leading-relaxed text-slate-700 group-hover:text-slate-900">{a.text}</p>
                  <p className="mt-0.5 text-xs text-slate-400 tnum">{a.time} · 来源：{a.source}</p>
                </div>
                <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-slate-300 opacity-0 transition-opacity group-hover:opacity-100" />
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* 待办与主动提醒 */}
      <div className="mt-7 rounded-2xl border border-l-[3px] border-l-amber-400 border-slate-200 bg-white p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-[15px] font-semibold text-slate-900">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-amber-50"><BellRing className="h-4 w-4 text-amber-500" /></span>
              今天需要你确认的事
            </h2>
            <p className="mt-2 text-[13px] text-slate-500">
              {proposals.filter(p => p.status === '待审阅').length} 份方案待审阅 · {knowledge.filter(k => k.status === '待审阅').length} 条沉淀待确认 · {scopedLeads.filter(l => l.suggestion.status === 'pending').length} 条下一步建议待处理 · {pendingReminders.length} 条跟进提醒
            </p>
          </div>
          <div className="flex gap-2">
            <button onClick={() => navigate({ name: 'proposals' })} className="rounded-md bg-[#3370ff] px-3.5 py-2 text-[13px] font-medium text-white hover:bg-[#2952cc]">去审阅方案</button>
            <button onClick={() => navigate({ name: 'knowledge' })} className="rounded-md border border-slate-200 px-3.5 py-2 text-[13px] font-medium text-slate-600 hover:bg-slate-50">去确认沉淀</button>
          </div>
        </div>
        {pendingReminders.length > 0 && (
          <div className="mt-4 border-t border-slate-100 pt-4 space-y-2">
            <p className="text-xs font-medium text-slate-500">系统主动提醒</p>
            {pendingReminders.slice(0, 3).map(r => (
              <div key={r.id} className="flex flex-wrap items-center gap-2.5 rounded-lg bg-amber-50/60 border border-amber-100 px-3.5 py-2.5">
                <span className="tnum shrink-0 rounded border border-amber-200 bg-white px-1.5 py-0.5 text-[11px] font-medium text-amber-700">{r.due}</span>
                <span className="min-w-0 flex-1 text-[13px] text-slate-700">{r.title}</span>
                {r.leadId && (
                  <button onClick={() => navigate({ name: 'lead', id: r.leadId! })} className="text-xs font-medium text-[#3370ff] hover:underline">查看线索</button>
                )}
                <button onClick={() => completeReminder(r.id)} className="text-xs font-medium text-emerald-600 hover:underline">完成</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
