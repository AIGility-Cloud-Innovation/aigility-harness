import { useEffect, useState } from 'react'
import { mcpTools, pluginTools } from '../mock/data'
import { fetchCapabilities, fetchDshTools, callDshTool, fetchInstalledPlugins, installPlugin, togglePlugin, uninstallPlugin, discoverPlugins, type CapabilityInfo, type DshToolInfo, type InstalledPlugin, type DiscoverPluginItem } from '../lib/harness'
import { Wrench, X, Plug, Hexagon, Building2, Blocks, Radio, PlugZap, Play, Loader2, RefreshCw, Trash2, Lock, Plus, Search } from 'lucide-react'

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

export default function ToolsPage({ showMock = true }: { showMock?: boolean }) {
  const [group, setGroup] = useState<(typeof groups)[number]>('全部')
  const [off, setOff] = useState<Set<string>>(new Set(allTools.filter(t => !t.enabled).map(t => t.key)))
  const [detail, setDetail] = useState<ToolItem | null>(null)
  const [capabilities, setCapabilities] = useState<CapabilityInfo[]>([])
  // 社区发现 → 安装表单的预填通道（token 变化触发填表）
  const [seedInstall, setSeedInstall] = useState<SeedInstall | null>(null)

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

      {/* 已安装插件（真 · dsh_plugins 注册表 + 热装卸）：装什么插件就变成什么工作台 */}
      <InstalledPluginsPanel seed={seedInstall} />

      {/* 社区插件发现（真 · npm registry 检索 dsh-plugin 生态）：发现 → 填入上方安装表单 → 热装载 */}
      <PluginDiscoverPanel onPick={setSeedInstall} />

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

      {showMock ? (
        <>
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
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-600 border border-amber-100">模拟</span>
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
      </>
      ) : (
        <div className="text-xs px-4 py-3 rounded-lg bg-emerald-50 text-emerald-700 border border-emerald-100">
          模拟数据已隐藏 —— 此处仅剩真实数据源：DSH MCP 工具总线与引擎能力总线（上方两块）。模拟工具货架可随时用顶栏「模拟数据」开关恢复。
        </div>
      )}

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

// ── 已安装插件（真 · dsh_plugins 注册表 + dsh-host 热装卸）────────────────
// 安装一条 = dsh_plugins 插一行 + dshLoadPlugin 热装载, 免重启。两种类型：
// MCP server: package=@deepseek-ai/dsh-mcp-client + config={transport:'stdio', serverName, command, args}
// DSH 插件包: package=<npm 包名>（社区/官方 cordis 插件, 进程内装载, 依赖的 dsh 服务行需已装）

const PROTECTED_PLUGINS = ['system-prompt', 'tools']

export type InstallKind = 'mcp' | 'dsh'

export interface SeedInstall {
  token: number
  kind: InstallKind
  name: string
  package?: string
  description?: string
}

function InstalledPluginsPanel({ seed }: { seed?: SeedInstall | null }) {
  const [plugins, setPlugins] = useState<InstalledPlugin[]>([])
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')
  const [kind, setKind] = useState<InstallKind>('mcp')
  const [form, setForm] = useState({ name: '', package: '', exportName: '', command: '', args: '', description: '' })

  const reload = () => { fetchInstalledPlugins().then(setPlugins).catch(() => {}) }
  useEffect(reload, [])

  // 社区目录「填入安装表单」：预填类型与字段
  useEffect(() => {
    if (!seed) return
    setKind(seed.kind)
    setForm(f => ({
      ...f,
      name: seed.name,
      package: seed.kind === 'dsh' ? (seed.package ?? '') : '',
      command: '', args: '', exportName: '',
      description: seed.description ?? '',
    }))
    setMsg(`已从社区目录填入「${seed.name}」——第三方插件为进程内装载，建议先看 repo 确认再点安装`)
  }, [seed?.token])

  const install = async () => {
    const name = form.name.trim()
    if (!name || busy) return
    setBusy(name)
    setMsg('')
    try {
      const input = kind === 'mcp'
        ? {
            name,
            package: '@deepseek-ai/dsh-mcp-client',
            description: form.description.trim() || `MCP server: ${form.command.trim()}`,
            config: {
              transport: 'stdio', serverName: name, command: form.command.trim(),
              args: form.args.trim() ? form.args.trim().split(/\s+/) : [],
            },
          }
        : {
            name,
            package: form.package.trim(),
            exportName: form.exportName.trim() || undefined,
            description: form.description.trim(),
            config: {},
          }
      const r = await installPlugin(input)
      setMsg(r.loaded
        ? `已安装并热装载「${name}」——立即生效（${kind === 'mcp' ? '上方工具总线可验证' : '进程内能力已挂载'}）`
        : `已登记「${name}」但装载失败：${r.error ?? '?'}（检查包名/依赖的 dsh 服务行是否齐备）`)
      setForm({ name: '', package: '', exportName: '', command: '', args: '', description: '' })
      reload()
    } catch (e) {
      setMsg(`安装失败：${String(e)}`)
    } finally {
      setBusy('')
    }
  }

  const toggle = async (p: InstalledPlugin) => {
    if (busy) return
    setBusy(p.name)
    setMsg('')
    try {
      const next = !p.enabled
      const r = await togglePlugin(p.name, next)
      if (next && !r.loaded) setMsg(`「${p.name}」已启用但装载失败：${r.error ?? '?'}（行保留, 修复命令后重新开启）`)
      reload()
    } finally {
      setBusy('')
    }
  }

  const uninstall = async (p: InstalledPlugin) => {
    if (busy || PROTECTED_PLUGINS.includes(p.name)) return
    setBusy(p.name)
    setMsg('')
    try {
      await uninstallPlugin(p.name)
      setMsg(`已卸载「${p.name}」（注册表行已删除, 热卸载生效）`)
      reload()
    } catch (e) {
      setMsg(`卸载失败：${String(e)}`)
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="bg-white rounded-xl border border-violet-200 ring-1 ring-violet-100/60 p-5" style={{ animation: 'fadeSlide .3s ease' }}>
      <div className="flex items-center gap-2 mb-1">
        <PlugZap size={14} className="text-violet-500" />
        <h2 className="text-sm font-semibold text-slate-700">已安装插件 · 安装即生效</h2>
        <span className="text-[10px] px-2 py-0.5 rounded-full bg-violet-50 text-violet-600 border border-violet-100">真 · {plugins.length} 个（dsh_plugins 注册表）</span>
      </div>
      <p className="text-[11px] text-slate-400 mb-3">装什么插件就变成什么工作台：MCP server 填一条启动命令、DSH 插件包填 npm 包名，热装载免重启。官方/社区插件（filesystem、neo4j、milvus…）装完即用。变更入审计日志。</p>

      {/* 安装表单：MCP server（命令声明）或 DSH 插件包（npm 包） */}
      <div className="rounded-lg border border-slate-100 bg-slate-50/60 p-3 mb-3">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-[11px] text-slate-500">安装类型：</span>
          {([['mcp', 'MCP server（命令声明）'], ['dsh', 'DSH 插件包（npm 包）']] as const).map(([k, label]) => (
            <button key={k} onClick={() => setKind(k)}
              className={`text-[11px] px-2.5 py-1 rounded-full border transition ${kind === k ? 'bg-violet-600 text-white border-violet-600' : 'bg-white text-slate-500 border-slate-200 hover:border-violet-300'}`}>
              {label}
            </button>
          ))}
        </div>
        {kind === 'mcp' ? (
          <div className="grid gap-2 md:grid-cols-[1fr_1.4fr_1fr_auto] items-end">
            <label className="text-[11px] text-slate-500">插件名（唯一标识）
              <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="neo4j"
                className="mt-1 w-full text-xs px-2.5 py-1.5 bg-white border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-violet-100" />
            </label>
            <label className="text-[11px] text-slate-500">启动命令（如 npx / docker / 可执行文件）
              <input value={form.command} onChange={e => setForm(f => ({ ...f, command: e.target.value }))} placeholder="npx -y @neo4j/mcp-neo4j-cypher"
                className="mt-1 w-full text-xs px-2.5 py-1.5 bg-white border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-violet-100" />
            </label>
            <label className="text-[11px] text-slate-500">备注（可选）
              <input value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder="Neo4j 图谱查询"
                className="mt-1 w-full text-xs px-2.5 py-1.5 bg-white border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-violet-100" />
            </label>
            <button onClick={install} disabled={busy === form.name.trim() || !form.name.trim() || !form.command.trim()}
              className="text-xs px-4 py-1.5 rounded-md bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50 flex items-center gap-1.5 whitespace-nowrap">
              {busy === form.name.trim() ? <Loader2 size={13} className="animate-spin" /> : <Plus />}
              安装
            </button>
            <p className="md:col-span-4 text-[10px] text-slate-400">命令首词为可执行文件、其余为参数（空格分隔）。安装 = dsh_plugins 插行 + 热装载 + 审计留痕；工具经 ctx.tools 以 mcp__&lt;插件名&gt;__&lt;工具名&gt; 暴露。</p>
          </div>
        ) : (
          <div className="grid gap-2 md:grid-cols-[1fr_1.4fr_0.8fr_1fr_auto] items-end">
            <label className="text-[11px] text-slate-500">插件名（注册表行 id）
              <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="context-milvus"
                className="mt-1 w-full text-xs px-2.5 py-1.5 bg-white border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-violet-100" />
            </label>
            <label className="text-[11px] text-slate-500">npm 包名
              <input value={form.package} onChange={e => setForm(f => ({ ...f, package: e.target.value }))} placeholder="dsh-context-milvus"
                className="mt-1 w-full text-xs px-2.5 py-1.5 bg-white border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-violet-100" />
            </label>
            <label className="text-[11px] text-slate-500">导出名（可选）
              <input value={form.exportName} onChange={e => setForm(f => ({ ...f, exportName: e.target.value }))} placeholder="默认入口"
                className="mt-1 w-full text-xs px-2.5 py-1.5 bg-white border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-violet-100" />
            </label>
            <label className="text-[11px] text-slate-500">备注（可选）
              <input value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder="Milvus 语义检索"
                className="mt-1 w-full text-xs px-2.5 py-1.5 bg-white border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-violet-100" />
            </label>
            <button onClick={install} disabled={busy === form.name.trim() || !form.name.trim() || !form.package.trim()}
              className="text-xs px-4 py-1.5 rounded-md bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50 flex items-center gap-1.5 whitespace-nowrap">
              {busy === form.name.trim() ? <Loader2 size={13} className="animate-spin" /> : <Plus />}
              安装
            </button>
            <p className="md:col-span-5 text-[10px] text-slate-400">进程内装载 cordis 插件（export apply）；插件依赖的 dsh 服务行（如 dsh-session/dsh-llm）需已在注册表，装载失败信息会指路。第三方插件建议装前看 repo、锁版本、进准入清单。</p>
          </div>
        )}
      </div>

      {msg && <div className="mb-3 text-[11px] px-3 py-2 rounded-lg bg-slate-50 border border-slate-100 text-slate-600">{msg}</div>}

      {/* 插件清单 */}
      <div className="space-y-2">
        {plugins.map(p => {
          const protectedRow = PROTECTED_PLUGINS.includes(p.name)
          const loaded = !!p.runtime.at
          return (
            <div key={p.name} className="flex items-center gap-3 rounded-lg border border-slate-100 px-3 py-2.5">
              <Blocks size={14} className={p.enabled ? 'text-violet-500' : 'text-slate-300'} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs font-medium text-slate-700">{p.name}</span>
                  <code className="text-[10px] text-slate-400 truncate max-w-[320px]">{p.package}</code>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${loaded ? 'bg-emerald-50 text-emerald-600 border-emerald-100' : p.runtime.error ? 'bg-red-50 text-red-600 border-red-100' : 'bg-slate-50 text-slate-400 border-slate-100'}`}>
                    {loaded ? `已装载 ${String(p.runtime.at).slice(11, 19)}` : p.runtime.error ? `装载失败` : p.enabled ? '待装载' : '未启用'}
                  </span>
                </div>
                <div className="text-[11px] text-slate-400 truncate">{p.description}{p.runtime.error ? ` · ${p.runtime.error}` : ''}</div>
              </div>
              <button onClick={() => toggle(p)} disabled={busy === p.name || (protectedRow && p.enabled)}
                title={protectedRow ? '平台关键插件不可停用' : undefined}
                className={`w-9 h-5 rounded-full relative transition shrink-0 ${p.enabled ? 'bg-violet-600' : 'bg-slate-200'} ${(protectedRow && p.enabled) || busy === p.name ? 'opacity-50 cursor-not-allowed' : ''}`}>
                <span className={`absolute top-[2px] w-4 h-4 rounded-full bg-white shadow transition-all ${p.enabled ? 'left-[17px]' : 'left-[2px]'}`} />
              </button>
              <button onClick={() => uninstall(p)} disabled={busy === p.name || protectedRow}
                title={protectedRow ? '平台关键插件不可卸载' : '卸载'}
                className={`text-slate-300 hover:text-red-500 transition shrink-0 ${protectedRow ? 'opacity-30 cursor-not-allowed' : ''}`}>
                {protectedRow ? <Lock size={13} /> : busy === p.name ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
              </button>
            </div>
          )
        })}
      </div>
      <style>{`@keyframes fadeSlide { from { opacity: 0; transform: translateY(4px);} to { opacity: 1; transform: none; } }`}</style>
    </div>
  )
}

// ── 社区插件发现（真 · npm registry 检索 dsh-plugin 生态）────────────────
// GitHub topic dsh-plugin 自动收录 → npm 可检索；按关键词粗分类，点「填入安装」预填上方表单。

const DISCOVER_CATS: Array<{ cat: string; test: RegExp }> = [
  { cat: '知识/检索', test: /context|search|rag|knowledge|milvus|vector|retriev|graph/i },
  { cat: '记忆/压缩', test: /memory|compact|checkpoint|lens/i },
  { cat: '运维/健康', test: /ops|health|monitor|observ|diagnos|audit/i },
  { cat: '模型/路由', test: /model|proxy|router|llm/i },
  { cat: '通知/集成', test: /notif|message|feishu|wecom|slack|bridge|webhook|mcp/i },
  { cat: '审批/编排', test: /approv|workflow|task|goal|plan/i },
  { cat: '技能/Agent', test: /skill|agent|persona/i },
  { cat: '外观/主题', test: /theme|skin|sidebar|panel|ui/i },
  { cat: '安全/回滚', test: /rollback|sandbox|guard|safe|time-machine/i },
  { cat: '截图/视觉', test: /screenshot|shot|vision|image/i },
]

const categorizePlugin = (p: DiscoverPluginItem): string =>
  DISCOVER_CATS.find(c => c.test.test(p.name) || c.test.test(p.description))?.cat ?? '通用'

const suggestRowId = (pkgName: string): string => {
  const base = pkgName.includes('/') ? pkgName.split('/')[1] : pkgName
  return base.replace(/^dsh[-_]/, '') || pkgName
}

function PluginDiscoverPanel({ onPick }: { onPick: (seed: SeedInstall) => void }) {
  const [q, setQ] = useState('dsh-plugin')
  const [items, setItems] = useState<DiscoverPluginItem[]>([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [cat, setCat] = useState('全部')

  const load = (query: string) => {
    setLoading(true)
    setErr('')
    discoverPlugins(query)
      .then(r => { setItems(r.items ?? []); if (!r.ok) setErr(r.error ?? '发现失败') })
      .catch(e => setErr(String(e)))
      .finally(() => setLoading(false))
  }
  useEffect(() => { load('dsh-plugin') }, [])

  const cats = ['全部', ...Array.from(new Set(items.map(categorizePlugin)))]
  const list = items.filter(p => cat === '全部' || categorizePlugin(p) === cat)

  return (
    <div className="bg-white rounded-xl border border-sky-200 ring-1 ring-sky-100/60 p-5">
      <div className="flex items-center gap-2 mb-1 flex-wrap">
        <Search size={14} className="text-sky-500" />
        <h2 className="text-sm font-semibold text-slate-700">社区插件发现</h2>
        <span className="text-[10px] px-2 py-0.5 rounded-full bg-sky-50 text-sky-600 border border-sky-100">真 · npm dsh-plugin 生态</span>
        <span className="text-[10px] text-slate-400">GitHub topic dsh-plugin 收录 · 第三方社区维护，装前看 repo、锁版本</span>
      </div>
      <div className="flex gap-2 mb-3">
        <input value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') load(q) }}
          placeholder="检索 npm：dsh-plugin / knowledge / notification / milvus / model proxy…"
          className="flex-1 text-xs px-3 py-2 bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-sky-100" />
        <button onClick={() => load(q)} disabled={loading}
          className="text-xs px-3 py-2 rounded-lg bg-sky-600 text-white hover:bg-sky-700 disabled:opacity-50 flex items-center gap-1.5">
          {loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} 搜索
        </button>
      </div>
      {err && <div className="mb-3 text-[11px] px-3 py-2 rounded-lg bg-amber-50 border border-amber-100 text-amber-700">{err}（服务端可用 NPM_REGISTRY_URL 配置镜像源）</div>}
      {items.length > 0 && (
        <div className="flex gap-1.5 flex-wrap mb-2">
          {cats.map(c => (
            <button key={c} onClick={() => setCat(c)}
              className={`text-[10px] px-2 py-1 rounded-full border transition ${cat === c ? 'bg-sky-600 text-white border-sky-600' : 'bg-white text-slate-500 border-slate-200 hover:border-sky-300'}`}>{c}</button>
          ))}
        </div>
      )}
      <div className="space-y-1.5 max-h-80 overflow-y-auto">
        {list.map(p => (
          <div key={p.name} className="flex items-center gap-2.5 rounded-lg border border-slate-100 px-3 py-2">
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-sky-50 text-sky-600 border border-sky-100 shrink-0">{categorizePlugin(p)}</span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <a href={p.repo || p.npm} target="_blank" rel="noreferrer" className="text-xs font-medium text-slate-700 hover:text-sky-600">{p.name}</a>
                <code className="text-[10px] text-slate-400">v{p.version}</code>
                <span className="text-[10px] text-slate-300">{String(p.date).slice(0, 10)}</span>
              </div>
              <div className="text-[11px] text-slate-400 truncate">{p.description || '（无描述）'}</div>
            </div>
            <button onClick={() => onPick({ token: Date.now(), kind: 'dsh', name: suggestRowId(p.name), package: p.name, description: p.description })}
              className="text-[11px] px-2.5 py-1 rounded-md border border-violet-200 text-violet-600 hover:bg-violet-50 transition shrink-0 flex items-center gap-1">
              <Plus size={11} /> 填入安装
            </button>
          </div>
        ))}
        {!loading && list.length === 0 && <div className="text-xs text-slate-400 text-center py-4">{err ? '' : '没有匹配的插件，换个关键词试试'}</div>}
      </div>
    </div>
  )
}

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
