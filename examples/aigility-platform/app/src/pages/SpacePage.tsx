import { useEffect, useState } from 'react'
import { memoryLayers, rules, knowledgeDocs, knowledgeBases } from '../mock/data'
import { fetchTimemStatus, timemSearch, type TimemStatus, type TimemMemoryHit } from '../lib/harness'
import { BrainCircuit, ScrollText, BookOpen, MessageSquareText, Check, Layers3, FlaskConical, Radio, Search, Loader2, PlugZap } from 'lucide-react'

export default function SpacePage() {
  const [tab, setTab] = useState<'memory' | 'rule' | 'knowledge'>('memory')
  const [ruleState, setRuleState] = useState<Record<string, boolean>>(Object.fromEntries(rules.map(r => [r.id, r.status])))
  const [kbState, setKbState] = useState(knowledgeBases)
  const [recall, setRecall] = useState('')
  const [qa, setQa] = useState(false)

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-slate-800">TiMEM 空间</h1>
        <p className="text-sm text-slate-500 mt-1">太忆上下文基础设施的可视化：记忆 · 规则 · 知识统一上下文管理 —— 所有数字员工与智能体共享的企业级长期记忆</p>
      </div>

      <div className="grid md:grid-cols-3 gap-4">
        {[
          { k: 'memory', icon: BrainCircuit, label: '记忆流', desc: '五层结构：碎片→会话→报告→画像→预判', count: '10,493 条 · 5 层', c: 'text-amber-600 bg-amber-50' },
          { k: 'rule', icon: ScrollText, label: '规则库', desc: '专家规则 + 审批沉淀', count: `${rules.length} 条生效中`, c: 'text-emerald-600 bg-emerald-50' },
          { k: 'knowledge', icon: BookOpen, label: '知识库', desc: '制度/工艺/方案切片入库', count: '5 个项目 855 块', c: 'text-blue-600 bg-blue-50' },
        ].map(t => (
          <button key={t.k} onClick={() => setTab(t.k as any)}
            className={`text-left bg-white rounded-xl border p-5 transition hover:shadow-md ${tab === t.k ? 'border-blue-400 ring-2 ring-blue-100' : 'border-slate-200/80'}`}>
            <div className={`w-9 h-9 rounded-lg flex items-center justify-center mb-3 ${t.c}`}><t.icon size={18} /></div>
            <div className="font-medium text-slate-800">{t.label}</div>
            <div className="text-xs text-slate-400 mt-1">{t.desc}</div>
            <div className="text-xs text-slate-500 mt-2 font-medium">{t.count}</div>
          </button>
        ))}
      </div>

      {tab === 'memory' && (<><TimemPanel /><MemoryLayers /></>)}

      {tab === 'rule' && (
        <div className="bg-white rounded-xl border border-slate-200/80 overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
            <h3 className="font-medium text-slate-800">规则库 · 专家在回路沉淀</h3>
            <span className="text-xs text-slate-400">审批轨迹自动转规则，支持启停与版本管理</span>
          </div>
          <div className="overflow-x-auto -mx-1 px-1"><table className="w-full text-sm">
            <thead><tr className="text-xs text-slate-400 border-b border-slate-100 bg-slate-50/60">
              <th className="text-left font-medium px-5 py-2.5">规则</th>
              <th className="text-left font-medium px-3 py-2.5">触发条件</th>
              <th className="text-left font-medium px-3 py-2.5">动作</th>
              <th className="text-left font-medium px-3 py-2.5">来源</th>
              <th className="text-left font-medium px-3 py-2.5">状态</th>
            </tr></thead>
            <tbody>
              {rules.map(r => (
                <tr key={r.id} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/50">
                  <td className="px-5 py-3"><span className="text-xs text-slate-400 mr-2">{r.id}</span><span className="text-sm text-slate-700">{r.name}</span></td>
                  <td className="px-3 py-3 text-xs text-slate-500">{r.condition}</td>
                  <td className="px-3 py-3 text-xs text-slate-500">{r.action}</td>
                  <td className="px-3 py-3"><span className={`text-xs px-2 py-0.5 rounded ${r.source === '审批轨迹沉淀' ? 'bg-emerald-50 text-emerald-600' : 'bg-blue-50 text-blue-600'}`}>{r.source}</span></td>
                  <td className="px-3 py-3">
                    <button onClick={() => setRuleState(s => ({ ...s, [r.id]: !s[r.id] }))}
                      className={`w-10 h-5.5 h-[22px] rounded-full transition relative ${ruleState[r.id] ? 'bg-blue-600' : 'bg-slate-200'}`}>
                      <span className={`absolute top-[3px] w-4 h-4 rounded-full bg-white shadow transition-all ${ruleState[r.id] ? 'left-[22px]' : 'left-[3px]'}`} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </div>
      )}

      {tab === 'knowledge' && (
        <div className="space-y-4">
          <div className="bg-white rounded-xl border border-slate-200/80 p-5">
            <div className="flex gap-2">
              <div className="relative flex-1">
                <MessageSquareText size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input placeholder="对知识库提问，例如：锅炉主汽温度报警的处置规程是什么？"
                  className="w-full pl-9 pr-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-300" />
              </div>
              <button onClick={() => setQa(true)} className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm hover:bg-blue-700">提问</button>
            </div>
            {qa && (
              <div className="mt-4 bg-slate-50 border border-slate-100 rounded-xl p-4 text-sm text-slate-700 leading-relaxed" style={{ animation: 'fadeSlide .3s ease' }}>
                根据《锅炉运行规程（2026 修订版）》第 4.2 节：主汽温度超过 575℃ 持续 60 秒即触发一级报警，值长应优先投入减温水并减负荷 5%；若 5 分钟内未回落，启动二级响应并通知检修。结合 GB30871 相关条款，涉及动火检修时需同步办理作业票。
                <div className="flex gap-2 mt-3">
                  <span className="text-xs px-2 py-1 rounded bg-blue-50 text-blue-600 flex items-center gap-1"><Check size={11} />引用：锅炉运行规程 4.2 节</span>
                  <span className="text-xs px-2 py-1 rounded bg-blue-50 text-blue-600">引用：GB30871 动火作业规范</span>
                </div>
              </div>
            )}
          </div>
          {/* 多知识库挂载管理 */}
          <div className="bg-white rounded-xl border border-slate-200/80 overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between flex-wrap gap-2">
              <div>
                <h3 className="font-medium text-slate-800 text-sm">多知识库挂载</h3>
                <p className="text-[11px] text-slate-400 mt-0.5">每个智能体按需挂载多个知识库，召回测试与启停即时生效</p>
              </div>
              {recall && <span className="text-[11px] text-emerald-600 flex items-center gap-1"><Check size={11} />「{recall}」召回测试通过：Top5 相关分片全部命中</span>}
            </div>
            <div className="overflow-x-auto -mx-1 px-1"><table className="w-full text-sm">
              <thead><tr className="text-xs text-slate-400 border-b border-slate-100 bg-slate-50/60">
                <th className="text-left font-medium px-5 py-2.5">知识库</th>
                <th className="text-left font-medium px-3 py-2.5">文档数</th>
                <th className="text-left font-medium px-3 py-2.5">分片数</th>
                <th className="text-left font-medium px-3 py-2.5">命中率</th>
                <th className="text-left font-medium px-3 py-2.5">更新时间</th>
                <th className="text-left font-medium px-3 py-2.5">操作</th>
                <th className="text-left font-medium px-3 py-2.5">挂载状态</th>
              </tr></thead>
              <tbody>
                {kbState.map(k => (
                  <tr key={k.name} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/50">
                    <td className="px-5 py-3 text-slate-700 font-medium">{k.name}</td>
                    <td className="px-3 py-3 text-xs text-slate-500">{k.docs}</td>
                    <td className="px-3 py-3 text-xs text-slate-500">{k.chunks.toLocaleString()}</td>
                    <td className="px-3 py-3"><span className="text-xs px-2 py-0.5 rounded bg-blue-50 text-blue-600">{k.hit}</span></td>
                    <td className="px-3 py-3 text-xs text-slate-400">{k.updated}</td>
                    <td className="px-3 py-3">
                      <button onClick={() => { setRecall(''); setTimeout(() => setRecall(k.name), 600) }}
                        className="text-xs px-2.5 py-1 rounded-lg border border-slate-200 text-slate-600 hover:border-blue-300 hover:text-blue-600 flex items-center gap-1"><FlaskConical size={11} />召回测试</button>
                    </td>
                    <td className="px-3 py-3">
                      <button onClick={() => setKbState(list => list.map(x => x.name === k.name ? { ...x, enabled: !x.enabled } : x))}
                        className={`w-10 h-[22px] rounded-full transition relative ${k.enabled ? 'bg-blue-600' : 'bg-slate-200'}`}>
                        <span className={`absolute top-[3px] w-4 h-4 rounded-full bg-white shadow transition-all ${k.enabled ? 'left-[22px]' : 'left-[3px]'}`} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          </div>

          <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
            {knowledgeDocs.map(d => (
              <div key={d.name} className="bg-white rounded-xl border border-slate-200/80 p-5 hover:shadow-md transition cursor-pointer">
                <div className="w-9 h-9 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center mb-3"><BookOpen size={17} /></div>
                <div className="font-medium text-slate-800 text-sm">{d.name}</div>
                <div className="text-xs text-slate-400 mt-1.5">{d.type} · {d.project}</div>
                <div className="text-xs text-slate-400 mt-2 pt-2 border-t border-slate-50">{d.chunks} 个知识切片 · 更新于 {d.updated}</div>
              </div>
            ))}
          </div>
        </div>
      )}
      <style>{`@keyframes fadeSlide { from { opacity: 0; transform: translateY(4px);} to { opacity: 1; transform: none; } }`}</style>
    </div>
  )
}

// ─── 记忆流五层结构 ───
function MemoryLayers() {
  const [layer, setLayer] = useState(memoryLayers[0])
  const max = Math.max(...memoryLayers.map(l => l.count))

  return (
    <div className="grid lg:grid-cols-[380px_1fr] gap-4">
      {/* 层级金字塔（自下而上聚合） */}
      <div className="bg-white rounded-xl border border-slate-200/80 p-5">
        <div className="flex items-center gap-2 mb-1">
          <Layers3 size={16} className="text-blue-600" />
          <h3 className="font-medium text-slate-800">记忆流 · 五层结构</h3>
        </div>
        <p className="text-xs text-slate-400 mb-4">下层保真写入，上层聚合抽象，逐层反哺决策</p>
        <div className="space-y-2">
          {[...memoryLayers].reverse().map(l => {
            const active = layer.id === l.id
            const width = 35 + (l.count / max) * 65
            return (
              <button key={l.id} onClick={() => setLayer(memoryLayers.find(x => x.id === l.id)!)}
                className={`w-full text-left rounded-xl border p-3 transition ${active ? 'border-blue-400 ring-2 ring-blue-100 bg-blue-50/40' : 'border-slate-100 hover:border-slate-200 bg-white'}`}>
                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded text-white" style={{ background: l.color }}>{l.level}</span>
                    <span className="text-sm font-medium text-slate-700">{l.name}</span>
                  </div>
                  <span className="text-xs text-slate-400">{l.count.toLocaleString()} 条</span>
                </div>
                <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
                  <div className="h-1.5 rounded-full transition-all" style={{ width: `${width}%`, background: l.color }} />
                </div>
                <p className="text-[11px] text-slate-400 mt-1.5 leading-relaxed">{l.desc}</p>
              </button>
            )
          })}
        </div>
        <div className="mt-4 rounded-lg bg-slate-50 border border-slate-100 px-3 py-2.5 text-[11px] text-slate-500 leading-relaxed">
          聚合链路：碎片 → 会话（任务上下文）→ 日报周报（周期聚合）→ 画像（长期特征）→ 前瞻预判（决策出口）
        </div>
      </div>

      {/* 当前层内容 */}
      <div className="bg-white rounded-xl border border-slate-200/80 p-5">
        <div className="flex items-center gap-2 mb-4">
          <span className="text-xs font-bold px-2 py-1 rounded text-white" style={{ background: layer.color }}>{layer.level}</span>
          <h3 className="font-medium text-slate-800">{layer.name}</h3>
          <span className="text-xs text-slate-400 ml-auto">{layer.count.toLocaleString()} 条 · 按实体与时间自动关联</span>
        </div>
        <div className="space-y-0 relative">
          <div className="absolute left-[7px] top-2 bottom-2 w-px bg-slate-200" />
          {layer.items.map((m, i) => (
            <div key={i} className="relative pl-7 pb-5 last:pb-0" style={{ animation: 'fadeSlide .3s ease' }}>
              <div className="absolute left-0 top-1.5 w-[15px] h-[15px] rounded-full border-[3px] bg-white" style={{ borderColor: layer.color }} />
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs text-slate-400">{m.time}</span>
                <span className="text-xs px-2 py-0.5 rounded bg-blue-50 text-blue-600">{m.entity}</span>
                {m.tag && <span className="text-xs px-2 py-0.5 rounded bg-slate-100 text-slate-500">{m.tag}</span>}
              </div>
              <p className="text-sm text-slate-600 mt-1.5 leading-relaxed">{m.content}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── TiMEM 记忆（真）：连接状态 + Seam 检索（@action/timem-memory）──

function TimemPanel() {
  const [status, setStatus] = useState<TimemStatus | null>(null)
  const [query, setQuery] = useState('')
  const [agentId, setAgentId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [hits, setHits] = useState<TimemMemoryHit[]>([])

  useEffect(() => {
    fetchTimemStatus().then(setStatus).catch(() => {})
  }, [])

  const search = async () => {
    const q = query.trim()
    if (!q || busy) return
    setBusy(true); setError('')
    try {
      setHits(await timemSearch(q, agentId.trim() || undefined))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="bg-white rounded-xl border border-emerald-200 ring-1 ring-emerald-100/60 p-5 space-y-4" style={{ animation: 'fadeSlide .3s ease' }}>
      <div className="flex items-center gap-2 flex-wrap">
        <Radio size={14} className="text-emerald-500" />
        <h2 className="text-sm font-semibold text-slate-700">已接入 aigility-harness · TiMEM 记忆</h2>
        <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-600 border border-emerald-100">真 · Seam → @action/timem-memory</span>
        <span className="text-[11px] text-slate-400 ml-auto flex items-center gap-1.5">
          {status && (status.configured && status.ok
            ? <><Check size={12} className="text-emerald-500" />已连接 {status.baseUrl}{status.latencyMs != null && ` · ${status.latencyMs}ms`}</>
            : <><PlugZap size={12} className="text-amber-500" />{status.configured ? '已配置但不可达' : '未配置 TIMEM_API_KEY（数字员工对话的记忆节点自动跳过）'}</>)}
        </span>
      </div>

      <div className="flex gap-2 flex-wrap">
        <input value={query} onChange={e => setQuery(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) void search() }}
          placeholder="检索企业长期记忆（如：锅炉 主汽温度 报警）…"
          className="flex-1 min-w-[220px] text-sm border border-slate-200 rounded-lg px-3.5 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-300" />
        <input value={agentId} onChange={e => setAgentId(e.target.value)}
          placeholder="agent_id（可空）"
          className="w-40 text-sm border border-slate-200 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-300" />
        <button onClick={() => void search()} disabled={busy || !query.trim()}
          className="px-4 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40 flex items-center gap-1.5 text-sm">
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Search size={15} />}检索
        </button>
      </div>

      {error && <div className="text-xs text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{error}</div>}
      {hits.length > 0 && (
        <div className="space-y-2">
          {hits.map((h, i) => (
            <div key={h.memory_id ?? i} className="text-xs rounded-lg border border-slate-100 bg-slate-50/60 px-3 py-2.5 leading-relaxed">
              <div className="text-slate-700">{h.content}</div>
              <div className="text-[10px] text-slate-400 mt-1">
                {h.memory_id && `id=${h.memory_id}`}{h.score != null && ` · 相关度 ${h.score}`}
              </div>
            </div>
          ))}
        </div>
      )}
      {hits.length === 0 && !error && query.trim() && !busy && status?.configured && (
        <div className="text-xs text-slate-400">无命中记忆 —— 该 agent_id/user_id 组合下暂无沉淀；数字员工对话后（配置 TiMEM 时）记忆会写入这里</div>
      )}
    </div>
  )
}
