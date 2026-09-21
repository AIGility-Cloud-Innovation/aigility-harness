export type LeadStage =
  | '新线索' | '已联系' | '拜访中' | '方案中' | '报价中'
  | '谈判中' | '已签约' | '已交付' | '已流失'

export const STAGE_ORDER: LeadStage[] = [
  '新线索', '已联系', '拜访中', '方案中', '报价中', '谈判中', '已签约', '已交付',
]

export type LeadSource = '转介绍' | '微信' | '电话' | '官网' | '会议' | '其他'
export type LeadScale = '央企' | '上市' | '中小' | '政府'

export interface RoleDef {
  id: string
  name: string
  title: string
  scope: 'all' | 'team' | 'self'
  teamIndustries?: string[]
}

export interface Reminder {
  id: string
  title: string
  leadId?: string
  due: string
  done: boolean
  auto: boolean
}

/** 团队任务：可分派给成员、带优先级与状态流转的人工任务 */
export interface TeamTask {
  id: string
  title: string
  detail?: string
  /** 负责人（TEAM_MEMBERS 之一） */
  assignee: string
  creator: string
  due: string
  priority: '高' | '中' | '低'
  status: '待处理' | '进行中' | '已完成'
  /** 关联业务页面（点击可跳转） */
  page?: Page
  source: '手动创建' | '本体建议' | '系统'
  createdAt: string
}

export interface Touchpoint {
  id: string
  date: string
  type: '线下拜访' | '线上拜访' | '资料发送' | '打款记录' | '访谈记录'
  note: string
}

/** 访谈记录：拜访录音转文字 + AI 提炼 */
export interface InterviewRecord {
  id: string
  date: string
  title: string
  participants: string
  duration: string
  audioFile: string
  transcript: string[]
  summary: string
  extracted: { kind: '需求' | '决策' | '待办'; text: string }[]
  status: '待确认' | '已沉淀'
}

export interface Suggestion {
  text: string
  basis: string
  status: 'pending' | 'adopted' | 'rejected' | 'modified'
  reason?: string
}

export interface Lead {
  id: string
  name: string
  industry: string
  scale: LeadScale
  source: LeadSource
  referrer: string
  stage: LeadStage
  owner: string
  team: string[]
  lastTouchAt: string
  background: string
  painPoints: string[]
  suggestion: Suggestion
  touchpoints: Touchpoint[]
  interviews: InterviewRecord[]
  lostReason?: string
}

export interface RuleConfig {
  key: string
  label: string
  desc: string
  price: number
  priceNote: string
  enabled: boolean
  reason?: string
  recentStat: string
}

export interface Slide {
  title: string
  bullets: string[]
}

export interface WordSection {
  heading: string
  body: string
}

export interface QuoteLine {
  item: string
  desc: string
  amount: number
}

export interface ProposalVersion {
  version: number
  time: string
  note: string
  total: number
  /** 本版本响应的甲方意见摘要 */
  opinion?: string
}

export interface ProposalFeedback {
  id: string
  version: number
  author: string
  at: string
  content: string
  status: '待处理' | '已响应'
}

/** 方案生成时关联的案例参考：作为上下文背景知识注入，人在回路确认 */
export interface CaseRef {
  /** 来源类型：历史方案 / 已交付案例（部署台账） / 知识库条目 */
  kind: 'proposal' | 'deployment' | 'knowledge'
  id: string
  title: string
  /** 数字员工给出的匹配理由（同行业 / 共用模块 / 同场景） */
  reason: string
}

export interface Proposal {
  id: string
  leadId: string
  title: string
  createdAt: string
  status: '待审阅' | '已确认'
  version: number
  versions: ProposalVersion[]
  feedbacks: ProposalFeedback[]
  /** 积木式组装的产品模块 id 列表 */
  modules: string[]
  /** 组装的标准产品 SKU id 列表（记忆容量/Token/积分/一体机/私有化授权） */
  skus: string[]
  /** 人工确认关联的案例参考，生成/再生成时作为上下文背景知识 */
  caseRefs: CaseRef[]
  materials: string[]
  template?: string
  rules: RuleConfig[]
  slides: Slide[]
  word: WordSection[]
  quote: QuoteLine[]
  total: number
}

/** 产品模块：从项目中沉淀的标准化/半成品能力，积木式组装进方案与交付 */
export interface ProductModule {
  id: string
  name: string
  kind: '平台' | '行业方案' | '功能模块'
  /** 成熟度：标准产品可直接售卖；半产品需少量定制；沉淀中来自最近项目 */
  maturity: '标准产品' | '半产品' | '沉淀中'
  desc: string
  capabilities: string[]
  /** 来源（自有产品 / 从哪个项目沉淀） */
  source: string
  /** 标准报价（万元），null 表示随项目报价 */
  price: number | null
  /** 复用记录：项目名称 */
  usedBy: string[]
}

/** 标准产品 SKU：标准化售卖的记忆容量/Token/积分/一体机/私有化授权，订阅制长期捆绑客户 */
export interface StandardSku {
  id: string
  name: string
  kind: '记忆容量' | 'Token 包' | '积分包' | '一体机' | '私有化授权'
  /** 规格，如 100GB 企业记忆容量 / 1 亿 tokens */
  spec: string
  /** 计价单位：年 / 套 / 次 */
  unit: string
  /** 单价（元） */
  price: number
  billing: '一次性' | '按年订阅' | '按量消耗'
  /** 长期捆绑点：为什么客户会持续续费/增购 */
  binding: string
  desc: string
}

/** 集成服务商（交付伙伴）：FDE 合作落地交付，与获客渠道分开核算 */
export interface IntegrationPartner {
  id: string
  name: string
  region: string
  /** 交付能力标签 */
  capabilities: string[]
  contact: string
  phone: string
  /** 交付结算比例（按项目额），如 0.15 */
  shareRate: number
  /** 在交付/已交付项目的合同 id */
  projects: string[]
  status: '合作中' | '待激活'
  totalSettled: number
  pendingSettle: number
}

/** 订阅续费台账：容量/Token/授权等到期续费与增购，长期捆绑的落脚点 */
export interface Renewal {
  id: string
  contractId: string
  customer: string
  /** 续费项目，如 记忆容量订阅（100GB/年） */
  item: string
  skuId?: string
  dueDate: string
  amount: number
  status: '待续费' | '跟进中' | '已续费' | '已流失'
  note?: string
}

export type ContractStatus = '草拟' | '法务审核' | '待签约' | '履约中' | '已回款'

export interface Payment {
  id: string
  date: string
  amount: number
  ratio: number
  done: boolean
}

/** 合同修订记录：每轮修改都有甲方/法务意见与对应修改内容 */
export interface ContractRevision {
  id: string
  version: number
  at: string
  by: string
  opinion: string
  change: string
}

export interface Contract {
  id: string
  code: string
  leadId: string
  customer: string
  amount: number
  salesType: '直接' | '间接' | '转介绍'
  channelId?: string
  commissionRate: number
  status: ContractStatus
  signDate?: string
  payments: Payment[]
  revisions: ContractRevision[]
}

/** 采购合同：销售合同对应的供应商采购 */
export interface PurchaseContract {
  id: string
  contractId: string
  code: string
  supplier: string
  category: '硬件采购' | '软件授权' | '算力租赁' | '外包服务'
  content: string
  amount: number
  status: '草拟中' | '已签订' | '执行中' | '已完成'
  signDate?: string
}

export interface Account {
  email: string
  password: string
  roleId: string
}

export interface Channel {
  id: string
  name: string
  type: '行业渠道' | '生态渠道' | '战略协同'
  commissionRate: number
  contact: string
  phone: string
  inFlight: number
  totalContribution: number
  commissionPaid: number
}

export type KnowledgeKind = 'rule' | 'skill' | 'node' | 'annotation' | 'memory' | 'template'

export interface KnowledgeItem {
  id: string
  kind: KnowledgeKind
  title: string
  content: string
  source: string
  date: string
  status: '已采纳' | '待审阅' | '已拒绝'
  usedCount: number
  impactCount: number
  tags: string[]
  rejectReason?: string
}

export interface Activity {
  id: string
  time: string
  text: string
  source: string
  /** 所属模块（审计日志按此归集） */
  page: 'lead' | 'proposal' | 'contracts' | 'deployments' | 'channels' | 'performance' | 'import' | 'ontology' | 'system'
  refId?: string
}

/** 数据导入目标台账 */
export type ImportTarget = 'deployments' | 'leads' | 'contracts' | 'renewals'

/** 导入行：数字员工解析出的结构化字段，字段级置信度 + 来源原文，人审后才能录入 */
export interface ImportRow {
  id: string
  fields: Record<string, string>
  /** 每字段解析元数据：置信度 0~1 + 来源原文片段 */
  meta: Record<string, { confidence: number; source: string }>
  status: '待审' | '已确认' | '已修改' | '已拒绝'
  editedBy?: string
}

/** 数据导入批次：一次文件/文本导入产生一个批次，审批通过后正式录入 */
export interface ImportBatch {
  id: string
  target: ImportTarget
  fileName: string
  at: string
  by: string
  status: '待审阅' | '已录入'
  rows: ImportRow[]
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  pending?: boolean
  suggestionAction?: { leadId: string }
  /** 数据卡片：按类型实时渲染工作台数据（在线查） */
  card?: { kind: 'leads' | 'contracts' | 'deployments' | 'tasks' | 'performance' | 'renewals' | 'skus' }
  /** 行动卡片：人确认后真正改数据/执行任务（在线改查 + 执行） */
  action?: {
    intent: 'advanceStage' | 'reminder' | 'proposal'
    label: string
    detail: string
    payload: Record<string, string>
    status: 'pending' | 'done' | 'cancelled'
  }
}

export interface DeliveryMilestone {
  id: string
  name: string
  date: string
  status: '已完成' | '进行中' | '未开始'
  note?: string
}

export interface DeliveryRevisit {
  id: string
  date: string
  content: string
  next?: string
}

export type DeliveryStatus = '待启动' | '交付中' | '已验收' | '已回访'

export interface Delivery {
  id: string
  contractId: string
  customer: string
  name: string
  owner: string
  status: DeliveryStatus
  milestones: DeliveryMilestone[]
  acceptance: { item: string; done: boolean }[]
  revisits: DeliveryRevisit[]
}

/** 贡献度分配：一个合同上每位成员的参与环节与提成份额 */
export interface ContributionShare {
  member: string
  /** 参与环节：获客 / 拜访跟进 / 方案报价 / 谈判签约 / 交付回款 */
  stages: string[]
  /** 分配比例（%），同一合同合计 100 */
  share: number
}

export interface ContractAllocation {
  contractId: string
  status: '协商中' | '已确认'
  shares: ContributionShare[]
}

/** 渠道分佣（对外）：与团队内部个人提成分开核算 */
export interface ChannelCommission {
  contractId: string
  channelId: string
  /** 分佣比例，如 0.08 */
  rate: number
  status: '待结算' | '已结算'
  settledAt?: string
}

/** 版本更新日志 */
export interface VersionLog {
  version: string
  date: string
  by: string
  note: string
}

/** 部署台账：售前方案演示站/正式站的域名、仓库与版本管理 */
export interface Deployment {
  id: string
  leadId?: string
  customer: string
  site: string
  domain: string
  env: '演示' | '试用' | '正式'
  platform: 'gitea' | 'github'
  repo: string
  status: '运行中' | '已下线'
  currentVersion: string
  /** 域名到期日 */
  domainExpire: string
  /** 最近部署日期 */
  updatedAt: string
  /** 组装的产品模块 id */
  modules: string[]
  logs: VersionLog[]
}

export type Page =
  | { name: 'dashboard' }
  | { name: 'tasks' }
  | { name: 'performance' }
  | { name: 'leads'; stage?: LeadStage; source?: LeadSource }
  | { name: 'lead'; id: string }
  | { name: 'proposals' }
  | { name: 'proposal'; id: string }
  | { name: 'modules' }
  | { name: 'contracts' }
  | { name: 'delivery' }
  | { name: 'deployments' }
  | { name: 'channels' }
  | { name: 'knowledge' }
  | { name: 'import' }
  | { name: 'audit' }
  | { name: 'mcp' }
  | { name: 'ontology' }

export const fmtMoney = (n: number) =>
  n >= 10000 ? `${(n / 10000).toFixed(n % 10000 === 0 ? 0 : 1)} 万` : n.toLocaleString()

export const fmtMoneyFull = (n: number) => `¥${n.toLocaleString()}`
