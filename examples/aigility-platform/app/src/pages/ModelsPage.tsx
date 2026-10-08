import { useEffect, useMemo, useState } from 'react'
import { fetchLlmStatus, fetchLlmModels, type LlmStatus, type GatewayModelEntry } from '../lib/harness'
import { Cpu, Radio, Activity, Layers, ShieldCheck, AlertTriangle } from 'lucide-react'
import LlmNodeConfig from '../components/LlmNodeConfig'

/** 供应商 → 卡片配色（与网关 config.yaml 的 model_name 前缀分组一致） */
const providerColor: Record<string, string> = {
  '金山云 KSyun': 'bg-blue-50 text-blue-600',
  '智谱 BigModel': 'bg-sky-50 text-sky-600',
  '阿里云 DashScope': 'bg-amber-50 text-amber-600',
  '商汤 SenseNova': 'bg-violet-50 text-violet-600',
  'Claude 兼容别名': 'bg-slate-100 text-slate-600',
  '本机 Ollama': 'bg-emerald-50 text-emerald-600',
}

const tok = (n?: number): string => (n ? (n >= 1000 ? `${Math.round(n / 100) / 10}K` : String(n)) : '—')

export default function ModelsPage() {
  const [llm, setLlm] = useState<LlmStatus | null>(null)
  const [gw, setGw] = useState<{ entries: GatewayModelEntry[]; health?: { healthy: number; unhealthy: number } } | null>(null)
  const [gwError, setGwError] = useState('')

  useEffect(() => {
    fetchLlmStatus().then(setLlm).catch(() => {})
    fetchLlmModels().then((r) => {
      if (r.ok) setGw({ entries: r.entries ?? [], health: r.health })
      else setGwError(r.error ?? '网关模型池不可达')
    }).catch((e) => setGwError(String(e)))
  }, [])

  // 供应商分组（按网关 model_name 前缀）
  const groups = useMemo(() => {
    const map = new Map<string, GatewayModelEntry[]>()
    for (const e of gw?.entries ?? []) {
      const arr = map.get(e.provider) ?? []
      arr.push(e)
      map.set(e.provider, arr)
    }
    return [...map.entries()].sort((a, b) => b[1].length - a[1].length)
  }, [gw])

  const maxCtx = Math.max(0, ...(gw?.entries ?? []).map((e) => e.maxIn ?? 0))
  const providers = groups.length

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-800">模型管理</h1>
          <p className="text-sm text-slate-500 mt-1">多模型接入与路由 —— 语言/代码/视觉/向量/重排序，私有推理、统一计量；TiMEM 向量与重排序模型是上下文召回的底座</p>
        </div>
      </div>

      {/* LLM 节点可视化配置（移植自 hire llm_node）*/}
      <LlmNodeConfig />

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

      {/* 网关模型池（真 · LiteLLM）：模型 / 供应商 / 上下限 / 路由健康 */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-600 border border-emerald-100">真 · LiteLLM 网关模型池</span>
        <span className="text-[11px] text-slate-400">模型清单与上限实时来自网关（只读）；网关路由/密钥变更走运维通道</span>
      </div>

      {gwError && (
        <div className="text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2 flex items-center gap-1.5">
          <AlertTriangle size={13} />网关模型池不可达：{gwError}（对话页模型池同步不可用）
        </div>
      )}

      {gw && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {[
              { l: '可用模型', v: String(gw.entries.length), icon: Cpu },
              { l: '接入供应商', v: String(providers), icon: Layers },
              { l: '路由健康', v: (gw.health && gw.health.healthy + gw.health.unhealthy > 0) ? `${gw.health.healthy} / ${gw.health.healthy + gw.health.unhealthy}` : '—', icon: ShieldCheck },
              { l: '最大上下文', v: maxCtx ? tok(maxCtx) : '—', icon: Activity },
            ].map(s => (
              <div key={s.l} className="bg-white rounded-xl border border-slate-200/80 p-4">
                <div className="text-xs text-slate-400 flex items-center gap-1"><s.icon size={12} />{s.l}</div>
                <div className="text-xl font-semibold text-slate-800 mt-1">{s.v}</div>
              </div>
            ))}
          </div>

          <div className="space-y-4">
            {groups.map(([provider, entries]) => (
              <div key={provider} className="bg-white rounded-xl border border-slate-200/80 p-5">
                <div className="flex items-center gap-2 mb-3">
                  <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${providerColor[provider] ?? 'bg-slate-100 text-slate-500'}`}>{provider}</span>
                  <span className="text-[11px] text-slate-400">{entries.length} 个模型</span>
                </div>
                <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-3">
                  {entries.map(e => (
                    <div key={e.id} className="rounded-lg border border-slate-100 bg-slate-50/60 p-3">
                      <div className="text-xs font-mono font-medium text-slate-800 truncate" title={e.id}>{e.id}</div>
                      <div className="flex gap-3 mt-1.5 text-[11px] text-slate-400">
                        <span>上下文 {tok(e.maxIn)}</span>
                        <span>输出 {tok(e.maxOut)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
