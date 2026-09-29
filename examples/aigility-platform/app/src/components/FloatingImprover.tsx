/**
 * FloatingImprover — 右下角悬浮球：直达「平台改进专员」
 *
 * 用户在网页上看到不舒服的地方，点开直接说；改进专员：
 *   - 展示层小问题（文案/隐藏/样式）→ 当场给出 sitefix 即时修改并持久化（对所有人生效）
 *   - 结构性改动 → 自动落任务板派发编码代理，人审后生效
 * 消息自动携带【当前页面】上下文；页面切换后重放已持久化的 tweaks。
 */
import { useEffect, useRef, useState } from 'react'
import { MessageCircle, X, Send, Loader2, Sparkles } from 'lucide-react'
import { streamPersonaChat, fetchSiteTweaks, saveSiteTweak, applySiteTweaks, type SiteTweak } from '../lib/harness'
import { SITE_IMPROVER_ROUTE } from '../lib/improver'

interface Msg {
  role: 'user' | 'agent'
  text?: string
  streaming?: boolean
  /** 当场修复条数（已应用并持久化） */
  fixes?: number
}

/** 从回复文本剥离 sitefix 围栏并应用 */
function extractAndApplyFixes(text: string, userKey: string): { clean: string; fixes: number } {
  const m = /```sitefix\n([\s\S]*?)```/.exec(text)
  if (!m) return { clean: text, fixes: 0 }
  const clean = text.replace(/```sitefix\n[\s\S]*?```/g, '').trim()
  try {
    const parsed = JSON.parse(m[1]) as { fixes?: Array<{ type: SiteTweak['type']; selector: string; value?: string }> }
    const fixes = parsed.fixes ?? []
    applySiteTweaks(fixes.map((f, i) => ({ ...f, id: `pending-${i}`, createdBy: userKey, createdAt: '' })))
    for (const f of fixes) {
      saveSiteTweak({ type: f.type, selector: f.selector, value: f.value, reason: '改进专员 live_fix', user_key: userKey }).catch(() => {})
    }
    return { clean, fixes: fixes.length }
  } catch {
    return { clean, fixes: 0 }
  }
}

export default function FloatingImprover({ page }: { page: string }) {
  const [open, setOpen] = useState(false)
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [unauth, setUnauth] = useState(false)
  const sessionRef = useRef(`fb-${Date.now().toString(36)}`)
  const bottomRef = useRef<HTMLDivElement>(null)
  const userKey = 'fde-local' // 与工作台一致；接 AppBase 会话后可换 user.email

  // 页面切换后重放已持久化的 tweaks（React 重渲染会还原 DOM）
  useEffect(() => {
    let cancelled = false
    fetchSiteTweaks()
      .then((t) => { if (!cancelled && t.length) applySiteTweaks(t) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [page])

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [msgs, open])

  const send = async () => {
    const q = draft.trim()
    if (!q || busy) return
    setDraft(''); setBusy(true); setUnauth(false)
    setMsgs((m) => [...m, { role: 'user', text: q }])
    try {
      const full = await streamPersonaChat(
        SITE_IMPROVER_ROUTE,
        { user_input: `【当前页面：${page}】${q}`, session_id: sessionRef.current, user_key: userKey },
        (t) => setMsgs((m) => {
          const next = [...m]
          const last = next[next.length - 1]
          if (last?.role === 'agent' && last.streaming) last.text = t
          else next.push({ role: 'agent', text: t, streaming: true })
          return next
        }),
      )
      const { clean, fixes } = extractAndApplyFixes(full, userKey)
      setMsgs((m) => {
        const next = [...m]
        const last = next[next.length - 1]
        if (last?.role === 'agent') { last.text = clean || last.text; last.streaming = false; last.fixes = fixes }
        return next
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes('401') || msg.includes('登录')) setUnauth(true)
      setMsgs((m) => [...m, { role: 'agent', text: unauth ? '请先登录后再提交意见。' : `这会儿没连上改进专员：${msg}` }])
    } finally { setBusy(false) }
  }

  return (
    <>
      {/* 悬浮球 */}
      <button
        onClick={() => setOpen((v) => !v)}
        title="网站改进专员：说个不舒服的地方，能当场改的当场改"
        className="fixed bottom-6 right-6 z-50 w-14 h-14 rounded-full shadow-xl flex items-center justify-center text-white transition hover:scale-105"
        style={{ background: 'linear-gradient(135deg,#2563EB,#0EA5E9)' }}>
        {open ? <X size={22} /> : <MessageCircle size={22} />}
        {!open && <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-amber-400 animate-pulse" />}
      </button>

      {/* 聊天面板 */}
      {open && (
        <div className="fixed bottom-24 right-6 z-50 w-[380px] max-w-[calc(100vw-3rem)] bg-white rounded-2xl shadow-2xl border border-slate-200 flex flex-col overflow-hidden" style={{ animation: 'fbIn .2s ease' }}>
          <div className="px-4 py-3 text-white" style={{ background: 'linear-gradient(135deg,#1E293B,#0F172A)' }}>
            <div className="text-sm font-semibold flex items-center gap-1.5"><Sparkles size={14} className="text-sky-300" />平台改进专员</div>
            <div className="text-[11px] text-slate-300 mt-0.5">哪里不舒服直接说 · 展示层小改当场生效 · 大改动自动派码农</div>
          </div>
          <div className="flex-1 overflow-y-auto p-4 space-y-3 h-80">
            {msgs.length === 0 && (
              <div className="text-center pt-8">
                <MessageCircle size={28} className="mx-auto text-slate-200 mb-2" />
                <p className="text-sm text-slate-500">直接说哪里不舒服，比如：</p>
                <div className="mt-2 space-y-1.5 text-left max-w-[280px] mx-auto">
                  {['首页标题太生硬，换个亲切点的说法', '任务板那个入口我不常用，先隐藏掉', '提交按钮颜色太浅了'].map((s) => (
                    <button key={s} onClick={() => setDraft(s)} className="w-full text-left text-xs px-3 py-2 rounded-lg border border-slate-100 hover:border-blue-200 hover:bg-blue-50/40 text-slate-600">{s}</button>
                  ))}
                </div>
              </div>
            )}
            {msgs.map((m, i) => (
              <div key={i} className={m.role === 'user' ? 'flex justify-end' : 'flex gap-2'}>
                {m.role === 'agent' && <div className="w-7 h-7 rounded-lg bg-sky-600 text-white flex items-center justify-center shrink-0 text-[10px] font-bold mt-0.5">改</div>}
                <div className={`text-sm leading-relaxed rounded-2xl px-3.5 py-2 max-w-[85%] whitespace-pre-wrap ${m.role === 'user' ? 'bg-blue-600 text-white rounded-tr-sm' : 'bg-slate-50 text-slate-700 rounded-tl-sm'}`}>
                  {m.text}
                  {m.streaming && <Loader2 size={12} className="inline animate-spin ml-1.5 text-slate-400" />}
                  {!m.streaming && !!m.fixes && <div className="text-[11px] text-emerald-600 mt-1.5 flex items-center gap-1"><Sparkles size={10} />已当场修改 {m.fixes} 处并对所有人生效</div>}
                </div>
              </div>
            ))}
            <div ref={bottomRef} />
          </div>
          <div className="border-t border-slate-100 p-3 flex gap-2">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() } }}
              placeholder={unauth ? '请先登录…' : '说说哪里不舒服…'}
              disabled={unauth || busy}
              className="flex-1 text-sm px-3 py-2 rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-100 disabled:bg-slate-50"
            />
            <button onClick={() => void send()} disabled={busy || !draft.trim()}
              className="px-3 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 flex items-center">
              {busy ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
            </button>
          </div>
        </div>
      )}
      <style>{`@keyframes fbIn { from { transform: translateY(12px); opacity: 0; } to { transform: none; opacity: 1; } }`}</style>
    </>
  )
}
