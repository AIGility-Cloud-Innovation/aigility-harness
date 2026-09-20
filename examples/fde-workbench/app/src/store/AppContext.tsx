import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import type {
  Lead, Proposal, Contract, Channel, KnowledgeItem, Activity, ChatMessage, Page,
  LeadStage, Touchpoint, RuleConfig, Slide, WordSection, QuoteLine, Reminder, RoleDef,
  PurchaseContract, InterviewRecord, Delivery, ProductModule, ContractAllocation, ChannelCommission, Deployment,
  StandardSku, IntegrationPartner, Renewal, ImportBatch, ImportRow, ImportTarget, CaseRef, TeamTask,
} from '@/types'
import { STAGE_ORDER } from '@/types'
import {
  initialLeads, initialProposals, initialContracts, initialChannels,
  initialKnowledge, initialActivities, defaultRules, initialReminders, ROLES,
  initialPurchaseContracts, initialDeliveries, initialModules, initialAllocations, CONTRIBUTION_STAGES,
  initialChannelCommissions, initialDeployments, ACCOUNTS, type ProcessMemory,
  initialSkus, initialPartners, initialRenewals, initialTeamTasks,
} from '@/data/mock'
import { getHarnessCfg, streamFdeChat, type FdeChatBody } from '@/lib/harness'

const uid = () => Math.random().toString(36).slice(2, 9)
const now = () => {
  const d = new Date()
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function genSlides(lead: Lead): Slide[] {
  return [
    {
      title: `${lead.name}：现状与痛点`,
      bullets: lead.painPoints.length ? lead.painPoints : ['经验依赖人工，沉淀不足', '流程数据分散，难以追踪'],
    },
    {
      title: '解决思路：让系统越用越聪明',
      bullets: ['流程数据统一沉淀，形成可复用的经验规则', '智能推荐下一步动作与相似案例', '所有智能产出需人工确认后生效，全程留痕'],
    },
    {
      title: '建设方案与报价',
      bullets: ['基础一体机交付，开箱即用', '按需选配运维、私有化部署等模块', '详见报价清单，支持按规则灵活调整'],
    },
  ]
}

function genWord(lead: Lead): WordSection[] {
  return [
    { heading: '一、客户背景与需求分析', body: `${lead.background} 核心痛点：${lead.painPoints.join('；') || '经验沉淀与流程管理'}。` },
    { heading: '二、总体方案', body: '采用「底座 + 工作台」两层架构：底座沉淀客户、项目与触点记忆，驱动下一步建议与素材推荐；工作台覆盖线索、方案、合同全流程，所有智能产出经人工确认后生效。' },
    { heading: '三、实施与验收', body: '分两期交付：一期跑通核心流程，二期接入外部系统并深化预测能力。验收指标在合同中明确约定。' },
  ]
}

function computeQuote(rules: RuleConfig[]): { lines: QuoteLine[]; total: number } {
  const lines: QuoteLine[] = rules
    .filter(r => r.enabled)
    .map(r => ({ item: r.label, desc: r.desc, amount: r.price }))
  return { lines, total: lines.reduce((s, l) => s + l.amount, 0) }
}

interface Store {
  page: Page
  navigate: (p: Page) => void
  loggedIn: boolean
  login: (username: string, password: string) => boolean
  logout: () => void
  leads: Lead[]
  proposals: Proposal[]
  contracts: Contract[]
  channels: Channel[]
  knowledge: KnowledgeItem[]
  activities: Activity[]
  reminders: Reminder[]
  purchaseContracts: PurchaseContract[]
  completeReminder: (id: string) => void
  role: RoleDef
  setRole: (id: string) => void
  scopedLeads: Lead[]
  addMember: (leadId: string, name: string) => void
  chat: ChatMessage[]
  chatOpen: boolean
  setChatOpen: (v: boolean) => void
  advanceStage: (leadId: string) => void
  markLost: (leadId: string, reason: string) => void
  respondSuggestion: (leadId: string, action: 'adopted' | 'rejected' | 'modified', reason?: string) => void
  addLead: (data: Partial<Lead> & { reminderDays?: number }) => string
  addTouchpoint: (leadId: string, tp: Omit<Touchpoint, 'id'>) => void
  addInterview: (leadId: string, iv: Omit<InterviewRecord, 'id' | 'status'>) => void
  confirmInterview: (leadId: string, interviewId: string, action: '确认' | '放弃') => void
  processExtras: Record<string, ProcessMemory[]>
  createProposal: (leadId: string, materials: string[], template?: string) => string
  toggleRule: (proposalId: string, key: string, reason: string) => void
  confirmProposal: (proposalId: string) => void
  addProposalFeedback: (proposalId: string, author: string, content: string) => void
  respondFeedback: (proposalId: string, feedbackId: string, changeNote: string) => void
  advanceContract: (id: string) => void
  settlePayment: (contractId: string, paymentId: string) => void
  addContractRevision: (contractId: string, by: string, opinion: string, change: string) => void
  deliveries: Delivery[]
  completeMilestone: (deliveryId: string, milestoneId: string) => void
  toggleAcceptance: (deliveryId: string, index: number) => void
  addRevisit: (deliveryId: string, content: string, next?: string) => void
  modules: ProductModule[]
  toggleProposalModule: (proposalId: string, moduleId: string) => void
  addProductModule: (data: { name: string; kind: ProductModule['kind']; desc: string; capabilities: string[]; source: string }) => void
  allocations: ContractAllocation[]
  setContributionShare: (contractId: string, member: string, share: number) => void
  autoAllocate: (contractId: string) => void
  confirmAllocation: (contractId: string) => void
  channelCommissions: ChannelCommission[]
  registerChannelCommission: (contractId: string, channelId: string, rate: number) => void
  settleChannelCommission: (contractId: string) => void
  deployments: Deployment[]
  addVersionLog: (deploymentId: string, version: string, note: string) => void
  addReminder: (title: string, due: string, leadId?: string) => void
  /** 团队任务（可分派给成员的人工任务） */
  teamTasks: TeamTask[]
  addTeamTask: (data: { title: string; detail?: string; assignee: string; due: string; priority: TeamTask['priority']; page?: Page; source?: TeamTask['source'] }) => void
  advanceTeamTask: (id: string) => void
  deleteTeamTask: (id: string) => void
  depositModule: (deploymentId: string, name: string, desc: string) => void
  /** 标准产品 SKU（标准化售卖 + 订阅捆绑） */
  skus: StandardSku[]
  toggleProposalSku: (proposalId: string, skuId: string) => void
  /** 关联/移除方案的案例参考（生成上下文） */
  toggleProposalCase: (proposalId: string, ref: CaseRef) => void
  /** 集成服务商（交付伙伴） */
  partners: IntegrationPartner[]
  settlePartner: (partnerId: string) => void
  /** 订阅续费台账（长期捆绑） */
  renewals: Renewal[]
  followRenewal: (id: string) => void
  confirmRenewal: (id: string) => void
  /** 数据导入：解析 → 人工审阅 → 审批录入，全程审计留痕 */
  importBatches: ImportBatch[]
  createImportBatch: (target: ImportTarget, fileName: string, rows: ImportRow[]) => string
  reviewImportRow: (batchId: string, rowId: string, action: '已确认' | '已拒绝' | '待审', editedFields?: Record<string, string>) => void
  commitImportBatch: (batchId: string) => void
  reviewKnowledge: (id: string, action: '已采纳' | '已拒绝', reason?: string) => void
  sendChat: (text: string) => void
  setChatActionStatus: (msgId: string, status: 'pending' | 'done' | 'cancelled') => void
  addActivity: (text: string, source: string, page: Activity['page'], refId?: string) => void
}

const Ctx = createContext<Store | null>(null)
export const useStore = () => useContext(Ctx)!

function mockReply(text: string, leads: Lead[], knowledge: KnowledgeItem[]): string {
  const t = text.toLowerCase()
  const inFlight = leads.filter(l => l.stage !== '已流失' && l.stage !== '已交付')
  if (t.includes('线索') || t.includes('pipeline') || t.includes('管道')) {
    return `当前在途线索 ${inFlight.length} 条：${inFlight.map(l => `${l.name}（${l.stage}）`).join('、')}。按历史经验，建议优先推进「${inFlight[0]?.name ?? '暂无'}」——${inFlight[0]?.suggestion.text ?? ''}`
  }
  if (t.includes('宁夏') || t.includes('电信')) {
    return '宁夏电信联合项目（500 万，渠道分佣 8%）已发出报价 3 天未收到反馈。历史规则显示：渠道单超过 3 天无反馈时主动跟进可显著提升转化率。建议明天上午联系集客部张主任确认立项评审时间。'
  }
  if (t.includes('南方') || t.includes('电网')) {
    return '南方电网方案《南方电网智能赋能解决方案》已生成（待审阅）。基于专家批注规则：央企首次汇报建议先讲资质背书（省级投资、行业大会报道、长庆灯塔案例），建立信任后再展开技术细节。'
  }
  if (t.includes('规则') || t.includes('沉淀') || t.includes('知识')) {
    const pending = knowledge.filter(k => k.status === '待审阅')
    return `知识库当前：经验规则 128 条、能力 24 个、资料 87 份。本周新增 9 条，其中 ${pending.length} 条待你审阅：${pending.map(k => `「${k.title}」`).join('、')}。确认后才会入库生效。`
  }
  if (t.includes('报价') || t.includes('价格')) {
    return '报价由规则引擎约束生成：基础一体机 ¥20 万为必选；运维（¥2 万/年）近 12 单 9 单启用、私有化部署（+¥5 万）央国企必选、大模型模块（+¥8 万）、工艺机理图谱（+¥6 万）按需勾选。改规则不影响已出报价单。'
  }
  if (t.includes('合同') || t.includes('回款') || t.includes('分佣')) {
    return '当前合同 4 份：待签约 1 份（宁夏电信，500 万）、法务审核 1 份（可孚医疗，33 万）、已回款 2 份（合计 54 万）。渠道分佣在途 ¥40 万（宁夏电信，回款后自动计入台账）。'
  }
  return `我基于当前工作台数据回答：在途线索 ${inFlight.length} 条，待审阅方案 ${'1'} 份，待审阅沉淀 ${knowledge.filter(k => k.status === '待审阅').length} 条。你可以问我「线索进展」「报价规则」「合同回款」「知识沉淀」，或让我为某个客户生成下一步建议。`
}

/** 按客户名模糊匹配线索（取名称首段做关键词） */
function findLeadByText(text: string, leads: Lead[]): Lead | undefined {
  return leads.find(l => {
    const kw = l.name.split(/[ ·（(]/)[0]
    return kw.length >= 2 && text.includes(kw)
  })
}

/** 数字员工指令解析：返回文本 + 数据卡片（在线查）+ 行动卡片（确认后执行） */
function parseCommand(text: string, leads: Lead[], knowledge: KnowledgeItem[]): Pick<ChatMessage, 'text' | 'card' | 'action'> {
  const t = text.toLowerCase()
  const lead = findLeadByText(text, leads)

  // 执行类：推进阶段
  if ((t.includes('推进') || t.includes('下一阶段') || t.includes('晋级')) && lead) {
    if (lead.stage === '已交付' || lead.stage === '已流失') {
      return { text: `「${lead.name}」当前已是${lead.stage}，无需推进。` }
    }
    const next = STAGE_ORDER[STAGE_ORDER.indexOf(lead.stage) + 1]
    return {
      text: `收到。准备把「${lead.name}」从「${lead.stage}」推进到「${next}」，请确认：`,
      action: { intent: 'advanceStage', label: '推进线索阶段', detail: `${lead.name}：${lead.stage} → ${next}`, payload: { leadId: lead.id }, status: 'pending' },
    }
  }
  // 执行类：创建提醒
  if ((t.includes('提醒') || t.includes('回访') || t.includes('跟进') && lead) && lead) {
    return {
      text: `收到。准备为「${lead.name}」创建跟进提醒，到期后会在通知中心提示，请确认：`,
      action: { intent: 'reminder', label: '创建跟进提醒', detail: `主动跟进「${lead.name}」（明天到期）`, payload: { leadId: lead.id, title: `主动跟进「${lead.name}」` }, status: 'pending' },
    }
  }
  // 执行类：生成方案
  if ((t.includes('生成方案') || t.includes('出方案') || t.includes('做方案')) && lead) {
    return {
      text: `收到。准备基于「${lead.name}」的客户背景与触点记录生成方案三件套（PPT/Word/报价单），生成后需你审阅确认，请确认：`,
      action: { intent: 'proposal', label: '生成方案三件套', detail: `为「${lead.name}」生成方案（待审阅）`, payload: { leadId: lead.id }, status: 'pending' },
    }
  }
  // 查询类
  if (t.includes('续费') || t.includes('捆绑') || t.includes('订阅')) {
    return { text: '订阅续费台账实时数据如下（记忆容量 / Token / 私有化授权的到期续费与增购），点击可直达处理：', card: { kind: 'renewals' } }
  }
  if (t.includes('标准产品') || t.includes('sku') || t.includes('一体机') || t.includes('容量') || t.includes('token') || t.includes('积分') || t.includes('私有化')) {
    return { text: '标准产品 SKU 如下：方案报价可直接积木式组装，订阅类产品自带长期捆绑属性：', card: { kind: 'skus' } }
  }
  if (t.includes('部署') || t.includes('站点') || t.includes('域名') || t.includes('版本')) {
    return { text: '部署台账实时数据如下，版本日志与域名到期一目了然：', card: { kind: 'deployments' } }
  }
  if (t.includes('提成') || t.includes('绩效') || t.includes('奖金') || t.includes('贡献')) {
    return { text: '绩效提成实时汇总如下（按已登记分配计算）：', card: { kind: 'performance' } }
  }
  if (t.includes('待办') || t.includes('任务') || t.includes('该做什么')) {
    return { text: '当前需要你拍板的事项汇总如下，点击可直达处理：', card: { kind: 'tasks' } }
  }
  if (t.includes('合同') || t.includes('回款') || t.includes('分佣')) {
    return { text: mockReply(text, leads, knowledge), card: { kind: 'contracts' } }
  }
  if (t.includes('线索') || t.includes('进展') || t.includes('pipeline') || t.includes('管道')) {
    return { text: mockReply(text, leads, knowledge), card: { kind: 'leads' } }
  }
  return { text: mockReply(text, leads, knowledge) }
}

/** 工作台实时数据快照：注入 fde-assistant 的业务上下文（服务端拼进 system prompt） */
function buildBusinessContext(input: {
  leads: Lead[]
  proposals: Proposal[]
  contracts: Contract[]
  deliveries: Delivery[]
  renewals: Renewal[]
  teamTasks: TeamTask[]
}): string {
  const lines: string[] = []
  const inFlight = input.leads.filter(l => l.stage !== '已流失' && l.stage !== '已交付')
  lines.push(`【线索】在途 ${inFlight.length} 条 / 全部 ${input.leads.length} 条`)
  input.leads.slice(0, 12).forEach(l => {
    lines.push(`- ${l.name}（${l.industry}·${l.scale}）：阶段=${l.stage}，负责人=${l.owner}，最近触点=${l.lastTouchAt}`)
  })
  lines.push(`【方案】${input.proposals.length} 份`)
  input.proposals.slice(0, 8).forEach(p => {
    lines.push(`- ${p.title}：v${p.version}·${p.status}·报价 ¥${p.total.toLocaleString()}`)
  })
  lines.push(`【合同】${input.contracts.length} 份`)
  input.contracts.slice(0, 8).forEach(c => {
    lines.push(`- ${c.code} ${c.customer}：¥${c.amount.toLocaleString()}，状态=${c.status}`)
  })
  lines.push(`【交付】${input.deliveries.length} 项`)
  input.deliveries.slice(0, 6).forEach(d => {
    lines.push(`- ${d.customer} ${d.name}：${d.status}`)
  })
  const dueRenewals = input.renewals.filter(r => r.status !== '已续费' && r.status !== '已流失')
  lines.push(`【续费】待处理 ${dueRenewals.length} 条：${dueRenewals.slice(0, 5).map(r => `${r.customer}·${r.item}(${r.dueDate})`).join('；') || '无'}`)
  const openTasks = input.teamTasks.filter(t => t.status !== '已完成')
  lines.push(`【待办任务】${openTasks.length} 条：${openTasks.slice(0, 5).map(t => `${t.title}(${t.assignee}·${t.status})`).join('；') || '无'}`)
  return lines.join('\n').slice(0, 8000)
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [page, setPage] = useState<Page>({ name: 'dashboard' })
  const [leads, setLeads] = useState<Lead[]>(initialLeads)
  const [proposals, setProposals] = useState<Proposal[]>(initialProposals)
  const [contracts, setContracts] = useState<Contract[]>(initialContracts)
  const [channels, setChannels] = useState<Channel[]>(initialChannels)
  const [knowledge, setKnowledge] = useState<KnowledgeItem[]>(initialKnowledge)
  const [activities, setActivities] = useState<Activity[]>(initialActivities)
  const [reminders, setReminders] = useState<Reminder[]>(initialReminders)
  const [purchaseContracts] = useState<PurchaseContract[]>(initialPurchaseContracts)
  const [deliveries, setDeliveries] = useState<Delivery[]>(initialDeliveries)
  const [modules, setModules] = useState<ProductModule[]>(initialModules)
  const [allocations, setAllocations] = useState<ContractAllocation[]>(initialAllocations)
  const [channelCommissions, setChannelCommissions] = useState<ChannelCommission[]>(initialChannelCommissions)
  const [deployments, setDeployments] = useState<Deployment[]>(initialDeployments)
  const [skus] = useState<StandardSku[]>(initialSkus)
  const [partners, setPartners] = useState<IntegrationPartner[]>(initialPartners)
  const [renewals, setRenewals] = useState<Renewal[]>(initialRenewals)
  const [importBatches, setImportBatches] = useState<ImportBatch[]>([])
  const [loggedIn, setLoggedIn] = useState(false)
  const [roleId, setRoleId] = useState('admin')
  const [username, setUsername] = useState('')
  /** 数字员工会话 ID（每次加载一个，供服务端 TiMEM 记忆与会话记忆隔离） */
  const [chatSession] = useState(uid)
  const role = ROLES.find(r => r.id === roleId) ?? ROLES[0]

  const login: Store['login'] = (username, password) => {
    const acc = ACCOUNTS.find(a => a.username === username.trim() && a.password === password)
    if (!acc) return false
    setRoleId(acc.roleId)
    setUsername(acc.username)
    setLoggedIn(true)
    const r = ROLES.find(x => x.id === acc.roleId)
    toast.success(`欢迎回来，${r?.name}（${r?.title}）`)
    return true
  }
  const logout: Store['logout'] = () => {
    setLoggedIn(false)
    setPage({ name: 'dashboard' })
    toast.success('已退出登录')
  }
  const setRole = (id: string) => {
    setRoleId(id)
    const r = ROLES.find(x => x.id === id)
    if (r) toast.success(`已切换视角：${r.name}（${r.title}）`)
  }
  const [chat, setChat] = useState<ChatMessage[]>([
    { id: uid(), role: 'assistant', text: '你好，我是 TiMEM 数字员工。我基于工作台沉淀的经验规则为你服务：可以帮你查线索进展、出下一步建议、解释报价规则、盘点知识沉淀。所有我的产出都需要你确认后才会生效。' },
  ])
  const [chatOpen, setChatOpen] = useState(false)
  const [processExtras, setProcessExtras] = useState<Record<string, ProcessMemory[]>>({})

  const navigate = (p: Page) => { setPage(p); window.scrollTo({ top: 0 }) }

  const addActivity = (text: string, source: string, pg: Activity['page'], refId?: string) =>
    setActivities(prev => [{ id: uid(), time: now(), text, source, page: pg, refId }, ...prev].slice(0, 30))

  const advanceStage = (leadId: string) => {
    setLeads(prev => prev.map(l => {
      if (l.id !== leadId) return l
      const i = STAGE_ORDER.indexOf(l.stage)
      if (l.stage === '已流失' || i >= STAGE_ORDER.length - 1) return l
      const next = STAGE_ORDER[i + 1]
      addActivity(`「${l.name}」阶段推进：${l.stage} → ${next}`, '余宣庆', 'lead', l.id)
      toast.success(`已推进至「${next}」`)
      return { ...l, stage: next as LeadStage, lastTouchAt: now().slice(0, 5) }
    }))
  }

  const markLost = (leadId: string, reason: string) => {
    setLeads(prev => prev.map(l => l.id === leadId ? { ...l, stage: '已流失', lostReason: reason } : l))
    const lead = leads.find(l => l.id === leadId)
    setKnowledge(prev => [{
      id: uid(), kind: 'rule', title: `流失原因：${reason.slice(0, 16)}${reason.length > 16 ? '…' : ''}`,
      content: `线索「${lead?.name}」流失原因：${reason}。系统已将其转为候选经验规则，审阅后可用于后续预警。`,
      source: `流失登记：${lead?.name}`, date: now().slice(0, 5), status: '待审阅', usedCount: 0, impactCount: 0, tags: ['流失预警'],
    }, ...prev])
    addActivity(`「${lead?.name}」标记流失，原因已沉淀为候选规则`, '系统', 'lead', leadId)
    toast.success('已标记流失，原因已沉淀为候选规则，待审阅')
  }

  const respondSuggestion: Store['respondSuggestion'] = (leadId, action, reason) => {
    setLeads(prev => prev.map(l => l.id === leadId ? { ...l, suggestion: { ...l.suggestion, status: action, reason } } : l))
    const label = action === 'adopted' ? '已采纳' : action === 'modified' ? '已修改采纳' : '已拒绝'
    addActivity(`下一步建议${label}（${leads.find(l => l.id === leadId)?.name}）`, '人在回路', 'lead', leadId)
    toast.success(`建议${label}，轨迹已回流沉淀`)
  }

  const completeReminder: Store['completeReminder'] = (id) => {
    setReminders(prev => prev.map(r => r.id === id ? { ...r, done: true } : r))
    toast.success('提醒已完成')
  }

  const addMember: Store['addMember'] = (leadId, name) => {
    setLeads(prev => prev.map(l => l.id === leadId && !l.team.includes(name) ? { ...l, team: [...l.team, name] } : l))
    addActivity(`「${leads.find(l => l.id === leadId)?.name}」项目组新增成员：${name}`, role.name, 'lead', leadId)
    toast.success(`${name} 已加入项目组`)
  }

  const addLead: Store['addLead'] = (data) => {
    const id = `L${uid().toUpperCase()}`
    const lead: Lead = {
      id, name: data.name ?? '未命名客户', industry: data.industry ?? '其他', scale: data.scale ?? '中小',
      source: data.source ?? '电话', referrer: data.referrer ?? '—', stage: '新线索',
      owner: role.name, team: [role.name], lastTouchAt: now().slice(0, 5), background: data.background ?? '',
      painPoints: data.painPoints ?? [],
      suggestion: { text: '新线索已录入。建议 24 小时内完成首次联系，明确决策链与预算窗口。', basis: '依据：新线索 24 小时内首联的转化率最高', status: 'pending' },
      touchpoints: [], interviews: [],
    }
    setLeads(prev => [lead, ...prev])
    const days = data.reminderDays ?? 1
    const due = days <= 1 ? '明天' : days <= 3 ? '3 天后' : '1 周后'
    setReminders(prev => [{
      id: uid(), title: `「${lead.name}」新线索跟进：完成首次联系，明确决策链与预算窗口`,
      leadId: id, due, done: false, auto: true,
    }, ...prev])
    addActivity(`新线索录入：「${lead.name}」（来源：${lead.source}），已自动创建 ${due}跟进提醒`, role.name, 'lead', id)
    toast.success(`线索已录入，已自动创建「${due}」跟进提醒`)
    return id
  }

  const addTouchpoint: Store['addTouchpoint'] = (leadId, tp) => {
    setLeads(prev => prev.map(l => l.id === leadId ? { ...l, touchpoints: [{ ...tp, id: uid() }, ...l.touchpoints], lastTouchAt: tp.date } : l))
    addActivity(`「${leads.find(l => l.id === leadId)?.name}」新增触点：${tp.type}`, role.name, 'lead', leadId)
    toast.success('触点已记录，纪要自动入库')
  }

  const addInterview: Store['addInterview'] = (leadId, iv) => {
    setLeads(prev => prev.map(l => l.id === leadId ? { ...l, interviews: [{ ...iv, id: uid(), status: '待确认' as const }, ...l.interviews] } : l))
    const lead = leads.find(l => l.id === leadId)
    addActivity(`「${lead?.name}」访谈录音转写完成：${iv.title}，AI 已提炼 ${iv.extracted.length} 条要点，待确认`, '数字员工', 'lead', leadId)
    toast.success('转写与提炼完成，请确认识别结果')
  }

  const confirmInterview: Store['confirmInterview'] = (leadId, interviewId, action) => {
    const lead = leads.find(l => l.id === leadId)
    const iv = lead?.interviews.find(x => x.id === interviewId)
    if (!lead || !iv) return
    if (action === '放弃') {
      setLeads(prev => prev.map(l => l.id === leadId ? { ...l, interviews: l.interviews.filter(x => x.id !== interviewId) } : l))
      toast.success('已放弃该转写结果')
      return
    }
    setLeads(prev => prev.map(l => l.id === leadId ? {
      ...l,
      interviews: l.interviews.map(x => x.id === interviewId ? { ...x, status: '已沉淀' as const } : x),
      touchpoints: [{ id: uid(), date: iv.date, type: '访谈记录' as const, note: `访谈「${iv.title}」：${iv.summary}` }, ...l.touchpoints],
    } : l))
    setProcessExtras(prev => ({
      ...prev,
      [leadId]: [...(prev[leadId] ?? []), { time: iv.date.slice(5), type: '需求' as const, text: `访谈「${iv.title}」确认入库：${iv.extracted.map(e => e.text).join('；')}`, why: '录音转文字后经人工确认，提炼要点进入过程记忆' }],
    }))
    addActivity(`「${lead.name}」访谈「${iv.title}」已确认沉淀：要点进入过程记忆与触点`, '人在回路', 'lead', leadId)
    toast.success('访谈已沉淀：要点进入过程记忆，纪要进入触点记录')
  }

  const createProposal: Store['createProposal'] = (leadId, materials, template) => {
    const lead = leads.find(l => l.id === leadId)
    const isIndustrial = lead ? ['石油化工', '能源电力', '电信运营商'].includes(lead.industry) : false
    const rules = defaultRules(true, isIndustrial || lead?.scale === '央企')
    const { lines, total } = computeQuote(rules)
    const p: Proposal = {
      id: `P${uid().toUpperCase()}`, leadId, title: `${lead?.name ?? '客户'}解决方案`,
      createdAt: now(), status: '待审阅', version: 1,
      versions: [{ version: 1, time: now(), note: '初版生成', total }],
      feedbacks: [],
      modules: ['M01'],
      skus: [],
      caseRefs: [],
      materials, template: template ?? '通用方案模板', rules, slides: genSlides(lead!), word: genWord(lead!), quote: lines, total,
    }
    setProposals(prev => [p, ...prev])
    if (lead && ['新线索', '已联系', '拜访中'].includes(lead.stage)) {
      setLeads(prev => prev.map(l => l.id === leadId ? { ...l, stage: '方案中' } : l))
    }
    addActivity(`《${p.title}》三件套已生成（方案 PPT / 解决方案 Word / 报价 Excel），等待审阅`, '数字员工', 'proposal', p.id)
    return p.id
  }

  const toggleRule: Store['toggleRule'] = (proposalId, key, reason) => {
    setProposals(prev => prev.map(p => {
      if (p.id !== proposalId) return p
      const rules = p.rules.map(r => r.key === key ? { ...r, enabled: !r.enabled, reason } : r)
      const { lines, total } = computeQuote(rules)
      const version = p.version + 1
      return {
        ...p, rules, quote: lines, total, version,
        versions: [...p.versions, { version, time: now(), note: reason || '调整报价配置', total }],
      }
    }))
    toast.success('配置已更新并生成新版本（历史版本不受影响）')
  }

  const addProposalFeedback: Store['addProposalFeedback'] = (proposalId, author, content) => {
    const p = proposals.find(x => x.id === proposalId)
    setProposals(prev => prev.map(x => x.id === proposalId ? {
      ...x,
      feedbacks: [...x.feedbacks, { id: uid(), version: x.version, author, at: now().slice(0, 5), content, status: '待处理' as const }],
    } : x))
    addActivity(`《${p?.title}》收到甲方反馈（v${p?.version}）：${content.slice(0, 24)}${content.length > 24 ? '…' : ''}`, role.name, 'proposal', proposalId)
    toast.success('甲方反馈已录入，待响应后生成新版本')
  }

  const respondFeedback: Store['respondFeedback'] = (proposalId, feedbackId, changeNote) => {
    const p = proposals.find(x => x.id === proposalId)
    const fb = p?.feedbacks.find(f => f.id === feedbackId)
    setProposals(prev => prev.map(x => {
      if (x.id !== proposalId) return x
      const version = x.version + 1
      return {
        ...x,
        version,
        versions: [...x.versions, { version, time: now(), note: `响应甲方意见：${changeNote}`, opinion: fb?.content, total: x.total }],
        feedbacks: x.feedbacks.map(f => f.id === feedbackId ? { ...f, status: '已响应' as const } : f),
      }
    }))
    addActivity(`《${p?.title}》响应甲方意见，生成 v${(p?.version ?? 0) + 1}：${changeNote}`, role.name, 'proposal', proposalId)
    toast.success(`已生成 v${(p?.version ?? 0) + 1}，反馈标记为已响应`)
  }

  const addContractRevision: Store['addContractRevision'] = (contractId, by, opinion, change) => {
    const c = contracts.find(x => x.id === contractId)
    setContracts(prev => prev.map(x => {
      if (x.id !== contractId) return x
      const version = (x.revisions[x.revisions.length - 1]?.version ?? 0) + 1
      return { ...x, revisions: [...x.revisions, { id: uid(), version, at: now().slice(0, 5), by, opinion, change }] }
    }))
    addActivity(`合同 ${c?.code} 第 ${(c?.revisions.length ?? 0) + 1} 轮修订：${change.slice(0, 24)}${change.length > 24 ? '…' : ''}`, role.name, 'contracts', contractId)
    toast.success('修订已登记，合同版本留痕')
  }

  const completeMilestone: Store['completeMilestone'] = (deliveryId, milestoneId) => {
    const d = deliveries.find(x => x.id === deliveryId)
    const m = d?.milestones.find(x => x.id === milestoneId)
    if (!d || !m || m.status !== '进行中') return
    setDeliveries(prev => prev.map(x => {
      if (x.id !== deliveryId) return x
      const idx = x.milestones.findIndex(y => y.id === milestoneId)
      const milestones = x.milestones.map((y, i) =>
        y.id === milestoneId ? { ...y, status: '已完成' as const, date: y.date === '待定' ? now().slice(0, 5) : y.date }
          : i === idx + 1 && y.status === '未开始' ? { ...y, status: '进行中' as const } : y)
      const allDone = milestones.every(y => y.status === '已完成')
      return { ...x, milestones, status: allDone ? '已验收' as const : x.status }
    }))
    addActivity(`「${d.customer}」交付里程碑「${m.name}」已完成`, role.name, 'contracts', d.contractId)
    toast.success(`里程碑「${m.name}」已完成${m.name === '验收' ? '，项目进入已验收' : ''}`)
  }

  const toggleAcceptance: Store['toggleAcceptance'] = (deliveryId, index) => {
    setDeliveries(prev => prev.map(x => x.id === deliveryId
      ? { ...x, acceptance: x.acceptance.map((a, i) => i === index ? { ...a, done: !a.done } : a) } : x))
  }

  const addRevisit: Store['addRevisit'] = (deliveryId, content, next) => {
    const d = deliveries.find(x => x.id === deliveryId)
    setDeliveries(prev => prev.map(x => x.id === deliveryId
      ? { ...x, status: '已回访' as const, revisits: [{ id: uid(), date: now().slice(0, 5), content, next }, ...x.revisits] } : x))
    addActivity(`「${d?.customer}」已回访：${content.slice(0, 24)}${content.length > 24 ? '…' : ''}`, role.name, 'contracts', d?.contractId)
    toast.success('回访记录已登记，项目状态更新为已回访')
  }

  const toggleProposalModule: Store['toggleProposalModule'] = (proposalId, moduleId) => {
    const p = proposals.find(x => x.id === proposalId)
    const m = modules.find(x => x.id === moduleId)
    if (!p || !m) return
    const has = p.modules.includes(moduleId)
    setProposals(prev => prev.map(x => x.id === proposalId
      ? { ...x, modules: has ? x.modules.filter(id => id !== moduleId) : [...x.modules, moduleId] } : x))
    if (!has) {
      setModules(prev => prev.map(x => x.id === moduleId && !x.usedBy.includes(p.title)
        ? { ...x, usedBy: [...x.usedBy, p.title.replace('解决方案', '')] } : x))
      addActivity(`《${p.title}》采纳产品模块「${m.name}」，积木式组装进方案`, '人在回路', 'proposal', proposalId)
      toast.success(`已组装模块「${m.name}」`)
    } else {
      toast.success(`已移除模块「${m.name}」`)
    }
  }

  const addProductModule: Store['addProductModule'] = (data) => {
    setModules(prev => [...prev, {
      id: `M${uid().toUpperCase()}`, ...data, maturity: '沉淀中', price: null, usedBy: [],
    }])
    addActivity(`新产品模块「${data.name}」登记入库，成熟度：沉淀中`, role.name, 'proposal')
    toast.success('模块已登记入库，后续方案可直接组装')
  }

  const setContributionShare: Store['setContributionShare'] = (contractId, member, share) => {
    setAllocations(prev => prev.map(a => a.contractId === contractId
      ? { ...a, status: '协商中' as const, shares: a.shares.map(s => s.member === member ? { ...s, share } : s) } : a))
  }

  const autoAllocate: Store['autoAllocate'] = (contractId) => {
    const a = allocations.find(x => x.contractId === contractId)
    if (!a) return
    const scores = a.shares.map(s => s.stages.reduce((sum, st) => sum + (CONTRIBUTION_STAGES.find(x => x.name === st)?.weight ?? 0), 0))
    const total = scores.reduce((x, y) => x + y, 0) || 1
    const raw = scores.map(sc => Math.round(sc / total * 100))
    // 尾差补给份额最大者，保证合计 100
    const diff = 100 - raw.reduce((x, y) => x + y, 0)
    const maxIdx = raw.indexOf(Math.max(...raw))
    raw[maxIdx] += diff
    setAllocations(prev => prev.map(x => x.contractId === contractId
      ? { ...x, shares: x.shares.map((s, i) => ({ ...s, share: raw[i] })) } : x))
    addActivity(`合同 ${contracts.find(c => c.id === contractId)?.code} 贡献度按环节权重智能分配`, '数字员工', 'performance', contractId)
    toast.success('已按参与环节权重给出建议分配，可继续协商调整')
  }

  const confirmAllocation: Store['confirmAllocation'] = (contractId) => {
    const a = allocations.find(x => x.contractId === contractId)
    if (!a) return
    const sum = a.shares.reduce((s, x) => s + x.share, 0)
    if (sum !== 100) {
      toast.error(`分配合计为 ${sum}%，需调整到 100% 才能确认`)
      return
    }
    setAllocations(prev => prev.map(x => x.contractId === contractId ? { ...x, status: '已确认' as const } : x))
    addActivity(`合同 ${contracts.find(c => c.id === contractId)?.code} 提成分配已确认锁定：${a.shares.map(s => `${s.member} ${s.share}%`).join('、')}`, '人在回路', 'performance', contractId)
    toast.success('分配已确认锁定，计入个人提成')
  }

  const registerChannelCommission: Store['registerChannelCommission'] = (contractId, channelId, rate) => {
    const c = contracts.find(x => x.id === contractId)
    const ch = channels.find(x => x.id === channelId)
    if (!c || !ch) return
    setChannelCommissions(prev => {
      const existing = prev.find(x => x.contractId === contractId)
      if (existing) return prev.map(x => x.contractId === contractId ? { ...x, channelId, rate, status: '待结算' as const, settledAt: undefined } : x)
      return [...prev, { contractId, channelId, rate, status: '待结算' as const }]
    })
    addActivity(`合同 ${c.code} 登记渠道分佣：${ch.name} ${(rate * 100).toFixed(0)}%，预计 ¥${Math.round(c.amount * rate).toLocaleString()}`, role.name, 'contracts', contractId)
    toast.success(`渠道分佣已登记：${ch.name} · ${(rate * 100).toFixed(0)}%`)
  }

  const settleChannelCommission: Store['settleChannelCommission'] = (contractId) => {
    const c = contracts.find(x => x.id === contractId)
    const cc = channelCommissions.find(x => x.contractId === contractId)
    const ch = channels.find(x => x.id === cc?.channelId)
    setChannelCommissions(prev => prev.map(x => x.contractId === contractId ? { ...x, status: '已结算' as const, settledAt: now().slice(0, 5) } : x))
    addActivity(`合同 ${c?.code} 渠道分佣已结算：${ch?.name} ¥${c && cc ? Math.round(c.amount * cc.rate).toLocaleString() : ''}`, role.name, 'contracts', contractId)
    toast.success('渠道分佣已结算')
  }

  const addVersionLog: Store['addVersionLog'] = (deploymentId, version, note) => {
    const d = deployments.find(x => x.id === deploymentId)
    if (!d) return
    setDeployments(prev => prev.map(x => x.id === deploymentId
      ? { ...x, currentVersion: version, updatedAt: now().slice(0, 5), logs: [{ version, date: now().slice(0, 5), by: role.name, note }, ...x.logs] } : x))
    addActivity(`「${d.site}」发布 ${version}：${note.slice(0, 26)}${note.length > 26 ? '…' : ''}`, role.name, 'deployments', d.leadId)
    toast.success(`${version} 已登记到版本日志`)
  }

  const addReminder: Store['addReminder'] = (title, due, leadId) => {
    setReminders(prev => [{ id: uid(), title, due, leadId, done: false, auto: true }, ...prev])
    toast.success('已转为跟进提醒，通知中心可见')
  }

  /* ---------- 团队任务 ---------- */
  const [teamTasks, setTeamTasks] = useState<TeamTask[]>(initialTeamTasks)

  const addTeamTask: Store['addTeamTask'] = (data) => {
    setTeamTasks(prev => [{
      id: `TT${uid().toUpperCase()}`, title: data.title, detail: data.detail,
      assignee: data.assignee, creator: role.name, due: data.due,
      priority: data.priority, status: '待处理' as const, page: data.page,
      source: data.source ?? '手动创建', createdAt: new Date().toISOString().slice(0, 10),
    }, ...prev])
    addActivity(`团队任务创建：「${data.title}」→ ${data.assignee}（${data.priority}优先级 · ${data.due}）`, role.name, 'system')
    toast.success(`任务已分派给 ${data.assignee}，待办中心可见`)
  }

  const advanceTeamTask: Store['advanceTeamTask'] = (id) => {
    const t = teamTasks.find(x => x.id === id)
    if (!t) return
    const next = t.status === '待处理' ? '进行中' : t.status === '进行中' ? '已完成' : '待处理'
    setTeamTasks(prev => prev.map(x => x.id === id ? { ...x, status: next } : x))
    addActivity(`团队任务${next === '已完成' ? '完成' : '状态流转'}：「${t.title}」→ ${next}（${t.assignee}）`, role.name, 'system')
    if (next === '已完成') toast.success('任务已完成，已记入审计日志')
  }

  const deleteTeamTask: Store['deleteTeamTask'] = (id) => {
    const t = teamTasks.find(x => x.id === id)
    setTeamTasks(prev => prev.filter(x => x.id !== id))
    if (t) addActivity(`团队任务删除：「${t.title}」`, role.name, 'system')
  }

  const depositModule: Store['depositModule'] = (deploymentId, name, desc) => {
    const d = deployments.find(x => x.id === deploymentId)
    if (!d) return
    setModules(prev => [...prev, {
      id: `M${uid().toUpperCase()}`, name, kind: '功能模块', maturity: '沉淀中',
      desc, capabilities: [], source: `沉淀自：${d.customer} ${d.site}（${d.currentVersion}）`, price: null, usedBy: [d.customer],
    }])
    addActivity(`「${d.site}」能力沉淀为内部半成品模块「${name}」，后续项目可直接组装`, '人在回路', 'deployments', d.leadId)
    toast.success('已沉淀为半成品模块，进入产品模块库')
  }

  const toggleProposalSku: Store['toggleProposalSku'] = (proposalId, skuId) => {
    const p = proposals.find(x => x.id === proposalId)
    const s = skus.find(x => x.id === skuId)
    if (!p || !s) return
    const has = p.skus.includes(skuId)
    setProposals(prev => prev.map(x => x.id === proposalId
      ? { ...x, skus: has ? x.skus.filter(id => id !== skuId) : [...x.skus, skuId] } : x))
    if (!has) {
      addActivity(`《${p.title}》组装标准产品「${s.name}」（${s.billing}）`, '人在回路', 'proposal', proposalId)
      toast.success(`已组装标准产品「${s.name}」`)
    } else {
      toast.success(`已移除「${s.name}」`)
    }
  }

  const toggleProposalCase: Store['toggleProposalCase'] = (proposalId, ref) => {
    const p = proposals.find(x => x.id === proposalId)
    if (!p) return
    const has = p.caseRefs.some(r => r.kind === ref.kind && r.id === ref.id)
    setProposals(prev => prev.map(x => x.id === proposalId
      ? { ...x, caseRefs: has ? x.caseRefs.filter(r => !(r.kind === ref.kind && r.id === ref.id)) : [...x.caseRefs, ref] } : x))
    if (!has) {
      addActivity(`《${p.title}》关联案例参考「${ref.title}」，再生成时注入上下文`, '人在回路', 'proposal', proposalId)
      toast.success(`已关联「${ref.title}」，再生成时将作为背景知识注入上下文`)
    } else {
      toast.success(`已移除「${ref.title}」`)
    }
  }

  const settlePartner: Store['settlePartner'] = (partnerId) => {
    const pa = partners.find(x => x.id === partnerId)
    if (!pa || pa.pendingSettle <= 0) return
    setPartners(prev => prev.map(x => x.id === partnerId
      ? { ...x, totalSettled: x.totalSettled + x.pendingSettle, pendingSettle: 0 } : x))
    addActivity(`集成服务商「${pa.name}」交付分成 ¥${pa.pendingSettle.toLocaleString()} 已结算`, role.name, 'channels')
    toast.success(`已与「${pa.name}」结算交付分成`)
  }

  const followRenewal: Store['followRenewal'] = (id) => {
    const r = renewals.find(x => x.id === id)
    if (!r) return
    setRenewals(prev => prev.map(x => x.id === id ? { ...x, status: '跟进中' as const } : x))
    setReminders(prev => [{ id: uid(), title: `续费跟进：「${r.customer}」${r.item}`, due: '本周', done: false, auto: true }, ...prev])
    addActivity(`续费「${r.customer} · ${r.item}」已转为跟进，提醒已创建`, role.name, 'contracts', r.contractId)
    toast.success('已转为跟进，提醒已创建')
  }

  const confirmRenewal: Store['confirmRenewal'] = (id) => {
    const r = renewals.find(x => x.id === id)
    if (!r) return
    setRenewals(prev => prev.map(x => x.id === id ? { ...x, status: '已续费' as const } : x))
    addActivity(`「${r.customer}」续费到账 ¥${r.amount.toLocaleString()}（${r.item}），订阅关系延续`, role.name, 'contracts', r.contractId)
    toast.success('续费已确认到账，客户捆绑关系延续')
  }

  const TARGET_LABELS: Record<ImportTarget, string> = { deployments: '部署台账', leads: '线索', contracts: '合同', renewals: '订阅续费' }

  const createImportBatch: Store['createImportBatch'] = (target, fileName, rows) => {
    const id = `IB${uid().toUpperCase()}`
    setImportBatches(prev => [{ id, target, fileName, at: now(), by: role.name, status: '待审阅' as const, rows }, ...prev])
    addActivity(`数字员工解析「${fileName}」为 ${rows.length} 条${TARGET_LABELS[target]}记录，待人工审阅`, '数字员工', 'import', id)
    toast.success(`解析完成：${rows.length} 条记录待审阅，逐条确认后才能录入`)
    return id
  }

  const reviewImportRow: Store['reviewImportRow'] = (batchId, rowId, action, editedFields) => {
    const batch = importBatches.find(b => b.id === batchId)
    setImportBatches(prev => prev.map(b => b.id === batchId
      ? {
          ...b,
          rows: b.rows.map(r => {
            if (r.id !== rowId) return r
            if (editedFields) {
              const meta = { ...r.meta }
              Object.keys(editedFields).forEach(k => {
                if (editedFields[k] !== r.fields[k]) meta[k] = { confidence: 1, source: `人工修正（原解析：${r.fields[k] || '空'}）` }
              })
              return { ...r, fields: { ...r.fields, ...editedFields }, meta, status: '已修改' as const, editedBy: role.name }
            }
            return { ...r, status: action }
          }),
        }
      : b))
    if (editedFields && batch) {
      addActivity(`导入数据人工修正：「${batch.fileName}」${rowId}（${TARGET_LABELS[batch.target]}）`, role.name, 'import', batchId)
    }
  }

  const commitImportBatch: Store['commitImportBatch'] = (batchId) => {
    const batch = importBatches.find(b => b.id === batchId)
    if (!batch || batch.status !== '待审阅') return
    const pending = batch.rows.filter(r => r.status === '待审')
    if (pending.length > 0) { toast.error(`还有 ${pending.length} 条待审，全部处理完才能录入`); return }
    const accepted = batch.rows.filter(r => r.status === '已确认' || r.status === '已修改')
    const rejected = batch.rows.filter(r => r.status === '已拒绝')
    if (accepted.length === 0) { toast.error('没有可录入的记录'); return }

    const today = new Date().toISOString().slice(0, 10)
    if (batch.target === 'deployments') {
      const items: Deployment[] = accepted.map(r => ({
        id: `DP${uid().toUpperCase()}`, customer: r.fields.customer, site: r.fields.site,
        domain: r.fields.domain,
        env: (['演示', '试用', '正式'].includes(r.fields.env) ? r.fields.env : '演示') as Deployment['env'],
        platform: (r.fields.platform?.toLowerCase() === 'github' ? 'github' : 'gitea') as Deployment['platform'],
        repo: r.fields.repo || '—', status: '运行中',
        currentVersion: r.fields.currentVersion || 'v0.1',
        domainExpire: r.fields.domainExpire || '—', updatedAt: today,
        modules: [],
        logs: [{ version: r.fields.currentVersion || 'v0.1', date: today, by: role.name, note: '数据导入初始登记' }],
      }))
      setDeployments(prev => [...prev, ...items])
      items.forEach(d => addActivity(`部署台账录入：「${d.site}」（${d.domain}）`, role.name, 'deployments', d.id))
    }
    if (batch.target === 'leads') {
      const items: Lead[] = accepted.map(r => ({
        id: `L${uid().toUpperCase()}`, name: r.fields.name, industry: r.fields.industry || '其他',
        scale: (['央企', '上市', '中小', '政府'].includes(r.fields.scale) ? r.fields.scale : '中小') as Lead['scale'],
        source: (['转介绍', '微信', '电话', '官网', '会议', '其他'].includes(r.fields.source) ? r.fields.source : '其他') as Lead['source'],
        referrer: '—', stage: '新线索', owner: role.name, team: [role.name], lastTouchAt: now().slice(0, 5),
        background: r.fields.note || '', painPoints: [],
        suggestion: { text: '新线索已录入。建议 24 小时内完成首次联系，明确决策链与预算窗口。', basis: '依据：新线索 24 小时内首联的转化率最高', status: 'pending' },
        touchpoints: [], interviews: [],
      }))
      setLeads(prev => [...items, ...prev])
      items.forEach(l => addActivity(`线索录入：「${l.name}」（来源：${l.source}）`, role.name, 'lead', l.id))
    }
    if (batch.target === 'contracts') {
      const items: Contract[] = accepted.map(r => ({
        id: `C${uid().toUpperCase()}`, code: r.fields.code, leadId: '', customer: r.fields.customer,
        amount: Number(r.fields.amount.replace(/[,，元¥\s]/g, '')) || 0,
        salesType: (['直接', '间接', '转介绍'].includes(r.fields.salesType) ? r.fields.salesType : '直接') as Contract['salesType'],
        commissionRate: 0, status: '草拟', signDate: r.fields.signDate || undefined,
        payments: [],
        revisions: [{ id: uid(), version: 1, at: now(), by: role.name, opinion: '—', change: '数据导入建档' }],
      }))
      setContracts(prev => [...prev, ...items])
      items.forEach(c => addActivity(`合同建档：${c.code}「${c.customer}」¥${c.amount.toLocaleString()}`, role.name, 'contracts', c.id))
    }
    if (batch.target === 'renewals') {
      const items: Renewal[] = accepted.map(r => ({
        id: `RN${uid().toUpperCase()}`, contractId: '', customer: r.fields.customer, item: r.fields.item,
        dueDate: r.fields.dueDate, amount: Number(r.fields.amount.replace(/[,，元¥\s]/g, '')) || 0,
        status: '待续费', note: r.fields.note || undefined,
      }))
      setRenewals(prev => [...prev, ...items])
      items.forEach(rn => addActivity(`续费台账录入：「${rn.customer}」${rn.item}（到期 ${rn.dueDate}）`, role.name, 'contracts', rn.id))
    }

    setImportBatches(prev => prev.map(b => b.id === batchId ? { ...b, status: '已录入' as const } : b))
    addActivity(`导入批次「${batch.fileName}」审批通过并正式录入：采纳 ${accepted.length} 条 / 拒绝 ${rejected.length} 条（${TARGET_LABELS[batch.target]}）`, '人在回路', 'import', batchId)
    toast.success(`已正式录入 ${accepted.length} 条${TARGET_LABELS[batch.target]}记录，全程留痕`)
  }

  const confirmProposal: Store['confirmProposal'] = (proposalId) => {
    setProposals(prev => prev.map(p => p.id === proposalId ? { ...p, status: '已确认' } : p))
    const p = proposals.find(x => x.id === proposalId)
    addActivity(`《${p?.title}》v${p?.version} 已经人工确认，成为正式版本`, '人在回路', 'proposal', proposalId)
    setLeads(prev => prev.map(l => {
      if (l.id !== p?.leadId) return l
      if (['新线索', '已联系', '拜访中', '方案中'].includes(l.stage)) return { ...l, stage: '报价中' }
      return l
    }))
    toast.success('方案已确认为正式版本，线索自动推进至「报价中」')
  }

  const contractFlow: Contract['status'][] = ['草拟', '法务审核', '待签约', '履约中', '已回款']
  const advanceContract: Store['advanceContract'] = (id) => {
    setContracts(prev => prev.map(c => {
      if (c.id !== id) return c
      const i = contractFlow.indexOf(c.status)
      if (i >= contractFlow.length - 1) return c
      const next = contractFlow[i + 1]
      addActivity(`合同 ${c.code} 状态变更：${c.status} → ${next}`, '余宣庆', 'contracts', id)
      toast.success(`合同已推进至「${next}」`)
      return { ...c, status: next }
    }))
  }

  const settlePayment: Store['settlePayment'] = (contractId, paymentId) => {
    const c = contracts.find(x => x.id === contractId)
    setContracts(prev => prev.map(x => {
      if (x.id !== contractId) return x
      const payments = x.payments.map(py => py.id === paymentId ? { ...py, done: true } : py)
      const allDone = payments.every(py => py.done)
      return { ...x, payments, status: allDone ? '已回款' : x.status }
    }))
    if (c) {
      const pay = c.payments.find(py => py.id === paymentId)
      if (c.channelId && pay) {
        const commission = Math.round(pay.amount * c.commissionRate)
        setChannels(prev => prev.map(ch => ch.id === c.channelId ? { ...ch, commissionPaid: ch.commissionPaid + commission, totalContribution: ch.totalContribution + pay.amount } : ch))
        addActivity(`合同 ${c.code} 回款 ¥${pay.amount.toLocaleString()}，渠道分佣 ¥${commission.toLocaleString()} 已自动计入台账`, '合同管理', 'contracts', contractId)
        toast.success(`回款已登记，渠道分佣 ¥${commission.toLocaleString()} 自动计入`)
      } else {
        addActivity(`合同 ${c.code} 回款 ¥${pay?.amount.toLocaleString()} 已登记`, '合同管理', 'contracts', contractId)
        toast.success('回款已登记')
      }
    }
  }

  const reviewKnowledge: Store['reviewKnowledge'] = (id, action, reason) => {
    setKnowledge(prev => prev.map(k => k.id === id ? { ...k, status: action, rejectReason: reason } : k))
    addActivity(`沉淀条目${action}：「${knowledge.find(k => k.id === id)?.title}」`, '人在回路', 'lead')
    toast.success(`已${action}，轨迹留痕`)
  }

  const sendChat: Store['sendChat'] = (text) => {
    const assistantId = uid()
    setChat(prev => [...prev, { id: uid(), role: 'user', text }, { id: assistantId, role: 'assistant', text: '', pending: true }])
    const fill = (reply: Pick<ChatMessage, 'text' | 'card' | 'action'>) => {
      setChat(prev => prev.map(m => m.id === assistantId ? { ...m, ...reply, pending: false } : m))
    }
    const parsed = parseCommand(text, leads, knowledge)
    const cfg = getHarnessCfg()
    // 行动/查询指令本地识别（人在回路确认不变）；开放问答走 Harness 网关 fde-assistant 角色链路
    if (!parsed.action && !parsed.card && cfg.url) {
      const body: FdeChatBody = {
        user_input: text,
        user_key: username || role.name,
        session_id: chatSession,
        business_context: buildBusinessContext({ leads, proposals, contracts, deliveries, renewals, teamTasks }),
        history: chat.filter(m => !m.pending && m.text).slice(-8).map(m => ({ role: m.role as 'user' | 'assistant', content: m.text })),
      }
      streamFdeChat(cfg, body, full => {
        setChat(prev => prev.map(m => m.id === assistantId ? { ...m, text: full, pending: false } : m))
      }).catch(() => {
        fill(parsed)
        toast.info('Harness 网关不可达，已回退内置演示引擎')
      })
      return
    }
    setTimeout(() => fill(parsed), 900)
  }

  const setChatActionStatus: Store['setChatActionStatus'] = (msgId, status) => {
    setChat(prev => prev.map(m => m.id === msgId && m.action ? { ...m, action: { ...m.action, status } } : m))
  }

  const scopedLeads = useMemo(() => {
    if (role.scope === 'all') return leads
    if (role.scope === 'team') return leads.filter(l => role.teamIndustries?.includes(l.industry) || l.team.includes(role.name) || l.owner === role.name)
    return leads.filter(l => l.team.includes(role.name) || l.owner === role.name)
  }, [leads, role])

  const store = useMemo<Store>(() => ({
    page, navigate, loggedIn, login, logout,
    leads, proposals, contracts, channels, knowledge, activities, chat, chatOpen, setChatOpen,
    reminders, purchaseContracts, completeReminder, role, setRole, scopedLeads, addMember,
    advanceStage, markLost, respondSuggestion, addLead, addTouchpoint, addInterview, confirmInterview, processExtras, createProposal,
    toggleRule, confirmProposal, addProposalFeedback, respondFeedback,
    advanceContract, settlePayment, addContractRevision, reviewKnowledge, sendChat, setChatActionStatus, addActivity,
    deliveries, completeMilestone, toggleAcceptance, addRevisit,
    modules, toggleProposalModule, addProductModule,
    allocations, setContributionShare, autoAllocate, confirmAllocation,
    channelCommissions, registerChannelCommission, settleChannelCommission,
    deployments, addVersionLog, addReminder, teamTasks, addTeamTask, advanceTeamTask, deleteTeamTask, depositModule,
    skus, toggleProposalSku, toggleProposalCase,
    partners, settlePartner,
    renewals, followRenewal, confirmRenewal,
    importBatches, createImportBatch, reviewImportRow, commitImportBatch,
  }), [page, loggedIn, leads, proposals, contracts, channels, knowledge, activities, chat, chatOpen, reminders, purchaseContracts, processExtras, deliveries, modules, allocations, channelCommissions, deployments, skus, partners, renewals, importBatches, teamTasks, role, scopedLeads])

  return <Ctx.Provider value={store}>{children}</Ctx.Provider>
}
