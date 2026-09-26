import { useEffect, useRef } from 'react'
import * as echarts from 'echarts'

export default function EChart({
  option,
  height = 420,
  onNodeClick,
}: {
  option: echarts.EChartsOption
  height?: number
  onNodeClick?: (params: any) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const chartRef = useRef<echarts.ECharts | null>(null)

  useEffect(() => {
    if (!ref.current) return
    const chart = echarts.init(ref.current)
    chartRef.current = chart
    const resize = () => chart.resize()
    window.addEventListener('resize', resize)
    return () => {
      window.removeEventListener('resize', resize)
      chart.dispose()
    }
  }, [])

  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    chart.setOption(option, true)
    chart.off('click')
    if (onNodeClick) chart.on('click', onNodeClick)
  }, [option, onNodeClick])

  return <div ref={ref} style={{ height, width: '100%' }} />
}
