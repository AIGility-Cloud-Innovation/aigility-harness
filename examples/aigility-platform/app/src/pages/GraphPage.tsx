import { useMemo, useState } from 'react'
import EChart from '../components/EChart'
import { TwinGraph3D, type N3 } from '../components/TwinGraph3D'
import { graphNodes, graphEdges, graphCategories, nodeProject, tenantProjects, eventDemo, eventCategory, type GraphNode } from '../mock/data'
import { Search, MessageSquareText, BellPlus, BrainCircuit, Zap, X } from 'lucide-react'

export default function GraphPage({ go }: { go: (p: string) => void }) {
  const [selected, setSelected] = useState<GraphNode | null>(null)
  const [enabled, setEnabled] = useState<Set<number>>(new Set(graphCategories.map((_, i) => i)))
  const [kw, setKw] = useState('')
  const [proj, setProj] = useState('all')
  const [eventOn, setEventOn] = useState(false)
  const [view3d, setView3d] = useState(false)
  const [selected3d, setSelected3d] = useState<N3 | null>(null)

  const allCategories = eventOn ? [...graphCategories, eventCategory] : graphCategories

  const option = useMemo(() => {
    let nodes: GraphNode[] = graphNodes.filter(n => (proj === 'all' || nodeProject[n.id] === proj))
    let edges = [...graphEdges]
    if (eventOn && (proj === 'all' || proj === 'power')) {
      nodes = [...nodes, ...(eventDemo.nodes as GraphNode[])]
      edges = [...edges, ...eventDemo.edges]
    }
    const visibleNodes = nodes.filter(n => enabled.has(n.category) && (!kw || n.name.includes(kw)))
    const ids = new Set(visibleNodes.map(n => n.id))
    const visibleEdges = edges.filter(e => ids.has(e.source) && ids.has(e.target))
    const neighbors = selected ? new Set([selected.id, ...visibleEdges.filter(e => e.source === selected.id || e.target === selected.id).flatMap(e => [e.source, e.target])]) : null

    return {
      tooltip: {
        formatter: (p: any) => p.dataType === 'node'
          ? `<b>${p.data.name}</b><br/><span style="color:#94a3b8">${p.data.desc || ''}</span>`
          : `${p.data.relation}`,
      },
      legend: { show: false },
      series: [{
        type: 'graph',
        layout: 'force',
        roam: true,
        draggable: true,
        force: { repulsion: 320, edgeLength: [70, 130], gravity: 0.08 },
        label: { show: true, fontSize: 11, color: '#475569', position: 'bottom' },
        categories: allCategories.map(c => ({ name: c.name, itemStyle: { color: c.color } })),
        data: visibleNodes.map(n => ({
          ...n,
          symbolSize: n.category === 6 ? 30 : n.category === 0 ? 34 : n.category === 1 ? 24 : 20,
          itemStyle: {
            opacity: neighbors ? (neighbors.has(n.id) ? 1 : 0.25) : 0.95,
            borderColor: n.category === 6 ? '#FCA5A5' : '#fff', borderWidth: 2,
            shadowBlur: n.category === 6 ? 14 : 6, shadowColor: n.category === 6 ? 'rgba(239,68,68,0.4)' : 'rgba(51,112,255,0.15)',
          },
          label: { color: neighbors && !neighbors.has(n.id) ? '#cbd5e1' : n.category === 6 ? '#DC2626' : '#475569' },
        })),
        links: visibleEdges.map(e => ({
          ...e,
          lineStyle: {
            color: e.source === 'ev1' || e.target === 'ev1' || e.source === 'mem1' ? '#EF4444' : '#cbd5e1',
            width: e.source === 'ev1' || e.source === 'mem1' ? 2 : 1.5,
            type: e.source === 'mem1' ? 'dashed' : 'solid',
            curveness: 0.08,
            opacity: neighbors ? ((e.source === selected?.id || e.target === selected?.id) ? 0.9 : 0.15) : 0.75,
          },
          label: { show: true, formatter: e.relation, fontSize: 10, color: e.source === 'ev1' || e.source === 'mem1' ? '#EF4444' : '#94a3b8' },
        })),
        emphasis: { focus: 'adjacency', lineStyle: { width: 3 } },
      }],
    } as any
  }, [enabled, kw, selected, proj, eventOn])

  const twin3dNodes = useMemo<N3[]>(() => {
    const optionNodes = (option.series as Array<{ data: GraphNode[] }>)[0]?.data ?? []
    const twinNode: N3 = { id: 'twin', name: '企业数字孪生', group: 'core', color: '#3370ff', val: 10, tip: '企业图谱 · 关系实时同步' }
    const optionEdges = ((option.series as Array<{ links: Array<{ source: string; target: string; relation: string }> }>)[0]?.links ?? [])
    const connectedNodes = optionNodes
      .map(node => ({
        id: node.id,
        name: node.name,
        group: allCategories[node.category]?.name || '实体',
        color: allCategories[node.category]?.color || '#60a5fa',
        val: node.category === 0 ? 5 : node.category === 6 ? 4 : 2.5,
        tip: node.desc || allCategories[node.category]?.name || '业务实体',
        connected: optionEdges.some(edge => edge.source === node.id || edge.target === node.id),
      }))
      .filter(node => node.connected)
      .map(({ connected: _connected, ...node }) => node)

    return [twinNode, ...connectedNodes]
  }, [allCategories, option])

  const twin3dLinks = useMemo(() => (
    ((option.series as Array<{ links: Array<{ source: string; target: string; relation: string }> }>)[0]?.links ?? [])
      .map(edge => ({ source: edge.source, target: edge.target, rel: edge.relation }))
  ), [option])

  const stats = useMemo(() => {
    const nodes = graphNodes.filter(n => proj === 'all' || nodeProject[n.id] === proj)
    const ids = new Set(nodes.map(n => n.id))
    return { nodes: nodes.length, edges: graphEdges.filter(e => ids.has(e.source) && ids.has(e.target)).length }
  }, [proj])

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-800 flex items-center gap-2">知识图谱中心<span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 font-normal">产品壳演示 · 五域引擎暂无对应能力，暂不对接</span></h1>
          <p className="text-sm text-slate-500 mt-1">按项目/行业查看图谱 · 事件与经验沉淀实时动态关联</p>
        </div>
        <div className="flex gap-2">
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input value={kw} onChange={e => setKw(e.target.value)} placeholder="搜索实体…"
              className="pl-9 pr-3 py-2 text-sm border border-slate-200 rounded-lg bg-white w-48 focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-300" />
          </div>
          <button onClick={() => setEventOn(v => {
            const next = !v
            setEnabled(s => { const n = new Set(s); next ? n.add(6) : n.delete(6); return n })
            return next
          })}
            className={`text-sm px-4 py-2 rounded-lg flex items-center gap-1.5 transition ${eventOn ? 'bg-red-600 text-white hover:bg-red-700' : 'bg-white border border-red-200 text-red-600 hover:bg-red-50'}`}>
            {eventOn ? <><X size={14} />关闭事件演示</> : <><Zap size={14} />模拟报警事件</>}
          </button>
        </div>
      </div>

      {/* 项目分栏 */}
      <div className="flex gap-2 flex-wrap items-center">
        {[{ id: 'all', name: '全部项目' }, ...tenantProjects.map(p => ({ id: p.id, name: p.name }))].map(t => (
          <button key={t.id} onClick={() => { setProj(t.id); setSelected(null) }}
            className={`text-sm px-4 py-2 rounded-lg border transition ${proj === t.id ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-600 border-slate-200 hover:border-blue-300'}`}>
            {t.name}
          </button>
        ))}
        <span className="text-xs text-slate-400 ml-2">当前视图：{stats.nodes} 实体 · {stats.edges} 关系</span>
      </div>

      {/* 事件叙事条 */}
      {eventOn && (
        <div className="bg-red-50 border border-red-200 rounded-xl px-5 py-4" style={{ animation: 'fadeSlide .3s ease' }}>
          <div className="flex items-center gap-2 mb-1.5">
            <Zap size={15} className="text-red-600" />
            <span className="text-sm font-medium text-red-700">{eventDemo.title}</span>
          </div>
          <p className="text-xs text-red-600/80 leading-relaxed">{eventDemo.narrative}</p>
        </div>
      )}

      {/* 本体过滤 */}
      <div className="flex gap-2 flex-wrap">
        {allCategories.map((c, i) => {
          const on = enabled.has(i)
          return (
            <button key={c.name} onClick={() => setEnabled(s => { const n = new Set(s); n.has(i) ? n.delete(i) : n.add(i); return n })}
              className={`text-xs px-3 py-1.5 rounded-full border transition flex items-center gap-1.5 ${on ? 'bg-white border-slate-300 text-slate-700' : 'bg-slate-50 border-slate-200 text-slate-400'}`}>
              <span className="w-2 h-2 rounded-full" style={{ background: on ? c.color : '#cbd5e1' }} />
              {c.name}
            </button>
          )
        })}
      </div>

      <div className="flex gap-2 flex-wrap items-center">
        <button onClick={() => setView3d(false)}
          className={`text-sm px-4 py-2 rounded-lg border transition ${view3d ? 'bg-white text-slate-600 border-slate-200 hover:border-blue-300' : 'bg-blue-600 text-white border-blue-600'}`}>
          2D 图谱
        </button>
        <button onClick={() => { setView3d(true); setSelected3d(null) }}
          className={`text-sm px-4 py-2 rounded-lg border transition ${view3d ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-600 border-slate-200 hover:border-blue-300'}`}>
          3D 企业数字孪生
        </button>
      </div>

      {view3d ? (
        <div className="grid lg:grid-cols-[1fr_300px] gap-4">
          <div className="bg-slate-950 rounded-xl border border-slate-800 p-2">
            <TwinGraph3D key="platform-twin" nodes={twin3dNodes} links={twin3dLinks} onPick={setSelected3d} />
          </div>
          <div className="bg-white rounded-xl border border-slate-200/80 p-5 self-start">
            {selected3d ? (
              <>
                <span className="text-xs px-2 py-0.5 rounded" style={{ background: `${selected3d.color}1a`, color: selected3d.color }}>
                  {selected3d.group === 'core' ? '孪生核心' : selected3d.group}
                </span>
                <h3 className="font-semibold text-slate-800 mt-2.5">{selected3d.name}</h3>
                <p className="text-sm text-slate-500 mt-2 leading-relaxed">{selected3d.tip}</p>
              </>
            ) : (
              <div className="py-14 text-center">
                <p className="text-sm text-slate-500">点击 3D 节点查看实体详情</p>
                <p className="text-xs text-slate-400 mt-1">支持拖拽旋转、滚轮缩放与悬停提示</p>
              </div>
            )}
          </div>
        </div>
      ) : (
      <div className="grid lg:grid-cols-[1fr_300px] gap-4">
        <div className="bg-white rounded-xl border border-slate-200/80 p-2">
          <EChart option={option} height={520} onNodeClick={(p: any) => {
            if (p.dataType === 'node') {
              const all = eventOn ? [...graphNodes, ...(eventDemo.nodes as GraphNode[])] : graphNodes
              setSelected(all.find(n => n.id === p.data.id) || null)
            }
          }} />
        </div>

        <div className="space-y-4">
          <div className="bg-white rounded-xl border border-slate-200/80 p-5 min-h-[220px]">
            {selected ? (
              <>
                <span className="text-xs px-2 py-0.5 rounded" style={{ background: allCategories[selected.category].color + '1a', color: allCategories[selected.category].color }}>
                  {allCategories[selected.category].name}
                </span>
                <h3 className="font-semibold text-slate-800 mt-2.5">{selected.name}</h3>
                {selected.value && <div className="text-2xl font-semibold text-blue-600 mt-2">{selected.value}</div>}
                <p className="text-sm text-slate-500 mt-2 leading-relaxed">{selected.desc}</p>
                <div className="mt-4 space-y-2">
                  <button onClick={() => go('agent')} className="w-full text-sm px-3 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 flex items-center justify-center gap-1.5">
                    <MessageSquareText size={14} /> 对该实体发起问答
                  </button>
                  <button className="w-full text-sm px-3 py-2 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 flex items-center justify-center gap-1.5">
                    <BellPlus size={14} /> 绑定实时监控规则
                  </button>
                  <button onClick={() => go('space')} className="w-full text-sm px-3 py-2 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 flex items-center justify-center gap-1.5">
                    <BrainCircuit size={14} /> 查看关联记忆
                  </button>
                </div>
              </>
            ) : (
              <div className="h-full flex flex-col items-center justify-center text-center py-10">
                <div className="w-12 h-12 rounded-full bg-blue-50 flex items-center justify-center mb-3"><Search size={20} className="text-blue-400" /></div>
                <p className="text-sm text-slate-500">点击图谱节点查看实体详情</p>
                <p className="text-xs text-slate-400 mt-1">支持拖拽、缩放、搜索与本体过滤</p>
              </div>
            )}
          </div>

          <div className="bg-white rounded-xl border border-slate-200/80 p-5">
            <h4 className="text-sm font-medium text-slate-800 mb-3">图谱覆盖度</h4>
            {[['能源电力 · DCS', 92], ['流程制造 · 五系统', 74], ['家装服务 · CRM', 81]].map(([k, v]) => (
              <div key={k as string} className="mb-3 last:mb-0">
                <div className="flex justify-between text-xs text-slate-500 mb-1"><span>{k}</span><span>{v}%</span></div>
                <div className="h-1.5 bg-slate-100 rounded-full"><div className="h-1.5 bg-blue-500 rounded-full" style={{ width: `${v}%` }} /></div>
              </div>
            ))}
          </div>
        </div>
      </div>
      )}
      <style>{`@keyframes fadeSlide { from { opacity: 0; transform: translateY(4px);} to { opacity: 1; transform: none; } }`}</style>
    </div>
  )
}
