/**
 * RoleDshEditor — 单角色 IM 能力编辑器（skill/MCP/通道声明）
 *
 * 一个角色一份能力组合：roles.json（skill/MCP，DSH 中继热读取）+ role-manifests.json
 * （通道声明，记忆域恒=角色 ID）。被两处复用：
 *  - 智能体工厂编辑界面（roleId = 已发布技能 id —— 角色的 IM 面）；
 *  - 「通道与角色」页（roleId = default/readonly 等渠道路由系统角色）。
 *
 * 技能/MCP 走草稿+保存；通道声明即时保存（对齐既有交互）。服务端校验前置 + 审计。
 */
import { useCallback, useEffect, useState } from 'react'
import {
  fetchRoles, saveRole, fetchDshSkills, fetchMcpShelf, fetchRoleManifests, saveRoleManifest, fetchWorkflows,
  type RoleMcpServer, type RolesPayload, type DshSkillInfo, type McpShelfItem, type RoleManifestView,
} from '../lib/harness'
import { Loader2, Plus, Trash2, Save, Sparkles, AlertTriangle, Package, MessageSquare, CheckCircle2, GitBranch } from 'lucide-react'

export interface RoleDshEditorProps {
  /** roles.json 角色 id（= 工厂技能 id 或 default/readonly 等系统角色） */
  roleId: string
  /** 展示名（首次启用/创建通道声明时用） */
  label: string
  /** 保存成功后回调（父级刷新数据用） */
  onChanged?: () => void
  /** 头部右侧动作（父级插按钮） */
  headerExtra?: React.ReactNode
  /** 渲染哪些区块（缺省全部）：ability=技能/MCP, workflow=编排委托(D4), channel=通道声明(D1) */
  sections?: Array<'ability' | 'workflow' | 'channel'>
}

export default function RoleDshEditor({ roleId, label, onChanged, headerExtra, sections = ['ability', 'workflow', 'channel'] }: RoleDshEditorProps) {
  const show = (k: 'ability' | 'workflow' | 'channel') => sections.includes(k)
  const [roleCfg, setRoleCfg] = useState<RolesPayload['roles'][string] | null>(null)
  const [skillsText, setSkillsText] = useState('')
  const [mcpServers, setMcpServers] = useState<RoleMcpServer[]>([])
  const [shelfSkills, setShelfSkills] = useState<DshSkillInfo[]>([])
  const [mcpShelf, setMcpShelf] = useState<McpShelfItem[]>([])
  const [missing, setMissing] = useState<string[]>([])
  const [manifest, setManifest] = useState<RoleManifestView | null>(null)
  const [workflows, setWorkflows] = useState<Array<{ id: string; name: string }>>([])
  const [busy, setBusy] = useState(false)
  const [banner, setBanner] = useState('')
  const [error, setError] = useState('')

  const reload = useCallback(async () => {
    const [j, shelf, mshelf, mans, wfs] = await Promise.all([
      fetchRoles(), fetchDshSkills().catch(() => ({ skills: [] as DshSkillInfo[] })),
      fetchMcpShelf().catch(() => [] as McpShelfItem[]), fetchRoleManifests().catch(() => []),
      fetchWorkflows().catch(() => []),
    ])
    setWorkflows(wfs)
    const cfg = j.roles[roleId] ?? null
    setRoleCfg(cfg)
    setSkillsText((cfg?.skills ?? []).join('\n'))
    setMcpServers((cfg?.mcpServers ?? []).map((s) => ({ ...s })))
    setMissing(j.missingSkills?.[roleId] ?? [])
    setShelfSkills(shelf.skills ?? [])
    setMcpShelf(mshelf)
    setManifest(mans.find((m) => m.role_id === roleId) ?? null)
  }, [roleId])

  useEffect(() => { reload().catch((e) => setError(String((e as Error).message ?? e))) }, [reload])

  /** 保存 skill/MCP 到 roles.json（无角色时自动创建）→ DSH 中继热生效 */
  const saveCaps = async () => {
    setBusy(true); setError(''); setBanner('')
    try {
      await saveRole(roleId, {
        label: roleCfg?.label || label || undefined,
        skills: skillsText.split('\n').map((s) => s.trim()).filter(Boolean),
        mcpServers,
      })
      setBanner(`「${roleId}」能力已保存 → IM 渠道热生效（下一条消息即用新能力）`)
      await reload()
      onChanged?.()
    } catch (e) { setError(String((e as Error).message ?? e)) } finally { setBusy(false) }
  }

  /** 启用 IM 能力：roles.json 尚无该角色时一键创建（label=展示名） */
  const enableCaps = async () => {
    setBusy(true); setError('')
    try {
      await saveRole(roleId, { label: label || undefined, skills: [], mcpServers: [] })
      await reload()
      onChanged?.()
    } catch (e) { setError(String((e as Error).message ?? e)) } finally { setBusy(false) }
  }

  /** 保存通道声明（即时；记忆域恒=角色 ID, 基线 3/4） */
  const saveChannels = async (channels: NonNullable<RoleManifestView['sources']['channels']>) => {
    setError(''); setBanner('')
    try {
      const next: RoleManifestView = {
        role_id: roleId,
        identity: { name: manifest?.identity.name || label || roleId, capability_ref: manifest?.identity.capability_ref ?? roleId },
        sources: { channels: channels.length ? channels : undefined, data: manifest?.sources.data ?? [] },
        actions: { tools: manifest?.actions.tools ?? [], workflows: manifest?.actions.workflows ?? [], engine: manifest?.actions.engine },
        outbound: { reply: manifest?.outbound.reply, push: manifest?.outbound.push ?? [] },
        memory: { agent_id: roleId },
      }
      await saveRoleManifest(next)
      setManifest(next)
      setBanner(channels.length
        ? `通道声明已保存：${channels.map((c) => `${c.platform}×${c.apps.length}`).join('、')}`
        : '通道声明已清空（纯网页/后台角色）')
      onChanged?.()
    } catch (e) { setError(String((e as Error).message ?? e)) }
  }

  /** 编排委托（D4）：角色可委托的数据面工作流（声明存 manifest.actions.workflows） */
  const toggleWorkflow = async (wfId: string) => {
    setError(''); setBanner('')
    try {
      const base: RoleManifestView = manifest ?? {
        role_id: roleId, identity: { name: label || roleId, capability_ref: roleId },
        sources: {}, actions: { tools: [], workflows: [] }, outbound: {}, memory: { agent_id: roleId },
      }
      const cur = base.actions.workflows ?? []
      const next = cur.includes(wfId) ? cur.filter((x) => x !== wfId) : [...cur, wfId]
      const nextManifest: RoleManifestView = { ...base, actions: { ...base.actions, workflows: next } }
      await saveRoleManifest(nextManifest)
      setManifest(nextManifest)
      setBanner(next.length ? `编排委托已更新：${next.join('、')}` : '编排委托已清空')
      onChanged?.()
    } catch (e) { setError(String((e as Error).message ?? e)) }
  }

  const addChannelApp = (platform: 'feishu' | 'wecom', app: string) => {
    const channels = [...(manifest?.sources.channels ?? [])]
    const ch = channels.find((c) => c.platform === platform)
    if (ch) {
      if (!ch.apps.some((a) => a.app === app)) ch.apps = [...ch.apps, { app, mention_only: true }]
    } else channels.push({ platform, apps: [{ app, mention_only: true }] })
    void saveChannels(channels)
  }

  const removeChannelApp = (platform: 'feishu' | 'wecom', app: string) => {
    const channels = (manifest?.sources.channels ?? [])
      .map((c) => (c.platform === platform ? { ...c, apps: c.apps.filter((a) => a.app !== app) } : c))
      .filter((c) => c.apps.length > 0)
    void saveChannels(channels)
  }

  const patchServer = (si: number, patch: Partial<RoleMcpServer>) =>
    setMcpServers((ss) => ss.map((s, j) => (j === si ? { ...s, ...patch } : s)))

  const toggleShelfSkill = (dir: string) => {
    const lines = skillsText.split('\n').map((x) => x.trim()).filter(Boolean)
    setSkillsText((lines.includes(dir) ? lines.filter((l) => l !== dir) : [...lines, dir]).join('\n'))
  }

  const channels = manifest?.sources.channels ?? []

  return (
    <div className="bg-white rounded-xl border border-slate-200/80 p-5 space-y-4">
      {/* 头部 */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm font-medium text-slate-800">{roleId}</span>
        {roleCfg?.label && <span className="text-xs text-slate-400">{roleCfg.label}</span>}
        {channels.length > 0 && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-sky-50 text-sky-600 border border-sky-100">
            IM 外勤：{channels.map((c) => c.platform).join('、')}
          </span>
        )}
        <div className="flex-1" />
        {headerExtra}
        {roleCfg && (
          <button onClick={saveCaps} disabled={busy}
            className="text-xs px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1.5">
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}保存能力
          </button>
        )}
      </div>

      {banner && <div className="text-xs px-3 py-2 rounded-lg bg-emerald-50 text-emerald-700 border border-emerald-100 flex items-center gap-1.5"><CheckCircle2 size={13} />{banner}</div>}
      {error && <div className="text-xs px-3 py-2 rounded-lg bg-red-50 text-red-600 border border-red-100">{error}</div>}

      {!roleCfg && show('ability') ? (
        /* 未启用：一键创建角色（空能力组合） */
        <div className="rounded-lg border border-dashed border-slate-200 p-4 text-center">
          <p className="text-xs text-slate-400 mb-2">该角色尚未注册到 IM 渠道（roles.json 无此角色）——启用后可勾选技能与 MCP 工具，飞书/企微机器人即可使用</p>
          <button onClick={enableCaps} disabled={busy}
            className="text-xs px-3 py-1.5 rounded-lg bg-sky-600 text-white hover:bg-sky-700 disabled:opacity-50 flex items-center gap-1.5 mx-auto">
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}启用 IM 能力
          </button>
        </div>
      ) : show('ability') ? (
        <>
          {/* 技能 */}
          <div>
            <label className="text-xs text-slate-500 block mb-1 flex items-center gap-1">
              <Sparkles size={12} />技能目录（每行一个：skillsRoot 下的目录名，或绝对路径；目录内需含 SKILL.md）
            </label>
            {shelfSkills.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-2">
                {shelfSkills.map((s) => {
                  const lines = skillsText.split('\n').map((x) => x.trim()).filter(Boolean)
                  const on = lines.includes(s.dir)
                  return (
                    <button key={s.dir} title={s.description || s.dir} onClick={() => toggleShelfSkill(s.dir)}
                      className={`text-xs px-2.5 py-1.5 rounded-lg border transition flex items-center gap-1 ${on ? 'border-blue-300 bg-blue-50 text-blue-700' : 'border-slate-200 text-slate-500 hover:border-blue-200'}`}>
                      <Package size={11} />{s.dir}
                    </button>
                  )
                })}
              </div>
            )}
            <textarea value={skillsText} onChange={(e) => setSkillsText(e.target.value)}
              rows={Math.max(2, skillsText.split('\n').length)}
              placeholder={'demo-greeting\n/home/.../examples/feishu-dsh/skills/phase2-skill'}
              className="w-full text-sm px-3 py-2 rounded-lg border border-slate-200 font-mono" />
            {missing.map((m) => (
              <div key={m} className="text-xs text-red-500 flex items-center gap-1 mt-1"><AlertTriangle size={11} />路径不存在：{m}</div>
            ))}
          </div>

          {/* MCP servers */}
          <div>
            <div className="text-xs text-slate-500 mb-1 flex items-center gap-2 flex-wrap">
              <span>MCP servers（serverName 即工具前缀 mcp__&lt;serverName&gt;__&lt;rawName&gt;）</span>
              {mcpShelf.length > 0 && (
                <select className="text-xs px-2 py-1 rounded-lg border border-slate-200 text-slate-600" value=""
                  onChange={(e) => {
                    const pick = mcpShelf.find((x) => x.serverName === e.target.value)
                    if (!pick) return
                    const { usedBy: _u, ...cfg } = pick
                    setMcpServers((ss) => [...ss.filter((s) => s.serverName !== pick.serverName), { ...cfg }])
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
              {mcpServers.map((s, si) => (
                <div key={si} className="flex flex-wrap gap-2 items-center text-sm">
                  <input value={s.serverName} onChange={(e) => patchServer(si, { serverName: e.target.value })}
                    placeholder="serverName" className="px-2.5 py-1.5 rounded-lg border border-slate-200 w-32" />
                  <input value={s.url ?? ''} onChange={(e) => patchServer(si, { url: e.target.value || undefined, command: e.target.value ? undefined : s.command })}
                    placeholder="url（http 传输，二选一）" className="px-2.5 py-1.5 rounded-lg border border-slate-200 w-56" />
                  <input value={s.command ?? ''} onChange={(e) => patchServer(si, { command: e.target.value || undefined, url: e.target.value ? undefined : s.url })}
                    placeholder="command（stdio，二选一）" className="px-2.5 py-1.5 rounded-lg border border-slate-200 w-44" />
                  <input value={(s.args ?? []).join(' ')} onChange={(e) => patchServer(si, { args: e.target.value.split(' ').filter(Boolean) })}
                    placeholder="args（空格分隔）" className="px-2.5 py-1.5 rounded-lg border border-slate-200 flex-1 min-w-40" />
                  <button onClick={() => setMcpServers((ss) => ss.filter((_, j) => j !== si))}
                    className="p-1.5 rounded-lg text-red-500 hover:bg-red-50"><Trash2 size={14} /></button>
                </div>
              ))}
              <button onClick={() => setMcpServers((ss) => [...ss, { serverName: '' }])}
                className="text-xs px-2.5 py-1.5 rounded-lg border border-dashed border-slate-300 text-slate-500 hover:bg-slate-50 flex items-center gap-1">
                <Plus size={12} />添加 MCP server
              </button>
            </div>
          </div>
        </>
      ) : null}

      {/* 编排委托（D4）：复杂任务沿数据面工作流拆解派发 */}
      {show('workflow') && workflows.length > 0 && (
        <div>
          <div className="text-xs text-slate-500 mb-1.5 flex items-center gap-1.5">
            <GitBranch size={12} />
            <span>编排委托（D4 · 复杂任务拆解派发；声明于 manifest, 消费链路随通道收口接线）</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {workflows.map((w) => {
              const on = (manifest?.actions.workflows ?? []).includes(w.id)
              return (
                <button key={w.id} title={w.name} onClick={() => void toggleWorkflow(w.id)}
                  className={`text-[11px] px-2.5 py-1 rounded-lg border transition flex items-center gap-1 ${on ? 'border-violet-300 bg-violet-50 text-violet-700' : 'border-slate-200 text-slate-500 hover:border-violet-200'}`}>
                  <GitBranch size={10} />{w.id}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* 通道声明：这个角色出现在哪里（与能力启用与否无关, 纯网页角色也可声明） */}
      <div className={`pt-3 ${show('ability') || (show('workflow') && roleCfg) ? 'border-t border-slate-100' : ''}`}>
        {show('channel') && (<>
          <div className="text-xs text-slate-500 mb-1.5 flex items-center gap-1.5">
            <MessageSquare size={12} />
            <span>通道声明（这个角色出现在哪里；app 面貌应与角色一致）</span>
          </div>
        <div className="space-y-1.5">
          {channels.length === 0 && (
            <div className="text-[11px] text-slate-400">未声明通道 —— 纯网页/后台角色（也可在下方添加 IM 外勤）</div>
          )}
          {channels.map((c) => (
            <div key={c.platform} className="flex flex-wrap items-center gap-1.5">
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">{c.platform}</span>
              {c.apps.map((a) => (
                <span key={a.app} className="text-[11px] px-2 py-0.5 rounded-full bg-sky-50 text-sky-700 border border-sky-100 flex items-center gap-1">
                  <code>{a.app}</code>
                  <button title={`移除 ${a.app}`} onClick={() => removeChannelApp(c.platform, a.app)}
                    className="text-sky-300 hover:text-rose-500"><Trash2 size={10} /></button>
                </span>
              ))}
            </div>
          ))}
          <ChannelAddRow onAdd={addChannelApp} disabled={busy} />
        </div>
        </>)}
      </div>
    </div>
  )
}

/** 通道声明添加行：平台 + appId（回车或按钮添加，即时保存） */
function ChannelAddRow({ onAdd, disabled }: { onAdd: (platform: 'feishu' | 'wecom', app: string) => void; disabled: boolean }) {
  const [platform, setPlatform] = useState<'feishu' | 'wecom'>('feishu')
  const [app, setApp] = useState('')
  const submit = () => {
    const v = app.trim()
    if (!v || disabled) return
    onAdd(platform, v)
    setApp('')
  }
  return (
    <div className="flex items-center gap-1.5">
      <select value={platform} onChange={(e) => setPlatform(e.target.value as 'feishu' | 'wecom')}
        className="text-[11px] px-2 py-1 rounded-lg border border-slate-200 text-slate-600">
        <option value="feishu">飞书</option>
        <option value="wecom">企微</option>
      </select>
      <input value={app} onChange={(e) => setApp(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
        placeholder="appId（cli_xxx / corp app id）"
        className="flex-1 min-w-0 text-[11px] px-2 py-1 rounded-lg border border-slate-200 focus:outline-none focus:border-violet-300" />
      <button onClick={submit} disabled={disabled || !app.trim()}
        className="text-[11px] px-2 py-1 rounded-lg border border-violet-200 text-violet-600 hover:bg-violet-50 disabled:opacity-40 flex items-center gap-1">
        <Plus size={11} />声明
      </button>
    </div>
  )
}
