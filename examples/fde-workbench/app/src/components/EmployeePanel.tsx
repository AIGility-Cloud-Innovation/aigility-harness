import { useEffect, useRef, useState } from 'react'
import { useStore } from '@/store/AppContext'
import { StageBadge } from '@/components/bits'
import { cn } from '@/lib/utils'
import { fmtMoneyFull, type ChatMessage } from '@/types'
import { commissionRateOf } from '@/data/mock'
import { getHarnessCfg, saveHarnessCfg, testHarnessConnection, type HarnessCfg } from '@/lib/harness'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  Bot, Send, User, X, Search, PencilLine, Play, CheckCircle2, Ban,
  ChevronRight, Globe, CircleDollarSign, ListTodo, Medal, Users, FileText, Repeat, Package, Settings2, Loader2, Unplug,
} from 'lucide-react'

const QUICK = [
  '查合同进度', '查待办事项', '查续费', '查部署站点', '提成汇总', '标准产品',
  '推进 宁夏电信 到下一阶段', '提醒 长庆油田 回访', '给 可孚医疗 生成方案',
]

const CAPABILITIES = [
  { icon: Search, title: '在线查', items: ['查线索进展', '查合同/回款/分佣', '查续费与订阅', '查部署与版本', '查待办与提成'] },
  { icon: PencilLine, title: '在线改', items: ['推进线索阶段', '更新阶段状态', '更多修改陆续接入'] },
  { icon: Play, title: '执行任务', items: ['生成方案三件套', '创建跟进提醒', '任务均留痕可追溯'] },
]

/** 数据卡片：实时渲染工作台数据 */
function DataCard({ m }: { m: ChatMessage }) {
  const { leads, contracts, deliveries, deployments, proposals, knowledge, reminders, allocations, renewals, skus, navigate, setChatOpen } = useStore()
  if (!m.card) return null
  const go = (p: Parameters<typeof navigate>[0]) => { setChatOpen(false); navigate(p) }
  const kind = m.card.kind

  if (kind === 'leads') {
    const inFlight = leads.filter(l => l.stage !== '已流失' && l.stage !== '已交付')
    return (
      <div className="mt-2 space-y-1.5">
        {inFlight.map(l => (
          <button key={l.id} onClick={() => go({ name: 'lead', id: l.id })}
            className="flex w-full items-center gap-2 rounded-lg border border-slate-100 bg-slate-50/70 px-3 py-2 text-left hover:border-[#3370ff]/40">
            <Users className="h-3.5 w-3.5 shrink-0 text-slate-400" />
            <span className="min-w-0 flex-1 truncate text-[12px] text-slate-700">{l.name}</span>
            <StageBadge stage={l.stage} />
          </button>
        ))}
      </div>
    )
  }
  if (kind === 'contracts') {
    return (
      <div className="mt-2 space-y-1.5">
        {contracts.map(c => {
          const paid = c.payments.filter(p => p.done).reduce((s, p) => s + p.amount, 0)
          return (
            <button key={c.id} onClick={() => go({ name: 'contracts' })}
              className="flex w-full items-center gap-2 rounded-lg border border-slate-100 bg-slate-50/70 px-3 py-2 text-left hover:border-[#3370ff]/40">
              <FileText className="h-3.5 w-3.5 shrink-0 text-slate-400" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] text-slate-700">{c.customer}</span>
                <span className="tnum block text-[10px] text-slate-400">{c.code} · 回款 {fmtMoneyFull(paid)} / {fmtMoneyFull(c.amount)}</span>
              </span>
              <span className="tnum shrink-0 rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] text-slate-500">{c.status}</span>
            </button>
          )
        })}
      </div>
    )
  }
  if (kind === 'deployments') {
    return (
      <div className="mt-2 space-y-1.5">
        {deployments.map(d => (
          <button key={d.id} onClick={() => go({ name: 'deployments' })}
            className="flex w-full items-center gap-2 rounded-lg border border-slate-100 bg-slate-50/70 px-3 py-2 text-left hover:border-[#3370ff]/40">
            <Globe className="h-3.5 w-3.5 shrink-0 text-slate-400" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12px] text-slate-700">{d.site}</span>
              <span className="tnum block text-[10px] text-slate-400">{d.domain}</span>
            </span>
            <span className="tnum shrink-0 rounded bg-slate-900 px-1.5 py-0.5 text-[10px] font-bold text-white">{d.currentVersion}</span>
          </button>
        ))}
      </div>
    )
  }
  if (kind === 'tasks') {
    const items = [
      { label: '甲方反馈待响应', n: proposals.reduce((s, p) => s + p.feedbacks.filter(f => f.status === '待处理').length, 0) },
      { label: '方案待审阅', n: proposals.filter(p => p.status === '待审阅').length },
      { label: '访谈转写待确认', n: leads.reduce((s, l) => s + l.interviews.filter(iv => iv.status === '待确认').length, 0) },
      { label: '知识候选待审阅', n: knowledge.filter(k => k.status === '待审阅').length },
      { label: '交付项目推进', n: deliveries.filter(d => d.status === '交付中' || d.status === '待启动').length },
      { label: '跟进提醒', n: reminders.filter(r => !r.done).length },
    ]
    return (
      <div className="mt-2 grid grid-cols-2 gap-1.5">
        {items.map(x => (
          <button key={x.label} onClick={() => go({ name: 'tasks' })}
            className="flex items-center justify-between rounded-lg border border-slate-100 bg-slate-50/70 px-3 py-2 hover:border-[#3370ff]/40">
            <span className="text-[11px] text-slate-600">{x.label}</span>
            <span className={cn('tnum text-[13px] font-bold', x.n > 0 ? 'text-[#3370ff]' : 'text-slate-300')}>{x.n}</span>
          </button>
        ))}
      </div>
    )
  }
  if (kind === 'performance') {
    const members = [...new Set(allocations.flatMap(a => a.shares.map(s => s.member)))]
    return (
      <div className="mt-2 space-y-1.5">
        {members.map(m2 => {
          const total = allocations.reduce((s, a) => {
            const c = contracts.find(x => x.id === a.contractId)
            const sh = a.shares.find(x => x.member === m2)
            return s + (c && sh ? c.amount * commissionRateOf(c.amount) * sh.share / 100 : 0)
          }, 0)
          return (
            <button key={m2} onClick={() => go({ name: 'performance' })}
              className="flex w-full items-center gap-2 rounded-lg border border-slate-100 bg-slate-50/70 px-3 py-2 hover:border-[#3370ff]/40">
              <Medal className="h-3.5 w-3.5 shrink-0 text-slate-400" />
              <span className="flex-1 text-left text-[12px] text-slate-700">{m2}</span>
              <span className="tnum text-[12px] font-bold text-slate-800">{fmtMoneyFull(Math.round(total))}</span>
            </button>
          )
        })}
      </div>
    )
  }
  if (kind === 'renewals') {
    return (
      <div className="mt-2 space-y-1.5">
        {renewals.map(r => (
          <button key={r.id} onClick={() => go({ name: 'contracts' })}
            className="flex w-full items-center gap-2 rounded-lg border border-slate-100 bg-slate-50/70 px-3 py-2 text-left hover:border-[#3370ff]/40">
            <Repeat className="h-3.5 w-3.5 shrink-0 text-slate-400" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12px] text-slate-700">{r.customer} · {r.item}</span>
              <span className="tnum block text-[10px] text-slate-400">到期 {r.dueDate}</span>
            </span>
            <span className="tnum shrink-0 text-[11px] font-semibold text-slate-700">{fmtMoneyFull(r.amount)}</span>
            <span className={cn('shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium',
              r.status === '已续费' ? 'border-emerald-200 bg-emerald-50 text-emerald-600'
              : r.status === '跟进中' ? 'border-blue-200 bg-blue-50 text-[#3370ff]'
              : 'border-amber-200 bg-amber-50 text-amber-700')}>{r.status}</span>
          </button>
        ))}
      </div>
    )
  }
  if (kind === 'skus') {
    return (
      <div className="mt-2 space-y-1.5">
        {skus.map(s => (
          <button key={s.id} onClick={() => go({ name: 'modules' })}
            className="flex w-full items-center gap-2 rounded-lg border border-slate-100 bg-slate-50/70 px-3 py-2 text-left hover:border-[#3370ff]/40">
            <Package className="h-3.5 w-3.5 shrink-0 text-slate-400" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12px] text-slate-700">{s.name}</span>
              <span className="block truncate text-[10px] text-slate-400">{s.kind} · {s.billing} · {s.binding}</span>
            </span>
            <span className="tnum shrink-0 text-[11px] font-semibold text-slate-700">{fmtMoneyFull(s.price)}/{s.unit}</span>
          </button>
        ))}
      </div>
    )
  }
  return null
}

/** 行动卡片：人确认后真正执行 */
function ActionCard({ m }: { m: ChatMessage }) {
  const { advanceStage, addReminder, createProposal, setChatActionStatus, navigate, setChatOpen } = useStore()
  const [goto, setGoto] = useState<Parameters<typeof navigate>[0] | null>(null)
  const a = m.action!
  if (a.status === 'cancelled') {
    return <p className="mt-2 flex items-center gap-1.5 text-[11px] text-slate-400"><Ban className="h-3 w-3" />已取消，未做任何修改</p>
  }
  if (a.status === 'done') {
    return (
      <div className="mt-2 flex items-center gap-2">
        <p className="flex items-center gap-1.5 text-[11px] font-medium text-emerald-600"><CheckCircle2 className="h-3.5 w-3.5" />已执行并留痕</p>
        {goto && (
          <button onClick={() => { setChatOpen(false); navigate(goto) }} className="flex items-center gap-0.5 text-[11px] font-medium text-[#3370ff] hover:underline">
            去查看 <ChevronRight className="h-3 w-3" />
          </button>
        )}
      </div>
    )
  }
  const confirm = () => {
    if (a.intent === 'advanceStage') { advanceStage(a.payload.leadId); setGoto({ name: 'lead', id: a.payload.leadId }) }
    if (a.intent === 'reminder') { addReminder(a.payload.title, '明天', a.payload.leadId); setGoto(null) }
    if (a.intent === 'proposal') { createProposal(a.payload.leadId, ['客户背景', '触点记录']); setGoto({ name: 'proposals' }) }
    setChatActionStatus(m.id, 'done')
  }
  return (
    <div className="mt-2 rounded-xl border border-amber-200 bg-amber-50/60 p-3">
      <p className="flex items-center gap-1.5 text-[12px] font-semibold text-amber-800"><Play className="h-3.5 w-3.5" />{a.label}</p>
      <p className="mt-1 text-[12px] text-slate-600">{a.detail}</p>
      <div className="mt-2.5 flex gap-2">
        <button onClick={confirm} className="flex items-center gap-1 rounded-lg bg-[#3370ff] px-3 py-1.5 text-[12px] font-medium text-white hover:bg-[#2952cc]">
          <CheckCircle2 className="h-3.5 w-3.5" />确认执行
        </button>
        <button onClick={() => setChatActionStatus(m.id, 'cancelled')} className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[12px] text-slate-500 hover:border-slate-300">
          取消
        </button>
      </div>
    </div>
  )
}

/** 数字员工工作台：完整交互 —— 在线查、在线改、执行任务，产出均需人确认 */
export function EmployeePanel() {
  const { chatOpen, setChatOpen, chat, sendChat } = useStore()
  const [input, setInput] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)
  const [cfgOpen, setCfgOpen] = useState(false)
  const [cfg, setCfg] = useState<HarnessCfg>(() => getHarnessCfg())
  const [online, setOnline] = useState(false)
  const [testing, setTesting] = useState(false)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chat, chatOpen])

  // 打开面板时真实探测一次本地 Harness 网关
  useEffect(() => {
    if (chatOpen && cfg.url) {
      testHarnessConnection(cfg.url).then(setOnline)
    } else if (!cfg.url) {
      setOnline(false)
    }
  }, [chatOpen, cfg.url])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setChatOpen(false) }
    if (chatOpen) window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [chatOpen, setChatOpen])

  if (!chatOpen) return null

  const send = (text: string) => {
    const t = text.trim()
    if (!t) return
    sendChat(t)
    setInput('')
  }

  const testConn = async () => {
    if (!cfg.url) { toast.error('请先填写网关地址'); return }
    setTesting(true)
    const ok = await testHarnessConnection(cfg.url)
    setOnline(ok)
    setTesting(false)
    if (ok) toast.success('已连接本地 Harness，开放问答将流式输出')
    else toast.error('未检测到本地网关，开放问答仍走内置演示引擎')
  }

  const saveCfg = () => {
    saveHarnessCfg(cfg)
    toast.success('网关配置已保存')
    if (cfg.url) testHarnessConnection(cfg.url).then(setOnline)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm" onClick={() => setChatOpen(false)}>
      <div
        className="flex h-full w-full flex-col bg-[#f5f6f7] md:h-[88vh] md:w-[min(1080px,94vw)] md:rounded-2xl md:border md:border-slate-200 md:shadow-2xl overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center gap-3 border-b border-slate-200 bg-white px-5 py-4">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#3370ff]">
            <Bot className="h-5 w-5 text-white" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-bold text-slate-900">数字员工工作台</div>
            <div className="flex items-center gap-1.5 text-[11px] text-slate-400">
              <span className="relative flex h-1.5 w-1.5"><span className="pulse-dot absolute inline-flex h-full w-full rounded-full bg-emerald-500" /></span>
              连接工作台全部数据 · 可在线查 / 在线改 / 执行任务 · 修改均需你确认后生效
            </div>
          </div>
          <button
            onClick={() => setCfgOpen(true)}
            className={cn('flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors',
              cfg.url && online ? 'border-emerald-200 bg-emerald-50 text-emerald-600'
              : cfg.url ? 'border-amber-200 bg-amber-50 text-amber-600'
              : 'border-slate-200 bg-slate-50 text-slate-400 hover:border-slate-300')}
          >
            <span className={cn('h-1.5 w-1.5 rounded-full', cfg.url ? (online ? 'bg-emerald-500' : 'bg-amber-500') : 'bg-emerald-500')} />
            {cfg.url ? (online ? 'Harness 流式' : 'Harness 离线') : '同源代理 · 流式'}
            <Settings2 className="h-3 w-3" />
          </button>
          <button onClick={() => setChatOpen(false)} className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100">
            <X className="h-[18px] w-[18px]" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* 对话区 */}
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex-1 overflow-y-auto px-5 py-5 space-y-4">
              {chat.map(m => (
                <div key={m.id} className={`msg-in flex gap-2.5 ${m.role === 'user' ? 'flex-row-reverse' : ''}`}>
                  <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${m.role === 'assistant' ? 'bg-[#3370ff]' : 'bg-slate-300'}`}>
                    {m.role === 'assistant' ? <Bot className="h-4 w-4 text-white" /> : <User className="h-4 w-4 text-white" />}
                  </div>
                  <div className={`max-w-[85%] rounded-xl px-3.5 py-2.5 text-[13px] leading-relaxed ${
                    m.role === 'assistant'
                      ? 'border border-slate-200/70 border-l-[3px] border-l-[#3370ff] bg-white text-slate-700 shadow-sm'
                      : 'bg-[#3370ff] text-white'
                  }`}>
                    {m.pending ? (
                      <span className="flex items-center gap-1 py-1">
                        {[0, 1, 2].map(i => (
                          <span key={i} className="typing-dot h-1.5 w-1.5 rounded-full bg-[#3370ff]" style={{ animationDelay: `${i * 0.2}s` }} />
                        ))}
                      </span>
                    ) : (
                      <>
                        {m.text}
                        <DataCard m={m} />
                        {m.action && <ActionCard m={m} />}
                      </>
                    )}
                  </div>
                </div>
              ))}
              <div ref={bottomRef} />
            </div>

            {/* 输入区 */}
            <div className="border-t border-slate-200 bg-white p-4">
              <div className="mb-3 flex flex-wrap gap-1.5">
                {QUICK.map(q => (
                  <button key={q} onClick={() => send(q)}
                    className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] text-slate-600 hover:border-[#3370ff] hover:text-[#3370ff] transition-colors">
                    {q}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <input
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && send(input)}
                  placeholder="查数据、下指令，如：推进 宁夏电信 到下一阶段 / 提醒 长庆油田 回访…"
                  className="h-10 flex-1 rounded-lg border border-slate-200/60 bg-white shadow-sm px-3.5 text-[13px] placeholder:text-slate-400 focus:border-[#3370ff] focus:outline-none"
                />
                <button className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#3370ff] text-white hover:bg-[#2952cc]" onClick={() => send(input)}>
                  <Send className="h-4 w-4" />
                </button>
              </div>
            </div>
          </div>

          {/* 右侧操作台（桌面） */}
          <div className="hidden md:flex w-[280px] shrink-0 flex-col gap-4 border-l border-slate-200 bg-white/60 p-5 overflow-y-auto">
            <p className="text-[11px] font-medium tracking-widest text-slate-400">我能做什么</p>
            {CAPABILITIES.map(c => (
              <div key={c.title} className="rounded-xl border border-slate-200/70 bg-white p-4 shadow-sm">
                <p className="flex items-center gap-2 text-[13px] font-semibold text-slate-800">
                  <c.icon className="h-4 w-4 text-[#3370ff]" />{c.title}
                </p>
                <ul className="mt-2.5 space-y-1.5">
                  {c.items.map(i => <li key={i} className="text-[12px] text-slate-500">· {i}</li>)}
                </ul>
              </div>
            ))}
            <div className="rounded-xl border border-emerald-200 bg-emerald-50/60 p-4">
              <p className="flex items-center gap-2 text-[13px] font-semibold text-emerald-700">
                <CircleDollarSign className="h-4 w-4" />安全边界
              </p>
              <p className="mt-2 text-[12px] leading-relaxed text-emerald-700/80">查询直接给结果；任何改数据、执行任务都会先出行动卡片，你点「确认执行」才生效，全程动态留痕。</p>
            </div>
            <div className="rounded-xl border border-slate-200/70 bg-white p-4 shadow-sm">
              <p className="flex items-center gap-2 text-[13px] font-semibold text-slate-800">
                <ListTodo className="h-4 w-4 text-[#3370ff]" />试试这些指令
              </p>
              <ul className="mt-2.5 space-y-1.5 text-[12px] text-slate-500">
                <li>·「查合同进度」「查待办事项」</li>
                <li>·「推进 宁夏电信 到下一阶段」</li>
                <li>·「提醒 长庆油田 回访」</li>
                <li>·「给 可孚医疗 生成方案」</li>
                <li>·「查部署站点」「提成汇总」</li>
              </ul>
            </div>
          </div>
        </div>
      </div>

      {/* Harness 网关配置 */}
      <Dialog open={cfgOpen} onOpenChange={setCfgOpen}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-[15px]">
              <Settings2 className="h-4 w-4 text-[#3370ff]" />连接本地 Harness 网关
            </DialogTitle>
            <DialogDescription>
              行动指令（推进/提醒/生成方案）始终本地识别、人确认后执行；开放问答缺省走同源会话代理（服务端持有网关密钥），SSE 逐字流式输出。也可手工指向其他自备网关。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Input
              value={cfg.url ?? ''}
              onChange={e => setCfg(c => ({ ...c, url: e.target.value }))}
              placeholder="网关地址（可选覆盖，留空 = 同源会话代理）"
            />
            <Input
              type="password"
              value={cfg.key ?? ''}
              onChange={e => setCfg(c => ({ ...c, key: e.target.value }))}
              placeholder="API Key（如网关开启鉴权）"
            />
            <Input
              value={cfg.model ?? ''}
              onChange={e => setCfg(c => ({ ...c, model: e.target.value }))}
              placeholder="模型名（可选，默认 glm-4.6，仅通用 /v1 链路使用）"
            />
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" disabled={testing} onClick={testConn}>
                {testing ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Unplug className="h-3.5 w-3.5 mr-1" />}测试连接
              </Button>
              <Button className="flex-1 bg-[#3370ff] hover:bg-[#2952cc]" onClick={saveCfg}>保存配置</Button>
            </div>
            <p className="text-[11px] leading-relaxed text-slate-400">
              当前状态：{cfg.url ? (online ? '已连接手工网关，开放问答走流式输出' : '手工网关离线或地址有误') : '缺省同源会话代理（登录会话直通 fde-assistant，无需填写）'}。
              开放问答走 @persona/fde-assistant（服务端注入工作台数据快照与记忆）；仅在需要指向其他网关时才手工填写地址与 key。
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
