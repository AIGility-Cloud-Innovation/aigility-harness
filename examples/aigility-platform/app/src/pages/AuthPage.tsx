import { useEffect, useState } from 'react'
import { roles, rolePermissions, users, moduleRegistry } from '../mock/data'
import { ShieldCheck, Users, KeyRound, PlusCircle, Radio } from 'lucide-react'
import { fetchTeam, fetchAudit, type TeamMember, type AuditEntry } from '../lib/harness'

const systemModules = [
  ...moduleRegistry.map(m => ({ id: m.id, name: m.name })),
  { id: 'modules', name: '模块装配' },
  { id: 'auth', name: '权限管理' },
  { id: 'settings', name: '项目设置' },
]

const permStyle: Record<string, string> = {
  manage: 'bg-blue-600 text-white',
  use: 'bg-emerald-50 text-emerald-600 border border-emerald-200',
  view: 'bg-slate-100 text-slate-500',
  '': 'bg-white text-slate-300 border border-slate-100',
}
const permLabel: Record<string, string> = { manage: '管理', use: '使用', view: '只读', '': '—' }
const permOrder = ['', 'view', 'use', 'manage']

export default function AuthPage() {
  const [perms, setPerms] = useState(rolePermissions)
  const [role, setRole] = useState('r-admin')

  const cycle = (mod: string, r: string) => {
    const cur = perms[mod]?.[r] ?? ''
    const next = permOrder[(permOrder.indexOf(cur) + 1) % permOrder.length]
    setPerms(p => ({ ...p, [mod]: { ...p[mod], [r]: next } }))
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-slate-800">权限管理</h1>
        <p className="text-sm text-slate-500 mt-1">RuoYi 式角色-模块权限矩阵 · 点击单元格切换权限（— → 只读 → 使用 → 管理）· 数字员工按 Skill 授权、写操作必经人审</p>
      </div>

      {/* 平台成员（真）+ 审计日志（真） */}
      <RealTeamAudit />

      {/* 角色卡片 */}
      <div className="flex items-center gap-2">
        <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-500">以下角色/矩阵为演示数据 · 引擎暂无 RBAC 服务</span>
      </div>

      {/* 角色卡片 */}
      <div className="grid md:grid-cols-3 xl:grid-cols-5 gap-3">
        {roles.map(r => (
          <button key={r.id} onClick={() => setRole(r.id)}
            className={`text-left bg-white rounded-xl border p-4 transition hover:shadow-md ${role === r.id ? 'border-blue-400 ring-2 ring-blue-100' : 'border-slate-200/80'}`}>
            <div className="flex items-center gap-2 mb-1.5">
              <ShieldCheck size={15} className={role === r.id ? 'text-blue-600' : 'text-slate-400'} />
              <span className="text-sm font-medium text-slate-800">{r.name}</span>
            </div>
            <p className="text-[11px] text-slate-400 leading-relaxed">{r.desc}</p>
            <div className="flex items-center justify-between mt-2.5 pt-2 border-t border-slate-50 text-[11px] text-slate-400">
              <span className="flex items-center gap-1"><Users size={11} />{r.userCount} 人</span>
              <span>{r.scope}</span>
            </div>
          </button>
        ))}
      </div>

      {/* 权限矩阵 */}
      <div className="bg-white rounded-xl border border-slate-200/80 overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
          <h3 className="font-medium text-slate-800 flex items-center gap-2"><KeyRound size={15} className="text-blue-600" />模块权限矩阵</h3>
          <span className="text-xs text-slate-400">当前高亮角色：{roles.find(r => r.id === role)?.name}</span>
        </div>
        <div className="overflow-x-auto">
          <div className="overflow-x-auto -mx-1 px-1"><table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-slate-400 border-b border-slate-100 bg-slate-50/60">
                <th className="text-left font-medium px-5 py-3">功能模块</th>
                {roles.map(r => (
                  <th key={r.id} className={`font-medium px-3 py-3 text-center ${role === r.id ? 'text-blue-600 bg-blue-50/50' : ''}`}>{r.name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {systemModules.map(m => (
                <tr key={m.id} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/40">
                  <td className="px-5 py-2.5 text-sm text-slate-700">{m.name}</td>
                  {roles.map(r => {
                    const v = perms[m.id]?.[r.id] ?? ''
                    return (
                      <td key={r.id} className={`px-3 py-2.5 text-center ${role === r.id ? 'bg-blue-50/30' : ''}`}>
                        <button onClick={() => cycle(m.id, r.id)}
                          className={`text-xs px-2.5 py-1 rounded-md min-w-[44px] transition ${permStyle[v]}`}>
                          {permLabel[v]}
                        </button>
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table></div>
        </div>
        <div className="px-5 py-3 bg-slate-50/60 border-t border-slate-100 text-xs text-slate-400">
          数据权限独立于功能权限：集成商角色可见「全部项目」，企业角色仅见「本企业项目」，数字员工仅见「按 Skill 授权的图谱与记忆范围」
        </div>
      </div>

      {/* 用户列表 */}
      <div className="bg-white rounded-xl border border-slate-200/80 overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
          <h3 className="font-medium text-slate-800 flex items-center gap-2"><Users size={15} className="text-blue-600" />用户与账号</h3>
          <button className="text-xs px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 flex items-center gap-1"><PlusCircle size={13} />新增用户</button>
        </div>
        <div className="overflow-x-auto -mx-1 px-1"><table className="w-full text-sm">
          <thead><tr className="text-xs text-slate-400 border-b border-slate-100 bg-slate-50/60">
            <th className="text-left font-medium px-5 py-2.5">姓名</th>
            <th className="text-left font-medium px-3 py-2.5">账号</th>
            <th className="text-left font-medium px-3 py-2.5">角色</th>
            <th className="text-left font-medium px-3 py-2.5">项目范围</th>
            <th className="text-left font-medium px-3 py-2.5">状态</th>
          </tr></thead>
          <tbody>
            {users.map(u => (
              <tr key={u.account} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/50">
                <td className="px-5 py-2.5 text-slate-700">{u.name}</td>
                <td className="px-3 py-2.5 text-xs font-mono text-slate-500">{u.account}</td>
                <td className="px-3 py-2.5"><span className={`text-xs px-2 py-0.5 rounded ${u.role === '数字员工' ? 'bg-sky-50 text-sky-600' : 'bg-blue-50 text-blue-600'}`}>{u.role}</span></td>
                <td className="px-3 py-2.5 text-xs text-slate-500">{u.project}</td>
                <td className="px-3 py-2.5"><span className={`text-xs ${u.status === '启用' ? 'text-emerald-600' : 'text-slate-400'}`}>{u.status}</span></td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </div>
    </div>
  )
}


// ── 平台成员（真）+ 审计日志（真）：AppBase users × app_members + audit_log ──

function RealTeamAudit() {
  const [members, setMembers] = useState<TeamMember[]>([])
  const [audit, setAudit] = useState<AuditEntry[]>([])

  useEffect(() => {
    fetchTeam().then(setMembers).catch(() => {})
    fetchAudit().then(setAudit).catch(() => {})
  }, [])

  return (
    <div className="grid lg:grid-cols-2 gap-4">
      <div className="bg-white rounded-xl border border-emerald-200 ring-1 ring-emerald-100/60 p-5">
        <div className="flex items-center gap-2 mb-3">
          <Users size={14} className="text-emerald-500" />
          <h3 className="text-sm font-semibold text-slate-700">平台成员</h3>
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-600 border border-emerald-100">真 · users × app_members</span>
          <span className="text-[11px] text-slate-400 ml-auto">{members.length} 人</span>
        </div>
        <div className="space-y-1.5 max-h-56 overflow-y-auto">
          {members.map(m => (
            <div key={m.email} className="flex items-center gap-2 text-xs rounded-lg border border-slate-100 bg-slate-50/60 px-3 py-2">
              <span className="w-6 h-6 rounded-full bg-blue-600 text-white text-[10px] flex items-center justify-center shrink-0">{m.email[0].toUpperCase()}</span>
              <span className="text-slate-700 truncate">{m.email}</span>
              {m.isAdmin && <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-600 shrink-0">管理员</span>}
              {m.createdAt && <span className="text-[10px] text-slate-300 ml-auto shrink-0">{String(m.createdAt).slice(0, 10)}</span>}
            </div>
          ))}
          {members.length === 0 && <div className="text-xs text-slate-400">加载中…</div>}
        </div>
      </div>
      <div className="bg-white rounded-xl border border-emerald-200 ring-1 ring-emerald-100/60 p-5">
        <div className="flex items-center gap-2 mb-3">
          <Radio size={14} className="text-emerald-500" />
          <h3 className="text-sm font-semibold text-slate-700">审计日志</h3>
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-600 border border-emerald-100">真 · audit_log 留痕</span>
        </div>
        <div className="space-y-1.5 max-h-56 overflow-y-auto font-mono">
          {audit.map((e, i) => (
            <div key={i} className="text-[11px] rounded-lg border border-slate-100 bg-slate-50/60 px-3 py-2 leading-relaxed">
              <span className="text-slate-400">{e.at.slice(5, 19).replace('T', ' ')}</span>{' '}
              <span className="text-slate-700">{e.actor}</span>{' '}
              <span className="text-blue-600">{e.action}</span>{' '}
              <span className="text-slate-400">{e.detail}</span>
            </div>
          ))}
          {audit.length === 0 && <div className="text-xs text-slate-400">暂无审计记录</div>}
        </div>
      </div>
    </div>
  )
}
