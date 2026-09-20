import { useEffect, useRef } from 'react'
import * as echarts from 'echarts'
import { INDUSTRY_TREE } from '@/data/mock'

const INDUSTRY_COLORS: Record<string, string> = {
  '化工': '#3370ff',
  '能源电力': '#059669',
  '医疗': '#dc2626',
  '家装服务': '#d97706',
}

/** 行业本体知识图谱：行业 → 子行业 → 本体知识条目 */
export function OntologyGraph() {
  const ref = useRef<HTMLDivElement>(null)
  const chartRef = useRef<echarts.ECharts | null>(null)

  useEffect(() => {
    if (!ref.current) return

    const data = {
      name: '行业机理知识库',
      children: INDUSTRY_TREE.map(g => ({
        name: g.industry,
        itemStyle: { color: INDUSTRY_COLORS[g.industry] ?? '#3370ff' },
        children: g.children.map(c => ({
          name: `${c.name}（${c.ontologyCount}）`,
          value: c.ontologyCount,
          fromProjects: c.fromProjects,
          itemStyle: { color: INDUSTRY_COLORS[g.industry] ?? '#3370ff' },
          children: c.samples.map(s => ({
            name: s,
            itemStyle: { color: INDUSTRY_COLORS[g.industry] ?? '#3370ff', opacity: 0.55 },
          })),
        })),
      })),
    }

    const chart = echarts.init(ref.current)
    chartRef.current = chart
    chart.setOption({
      tooltip: {
        trigger: 'item',
        triggerOn: 'mousemove',
        backgroundColor: '#fff',
        borderColor: '#e2e8f0',
        textStyle: { color: '#334155', fontSize: 12 },
        formatter: (p: any) => {
          const d = p.data
          let html = `<b>${p.name}</b>`
          if (d.value) html += `<br/>本体知识：<b>${d.value}</b> 条`
          if (d.fromProjects) html += `<br/>沉淀自：${d.fromProjects.join('、')}`
          return html
        },
      },
      series: [{
        type: 'tree',
        data: [data],
        left: '12%',
        right: '26%',
        top: '2%',
        bottom: '2%',
        symbol: 'circle',
        symbolSize: (_v: any, params: any) => {
          const depth = params.treeAncestors.length
          return depth === 1 ? 18 : depth === 2 ? 12 : depth === 3 ? 8 : 5
        },
        itemStyle: { color: '#0f172a', borderColor: '#fff', borderWidth: 1.5 },
        label: {
          position: 'left',
          verticalAlign: 'middle',
          align: 'right',
          fontSize: 13,
          fontWeight: 600,
          color: '#0f172a',
        },
        leaves: {
          label: {
            position: 'right',
            verticalAlign: 'middle',
            align: 'left',
            fontSize: 11,
            fontWeight: 400,
            color: '#64748b',
          },
        },
        emphasis: { focus: 'descendant' },
        expandAndCollapse: true,
        initialTreeDepth: 2,
        animationDuration: 400,
        animationDurationUpdate: 500,
        lineStyle: { color: '#c6d4e4', width: 1.2, curveness: 0.5 },
      }],
    })

    const onResize = () => chart.resize()
    window.addEventListener('resize', onResize)
    const ro = new ResizeObserver(onResize)
    ro.observe(ref.current)
    return () => {
      window.removeEventListener('resize', onResize)
      ro.disconnect()
      chart.dispose()
    }
  }, [])

  return (
    <div className="overflow-x-auto">
      <div ref={ref} className="min-w-[640px]" style={{ height: 600 }} />
      <p className="px-1 pb-2 text-xs text-slate-400">点击行业节点可展开/收起到本体知识条目 · 悬停查看沉淀来源 · 节点大小与知识量无关，仅分层级</p>
    </div>
  )
}
