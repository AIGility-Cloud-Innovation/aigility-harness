import { useEffect, useState } from 'react'
import EChart from '../components/EChart'
import { wsTasks, wsMessages, wsApprovals, recentUsed, marketAgents, centerApps, opsToken } from '../mock/data'
import { fetchUsage, fetchCredit, type UsagePayload, type CreditPayload } from '../lib/harness'
import { getCurrentUser } from '../lib/api'
import { CheckCircle2, Clock, Bell, Wallet, Zap, ArrowRight, Bot, LayoutGrid, ShieldCheck, MailOpen, Radio } from 'lucide-react'

export default function WorkspacePage({ go }: { go: (p: string) => void }) {
  const [tasks, setTasks] = useState(wsTasks)
  const [msgs, setMsgs] = useState(wsMessages)
  const [approvals, setApprovals] = useState(wsApprovals)
  const [range, setRange] = useState<'today' | 'week' | 'month'>('today')
  const [usage, setUsage] = useState<UsagePayload | null>(null)
  const [credit, setCredit] = useState<CreditPayload | null>(null)

  useEffect(() => {
    fetchUsage().then(setUsage).catch(() => {})
    fetchCredit().then(setCredit).catch(() => {})
  }, [])

  const me = getCurrentUser()
  const summary = usage?.summary
  // 按窗口从 byDay 聚合（token-metering 的真实按日数据）
  const days = summary?.byDay ?? []
  const inRange = (d: { key: string }) => {
    const t = new Date(); const day = new Date(d.key + 'T00:00:00')
    if (range === 'today') return d.key === t.toISOString().slice(0, 10)
    const diff = (t.getTime() - day.getTime()) / 86400000
    return range === 'week' ? diff < 7 : diff < 30
  }
  const ranged = days.filter(inRange)
  const realTokens = ranged.reduce((s2, d) => s2 + d.totalTokens, 0)
  const realCalls = ranged.reduce((s2, d) => s2 + d.calls, 0)

  const hour = new Date().getHours()
  const greet = hour < 6 ? '夜深了' : hour < 12 ? '早上好' : hour < 14 ? '中午好' : hour < 18 ? '下午好' : '晚上好'
  const unread = msgs.filter(m => !m.read).length
  const todoCount = tasks.filter(t => !t.done).length



  return (
    <div className="space-y-5">
      {/* 欢迎卡 */}
      <div className="rounded-2xl bg-gradient-to-r from-blue-600 via-blue-600 to-sky-500 text-white p-6 relative overflow-hidden">
        <div className="absolute -right-8 -top-14 w-56 h-56 rounded-full bg-white/10" />
        <div className="absolute right-28 -bottom-16 w-40 h-40 rounded-full bg-white/10" />
        <div className="text-blue-100 text-sm">{greet}，{me?.email ?? '访客'}</div>
        <h1 className="text-xl font-semibold mt-1 mb-3">今天有 {todoCount} 项任务、{unread} 条未读消息、{approvals.filter(a => !a.status).length} 条待审批</h1>
        <div className="flex gap-2 flex-wrap">
          {[['创建智能体', 'studio'], ['接入数据表', 'ingest'], ['浏览智能体市场', 'market'], ['查看运营数据', 'ops']].map(([l, p]) => (
            <button key={l} onClick={() => go(p)} className="text-xs px-3.5 py-2 rounded-lg bg-white/15 hover:bg-white/25 transition flex items-center gap-1.5"><Zap size={12} />{l}</button>
          ))}
        </div>
      </div>

      <div className="grid lg:grid-cols-3 gap-4">
        {/* 今日任务（演示数据 · 引擎暂无任务/消息/审批服务） */}
        <div className="bg-white rounded-xl border border-slate-200/80 p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-medium text-slate-800 text-sm">今日任务</h3>
            <span className="text-[11px] text-slate-400">{todoCount} 项待完成</span>
          </div>
          <div className="space-y-3">
            {tasks.map(t => (
              <button key={t.id} onClick={() => setTasks(list => list.map(x => x.id === t.id ? { ...x, done: !x.done } : x))} className="w-full text-left flex items-start gap-2.5">
                {t.done ? <CheckCircle2 size={16} className="text-emerald-500 mt-0.5 shrink-0" /> : <Clock size={16} className="text-amber-500 mt-0.5 shrink-0" />}
                <div className="flex-1">
                  <div className={`text-xs leading-relaxed ${t.done ? 'text-slate-400 line-through' : 'text-slate-700'}`}>{t.title}</div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-[10px] text-slate-400">{t.source} · {t.due}</span>
                    <span className={`text-[10px] px-1.5 rounded ${t.priority === '高' ? 'bg-red-50 text-red-500' : t.priority === '中' ? 'bg-amber-50 text-amber-600' : 'bg-slate-100 text-slate-400'}`}>{t.priority}</span>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* 未读消息 */}
        <div className="bg-white rounded-xl border border-slate-200/80 p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-medium text-slate-800 text-sm flex items-center gap-1.5"><Bell size={14} className="text-slate-400" />消息</h3>
            <button onClick={() => setMsgs(list => list.map(m => ({ ...m, read: true })))} className="text-[11px] text-blue-600 hover:underline flex items-center gap-1"><MailOpen size={11} />全部已读</button>
          </div>
          <div className="space-y-3">
            {msgs.map(m => (
              <button key={m.id} onClick={() => setMsgs(list => list.map(x => x.id === m.id ? { ...x, read: true } : x))} className="w-full text-left flex items-start gap-2.5">
                <span className={`w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 ${m.read ? 'bg-slate-200' : 'bg-blue-500'}`} />
                <div>
                  <div className={`text-xs ${m.read ? 'text-slate-400' : 'text-slate-700 font-medium'}`}>{m.title}<span className="font-normal text-slate-400 ml-2">{m.time}</span></div>
                  <div className={`text-[11px] mt-0.5 leading-relaxed ${m.read ? 'text-slate-300' : 'text-slate-400'}`}>{m.content}</div>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* 待办审批（人在回路） */}
        <div className="bg-white rounded-xl border border-slate-200/80 p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-medium text-slate-800 text-sm flex items-center gap-1.5"><ShieldCheck size={14} className="text-slate-400" />待办审批</h3>
            <span className="text-[11px] text-slate-400">数字员工提交 · 写操作必经人审</span>
          </div>
          <div className="space-y-3">
            {approvals.map(a => (
              <div key={a.id} className="rounded-lg border border-slate-100 bg-slate-50/60 p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs font-medium text-slate-700">{a.title}</div>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-600 whitespace-nowrap">{a.risk}</span>
                </div>
                <div className="text-[11px] text-slate-400 mt-1 leading-relaxed">{a.from} · {a.detail}</div>
                {a.status ? (
                  <div className={`text-[11px] mt-2 flex items-center gap-1 ${a.status === '已通过' ? 'text-emerald-600' : 'text-red-500'}`}><CheckCircle2 size={11} />{a.status}，轨迹已沉淀至规则库</div>
                ) : (
                  <div className="flex gap-2 mt-2.5">
                    <button onClick={() => setApprovals(list => list.map(x => x.id === a.id ? { ...x, status: '已通过' } : x))} className="text-[11px] px-2.5 py-1 rounded-md bg-blue-600 text-white hover:bg-blue-700">通过</button>
                    <button onClick={() => setApprovals(list => list.map(x => x.id === a.id ? { ...x, status: '已驳回' } : x))} className="text-[11px] px-2.5 py-1 rounded-md border border-slate-200 text-slate-500 hover:bg-white">驳回</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="grid lg:grid-cols-[1.5fr_1fr] gap-4">
        {/* Token 用量 */}
        <div className="bg-white rounded-xl border border-slate-200/80 p-5">
          <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
            <h3 className="font-medium text-slate-800 text-sm flex items-center gap-1.5"><Wallet size={14} className="text-slate-400" />Token 用量 <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-50 text-emerald-600 border border-emerald-100">真</span></h3>
            <div className="flex bg-slate-100 rounded-lg p-0.5">
              {([['today', '今天'], ['week', '本周'], ['month', '本月']] as const).map(([k, l]) => (
                <button key={k} onClick={() => setRange(k)} className={`text-[11px] px-3 py-1 rounded-md transition ${range === k ? 'bg-white text-slate-800 shadow-sm font-medium' : 'text-slate-500'}`}>{l}</button>
              ))}
            </div>
          </div>
          <div className="flex items-end gap-6 mb-2 flex-wrap">
            <div><div className="text-[11px] text-slate-400">本期消耗（真 · token-metering）</div><div className="text-xl font-semibold text-slate-800">{realTokens.toLocaleString()} tok</div></div>
            <div><div className="text-[11px] text-slate-400">本期调用</div><div className="text-xl font-semibold text-slate-800">{realCalls} 次</div></div>
            <div><div className="text-[11px] text-slate-400">积分余额（真 · credit）</div><div className="text-xl font-semibold text-slate-800">{credit?.ok ? String(credit.balance ?? 0) : '未开户'}</div></div>
          </div>
          {days.length > 0 ? (
            <EChart option={{
              tooltip: { trigger: 'axis', formatter: (ps: any) => `${ps[0].name}<br/>Token ${ps[0].value} · 调用 ${days.find(d => d.key === ps[0].name)?.calls ?? 0} 次` },
              grid: { left: 60, right: 8, top: 10, bottom: 22 },
              xAxis: { type: 'category', data: days.map(d => d.key), axisLine: { lineStyle: { color: '#e2e8f0' } }, axisLabel: { fontSize: 10, color: '#94a3b8' } },
              yAxis: { type: 'value', splitLine: { lineStyle: { color: '#f1f5f9' } }, axisLabel: { fontSize: 10, color: '#94a3b8' } },
              series: [{ type: 'bar', data: days.map(d => d.totalTokens), barWidth: '46%', itemStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: '#3370FF' }, { offset: 1, color: '#8FB8FF' }] }, borderRadius: [4, 4, 0, 0] } }],
            } as any} height={190} />
          ) : (
            <div className="h-[190px] rounded-lg border border-dashed border-slate-200 flex flex-col items-center justify-center text-xs text-slate-400 gap-1.5">
              <Radio size={16} className="text-slate-300" />
              暂无真实用量 —— 去数字员工工作台对话一次，token-metering 会实时记录
            </div>
          )}
        </div>

        <div className="space-y-4">
          {/* 最近使用 */}
          <div className="bg-white rounded-xl border border-slate-200/80 p-5">
            <h3 className="font-medium text-slate-800 text-sm mb-3">最近使用</h3>
            <div className="space-y-2">
              {recentUsed.map(r => (
                <button key={r.id + r.time} onClick={() => go(r.kind === 'agent' ? 'market' : 'apps')} className="w-full flex items-center gap-2.5 text-left group">
                  <span className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${r.kind === 'agent' ? 'bg-blue-50 text-blue-600' : 'bg-emerald-50 text-emerald-600'}`}>
                    {r.kind === 'agent' ? <Bot size={14} /> : <LayoutGrid size={14} />}
                  </span>
                  <span className="text-xs text-slate-700 group-hover:text-blue-600 flex-1">{r.name}</span>
                  <span className="text-[10px] text-slate-300">{r.time}</span>
                </button>
              ))}
            </div>
          </div>
          {/* 我的智能体 / 应用 */}
          <div className="bg-white rounded-xl border border-slate-200/80 p-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-medium text-slate-800 text-sm">我的智能体 / 应用</h3>
              <button onClick={() => go('market')} className="text-[11px] text-blue-600 flex items-center gap-0.5">全部 <ArrowRight size={11} /></button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {marketAgents.slice(0, 3).map(a => <span key={a.id} className="text-[11px] px-2 py-1 rounded-md bg-blue-50 text-blue-600">{a.name.replace(' Agent', '')}</span>)}
              {centerApps.filter(a => a.on).slice(0, 3).map(a => <span key={a.id} className="text-[11px] px-2 py-1 rounded-md bg-emerald-50 text-emerald-600">{a.name}</span>)}
            </div>
            <div className="text-[11px] text-slate-400 mt-3 pt-3 border-t border-slate-50">今日消耗 {opsToken.today} · 由 TiMEM 上下文层统一供给记忆与知识</div>
          </div>
        </div>
      </div>
    </div>
  )
}
