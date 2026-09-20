import { useState } from 'react'
import { useStore } from '@/store/AppContext'
import { StageBadge, AIReviewCard, Money } from '@/components/bits'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Checkbox } from '@/components/ui/checkbox'
import { STAGE_ORDER, type Touchpoint } from '@/types'
import { materialOptions, PROPOSAL_TEMPLATES, TEAM_MEMBERS, PROCESS_MEMORIES, DEFAULT_PROCESS_MEMORY } from '@/data/mock'
import { ArrowLeft, Plus, FileStack, Loader2, CheckCircle2, Ban, CalendarClock, UserPlus, Mic, ChevronDown, FileAudio, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'

export function LeadDetail({ id }: { id: string }) {
  const { leads, proposals, contracts, navigate, advanceStage, markLost, respondSuggestion, addTouchpoint, createProposal, addMember, addInterview, confirmInterview, processExtras } = useStore()
  const lead = leads.find(l => l.id === id)
  const [lostOpen, setLostOpen] = useState(false)
  const [lostReason, setLostReason] = useState('')
  const [tpOpen, setTpOpen] = useState(false)
  const [tp, setTp] = useState({ type: '线下拜访' as Touchpoint['type'], date: '2026-09-09', note: '' })
  const [genOpen, setGenOpen] = useState(false)
  const [materials, setMaterials] = useState<string[]>(['客户背景', '触点记录'])
  const [template, setTemplate] = useState(PROPOSAL_TEMPLATES[0])
  const [memberToAdd, setMemberToAdd] = useState('')
  const [generating, setGenerating] = useState(false)
  const [genStep, setGenStep] = useState(0)
  const [ivOpen, setIvOpen] = useState(false)
  const [ivForm, setIvForm] = useState({ title: '', participants: '', date: '2026-09-12', audioFile: '现场录音.m4a' })
  const [ivProcessing, setIvProcessing] = useState(false)
  const [ivStep, setIvStep] = useState(0)
  const [ivExpanded, setIvExpanded] = useState<Record<string, boolean>>({})

  if (!lead) return <div className="py-20 text-center text-slate-400">线索不存在</div>

  const idx = STAGE_ORDER.indexOf(lead.stage)
  const linkedProposals = proposals.filter(p => p.leadId === lead.id)
  const linkedContracts = contracts.filter(c => c.leadId === lead.id)

  const genSteps = ['读取客户背景与触点记录…', '匹配相似案例与调研方案…', '生成方案 PPT 与解决方案 Word…', '按报价规则引擎计算价格…']
  const ivSteps = ['上传音频文件…', '语音转写为文字…', 'AI 提炼需求 / 决策 / 待办…', '生成访谈记录，等待人工确认…']

  const doTranscribe = () => {
    setIvProcessing(true)
    setIvStep(0)
    const timer = setInterval(() => {
      setIvStep(s => {
        if (s >= ivSteps.length - 1) {
          clearInterval(timer)
          setTimeout(() => {
            const pain = lead.painPoints[0] ?? '经验沉淀不足，流程靠人盯'
            addInterview(lead.id, {
              date: ivForm.date,
              title: ivForm.title || '拜访访谈',
              participants: ivForm.participants || '客户方联系人',
              duration: `${20 + Math.floor(Math.random() * 25)} 分钟`,
              audioFile: ivForm.audioFile,
              transcript: [
                `客户：我们现在最头疼的是${pain}。`,
                `我方：这个问题在我们服务的${lead.industry}客户里很典型，之前有类似的落地案例。`,
                '客户：预算要等内部立项，你们先把方案资料和同行业案例发我看看。',
              ],
              summary: `客户确认核心痛点为「${pain}」；预算待内部立项，约定近期发送方案与同行业案例。`,
              extracted: [
                { kind: '需求' as const, text: pain },
                { kind: '待办' as const, text: '本周内发送方案资料与同行业案例' },
              ],
            })
            setIvProcessing(false)
            setIvOpen(false)
          }, 600)
          return s
        }
        return s + 1
      })
    }, 800)
  }

  const doGenerate = () => {
    setGenerating(true)
    setGenStep(0)
    const timer = setInterval(() => {
      setGenStep(s => {
        if (s >= genSteps.length - 1) {
          clearInterval(timer)
          setTimeout(() => {
            const pid = createProposal(lead.id, materials, template)
            setGenerating(false)
            setGenOpen(false)
            navigate({ name: 'proposal', id: pid })
          }, 600)
          return s
        }
        return s + 1
      })
    }, 800)
  }

  return (
    <div>
      <button onClick={() => navigate({ name: 'leads' })} className="mb-4 flex items-center gap-1 text-[13px] text-slate-500 hover:text-[#3370ff]">
        <ArrowLeft className="h-3.5 w-3.5" />返回线索列表
      </button>

      {/* 头部 */}
      <div className="rounded-xl border border-slate-200/60 bg-white shadow-sm p-4 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-xl font-bold text-slate-900">{lead.name}</h1>
              <StageBadge stage={lead.stage} />
            </div>
            <p className="mt-1.5 text-[13px] text-slate-500">
              {lead.industry} · {lead.scale} · 来源：{lead.source} · 介绍人：{lead.referrer} · 负责人：{lead.owner}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {lead.stage !== '已流失' && lead.stage !== '已交付' && (
              <Button className="bg-[#3370ff] hover:bg-[#2952cc]" onClick={() => advanceStage(lead.id)}>
                推进到「{STAGE_ORDER[idx + 1]}」
              </Button>
            )}
            <Button variant="outline" onClick={() => { setMaterials(['客户背景', '触点记录']); setGenOpen(true) }}>
              <FileStack className="h-4 w-4 mr-1.5" />一键生成三件套
            </Button>
            {lead.stage !== '已流失' && (
              <Button variant="ghost" className="text-slate-500 hover:text-rose-600" onClick={() => { setLostReason(''); setLostOpen(true) }}>
                <Ban className="h-4 w-4 mr-1" />标记流失
              </Button>
            )}
          </div>
        </div>

        {/* 阶段进度 */}
        <div className="mt-6 overflow-x-auto -mx-1 px-1">
        <div className="flex items-center min-w-[560px]">
          {STAGE_ORDER.map((s, i) => (
            <div key={s} className="flex flex-1 items-center last:flex-none">
              <div className="flex flex-col items-center">
                <div className={cn(
                  'flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-semibold',
                  lead.stage === '已流失' ? (i === 0 ? 'bg-rose-500 text-white' : 'bg-slate-100 text-slate-400')
                    : i <= idx ? 'bg-[#3370ff] text-white' : 'bg-slate-100 text-slate-400'
                )}>
                  {i < idx && lead.stage !== '已流失' ? <CheckCircle2 className="h-3.5 w-3.5" /> : i + 1}
                </div>
                <span className={cn('mt-1.5 text-[11px] whitespace-nowrap', i <= idx && lead.stage !== '已流失' ? 'font-medium text-[#3370ff]' : 'text-slate-400')}>{s}</span>
              </div>
              {i < STAGE_ORDER.length - 1 && (
                <div className={cn('mx-1 mb-5 h-0.5 flex-1 min-w-3 rounded', i < idx && lead.stage !== '已流失' ? 'bg-[#3370ff]' : 'bg-slate-200')} />
              )}
            </div>
          ))}
        </div>
        </div>
        {lead.stage === '已流失' && (
          <div className="mt-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-[13px] text-rose-700">
            已流失 · 原因：{lead.lostReason}（已沉淀为候选规则，待审阅）
          </div>
        )}
      </div>

      <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="order-2 lg:order-1 space-y-5 lg:col-span-2">
          {/* 客户背景 */}
          <div className="rounded-xl border border-slate-200/60 bg-white shadow-sm p-5">
            <h2 className="text-[15px] font-semibold text-slate-900">客户背景</h2>
            <p className="mt-2.5 text-[13px] leading-relaxed text-slate-600">{lead.background || '暂无背景资料'}</p>
            {lead.painPoints.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {lead.painPoints.map(p => (
                  <span key={p} className="rounded-md bg-amber-50 border border-amber-200 px-2 py-1 text-xs text-amber-700">{p}</span>
                ))}
              </div>
            )}
          </div>

          {/* 访谈记录：拜访录音转文字 */}
          <div className="rounded-xl border border-slate-200/60 bg-white shadow-sm p-5">
            <div className="flex items-center justify-between gap-2">
              <div>
                <h2 className="flex items-center gap-2 text-[15px] font-semibold text-slate-900">
                  <Mic className="h-4 w-4 text-[#3370ff]" />访谈记录
                  {lead.interviews.length > 0 && <span className="tnum rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-500">{lead.interviews.length}</span>}
                </h2>
                <p className="mt-1 text-xs text-slate-400">拜访录音自动转文字，AI 提炼需求 / 决策 / 待办，人工确认后沉淀</p>
              </div>
              <Button variant="outline" size="sm" className="h-8 shrink-0 text-xs" onClick={() => { setIvForm({ title: '', participants: '', date: '2026-09-12', audioFile: '现场录音.m4a' }); setIvOpen(true) }}>
                <FileAudio className="h-3 w-3 mr-1" />上传录音转写
              </Button>
            </div>

            <div className="mt-4 space-y-2.5">
              {lead.interviews.length === 0 && (
                <button onClick={() => setIvOpen(true)} className="w-full rounded-lg border border-dashed border-slate-300 py-7 text-center transition-colors hover:border-[#3370ff] hover:bg-blue-50/40">
                  <Mic className="mx-auto h-5 w-5 text-slate-300" />
                  <p className="mt-2 text-[13px] text-slate-400">拜访录音上传后自动转文字并提炼要点</p>
                  <p className="mt-0.5 text-xs text-[#3370ff]">上传第一段录音 →</p>
                </button>
              )}
              {lead.interviews.map(iv => {
                const expanded = ivExpanded[iv.id] ?? false
                return (
                  <div key={iv.id} className={cn('rounded-lg border', iv.status === '待确认' ? 'border-amber-200 bg-amber-50/40' : 'border-slate-200')}>
                    <button
                      onClick={() => setIvExpanded(prev => ({ ...prev, [iv.id]: !expanded }))}
                      className="flex w-full items-center gap-3 px-3.5 py-3 text-left"
                    >
                      <FileAudio className={cn('h-4 w-4 shrink-0', iv.status === '待确认' ? 'text-amber-500' : 'text-[#3370ff]')} />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-[13px] font-semibold text-slate-800">{iv.title}</span>
                          <span className={cn('rounded border px-1.5 py-0.5 text-[11px] font-medium',
                            iv.status === '待确认' ? 'border-amber-200 bg-white text-amber-600' : 'border-emerald-200 bg-white text-emerald-600')}>
                            {iv.status}
                          </span>
                        </div>
                        <p className="tnum mt-0.5 text-[11px] text-slate-400">{iv.date} · {iv.participants} · {iv.duration} · {iv.audioFile}</p>
                      </div>
                      <ChevronDown className={cn('h-4 w-4 shrink-0 text-slate-400 transition-transform', expanded && 'rotate-180')} />
                    </button>

                    {expanded && (
                      <div className="border-t border-slate-100 px-3.5 py-3.5 space-y-3">
                        {/* 转写原文 */}
                        <div className="rounded-lg bg-slate-50 p-3 space-y-2">
                          {iv.transcript.map((line, i) => {
                            const isCustomer = line.startsWith('客户') || line.startsWith('张主任')
                            return (
                              <p key={i} className="text-[12px] leading-relaxed">
                                <span className={cn('font-medium', isCustomer ? 'text-[#3370ff]' : 'text-slate-500')}>{line.split('：')[0]}：</span>
                                <span className="text-slate-700">{line.split('：').slice(1).join('：')}</span>
                              </p>
                            )
                          })}
                        </div>
                        {/* AI 摘要 */}
                        <p className="flex items-start gap-1.5 rounded-lg bg-blue-50/70 px-3 py-2 text-xs leading-relaxed text-slate-700">
                          <Sparkles className="mt-0.5 h-3 w-3 shrink-0 text-[#3370ff]" />{iv.summary}
                        </p>
                        {/* 提炼要点 */}
                        <div className="flex flex-wrap gap-1.5">
                          {iv.extracted.map((e, i) => (
                            <span key={i} className={cn('rounded border px-2 py-1 text-[11px]',
                              e.kind === '需求' ? 'border-blue-200 bg-blue-50 text-[#3370ff]'
                              : e.kind === '决策' ? 'border-indigo-200 bg-indigo-50 text-indigo-700'
                              : 'border-amber-200 bg-amber-50 text-amber-700')}>
                              {e.kind} · {e.text}
                            </span>
                          ))}
                        </div>
                        {/* 人在回路确认 */}
                        {iv.status === '待确认' && (
                          <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-white px-3 py-2.5">
                            <p className="flex-1 text-xs text-amber-700">AI 转写与提炼结果待确认，确认后进入过程记忆与触点记录</p>
                            <Button size="sm" className="h-7 bg-[#3370ff] text-xs hover:bg-[#2952cc]" onClick={() => confirmInterview(lead.id, iv.id, '确认')}>确认沉淀</Button>
                            <Button size="sm" variant="ghost" className="h-7 text-xs text-slate-500" onClick={() => confirmInterview(lead.id, iv.id, '放弃')}>放弃</Button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>

          {/* 触点记录 */}
          <div className="rounded-xl border border-slate-200/60 bg-white shadow-sm p-5">
            <div className="flex items-center justify-between">
              <h2 className="text-[15px] font-semibold text-slate-900">触点记录</h2>
              <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => setTpOpen(true)}>
                <Plus className="h-3 w-3 mr-1" />记录触点
              </Button>
            </div>
            <div className="mt-4 space-y-0">
              {lead.touchpoints.length === 0 && <p className="py-4 text-center text-[13px] text-slate-400">暂无触点记录，纪要将在录入后自动入库</p>}
              {lead.touchpoints.map((t, i) => (
                <div key={t.id} className="flex gap-3 pb-4 last:pb-0">
                  <div className="flex flex-col items-center pt-1">
                    <span className={cn('h-2 w-2 rounded-full', t.type === '打款记录' ? 'bg-emerald-500' : t.type === '线下拜访' ? 'bg-[#3370ff]' : 'bg-slate-300')} />
                    {i < lead.touchpoints.length - 1 && <span className="mt-1 w-px flex-1 bg-slate-200" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-[13px]">
                      <span className="font-medium text-slate-800">{t.type}</span>
                      <span className="tnum text-xs text-slate-400">{t.date}</span>
                    </div>
                    <p className="mt-0.5 text-[13px] leading-relaxed text-slate-600">{t.note}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* 过程记忆：需求/变更/决策上下文 */}
          <div className="rounded-xl border border-slate-200/60 bg-white shadow-sm p-5">
            <div className="flex items-center justify-between">
              <h2 className="text-[15px] font-semibold text-slate-900">过程记忆</h2>
              <span className="text-[11px] text-slate-400">先做了什么、为什么这么做，全程自动记录</span>
            </div>
            <div className="mt-4 space-y-0">
              {[...(PROCESS_MEMORIES[lead.id] ?? DEFAULT_PROCESS_MEMORY), ...(processExtras[lead.id] ?? [])].map((m, i, arr) => (
                <div key={i} className="flex gap-3 pb-4 last:pb-0">
                  <div className="flex flex-col items-center pt-1">
                    <span className={cn('h-2 w-2 rounded-full',
                      m.type === '决策' ? 'bg-indigo-500' : m.type === '变更' ? 'bg-amber-500' : m.type === '需求' ? 'bg-[#3370ff]' : 'bg-slate-300')} />
                    {i < arr.length - 1 && <span className="mt-1 w-px flex-1 bg-slate-200" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className={cn('rounded border px-1.5 py-0.5 text-[11px] font-medium',
                        m.type === '决策' ? 'border-indigo-200 bg-indigo-50 text-indigo-700'
                        : m.type === '变更' ? 'border-amber-200 bg-amber-50 text-amber-700'
                        : m.type === '需求' ? 'border-blue-200 bg-blue-50 text-[#3370ff]'
                        : 'border-slate-200 bg-slate-50 text-slate-500')}>{m.type}</span>
                      <span className="tnum text-xs text-slate-400">{m.time}</span>
                    </div>
                    <p className="mt-1 text-[13px] leading-relaxed text-slate-700">{m.text}</p>
                    {m.why && (
                      <p className="mt-1 rounded-md bg-indigo-50/60 border border-indigo-100 px-2.5 py-1.5 text-xs leading-relaxed text-indigo-700">
                        决策依据：{m.why}
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* 关联方案与合同 */}
          <div className="rounded-xl border border-slate-200/60 bg-white shadow-sm p-5">
            <h2 className="text-[15px] font-semibold text-slate-900">关联方案与合同</h2>
            <div className="mt-3 space-y-2">
              {linkedProposals.length === 0 && linkedContracts.length === 0 && (
                <p className="py-4 text-center text-[13px] text-slate-400">暂无关联，点击上方「一键生成三件套」开始</p>
              )}
              {linkedProposals.map(p => (
                <button key={p.id} onClick={() => navigate({ name: 'proposal', id: p.id })}
                  className="flex w-full items-center justify-between rounded-lg border border-slate-200 px-4 py-3 text-left transition-colors hover:border-[#3370ff]/50 hover:bg-blue-50/40">
                  <div className="flex items-center gap-2.5">
                    <FileStack className="h-4 w-4 text-[#3370ff]" />
                    <span className="text-[13px] font-medium text-slate-800">{p.title}</span>
                    <span className={cn('rounded border px-1.5 py-0.5 text-[11px]', p.status === '已确认' ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-amber-200 bg-amber-50 text-amber-700')}>{p.status} · v{p.version}</span>
                  </div>
                  <Money value={p.total} className="text-[13px] text-slate-700" />
                </button>
              ))}
              {linkedContracts.map(c => (
                <button key={c.id} onClick={() => navigate({ name: 'contracts' })}
                  className="flex w-full items-center justify-between rounded-lg border border-slate-200 px-4 py-3 text-left transition-colors hover:border-[#3370ff]/50 hover:bg-blue-50/40">
                  <div className="flex items-center gap-2.5">
                    <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                    <span className="tnum text-[13px] font-medium text-slate-800">{c.code}</span>
                    <span className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[11px] text-slate-600">{c.status}</span>
                  </div>
                  <Money value={c.amount} className="text-[13px] text-slate-700" />
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* 右侧：下一步建议（移动端置顶） */}
        <div className="order-1 lg:order-2 space-y-5">
          <div>
            <h2 className="mb-3 flex items-center gap-2 text-[15px] font-semibold text-slate-900">
              <CalendarClock className="h-4 w-4 text-[#3370ff]" />数字员工 · 下一步建议
            </h2>
            <AIReviewCard
              title="基于上下文与历史成功案例生成"
              body={lead.suggestion.text}
              basis={lead.suggestion.basis}
              status={lead.suggestion.status}
              reason={lead.suggestion.reason}
              onRespond={(a, r) => respondSuggestion(lead.id, a, r)}
            />
          </div>
          <div className="rounded-xl border border-slate-200/60 bg-white shadow-sm p-5">
            <h2 className="text-[15px] font-semibold text-slate-900">关键信息</h2>
            <dl className="mt-3 space-y-2.5 text-[13px]">
              {[
                ['企业规模', lead.scale], ['线索来源', lead.source], ['介绍人', lead.referrer],
                ['负责人', lead.owner], ['最近触点', lead.lastTouchAt], ['触点次数', `${lead.touchpoints.length} 次`],
              ].map(([k, v]) => (
                <div key={k} className="flex justify-between"><dt className="text-slate-400">{k}</dt><dd className="tnum font-medium text-slate-700">{v}</dd></div>
              ))}
            </dl>
          </div>

          {/* 项目组（团队协作） */}
          <div className="rounded-xl border border-slate-200/60 bg-white shadow-sm p-5">
            <div className="flex items-center justify-between">
              <h2 className="text-[15px] font-semibold text-slate-900">项目组</h2>
              <span className="text-[11px] text-slate-400">多人共同维护</span>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {lead.team.map(m => (
                <span key={m} className="flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 pl-1 pr-2.5 py-1 text-xs text-slate-700">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[#3370ff] text-[10px] font-semibold text-white">{m[0]}</span>
                  {m}
                  {m === lead.owner && <span className="text-[10px] text-slate-400">负责人</span>}
                </span>
              ))}
            </div>
            <div className="mt-3 flex gap-2">
              <Select value={memberToAdd} onValueChange={setMemberToAdd}>
                <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="选择成员" /></SelectTrigger>
                <SelectContent>
                  {TEAM_MEMBERS.filter(m => !lead.team.includes(m)).map(m => <SelectItem key={m} value={m}>{m}</SelectItem>)}
                </SelectContent>
              </Select>
              <Button size="sm" variant="outline" className="h-8 text-xs shrink-0" disabled={!memberToAdd}
                onClick={() => { addMember(lead.id, memberToAdd); setMemberToAdd('') }}>
                <UserPlus className="h-3 w-3 mr-1" />加入项目组
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* 标记流失 */}
      <Dialog open={lostOpen} onOpenChange={setLostOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>标记流失</DialogTitle>
            <DialogDescription>流失原因将自动沉淀为候选规则，用于后续预警。</DialogDescription>
          </DialogHeader>
          <Textarea value={lostReason} onChange={e => setLostReason(e.target.value)} rows={3} placeholder="例如：客户年度预算冻结，暂缓采购…" />
          <DialogFooter>
            <Button variant="outline" onClick={() => setLostOpen(false)}>取消</Button>
            <Button variant="destructive" disabled={!lostReason.trim()} onClick={() => { markLost(lead.id, lostReason.trim()); setLostOpen(false) }}>确认流失</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 记录触点 */}
      <Dialog open={tpOpen} onOpenChange={setTpOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>记录触点</DialogTitle>
            <DialogDescription>纪要将自动入库，供数字员工提炼规则。</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="flex gap-3">
              <Select value={tp.type} onValueChange={v => setTp(t => ({ ...t, type: v as Touchpoint['type'] }))}>
                <SelectTrigger className="w-[130px]"><SelectValue /></SelectTrigger>
                <SelectContent>{(['线下拜访', '线上拜访', '资料发送', '打款记录'] as const).map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent>
              </Select>
              <Input type="date" value={tp.date} onChange={e => setTp(t => ({ ...t, date: e.target.value }))} />
            </div>
            <Textarea value={tp.note} onChange={e => setTp(t => ({ ...t, note: e.target.value }))} rows={3} placeholder="纪要内容…" />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTpOpen(false)}>取消</Button>
            <Button className="bg-[#3370ff] hover:bg-[#2952cc]" disabled={!tp.note.trim()} onClick={() => { addTouchpoint(lead.id, tp); setTpOpen(false); setTp({ ...tp, note: '' }) }}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 上传录音转写 */}
      <Dialog open={ivOpen} onOpenChange={v => !ivProcessing && setIvOpen(v)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>上传录音转写</DialogTitle>
            <DialogDescription>拜访/电话录音自动转文字，AI 提炼需求、决策与待办，经你确认后沉淀为过程记忆。</DialogDescription>
          </DialogHeader>
          {!ivProcessing ? (
            <>
              <div className="space-y-3">
                <button
                  onClick={() => setIvForm(f => ({ ...f, audioFile: f.audioFile === '现场录音.m4a' ? '电话访谈_0912.mp3' : '现场录音.m4a' }))}
                  className="flex w-full items-center gap-3 rounded-lg border border-dashed border-slate-300 px-4 py-4 text-left transition-colors hover:border-[#3370ff] hover:bg-blue-50/40"
                >
                  <FileAudio className="h-5 w-5 text-[#3370ff]" />
                  <div>
                    <p className="text-[13px] font-medium text-slate-700">{ivForm.audioFile}</p>
                    <p className="text-[11px] text-slate-400">点击切换文件（演示环境模拟选择音频）</p>
                  </div>
                </button>
                <Input value={ivForm.title} onChange={e => setIvForm(f => ({ ...f, title: e.target.value }))} placeholder="访谈主题，如：首次上门需求调研" />
                <div className="flex gap-3">
                  <Input value={ivForm.participants} onChange={e => setIvForm(f => ({ ...f, participants: e.target.value }))} placeholder="参与人，如：客户信息科 · 赵鹏" />
                  <Input type="date" value={ivForm.date} onChange={e => setIvForm(f => ({ ...f, date: e.target.value }))} className="w-[150px] shrink-0" />
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setIvOpen(false)}>取消</Button>
                <Button className="bg-[#3370ff] hover:bg-[#2952cc]" onClick={doTranscribe}>
                  <Mic className="h-4 w-4 mr-1.5" />开始转写
                </Button>
              </DialogFooter>
            </>
          ) : (
            <div className="space-y-3 py-2">
              {ivSteps.map((s, i) => (
                <div key={s} className="flex items-center gap-2.5 text-[13px]">
                  {i < ivStep ? <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                    : i === ivStep ? <Loader2 className="h-4 w-4 animate-spin text-[#3370ff]" />
                    : <span className="h-4 w-4 rounded-full border border-slate-200" />}
                  <span className={i <= ivStep ? 'text-slate-700' : 'text-slate-400'}>{s}</span>
                </div>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* 生成三件套 */}
      <Dialog open={genOpen} onOpenChange={v => !generating && setGenOpen(v)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>一键生成三件套</DialogTitle>
            <DialogDescription>方案 PPT · 解决方案 Word · 报价 Excel，生成后需人工确认才成为正式版本。</DialogDescription>
          </DialogHeader>
          {!generating ? (
            <>
              <div>
                <p className="mb-2 text-xs text-slate-500">参考模板</p>
                <Select value={template} onValueChange={setTemplate}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{PROPOSAL_TEMPLATES.map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="mt-3">
                <p className="mb-2 text-xs text-slate-500">引用素材（自动带入客户背景）</p>
                <div className="space-y-2">
                  {materialOptions.map(m => (
                    <label key={m} className="flex items-center gap-2.5 rounded-md border border-slate-200 px-3 py-2 text-[13px] text-slate-700 hover:bg-slate-50 cursor-pointer">
                      <Checkbox
                        checked={materials.includes(m)}
                        onCheckedChange={v => setMaterials(prev => v ? [...prev, m] : prev.filter(x => x !== m))}
                      />
                      {m}
                    </label>
                  ))}
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setGenOpen(false)}>取消</Button>
                <Button className="bg-[#3370ff] hover:bg-[#2952cc]" disabled={materials.length === 0} onClick={doGenerate}>
                  <FileStack className="h-4 w-4 mr-1.5" />开始生成
                </Button>
              </DialogFooter>
            </>
          ) : (
            <div className="space-y-3 py-2">
              {genSteps.map((s, i) => (
                <div key={s} className="flex items-center gap-2.5 text-[13px]">
                  {i < genStep ? <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                    : i === genStep ? <Loader2 className="h-4 w-4 animate-spin text-[#3370ff]" />
                    : <span className="h-4 w-4 rounded-full border border-slate-200" />}
                  <span className={i <= genStep ? 'text-slate-700' : 'text-slate-400'}>{s}</span>
                </div>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
