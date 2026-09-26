import { useState } from 'react'
import { apiLogin, apiRegister } from '../lib/api'
import { Bot, LogIn, UserPlus, Loader2, AlertCircle } from 'lucide-react'

/** 登录屏（AppBase 平台账号, token 与 AppBase 互通）—— 未登录时整站门禁 */
export default function LoginGate({ onSuccess }: { onSuccess: () => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async () => {
    if (!email.trim() || !password || busy) return
    setBusy(true)
    setError('')
    try {
      if (mode === 'login') await apiLogin(email.trim(), password)
      else await apiRegister(email.trim(), password)
      onSuccess()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen bg-[#F6F7F9] flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-8">
          <div className="text-center mb-7">
            <div className="w-12 h-12 rounded-xl text-white flex items-center justify-center text-lg font-bold mx-auto mb-3"
              style={{ background: 'linear-gradient(135deg,#3370FF,#14C0FF)' }}>智</div>
            <h1 className="text-lg font-semibold text-slate-800">智悦智能平台</h1>
            <p className="text-xs text-slate-400 mt-1">Aigility · 数字员工智能体平台 · 平台账号登录</p>
          </div>

          <div className="space-y-3">
            <div>
              <label className="text-xs text-slate-400 block mb-1">邮箱 / 账号</label>
              <input value={email} onChange={e => setEmail(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') void submit() }}
                placeholder="admin@aigility.local"
                className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-300" />
            </div>
            <div>
              <label className="text-xs text-slate-400 block mb-1">密码</label>
              <input type="password" value={password} onChange={e => setPassword(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') void submit() }}
                placeholder="••••••••"
                className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-300" />
            </div>
            {error && (
              <div className="text-xs text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2 flex items-start gap-1.5">
                <AlertCircle size={13} className="mt-0.5 shrink-0" />{error}
              </div>
            )}
            <button onClick={() => void submit()} disabled={busy || !email.trim() || !password}
              className="w-full text-sm py-2.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 flex items-center justify-center gap-1.5">
              {busy ? <Loader2 size={15} className="animate-spin" /> : mode === 'login' ? <LogIn size={15} /> : <UserPlus size={15} />}
              {mode === 'login' ? '登录' : '注册并登录'}
            </button>
          </div>

          <div className="mt-5 pt-4 border-t border-slate-100 flex items-center justify-between text-xs">
            <button onClick={() => { setMode(m => m === 'login' ? 'register' : 'login'); setError('') }}
              className="text-blue-600 hover:underline">
              {mode === 'login' ? '没有账号？注册' : '已有账号？登录'}
            </button>
            <span className="text-slate-400 flex items-center gap-1"><Bot size={11} />首次部署自动播种演示账号</span>
          </div>
        </div>
        <p className="text-[11px] text-slate-400 text-center mt-4 leading-relaxed">
          演示账号：admin@aigility.local / admin123（管理员）<br />
          fde@aigility.local / fde123 · demo@aigility.local / demo123 —— 与 AppBase 共库共账号
        </p>
      </div>
    </div>
  )
}
