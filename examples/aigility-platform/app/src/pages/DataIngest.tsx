import { useEffect, useRef, useState } from 'react'
import { demoCases, tenantProjects, chemTables, ontologyAlignment, type DemoCase, type EnterpriseTable } from '../mock/data'
import { UploadCloud, FileSpreadsheet, Sparkles, Check, Wrench, ArrowRight, Network, CircleCheck, Table2, Link2, Building2 } from 'lucide-react'

type Stage = 'idle' | 'analyzing' | 'done' | 'mapped'

const tabs = [{ id: 'all', name: '全部项目' }, ...tenantProjects.map(p => ({ id: p.id, name: p.enterprise }))]

const caseProject: Record<string, string> = { dcs: 'power', scada: 'chem', crm: 'deco' }

export default function DataIngest({ go }: { go: (p: string) => void }) {
  const [proj, setProj] = useState('all')
  const [active, setActive] = useState<DemoCase | null>(null)
  const [stage, setStage] = useState<Stage>('idle')
  const [visibleRows, setVisibleRows] = useState(0)
  const [adopted, setAdopted] = useState<Set<number>>(new Set())
  const [activeTable, setActiveTable] = useState<EnterpriseTable>(chemTables[0])
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  const start = (c: DemoCase) => {
    setActive(c)
    setStage('analyzing')
    setVisibleRows(0)
    setAdopted(new Set())
    if (timer.current) clearInterval(timer.current)
    let i = 0
    timer.current = setInterval(() => {
      i++
      setVisibleRows(i)
      if (i >= c.fields.length) {
        clearInterval(timer.current!)
        setStage('done')
      }
    }, 260)
  }

  useEffect(() => () => { if (timer.current) clearInterval(timer.current) }, [])

  const adoptAll = () => setAdopted(new Set(active!.fields.map((_, i) => i)))
  const visibleCases = proj === 'all' ? demoCases : demoCases.filter(c => caseProject[c.id] === proj)
  const currentProject = tenantProjects.find(p => p.id === proj)

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-800 flex items-center gap-2">数据接入与自动理解<span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 font-normal">产品壳演示 · 五域引擎暂无对应能力，暂不对接</span></h1>
        <p className="text-sm text-slate-500 mt-1">按项目上传客户系统的字段表，自动完成字段语义理解、清洗建议与本体映射</p>
      </div>

      {/* 项目切换 */}
      <div className="flex gap-2 flex-wrap">
        {tabs.map(t => (
          <button key={t.id} onClick={() => setProj(t.id)}
            className={`text-sm px-4 py-2 rounded-lg border transition flex items-center gap-1.5 ${proj === t.id ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-600 border-slate-200 hover:border-blue-300'}`}>
            {t.id !== 'all' && <Building2 size={14} />}
            {t.name}
            {t.id === 'chem' && <span className={`text-[10px] px-1.5 py-0.5 rounded ${proj === 'chem' ? 'bg-white/20' : 'bg-blue-50 text-blue-600'}`}>多表</span>}
          </button>
        ))}
      </div>

      {currentProject && (
        <div className="bg-white rounded-xl border border-slate-200/80 px-5 py-4 flex items-center gap-6 flex-wrap">
          <div>
            <div className="font-medium text-slate-800">{currentProject.name}</div>
            <div className="text-xs text-slate-400 mt-0.5">{currentProject.industry} · 接入 {currentProject.systems.join(' / ')}</div>
          </div>
          <div className="flex gap-6 ml-auto text-center">
            <div><div className="text-lg font-semibold text-slate-800">{currentProject.tables}</div><div className="text-xs text-slate-400">已接表</div></div>
            <div><div className="text-lg font-semibold text-slate-800">{currentProject.entities}</div><div className="text-xs text-slate-400">图谱实体</div></div>
          </div>
        </div>
      )}

      {/* ── 华精细化工：多表接入 + 本体对齐 ── */}
      {proj === 'chem' && (
        <>
          <div className="grid md:grid-cols-2 xl:grid-cols-5 gap-3">
            {chemTables.map(t => (
              <button key={t.id} onClick={() => setActiveTable(t)}
                className={`text-left bg-white rounded-xl border p-4 transition hover:shadow-md ${activeTable.id === t.id ? 'border-blue-400 ring-2 ring-blue-100' : 'border-slate-200/80'}`}>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-medium px-2 py-0.5 rounded bg-cyan-50 text-cyan-600">{t.system}</span>
                  <span className={`text-[11px] ${t.status === '已入图谱' ? 'text-emerald-600' : t.status === '待确认' ? 'text-amber-600' : 'text-blue-500'}`}>{t.status}</span>
                </div>
                <div className="text-sm font-medium text-slate-800">{t.name}</div>
                <div className="text-xs text-slate-400 mt-1 flex items-center gap-1"><FileSpreadsheet size={11} />{t.file}</div>
                <div className="text-xs text-slate-400 mt-1.5">{t.rows} 行 · {t.fieldCount} 字段</div>
              </button>
            ))}
          </div>

          <div className="grid lg:grid-cols-2 gap-4">
            {/* 单表字段理解 */}
            <div className="bg-white rounded-xl border border-slate-200/80 overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-100 flex items-center gap-2">
                <Table2 size={15} className="text-blue-600" />
                <span className="font-medium text-slate-800 text-sm">字段理解 · {activeTable.name}</span>
              </div>
              <div className="overflow-x-auto -mx-1 px-1"><table className="w-full text-sm">
                <thead><tr className="text-xs text-slate-400 border-b border-slate-100 bg-slate-50/60">
                  <th className="text-left font-medium px-5 py-2.5">原始字段</th>
                  <th className="text-left font-medium px-3 py-2.5">语义识别</th>
                  <th className="text-left font-medium px-3 py-2.5">本体映射</th>
                </tr></thead>
                <tbody>
                  {activeTable.keyFields.map(f => (
                    <tr key={f.name} className="border-b border-slate-50 last:border-0">
                      <td className="px-5 py-2.5 font-mono text-xs text-slate-700">{f.name}</td>
                      <td className="px-3 py-2.5"><span className="text-xs px-2 py-0.5 rounded bg-blue-50 text-blue-600">{f.semantic}</span></td>
                      <td className="px-3 py-2.5 text-xs font-medium text-sky-600">{f.ontology}</td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
              <div className="px-5 py-3 bg-slate-50/60 text-xs text-slate-400">完整字段共 {activeTable.fieldCount} 个，此处展示关键映射字段</div>
            </div>

            {/* 跨表本体对齐 */}
            <div className="bg-white rounded-xl border border-blue-200/70 overflow-hidden">
              <div className="px-5 py-4 border-b border-blue-100 bg-blue-50/40 flex items-center gap-2">
                <Link2 size={15} className="text-blue-600" />
                <span className="font-medium text-slate-800 text-sm">跨表本体对齐 · 不同字段名，同一本体</span>
              </div>
              <div className="p-5 space-y-3">
                {ontologyAlignment.map(o => (
                  <div key={o.ontology} className="border border-slate-100 rounded-xl p-3.5 hover:border-blue-200 transition">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs font-semibold px-2.5 py-1 rounded-lg bg-sky-600 text-white">{o.ontology}</span>
                      <span className="text-xs text-slate-300">←</span>
                      {o.sources.map(s => (
                        <code key={s} className="text-xs px-2 py-1 rounded bg-slate-100 text-slate-600">{s}</code>
                      ))}
                    </div>
                    <p className="text-xs text-slate-400 mt-2">{o.note}</p>
                  </div>
                ))}
              </div>
              <div className="px-5 py-3.5 border-t border-blue-100 bg-blue-50/40 flex items-center justify-between">
                <p className="text-xs text-blue-700">5 张表、58 个字段，语义归一到 12 个本体节点，图谱自动合并同源实体</p>
                <button onClick={() => go('graph')} className="text-xs px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 flex items-center gap-1 shrink-0"><Network size={12} />查看图谱</button>
              </div>
            </div>
          </div>
        </>
      )}

      {/* ── 通用示例案例 ── */}
      {proj !== 'chem' && (
        <div className="grid md:grid-cols-3 gap-4">
          {visibleCases.map(c => (
            <button key={c.id} onClick={() => start(c)}
              className={`text-left bg-white rounded-xl border p-5 transition hover:shadow-md ${active?.id === c.id ? 'border-blue-400 ring-2 ring-blue-100' : 'border-slate-200/80'}`}>
              <div className="flex items-center justify-between mb-3">
                <span className={`text-xs font-medium px-2.5 py-1 rounded-md ${c.system === 'DCS' ? 'bg-blue-50 text-blue-600' : c.system === 'SCADA' ? 'bg-cyan-50 text-cyan-600' : 'bg-pink-50 text-pink-600'}`}>{c.system}</span>
                <span className="text-xs text-slate-400">{c.industry}</span>
              </div>
              <div className="font-medium text-slate-800 mb-1.5">{c.name}</div>
              <p className="text-xs text-slate-500 leading-relaxed">{c.desc}</p>
              <div className="flex items-center gap-1.5 mt-3 text-xs text-slate-400">
                <FileSpreadsheet size={13} /> {c.tableName}
              </div>
            </button>
          ))}
        </div>
      )}

      {/* 上传区 */}
      <div className="border-2 border-dashed border-slate-200 rounded-xl bg-white p-8 text-center hover:border-blue-300 hover:bg-blue-50/30 transition cursor-pointer"
        onClick={() => active && start(active)}>
        <UploadCloud className="mx-auto text-slate-300 mb-3" size={36} />
        <p className="text-sm text-slate-600 font-medium">拖拽或点击上传{currentProject ? `「${currentProject.enterprise}」的` : '客户'}字段表</p>
        <p className="text-xs text-slate-400 mt-1">支持 Excel / CSV · 上传时标记来源系统（ERP / CRM / MES / SCADA / DCS / OA）· 也可配置 API 直连</p>
      </div>

      {/* 理解结果 */}
      {active && proj !== 'chem' && (
        <div className="bg-white rounded-xl border border-slate-200/80 overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Sparkles size={16} className="text-blue-600" />
              <span className="font-medium text-slate-800 text-sm">字段理解结果 · {active.tableName}</span>
              {stage === 'analyzing' && <span className="text-xs text-blue-500 animate-pulse">正在逐字段理解…</span>}
              {stage !== 'analyzing' && <span className="text-xs text-emerald-600 flex items-center gap-1"><CircleCheck size={12} />理解完成，识别 {active.fields.length} 个字段</span>}
            </div>
            {stage === 'done' && (
              <div className="flex gap-2">
                <button onClick={adoptAll} className="text-xs px-3 py-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50">全部采纳清洗建议</button>
                <button onClick={() => setStage('mapped')} className="text-xs px-3.5 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 flex items-center gap-1">
                  确认映射并生成图谱 <ArrowRight size={13} />
                </button>
              </div>
            )}
            {stage === 'mapped' && (
              <button onClick={() => go('graph')} className="text-xs px-3.5 py-1.5 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 flex items-center gap-1">
                <Network size={13} /> 查看生成的知识图谱
              </button>
            )}
          </div>

          <div className="overflow-x-auto">
            <div className="overflow-x-auto -mx-1 px-1"><table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-slate-400 border-b border-slate-100 bg-slate-50/60">
                  <th className="text-left font-medium px-5 py-2.5">原始字段</th>
                  <th className="text-left font-medium px-3 py-2.5">语义识别</th>
                  <th className="text-left font-medium px-3 py-2.5">格式</th>
                  <th className="text-left font-medium px-3 py-2.5">缺失</th>
                  <th className="text-left font-medium px-3 py-2.5">发现问题</th>
                  <th className="text-left font-medium px-3 py-2.5">清洗建议</th>
                  <th className="text-left font-medium px-3 py-2.5">本体映射</th>
                  <th className="px-3 py-2.5"></th>
                </tr>
              </thead>
              <tbody>
                {active.fields.slice(0, visibleRows).map((f, i) => (
                  <tr key={f.name} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/50" style={{ animation: 'fadeSlide .3s ease' }}>
                    <td className="px-5 py-2.5 font-mono text-xs text-slate-700">{f.name}</td>
                    <td className="px-3 py-2.5"><span className="text-xs px-2 py-0.5 rounded bg-blue-50 text-blue-600">{f.semantic}</span></td>
                    <td className="px-3 py-2.5 text-xs text-slate-500">{f.format}</td>
                    <td className="px-3 py-2.5 text-xs text-slate-500">{f.missing}</td>
                    <td className="px-3 py-2.5 text-xs">{f.issue === '—' ? <span className="text-slate-300">—</span> : <span className="text-amber-600">{f.issue}</span>}</td>
                    <td className="px-3 py-2.5 text-xs text-slate-600 max-w-[200px]">{f.suggestion}</td>
                    <td className="px-3 py-2.5 text-xs font-medium text-sky-600">{f.ontology}</td>
                    <td className="px-3 py-2.5">
                      {f.suggestion !== '—' && (
                        <button onClick={() => setAdopted(s => { const n = new Set(s); n.has(i) ? n.delete(i) : n.add(i); return n })}
                          className={`text-xs px-2 py-1 rounded-md flex items-center gap-1 transition ${adopted.has(i) ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}>
                          {adopted.has(i) ? <><Check size={11} />已采纳</> : <><Wrench size={11} />采纳</>}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          </div>

          {stage !== 'analyzing' && (
            <div className="px-5 py-4 bg-slate-50/60 border-t border-slate-100">
              <p className="text-xs text-slate-400 mb-2">数据样例预览（前 4 行）</p>
              <div className="grid gap-1.5">
                {active.sampleRows.map((r, i) => (
                  <div key={i} className="flex gap-2 flex-wrap">
                    {r.map((cell, j) => (
                      <span key={j} className="text-xs bg-white border border-slate-200 rounded px-2 py-1 text-slate-600">{cell}</span>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          )}

          {stage === 'mapped' && (
            <div className="px-5 py-4 border-t border-blue-100 bg-blue-50/40">
              <p className="text-xs font-medium text-blue-700 mb-3 flex items-center gap-1.5"><Network size={13} /> 本体映射已确认，生成图谱关系：</p>
              <div className="flex flex-wrap gap-2">
                {active.mappings.map((m, i) => (
                  <span key={i} className="text-xs bg-white border border-blue-200 rounded-full px-3 py-1.5 text-slate-700">
                    <b className="text-blue-600">{m.source}</b> —<span className="text-slate-400">{m.relation}</span>→ <b className="text-sky-600">{m.target}</b>
                  </span>
                ))}
              </div>
              <p className="text-xs text-slate-400 mt-3">图谱已驱动：知识问答 · 决策建议 · 实时监控与预判</p>
            </div>
          )}
        </div>
      )}
      <style>{`@keyframes fadeSlide { from { opacity: 0; transform: translateY(4px);} to { opacity: 1; transform: none; } }`}</style>
    </div>
  )
}
