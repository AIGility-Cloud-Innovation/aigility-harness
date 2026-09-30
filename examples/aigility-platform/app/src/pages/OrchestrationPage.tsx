/**
 * OrchestrationPage — 编排管理（图形化工作流画布）
 *
 * 画布机制收编自 gyzy_platform（git.aigility.cloud/AIGility-Cloud-Innovation/gyzy_platform
 * src/console/pages/Orchestration.tsx：三栏布局 · 节点卡拖拽 · SVG 贝塞尔连线 · 属性面板），
 * 数据源换成智悦真实的数据面工作流 YAML（executor-dispatch 路由 + 任务板 Plan 拆解产物）。
 *
 * 诚实边界：v1 编辑范围 = 节点描述与 llm_node 的 system_prompt（保存走服务端结构校验 +
 * 审计, 任务派发下次加载即用新配置）；节点增删/连线编辑需要引擎侧节点注册配套（v2）。
 * 节点位置为会话内视觉布局（自动分层），不写入 YAML。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import * as YAML from 'js-yaml'
import { fetchFlows, fetchFlowYaml, saveFlowYaml, type FlowInfo } from '../lib/harness'
import { CirclePlay, Cpu, Blocks, GitBranch, Loader2, Save, CheckCircle2, AlertTriangle, ZoomIn, ZoomOut } from 'lucide-react'

// ── YAML → 图模型 ────────────────────────────────────────────────

interface YamlNode { type?: string; description?: string; system_prompt?: string; function_ref?: string; output_keys?: string[]; [k: string]: unknown }
interface YamlBranch { condition?: string; to: string; description?: string }
interface ParsedFlow {
  name: string
  entryPoint: string
  nodes: Record<string, YamlNode>
  edges: Array<[string, string]>
  conditional: Array<{ from: string; condition?: string; branches: YamlBranch[] }>
}

function parseFlowYaml(text: string): ParsedFlow {
  const doc = YAML.load(text) as { workflow?: { name?: string; entry_point?: string; nodes?: Record<string, YamlNode>; flow?: { edges?: Array<{ from: string; to: string } | [string, string]>; conditional_edges?: Array<{ from: string; condition?: string; branches?: YamlBranch[] }> } } }
  const wf = doc.workflow ?? {}
  const edges = (wf.flow?.edges ?? []).map((e) => (Array.isArray(e) ? [e[0], e[1]] : [e.from, e.to])) as Array<[string, string]>
  return {
    name: wf.name ?? '未命名',
    entryPoint: wf.entry_point ?? '',
    nodes: wf.nodes ?? {},
    edges,
    conditional: (wf.flow?.conditional_edges ?? []).map((c) => ({ from: c.from, condition: c.condition ?? '', branches: c.branches ?? [] })),
  }
}

// ── 自动分层布局（BFS 层级 × 列; 回边=循环）─────────────────────

const NODE_W = 208
const NODE_H = 84
const COL_GAP = 96
const ROW_GAP = 36

interface LaidNode { id: string; x: number; y: number; col: number }

function layoutFlow(flow: ParsedFlow): { laid: LaidNode[]; width: number; height: number; backEdges: Set<string> } {
  const ids = Object.keys(flow.nodes)
  const adj = new Map<string, string[]>()
  for (const id of ids) adj.set(id, [])
  const layer = new Map<string, number>()
  const backEdges = new Set<string>()
  // BFS 分层（从 entry_point；不可达节点归入最后一层）
  const queue = flow.entryPoint && flow.nodes[flow.entryPoint] ? [flow.entryPoint] : ids.slice(0, 1)
  if (flow.entryPoint) layer.set(flow.entryPoint, 0)
  while (queue.length) {
    const cur = queue.shift()!
    const curLayer = layer.get(cur) ?? 0
    const outs = [
      ...flow.edges.filter(([f]) => f === cur).map(([, t]) => t),
      ...(flow.conditional.filter((c) => c.from === cur).flatMap((c) => c.branches.map((b) => b.to))),
    ]
    for (const t of outs) {
      if (!flow.nodes[t]) continue // __end__ 等虚拟节点
      if (!layer.has(t)) { layer.set(t, curLayer + 1); queue.push(t) }
      else if ((layer.get(t) ?? 0) <= curLayer) backEdges.add(`${cur}->${t}`) // 回边 = 循环
    }
  }
  let maxLayer = 0
  for (const id of ids) {
    if (!layer.has(id)) layer.set(id, (layer.get(id) ?? (maxLayer + 1)))
    maxLayer = Math.max(maxLayer, layer.get(id) ?? 0)
  }
  const byLayer = new Map<number, string[]>()
  for (const id of ids) {
    const l = layer.get(id) ?? 0
    if (!byLayer.has(l)) byLayer.set(l, [])
    byLayer.get(l)!.push(id)
  }
  const laid: LaidNode[] = []
  let width = 0
  let height = 0
  for (const [l, list] of [...byLayer.entries()].sort((a, b) => a[0] - b[0])) {
    list.forEach((id, row) => {
      laid.push({ id, col: l, x: 48 + l * (NODE_W + COL_GAP), y: 56 + row * (NODE_H + ROW_GAP) })
      width = Math.max(width, 48 + l * (NODE_W + COL_GAP) + NODE_W)
      height = Math.max(height, 56 + (row + 1) * (NODE_H + ROW_GAP))
    })
  }
  return { laid, width: width + 48, height: height + 24, backEdges }
}

// ── 页面 ─────────────────────────────────────────────────────────

const KIND_META: Record<string, { label: string; cls: string }> = {
  llm_node: { label: '大模型节点', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  function_node: { label: '函数节点', cls: 'bg-sky-50 text-sky-700 border-sky-200' },
  capability_node: { label: '能力节点', cls: 'bg-violet-50 text-violet-700 border-violet-200' },
}

export default function OrchestrationPage() {
  const [flows, setFlows] = useState<FlowInfo[]>([])
  const [currentId, setCurrentId] = useState<string>('')
  const [flow, setFlow] = useState<ParsedFlow | null>(null)
  const [yamlText, setYamlText] = useState('')
  const [selected, setSelected] = useState('')
  const [dirty, setDirty] = useState(false)
  const [zoom, setZoom] = useState(100)
  const [busy, setBusy] = useState(false)
  const [banner, setBanner] = useState('')
  const [error, setError] = useState('')
  const canvasRef = useRef<HTMLDivElement | null>(null)

  const loadList = useCallback(async () => {
    const fs = await fetchFlows()
    setFlows(fs)
    if (fs.length && !currentId) void loadFlow(fs[0].id)
  }, [currentId])
  useEffect(() => { loadList().catch(e => setError(String(e))) }, [])

  const loadFlow = async (id: string) => {
    setBusy(true); setError(''); setBanner(''); setDirty(false); setSelected('')
    try {
      const yaml = await fetchFlowYaml(id)
      setCurrentId(id); setYamlText(yaml); setFlow(parseFlowYaml(yaml))
    } catch (e) { setError(String((e as Error).message ?? e)) } finally { setBusy(false) }
  }

  const laid = useMemo(() => (flow ? layoutFlow(flow) : null), [flow])
  const nodeById = (id: string) => laid?.laid.find((n) => n.id === id)
  const sel = flow && selected ? flow.nodes[selected] : null

  const patchNode = (id: string, patch: Partial<YamlNode>) => {
    if (!flow) return
    setFlow({ ...flow, nodes: { ...flow.nodes, [id]: { ...flow.nodes[id], ...patch } } })
    setDirty(true)
  }

  const save = async () => {
    if (!flow || !currentId || busy) return
    setBusy(true); setError(''); setBanner('')
    try {
      const doc = {
        workflow: {
          name: flow.name,
          description: undefined,
          entry_point: flow.entryPoint,
          nodes: flow.nodes,
          flow: {
            edges: flow.edges.map(([f, t]) => ({ from: f, to: t })),
            ...(flow.conditional.length ? { conditional_edges: flow.conditional.map((c) => ({ from: c.from, ...(c.condition ? { condition: c.condition } : {}), branches: c.branches })) } : {}),
          },
        },
      }
      const text = YAML.dump(doc, { lineWidth: -1 })
      await saveFlowYaml(currentId, text)
      setYamlText(text)
      setDirty(false)
      setBanner('已保存并通过结构校验——任务派发下次加载即用新配置')
    } catch (e) {
      setError(String((e as Error).message ?? e))
    } finally { setBusy(false) }
  }

  // 节点拖拽（会话内视觉布局）
  const dragRef = useRef<{ id: string; dx: number; dy: number } | null>(null)
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({})
  useEffect(() => { setPositions({}) }, [currentId])
  const posOf = (n: LaidNode) => positions[n.id] ?? { x: n.x, y: n.y }
  const onNodeMouseDown = (e: MouseEvent, id: string) => {
    e.preventDefault()
    setSelected(id)
    const base = laid?.laid.find((n) => n.id === id)
    if (!base) return
    const p = posOf(base)
    dragRef.current = { id, dx: e.clientX - p.x, dy: e.clientY - p.y }
    const move = (ev: globalThis.MouseEvent) => {
      const d = dragRef.current
      if (!d) return
      setPositions((ps) => ({ ...ps, [d.id]: { x: Math.max(0, ev.clientX - d.dx), y: Math.max(0, ev.clientY - d.dy) } }))
    }
    const up = () => {
      dragRef.current = null
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-800">编排管理</h1>
          <p className="text-sm text-slate-500 mt-1">数据面工作流图形化管理：节点画布、条件分支与循环 —— YAML 可版本化，保存走结构校验（画布机制收编自 gyzy_platform）</p>
        </div>
        {currentId && (
          <button onClick={save} disabled={busy || !dirty}
            className="text-sm px-4 py-2 rounded-lg bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-40 flex items-center gap-1.5">
            {busy ? <Loader2 size={14} className="animate-spin" /> : dirty ? <Save size={14} /> : <CheckCircle2 size={14} />}
            {dirty ? '保存工作流' : '已保存'}
          </button>
        )}
      </div>

      {banner && <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-2.5 text-xs text-emerald-700 flex items-center gap-2"><CheckCircle2 size={13} />{banner}</div>}
      {error && <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-2.5 text-xs text-red-600 flex items-center gap-2"><AlertTriangle size={13} />{error}</div>}

      <div className="flex gap-4 items-start">
        {/* 左：工作流清单 */}
        <div className="w-60 shrink-0 space-y-2">
          <div className="text-[11px] font-medium text-slate-400 px-1">工作流（数据面 YAML）</div>
          {flows.map(f => (
            <button key={f.id} onClick={() => loadFlow(f.id)}
              className={`w-full text-left rounded-xl border px-3.5 py-3 transition ${currentId === f.id ? 'border-violet-300 ring-1 ring-violet-100 bg-violet-50/40' : 'bg-white border-slate-200/80 hover:border-violet-200'}`}>
              <div className="flex items-center gap-2">
                <GitBranch size={13} className={currentId === f.id ? 'text-violet-600' : 'text-slate-400'} />
                <span className="text-xs font-medium text-slate-700 truncate">{f.name}</span>
                {f.builtin && <span className="text-[9px] px-1.5 py-0.5 rounded bg-slate-800 text-white shrink-0">内置</span>}
              </div>
              <code className="text-[10px] text-slate-400 block mt-1 truncate">{f.source}</code>
            </button>
          ))}
          {flows.length === 0 && <div className="text-xs text-slate-400 px-1 py-4">加载中…</div>}
          <div className="text-[10px] text-slate-300 px-1 pt-2 leading-relaxed">新工作流由任务板「workflow 执行器」Plan 拆解产生（人审后入库）</div>
        </div>

        {/* 中：画布（gyzy 机制：节点卡 + SVG 贝塞尔连线 + 缩放） */}
        <div ref={canvasRef as never} className="flex-1 min-w-0 bg-white rounded-xl border border-slate-200/80 overflow-auto" style={{ maxHeight: 620 }}>
          {!flow || !laid ? (
            <div className="p-16 text-center text-sm text-slate-400">{busy ? <Loader2 size={20} className="animate-spin mx-auto" /> : '选择左侧工作流加载画布'}</div>
          ) : (
            <div className="relative origin-top-left dotgrid" style={{ width: laid.width, height: laid.height, transform: `scale(${zoom / 100})` }}>
              <svg className="absolute inset-0 pointer-events-none" width={laid.width} height={laid.height}>
                {/* 结构边 */}
                {flow.edges.filter(([f, t]) => nodeById(f) && (nodeById(t) || t === '__end__')).map(([f, t]) => {
                  const a = nodeById(f); const pa = a ? posOf(a) : null
                  const endFlag = t === '__end__'
                  const bx = endFlag ? (pa ? pa.x + NODE_W + 60 : 0) : (nodeById(t) ? posOf(nodeById(t)!).x : 0)
                  const by = endFlag ? (pa ? pa.y + NODE_H / 2 : 0) : (nodeById(t) ? posOf(nodeById(t)!).y + NODE_H / 2 : 0)
                  if (!pa) return null
                  const ax = pa.x + NODE_W; const ay = pa.y + NODE_H / 2
                  const dx = Math.max(40, Math.abs(bx - ax) / 2)
                  return (
                    <g key={`${f}-${t}`}>
                      <path d={`M ${ax} ${ay} C ${ax + dx} ${ay}, ${bx - dx} ${by}, ${bx - 4} ${by}`} fill="none" stroke="#B9C6CF" strokeWidth={1.5} />
                      <circle cx={bx - 3} cy={by} r={3} fill="#B9C6CF" />
                      {endFlag && (
                        <g>
                          <rect x={bx} y={by - 18} width={68} height={36} rx={10} fill="#fff" stroke="#B9C6CF" />
                          <text x={bx + 34} y={by + 4} textAnchor="middle" fontSize="11" fill="#64748b">结束</text>
                        </g>
                      )}
                    </g>
                  )
                })}
                {/* 条件边（分支 label; 回边=循环 金色曲线） */}
                {flow.conditional.flatMap((c) => c.branches.map((b) => {
                  const a = nodeById(c.from); const t = nodeById(b.to)
                  if (!a || !t) return null
                  const pa = posOf(a); const pt = posOf(t)
                  const ax = pa.x + NODE_W; const ay = pa.y + NODE_H / 2
                  const bx = pt.x; const by = pt.y + NODE_H / 2
                  const isBack = laid.backEdges.has(`${c.from}->${b.to}`)
                  const dx = Math.max(40, Math.abs(bx - ax) / 2)
                  const lift = isBack ? -60 : 0
                  return (
                    <g key={`${c.from}-${b.to}`}>
                      <path d={`M ${ax} ${ay} C ${ax + dx} ${ay + lift}, ${bx - dx} ${by + lift}, ${bx - 4} ${by}`} fill="none"
                        stroke={isBack ? '#B08D57' : '#94A3B8'} strokeWidth={isBack ? 2 : 1.5} strokeDasharray={isBack ? '6 3' : undefined} />
                      <circle cx={bx - 3} cy={by} r={3} fill={isBack ? '#B08D57' : '#94A3B8'} />
                      <text x={(ax + bx) / 2} y={(ay + by) / 2 + lift - 8} textAnchor="middle" fontSize="11"
                        fill={isBack ? '#B08D57' : '#64748b'} fontWeight="500">{b.condition}</text>
                    </g>
                  )
                }))}
              </svg>
              {laid.laid.map((n) => {
                const def = flow.nodes[n.id]
                const p = posOf(n)
                const meta = KIND_META[def.type ?? ''] ?? { label: def.type || '节点', cls: 'bg-slate-100 text-slate-600 border-slate-200' }
                const isEntry = n.id === flow.entryPoint
                return (
                  <div key={n.id} onMouseDown={(e) => onNodeMouseDown(e, n.id)}
                    className={`absolute bg-white rounded-xl border px-3.5 py-3 cursor-grab active:cursor-grabbing hover:shadow-lg select-none ${selected === n.id ? 'border-violet-400 ring-2 ring-violet-100' : 'border-slate-200'}`}
                    style={{ left: p.x, top: p.y, width: NODE_W, height: NODE_H }}>
                    <div className="flex items-center gap-2">
                      {isEntry ? <CirclePlay size={13} className="text-emerald-500" /> : def.type === 'llm_node' ? <Cpu size={13} className="text-amber-500" /> : <Blocks size={13} className="text-sky-500" />}
                      <span className={`text-[9.5px] font-medium rounded px-1.5 py-px border ${meta.cls}`}>{isEntry ? '入口' : meta.label}</span>
                    </div>
                    <div className="mt-1.5 text-[12px] font-semibold text-slate-800 leading-tight line-clamp-2">{def.description || n.id}</div>
                    <div className="mt-0.5 text-[10px] text-slate-400 truncate">{n.id}</div>
                    {selected === n.id && <span className="absolute -top-2 -right-2 w-4 h-4 rounded-full bg-violet-600 text-white text-[9px] flex items-center justify-center">✓</span>}
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* 右：属性面板（gyzy 机制） */}
        <div className="w-80 shrink-0 bg-white rounded-xl border border-slate-200/80 p-5" style={{ minHeight: 360 }}>
          {sel && flow ? (
            <div className="space-y-4">
              <div>
                <div className="text-[13px] font-semibold text-slate-800">{flow.nodes[selected]?.description || selected}</div>
                <div className="text-[11px] text-slate-400 mt-0.5">
                  {KIND_META[flow.nodes[selected]?.type ?? '']?.label ?? flow.nodes[selected]?.type} · {selected}
                </div>
              </div>
              <div>
                <div className="text-xs font-medium text-slate-600 mb-1.5">节点描述</div>
                <input value={String(sel.description ?? '')} onChange={(e) => patchNode(selected, { description: e.target.value })}
                  className="w-full text-xs px-3 py-2 rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-violet-100" />
              </div>
              {sel.type === 'llm_node' && (
                <div>
                  <div className="text-xs font-medium text-slate-600 mb-1.5">System Prompt（该节点的大模型指令）</div>
                  <textarea value={String(sel.system_prompt ?? '')} onChange={(e) => patchNode(selected, { system_prompt: e.target.value })} rows={12}
                    className="w-full text-xs px-3 py-2 rounded-lg border border-slate-200 font-mono leading-relaxed focus:outline-none focus:ring-2 focus:ring-violet-100" />
                </div>
              )}
              {sel.type !== 'llm_node' && (
                <div className="rounded-lg bg-slate-50 border border-slate-100 p-3 text-[11px] text-slate-500 space-y-1.5">
                  <div>类型：<code>{String(sel.type ?? '-')}</code></div>
                  {sel.function_ref && <div>函数引用：<code>{String(sel.function_ref)}</code>（函数体注册于服务端, 编辑器不改）</div>}
                  {sel.output_keys && <div>输出键：<code>{sel.output_keys.join(', ')}</code></div>}
                  <div>节点位置与描述可编辑；节点增删与连线编辑随引擎节点注册机制开放（v2）。</div>
                </div>
              )}
              <div className="text-[11px] text-slate-400 flex items-center gap-3 pt-1">
                <button onClick={() => setZoom(z => Math.max(50, z - 10))} className="w-6 h-6 rounded hover:bg-slate-100 flex items-center justify-center"><ZoomOut size={13} /></button>
                <span className="w-10 text-center">{zoom}%</span>
                <button onClick={() => setZoom(z => Math.min(150, z + 10))} className="w-6 h-6 rounded hover:bg-slate-100 flex items-center justify-center"><ZoomIn size={13} /></button>
                <span className="ml-auto">节点 {Object.keys(flow.nodes).length} · 条件分支 {flow.conditional.reduce((s, c) => s + c.branches.length, 0)}</span>
              </div>
            </div>
          ) : (
            <div className="h-full min-h-[280px] flex flex-col items-center justify-center text-center text-slate-400">
              <GitBranch size={26} className="mb-3" strokeWidth={1.4} />
              <div className="text-[13px]">点击画布中的节点查看配置</div>
              <div className="text-[11.5px] mt-1.5">节点可拖拽移动，连线自动跟随；虚线金边 = 循环回边</div>
            </div>
          )}
        </div>
      </div>

      {/* 底部：YAML 只读预览（可折叠感知） */}
      {yamlText && (
        <details className="bg-white rounded-xl border border-slate-200/80 px-5 py-3">
          <summary className="text-xs text-slate-500 cursor-pointer select-none">查看原始 YAML（只读 · 保存后的真实落盘内容）</summary>
          <pre className="mt-3 text-[11px] leading-relaxed text-slate-600 bg-slate-50 rounded-lg p-3 overflow-x-auto max-h-72">{yamlText}</pre>
        </details>
      )}
      <style>{`.dotgrid { background-image: radial-gradient(circle, #e2e8f0 1px, transparent 1px); background-size: 22px 22px; }`}</style>
    </div>
  )
}
