import { useEffect, useState } from 'react'
import {
  fetchFdeLedger, exportFdeProposalDoc,
  type FdeLedgerSummary, type FdeLeadLite, type FdeProposalLite, type FdeContractLite, type FdeRenewalLite,
} from '../lib/harness'
import {
  ArrowLeft, ExternalLink, Briefcase, FileBarChart, Loader2, CheckCircle2, AlertTriangle, RefreshCw, Database, Handshake,
} from 'lucide-react'

/** 金额：万以上以「万」计（与 fde-workbench fmtMoney 同规则） */
const fmtMoney = (n: number) => (n >= 10000 ? `${(n / 10000).toFixed(n % 10000 === 0 ? 0 : 1)} 万` : n.toLocaleString())

const stageColor: Record<string, string> = {
  新线索: 'bg-slate-100 text-slate-600', 已联系: 'bg-sky-50 text-sky-600', 拜访中: 'bg-blue-50 text-blue-600',
  方案中: 'bg-indigo-50 text-indigo-600', 报价中: 'bg-violet-50 text-violet-600', 谈判中: 'bg-purple-50 text-purple-600',
  已签约: 'bg-emerald-50 text-emerald-600', 已交付: 'bg-emerald-50 text-emerald-700', 已流失: 'bg-rose-50 text-rose-500',
}
const stageBar: Record<string, string> = {
  新线索: 'bg-slate-300', 已联系: 'bg-sky-400', 拜访中: 'bg-blue-500', 方案中: 'bg-indigo-500', 报价中: 'bg-violet-500',
  谈判中: 'bg-purple-500', 已签约: 'bg-emerald-500', 已交付: 'bg-emerald-600', 已流失: 'bg-rose-400',
}
const renewalColor: Record<string, string> = {
  待续费: 'bg-amber-50 text-amber-600', 跟进中: 'bg-blue-50 text-blue-600', 已续费: 'bg-emerald-50 text-emerald-600', 已流失: 'bg-slate-100 text-slate-500',
}

/**
 * FDE 生意台账应用（应用中心 · 真）：@action/fde-ledger 域包共库直读 fde-workbench 台账，
 * 方案 DOCX 一键导出（@action/doc-worker），「打开完整工作台」以 #ssw= 携票跳转免二次登录（S1 挂接）。
 */
export default function FdeLedgerApp({ back }: { back: () => void }) {
  const [data, setData] = useState<FdeLedgerSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState('')
  const [exportDone, setExportDone] = useState('')
  const [exportError, setExportError] = useState('')

  const load = () => {
    setLoading(true)
    fetchFdeLedger()
      .then(setData)
      .catch((e) => setData({ ok: false, error: e instanceof Error ? e.message : String(e), source: '', seeded: false, fdeWorkbenchUrl: 'http://127.0.0.1:1234', counts: {}, leadsByStage: {}, contractAmount: { total: 0, byStatus: {} }, renewalsDue: { count: 0, amount: 0 }, leads: [], proposals: [], contracts: [], renewals: [], deliveries: [], deployments: [], knowledge: [] }))
      .finally(() => setLoading(false))
  }
  useEffect(() => { load() }, [])

  const exportDoc = async (p: FdeProposalLite) => {
    if (exporting) return
    setExporting(p.id); setExportDone(''); setExportError('')
    try {
      const r = await exportFdeProposalDoc(p.id)
      setExportDone(`已生成 ${r.filename}（${(r.bytes / 1024).toFixed(1)} KB）并开始下载`)
    } catch (e) {
      setExportError(e instanceof Error ? e.message : String(e))
    } finally {
      setExporting('')
    }
  }

  const openWorkbench = () => {
    if (!data) return
    const token = localStorage.getItem('aigility-token') ?? ''
    // S1 携票跳转：token 与 fde-workbench 同一 AppBase 签发体系, 对方读 #ssw= 免二次登录
    window.open(`${data.fdeWorkbenchUrl}/#ssw=${encodeURIComponent(token)}`, '_blank')
  }

  if (loading) {
    return (
      <div className="space-y-5">
        <Header back={back} />
        <div className="bg-white rounded-xl border border-slate-200/80 p-16 text-center text-sm text-slate-400">
          <Loader2 size={20} className="animate-spin mx-auto mb-3 text-slate-300" />正在读取共库台账…
        </div>
      </div>
    )
  }

  const failed = !data?.ok
  const empty = !!data && !failed && !data.seeded

  return (
    <div className="space-y-5">
      <Header back={back} />

      {/* 数据来源条（真） */}
      <div className="rounded-xl border border-emerald-100 bg-emerald-50/60 px-4 py-3 flex items-center gap-2 flex-wrap">
        <span className="text-xs text-emerald-700 flex items-center gap-1.5 font-medium"><Database size={13} />真 · AppBase 共库台账</span>
        <span className="text-[11px] text-slate-500">{data?.source}</span>
        {data?.updatedAt && <span className="text-[11px] text-slate-400">最近落库 {new Date(data.updatedAt).toLocaleString()}</span>}
        <button onClick={load} className="ml-auto text-xs px-2.5 py-1.5 rounded-lg border border-emerald-200 text-emerald-700 bg-white hover:bg-emerald-50 flex items-center gap-1"><RefreshCw size={12} />刷新</button>
        <button onClick={openWorkbench} className="text-xs px-2.5 py-1.5 rounded-lg bg-slate-800 text-white hover:bg-slate-700 flex items-center gap-1"><ExternalLink size={12} />打开完整工作台（免登录）</button>
      </div>

      {failed && (
        <div className="rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-xs text-red-600 flex items-start gap-2">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>共库台账不可读：{data?.error}</span>
        </div>
      )}
      {empty && (
        <div className="rounded-xl border border-amber-100 bg-amber-50 px-4 py-3 text-xs text-amber-700 leading-relaxed">
          共库中暂无 FDE 台账数据（fde_* 分片未播种）。启动 fde-workbench（仓库根目录 <code className="px-1 py-0.5 rounded bg-amber-100 font-mono">pnpm example:fde</code>）并登录任一账号后，台账会自动写入共库，本应用即可读真数据。
        </div>
      )}

      {/* 总览统计 */}
      {data?.ok && data.seeded && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4">
            {[
              { label: '线索总数', value: String(data.counts.leads ?? 0), sub: `${data.counts.proposals ?? 0} 个方案在档` },
              { label: '合同总额', value: `¥${fmtMoney(data.contractAmount.total)}`, sub: `${data.counts.contracts ?? 0} 份合同` },
              { label: '待续费', value: `¥${fmtMoney(data.renewalsDue.amount)}`, sub: `${data.renewalsDue.count} 笔跟进中/待续` },
              { label: '交付项目', value: String(data.counts.deliveries ?? 0), sub: `${data.counts.deployments ?? 0} 个部署站点` },
              { label: '渠道伙伴', value: String(data.counts.channels ?? 0), sub: `${data.counts.knowledge ?? 0} 条沉淀知识` },
              { label: '已签约+已交付', value: String((data.leadsByStage['已签约'] ?? 0) + (data.leadsByStage['已交付'] ?? 0)), sub: `流失 ${data.leadsByStage['已流失'] ?? 0} 个` },
            ].map((s) => (
              <div key={s.label} className="bg-white rounded-xl border border-slate-200/80 p-4">
                <div className="text-xs text-slate-400">{s.label}</div>
                <div className="text-xl font-semibold text-slate-800 mt-1">{s.value}</div>
                <div className="text-[11px] text-slate-400 mt-0.5">{s.sub}</div>
              </div>
            ))}
          </div>

          {/* 线索漏斗（按阶段） */}
          <div className="bg-white rounded-xl border border-slate-200/80 p-5">
            <div className="font-medium text-slate-800 text-sm mb-3 flex items-center gap-1.5"><Handshake size={14} className="text-slate-400" />线索漏斗（按阶段）</div>
            <div className="space-y-2">
              {Object.entries(data.leadsByStage).map(([stage, n]) => {
                const max = Math.max(1, ...Object.values(data.leadsByStage))
                return (
                  <div key={stage} className="flex items-center gap-3">
                    <span className="text-xs text-slate-500 w-14 shrink-0">{stage}</span>
                    <div className="flex-1 h-4 rounded bg-slate-50 overflow-hidden">
                      <div className={`h-full rounded ${stageBar[stage] ?? 'bg-slate-300'}`} style={{ width: `${(n / max) * 100}%` }} />
                    </div>
                    <span className="text-xs text-slate-700 w-6 text-right">{n}</span>
                  </div>
                )
              })}
            </div>
          </div>

          {/* 三列明细：线索 / 方案 / 续费 */}
          <div className="grid lg:grid-cols-3 gap-4">
            <Panel title={`线索（${data.leads.length}）`}>
              {data.leads.map((l: FdeLeadLite) => (
                <div key={l.id} className="px-4 py-2.5 border-b border-slate-50 last:border-0 hover:bg-slate-50/50">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-slate-700 truncate">{l.name}</span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full shrink-0 ${stageColor[l.stage] ?? 'bg-slate-100 text-slate-500'}`}>{l.stage}</span>
                  </div>
                  <div className="text-[11px] text-slate-400 mt-0.5">{l.industry || '—'} · {l.scale || '—'} · {l.owner || '—'} · 最近触达 {l.lastTouchAt || '—'}</div>
                </div>
              ))}
            </Panel>

            <Panel title={`方案（${data.proposals.length}）· 点击行导出 DOCX`}>
              {data.proposals.map((p: FdeProposalLite) => (
                <button key={p.id} onClick={() => void exportDoc(p)} disabled={!!exporting}
                  className="w-full text-left px-4 py-2.5 border-b border-slate-50 last:border-0 hover:bg-blue-50/40 disabled:opacity-60">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-slate-700 truncate flex-1">{p.title}</span>
                    {exporting === p.id
                      ? <Loader2 size={12} className="animate-spin text-blue-500 shrink-0" />
                      : <FileBarChart size={12} className="text-slate-300 shrink-0" />}
                  </div>
                  <div className="text-[11px] text-slate-400 mt-0.5">
                    v{p.version} · {p.status} · ¥{p.total.toLocaleString()} · {p.createdAt}
                  </div>
                </button>
              ))}
            </Panel>

            <Panel title={`续费台账（${data.renewals.length} · 按到期日)`}>
              {data.renewals.map((r: FdeRenewalLite) => (
                <div key={r.id} className="px-4 py-2.5 border-b border-slate-50 last:border-0 hover:bg-slate-50/50">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-slate-700 truncate">{r.customer}</span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full shrink-0 ${renewalColor[r.status] ?? 'bg-slate-100 text-slate-500'}`}>{r.status}</span>
                  </div>
                  <div className="text-[11px] text-slate-400 mt-0.5">{r.item} · 到期 {r.dueDate} · ¥{fmtMoney(r.amount)}</div>
                </div>
              ))}
            </Panel>
          </div>

          {/* 合同 + 交付 */}
          <div className="grid lg:grid-cols-2 gap-4">
            <div className="bg-white rounded-xl border border-slate-200/80 overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-100 font-medium text-slate-800 text-sm">合同（按状态金额）</div>
              <div className="p-4 space-y-2">
                {Object.entries(data.contractAmount.byStatus).map(([st, amt]) => (
                  <div key={st} className="flex items-center gap-3 text-xs">
                    <span className="text-slate-500 w-20 shrink-0">{st}</span>
                    <div className="flex-1 h-3 rounded bg-slate-50 overflow-hidden">
                      <div className="h-full rounded bg-emerald-500" style={{ width: `${data.contractAmount.total ? (amt / data.contractAmount.total) * 100 : 0}%` }} />
                    </div>
                    <span className="text-slate-700 w-24 text-right">¥{fmtMoney(amt)}</span>
                  </div>
                ))}
                {data.contracts.slice(0, 4).map((c: FdeContractLite) => (
                  <div key={c.id} className="text-[11px] text-slate-400 pt-1 border-t border-slate-50 first:border-0">
                    {c.code} · {c.customer} · ¥{fmtMoney(c.amount)} · {c.status}{c.signDate ? ` · 签于 ${c.signDate}` : ''}
                  </div>
                ))}
              </div>
            </div>
            <div className="bg-white rounded-xl border border-slate-200/80 overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-100 font-medium text-slate-800 text-sm">交付与部署</div>
              <div className="divide-y divide-slate-50">
                {data.deliveries.map((d) => (
                  <div key={d.id} className="px-4 py-2.5 flex items-center gap-2 text-xs">
                    <span className="font-medium text-slate-700 truncate">{d.name}</span>
                    <span className="text-slate-400 truncate">{d.customer}</span>
                    <span className={`ml-auto text-[10px] px-1.5 py-0.5 rounded-full shrink-0 ${d.status === '已验收' || d.status === '已回访' ? 'bg-emerald-50 text-emerald-600' : 'bg-blue-50 text-blue-600'}`}>{d.status}</span>
                  </div>
                ))}
                {data.deployments.map((d) => (
                  <div key={d.id} className="px-4 py-2.5 flex items-center gap-2 text-xs">
                    <span className="font-medium text-slate-700 truncate">{d.site}</span>
                    <span className="text-slate-400 truncate">{d.customer}</span>
                    <span className={`ml-auto text-[10px] px-1.5 py-0.5 rounded-full shrink-0 ${d.status === '运行中' ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-100 text-slate-500'}`}>{d.status}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>
      )}

      {exportDone && (
        <div className="rounded-xl border border-emerald-100 bg-emerald-50 px-4 py-3 text-xs text-emerald-700 flex items-center gap-1.5"><CheckCircle2 size={13} />{exportDone}</div>
      )}
      {exportError && (
        <div className="rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-xs text-red-600 flex items-center gap-1.5"><AlertTriangle size={13} />{exportError}</div>
      )}

      <div className="rounded-xl bg-gradient-to-br from-slate-800 to-slate-900 p-5 text-white flex items-center justify-between flex-wrap gap-3">
        <div>
          <div className="text-sm font-medium flex items-center gap-2"><Briefcase size={15} className="text-sky-300" />这是 fde-workbench 插入智悦的「应用包」</div>
          <p className="text-xs text-slate-300 mt-1">域包插件 @action/fde-ledger 共库直读台账 · 方案导出走 D3 @action/doc-worker · 完整工作台携票免登录跳转（S1 挂接，见 docs/platform-module-plugin-design.md）</p>
        </div>
        <span className="text-xs text-slate-400">数据归属 app:fde-workbench · 与工作台读写同一份台账</span>
      </div>
    </div>
  )
}

function Header({ back }: { back: () => void }) {
  return (
    <div className="flex items-center gap-3 flex-wrap">
      <button onClick={back} className="w-8 h-8 rounded-lg border border-slate-200 bg-white flex items-center justify-center text-slate-500 hover:bg-slate-50"><ArrowLeft size={15} /></button>
      <div className="w-9 h-9 rounded-xl bg-sky-50 text-sky-600 flex items-center justify-center"><Briefcase size={18} /></div>
      <div>
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-semibold text-slate-800">FDE 生意台账</h1>
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-600">真 · 共库台账</span>
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-500">应用包 · 来自 fde-workbench</span>
        </div>
        <p className="text-xs text-slate-400 mt-0.5">线索 → 方案 → 合同 → 交付 → 续费全流程台账：总览、方案 DOCX 导出与完整工作台直达</p>
      </div>
    </div>
  )
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-xl border border-slate-200/80 overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-100 font-medium text-slate-800 text-xs">{title}</div>
      <div className="max-h-[320px] overflow-y-auto">
        {children}
      </div>
    </div>
  )
}
