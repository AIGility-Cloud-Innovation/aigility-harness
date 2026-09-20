import { useEffect, useRef, useState } from 'react'
import { useStore } from '@/store/AppContext'
import { AIReviewCard, PageHeader } from '@/components/bits'
import { knowledgeStats, INDUSTRY_TREE, LEARNING_PATHS, type OntologyNode } from '@/data/mock'
import { OntologyGraph } from '@/components/OntologyGraph'
import type { KnowledgeKind } from '@/types'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { ScrollText, Wrench, FolderOpen, MessageSquareText, TrendingUp, History, LayoutTemplate, ChevronDown, Send, GraduationCap, Bot, User, CheckCircle2, Plug, Crown, RefreshCw, Waves, Scale, Library, BrainCircuit, MessageSquareQuote, BookOpen } from 'lucide-react'
import { cn } from '@/lib/utils'

const KIND_META: Record<KnowledgeKind, { label: string; icon: any; count: number; trend: string; desc: string }> = {
  rule: { label: '经验规则', icon: ScrollText, count: knowledgeStats.rule, trend: '+5 本周', desc: '报价、跟进、预警的固化经验，带标签' },
  skill: { label: '能力', icon: Wrench, count: knowledgeStats.skill, trend: '+1 本周', desc: '出方案、算报价等可复用能力' },
  node: { label: '资料', icon: FolderOpen, count: knowledgeStats.node, trend: '+2 本周', desc: `案例 ${knowledgeStats.case} 个 · 调研方案 ${knowledgeStats.research} 份` },
  annotation: { label: '专家批注', icon: MessageSquareText, count: knowledgeStats.annotation, trend: '+1 本周', desc: '人在回路中沉淀的专家判断' },
  memory: { label: '时序记忆', icon: History, count: knowledgeStats.memory, trend: '+23 本周', desc: '每人与数字员工交互沉淀的记忆' },
  template: { label: '方案模板', icon: LayoutTemplate, count: knowledgeStats.template, trend: '+1 本周', desc: '各行业方案的参考模板' },
}

/* ---------------- Tab 1: 沉淀资产 ---------------- */
function AssetsTab() {
  const { knowledge, reviewKnowledge } = useStore()
  const [tab, setTab] = useState<'all' | '待审阅' | '已采纳' | '已拒绝'>('all')
  const filtered = knowledge.filter(k => tab === 'all' ? true : k.status === tab)
  const pendingCount = knowledge.filter(k => k.status === '待审阅').length

  return (
    <div>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        {(Object.keys(KIND_META) as KnowledgeKind[]).map(k => {
          const m = KIND_META[k]
          return (
            <div key={k} className="rounded-xl border border-slate-200/60 bg-white shadow-sm p-5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-[13px] text-slate-500">
                  <m.icon className="h-4 w-4 text-[#3370ff]" />{m.label}
                </div>
                <span className="flex items-center gap-1 text-[11px] text-emerald-600 tnum"><TrendingUp className="h-3 w-3" />{m.trend}</span>
              </div>
              <p className="tnum mt-2.5 text-[28px] font-bold leading-none text-slate-900">{m.count}</p>
              <p className="mt-2 text-xs text-slate-400">{m.desc}</p>
            </div>
          )
        })}
      </div>

      <div className="mt-6 mb-4 flex items-center gap-1.5">
        {(['all', '待审阅', '已采纳', '已拒绝'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={cn('rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
              tab === t ? 'border-[#3370ff] bg-[#3370ff] text-white' : 'border-slate-200 bg-white text-slate-600 hover:text-[#3370ff]')}>
            {t === 'all' ? '全部' : t}
            {t === '待审阅' && pendingCount > 0 && <span className="tnum ml-1 rounded-full bg-white/20 px-1">{pendingCount}</span>}
          </button>
        ))}
      </div>

      <div className="space-y-3">
        {filtered.map(k => (
          <AIReviewCard
            key={k.id}
            title={k.title}
            basis={`${KIND_META[k.kind].label} · 来源：${k.source} · ${k.date}`}
            status={k.status === '待审阅' ? 'pending' : k.status === '已采纳' ? 'adopted' : 'rejected'}
            reason={k.rejectReason}
            onRespond={(a, r) => reviewKnowledge(k.id, a === 'rejected' ? '已拒绝' : '已采纳', r)}
            body={
              <>
                <p>{k.content}</p>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {k.tags?.map(t => (
                    <span key={t} className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[11px] text-slate-500">#{t}</span>
                  ))}
                </div>
                <div className="mt-2 flex gap-4 text-xs text-slate-400">
                  <span>被引用 <span className="tnum font-semibold text-slate-600">{k.usedCount}</span> 次</span>
                  <span>影响成单 <span className="tnum font-semibold text-slate-600">{k.impactCount}</span> 单</span>
                </div>
              </>
            }
          />
        ))}
        {filtered.length === 0 && (
          <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50/60 py-10 text-center text-sm text-slate-500">当前状态下暂无条目</div>
        )}
      </div>
    </div>
  )
}

/* ---------------- Tab 2: 行业机理 ---------------- */
function IndustryNode({ node }: { node: OntologyNode }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="rounded-lg border border-slate-200/60 bg-white shadow-sm">
      <button onClick={() => setOpen(v => !v)} className="flex w-full items-center gap-3 px-4 py-3 text-left">
        <ChevronDown className={cn('h-4 w-4 shrink-0 text-slate-400 transition-transform', open && 'rotate-180')} />
        <span className="text-[14px] font-medium text-slate-800">{node.name}</span>
        <span className="tnum rounded-full bg-blue-50 border border-blue-200 px-2 py-0.5 text-[11px] font-medium text-[#3370ff]">{node.ontologyCount} 条本体知识</span>
        <span className="ml-auto hidden sm:block text-xs text-slate-400 truncate max-w-[220px]">沉淀自：{node.fromProjects.join('、')}</span>
      </button>
      {open && (
        <div className="border-t border-slate-100 px-4 py-3 pl-11">
          <p className="sm:hidden mb-2 text-xs text-slate-400">沉淀自：{node.fromProjects.join('、')}</p>
          <div className="flex flex-wrap gap-1.5">
            {node.samples.map(s => (
              <span key={s} className="rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-600">{s}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function IndustryTab() {
  return (
    <div className="space-y-7">
      {/* 沉淀链路 */}
      <div className="rounded-xl border border-slate-200/60 bg-white shadow-sm p-5">
        <h2 className="text-[15px] font-semibold text-slate-900">行业理解是怎么长出来的</h2>
        <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
          {['服务客户做方案', '沉淀需求 · 案例 · 资料 · 文档', '提炼规则与机理', '形成行业本体知识', '反哺下一个方案'].map((s, i) => (
            <div key={s} className="flex items-center gap-2 sm:flex-1">
              <div className={cn('flex-1 rounded-lg border px-3 py-2.5 text-center text-[12px] font-medium',
                i === 3 ? 'border-[#3370ff] bg-blue-50 text-[#3370ff]' : 'border-slate-200 bg-slate-50/60 text-slate-600')}>
                {s}
              </div>
              {i < 4 && <span className="hidden sm:block text-slate-300">→</span>}
            </div>
          ))}
        </div>
        <p className="mt-3 text-xs text-slate-400">客户越多，每个子行业的本体知识越厚；方案规则同步沉淀，越用越聪明。</p>
      </div>

      {/* 本体知识图谱 */}
      <div className="rounded-xl border border-slate-200/60 bg-white shadow-sm p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-[15px] font-semibold text-slate-900">行业本体知识图谱</h2>
          <span className="text-xs text-slate-400">行业 → 子行业 → 本体知识条目</span>
        </div>
        <OntologyGraph />
      </div>

      {/* 行业机理树 */}
      {INDUSTRY_TREE.map(g => (
        <div key={g.industry} className="rounded-xl border border-slate-200/60 bg-white shadow-sm p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-[15px] font-semibold text-slate-900">{g.industry}</h2>
            <span className="tnum text-xs text-slate-400">{g.children.reduce((s, c) => s + c.ontologyCount, 0)} 条本体知识</span>
          </div>
          <div className="mt-3 space-y-2">
            {g.children.map(c => <IndustryNode key={c.name} node={c} />)}
          </div>
        </div>
      ))}
    </div>
  )
}

/* ---------------- Tab 3: 培训问答 ---------------- */
interface QA { role: 'user' | 'assistant'; text: string; refs?: string[] }

function trainAnswer(q: string): QA {
  if (q.includes('运维') || q.includes('报价') || q.includes('价格'))
    return { role: 'assistant', text: '报价由规则引擎约束生成：基础一体机 ¥20 万必选；运维服务（¥2 万/年）在工业场景近 12 单中 9 单启用，几乎必选；央国企客户默认启用私有化部署（+¥5 万），并转化为合规卖点。每次改规则需填理由并生成新版本，历史报价单不受影响。', refs: ['经验规则：工业客户报价默认含运维条款', '经验规则：央国企报价默认含私有化部署'] }
  if (q.includes('央企') || q.includes('汇报') || q.includes('拜访'))
    return { role: 'assistant', text: '央企首次汇报先讲资质背书（省级投资、行业大会报道、灯塔案例），建立信任后再展开技术细节。政府类线索从接触到首访不宜超过 2 周，否则热度明显衰减。', refs: ['专家批注：央企汇报先讲背书', '经验规则：政府客户两周内必须首访'] }
  if (q.includes('化工') || q.includes('机理') || q.includes('行业') || q.includes('子行业'))
    return { role: 'assistant', text: '化工行业在工作台中细分为天然气净化（86 条本体）、油气田（64 条）、煤化工（32 条）、磷化工（18 条）。每个子行业的工艺机理、异常工况图谱来自我们服务过的项目沉淀，做方案时自动作为素材推荐。', refs: ['行业机理：化工子行业知识树', '模板：工业预测预警方案（PPT 结构）'] }
  return { role: 'assistant', text: '我基于工作台沉淀的 128 条经验规则、356 条时序记忆和行业本体知识回答。新人建议先走学习路径：了解全流程 → 学报价规则 → 跟访 → 独立出方案 → 参与复盘提炼规则。', refs: ['学习路径：FDE 工程师上手五步法'] }
}

const TRAIN_QUICK = ['报价时运维条款怎么定？', '央企客户汇报要注意什么？', '化工行业有哪些子行业本体知识？', '新人怎么快速上手？']

function TrainingTab() {
  const [qa, setQa] = useState<QA[]>([
    { role: 'assistant', text: '你好，我是培训助手。新人可以问我任何关于报价规则、行业知识、客户打法的问题，我的回答都会引用知识库里的沉淀条目，方便你溯源学习。' },
  ])
  const [input, setInput] = useState('')
  const [paths, setPaths] = useState(LEARNING_PATHS)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [qa])

  const ask = (text: string) => {
    const t = text.trim()
    if (!t) return
    setQa(prev => [...prev, { role: 'user', text: t }])
    setInput('')
    setTimeout(() => setQa(prev => [...prev, trainAnswer(t)]), 700)
  }

  const toggleStep = (pi: number, si: number) =>
    setPaths(prev => prev.map((p, i) => i !== pi ? p : { ...p, steps: p.steps.map((s, j) => j !== si ? s : { ...s, done: !s.done }) }))

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
      {/* 问答 */}
      <div className="rounded-xl border border-slate-200/60 bg-white shadow-sm flex flex-col lg:col-span-2" style={{ minHeight: 480 }}>
        <div className="border-b border-slate-100 px-5 py-3.5 flex items-center gap-2">
          <GraduationCap className="h-4 w-4 text-[#3370ff]" />
          <span className="text-[15px] font-semibold text-slate-900">知识问答</span>
          <span className="text-xs text-slate-400">回答引用知识库条目，可溯源</span>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4" style={{ maxHeight: 480 }}>
          {qa.map((m, i) => (
            <div key={i} className={cn('msg-in flex gap-2.5', m.role === 'user' && 'flex-row-reverse')}>
              <div className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-lg', m.role === 'assistant' ? 'bg-[#3370ff]' : 'bg-slate-300')}>
                {m.role === 'assistant' ? <Bot className="h-4 w-4 text-white" /> : <User className="h-4 w-4 text-white" />}
              </div>
              <div className={cn('max-w-[85%] rounded-lg px-3.5 py-2.5 text-[13px] leading-relaxed',
                m.role === 'assistant' ? 'border border-slate-200 border-l-[3px] border-l-[#3370ff] bg-slate-50/60 text-slate-700' : 'bg-[#3370ff] text-white')}>
                {m.text}
                {m.refs && (
                  <div className="mt-2 space-y-1 border-t border-slate-200 pt-2">
                    {m.refs.map(r => (
                      <p key={r} className="flex items-center gap-1.5 text-[11px] text-[#3370ff]">
                        <ScrollText className="h-3 w-3 shrink-0" />引用：{r}
                      </p>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
        <div className="border-t border-slate-100 p-4">
          <div className="mb-2.5 flex flex-wrap gap-1.5">
            {TRAIN_QUICK.map(q => (
              <button key={q} onClick={() => ask(q)} className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] text-slate-600 hover:border-[#3370ff] hover:text-[#3370ff] transition-colors">{q}</button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && ask(input)}
              placeholder="问一个新人最困惑的问题…"
              className="h-9 flex-1 rounded-md border border-slate-200 px-3 text-[13px] placeholder:text-slate-400 focus:border-[#3370ff]" />
            <button onClick={() => ask(input)} className="flex h-9 w-9 items-center justify-center rounded-md bg-[#3370ff] text-white hover:bg-[#2952cc]">
              <Send className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>

      {/* 学习路径 */}
      <div className="space-y-4">
        {paths.map((p, pi) => {
          const doneCount = p.steps.filter(s => s.done).length
          const pct = Math.round((doneCount / p.steps.length) * 100)
          return (
            <div key={p.member} className="rounded-xl border border-slate-200/60 bg-white shadow-sm p-5">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-[14px] font-semibold text-slate-900">{p.member}</p>
                  <p className="text-xs text-slate-400">{p.role}</p>
                </div>
                <span className="tnum text-lg font-bold text-[#3370ff]">{pct}%</span>
              </div>
              <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                <div className="h-full rounded-full bg-[#3370ff] transition-all" style={{ width: `${pct}%` }} />
              </div>
              <div className="mt-3 space-y-2">
                {p.steps.map((s, si) => (
                  <button key={s.title} onClick={() => toggleStep(pi, si)} className="flex w-full items-start gap-2.5 text-left">
                    <CheckCircle2 className={cn('mt-0.5 h-4 w-4 shrink-0', s.done ? 'text-emerald-500' : 'text-slate-300')} />
                    <span className={cn('text-[13px] leading-relaxed', s.done ? 'text-slate-400 line-through' : 'text-slate-700')}>{s.title}</span>
                  </button>
                ))}
              </div>
            </div>
          )
        })}
        <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50/60 p-4 text-xs leading-relaxed text-slate-500">
          学习路径由行业队长分配，完成度同步到空间可视化面板；新人提问的问答记录也会沉淀为时序记忆，成为下一位新人的教材。
        </div>
      </div>
    </div>
  )
}

/* ---------------- Tab 4: 太忆空间（三池视图 + 同步状态 + 资产图谱） ---------------- */
const POOLS = [
  { key: 'memory', label: '记忆流', color: '#6366f1', desc: '人 × 数字员工的时序记忆与项目过程记忆' },
  { key: 'rule', label: '规则库', color: '#3370ff', desc: '复盘与专家批注提炼的业务规则' },
  { key: 'knowledge', label: '知识库', color: '#059669', desc: '行业知识、案例、模板与机理本体' },
]

const SPACE_NODES = [
  { label: '时序记忆', count: knowledgeStats.memory, x: 120, y: 60, pool: 'memory' },
  { label: '过程记忆', count: 46, x: 90, y: 200, pool: 'memory' },
  { label: '经验规则', count: knowledgeStats.rule, x: 400, y: 36, pool: 'rule' },
  { label: '专家批注', count: knowledgeStats.annotation, x: 620, y: 80, pool: 'rule' },
  { label: '行业资料', count: knowledgeStats.node, x: 650, y: 220, pool: 'knowledge' },
  { label: '案例', count: knowledgeStats.case, x: 500, y: 310, pool: 'knowledge' },
  { label: '方案模板', count: knowledgeStats.template, x: 240, y: 300, pool: 'knowledge' },
  { label: '能力技能', count: knowledgeStats.skill, x: 600, y: 160, pool: 'knowledge' },
]
const poolColor = (key: string) => POOLS.find(p => p.key === key)?.color ?? '#3370ff'

function SpaceTab() {
  const { leads, knowledge } = useStore()
  const memories = knowledge.filter(k => k.kind === 'memory')
  const rules = knowledge.filter(k => k.kind === 'rule')
  const adoptedRules = rules.filter(r => r.status === '已采纳').length
  const pendingCount = knowledge.filter(k => k.status === '待审阅').length

  return (
    <div>
      {/* 连接与订阅状态 */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="rounded-2xl border border-slate-200/60 bg-white shadow-sm p-5">
          <div className="flex items-center gap-2 text-[13px] text-slate-500"><Plug className="h-4 w-4 text-[#3370ff]" />MCP 连接</div>
          <div className="mt-2.5 flex items-center gap-2">
            <span className="relative flex h-2.5 w-2.5"><span className="pulse-dot absolute inline-flex h-full w-full rounded-full bg-emerald-500" /></span>
            <span className="text-[15px] font-semibold text-slate-900">已连接</span>
          </div>
          <p className="tnum mt-2 text-xs text-slate-400 break-all">mcp://internal.timem.cloud/space</p>
          <p className="mt-1 text-xs text-slate-400">心跳正常 · 延迟 12ms</p>
        </div>
        <div className="rounded-2xl border border-slate-200/60 bg-white shadow-sm p-5">
          <div className="flex items-center gap-2 text-[13px] text-slate-500"><Crown className="h-4 w-4 text-amber-500" />订阅信息</div>
          <p className="mt-2.5 text-[15px] font-semibold text-slate-900">团队版 · 20 席</p>
          <p className="mt-2 text-xs text-slate-400">到期时间 <span className="tnum">2027-03-01</span> · 自动续费</p>
          <p className="mt-1 text-xs text-slate-400">含项目组协作与空间可视化面板</p>
        </div>
        <div className="rounded-2xl border border-slate-200/60 bg-white shadow-sm p-5">
          <div className="flex items-center gap-2 text-[13px] text-slate-500"><RefreshCw className="h-4 w-4 text-emerald-600" />数据同步</div>
          <p className="mt-2.5 text-[15px] font-semibold text-slate-900">实时同步中</p>
          <p className="tnum mt-2 text-xs text-slate-400">最近同步：09-12 10:24 · 方向：工作台 → 空间</p>
          <p className="mt-1 text-xs text-slate-400">记忆流 / 规则库 / 知识库 / 项目组动态</p>
        </div>
      </div>

      {/* 三大资产池 */}
      <div className="mt-6 grid grid-cols-1 gap-5 lg:grid-cols-3">
        {/* 记忆流 */}
        <div className="rounded-2xl border border-slate-200/60 bg-white shadow-sm p-6">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-indigo-50"><Waves className="h-[18px] w-[18px] text-indigo-500" /></span>
            <div className="flex-1">
              <h2 className="text-[15px] font-semibold text-slate-900">记忆流</h2>
              <p className="text-[11px] text-slate-400">时序记忆 + 过程记忆，按时间持续累积</p>
            </div>
            <span className="tnum text-[20px] font-bold text-indigo-500">{knowledgeStats.memory + 46}</span>
          </div>
          <div className="mt-4 space-y-0">
            {memories.map((m, i) => (
              <div key={m.id} className="relative flex gap-3 pb-4 last:pb-0">
                {i < memories.length - 1 && <div className="absolute left-[5px] top-4 bottom-0 w-px bg-indigo-100" />}
                <span className="relative mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full bg-indigo-400" />
                <div className="min-w-0">
                  <p className="text-[12px] font-medium leading-snug text-slate-700">{m.title.replace('时序记忆：', '')}</p>
                  <p className="mt-1 text-[11px] leading-relaxed text-slate-400 line-clamp-2">{m.content}</p>
                  <p className="tnum mt-1 text-[10px] text-indigo-400">{m.date} · 被复用 {m.usedCount} 次</p>
                </div>
              </div>
            ))}
          </div>
          <p className="mt-3 border-t border-slate-100 pt-3 text-[11px] text-slate-400">线索过程记忆随拜访/访谈实时汇入，数字员工越用越懂你和客户</p>
        </div>

        {/* 规则库 */}
        <div className="rounded-2xl border border-slate-200/60 bg-white shadow-sm p-6">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-50"><Scale className="h-[18px] w-[18px] text-[#3370ff]" /></span>
            <div className="flex-1">
              <h2 className="text-[15px] font-semibold text-slate-900">规则库</h2>
              <p className="text-[11px] text-slate-400">复盘提炼的业务规则，审阅后生效</p>
            </div>
            <span className="tnum text-[20px] font-bold text-[#3370ff]">{knowledgeStats.rule}</span>
          </div>
          <div className="tnum mt-3 flex items-center gap-2 text-[11px] text-slate-400">
            <span className="rounded bg-emerald-50 border border-emerald-100 px-1.5 py-0.5 text-emerald-600">已采纳 {adoptedRules}</span>
            <span className="rounded bg-amber-50 border border-amber-100 px-1.5 py-0.5 text-amber-600">待审阅 {rules.length - adoptedRules}</span>
            <span className="ml-auto">采纳率 {Math.round(adoptedRules / Math.max(rules.length, 1) * 100)}%</span>
          </div>
          <div className="mt-3 space-y-2">
            {rules.slice(0, 4).map(r => (
              <div key={r.id} className="rounded-lg border border-slate-100 bg-slate-50/60 px-3 py-2.5">
                <p className="flex items-center gap-1.5 text-[12px] font-medium text-slate-700">
                  <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', r.status === '已采纳' ? 'bg-emerald-500' : 'bg-amber-400')} />
                  {r.title}
                </p>
                <p className="tnum mt-1 text-[10px] text-slate-400">应用 {r.usedCount} 次 · 见效 {r.impactCount} 次 · {r.source}</p>
              </div>
            ))}
          </div>
          <p className="mt-3 border-t border-slate-100 pt-3 text-[11px] text-slate-400">审阅入口在「沉淀资产」页签，逐条采纳/拒绝并留痕</p>
        </div>

        {/* 知识库 */}
        <div className="rounded-2xl border border-slate-200/60 bg-white shadow-sm p-6">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-50"><Library className="h-[18px] w-[18px] text-emerald-600" /></span>
            <div className="flex-1">
              <h2 className="text-[15px] font-semibold text-slate-900">知识库</h2>
              <p className="text-[11px] text-slate-400">行业资料 · 案例 · 模板 · 机理本体</p>
            </div>
            <span className="tnum text-[20px] font-bold text-emerald-600">{knowledgeStats.node + knowledgeStats.skill + knowledgeStats.template + knowledgeStats.case + knowledgeStats.annotation}</span>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-2">
            {[
              { icon: BookOpen, label: '行业资料', count: knowledgeStats.node },
              { icon: BrainCircuit, label: '能力技能', count: knowledgeStats.skill },
              { icon: LayoutTemplate, label: '方案模板', count: knowledgeStats.template },
              { icon: MessageSquareQuote, label: '专家批注', count: knowledgeStats.annotation },
            ].map(x => (
              <div key={x.label} className="rounded-lg border border-slate-100 bg-slate-50/60 px-3 py-2.5 text-center">
                <x.icon className="mx-auto h-4 w-4 text-emerald-600/70" />
                <p className="tnum mt-1.5 text-[15px] font-bold text-slate-800">{x.count}</p>
                <p className="text-[10px] text-slate-400">{x.label}</p>
              </div>
            ))}
          </div>
          <p className="mt-3 border-t border-slate-100 pt-3 text-[11px] text-slate-400">做方案时自动检索推荐相似案例，人工关联后作为生成上下文</p>
        </div>
      </div>

      {/* 沉淀资产图谱 */}
      <div className="mt-6 rounded-2xl border border-slate-200/60 bg-white shadow-sm p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-[15px] font-semibold text-slate-900">沉淀资产图谱</h2>
          <div className="flex items-center gap-3">
            {POOLS.map(p => (
              <span key={p.key} className="flex items-center gap-1.5 text-[11px] text-slate-500">
                <span className="h-2 w-2 rounded-full" style={{ background: p.color }} />{p.label}
              </span>
            ))}
          </div>
        </div>
        <div className="mt-2 overflow-x-auto">
          <svg viewBox="0 0 720 360" className="mx-auto min-w-[560px] w-full max-w-[760px]">
            {SPACE_NODES.map(n => (
              <line key={n.label} x1="360" y1="180" x2={n.x} y2={n.y} stroke="#c6d4e4" strokeWidth="1.5" strokeDasharray="4 3" />
            ))}
            {SPACE_NODES.map(n => (
              <g key={n.label}>
                <circle cx={n.x} cy={n.y} r="30" fill={poolColor(n.pool)} fillOpacity="0.1" stroke={poolColor(n.pool)} strokeWidth="1.5" />
                <text x={n.x} y={n.y - 1} textAnchor="middle" fontSize="11" fill={poolColor(n.pool)} fontWeight="600">{n.label}</text>
                <text x={n.x} y={n.y + 13} textAnchor="middle" fontSize="10" fill={poolColor(n.pool)} className="tnum">{n.count}</text>
              </g>
            ))}
            <circle cx="360" cy="180" r="44" fill="#3370ff" />
            <text x="360" y="172" textAnchor="middle" fontSize="13" fill="#fff" fontWeight="700">FDE 工作台</text>
            <text x="360" y="188" textAnchor="middle" fontSize="9" fill="#bfdbfe">{leads.length} 条线索</text>
            <text x="360" y="200" textAnchor="middle" fontSize="9" fill="#bfdbfe">沉淀实时同步</text>
          </svg>
        </div>
      </div>

      <div className="mt-6 flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50/60 px-4 py-3 text-[13px] text-emerald-700">
        <CheckCircle2 className="h-4 w-4 shrink-0" />
        私有化部署，数据不出内网；空间能力通过 MCP 订阅接入（见「MCP 连接器」），不依赖外部 SaaS。
        {pendingCount > 0 && <span className="tnum ml-auto shrink-0 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">{pendingCount} 条候选待审阅</span>}
      </div>
    </div>
  )
}

/* ---------------- 页面 ---------------- */
export function Knowledge() {
  return (
    <div>
      <PageHeader title="知识沉淀" desc="沉淀资产 · 太忆空间三池 · 行业机理 · 培训问答：系统越用越聪明，新人越带越快" />
      <Tabs defaultValue="assets">
        <TabsList className="bg-slate-100 mb-5">
          <TabsTrigger value="assets" className="text-[13px]">沉淀资产</TabsTrigger>
          <TabsTrigger value="space" className="text-[13px]">太忆空间</TabsTrigger>
          <TabsTrigger value="industry" className="text-[13px]">行业机理</TabsTrigger>
          <TabsTrigger value="training" className="text-[13px]">培训问答</TabsTrigger>
        </TabsList>
        <TabsContent value="assets"><AssetsTab /></TabsContent>
        <TabsContent value="space"><SpaceTab /></TabsContent>
        <TabsContent value="industry"><IndustryTab /></TabsContent>
        <TabsContent value="training"><TrainingTab /></TabsContent>
      </Tabs>
    </div>
  )
}
