/**
 * WorkflowYamlEditor — 工作流可视化编排 Studio（编排域 D4 · 设计面）
 *
 * 画布 UX 移植自 gyzy_platform（被验证可用的三件套）：
 *   1. 节点自由二维拖拽（绝对坐标；拖拽坐标已按 zoom 换算，修复了原实现的缩放偏差）；
 *   2. 贝塞尔连线每次渲染从节点当前坐标现算——拖动节点连线自动跟随；
 *   3. 节点库 HTML5 DnD 拖入。
 * 在此之上补齐 gyzy 缺失的编辑闭环：端口拖拽建边、点边删除、旁路/启用切换、
 * 属性面板真实读写；持久层走 layer-orchestration 的 workflow-doc 保守写回引擎
 * （system_prompt / conditional_edges / 注释永不破坏）。
 * 未编辑保存短路原文（规避 yaml@2 流式序列一次性规范化）。
 * 数据源由 props 注入（站点负责鉴权与端点），本组件不含任何站点知识。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  applyWorkflowModel,
  extractWorkflowModel,
  layeredLayout,
  originalEdgeSeq,
  sameWorkflowModel,
  type WorkflowDocModel,
  type WorkflowEdge,
  type WorkflowNode,
} from '@aigility-harness/layer-orchestration/workflow-doc'
import {
  Loader2, Save, RefreshCw, Trash2, Code2, Network, CheckCircle2, AlertTriangle, ShieldCheck, ZoomIn, ZoomOut, Bot, Braces, Flag,
} from 'lucide-react'

const NODE_W = 176
const NODE_H = 56
const CANVAS_W = 2300
const CANVAS_H = 760

export interface WorkflowYamlEditorProps {
  /** 工具条标题 */
  title: string
  /** 加载 YAML 文本（站点注入：端点 + 鉴权） */
  load: () => Promise<string>
  /** 保存 YAML 文本；返回提示文案 */
  save: (text: string) => Promise<string | void>
}

interface Pos { x: number; y: number }

export default function WorkflowYamlEditor({ title, load, save }: WorkflowYamlEditorProps) {
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [banner, setBanner] = useState('')
  const [model, setModel] = useState<WorkflowDocModel | null>(null)
  const [positions, setPositions] = useState<Record<string, Pos>>({})
  const [selected, setSelected] = useState<string | null>(null)
  const [selectedEdge, setSelectedEdge] = useState<number | null>(null)
  const [zoom, setZoom] = useState(100)
  const [showYaml, setShowYaml] = useState(false)
  const [newKey, setNewKey] = useState('')
  const [linking, setLinking] = useState<{ from: string; x: number; y: number } | null>(null)

  const origRef = useRef<{ text: string; model: WorkflowDocModel; missing: boolean; docValid: boolean } | null>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ id: string; offX: number; offY: number } | null>(null)

  const reload = useCallback(async () => {
    setLoading(true); setError(''); setBanner(''); setSelected(null); setSelectedEdge(null)
    try {
      const text = await load()
      const parsed = extractWorkflowModel(text)
      if (!parsed) throw new Error('YAML 解析失败（需含 workflow.nodes）')
      origRef.current = { text, model: parsed.model, missing: false, docValid: true }
      setModel(parsed.model)
      setPositions(layeredLayout(parsed.model))
    } catch (e) { setError(String((e as Error).message ?? e)) } finally { setLoading(false) }
  }, [load])
  useEffect(() => { reload() }, [reload])

  const nodeById = useMemo(() => new Map((model?.nodes ?? []).map((n) => [n.id, n])), [model])

  const yamlPreview = useMemo(() => {
    if (!model || !origRef.current) return ''
    try {
      if (sameWorkflowModel(model, origRef.current.model)) return origRef.current.text
      const re = extractWorkflowModel(origRef.current.text)
      return applyWorkflowModel(re!.doc, model, false, originalEdgeSeq(re!.doc)).toString()
    } catch { return '(序列化失败)' }
  }, [model])

  /** 保存：未编辑 → 短路原文（真字节稳定）；已编辑 → 引擎保守写回 */
  const saveNow = async () => {
    if (!model || !origRef.current) return
    setBusy(true); setError(''); setBanner('')
    try {
      let text: string
      let hint = '已保存'
      if (sameWorkflowModel(model, origRef.current.model)) {
        text = origRef.current.text
        hint = '内容未变化，原文已保存（零 diff）'
      } else {
        const re = extractWorkflowModel(origRef.current.text)
        text = applyWorkflowModel(re!.doc, model, false, originalEdgeSeq(re!.doc)).toString()
      }
      const h = await save(text)
      const re = extractWorkflowModel(text)
      if (re) {
        origRef.current = { text, model: re.model, missing: false, docValid: true }
        setModel(re.model)
      }
      setBanner(h || hint)
    } catch (e) { setError(String((e as Error).message ?? e)) } finally { setBusy(false) }
  }

  /* ---- 模型编辑操作 ---- */

  const patchNode = (id: string, patch: Partial<WorkflowNode>) =>
    setModel((m) => (m ? { ...m, nodes: m.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)) } : m))

  const addNodeAt = (type: 'function_node' | 'llm_node', x: number, y: number) => {
    if (!model) return
    let nid = type === 'llm_node' ? 'new_llm' : 'new_node', k = 2
    while (model.nodes.some((n) => n.id === nid)) nid = `${nid}_${k++}`
    const node: WorkflowNode = {
      id: nid, type,
      functionRef: type === 'function_node' ? nid : null,
      description: '', enabled: true, outputKeys: [],
    }
    setModel({ ...model, nodes: [...model.nodes, node] })
    setPositions((p) => ({ ...p, [nid]: { x, y } }))
    setSelected(nid); setSelectedEdge(null)
  }

  const removeNode = (id: string) => {
    if (!model) return
    const preds = model.edges.filter((e) => e.to === id).map((e) => e.from)
    const succs = model.edges.filter((e) => e.from === id).map((e) => e.to)
    const edges = model.edges
      .filter((e) => e.from !== id && e.to !== id)
      .concat(preds.flatMap((p) => succs.filter((s) => s !== id && s !== p).map((s) => ({ from: p, to: s }))))
      .filter((e, i, a) => a.findIndex((x) => x.from === e.from && x.to === e.to) === i)
    const nodes = model.nodes.filter((n) => n.id !== id)
    setModel({ ...model, nodes, edges: edges.filter((e) => nodes.some((n) => n.id === e.from) && (nodes.some((n) => n.id === e.to) || e.to === '__end__')) })
    if (selected === id) setSelected(null)
  }

  const removeEdge = (idx: number) => {
    if (!model) return
    setModel({ ...model, edges: model.edges.filter((_, i) => i !== idx) })
    setSelectedEdge(null)
  }

  const addEdge = (from: string, to: string) => {
    if (!model || !to || from === to) return
    if (model.edges.some((e) => e.from === from && e.to === to)) return
    setModel({ ...model, edges: [...model.edges, { from, to }] })
  }

  /* ---- gyzy 式交互：拖拽（坐标按 zoom 换算） ---- */

  const toCanvasXY = (clientX: number, clientY: number): Pos => {
    const rect = canvasRef.current?.getBoundingClientRect()
    const scale = zoom / 100
    if (!rect) return { x: clientX / scale, y: clientY / scale }
    return { x: (clientX - rect.left) / scale, y: (clientY - rect.top) / scale }
  }

  const onNodeMouseDown = (e: React.MouseEvent, id: string) => {
    if ((e.target as HTMLElement).closest('[data-wf-port]')) return
    e.preventDefault()
    const n = positions[id] ?? { x: 0, y: 0 }
    const c = toCanvasXY(e.clientX, e.clientY)
    dragRef.current = { id, offX: c.x - n.x, offY: c.y - n.y }
    setSelected(id); setSelectedEdge(null)
    const move = (ev: globalThis.MouseEvent) => {
      const d = dragRef.current
      if (!d) return
      const p = toCanvasXY(ev.clientX, ev.clientY)
      setPositions((ps) => ({ ...ps, [d.id]: { x: Math.max(4, p.x - d.offX), y: Math.max(4, p.y - d.offY) } }))
    }
    const up = () => {
      dragRef.current = null
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  /* ---- 端口拖拽建边（gyzy 缺失的闭环） ---- */

  const onPortMouseDown = (e: React.MouseEvent, from: string) => {
    e.preventDefault(); e.stopPropagation()
    const c = toCanvasXY(e.clientX, e.clientY)
    setLinking({ from, x: c.x, y: c.y })
    setSelected(from); setSelectedEdge(null)
    const move = (ev: globalThis.MouseEvent) => {
      const p = toCanvasXY(ev.clientX, ev.clientY)
      setLinking((l) => (l ? { ...l, x: p.x, y: p.y } : l))
    }
    const up = (ev: globalThis.MouseEvent) => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      const target = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest('[data-wf-target]')
      const to = target?.getAttribute('data-wf-target')
      setLinking(null)
      if (to && to !== from) addEdge(from, to)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  /* ---- 节点库拖入（HTML5 DnD, zoom 补偿落点） ---- */

  const onCanvasDrop = (e: React.DragEvent) => {
    e.preventDefault()
    const t = e.dataTransfer.getData('text/wf-type')
    if (t !== 'function_node' && t !== 'llm_node') return
    const c = toCanvasXY(e.clientX, e.clientY)
    addNodeAt(t, Math.max(4, c.x - NODE_W / 2), Math.max(4, c.y - NODE_H / 2))
  }

  if (loading) return <div className="text-xs text-slate-400 flex items-center gap-2 py-6"><Loader2 size={14} className="animate-spin" />加载工作流…</div>
  if (!model) return (
    <div className="text-xs text-red-500 bg-red-50 border border-red-100 rounded-lg px-3 py-2.5 flex items-center gap-2">
      <AlertTriangle size={13} />{error || '工作流不可用'}
      <button onClick={() => reload()} className="ml-auto text-slate-500 hover:text-slate-700"><RefreshCw size={13} /></button>
    </div>
  )

  const sel = selected ? nodeById.get(selected) : undefined
  const pos = (id: string) => positions[id] ?? { x: 40, y: 40 }
  const hasEnd = model.edges.some((e) => e.to === '__end__')
  // __end__ 终端卡位置：最右列右侧、垂直居中
  const endPos: Pos = (() => {
    const xs = Object.values(positions).map((p) => p.x)
    const ys = model.edges.filter((e) => e.to === '__end__').map((e) => pos(e.from).y)
    return { x: (xs.length ? Math.max(...xs) : 200) + NODE_W + 90, y: ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : 200 }
  })()
  const bezier = (ax: number, ay: number, bx: number, by: number) =>
    `M ${ax} ${ay} C ${ax + Math.max(40, Math.abs(bx - ax) / 2)} ${ay}, ${bx - Math.max(40, Math.abs(bx - ax) / 2)} ${by}, ${bx - 4} ${by}`

  return (
    <div className="space-y-3">
      {/* 工具条 */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[11px] text-slate-400 flex items-center gap-1"><Network size={12} />{title}</span>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-600 border border-emerald-100">enabled 关闭 = 旁路</span>
        {model.conditional.length > 0 && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-600 border border-amber-100 flex items-center gap-1">
            <ShieldCheck size={10} />条件边只读（金色虚线）
          </span>
        )}
        <div className="flex-1" />
        <button onClick={() => setShowYaml((v) => !v)} className={`text-xs px-2.5 py-1.5 rounded-lg border flex items-center gap-1 ${showYaml ? 'bg-slate-700 text-white border-slate-700' : 'border-slate-200 text-slate-500 hover:bg-slate-50'}`}><Code2 size={12} />YAML</button>
        <button onClick={() => reload()} className="text-xs px-2.5 py-1.5 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50"><RefreshCw size={12} /></button>
        <button onClick={saveNow} disabled={busy}
          className="text-xs px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1.5">
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}保存（即时生效）
        </button>
      </div>

      {banner && <div className="text-xs px-3 py-2 rounded-lg bg-emerald-50 text-emerald-700 border border-emerald-100 flex items-center gap-1.5"><CheckCircle2 size={13} />{banner}</div>}
      {error && <div className="text-xs px-3 py-2 rounded-lg bg-red-50 text-red-600 border border-red-100">{error}</div>}

      <div className="flex gap-3 items-stretch">
        {/* 节点库（gyzy 三栏之左） */}
        <div className="w-36 shrink-0 bg-white rounded-xl border border-slate-200 p-2.5 space-y-2">
          <div className="text-[10px] font-medium text-slate-400 px-1">节点库 · 拖入画布</div>
          {([
            { type: 'function_node' as const, label: '函数节点', icon: Braces, cls: 'border-sky-200 text-sky-600' },
            { type: 'llm_node' as const, label: 'LLM 节点', icon: Bot, cls: 'border-violet-200 text-violet-600' },
          ]).map((p) => (
            <div key={p.type} draggable
              onDragStart={(e) => { e.dataTransfer.setData('text/wf-type', p.type); e.dataTransfer.effectAllowed = 'copy' }}
              className={`flex items-center gap-2 text-[11px] px-2.5 py-2 rounded-lg border bg-slate-50 cursor-grab active:cursor-grabbing hover:shadow-sm ${p.cls}`}>
              <p.icon size={13} />{p.label}
            </div>
          ))}
          <div className="text-[10px] text-slate-300 px-1 leading-relaxed pt-1">拖节点右侧端口到目标卡上松手即建边</div>
        </div>

        {/* 画布（gyzy 三栏之中） */}
        <div ref={canvasRef}
          className="flex-1 min-h-[560px] max-h-[640px] overflow-auto rounded-xl border border-slate-200 relative"
          style={{
            backgroundImage: 'radial-gradient(#E2E8F0 1px, transparent 1px)',
            backgroundSize: '18px 18px',
            backgroundColor: '#FBFCFD',
          }}
          onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' }}
          onDrop={onCanvasDrop}
          onMouseDown={(e) => { if (e.target === e.currentTarget || (e.target as HTMLElement).tagName === 'svg') { setSelected(null); setSelectedEdge(null) } }}
        >
          <div className="relative origin-top-left" style={{ width: CANVAS_W, height: CANVAS_H, transform: `scale(${zoom / 100})` }}>
            {/* 连线层 */}
            <svg className="absolute inset-0 pointer-events-none" width={CANVAS_W} height={CANVAS_H}>
              <defs>
                <marker id="wfs-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#94A3B8" /></marker>
                <marker id="wfs-arrow-sel" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#EF4444" /></marker>
                <marker id="wfs-arrow-amber" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#F59E0B" /></marker>
                <marker id="wfs-arrow-link" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#2563EB" /></marker>
              </defs>
              {/* 简单边（可选删） */}
              {model.edges.map((e, i) => {
                const a = pos(e.from), b = e.to === '__end__' ? endPos : pos(e.to)
                const ax = a.x + NODE_W, ay = a.y + NODE_H / 2
                const bx = b.x, by = b.y + NODE_H / 2
                const on = selectedEdge === i
                return (
                  <g key={i} className="cursor-pointer" style={{ pointerEvents: 'auto' }}
                    onClick={() => { setSelectedEdge(i); setSelected(null) }}>
                    <path d={bezier(ax, ay, bx, by)} fill="none" stroke={on ? '#EF4444' : '#B9C6CF'} strokeWidth={on ? 2.5 : 1.5} markerEnd={`url(#wfs-arrow${on ? '-sel' : ''})`} />
                    <path d={bezier(ax, ay, bx, by)} fill="none" stroke="transparent" strokeWidth={14} />
                  </g>
                )
              })}
              {/* 条件边（只读金虚线 + 分支标签） */}
              {model.conditional.map((c, ci) => c.branches.map((b, bi) => {
                const a = pos(c.from), t = pos(b.to)
                if (!t) return null
                const ax = a.x + NODE_W, ay = a.y + NODE_H / 2
                const bx = t.x, by = t.y + NODE_H / 2
                return (
                  <g key={`c${ci}-${bi}`} style={{ pointerEvents: 'none' }}>
                    <path d={bezier(ax, ay, bx, by)} fill="none" stroke="#F59E0B" strokeWidth={1.4} strokeDasharray="5 4" markerEnd="url(#wfs-arrow-amber)" />
                    <text x={(ax + bx) / 2} y={(ay + by) / 2 - 7} textAnchor="middle" fontSize={10} fill="#B45309" fontWeight={500}>{b.condition}</text>
                  </g>
                )
              }))}
              {/* 端口拖线 */}
              {linking && (() => {
                const a = pos(linking.from)
                return <path d={bezier(a.x + NODE_W, a.y + NODE_H / 2, linking.x, linking.y)} fill="none" stroke="#2563EB" strokeWidth={1.8} strokeDasharray="4 3" markerEnd="url(#wfs-arrow-link)" />
              })()}
            </svg>

            {/* 节点卡（gyzy 卡片结构 + 真实数据） */}
            {model.nodes.map((n) => {
              const p = pos(n.id)
              const on = selected === n.id
              const isLlm = n.type === 'llm_node'
              const tone = !n.enabled ? 'bg-slate-100 text-slate-400' : isLlm ? 'bg-violet-50 text-violet-600' : 'bg-sky-50 text-sky-600'
              return (
                <div key={n.id} data-wf-target={n.id}
                  onMouseDown={(e) => onNodeMouseDown(e, n.id)}
                  className={`absolute bg-white rounded-xl border px-3 py-2.5 shadow-sm cursor-grab active:cursor-grabbing select-none group hover:shadow-md transition-shadow ${on ? 'border-blue-500 ring-2 ring-blue-500/15' : 'border-slate-200'}`}
                  style={{ left: p.x, top: p.y, width: NODE_W, height: NODE_H }}>
                  <div className="flex items-center gap-1.5">
                    <span className={`w-2 h-2 rounded-full ${n.enabled ? (isLlm ? 'bg-violet-500' : 'bg-emerald-500') : 'bg-slate-300'}`} />
                    <span className={`text-[9.5px] font-medium rounded px-1.5 py-[1px] ${tone}`}>{isLlm ? 'LLM' : '函数'}{n.enabled ? '' : ' · 旁路'}</span>
                    <button data-wf-port="1" title="拖到目标节点建边"
                      onMouseDown={(e) => onPortMouseDown(e, n.id)}
                      className="ml-auto w-3 h-3 rounded-full border-2 border-slate-300 bg-white hover:border-blue-500 hover:scale-125 transition-transform" />
                    <button onMouseDown={(e) => e.stopPropagation()} title="删除节点（上下游自动接回）"
                      onClick={() => removeNode(n.id)}
                      className="opacity-0 group-hover:opacity-100 text-slate-300 hover:text-red-500 transition-opacity"><Trash2 size={12} /></button>
                  </div>
                  <div className="mt-1 text-[12.5px] font-semibold text-slate-800 leading-tight truncate">{n.id}</div>
                  <div className="text-[10px] text-slate-400 leading-tight truncate">{n.functionRef ?? (isLlm ? 'system_prompt' : n.type)}</div>
                  {on && <span className="absolute -top-2 -right-2 w-4 h-4 rounded-full bg-blue-500 text-white text-[9px] flex items-center justify-center">✓</span>}
                </div>
              )
            })}

            {/* __end__ 终端卡（可作拖线目标） */}
            {hasEnd && (
              <div data-wf-target="__end__"
                className="absolute flex items-center gap-2 px-3 py-2 rounded-xl border border-slate-200 bg-slate-50 text-slate-400 select-none"
                style={{ left: endPos.x, top: endPos.y, width: NODE_W - 30, height: NODE_H }}>
                <Flag size={13} />
                <span className="text-[11px] font-medium">__end__</span>
              </div>
            )}
          </div>

          {/* 缩放控件（gyzy 底部条） */}
          <div className="absolute bottom-2.5 right-3 flex items-center gap-1.5 bg-white/90 border border-slate-200 rounded-lg px-2 py-1 text-[11px] text-slate-500 backdrop-blur">
            <button onClick={() => setZoom((z) => Math.max(50, z - 10))} className="p-0.5 hover:text-slate-800"><ZoomOut size={13} /></button>
            <span className="w-9 text-center tabular-nums">{zoom}%</span>
            <button onClick={() => setZoom((z) => Math.min(150, z + 10))} className="p-0.5 hover:text-slate-800"><ZoomIn size={13} /></button>
          </div>
        </div>

        {/* 属性面板（gyzy 三栏之右 + 真实读写） */}
        <div className="w-80 shrink-0 bg-white rounded-xl border border-slate-200 p-4 space-y-3 self-start">
          {!sel && selectedEdge === null && (
            <div className="text-xs text-slate-400 py-6 text-center leading-relaxed">
              点选节点改属性<br />拖右侧端口建边 · 点连线删除<br />节点库拖入新节点
            </div>
          )}
          {selectedEdge !== null && model.edges[selectedEdge] && (
            <div className="space-y-2">
              <div className="text-xs font-medium text-slate-600 flex items-center gap-1.5"><Network size={12} />连线</div>
              <div className="text-xs text-slate-500 font-mono">{model.edges[selectedEdge].from} → {model.edges[selectedEdge].to}</div>
              <button onClick={() => removeEdge(selectedEdge)}
                className="text-xs px-2.5 py-1.5 rounded-lg border border-red-200 text-red-500 hover:bg-red-50 flex items-center gap-1"><Trash2 size={12} />删除连线</button>
            </div>
          )}
          {sel && (
            <>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-medium text-slate-800 truncate">{sel.id}</span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded ${sel.type === 'llm_node' ? 'bg-violet-50 text-violet-600' : 'bg-sky-50 text-sky-600'}`}>{sel.type}</span>
                <button onClick={() => patchNode(sel.id, { enabled: !sel.enabled })}
                  className={`text-[10px] px-2 py-0.5 rounded-full border ${sel.enabled ? 'bg-emerald-50 text-emerald-600 border-emerald-200' : 'bg-slate-100 text-slate-400 border-slate-200'}`}>
                  {sel.enabled ? '启用' : '旁路'}
                </button>
              </div>
              {sel.functionRef !== null || sel.type !== 'llm_node' ? (
                <div>
                  <label className="text-[11px] text-slate-400 block mb-1">function_ref（装配层注册的节点函数）</label>
                  <input value={sel.functionRef ?? ''} onChange={(e) => patchNode(sel.id, { functionRef: e.target.value || null })}
                    className="w-full text-xs px-2.5 py-1.5 rounded-lg border border-slate-200 font-mono" />
                </div>
              ) : (
                <div className="text-[11px] text-slate-400 bg-violet-50 border border-violet-100 rounded-lg px-2.5 py-2">
                  LLM 节点：system_prompt 在 YAML 中维护，本编辑器不改动该字段。
                </div>
              )}
              <div>
                <label className="text-[11px] text-slate-400 block mb-1">说明</label>
                <textarea value={sel.description} onChange={(e) => patchNode(sel.id, { description: e.target.value })} rows={2}
                  className="w-full text-xs px-2.5 py-1.5 rounded-lg border border-slate-200" />
              </div>
              <div>
                <label className="text-[11px] text-slate-400 block mb-1">output_keys</label>
                <div className="flex flex-wrap gap-1 mb-1.5">
                  {sel.outputKeys.map((k) => (
                    <span key={k} className="text-[10px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 flex items-center gap-1">
                      {k}<button onClick={() => patchNode(sel.id, { outputKeys: sel.outputKeys.filter((x) => x !== k) })} className="text-slate-300 hover:text-red-500">×</button>
                    </span>
                  ))}
                </div>
                <input value={newKey} onChange={(e) => setNewKey(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && newKey.trim()) { patchNode(sel.id, { outputKeys: [...sel.outputKeys, newKey.trim()] }); setNewKey('') } }}
                  placeholder="回车添加 key" className="w-full text-xs px-2.5 py-1.5 rounded-lg border border-slate-200" />
              </div>
              <div>
                <label className="text-[11px] text-slate-400 block mb-1">添加下游连线</label>
                <select value="" onChange={(e) => { addEdge(sel.id, e.target.value); e.target.value = '' }}
                  className="w-full text-xs px-2 py-1.5 rounded-lg border border-slate-200 text-slate-600">
                  <option value="">选择目标…</option>
                  {model.nodes.filter((n) => n.id !== sel.id).map((n) => (
                    <option key={n.id} value={n.id}>{n.id}{model.edges.some((e) => e.from === sel.id && e.to === n.id) ? '（已连）' : ''}</option>
                  ))}
                  <option value="__end__">__end__</option>
                </select>
              </div>
              <button onClick={() => removeNode(sel.id)}
                className="w-full text-xs px-2.5 py-1.5 rounded-lg border border-red-200 text-red-500 hover:bg-red-50 flex items-center justify-center gap-1"><Trash2 size={12} />删除节点（上下游自动接回）</button>
            </>
          )}
        </div>
      </div>

      {showYaml && (
        <pre className="text-[11px] bg-slate-900 text-slate-100 rounded-xl p-4 overflow-auto max-h-80 leading-relaxed">{yamlPreview}</pre>
      )}
    </div>
  )
}
