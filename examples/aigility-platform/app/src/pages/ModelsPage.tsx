import { useEffect, useState } from 'react'
import { models } from '../mock/data'
import EChart from '../components/EChart'
import { fetchLlmStatus, type LlmStatus } from '../lib/harness'
import { Cpu, X, KeyRound, Gauge, CheckCircle2, TrendingUp, Radio } from 'lucide-react'
import type { ModelInfo } from '../mock/data'

const typeColor: Record<string, string> = {
  通用语言模型: 'bg-blue-50 text-blue-600', 代码模型: 'bg-sky-50 text-sky-600', 视觉模型: 'bg-amber-50 text-amber-600',
  向量模型: 'bg-emerald-50 text-emerald-600', 重排序模型: 'bg-cyan-50 text-cyan-600',
}

export default function ModelsPage() {
  const [list, setList] = useState(models)
  const [detail, setDetail] = useState<ModelInfo | null>(null)
  const [llm, setLlm] = useState<LlmStatus | null>(null)

  useEffect(() => {
    fetchLlmStatus().then(setLlm).catch(() => {})
  }, [])

  const enabled = list.filter(m => m.status === '已启用')
  const avgLatency = Math.round(enabled.reduce((s, m) => s + m.latencyMs, 0) / enabled.length)
  const avgSuccess = (enabled.reduce((s, m) => s + m.successRate, 0) / enabled.length).toFixed(1)

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-800">模型管理</h1>
          <p className="text-sm text-slate-500 mt-1">多模型接入与路由 —— 语言/代码/视觉/向量/重排序，私有推理、统一计量；TiMEM 向量与重排序模型是上下文召回的底座</p>
        </div>
        <button className="text-sm px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700">接入自有模型</button>
      </div>

      {/* 当前推理上游（真）：D2 llm-inference 实际生效配置 */}
      {llm && (
        <div className="bg-white rounded-xl border border-emerald-200 ring-1 ring-emerald-100/60 p-5" style={{ animation: 'fadeSlide .3s ease' }}>
          <div className="flex items-center gap-2 flex-wrap">
            <Radio size={14} className="text-emerald-500" />
            <h2 className="text-sm font-semibold text-slate-700">当前引擎推理上游</h2>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-600 border border-emerald-100">真 · D2 llm-inference 生效配置</span>
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mt-3 text-xs">
            <div className="rounded-lg border border-slate-100 bg-slate-50/60 p-3"><div className="text-slate-400">Provider</div><div className="text-slate-800 font-semibold mt-0.5">{llm.provider}</div></div>
            <div className="rounded-lg border border-slate-100 bg-slate-50/60 p-3"><div className="text-slate-400">默认模型</div><div className="text-slate-800 font-semibold mt-0.5">{llm.model}</div></div>
            <div className="rounded-lg border border-slate-100 bg-slate-50/60 p-3 min-w-0"><div className="text-slate-400">上游地址</div><div className="text-slate-800 font-semibold mt-0.5 truncate">{llm.baseUrl || '—'}</div></div>
            <div className="rounded-lg border border-slate-100 bg-slate-50/60 p-3"><div className="text-slate-400">状态</div><div className={`font-semibold mt-0.5 ${llm.degraded ? 'text-amber-600' : 'text-emerald-600'}`}>{llm.degraded ? 'stub 降级' : '真实推理'}</div></div>
          </div>
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-500">以下模型矩阵为演示数据</span>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { l: '已启用模型', v: `${enabled.length} / ${list.length}` },
          { l: '今日总调用', v: '126.8 万次' },
          { l: '平均延迟', v: `${avgLatency}ms` },
          { l: '综合成功率', v: `${avgSuccess}%` },
        ].map(s => (
          <div key={s.l} className="bg-white rounded-xl border border-slate-200/80 p-4">
            <div className="text-xs text-slate-400">{s.l}</div>
            <div className="text-xl font-semibold text-slate-800 mt-1">{s.v}</div>
          </div>
        ))}
      </div>

      <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
        {list.map(m => {
          const max = Math.max(...m.trend)
          return (
            <div key={m.id} className={`bg-white rounded-xl border p-5 transition hover:shadow-md ${m.status === '已停用' ? 'border-slate-200/80 opacity-75' : 'border-slate-200/80'}`}>
              <div className="flex items-start justify-between mb-2">
                <div className="flex items-center gap-2.5">
                  <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${m.provider.includes('TiMEM') ? 'bg-sky-50 text-sky-600' : 'bg-blue-50 text-blue-600'}`}><Cpu size={17} /></div>
                  <div>
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium text-slate-800 text-sm">{m.name}</span>
                      {m.isDefault && <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-white">默认</span>}
                    </div>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded ${typeColor[m.type] || 'bg-slate-100 text-slate-500'}`}>{m.type}</span>
                  </div>
                </div>
                <button onClick={() => setList(ls => ls.map(x => x.id === m.id ? { ...x, status: x.status === '已启用' ? '已停用' : '已启用' } : x))}
                  className={`w-10 h-[22px] rounded-full transition relative ${m.status === '已启用' ? 'bg-blue-600' : 'bg-slate-200'}`}>
                  <span className={`absolute top-[3px] w-4 h-4 rounded-full bg-white shadow transition-all ${m.status === '已启用' ? 'left-[22px]' : 'left-[3px]'}`} />
                </button>
              </div>
              <p className="text-xs text-slate-500 leading-relaxed mb-3 min-h-[32px]">{m.description}</p>
              {/* 7 日趋势 sparkline */}
              <div className="flex items-end gap-1 h-8 mb-3">
                {m.trend.map((v, i) => (
                  <div key={i} className={`flex-1 rounded-sm ${m.status === '已启用' ? 'bg-blue-200' : 'bg-slate-200'}`} style={{ height: `${(v / max) * 100}%` }} />
                ))}
              </div>
              <div className="grid grid-cols-3 gap-2 text-center text-[11px] mb-3">
                <div><div className="text-slate-400">延迟</div><div className="text-slate-700 font-medium">{m.latencyMs}ms</div></div>
                <div><div className="text-slate-400">成功率</div><div className="text-slate-700 font-medium">{m.successRate}%</div></div>
                <div><div className="text-slate-400">调用量</div><div className="text-slate-700 font-medium">{m.calls}</div></div>
              </div>
              <div className="flex items-center justify-between pt-3 border-t border-slate-50">
                <span className="text-[11px] text-slate-400">¥{m.pricePer1k}/千 Token · 上下文 {m.contextLength}</span>
                <button onClick={() => setDetail(m)} className="text-xs px-3 py-1.5 rounded-lg border border-slate-200 text-slate-600 hover:border-blue-300 hover:text-blue-600">详情</button>
              </div>
            </div>
          )
        })}
      </div>

      {/* 详情抽屉 */}
      {detail && (
        <div className="fixed inset-0 z-40 flex justify-end" onClick={() => setDetail(null)}>
          <div className="absolute inset-0 bg-slate-900/20" />
          <div className="relative w-full max-w-md bg-white h-full shadow-2xl p-6 overflow-y-auto" onClick={e => e.stopPropagation()} style={{ animation: 'slideIn .25s ease' }}>
            <div className="flex items-start justify-between mb-5">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-lg font-semibold text-slate-800">{detail.name}</h2>
                  {detail.isDefault && <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-white">默认</span>}
                </div>
                <div className="text-xs text-slate-400 mt-1">{detail.type} · {detail.provider}</div>
              </div>
              <button onClick={() => setDetail(null)} className="w-8 h-8 rounded-lg border border-slate-200 flex items-center justify-center text-slate-400 hover:bg-slate-50"><X size={15} /></button>
            </div>
            <p className="text-sm text-slate-600 leading-relaxed mb-5">{detail.description}</p>
            <div className="space-y-3 mb-5">
              {[['每千 Token 价格', `¥${detail.pricePer1k}`], ['上下文长度', detail.contextLength], ['限流', '5000 并发 · 按租户配额'], ['更新时间', detail.updatedAt]].map(([k, v]) => (
                <div key={k} className="flex justify-between text-xs"><span className="text-slate-400">{k}</span><span className="text-slate-700 font-medium">{v}</span></div>
              ))}
              <div className="flex justify-between text-xs items-center">
                <span className="text-slate-400 flex items-center gap-1"><KeyRound size={11} />API 密钥</span>
                <code className="text-slate-700">sk-••••••••••••3f9a <button className="text-blue-600 ml-1">重置</button></code>
              </div>
            </div>
            <div className="mb-5">
              <div className="text-xs text-slate-400 mb-2 flex items-center gap-1"><TrendingUp size={12} />近 7 日调用趋势</div>
              <EChart height={150} option={{
                grid: { left: 30, right: 8, top: 8, bottom: 20 },
                xAxis: { type: 'category', data: ['D-6', 'D-5', 'D-4', 'D-3', 'D-2', 'D-1', '今天'], axisLabel: { fontSize: 10, color: '#94a3b8' }, axisLine: { lineStyle: { color: '#e2e8f0' } } },
                yAxis: { type: 'value', splitLine: { lineStyle: { color: '#f1f5f9' } }, axisLabel: { fontSize: 10, color: '#94a3b8' } },
                series: [{ type: 'line', smooth: true, data: detail.trend, lineStyle: { color: '#3370FF', width: 2 }, itemStyle: { color: '#3370FF' }, areaStyle: { color: 'rgba(51,112,255,.12)' }, symbolSize: 4 }],
              } as any} />
            </div>
            <div>
              <div className="text-xs text-slate-400 mb-2 flex items-center gap-1"><Gauge size={12} />近期调用日志</div>
              <div className="space-y-2 text-[11px] font-mono text-slate-500 bg-slate-50 rounded-lg p-3">
                <div>14:32:07 chat.completions <span className="text-emerald-600">200</span> 812ms</div>
                <div>14:31:55 embeddings <span className="text-emerald-600">200</span> 38ms</div>
                <div>14:31:40 chat.completions <span className="text-emerald-600">200</span> 1.2s</div>
                <div>14:30:58 rerank <span className="text-amber-600">429 限流重试</span> → 成功</div>
              </div>
              <div className="text-[11px] text-slate-400 mt-3 flex items-center gap-1"><CheckCircle2 size={11} className="text-emerald-500" />全部调用留在私有推理域内，数据不出域</div>
            </div>
          </div>
        </div>
      )}
      <style>{`@keyframes slideIn { from { transform: translateX(40px); opacity: 0; } to { transform: none; opacity: 1; } }`}</style>
    </div>
  )
}
