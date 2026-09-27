import { useEffect, useState } from 'react'
import EChart from '../components/EChart'
import { opsStats, opsCatShare, opsToken, opsTasks } from '../mock/data'
import { fetchMetrics, fetchUsage, type MetricsPayload, type UsagePayload } from '../lib/harness'
import { CheckCircle2, Clock, Wallet, TrendingUp, Radio } from 'lucide-react'

const fmtUptime = (ms: number) => {
  const m = Math.floor(ms / 60000)
  return m >= 60 ? `${Math.floor(m / 60)} 小时 ${m % 60} 分` : `${m} 分钟`
}

export default function OpsPage() {
  const [range, setRange] = useState('本周')
  const [tasks, setTasks] = useState(opsTasks)
  const [metrics, setMetrics] = useState<MetricsPayload | null>(null)
  const [usage, setUsage] = useState<UsagePayload | null>(null)

  useEffect(() => {
    const load = () => { fetchMetrics().then(setMetrics).catch(() => {}); fetchUsage().then(setUsage).catch(() => {}) }
    load()
    const t = setInterval(load, 15000)
    return () => clearInterval(t)
  }, [])

  // 趋势图（真 · token-metering byDay）：调用次数 + Token 消耗双系列
  const realDays = usage?.summary?.byDay ?? []
  const trendOption = {
    tooltip: { trigger: 'axis' },
    legend: { data: ['LLM 调用', 'Token 消耗'], textStyle: { fontSize: 11, color: '#64748b' }, top: 0, right: 0 },
    grid: { left: 52, right: 52, top: 32, bottom: 24 },
    xAxis: { type: 'category', data: realDays.map(d => d.key), axisLine: { lineStyle: { color: '#e2e8f0' } }, axisLabel: { fontSize: 11, color: '#94a3b8' } },
    yAxis: [
      { type: 'value', name: '调用', splitLine: { lineStyle: { color: '#f1f5f9' } }, axisLabel: { fontSize: 10, color: '#94a3b8' } },
      { type: 'value', name: 'Token', splitLine: { show: false }, axisLabel: { fontSize: 10, color: '#94a3b8' } },
    ],
    series: [
      { name: 'LLM 调用', type: 'line', smooth: true, yAxisIndex: 0, data: realDays.map(d => d.calls), lineStyle: { width: 2.5, color: '#3370FF' }, itemStyle: { color: '#3370FF' }, areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: 'rgba(51,112,255,.18)' }, { offset: 1, color: 'rgba(51,112,255,0)' }] } }, symbolSize: 5 },
      { name: 'Token 消耗', type: 'line', smooth: true, yAxisIndex: 1, data: realDays.map(d => d.totalTokens), lineStyle: { width: 2.5, color: '#14C0FF' }, itemStyle: { color: '#14C0FF' }, symbolSize: 5 },
    ],
  }

  const donutOption = {
    tooltip: { trigger: 'item', formatter: '{b}: {c}%' },
    legend: { orient: 'vertical', right: 8, top: 'center', textStyle: { fontSize: 11, color: '#64748b' }, itemWidth: 10, itemHeight: 10 },
    series: [{
      type: 'pie', radius: ['52%', '74%'], center: ['36%', '50%'],
      label: { show: false },
      data: opsCatShare,
      color: ['#3370FF', '#0EA5E9', '#14C0FF', '#F59E0B', '#10B981', '#F43F5E'],
      itemStyle: { borderColor: '#fff', borderWidth: 2, borderRadius: 4 },
    }],
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-800">运营驾驶舱</h1>
          <p className="text-sm text-slate-500 mt-1">调用量 · Token · 成功率 · 命中率一屏总览 —— 平台可运营、可计量、可复制</p>
        </div>
        <div className="flex bg-slate-100 rounded-lg p-1">
          {['今天', '本周', '本月'].map(r => (
            <button key={r} onClick={() => setRange(r)}
              className={`text-xs px-4 py-1.5 rounded-md transition ${range === r ? 'bg-white text-slate-800 shadow-sm font-medium' : 'text-slate-500'}`}>{r}</button>
          ))}
        </div>
      </div>

      {/* 实时运行指标（真）：服务端内存计数, 15s 轮询 */}
      {metrics && (
        <div className="bg-white rounded-xl border border-emerald-200 ring-1 ring-emerald-100/60 p-5" style={{ animation: 'fadeSlide .3s ease' }}>
          <div className="flex items-center gap-2 mb-3">
            <Radio size={14} className="text-emerald-500" />
            <h2 className="text-sm font-semibold text-slate-700">实时运行指标</h2>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-600 border border-emerald-100">真 · 15s 自动刷新</span>
            <span className="text-[11px] text-slate-400 ml-auto">LLM 上游 {metrics.llm} · 运行 {fmtUptime(metrics.uptimeMs)}</span>
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {[
              { l: '引擎原生角色', v: `${metrics.personas} 个` },
              { l: '已发布数字员工', v: `${metrics.skills} 个` },
              { l: 'LLM 调用（真计量）', v: `${usage?.summary?.calls ?? 0} 次` },
              { l: 'Token 消耗（真计量）', v: (usage?.summary?.totalTokens ?? 0).toLocaleString() },
            ].map(s => (
              <div key={s.l} className="rounded-lg border border-slate-100 bg-slate-50/60 p-3">
                <div className="text-xs text-slate-400">{s.l}</div>
                <div className="text-lg font-semibold text-slate-800 mt-0.5">{s.v}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-500">以下图表为演示数据</span>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {opsStats.map(s => (
          <div key={s.label} className="bg-white rounded-xl border border-slate-200/80 p-4">
            <div className="text-xs text-slate-400">{s.label}</div>
            <div className="text-xl font-semibold text-slate-800 mt-1">{s.value}</div>
            <div className="text-[11px] text-slate-400 mt-1 flex items-center gap-1">
              <TrendingUp size={11} className={s.delta.startsWith('-') ? 'text-emerald-500' : 'text-blue-500'} />{s.delta}
            </div>
          </div>
        ))}
      </div>

      <div className="grid lg:grid-cols-[1.6fr_1fr] gap-4">
        <div className="bg-white rounded-xl border border-slate-200/80 p-5">
          <div className="font-medium text-slate-800 text-sm mb-2 flex items-center justify-between flex-wrap gap-1">
            <span>调用与 Token 趋势 <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-50 text-emerald-600 border border-emerald-100 align-middle">真</span></span>
            {realDays.length === 0 && <span className="text-[11px] text-slate-400 font-normal">暂无数据，对话后按日累计</span>}
          </div>
          <EChart option={trendOption as any} height={260} />
        </div>
        <div className="bg-white rounded-xl border border-slate-200/80 p-5">
          <div className="font-medium text-slate-800 text-sm mb-2">分类调用占比</div>
          <EChart option={donutOption as any} height={260} />
        </div>
      </div>

      <div className="grid lg:grid-cols-[1fr_1.2fr] gap-4">
        {/* Token 计量 */}
        <div className="bg-gradient-to-br from-slate-800 to-slate-900 rounded-xl p-5 text-white">
          <div className="flex items-center gap-2 mb-4"><Wallet size={15} className="text-blue-300" /><span className="text-sm font-medium">Token 用量 · 计量计费</span></div>
          <div className="grid grid-cols-2 gap-4 mb-4">
            <div>
              <div className="text-[11px] text-slate-400">Token 余额</div>
              <div className="text-xl font-semibold mt-0.5">{opsToken.balance}</div>
            </div>
            <div>
              <div className="text-[11px] text-slate-400">今日消耗</div>
              <div className="text-xl font-semibold mt-0.5">{opsToken.today}</div>
            </div>
          </div>
          <div className="h-1.5 bg-slate-700 rounded-full overflow-hidden mb-2">
            <div className="h-full w-[86%] rounded-full bg-gradient-to-r from-blue-500 to-cyan-300" />
          </div>
          <p className="text-[11px] text-slate-400">{opsToken.forecast} · 按项目/租户分摊出账，集成商可对下游客户二次计量</p>
        </div>

        {/* 今日任务 */}
        <div className="bg-white rounded-xl border border-slate-200/80 p-5">
          <div className="font-medium text-slate-800 text-sm mb-4">今日任务</div>
          <div className="space-y-3">
            {tasks.map((t, i) => (
              <button key={i} onClick={() => setTasks(list => list.map((x, j) => j === i ? { ...x, done: !x.done } : x))}
                className="w-full text-left flex items-start gap-3">
                {t.done ? <CheckCircle2 size={17} className="text-emerald-500 mt-0.5 shrink-0" /> : <Clock size={17} className="text-amber-500 mt-0.5 shrink-0" />}
                <div className="flex-1">
                  <div className={`text-sm ${t.done ? 'text-slate-400 line-through' : 'text-slate-700'}`}>{t.text}</div>
                  <div className="text-[11px] text-slate-400 mt-0.5">来源：{t.from}{t.due ? ` · 截止 ${t.due}` : ''}</div>
                </div>
              </button>
            ))}
          </div>
          <div className="mt-4 pt-4 border-t border-slate-50 text-[11px] text-slate-400 leading-relaxed">
            任务由智能体工厂、知识库、审批中心自动派发 —— 运营动作同样沉淀为记忆
          </div>
        </div>
      </div>
    </div>
  )
}
