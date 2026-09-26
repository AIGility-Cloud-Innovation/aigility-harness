import { useEffect, useState } from 'react'
import { mcpTools, pluginTools } from '../mock/data'
import { fetchCapabilities, fetchDshTools, callDshTool, type CapabilityInfo, type DshToolInfo } from '../lib/harness'
import { Wrench, X, Plug, Hexagon, Building2, Blocks, Radio, PlugZap, Play, Loader2, RefreshCw } from 'lucide-react'

type ToolItem = {
  key: string; name: string; desc: string; group: 'TiMEM 上下文能力' | '客户系统封装' | '通用插件'
  category?: string; enabled: boolean; calls: string; extra?: string
}

const allTools: ToolItem[] = [
  ...mcpTools.filter(t => t.type === '太忆内置').map(t => ({
    key: t.name, name: t.name, desc: t.desc, group: 'TiMEM 上下文能力' as const, enabled: t.status === '已连接', calls: String(t.calls), extra: t.source,
  })),
  ...mcpTools.filter(t => t.type !== '太忆内置').map(t => ({
    key: t.name, name: t.name, desc: t.desc, group: '客户系统封装' as const, enabled: t.status === '已连接', calls: String(t.calls), extra: t.source,
  })),
  ...pluginTools.map(t => ({
    key: t.id, name: t.name, desc: t.description, group: '通用插件' as const, category: t.category, enabled: t.enabled, calls: t.calls, extra: t.version,
  })),
]

const groups = ['全部', 'TiMEM 上下文能力', '客户系统封装', '通用插件'] as const

const groupIcon: Record<string, any> = { 'TiMEM 上下文能力': Hexagon, '客户系统封装': Building2, '通用插件': Blocks }

const layerOrder = ['D1 底座基础层', 'D2 认知算力层', 'D3 行动执行层', 'D4 编排规划层', 'D5 角色人格层']

export default function ToolsPage() {
  const [group, setGroup] = useState<(typeof groups)[number]>('全部')
  const [off, setOff] = useState<Set<string>>(new Set(allTools.filter(t => !t.enabled).map(t => t.key)))
  const [detail, setDetail] = useState<ToolItem | null>(null)
  const [capabilities, setCapabilities] = useState<CapabilityInfo[]>([])

  useEffect(() => {
    fetchCapabilities().then(setCapabilities).catch(() => {})
  }, [])

  const list = allTools.filter(t => group === '全部' || t.group === group)
  const toggle = (key: string) => setOff(s => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n })

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-800">工具插件中心</h1>
          <p className="text-sm text-slate-500 mt-1">统一工具总线：TiMEM 上下文中间件能力开箱即用，客户系统 API 一键封装为 MCP 工具，通用插件按需启用</p>
        </div>
        <button className="text-sm px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 flex items-center gap-1.5"><Plug size={15} />封装新 API 为工具</button>
      </div>

      {/* DSH ctx.tools · MCP 工具总线（真）：dsh-mcp-client 注册的外部 MCP 工具, 经 @action/dsh-tool 桥 */}
      <DshMcpPanel />

      {/* 引擎能力总线（真）：内核已装配插件的全部 Provider, 随引擎版本自动更新 */}
      {capabilities.length > 0 && (
        <div className="bg-white rounded-xl border border-emerald-200 ring-1 ring-emerald-100/60 p-5" style={{ animation: 'fadeSlide .3s ease' }}>
          <div className="flex items-center gap-2 mb-1">
            <Radio size={14} className="text-emerald-500" />
            <h2 className="text-sm font-semibold text-slate-700">已接入 aigility-harness · 引擎能力总线</h2>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-600 border border-emerald-100">真 · {capabilities.length} 个能力</span>
          </div>
          <p className="text-[11px] text-slate-400 mb-3">来自内核五域插件注册表（enumerate from layer plugins），数字员工对话时经 Seam 实际调用</p>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {layerOrder.map(ln => {
              const items = capabilities.filter(c => c.layerName === ln)
              if (!items.length) return null
              return (
                <div key={ln} className="rounded-lg border border-slate-100 bg-slate-50/60 p-3">
                  <div className="text-[11px] font-medium text-slate-600 mb-2">{ln} <span className="text-slate-300">· {items.length}</span></div>
                  <div className="space-y-1.5">
                    {items.map(c => (
                      <div key={c.id} className="text-[11px] leading-snug">
                        <code className="text-blue-600">{c.id}</code>
                        <span className="text-slate-400 ml-1.5">{c.description}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      <div className="flex gap-2 flex-wrap items-center">
        <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-500">以下为产品壳演示数据</span>
        {groups.map(g => (
          <button key={g} onClick={() => setGroup(g)}
            className={`text-xs px-3.5 py-1.5 rounded-full transition ${group === g ? 'bg-blue-600 text-white' : 'bg-white border border-slate-200 text-slate-600 hover:border-blue-300'}`}>
            {g}{g !== '全部' && ` ${allTools.filter(t => t.group === g).length}`}
          </button>
        ))}
        <span className="text-xs text-slate-400 ml-auto">共 {allTools.length} 个工具 · 数字员工与智能体经 MCP 统一调用</span>
      </div>

      <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
        {list.map(t => {
          const enabled = !off.has(t.key)
          const Icon = groupIcon[t.group] || Wrench
          return (
            <div key={t.key} className={`bg-white rounded-xl border p-5 transition hover:shadow-md ${enabled ? 'border-slate-200/80' : 'border-slate-200/80 opacity-70'}`}>
              <div className="flex items-start justify-between mb-2">
                <div className="flex items-center gap-2.5">
                  <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${t.group === 'TiMEM 上下文能力' ? 'bg-sky-50 text-sky-600' : t.group === '客户系统封装' ? 'bg-cyan-50 text-cyan-600' : 'bg-slate-100 text-slate-500'}`}><Icon size={16} /></div>
                  <div>
                    <code className="text-sm font-semibold text-slate-800">{t.name}</code>
                    <div className="flex gap-1.5 mt-0.5">
                      <span className={`text-[10px] px-1.5 py-0.5 rounded ${t.group === 'TiMEM 上下文能力' ? 'bg-sky-50 text-sky-600' : t.group === '客户系统封装' ? 'bg-cyan-50 text-cyan-600' : 'bg-slate-100 text-slate-500'}`}>{t.category || t.group}</span>
                    </div>
                  </div>
                </div>
                <button onClick={() => toggle(t.key)} className={`w-10 h-[22px] rounded-full transition relative shrink-0 ${enabled ? 'bg-blue-600' : 'bg-slate-200'}`}>
                  <span className={`absolute top-[3px] w-4 h-4 rounded-full bg-white shadow transition-all ${enabled ? 'left-[22px]' : 'left-[3px]'}`} />
                </button>
              </div>
              <p className="text-xs text-slate-500 leading-relaxed mb-3 min-h-[32px]">{t.desc}</p>
              <div className="flex items-center justify-between pt-3 border-t border-slate-50">
                <span className="text-[11px] text-slate-400">{t.extra} · 调用 {t.calls}</span>
                <button onClick={() => setDetail(t)} className="text-xs px-3 py-1.5 rounded-lg border border-slate-200 text-slate-600 hover:border-blue-300 hover:text-blue-600">配置</button>
              </div>
            </div>
          )
        })}
      </div>

      {/* 配置抽屉 */}
      {detail && (
        <div className="fixed inset-0 z-40 flex justify-end" onClick={() => setDetail(null)}>
          <div className="absolute inset-0 bg-slate-900/20" />
          <div className="relative w-full max-w-md bg-white h-full shadow-2xl p-6 overflow-y-auto" onClick={e => e.stopPropagation()} style={{ animation: 'slideIn .25s ease' }}>
            <div className="flex items-start justify-between mb-4">
              <div>
                <code className="text-lg font-semibold text-slate-800">{detail.name}</code>
                <div className="text-xs text-slate-400 mt-1">{detail.group}{detail.category ? ` · ${detail.category}` : ''}</div>
              </div>
              <button onClick={() => setDetail(null)} className="w-8 h-8 rounded-lg border border-slate-200 flex items-center justify-center text-slate-400 hover:bg-slate-50"><X size={15} /></button>
            </div>
            <p className="text-sm text-slate-600 leading-relaxed mb-5">{detail.desc}</p>
            <div className="space-y-4">
              <div>
                <div className="text-xs text-slate-400 mb-1.5">调用参数（Schema）</div>
                <pre className="text-[11px] bg-slate-900 text-slate-200 rounded-lg p-3.5 overflow-x-auto">{`{
  "query": "string, 检索/执行目标",
  "scope": "string, 项目或租户范围",
  "top_k": "number, 默认 5"
}`}</pre>
              </div>
              <div>
                <div className="text-xs text-slate-400 mb-1.5">MCP 调用示例</div>
                <pre className="text-[11px] bg-slate-900 text-slate-200 rounded-lg p-3.5 overflow-x-auto">{`await mcp.call("${detail.name}", {
  query: "2 号锅炉历史报警",
  scope: "huajing",
  top_k: 5
})`}</pre>
              </div>
              <div className="rounded-lg bg-slate-50 border border-slate-100 p-3.5 text-xs text-slate-500 leading-relaxed">
                鉴权：租户级 Token 自动注入；写操作类工具强制经过人在回路审批闸门；全部调用计入运营驾驶舱计量。
              </div>
            </div>
          </div>
        </div>
      )}
      <style>{`@keyframes slideIn { from { transform: translateX(40px); opacity: 0; } to { transform: none; opacity: 1; } }`}</style>
    </div>
  )
}

// ── DSH MCP 工具总线（真）：dsh-mcp-client → ctx.tools → @action/dsh-tool 桥 ──

function DshMcpPanel() {
  const [payload, setPayload] = useState<{ ok: boolean; hostAlive: boolean; toolsMounted: boolean; tools?: DshToolInfo[]; error?: string } | null>(null)
  const [openTool, setOpenTool] = useState('')
  const [argsText, setArgsText] = useState('{}')
  const [busyName, setBusyName] = useState('')
  const [result, setResult] = useState<{ name: string; text: string; ok: boolean } | null>(null)
  const [loadError, setLoadError] = useState('')

  const load = () => {
    fetchDshTools().then(setPayload).catch(e => setLoadError(e instanceof Error ? e.message : String(e)))
  }
  useEffect(() => { load() }, [])

  const run = async (name: string) => {
    if (busyName) return
    setBusyName(name); setResult(null)
    let args: Record<string, unknown> = {}
    try { args = JSON.parse(argsText || '{}') } catch { setBusyName(''); setResult({ name, text: 'args 不是合法 JSON', ok: false }); return }
    try {
      const r = await callDshTool(name, args)
      setResult({ name, ok: r.ok, text: r.ok ? JSON.stringify(r.value, null, 2) : (r.error ?? '调用失败') })
    } catch (e) {
      setResult({ name, ok: false, text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusyName('')
    }
  }

  const statusLine = !payload
    ? (loadError || '加载中…')
    : !payload.hostAlive
      ? 'DSH 宿主未启动（dsh_plugins 无启用插件时宿主懒创建）'
      : !payload.toolsMounted
        ? 'dsh-tools 未装载（检查 dsh_plugins 表 tools 行装载状态）'
        : `${payload.tools?.length ?? 0} 个工具已注册（公共名 mcp__<serverName>__<rawName>）`

  return (
    <div className="bg-white rounded-xl border border-sky-200 ring-1 ring-sky-100/60 p-5 space-y-3" style={{ animation: 'fadeSlide .3s ease' }}>
      <div className="flex items-center gap-2 flex-wrap">
        <PlugZap size={14} className="text-sky-500" />
        <h2 className="text-sm font-semibold text-slate-700">已接入 DSH · MCP 工具总线</h2>
        <span className="text-[10px] px-2 py-0.5 rounded-full bg-sky-50 text-sky-600 border border-sky-100">真 · dsh-mcp-client → ctx.tools → @action/dsh-tool</span>
        <button onClick={() => { setResult(null); load() }} className="ml-auto text-xs text-slate-400 hover:text-sky-600 flex items-center gap-1"><RefreshCw size={12} />刷新</button>
      </div>
      <p className="text-[11px] text-slate-400">{statusLine}</p>
      {payload?.error && <div className="text-xs text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{payload.error}</div>}
      {(payload?.tools?.length ?? 0) > 0 && (
        <div className="grid gap-2 md:grid-cols-2">
          {payload!.tools!.map(t => (
            <div key={t.name} className={`rounded-lg border p-3 transition ${openTool === t.name ? 'border-sky-300 bg-sky-50/40' : 'border-slate-100 bg-slate-50/60'}`}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <code className="text-[11px] font-semibold text-sky-700 break-all">{t.name}</code>
                  <div className="text-[11px] text-slate-400 mt-0.5 leading-snug">{t.description || '（无描述）'}</div>
                </div>
                <button onClick={() => { setOpenTool(openTool === t.name ? '' : t.name); setArgsText('{}'); setResult(null) }}
                  className="shrink-0 text-xs px-2.5 py-1.5 rounded-lg border border-sky-200 text-sky-600 hover:bg-sky-50 flex items-center gap-1">
                  {busyName === t.name ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}调用
                </button>
              </div>
              {openTool === t.name && (
                <div className="mt-2.5 space-y-2">
                  <textarea value={argsText} onChange={e => setArgsText(e.target.value)} rows={3}
                    placeholder='{"参数": "值"}'
                    className="w-full text-[11px] font-mono border border-slate-200 rounded-lg px-2.5 py-2 focus:outline-none focus:ring-2 focus:ring-blue-100" />
                  <button onClick={() => void run(t.name)} disabled={busyName === t.name}
                    className="text-xs px-3 py-1.5 rounded-lg bg-sky-600 text-white hover:bg-sky-700 disabled:opacity-50 flex items-center gap-1.5">
                    {busyName === t.name ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}运行
                  </button>
                  <div className="text-[10px] text-slate-400">入参 schema：{typeof t.parameters === 'object' ? JSON.stringify(t.parameters).slice(0, 160) : '—'}</div>
                  {result?.name === t.name && (
                    <pre className={`text-[11px] font-mono rounded-lg px-3 py-2 whitespace-pre-wrap max-h-56 overflow-y-auto ${result.ok ? 'bg-slate-900 text-emerald-300' : 'bg-red-50 text-red-600 border border-red-100'}`}>{result.text}</pre>
                  )}
                </div>
              )}
              {openTool !== t.name && result?.name === t.name && (
                <pre className={`mt-2 text-[11px] font-mono rounded-lg px-3 py-2 whitespace-pre-wrap max-h-40 overflow-y-auto ${result.ok ? 'bg-slate-900 text-emerald-300' : 'bg-red-50 text-red-600 border border-red-100'}`}>{result.text}</pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
