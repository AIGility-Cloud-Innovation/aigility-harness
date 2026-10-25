import { useCallback, useEffect, useState } from 'react'
import {
  fetchLlmSources, addLlmSourceAlias, removeLlmSourceModel, probeLlmSourceModel,
  type LlmSourceNode,
} from '../lib/harness'
import { Network, RefreshCw, Trash2, Activity, Plus, FileClock, CheckCircle2, XCircle, Loader2 } from 'lucide-react'

interface ProbeState { ok: boolean; ms: number; status?: number; error?: string; pending?: boolean }

export default function LlmSourcesPage() {
  const [data, setData] = useState<{ sources: LlmSourceNode[]; modelCount: number; configPath: string } | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [probes, setProbes] = useState<Record<string, ProbeState>>({})
  const [aliasName, setAliasName] = useState('')
  const [target, setTarget] = useState('')

  const load = useCallback(() => {
    setError('')
    fetchLlmSources().then((r) => {
      if (r.ok && r.sources) setData({ sources: r.sources, modelCount: r.modelCount ?? 0, configPath: r.configPath ?? '' })
      else setError(r.error ?? '来源节点读取失败')
    }).catch((e) => setError(String(e)))
  }, [])
  useEffect(() => { load() }, [load])

  const allModels = (data?.sources ?? []).flatMap((s) => s.models.map((m) => ({ ...m, source: s })))

  const doProbe = async (name: string) => {
    setProbes((p) => ({ ...p, [name]: { ok: false, ms: 0, pending: true } }))
    try {
      const r = await probeLlmSourceModel(name)
      setProbes((p) => ({ ...p, [name]: { ok: !!r.ok, ms: (r as any).ms ?? 0, status: (r as any).status, error: (r as any).error } }))
    } catch (e) {
      setProbes((p) => ({ ...p, [name]: { ok: false, ms: 0, error: String(e) } }))
    }
  }

  const doRemove = async (name: string) => {
    setNotice('')
    const r = await removeLlmSourceModel(name)
    if (r.ok) { setNotice(`已移除 ${name}（litellm 重启后生效）`); load() }
    else setNotice(r.error ?? '移除失败')
  }

  const doAddAlias = async () => {
    setNotice('')
    if (!aliasName.trim() || !target) return
    const r = await addLlmSourceAlias(aliasName.trim(), target)
    if (r.ok) { setNotice(`别名 ${aliasName.trim()} 已写入（litellm 重启后生效）`); setAliasName(''); load() }
    else setNotice(r.error ?? '新增失败')
  }

  const sources = data?.sources ?? []
  const aliasCount = sources.reduce((n, s) => n + s.aliases.length, 0)
  const probeBad = Object.values(probes).filter((p) => !p.pending && p.ok === false).length

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-800">LLM 来源节点管理</h1>
          <p className="text-sm text-slate-500 mt-1">上游渠道与别名映射 —— 模型路由故障（别名缺失/上游失效）就地修复，变更审计留痕</p>
        </div>
        <button onClick={load} className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg bg-slate-100 text-slate-600 hover:bg-slate-200">
          <RefreshCw size={14} /> 刷新
        </button>
      </div>

      {error && <div className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{error}</div>}
      {notice && <div className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-lg px-3 py-2">{notice}</div>}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: '来源节点', value: sources.length },
          { label: '路由模型', value: data?.modelCount ?? 0 },
          { label: '别名', value: aliasCount },
          { label: '探活异常', value: probeBad },
        ].map((c) => (
          <div key={c.label} className="bg-white border border-slate-200 rounded-xl px-4 py-3">
            <div className="text-xs text-slate-500">{c.label}</div>
            <div className="text-2xl font-semibold text-slate-800 mt-1">{c.value}</div>
          </div>
        ))}
      </div>

      {sources.map((s) => (
        <div key={s.id} className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2">
              <Network size={16} className="text-slate-500" />
              <span className="font-medium text-slate-800">{s.label}</span>
              <span className="text-xs font-mono text-slate-400">{s.apiBase}</span>
            </div>
            <span className="text-xs px-2 py-0.5 rounded bg-slate-100 text-slate-500">🔒 env: {s.keyRef}</span>
          </div>
          <table className="w-full text-sm">
            <thead><tr className="text-left text-xs text-slate-400 border-b border-slate-100">
              <th className="py-1.5 font-normal">路由模型</th><th className="py-1.5 font-normal">上游模型</th>
              <th className="py-1.5 font-normal">RPM</th><th className="py-1.5 font-normal">探活</th><th className="py-1.5 font-normal">操作</th>
            </tr></thead>
            <tbody>
              {s.models.map((m) => {
                const p = probes[m.name]
                const isAlias = s.aliases.includes(m.name)
                return (
                  <tr key={m.name} className="border-b border-slate-50">
                    <td className="py-1.5 font-mono text-xs">{m.name}{isAlias && <span className="ml-1 text-[10px] px-1 rounded bg-amber-50 text-amber-600">别名</span>}</td>
                    <td className="py-1.5 font-mono text-xs text-slate-500">{m.upstreamModel}</td>
                    <td className="py-1.5 text-xs text-slate-500">{m.rpm ?? '—'}</td>
                    <td className="py-1.5">
                      {p?.pending ? <Loader2 size={14} className="animate-spin text-slate-400" />
                        : p?.ok ? <span className="flex items-center gap-1 text-emerald-600 text-xs"><CheckCircle2 size={13} /> {p.ms}ms</span>
                        : p?.error || p?.status ? <span className="flex items-center gap-1 text-red-500 text-xs"><XCircle size={13} /> 失败</span>
                        : <span className="text-slate-300 text-xs">未探测</span>}
                    </td>
                    <td className="py-1.5">
                      <div className="flex gap-2">
                        <button onClick={() => doProbe(m.name)} title="真发一次极短补全" className="text-xs text-sky-600 hover:underline flex items-center gap-0.5"><Activity size={12} /> 探活</button>
                        <button onClick={() => doRemove(m.name)} title="移除该路由模型" className="text-xs text-red-500 hover:underline flex items-center gap-0.5"><Trash2 size={12} /> 移除</button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ))}

      <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-2">
        <div className="flex items-center gap-2"><Plus size={15} className="text-slate-500" /><span className="text-sm font-medium text-slate-700">新增别名</span></div>
        <p className="text-xs text-slate-500">别名 = 调用方请求的模型名，指向某个来源节点的上游模型（克隆其上游参数）。用于承接 dsh/codex 等内置模型名与网关实际模型的差异。</p>
        <div className="flex gap-2 flex-wrap items-center">
          <input value={aliasName} onChange={(e) => setAliasName(e.target.value)} placeholder="别名（调用方请求的模型名）"
            className="text-sm px-3 py-1.5 rounded-lg border border-slate-200 focus:outline-none focus:ring-1 focus:ring-slate-300 font-mono" />
          <select value={target} onChange={(e) => setTarget(e.target.value)}
            className="text-sm px-3 py-1.5 rounded-lg border border-slate-200 bg-white focus:outline-none focus:ring-1 focus:ring-slate-300">
            <option value="">选择目标模型…</option>
            {allModels.map((m) => <option key={m.name} value={m.name}>{m.name}（{m.source.label}）</option>)}
          </select>
          <button onClick={doAddAlias} disabled={!aliasName || !target}
            className="text-sm px-3 py-1.5 rounded-lg bg-slate-800 text-white disabled:opacity-40 hover:bg-slate-700">新增别名</button>
        </div>
      </div>

      {data?.configPath && (
        <p className="text-xs text-slate-400 flex items-center gap-1"><FileClock size={12} /> 单一事实源：{data.configPath}（每次变更自动备份，保留最近 5 份）</p>
      )}
    </div>
  )
}
