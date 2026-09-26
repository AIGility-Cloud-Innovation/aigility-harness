import EChart from './EChart'
import { flowCanvas } from '../mock/data'

/** 低代码编排画布（DAG：开始→检索/本体→推理→置信度分支→输出/转人工） */
export default function FlowCanvas({ height = 290 }: { height?: number }) {
  const option = {
    tooltip: { show: false },
    series: [{
      type: 'graph', layout: 'none', roam: false,
      symbol: 'roundRect', symbolSize: [104, 40],
      label: { show: true, color: '#fff', fontSize: 12, fontWeight: 500 },
      edgeSymbol: ['none', 'arrow'], edgeSymbolSize: 8,
      lineStyle: { color: '#CBD5E1', width: 1.5, curveness: 0.08 },
      edgeLabel: { show: true, fontSize: 10, color: '#F59E0B', fontWeight: 600 },
      data: flowCanvas.nodes.map(n => ({ id: n.id, name: n.name, x: n.x, y: n.y, itemStyle: { color: n.c, borderRadius: 8, shadowBlur: 6, shadowColor: 'rgba(15,23,42,.12)' } })),
      links: flowCanvas.edges.map(e => ({ source: e.source, target: e.target, label: e.label ? { show: true, formatter: e.label } : { show: false } })),
    }],
  }
  return (
    <div className="border border-slate-200 rounded-xl bg-[#FAFBFC] overflow-hidden">
      <EChart option={option as any} height={height} />
    </div>
  )
}
