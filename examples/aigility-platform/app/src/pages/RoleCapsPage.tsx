/**
 * RoleCapsPage — 角色能力配置（DSH 渠道）
 *
 * 给角色配 skill / MCP 的管理页：读写 examples/feishu-dsh/roles.json
 * （单一事实源，DSH 会话中继每条消息热读取，保存即生效）。
 * 展示技能路径体检（missingSkills 标红）、路由映射编辑。
 */
import { useCallback, useEffect, useState } from 'react'
import {
  fetchRoles, saveRole, deleteRole, saveRoleRoute, fetchDshSkills, fetchMcpShelf,
  type RoleCapabilityConfig, type RoleMcpServer, type RolesPayload,
  type DshSkillInfo, type McpShelfItem,
} from '../lib/harness'
import { Loader2, Plus, Trash2, RefreshCw, Save, Route, Sparkles, AlertTriangle, Package } from 'lucide-react'

interface Draft {
  id: string
  label: string
  skillsText: string                      // 每行一个技能目录名/绝对路径
  mcpServers: RoleMcpServer[]
  isNew: boolean
}

function toDraft(id: string, cfg: RoleCapabilityConfig): Draft {
  return {
    id,
    label: cfg.label ?? '',
    skillsText: (cfg.skills ?? []).join('\n'),
    mcpServers: (cfg.mcpServers ?? []).map((s) => ({ ...s })),
    isNew: false,
  }
}

const emptyDraft = (): Draft => ({ id: '', label: '', skillsText: '', mcpServers: [], isNew: true })

export default function RoleCapsPage() {
  const [data, setData] = useState<RolesPayload | null>(null)
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [banner, setBanner] = useState('')
  const [error, setError] = useState('')
  const [routeKey, setRouteKey] = useState('')
  const [routeRole, setRouteRole] = useState('')
  const [shelfSkills, setShelfSkills] = useState<DshSkillInfo[]>([])
  const [mcpShelf, setMcpShelf] = useState<McpShelfItem[]>([])

  const reload = useCallback(async () => {
    const j = await fetchRoles()
    setData(j)
    setDrafts(Object.entries(j.roles).map(([id, cfg]) => toDraft(id, cfg)))
    fetchDshSkills().then((r) => setShelfSkills(r.skills)).catch(() => {})
    fetchMcpShelf().then(setMcpShelf).catch(() => {})
  }, [])

  useEffect(() => { reload().catch((e) => setError(String(e))) }, [reload])

  const patchDraft = (idx: number, patch: Partial<Draft>) =>
    setDrafts((ds) => ds.map((d, i) => (i === idx ? { ...d, ...patch } : d)))

  const save = async (d: Draft) => {
    setBusy(d.id || 'new'); setError(''); setBanner('')
    try {
      await saveRole(d.id.trim(), {
        label: d.label || undefined,
        skills: d.skillsText.split('\n').map((s) => s.trim()).filter(Boolean),
        mcpServers: d.mcpServers,
      })
      setBanner(`角色「${d.id}」已保存 → DSH 会话中继热生效（下一条消息即用新能力）`)
      await reload()
    } catch (e) { setError(String((e as Error).message ?? e)) } finally { setBusy(null) }
  }

  const remove = async (id: string) => {
    setBusy(id); setError('')
    try {
      await deleteRole(id)
      setBanner(`角色「${id}」已删除（指向它的路由一并清理）`)
      await reload()
    } catch (e) { setError(String(e)) } finally { setBusy(null) }
  }

  const addRoute = async () => {
    if (!routeKey.trim()) return
    setBusy('route'); setError('')
    try {
      await saveRoleRoute(routeKey.trim(), routeRole)
      setBanner(`路由已保存：${routeKey} → ${routeRole || '(删除)'}`)
      setRouteKey(''); setRouteRole('')
      await reload()
    } catch (e) { setError(String((e as Error).message ?? e)) } finally { setBusy(null) }
  }

  const patchServer = (di: number, si: number, patch: Partial<RoleMcpServer>) =>
    setDrafts((ds) => ds.map((d, i) =>
      i === di ? { ...d, mcpServers: d.mcpServers.map((s, j) => (j === si ? { ...s, ...patch } : s)) } : d))

  return (
    <div className="space-y-5">
      {/* 新手引导：这个页面管什么、怎么用、生效路径 */}
      <div className="bg-white rounded-xl border border-sky-200 ring-1 ring-sky-100/60 p-5">
        <div className="flex items-center gap-2 mb-2">
          <Route size={14} className="text-sky-500" />
          <h2 className="text-sm font-semibold text-slate-700">这个页面做什么</h2>
        </div>
        <p className="text-xs text-slate-500 leading-relaxed">
          这里配置的是 <b className="text-slate-700">IM 渠道数字分身</b>（如飞书机器人）背后的 AI 角色：给角色勾选 <b>Skill</b>（技能包）和 <b>MCP server</b>（外部工具），
          保存后该渠道的对话即刻按新能力回答——<b className="text-slate-700">无需重启，下一条消息生效</b>。
        </p>
        <div className="grid gap-2 md:grid-cols-3 mt-3">
          {[
            ['① 建角色 / 选角色', '每个角色是一套独立能力组合；未命中路由的对话走 default 角色'],
            ['② 勾技能、配工具', '技能从货架勾选（也可手填路径）；MCP 支持从货架复制或填连接配置'],
            ['③ 保存即生效', '配置写入注册表文件，IM 渠道每条消息实时读取最新配置'],
          ].map(([t, d]) => (
            <div key={t} className="rounded-lg bg-slate-50 border border-slate-100 p-3">
              <div className="text-[11px] font-medium text-slate-600 mb-0.5">{t}</div>
              <div className="text-[11px] text-slate-400 leading-snug">{d}</div>
            </div>
          ))}
        </div>
        <p className="text-[11px] text-slate-400 mt-3">
          与「智能体工厂」的关系：工厂发布的是对话工作台/智能体市场用的数字员工；本页角色服务 IM 渠道。
          发布时可勾选「同时注册为 DSH 技能」让两者打通。
        </p>
      </div>

      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-800">角色能力配置 · DSH 渠道</h1>
          <p className="text-sm text-slate-500 mt-1">
            给角色配 skill / MCP → 写入 {data?.registryFile ?? 'roles.json'} → DSH 会话中继热生效（无需重启）
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setDrafts((ds) => [...ds, emptyDraft()])}
            className="text-sm px-3 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 flex items-center gap-1.5">
            <Plus size={15} />新建角色
          </button>
          <button onClick={() => reload()} className="text-sm px-3 py-2 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 flex items-center gap-1.5">
            <RefreshCw size={15} />刷新
          </button>
        </div>
      </div>

      {banner && <div className="text-sm px-4 py-2.5 rounded-lg bg-emerald-50 text-emerald-700 border border-emerald-100">{banner}</div>}
      {error && <div className="text-sm px-4 py-2.5 rounded-lg bg-red-50 text-red-600 border border-red-100 whitespace-pre-wrap">{error}</div>}

      {/* 路由映射 */}
      <div className="bg-white rounded-xl border border-slate-200 p-5">
        <div className="flex items-center gap-2 mb-3"><Route size={15} className="text-slate-500" />
          <h2 className="text-sm font-semibold text-slate-700">路由映射（渠道身份 chatId / userId / appId → 角色；未命中走 default）</h2></div>
        <div className="flex flex-wrap gap-2 items-center">
          <input value={routeKey} onChange={(e) => setRouteKey(e.target.value)} placeholder="oc_xxx / ou_xxx / cli_xxx（渠道会话标识）"
            className="text-sm px-3 py-2 rounded-lg border border-slate-200 w-72" />
          <span className="text-slate-400 text-sm">→</span>
          <select value={routeRole} onChange={(e) => setRouteRole(e.target.value)} className="text-sm px-3 py-2 rounded-lg border border-slate-200">
            <option value="">（删除该路由）</option>
            {Object.keys(data?.roles ?? {}).map((id) => <option key={id} value={id}>{id}{data?.roles[id].label ? `（${data.roles[id].label}）` : ''}</option>)}
          </select>
          <button onClick={addRoute} disabled={busy === 'route'}
            className="text-sm px-3 py-2 rounded-lg bg-slate-700 text-white hover:bg-slate-800 flex items-center gap-1.5 disabled:opacity-50">
            {busy === 'route' ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}保存路由
          </button>
        </div>
        {Object.entries(data?.routes ?? {}).length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {Object.entries(data?.routes ?? {}).map(([k, v]) => (
              <span key={k} className="text-xs px-2.5 py-1 rounded-full bg-slate-100 text-slate-600">{k} → {v}</span>
            ))}
          </div>
        )}
      </div>

      {/* 角色卡片 */}
      {drafts.map((d, di) => {
        const missing = d.isNew ? [] : (data?.missingSkills?.[d.id] ?? [])
        return (
          <div key={di} className="bg-white rounded-xl border border-slate-200 p-5 space-y-4">
            <div className="flex items-center gap-3 flex-wrap">
              <input value={d.id} onChange={(e) => patchDraft(di, { id: e.target.value })} disabled={!d.isNew}
                placeholder="角色 id（如 default / readonly）"
                className="text-sm px-3 py-2 rounded-lg border border-slate-200 w-56 disabled:bg-slate-50 disabled:text-slate-500" />
              <input value={d.label} onChange={(e) => patchDraft(di, { label: e.target.value })} placeholder="展示名（可选）"
                className="text-sm px-3 py-2 rounded-lg border border-slate-200 w-56" />
              <div className="flex-1" />
              <button onClick={() => save(d)} disabled={busy === d.id || !d.id.trim()}
                className="text-sm px-3 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 flex items-center gap-1.5 disabled:opacity-50">
                {busy === d.id ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}保存
              </button>
              {!d.isNew && (
                <button onClick={() => remove(d.id)} disabled={busy === d.id}
                  className="text-sm px-3 py-2 rounded-lg border border-red-200 text-red-600 hover:bg-red-50 flex items-center gap-1.5 disabled:opacity-50">
                  <Trash2 size={14} />删除
                </button>
              )}
            </div>

            {/* skills */}
            <div>
              <label className="text-xs text-slate-500 block mb-1 flex items-center gap-1">
                <Sparkles size={12} />技能目录（每行一个：skillsRoot 下的目录名，或绝对路径；目录内需含 SKILL.md）
              </label>
              {shelfSkills.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {shelfSkills.map((s) => {
                    const lines = d.skillsText.split('\n').map((x) => x.trim()).filter(Boolean)
                    const on = lines.includes(s.dir)
                    return (
                      <button key={s.dir} title={s.description || s.dir}
                        onClick={() => patchDraft(di, { skillsText: (on ? lines.filter((l) => l !== s.dir) : [...lines, s.dir]).join('\n') })}
                        className={`text-xs px-2.5 py-1.5 rounded-lg border transition flex items-center gap-1 ${on ? 'border-blue-300 bg-blue-50 text-blue-700' : 'border-slate-200 text-slate-500 hover:border-blue-200'}`}>
                        <Package size={11} />{s.dir}
                      </button>
                    )
                  })}
                </div>
              )}
              <textarea value={d.skillsText} onChange={(e) => patchDraft(di, { skillsText: e.target.value })}
                rows={Math.max(2, d.skillsText.split('\n').length)}
                placeholder={'demo-greeting\n/home/.../examples/feishu-dsh/skills/phase2-skill'}
                className="w-full text-sm px-3 py-2 rounded-lg border border-slate-200 font-mono" />
              {missing.map((m) => (
                <div key={m} className="text-xs text-red-500 flex items-center gap-1 mt-1"><AlertTriangle size={11} />路径不存在：{m}</div>
              ))}
            </div>

            {/* mcpServers */}
            <div>
              <div className="text-xs text-slate-500 mb-1 flex items-center gap-2 flex-wrap">
                <span>MCP servers（serverName 即工具前缀 mcp__&lt;serverName&gt;__&lt;rawName&gt;）</span>
                {mcpShelf.length > 0 && (
                  <select className="text-xs px-2 py-1 rounded-lg border border-slate-200 text-slate-600"
                    value="" onChange={(e) => {
                      const pick = mcpShelf.find((x) => x.serverName === e.target.value)
                      if (!pick) return
                      const { usedBy: _u, ...cfg } = pick
                      patchDraft(di, { mcpServers: [...d.mcpServers.filter((s) => s.serverName !== pick.serverName), { ...cfg }] })
                    }}>
                    <option value="">＋ 从货架复制 server 配置…</option>
                    {mcpShelf.map((s) => (
                      <option key={s.serverName} value={s.serverName}>
                        {s.serverName}{s.url ? `（${s.url}）` : ''}{s.usedBy.length ? ` · 已用于 ${s.usedBy.join(',')}` : ''}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              <div className="space-y-2">
                {d.mcpServers.map((s, si) => (
                  <div key={si} className="flex flex-wrap gap-2 items-center text-sm">
                    <input value={s.serverName} onChange={(e) => patchServer(di, si, { serverName: e.target.value })}
                      placeholder="serverName" className="px-2.5 py-1.5 rounded-lg border border-slate-200 w-32" />
                    <input value={s.url ?? ''} onChange={(e) => patchServer(di, si, { url: e.target.value || undefined, command: e.target.value ? undefined : s.command })}
                      placeholder="url（http 传输，二选一）" className="px-2.5 py-1.5 rounded-lg border border-slate-200 w-64" />
                    <input value={s.command ?? ''} onChange={(e) => patchServer(di, si, { command: e.target.value || undefined, url: e.target.value ? undefined : s.url })}
                      placeholder="command（stdio，二选一）" className="px-2.5 py-1.5 rounded-lg border border-slate-200 w-48" />
                    <input value={(s.args ?? []).join(' ')} onChange={(e) => patchServer(di, si, { args: e.target.value.split(' ').filter(Boolean) })}
                      placeholder="args（空格分隔）" className="px-2.5 py-1.5 rounded-lg border border-slate-200 flex-1 min-w-48" />
                    <button onClick={() => patchDraft(di, { mcpServers: d.mcpServers.filter((_, j) => j !== si) })}
                      className="p-1.5 rounded-lg text-red-500 hover:bg-red-50"><Trash2 size={14} /></button>
                  </div>
                ))}
                <button onClick={() => patchDraft(di, { mcpServers: [...d.mcpServers, { serverName: '' }] })}
                  className="text-xs px-2.5 py-1.5 rounded-lg border border-dashed border-slate-300 text-slate-500 hover:bg-slate-50 flex items-center gap-1">
                  <Plus size={12} />添加 MCP server
                </button>
              </div>
            </div>
          </div>
        )
      })}

      {drafts.length === 0 && (
        <div className="text-sm text-slate-400 px-4 py-10 text-center bg-white rounded-xl border border-dashed border-slate-200">
          还没有角色，点「新建角色」开始；DSH 机器人未命中任何路由时使用 default 角色
        </div>
      )}
    </div>
  )
}
