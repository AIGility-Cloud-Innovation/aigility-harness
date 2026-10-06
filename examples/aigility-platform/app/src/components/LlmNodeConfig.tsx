/**
 * LlmNodeConfig — LLM 节点可视化配置（D2 模型算力层 · 移植自 hire llm_node 模块）
 *
 * 一个「LLM 节点」= 命名的模型配置（供应商 + 模型 + 参数 + 流式），业务按节点名引用——
 * 工作流节点、角色模型偏好、任务管线换模型不改代码。供应商 api_key 只存 env 占位符
 * （{VAR_NAME}），密钥本体不落库；「试解析」验证占位符与上游可解析。
 */
import { useCallback, useEffect, useState } from 'react'
import {
  createLlmNode, createLlmProvider, deleteLlmNode, fetchLlmModels, fetchLlmNodes,
  resolveLlmNode, updateLlmNode, type LlmNodeInfo, type LlmProviderInfo,
} from '../lib/harness'
import { Loader2, Plus, Save, Trash2, RefreshCw, CheckCircle2, AlertTriangle, Play, Boxes, Building2 } from 'lucide-react'

interface Draft {
  id: number | null
  name: string
  description: string
  serviceModule: string
  functionName: string
  modelName: string
  temperature: string
  maxTokens: string
  providerId: number | null
  isStream: boolean
}

const blankDraft = (providerId: number | null): Draft => ({
  id: null, name: '', description: '', serviceModule: '', functionName: '',
  modelName: '', temperature: '0.3', maxTokens: '', providerId, isStream: true,
})

export default function LlmNodeConfig() {
  const [nodes, setNodes] = useState<LlmNodeInfo[]>([])
  const [providers, setProviders] = useState<LlmProviderInfo[]>([])
  const [modelPool, setModelPool] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [newProv, setNewProv] = useState({ name: '', tag: '', apiBase: '', apiKey: '' })
  const [showProvForm, setShowProvForm] = useState(false)
  const [tested, setTested] = useState<{ name: string; baseUrl: string; model: string } | null>(null)
  const [error, setError] = useState('')
  const [banner, setBanner] = useState('')

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const r = await fetchLlmNodes()
      setNodes(r.nodes); setProviders(r.providers)
    } catch (e) { setError(String((e as Error).message ?? e)) } finally { setLoading(false) }
  }, [])
  useEffect(() => { reload(); fetchLlmModels().then((r) => setModelPool(r.models ?? [])).catch(() => {}) }, [reload])

  const refresh = () => { reload(); }

  const openEdit = (n: LlmNodeInfo | null) => {
    setError(''); setBanner(''); setTested(null)
    setDraft(n ? {
      id: n.id, name: n.name, description: n.description, serviceModule: n.serviceModule,
      functionName: n.functionName, modelName: n.modelName,
      temperature: String((n.parameter as { temperature?: number }).temperature ?? 0.3),
      maxTokens: String((n.parameter as { max_tokens?: number }).max_tokens ?? ''),
      providerId: n.providerId, isStream: n.isStream,
    } : blankDraft(providers[0]?.id ?? null))
  }

  const saveDraft = async () => {
    if (!draft) return
    setBusy(true); setError(''); setBanner('')
    try {
      const parameter: Record<string, unknown> = {}
      if (draft.temperature !== '') parameter.temperature = Number(draft.temperature)
      if (draft.maxTokens !== '') parameter.max_tokens = Number(draft.maxTokens)
      const payload = {
        name: draft.name.trim(), description: draft.description, serviceModule: draft.serviceModule,
        functionName: draft.functionName, modelName: draft.modelName.trim(),
        parameter, providerId: draft.providerId ?? 0, isStream: draft.isStream,
      }
      if (!payload.name || !payload.modelName || !payload.providerId) throw new Error('需要名称、模型与供应商')
      if (draft.id) await updateLlmNode(draft.id, payload)
      else await createLlmNode(payload)
      setBanner(draft.id ? `节点「${payload.name}」已更新` : `节点「${payload.name}」已创建——业务可按此名称引用`)
      setDraft(null)
      await reload()
    } catch (e) { setError(String((e as Error).message ?? e)) } finally { setBusy(false) }
  }

  const testResolve = async (name: string) => {
    setError(''); setBanner(''); setTested(null)
    try {
      const r = await resolveLlmNode(name)
      setTested({ name, baseUrl: r.baseUrl, model: r.model })
    } catch (e) { setError(String((e as Error).message ?? e)) }
  }

  const addProvider = async () => {
    if (!newProv.name.trim() || !newProv.tag.trim()) return
    setBusy(true)
    try {
      await createLlmProvider({ ...newProv })
      setNewProv({ name: '', tag: '', apiBase: '', apiKey: '' })
      setShowProvForm(false)
      await reload()
      setBanner('供应商已添加（api_key 建议填 env 占位符 {VAR_NAME}）')
    } catch (e) { setError(String((e as Error).message ?? e)) } finally { setBusy(false) }
  }

  return (
    <div className="bg-white rounded-xl border border-sky-200 ring-1 ring-sky-100/60 p-5 space-y-4" style={{ animation: 'fadeSlide .3s ease' }}>
      <div className="flex items-center gap-2 flex-wrap">
        <Boxes size={14} className="text-sky-500" />
        <h2 className="text-sm font-semibold text-slate-700">LLM 节点 · 可视化配置</h2>
        <span className="text-[10px] px-2 py-0.5 rounded-full bg-sky-50 text-sky-600 border border-sky-100">命名模型配置 · 业务按节点名引用 · 换模型不改代码</span>
        <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-50 text-slate-500 border border-slate-100">密钥只存 env 占位符 {"{VAR}"}</span>
        <div className="flex-1" />
        <button onClick={() => { refresh(); }} className="text-xs px-2.5 py-1.5 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50"><RefreshCw size={12} /></button>
        <button onClick={() => openEdit(null)} className="text-xs px-3 py-1.5 rounded-lg bg-sky-600 text-white hover:bg-sky-700 flex items-center gap-1.5"><Plus size={12} />新建节点</button>
      </div>

      {banner && <div className="text-xs px-3 py-2 rounded-lg bg-emerald-50 text-emerald-700 border border-emerald-100 flex items-center gap-1.5"><CheckCircle2 size={13} />{banner}</div>}
      {error && <div className="text-xs px-3 py-2 rounded-lg bg-red-50 text-red-600 border border-red-100 flex items-center gap-1.5"><AlertTriangle size={13} />{error}</div>}
      {tested && (
        <div className="text-xs px-3 py-2 rounded-lg bg-sky-50 text-sky-700 border border-sky-100">
          试解析「{tested.name}」→ 模型 <b>{tested.model}</b> · 上游 <code>{tested.baseUrl}</code> · 密钥已按 env 解析
        </div>
      )}

      {/* 节点表 */}
      {loading ? <div className="text-xs text-slate-400 flex items-center gap-2 py-4"><Loader2 size={13} className="animate-spin" />加载…</div> : (
        <div className="overflow-x-auto rounded-lg border border-slate-100">
          <table className="w-full text-xs">
            <thead><tr className="bg-slate-50 text-slate-500 text-left">
              <th className="px-3 py-2 font-medium">节点名</th>
              <th className="px-3 py-2 font-medium">供应商</th>
              <th className="px-3 py-2 font-medium">模型</th>
              <th className="px-3 py-2 font-medium">参数</th>
              <th className="px-3 py-2 font-medium">流式</th>
              <th className="px-3 py-2 font-medium">模块/功能</th>
              <th className="px-3 py-2 font-medium text-right">操作</th>
            </tr></thead>
            <tbody>
              {nodes.map((n) => {
                const prov = providers.find((p) => p.id === n.providerId)
                return (
                  <tr key={n.id} className="border-t border-slate-100 hover:bg-slate-50/60">
                    <td className="px-3 py-2 font-mono text-slate-800">{n.name}<div className="text-[10px] text-slate-400 font-sans">{n.description}</div></td>
                    <td className="px-3 py-2 text-slate-600">{prov?.name ?? n.providerId}</td>
                    <td className="px-3 py-2 font-mono text-slate-600">{n.modelName}</td>
                    <td className="px-3 py-2 text-slate-500">{Object.entries(n.parameter).map(([k, v]) => `${k}=${String(v)}`).join(' · ') || '—'}</td>
                    <td className="px-3 py-2">{n.isStream ? '流式' : '阻塞'}</td>
                    <td className="px-3 py-2 text-slate-400">{[n.serviceModule, n.functionName].filter(Boolean).join(' / ') || '—'}</td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      <button title="试解析（占位符→真实上游）" onClick={() => void testResolve(n.name)} className="p-1.5 rounded-lg text-sky-500 hover:bg-sky-50"><Play size={12} /></button>
                      <button title="编辑" onClick={() => openEdit(n)} className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100"><Save size={12} /></button>
                      <button title="删除" onClick={() => { if (window.confirm(`删除节点「${n.name}」？`)) void deleteLlmNode(n.id).then(refresh).catch((err) => setError(String((err as Error).message ?? err))) }} className="p-1.5 rounded-lg text-red-400 hover:bg-red-50"><Trash2 size={12} /></button>
                    </td>
                  </tr>
                )
              })}
              {nodes.length === 0 && <tr><td colSpan={7} className="px-3 py-6 text-center text-slate-400">暂无节点——新建后业务按名称引用（如任务判定、角色模型偏好）</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {/* 新建/编辑表单 */}
      {draft && (
        <div className="rounded-xl border border-sky-200 bg-sky-50/40 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="text-xs font-semibold text-slate-700">{draft.id ? `编辑节点 · ${draft.name}` : '新建节点'}</div>
            <button onClick={() => setDraft(null)} className="text-xs text-slate-400 hover:text-slate-600">取消</button>
          </div>
          <div className="grid md:grid-cols-2 gap-3">
            <label className="block"><span className="text-[11px] text-slate-400 block mb-1">节点名 *（唯一；业务按名引用）</span>
              <input value={draft.name} disabled={!!draft.id} onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                className="w-full text-xs px-2.5 py-1.5 rounded-lg border border-slate-200 font-mono disabled:bg-slate-100" /></label>
            <label className="block"><span className="text-[11px] text-slate-400 block mb-1">供应商 *</span>
              <select value={draft.providerId ?? ''} onChange={(e) => setDraft({ ...draft, providerId: Number(e.target.value) })}
                className="w-full text-xs px-2.5 py-1.5 rounded-lg border border-slate-200 bg-white">
                <option value="">选择…</option>
                {providers.map((p) => <option key={p.id} value={p.id}>{p.name}（{p.tag}）</option>)}
              </select></label>
            <label className="block"><span className="text-[11px] text-slate-400 block mb-1">模型名 *（可从网关模型池选择）</span>
              <input list="llm-node-model-pool" value={draft.modelName} onChange={(e) => setDraft({ ...draft, modelName: e.target.value })}
                className="w-full text-xs px-2.5 py-1.5 rounded-lg border border-slate-200 font-mono" />
              <datalist id="llm-node-model-pool">{modelPool.map((m) => <option key={m} value={m} />)}</datalist></label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block"><span className="text-[11px] text-slate-400 block mb-1">temperature</span>
                <input value={draft.temperature} onChange={(e) => setDraft({ ...draft, temperature: e.target.value })} placeholder="0.3"
                  className="w-full text-xs px-2.5 py-1.5 rounded-lg border border-slate-200 font-mono" /></label>
              <label className="block"><span className="text-[11px] text-slate-400 block mb-1">max_tokens</span>
                <input value={draft.maxTokens} onChange={(e) => setDraft({ ...draft, maxTokens: e.target.value })} placeholder="留空默认"
                  className="w-full text-xs px-2.5 py-1.5 rounded-lg border border-slate-200 font-mono" /></label>
            </div>
            <label className="block"><span className="text-[11px] text-slate-400 block mb-1">描述</span>
              <input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                className="w-full text-xs px-2.5 py-1.5 rounded-lg border border-slate-200" /></label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block"><span className="text-[11px] text-slate-400 block mb-1">业务模块（标注）</span>
                <input value={draft.serviceModule} onChange={(e) => setDraft({ ...draft, serviceModule: e.target.value })} placeholder="taskloop"
                  className="w-full text-xs px-2.5 py-1.5 rounded-lg border border-slate-200 font-mono" /></label>
              <label className="block"><span className="text-[11px] text-slate-400 block mb-1">功能名（标注）</span>
                <input value={draft.functionName} onChange={(e) => setDraft({ ...draft, functionName: e.target.value })} placeholder="judge"
                  className="w-full text-xs px-2.5 py-1.5 rounded-lg border border-slate-200 font-mono" /></label>
            </div>
          </div>
          <label className="flex items-center gap-2 text-xs text-slate-600">
            <input type="checkbox" checked={draft.isStream} onChange={(e) => setDraft({ ...draft, isStream: e.target.checked })} />流式输出
          </label>
          <div className="flex gap-2">
            <button onClick={saveDraft} disabled={busy}
              className="text-xs px-3 py-1.5 rounded-lg bg-sky-600 text-white hover:bg-sky-700 disabled:opacity-50 flex items-center gap-1.5">
              {busy ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}保存节点
            </button>
          </div>
        </div>
      )}

      {/* 供应商管理 */}
      <div className="pt-3 border-t border-slate-100">
        <div className="flex items-center gap-2 flex-wrap">
          <Building2 size={13} className="text-slate-400" />
          <span className="text-xs font-medium text-slate-600">供应商</span>
          <span className="text-[10px] text-slate-400">api_key 填 env 占位符（如 {"{LITELLM_KEY}"}），密钥本体不落库</span>
          <div className="flex-1" />
          <button onClick={() => setShowProvForm((v) => !v)} className="text-xs px-2.5 py-1.5 rounded-lg border border-dashed border-slate-300 text-slate-500 hover:bg-slate-50 flex items-center gap-1"><Plus size={11} />添加供应商</button>
        </div>
        <div className="flex flex-wrap gap-2 mt-2">
          {providers.map((p) => (
            <span key={p.id} className="text-[11px] px-2.5 py-1 rounded-lg bg-slate-50 border border-slate-100 text-slate-600">
              {p.name} <code className="text-slate-400">{p.tag}</code> · <code className="text-slate-400">{p.apiBase || '—'}</code> · key: <code className="text-slate-400">{p.apiKey || '—'}</code>
            </span>
          ))}
        </div>
        {showProvForm && (
          <div className="grid md:grid-cols-5 gap-2 mt-2 items-end">
            <input value={newProv.name} onChange={(e) => setNewProv({ ...newProv, name: e.target.value })} placeholder="名称"
              className="text-xs px-2.5 py-1.5 rounded-lg border border-slate-200" />
            <input value={newProv.tag} onChange={(e) => setNewProv({ ...newProv, tag: e.target.value })} placeholder="tag（唯一）"
              className="text-xs px-2.5 py-1.5 rounded-lg border border-slate-200 font-mono" />
            <input value={newProv.apiBase} onChange={(e) => setNewProv({ ...newProv, apiBase: e.target.value })} placeholder="api_base 或 {VAR}"
              className="text-xs px-2.5 py-1.5 rounded-lg border border-slate-200 font-mono" />
            <input value={newProv.apiKey} onChange={(e) => setNewProv({ ...newProv, apiKey: e.target.value })} placeholder="{API_KEY_VAR}"
              className="text-xs px-2.5 py-1.5 rounded-lg border border-slate-200 font-mono" />
            <button onClick={addProvider} disabled={busy} className="text-xs px-3 py-1.5 rounded-lg bg-slate-700 text-white hover:bg-slate-800 disabled:opacity-50 flex items-center gap-1 justify-center">
              {busy ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}添加
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
