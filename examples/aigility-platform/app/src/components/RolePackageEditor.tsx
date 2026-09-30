/**
 * RolePackageEditor — 角色包编辑器（roles/ 目录 · role-kit 五要素）
 *
 * 与 RoleDshEditor（编辑 role-manifests.json 声明面）不同：本组件编辑的是
 * 可移植角色包本体（SKILL.md 人设 + role.json 五要素），保存即原子写回包目录
 * （git 兜底可 diff/回滚）。命令面板与调度器是项目小助理引入的两个新配置面：
 *   - commands：确定性意图表（正则命中零 LLM 成本）
 *   - schedules：进程内调度器声明（interval/silence/daily/event，enabled=false 即旁路）
 */
import { useEffect, useState } from 'react'
import { saveRolePackage, type RolePackageInfo, type RolePackageCommand, type RolePackageSchedule } from '../lib/harness'
import { Loader, Save, X, Terminal, CalendarClock, User, AlertTriangle, Plus, Trash2, Package } from 'lucide-react'

type Tab = 'persona' | 'commands' | 'schedules' | 'manifest'

const TABS: Array<{ id: Tab; label: string; icon: typeof User }> = [
  { id: 'persona', label: '人设 · SKILL.md', icon: User },
  { id: 'commands', label: '命令面板', icon: Terminal },
  { id: 'schedules', label: '调度器', icon: CalendarClock },
  { id: 'manifest', label: '五要素声明', icon: Package },
]

export default function RolePackageEditor({ pkg, onSaved, onClose }: {
  pkg: RolePackageInfo
  onSaved: () => void
  onClose: () => void
}) {
  const [tab, setTab] = useState<Tab>('persona')
  const [prompt, setPrompt] = useState(pkg.prompt)
  const [manifest, setManifest] = useState<RolePackageInfo['manifest']>(structuredClone(pkg.manifest))
  const [busy, setBusy] = useState(false)
  const [banner, setBanner] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    setPrompt(pkg.prompt)
    setManifest(structuredClone(pkg.manifest))
    setBanner(''); setError(''); setTab('persona')
  }, [pkg])

  const save = async () => {
    setBusy(true); setError(''); setBanner('')
    try {
      await saveRolePackage(pkg.id, { manifest, prompt })
      setBanner(`角色包「${pkg.id}」已保存 → 原子写回 ${pkg.dir.split('/').slice(-2).join('/')}（git 可 diff/回滚）`)
      onSaved()
    } catch (e) { setError(String((e as Error).message ?? e)) } finally { setBusy(false) }
  }

  const patchCommands = (next: RolePackageCommand[]) => setManifest((m) => ({ ...m, actions: { ...m.actions, commands: next } }))
  const patchSchedules = (next: RolePackageSchedule[]) => setManifest((m) => ({ ...m, actions: { ...m.actions, schedules: next } }))

  const commands = manifest.actions.commands ?? []
  const schedules = manifest.actions.schedules ?? []

  const inputCls = 'text-xs px-2.5 py-1.5 rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-100'

  return (
    <div className="bg-white rounded-xl border border-slate-200/80">
      {/* 头部 */}
      <div className="flex items-center gap-2 flex-wrap px-5 py-3 border-b border-slate-100">
        <Package size={15} className="text-violet-500" />
        <span className="text-sm font-medium text-slate-800">{pkg.name}</span>
        <code className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">{pkg.id}</code>
        <span className={`text-[10px] px-1.5 py-0.5 rounded ${pkg.layer === 'public' ? 'bg-violet-50 text-violet-600' : 'bg-sky-50 text-sky-600'}`}>
          {pkg.layer === 'public' ? '公共角色包' : '站点私有'}
        </span>
        {pkg.issues.length > 0 && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-50 text-red-600 flex items-center gap-1">
            <AlertTriangle size={10} />{pkg.issues.join('；')}
          </span>
        )}
        <div className="flex-1" />
        <button onClick={save} disabled={busy}
          className="text-xs px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1.5">
          {busy ? <Loader size={13} className="animate-spin" /> : <Save size={13} />}保存角色包
        </button>
        <button onClick={onClose} className="text-xs px-2 py-1.5 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50"><X size={13} /></button>
      </div>

      {banner && <div className="mx-5 mt-3 text-xs px-3 py-2 rounded-lg bg-emerald-50 text-emerald-700 border border-emerald-100">{banner}</div>}
      {error && <div className="mx-5 mt-3 text-xs px-3 py-2 rounded-lg bg-red-50 text-red-600 border border-red-100 whitespace-pre-wrap">{error}</div>}

      {/* 分区标签 */}
      <div className="flex gap-1.5 px-5 pt-3 flex-wrap">
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`text-xs px-3 py-1.5 rounded-lg flex items-center gap-1.5 transition ${tab === t.id ? 'bg-violet-600 text-white' : 'bg-slate-50 text-slate-500 hover:bg-slate-100'}`}>
            <t.icon size={12} />{t.label}
            {t.id === 'commands' && commands.length > 0 && <span className="text-[10px] opacity-70">{commands.length}</span>}
            {t.id === 'schedules' && schedules.length > 0 && <span className="text-[10px] opacity-70">{schedules.filter((s) => s.enabled !== false).length}/{schedules.length}</span>}
          </button>
        ))}
      </div>

      <div className="p-5">
        {tab === 'persona' && (
          <div>
            <label className="text-xs text-slate-500 block mb-1">角色 Prompt（SKILL.md 正文；frontmatter 由服务端保留）</label>
            <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={22}
              className="w-full text-xs px-3 py-2.5 rounded-lg border border-slate-200 font-mono leading-relaxed focus:outline-none focus:ring-2 focus:ring-blue-100" />
            <p className="text-[11px] text-slate-400 mt-1.5">{prompt.length} 字符 · 保存时原子写回包目录 SKILL.md</p>
          </div>
        )}

        {tab === 'commands' && (
          <div className="space-y-2">
            <p className="text-xs text-slate-500">确定性命令/意图表：pattern 命中即执行（零 LLM 成本）；未命中才走 LLM 兜底。运行时由 persona 正则引擎消费。</p>
            {commands.map((c, i) => (
              <div key={i} className="flex flex-wrap gap-1.5 items-center">
                <input value={c.pattern} onChange={(e) => patchCommands(commands.map((x, j) => (j === i ? { ...x, pattern: e.target.value } : x)))}
                  placeholder="pattern（命令样例）" className={`${inputCls} w-64 font-mono`} />
                <span className="text-slate-300 text-xs">→</span>
                <input value={c.action} onChange={(e) => patchCommands(commands.map((x, j) => (j === i ? { ...x, action: e.target.value } : x)))}
                  placeholder="action（编排动作）" className={`${inputCls} w-56 font-mono`} />
                <input value={c.summary ?? ''} onChange={(e) => patchCommands(commands.map((x, j) => (j === i ? { ...x, summary: e.target.value } : x)))}
                  placeholder="说明（可选）" className={`${inputCls} flex-1 min-w-40`} />
                <button onClick={() => patchCommands(commands.filter((_, j) => j !== i))}
                  className="p-1.5 rounded-lg text-red-400 hover:bg-red-50"><Trash2 size={13} /></button>
              </div>
            ))}
            <button onClick={() => patchCommands([...commands, { pattern: '', action: '' }])}
              className="text-xs px-2.5 py-1.5 rounded-lg border border-dashed border-slate-300 text-slate-500 hover:bg-slate-50 flex items-center gap-1">
              <Plus size={12} />添加命令
            </button>
          </div>
        )}

        {tab === 'schedules' && (
          <div className="space-y-2">
            <p className="text-xs text-slate-500">进程内调度器声明：trigger 支持 <code>interval 10m</code> / <code>silence 180s</code> / <code>daily 18:30</code> / <code>event …</code>；关闭即旁路（不销毁声明）。</p>
            {schedules.map((s, i) => (
              <div key={i} className="flex flex-wrap gap-1.5 items-center">
                <input value={s.name} onChange={(e) => patchSchedules(schedules.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                  placeholder="名称" className={`${inputCls} w-36 font-mono`} />
                <input value={s.trigger} onChange={(e) => patchSchedules(schedules.map((x, j) => (j === i ? { ...x, trigger: e.target.value } : x)))}
                  placeholder="trigger" className={`${inputCls} w-36 font-mono`} />
                <span className="text-slate-300 text-xs">→</span>
                <input value={s.action} onChange={(e) => patchSchedules(schedules.map((x, j) => (j === i ? { ...x, action: e.target.value } : x)))}
                  placeholder="action" className={`${inputCls} w-48 font-mono`} />
                <input value={s.summary ?? ''} onChange={(e) => patchSchedules(schedules.map((x, j) => (j === i ? { ...x, summary: e.target.value } : x)))}
                  placeholder="说明（可选）" className={`${inputCls} flex-1 min-w-36`} />
                <button onClick={() => patchSchedules(schedules.map((x, j) => (j === i ? { ...x, enabled: x.enabled === false } : x)))}
                  title="启用/旁路"
                  className={`text-[10px] px-2 py-1.5 rounded-lg border ${s.enabled === false ? 'bg-slate-100 text-slate-400 border-slate-200' : 'bg-emerald-50 text-emerald-600 border-emerald-200'}`}>
                  {s.enabled === false ? '已旁路' : '启用'}
                </button>
                <button onClick={() => patchSchedules(schedules.filter((_, j) => j !== i))}
                  className="p-1.5 rounded-lg text-red-400 hover:bg-red-50"><Trash2 size={13} /></button>
              </div>
            ))}
            <button onClick={() => patchSchedules([...schedules, { name: '', trigger: 'interval 10m', action: '', enabled: true }])}
              className="text-xs px-2.5 py-1.5 rounded-lg border border-dashed border-slate-300 text-slate-500 hover:bg-slate-50 flex items-center gap-1">
              <Plus size={12} />添加调度器
            </button>
          </div>
        )}

        {tab === 'manifest' && (
          <div className="space-y-2.5">
            <p className="text-xs text-slate-500">五要素声明的其余部分（本页只读；通道/工具等结构化编辑后续并入对应分区）。</p>
            <pre className="text-[11px] bg-slate-50 border border-slate-100 rounded-lg p-4 overflow-x-auto leading-relaxed">{JSON.stringify({
              identity: manifest.identity,
              sources: manifest.sources,
              actions: {
                tools: manifest.actions.tools,
                workflows: manifest.actions.workflows,
                commands: `⟨${commands.length} 条 → 命令面板页编辑⟩`,
                schedules: `⟨${schedules.length} 条 → 调度器页编辑⟩`,
                engine: manifest.actions.engine,
              },
              outbound: manifest.outbound,
              memory: manifest.memory,
            }, null, 2)}</pre>
          </div>
        )}
      </div>
    </div>
  )
}
