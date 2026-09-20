import { useState } from 'react'
import { useStore } from '@/store/AppContext'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Bot, Eye, EyeOff, Lock, User, ArrowRight, BrainCircuit, ShieldCheck, Workflow } from 'lucide-react'
import { ACCOUNTS, ROLES } from '@/data/mock'

/** 登录页：账号密码登录，演示账号一键填充 */
export function Login() {
  const { login } = useStore()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPwd, setShowPwd] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const submit = () => {
    if (!username.trim() || !password) { setError('请输入账号和密码'); return }
    setLoading(true)
    setError('')
    setTimeout(() => {
      const ok = login(username, password)
      if (!ok) setError('账号或密码不正确，请使用下方演示账号')
      setLoading(false)
    }, 500)
  }

  const fill = (u: string, p: string) => { setUsername(u); setPassword(p); setError('') }

  return (
    <div className="flex min-h-screen bg-white">
      {/* 左侧品牌区（桌面端） */}
      <div className="relative hidden w-[46%] flex-col justify-between overflow-hidden bg-[#2952cc] p-10 lg:flex xl:p-14">
        <div className="pointer-events-none absolute -right-24 -top-24 h-96 w-96 rounded-full bg-[#3370ff] opacity-60 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-32 -left-16 h-80 w-80 rounded-full bg-[#0a3d6e] opacity-70 blur-3xl" />
        <div className="relative flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/15 text-lg font-bold text-white backdrop-blur">忆</div>
          <div>
            <div className="text-[17px] font-bold text-white tracking-tight">TiMEM FDE 工作台</div>
            <div className="text-xs text-blue-200">从线索到交付 · 越用越聪明</div>
          </div>
        </div>

        <div className="relative">
          <h1 className="text-[32px] font-bold leading-snug text-white xl:text-[36px]">
            每一次跟进、每一份方案<br />都沉淀成团队的记忆力
          </h1>
          <p className="mt-4 max-w-md text-sm leading-relaxed text-blue-100/90">
            线索、方案、合同、渠道、知识沉淀一体化。数字员工全程协作，所有智能产出经人工确认后生效。
          </p>
          <div className="mt-8 space-y-4">
            {[
              { icon: Workflow, text: '线索 → 方案 → 合同全流程留痕，过程记忆可回溯' },
              { icon: BrainCircuit, text: '行业机理知识随客户增长自动沉淀，越用越聪明' },
              { icon: ShieldCheck, text: '私有化部署，数据不出内网，权限按角色隔离' },
            ].map((f, i) => (
              <div key={i} className="flex items-center gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/10">
                  <f.icon className="h-[18px] w-[18px] text-blue-100" />
                </div>
                <span className="text-[13px] text-blue-50/95">{f.text}</span>
              </div>
            ))}
          </div>
        </div>

        <p className="relative text-xs text-blue-200/70">太忆 TiMEM.ai · 私有化部署 · 数据不出内网</p>
      </div>

      {/* 右侧登录表单 */}
      <div className="flex flex-1 items-center justify-center bg-slate-50 px-4 py-10 sm:px-8">
        <div className="w-full max-w-[400px]">
          <div className="mb-8 flex items-center gap-3 lg:hidden">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#3370ff] text-lg font-bold text-white">忆</div>
            <div>
              <div className="text-[17px] font-bold text-slate-900 tracking-tight">TiMEM FDE 工作台</div>
              <div className="text-xs text-slate-400">从线索到交付 · 越用越聪明</div>
            </div>
          </div>

          <h2 className="text-[22px] font-bold text-slate-900">登录工作台</h2>
          <p className="mt-1.5 text-[13px] text-slate-500">使用团队账号登录，数据范围按角色自动隔离</p>

          <div className="mt-7 space-y-4">
            <div>
              <label className="mb-1.5 block text-[13px] font-medium text-slate-700">账号</label>
              <div className="relative">
                <User className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <Input
                  value={username}
                  onChange={e => { setUsername(e.target.value); setError('') }}
                  onKeyDown={e => e.key === 'Enter' && submit()}
                  placeholder="请输入账号"
                  className="h-11 pl-9 bg-white"
                  autoComplete="username"
                />
              </div>
            </div>
            <div>
              <label className="mb-1.5 block text-[13px] font-medium text-slate-700">密码</label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <Input
                  type={showPwd ? 'text' : 'password'}
                  value={password}
                  onChange={e => { setPassword(e.target.value); setError('') }}
                  onKeyDown={e => e.key === 'Enter' && submit()}
                  placeholder="请输入密码"
                  className="h-11 pl-9 pr-10 bg-white"
                  autoComplete="current-password"
                />
                <button
                  type="button"
                  onClick={() => setShowPwd(v => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                  aria-label="显示或隐藏密码"
                >
                  {showPwd ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            {error && <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-600">{error}</p>}

            <Button
              onClick={submit}
              disabled={loading}
              className="h-11 w-full bg-[#3370ff] text-[15px] hover:bg-[#2952cc]"
            >
              {loading ? '登录中…' : <>登录<ArrowRight className="ml-1.5 h-4 w-4" /></>}
            </Button>
          </div>

          {/* 演示账号 */}
          <div className="mt-8 rounded-xl border border-dashed border-slate-300 bg-white p-4">
            <p className="flex items-center gap-1.5 text-xs font-medium text-slate-500">
              <Bot className="h-3.5 w-3.5 text-[#3370ff]" />演示账号（点击自动填充，登录后视角与数据范围不同）
            </p>
            <div className="mt-3 space-y-2">
              {ACCOUNTS.map(a => {
                const r = ROLES.find(x => x.id === a.roleId)
                return (
                  <button
                    key={a.username}
                    onClick={() => fill(a.username, a.password)}
                    className="group flex w-full items-center justify-between rounded-lg border border-slate-200 px-3 py-2.5 text-left transition-all hover:border-[#3370ff] hover:bg-blue-50/50"
                  >
                    <div>
                      <span className="text-[13px] font-medium text-slate-800">{r?.name} · {r?.title}</span>
                      <p className="tnum mt-0.5 text-[11px] text-slate-400">{a.username} / {a.password}</p>
                    </div>
                    <ArrowRight className="h-3.5 w-3.5 text-slate-300 transition-transform group-hover:translate-x-0.5 group-hover:text-[#3370ff]" />
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
