import type { Lead, Proposal, Contract, Channel, KnowledgeItem, Activity, RuleConfig, LeadStage } from '@/types'


export const defaultRules = (withOps: boolean, withPrivate: boolean): RuleConfig[] => [
  {
    key: 'base', label: '基础一体机（含记忆引擎授权）', desc: '软硬件一体交付，内置记忆引擎与知识库底座',
    price: 200000, priceNote: '固定', enabled: true, reason: '基础配置，所有报价必选',
    recentStat: '近 12 单中 12 单启用',
  },
  {
    key: 'ops', label: '运维服务', desc: '年度巡检、规则库更新、远程支持，按合同额年费计',
    price: 20000, priceNote: '¥2 万/年', enabled: withOps,
    reason: withOps ? '工业客户要求年度运维保障' : undefined,
    recentStat: '近 12 单中 9 单启用，工业场景几乎必选',
  },
  {
    key: 'llm', label: '大模型推理模块', desc: '本地推理加速卡与模型授权，支撑复杂问答与生成',
    price: 80000, priceNote: '+¥8 万', enabled: true,
    recentStat: '近 12 单中 8 单启用',
  },
  {
    key: 'private', label: '私有化部署', desc: '全套系统部署至客户内网，数据不出厂',
    price: 50000, priceNote: '+¥5 万', enabled: withPrivate,
    reason: withPrivate ? '客户安全合规要求，数据不出内网' : undefined,
    recentStat: '近 12 单中 7 单启用，央国企客户必选',
  },
  {
    key: 'kg', label: '工艺机理知识图谱构建', desc: '面向客户工艺的行业机理图谱定制构建',
    price: 60000, priceNote: '+¥6 万', enabled: withPrivate,
    recentStat: '近 12 单中 5 单启用，流程工业客户启用率 100%',
  },
]

export const initialLeads: Lead[] = [
  {
    id: 'L01', name: '长庆油田 · 天然气净化厂', industry: '石油化工', scale: '央企', source: '转介绍',
    referrer: '中科元融', stage: '已交付', owner: '赵鹏', team: ['赵鹏', '陈思远', '余宣庆'], lastTouchAt: '2026-09-05',
    background: '央企旗下天然气净化厂，DCS 系统报警泛滥，工艺工程师依赖个人经验判断，人员流动导致经验断层。安全合规要求高，预算充足。',
    painPoints: ['报警信息过载，人工判断费劲易出错', '工艺经验依赖老师傅，流失风险高', '安全审计要求明文可审'],
    suggestion: {
      text: '灯塔案例已交付，建议本周安排复盘会，提炼「报警降噪 + 经验沉淀」案例入案例库，并向同集团其他净化厂复制推广。',
      basis: '依据：同类型净化厂 3 家历史成交均从灯塔厂复制', status: 'pending',
    },
    touchpoints: [
      { id: 'T011', date: '2026-06-12', type: '线下拜访', note: '首次进厂调研，与工艺总工程师交流报警处置痛点' },
      { id: 'T012', date: '2026-07-02', type: '资料发送', note: '发送方案 PPT v1 与报价单（含运维 + 私有化部署）' },
      { id: 'T013', date: '2026-07-20', type: '打款记录', note: '首付款 60% 到账' },
      { id: 'T014', date: '2026-09-05', type: '线下拜访', note: '交付验收，运行 3 周报警处置时长下降 62%' },
    ],
    interviews: [
      {
        id: 'IV011', date: '2026-06-12', title: '首次进厂调研访谈', participants: '工艺总工程师 · 赵鹏', duration: '48 分钟',
        audioFile: 'visit_20260612.m4a',
        transcript: [
          '客户：DCS 一天两千多条报警，值班的兄弟根本看不过来，真正要处理的可能不到两成。',
          '赵鹏：那现在怎么判断哪些报警要管、哪些可以压掉？',
          '客户：靠老师傅的经验。年轻人来了根本不敢动，怕误操作。老师傅一走，经验就带走了。',
          '客户：安监这边要求处置过程全部留痕，谁判断的、依据是什么，都要能查。',
        ],
        summary: '报警泛滥是第一痛点，处置依赖老师傅个人经验；安监要求过程留痕。私有化部署与经验沉淀是最匹配的方案切入点。',
        extracted: [
          { kind: '需求', text: '报警智能降噪，过滤无效报警' },
          { kind: '需求', text: '处置过程明文留痕，满足安监审计' },
          { kind: '决策', text: '方案以「报警降噪 + 经验沉淀」为第一切入点' },
        ],
        status: '已沉淀',
      },
      {
        id: 'IV012', date: '2026-09-05', title: '交付验收复盘访谈', participants: '生产部主任 · 赵鹏', duration: '35 分钟',
        audioFile: 'review_20260905.m4a',
        transcript: [
          '客户：跑了三周，无效报警降了八成，班组现在敢让年轻人先判了。',
          '客户：同集团还有两个净化厂情况差不多，年底技改预算里可以排进去。',
        ],
        summary: '验收达标：无效报警下降 80%、处置时长下降 62%。客户主动提出同集团 2 家净化厂可复制，进入年底技改预算窗口。',
        extracted: [
          { kind: '决策', text: '提炼灯塔案例入库，向同集团净化厂复制' },
          { kind: '待办', text: 'Q4 前跟进客户集团技改预算申报窗口' },
        ],
        status: '已沉淀',
      },
    ],
  },
  {
    id: 'L02', name: '宁夏电信 · 工业智能联合项目', industry: '电信运营商', scale: '央企', source: '转介绍',
    referrer: '宁夏电信集客部', stage: '谈判中', owner: '余宣庆', team: ['余宣庆'], lastTouchAt: '2026-09-07',
    background: '与电信运营商合作的园区工业智能项目，覆盖办公经营与生产制造，含多智能体协同、知识库与预测预警能力，项目立项中。',
    painPoints: ['园区企业数字化入口分散', '缺乏统一的数据与服务聚合', '需要可演示的标杆场景'],
    suggestion: {
      text: '报价已发 3 天未回，建议明天上午致电集客部张主任确认立项评审时间，并主动提出补充「预测预警标杆场景」专章。',
      basis: '依据：渠道单超过 3 天无反馈时主动跟进，历史转化率提升明显', status: 'pending',
    },
    touchpoints: [
      { id: 'T021', date: '2026-08-10', type: '线上拜访', note: '需求澄清会，确认只做软件层，不含硬件与算力' },
      { id: 'T022', date: '2026-08-15', type: '资料发送', note: '发送 500 万建设方案书与报价 Excel' },
      { id: 'T023', date: '2026-09-04', type: '线上拜访', note: '渠道方反馈客户内部立项评审预计中旬启动' },
    ],
    interviews: [
      {
        id: 'IV021', date: '2026-09-04', title: '渠道方需求同步电话', participants: '集客部张主任 · 余宣庆', duration: '32 分钟',
        audioFile: 'call_20260904.m4a',
        transcript: [
          '张主任：客户内部立项评审大概中旬启动，你们那个预测预警的标杆场景最好单独写一章。',
          '余宣庆：明白。硬件和算力这次都不含，只做软件层，对吧？',
          '张主任：对，软件层五个模块分项报价，过审容易些。',
        ],
        summary: '立项评审预计中旬启动；客户要求预测预警标杆场景单独成章；确认只做软件层、五模块分项报价。',
        extracted: [
          { kind: '需求', text: '方案补充「预测预警标杆场景」专章' },
          { kind: '待办', text: '中旬前确认立项评审时间并送审方案' },
        ],
        status: '待确认',
      },
    ],
  },
  {
    id: 'L03', name: '可孚医疗', industry: '医疗器械', scale: '上市', source: '电话',
    referrer: '—', stage: '报价中', owner: '林芳', team: ['林芳', '余宣庆'], lastTouchAt: '2026-09-06',
    background: '上市医疗器械企业，探讨 Memory FDE 合作，关注「数据不出院」的合规要求与院内知识沉淀。',
    painPoints: ['数据合规要求高，数据不出院', '院内经验沉淀依赖人工文档'],
    suggestion: {
      text: '方案已出，建议本周内约法务对齐「数据不出院」条款写法，把私有化部署从限制讲成合规卖点。',
      basis: '依据：医疗客户决策链中法务是关键卡点，提前对齐可缩短 2 周周期', status: 'pending',
    },
    touchpoints: [
      { id: 'T031', date: '2026-08-28', type: '线下拜访', note: '与信息科负责人交流，明确私有化部署为硬性要求' },
      { id: 'T032', date: '2026-09-06', type: '资料发送', note: '发送解决方案 Word 初稿' },
    ],
    interviews: [],
  },
  {
    id: 'L04', name: '轩怡装饰', industry: '家装服务', scale: '中小', source: '官网',
    referrer: '—', stage: '已交付', owner: '陈思远', team: ['陈思远'], lastTouchAt: '2026-08-30',
    background: '华南家装连锁品牌，部署销售-交付全链路智能体工作台，覆盖售前线索、合同关联与智能资源调度。',
    painPoints: ['售前线索跟进不透明', '施工经验靠店长口传', '新人培训周期长'],
    suggestion: {
      text: '已交付并进入使用期，建议收集 30 天使用数据，整理成「家装行业智能体落地」案例，用于同类客户获客。',
      basis: '依据：C 端口碑案例对中小客户转化率贡献最大', status: 'adopted',
    },
    touchpoints: [
      { id: 'T041', date: '2026-07-18', type: '线上拜访', note: '需求调研，确认以门店管家场景切入' },
      { id: 'T042', date: '2026-08-30', type: '打款记录', note: '尾款结清，项目交付完成' },
    ],
    interviews: [],
  },
  {
    id: 'L05', name: '省级教育就业服务平台', industry: '教育政务', scale: '政府', source: '会议',
    referrer: '类脑智能专业赛评委引荐', stage: '已联系', owner: '林芳', team: ['林芳'], lastTouchAt: '2026-09-02',
    background: '省级就业服务数字化项目，面向一生一档、数据核查、实习项目等场景，曾向省级领导汇报并获得关注。',
    painPoints: ['就业帮扶数据分散', '人工推送效率低', '缺乏多维度分析工具'],
    suggestion: {
      text: '尚未上门拜访，建议本周内发出正式拜访函，附上地质大学系统参数比对材料，突出「数据核查 + 多维分析」差异点。',
      basis: '依据：政府客户从会议接触到首访超过 2 周，热度衰减明显', status: 'pending',
    },
    touchpoints: [
      { id: 'T051', date: '2026-09-02', type: '线上拜访', note: '电话初步沟通，对方要求先看参数比对材料' },
    ],
    interviews: [],
  },
  {
    id: 'L06', name: '南方电网（广州）', industry: '能源电力', scale: '央企', source: '转介绍',
    referrer: '行业专家引荐', stage: '方案中', owner: '赵鹏', team: ['赵鹏', '陈思远'], lastTouchAt: '2026-09-08',
    background: '央企能源客户，专家引荐对接，关注智能化赋能解决方案，看重团队背景、已有案例与技术特色。',
    painPoints: ['设备运维经验依赖专家', '预测性维护能力不足', '对供应商资质与案例要求高'],
    suggestion: {
      text: '方案已出待汇报，建议汇报时以「公司简介一段话 + 湖南省级投资背书 + 世界人工智能大会报道」开场，先建立信任再讲技术。',
      basis: '依据：央企首次汇报中，资质背书比技术细节更能推进下一步', status: 'pending',
    },
    touchpoints: [
      { id: 'T061', date: '2026-09-08', type: '资料发送', note: '发送公司简介与智能报警解决方案 PPT' },
    ],
    interviews: [
      {
        id: 'IV061', date: '2026-09-08', title: '专家引荐电话访谈', participants: '运维部主任 · 赵鹏', duration: '26 分钟',
        audioFile: 'call_20260908.m4a',
        transcript: [
          '客户：设备检修的经验都在几个老专家脑子里，他们退休了怎么办，这是我最担心的。',
          '客户：你们做过哪些央企的案例？供应商我们首要看资质和案例。',
        ],
        summary: '客户核心关切是专家经验断层与预测性维护；供应商选择看重资质背书与灯塔案例。汇报策略应先讲背书再讲技术。',
        extracted: [
          { kind: '需求', text: '检修经验沉淀与预测性维护' },
          { kind: '决策', text: '汇报开场先讲资质背书（省级投资 + 灯塔案例）' },
        ],
        status: '已沉淀',
      },
    ],
  },
  {
    id: 'L07', name: '中原石化装备', industry: '石油化工', scale: '中小', source: '官网',
    referrer: '—', stage: '已流失', owner: '陈思远', team: ['陈思远'], lastTouchAt: '2026-08-12',
    background: '中型石化装备制造商，试用后预算收紧。',
    painPoints: ['预算有限'],
    lostReason: '客户年度预算冻结，暂缓采购',
    suggestion: { text: '建议明年 Q1 预算窗口期重新触达。', basis: '依据：预算冻结类流失客户，下个预算周期回访成功率约 30%', status: 'pending' },
    touchpoints: [
      { id: 'T071', date: '2026-08-12', type: '线上拜访', note: '客户确认预算冻结，约定明年初再议' },
    ],
    interviews: [],
  },
]

export const initialProposals: Proposal[] = [
  {
    id: 'P01', leadId: 'L01', title: '天然气净化厂智能报警解决方案', createdAt: '2026-07-02',
    status: '已确认', version: 2,
    versions: [
      { version: 1, time: '2026-07-02', note: '初版生成', total: 340000 },
      { version: 2, time: '2026-07-09', note: '响应甲方意见：追加年度运维条款与审计专章', opinion: '甲方担心系统用一年后落后，要求明确年度运维；安监要求处置过程明文可审', total: 360000 },
    ],
    feedbacks: [
      { id: 'FB011', version: 1, author: '甲方 · 工艺总工', at: '2026-07-05', content: '报警降噪指标认可，但希望明确年度运维与规则库持续更新条款，担心系统用一年后落后。', status: '已响应' },
      { id: 'FB012', version: 1, author: '甲方 · 安全监察部', at: '2026-07-07', content: '安全审计要求处置过程明文可审，建议把「全程留痕」写进验收标准而不仅是功能描述。', status: '已响应' },
    ],
    modules: ['M01', 'M05', 'M06'],
    skus: ['S05', 'S06'],
    caseRefs: [
      { kind: 'knowledge', id: 'K06', title: '案例：天然气净化厂报警降噪', reason: '同行业 · 含前后对比数据与客户证言，验收口径直接复用' },
      { kind: 'knowledge', id: 'K05', title: '化工场景方案生成模板', reason: '同场景 · 流程工业方案 PPT 结构与话术模板' },
    ],
    materials: ['客户背景', '相似案例：化工园区报警降噪', '调研方案：流程工业预测预警'],
    rules: defaultRules(true, true),
    slides: [
      { title: '项目背景：报警泛滥下的经验断层', bullets: ['DCS 日均报警 2000+ 条，有效处置率不足 15%', '工艺判断依赖老师傅经验，人员流动带来断层风险', '安全审计要求处置过程明文可审、全程留痕'] },
      { title: '解决思路：让设备长出记忆和预判', bullets: ['报警智能降噪：规则库 + 历史案例匹配，无效报警下降 80%', '经验沉淀：专家处置批注自动入库，新人可复用', '预测预警：时序趋势 + 机理图谱，提前识别异常工况'] },
      { title: '建设方案与报价', bullets: ['基础一体机 + 私有化部署，数据不出厂', '工艺机理知识图谱定制构建', '年度运维服务，规则库持续更新', '总价 ¥36 万，含首年运维'] },
    ],
    word: [
      { heading: '一、项目背景与需求分析', body: '天然气净化厂 DCS 系统报警信息过载，工艺工程师需在大量噪声报警中人工筛选有效信息，判断费劲且易出错。工厂安全合规要求高，预算充足，明确要求私有化部署、数据不出厂。' },
      { heading: '二、总体架构', body: '系统采用「一体机 + 记忆引擎 + 知识库」三层架构：一体机承载算力与存储；记忆引擎沉淀报警处置记忆与规则；知识库构建工艺机理图谱，支撑预测预警。' },
      { heading: '三、实施路径与验收标准', body: '分两期实施：一期完成报警降噪与经验沉淀，二期上线预测预警。验收以「无效报警下降 80%、处置时长下降 50%」为核心指标。' },
    ],
    quote: [],
    total: 360000,
  },
  {
    id: 'P02', leadId: 'L06', title: '南方电网智能赋能解决方案', createdAt: '2026-09-08',
    status: '待审阅', version: 1,
    versions: [{ version: 1, time: '2026-09-08', note: '初版生成', total: 280000 }],
    feedbacks: [
      { id: 'FB021', version: 1, author: '甲方 · 运维部主任', at: '2026-09-10', content: '预测预警部分方向认可，希望补充电网设备检修经验本体的具体构建方式，并说明与现有 OMS 系统的对接边界。', status: '待处理' },
      { id: 'FB022', version: 1, author: '甲方 · 采购办', at: '2026-09-11', content: '报价中运维服务费建议从一次性打包改为按年列示，便于走年度预算科目。', status: '待处理' },
    ],
    modules: ['M01', 'M06'],
    skus: ['S01', 'S03'],
    caseRefs: [],
    materials: ['客户背景', '相似案例：长庆油田天然气净化厂', '触点记录'],
    rules: defaultRules(true, true).map(r => r.key === 'kg' ? { ...r, enabled: false } : r),
    slides: [
      { title: '能源央企的智能化命题', bullets: ['设备运维经验集中在少数专家手中', '故障多为事后处置，预测性维护能力不足', '供应商选择看重资质背书与灯塔案例'] },
      { title: '太忆方案：预测式智能底座', bullets: ['设备记忆沉淀：每次检修经验自动入库', '预测预警：趋势 + 机理双驱动，提前识别风险', '私有化部署，符合央企安全合规要求'] },
    ],
    word: [
      { heading: '一、公司与团队', body: '太忆科技 2025 年 3 月注册，获湖南省级政府投资，创始团队来自中科院自动化所，多次受邀于中国生成式 AI 大会作专题报告。' },
      { heading: '二、已有案例', body: '已在长庆油田天然气净化厂完成灯塔交付，报警处置时长下降 62%，验证了工业场景的落地能力。' },
    ],
    quote: [],
    total: 280000,
  },
]

export const initialContracts: Contract[] = [
  {
    id: 'C01', code: 'HT-2026-011', leadId: 'L02', customer: '宁夏电信 · 工业智能联合项目',
    amount: 5000000, salesType: '间接', channelId: 'CH01', commissionRate: 0.08,
    status: '待签约', payments: [
      { id: 'PAY011', date: '2026-10-15', amount: 2500000, ratio: 0.5, done: false },
      { id: 'PAY012', date: '2027-04-15', amount: 2500000, ratio: 0.5, done: false },
    ],
    revisions: [
      { id: 'RV011', version: 1, at: '2026-08-18', by: '我方商务', opinion: '初版起草', change: '按 500 万建设方案生成合同初稿，五模块分项计价' },
      { id: 'RV012', version: 2, at: '2026-08-25', by: '甲方法务', opinion: '验收标准不能只写「上线运行」，需细化为可考核指标', change: '验收条款修订为「试运行 30 天无重大故障 + 预测预警准确率 ≥ 85%」' },
      { id: 'RV013', version: 3, at: '2026-09-05', by: '甲方采购办', opinion: '渠道分佣结构不得出现在合同正文中', change: '删除分佣相关表述，渠道费用另行签署补充协议' },
    ],
  },
  {
    id: 'C02', code: 'HT-2026-009', leadId: 'L03', customer: '可孚医疗',
    amount: 330000, salesType: '直接', commissionRate: 0,
    status: '法务审核', payments: [
      { id: 'PAY021', date: '2026-09-30', amount: 198000, ratio: 0.6, done: false },
      { id: 'PAY022', date: '2026-12-30', amount: 132000, ratio: 0.4, done: false },
    ],
    revisions: [
      { id: 'RV021', version: 1, at: '2026-09-08', by: '我方商务', opinion: '初版起草', change: '按已确认方案 v1 生成合同初稿' },
      { id: 'RV022', version: 2, at: '2026-09-11', by: '我方法务', opinion: '医疗客户数据合规条款需前置，明确「数据不出院」的责任边界', change: '新增数据合规专章：数据存储、处理均在院内，我方人员进场签署保密协议' },
    ],
  },
  {
    id: 'C03', code: 'HT-2026-004', leadId: 'L01', customer: '长庆油田 · 天然气净化厂',
    amount: 360000, salesType: '间接', channelId: 'CH02', commissionRate: 0.10,
    status: '已回款', signDate: '2026-07-18', payments: [
      { id: 'PAY031', date: '2026-07-20', amount: 216000, ratio: 0.6, done: true },
      { id: 'PAY032', date: '2026-09-01', amount: 144000, ratio: 0.4, done: true },
    ],
    revisions: [
      { id: 'RV031', version: 1, at: '2026-07-10', by: '我方商务', opinion: '初版起草', change: '按已确认方案 v2 生成合同初稿，总价 ¥36 万' },
      { id: 'RV032', version: 2, at: '2026-07-14', by: '甲方法务', opinion: '安全审计条款需写明留痕数据的保存年限', change: '补充「处置留痕数据保存不少于 3 年」条款' },
      { id: 'RV033', version: 3, at: '2026-07-17', by: '甲方采购办', opinion: '付款节奏调整为 6/4，尾款与验收指标挂钩', change: '付款修订为首付 60%，验收达标后付 40%' },
    ],
  },
  {
    id: 'C04', code: 'HT-2026-006', leadId: 'L04', customer: '轩怡装饰',
    amount: 180000, salesType: '直接', commissionRate: 0,
    status: '已回款', signDate: '2026-07-25', payments: [
      { id: 'PAY041', date: '2026-07-28', amount: 180000, ratio: 1, done: true },
    ],
    revisions: [
      { id: 'RV041', version: 1, at: '2026-07-21', by: '我方商务', opinion: '初版起草', change: '标准 SaaS 交付合同，一次性付清' },
    ],
  },
]

/** 采购合同：销售合同对应的供应商采购 */
export const initialPurchaseContracts: import('@/types').PurchaseContract[] = [
  { id: 'PC01', contractId: 'C03', code: 'CG-2026-018', supplier: '华为（硬件一体机）', category: '硬件采购', content: '国产化一体机服务器 2 台，含 GPU 推理加速卡', amount: 96000, status: '已完成', signDate: '2026-07-22' },
  { id: 'PC02', contractId: 'C03', code: 'CG-2026-019', supplier: '行业大模型授权方', category: '软件授权', content: '行业大模型本地推理授权（1 年）', amount: 30000, status: '已完成', signDate: '2026-07-22' },
  { id: 'PC03', contractId: 'C01', code: 'CG-2026-024', supplier: '云算力服务商', category: '算力租赁', content: 'GPU 算力租赁（验收测试期 3 个月）', amount: 45000, status: '执行中', signDate: '2026-09-01' },
  { id: 'PC04', contractId: 'C02', code: 'CG-2026-026', supplier: '华为（硬件一体机）', category: '硬件采购', content: '私有化部署一体机 1 台（院内机房）', amount: 52000, status: '已签订', signDate: '2026-09-10' },
]

/** 产品模块库：从项目中沉淀的标准化能力，方案与交付按积木式组装 */
export const initialModules: import('@/types').ProductModule[] = [
  {
    id: 'M01', name: '数字员工平台', kind: '平台', maturity: '标准产品',
    desc: '公司自有核心平台：时序记忆引擎 + 规则引擎 + 人在回路审阅，让 AI 员工越用越懂业务。',
    capabilities: ['时序记忆引擎', '规则库与候选规则审阅', '多渠道接入（IM/邮件/系统）', '人在回路工作台'],
    source: '公司自有产品', price: 15, usedBy: ['长庆油田 · 天然气净化厂', '宁夏电信 · 工业智能联合项目', '南方电网智能赋能'],
  },
  {
    id: 'M02', name: '太忆空间', kind: '平台', maturity: '标准产品',
    desc: '企业记忆资产的沉淀池：记忆流、规则库、知识库在这里持续累积与组织，通过 MCP 订阅输出，可视化面板可嵌入客户系统。',
    capabilities: ['记忆流沉淀', '规则库管理', '知识库与行业本体', 'MCP 订阅输出'],
    source: '公司自有产品', price: 8, usedBy: ['宁夏电信 · 工业智能联合项目'],
  },
  {
    id: 'M03', name: '智能客服解决方案', kind: '行业方案', maturity: '半产品',
    desc: '沉淀自家装/零售项目的客服方案：知识库问答 + 工单流转 + 会话记忆，SaaS 或私有化均可交付。',
    capabilities: ['知识库智能问答', '工单自动流转', '客户会话记忆', '满意度回访'],
    source: '沉淀自：轩怡装饰项目', price: 12, usedBy: ['轩怡装饰'],
  },
  {
    id: 'M04', name: '简历筛选解决方案', kind: '行业方案', maturity: '半产品',
    desc: '面向 HR 场景的简历解析与人岗匹配方案：批量解析、匹配打分、淘汰理由可解释，支持私有化。',
    capabilities: ['简历批量解析', '人岗匹配打分', '可解释淘汰理由', '私有化部署'],
    source: '沉淀自：省级教育就业平台项目', price: 10, usedBy: ['省级教育就业平台'],
  },
  {
    id: 'M05', name: '报警降噪功能模块', kind: '功能模块', maturity: '沉淀中',
    desc: '流程工业报警智能降噪：规则库 + 历史案例匹配，长庆项目实测无效报警下降 80%，正提炼为可复用模块。',
    capabilities: ['报警规则库', '历史案例匹配', '处置留痕审计', '降噪效果看板'],
    source: '沉淀自：长庆油田项目（复盘会确认提炼）', price: null, usedBy: ['长庆油田 · 天然气净化厂'],
  },
  {
    id: 'M06', name: '私有化部署套件', kind: '功能模块', maturity: '标准产品',
    desc: '国产化一体机 + 行业大模型本地授权的标准打包，数据不出内网，含上架实施与一年质保。',
    capabilities: ['国产化一体机', '大模型本地推理授权', '内网部署实施', '一年硬件质保'],
    source: '自有供应链打包（华为一体机等）', price: 13, usedBy: ['长庆油田 · 天然气净化厂', '可孚医疗', '南方电网智能赋能'],
  },
]

/** 交付项目：签约后自动生成，覆盖 启动→部署→联调→试运行→验收→回访 */
export const initialDeliveries: import('@/types').Delivery[] = [
  {
    id: 'D01', contractId: 'C03', customer: '长庆油田 · 天然气净化厂', name: '报警降噪与处置留痕系统交付', owner: '陈思远',
    status: '已回访',
    milestones: [
      { id: 'M011', name: '启动会', date: '2026-07-22', status: '已完成', note: '双方项目组成立，确认 6 周交付计划' },
      { id: 'M012', name: '数据接入', date: '2026-08-05', status: '已完成', note: 'DCS/报警系统历史数据接入，国产化一体机上架' },
      { id: 'M013', name: '模型联调', date: '2026-08-20', status: '已完成', note: '报警降噪模型上线并联调，无效报警开始下降' },
      { id: 'M014', name: '试运行', date: '2026-09-01', status: '已完成', note: '30 天试运行，无效报警下降 80%、处置时长下降 62%' },
      { id: 'M015', name: '验收', date: '2026-09-10', status: '已完成', note: '验收会通过，尾款 40% 已回款' },
    ],
    acceptance: [
      { item: '验收报告（双方盖章）', done: true },
      { item: '试运行数据对比报告', done: true },
      { item: '操作手册与运维文档', done: true },
      { item: '处置留痕合规说明（保存 ≥3 年）', done: true },
    ],
    revisits: [
      { id: 'RV01', date: '2026-09-12', content: '交付复盘会：客户对报警降噪效果满意，提炼案例素材入库', next: '二期扩容意向：覆盖另外 2 个净化厂，Q4 出方案' },
    ],
  },
  {
    id: 'D02', contractId: 'C04', customer: '轩怡装饰', name: '标准 SaaS 版开通交付', owner: '赵鹏',
    status: '已验收',
    milestones: [
      { id: 'M021', name: '启动会', date: '2026-07-28', status: '已完成' },
      { id: 'M022', name: '数据接入', date: '2026-08-02', status: '已完成', note: '历史项目资料批量导入' },
      { id: 'M023', name: '上线培训', date: '2026-08-08', status: '已完成', note: '2 场全员培训，答疑群已建' },
      { id: 'M024', name: '验收', date: '2026-08-15', status: '已完成' },
    ],
    acceptance: [
      { item: '账号开通确认单', done: true },
      { item: '培训签到记录', done: true },
    ],
    revisits: [],
  },
  {
    id: 'D03', contractId: 'C01', customer: '宁夏电信 · 工业智能联合项目', name: '工业智能平台五模块实施', owner: '陈思远',
    status: '待启动',
    milestones: [
      { id: 'M031', name: '启动会', date: '待定', status: '未开始', note: '合同签订后 5 个工作日内召开' },
      { id: 'M032', name: '数据接入', date: '待定', status: '未开始' },
      { id: 'M033', name: '模型联调', date: '待定', status: '未开始' },
      { id: 'M034', name: '试运行', date: '待定', status: '未开始', note: '验收指标：试运行 30 天无重大故障 + 预测预警准确率 ≥ 85%' },
      { id: 'M035', name: '验收', date: '待定', status: '未开始' },
    ],
    acceptance: [
      { item: '验收报告（双方盖章）', done: false },
      { item: '试运行数据对比报告', done: false },
      { item: '预测预警准确率测试记录', done: false },
      { item: '操作手册与运维文档', done: false },
    ],
    revisits: [],
  },
]

/** 提成比例：按合同金额 1%–3% 阶梯 */
export const commissionRateOf = (amount: number) =>
  amount >= 1000000 ? 0.03 : amount >= 300000 ? 0.02 : 0.01

/** 参与环节及参考权重（AI 建议分配的依据） */
export const CONTRIBUTION_STAGES: { name: string; weight: number }[] = [
  { name: '获客', weight: 20 },
  { name: '拜访跟进', weight: 20 },
  { name: '方案报价', weight: 25 },
  { name: '谈判签约', weight: 25 },
  { name: '交付回款', weight: 10 },
]

/** 各合同的贡献度分配（多人协助时协商分配，确认后锁定） */
export const initialAllocations: import('@/types').ContractAllocation[] = [
  {
    contractId: 'C01', status: '协商中',
    shares: [
      { member: '余宣庆', stages: ['获客', '谈判签约'], share: 40 },
      { member: '赵鹏', stages: ['拜访跟进', '方案报价'], share: 35 },
      { member: '陈思远', stages: ['方案报价', '交付回款'], share: 25 },
    ],
  },
  {
    contractId: 'C02', status: '协商中',
    shares: [
      { member: '赵鹏', stages: ['获客', '拜访跟进'], share: 50 },
      { member: '陈思远', stages: ['方案报价'], share: 30 },
      { member: '余宣庆', stages: ['谈判签约'], share: 20 },
    ],
  },
  {
    contractId: 'C03', status: '已确认',
    shares: [
      { member: '赵鹏', stages: ['获客', '拜访跟进', '方案报价'], share: 55 },
      { member: '陈思远', stages: ['方案报价', '交付回款'], share: 30 },
      { member: '余宣庆', stages: ['谈判签约'], share: 15 },
    ],
  },
  {
    contractId: 'C04', status: '已确认',
    shares: [
      { member: '赵鹏', stages: ['获客', '拜访跟进', '方案报价', '交付回款'], share: 70 },
      { member: '余宣庆', stages: ['谈判签约'], share: 30 },
    ],
  },
]

/** 渠道分佣登记：间接单按合同登记渠道方与比例，结算状态独立跟踪 */
export const initialChannelCommissions: import('@/types').ChannelCommission[] = [
  { contractId: 'C01', channelId: 'CH01', rate: 0.08, status: '待结算' },
  { contractId: 'C03', channelId: 'CH02', rate: 0.10, status: '已结算', settledAt: '2026-09-05' },
]

/** 部署台账：现场/回来方案后部署的演示站与正式站，域名 + 仓库 + 版本日志 */
export const initialDeployments: import('@/types').Deployment[] = [
  {
    id: 'DP01', leadId: 'L01', customer: '长庆油田 · 天然气净化厂', site: '报警降噪演示站',
    domain: 'demo-changqing.timem.site', env: '演示', platform: 'gitea',
    repo: 'gitea.timem.internal/fde/changqing-alarm-demo', status: '运行中',
    currentVersion: 'v1.4', domainExpire: '2026-12-20', updatedAt: '2026-09-08',
    modules: ['M05', 'M01'],
    logs: [
      { version: 'v1.4', date: '2026-09-08', by: '陈思远', note: '报警降噪规则库更新：新增脱硫单元 12 条规则，接入处置留痕面板' },
      { version: 'v1.3', date: '2026-08-25', by: '陈思远', note: '应甲方安监要求：留痕数据保存年限说明页，导出审计报表' },
      { version: 'v1.2', date: '2026-08-10', by: '陈思远', note: '接入真实 DCS 历史数据，演示无效报警下降对比看板' },
      { version: 'v1.0', date: '2026-07-24', by: '陈思远', note: '首次部署：报警降噪核心流程演示' },
    ],
  },
  {
    id: 'DP02', leadId: 'L06', customer: '南方电网（广州）', site: '智能赋能 POC 站',
    domain: 'poc-sge.timem.site', env: '试用', platform: 'github',
    repo: 'github.com/timem-ai/sge-poc', status: '运行中',
    currentVersion: 'v0.9', domainExpire: '2026-09-28', updatedAt: '2026-09-10',
    modules: ['M01'],
    logs: [
      { version: 'v0.9', date: '2026-09-10', by: '陈思远', note: '预测预警模块上线试用，等待甲方运维部反馈 OMS 对接边界' },
      { version: 'v0.7', date: '2026-09-05', by: '赵鹏', note: '按专家批注重构汇报页：资质背书前置' },
      { version: 'v0.5', date: '2026-09-01', by: '陈思远', note: 'POC 首版：知识沉淀 + 经验检索演示' },
    ],
  },
  {
    id: 'DP03', leadId: 'L04', customer: '轩怡装饰', site: '智能客服 SaaS 站点',
    domain: 'cs-xuanyi.timem.site', env: '正式', platform: 'gitea',
    repo: 'gitea.timem.internal/fde/xuanyi-cs-saas', status: '运行中',
    currentVersion: 'v2.1', domainExpire: '2027-07-25', updatedAt: '2026-08-15',
    modules: ['M03'],
    logs: [
      { version: 'v2.1', date: '2026-08-15', by: '赵鹏', note: '验收版本：工单流转 + 满意度回访上线' },
      { version: 'v2.0', date: '2026-08-06', by: '陈思远', note: '知识库问答接入客户历史工单语料' },
    ],
  },
  {
    id: 'DP04', leadId: 'L03', customer: '可孚医疗', site: '私有化部署演示站',
    domain: 'demo-kfu.timem.site', env: '演示', platform: 'gitea',
    repo: 'gitea.timem.internal/fde/kfu-private-demo', status: '运行中',
    currentVersion: 'v0.6', domainExpire: '2027-03-15', updatedAt: '2026-08-26',
    modules: ['M01', 'M06'],
    logs: [
      { version: 'v0.6', date: '2026-08-26', by: '陈思远', note: '数据不出院架构说明页 + 合规专章演示' },
      { version: 'v0.5', date: '2026-08-20', by: '陈思远', note: '首版：知识库问答 + 本地推理演示' },
    ],
  },
]

/** 登录账号（演示环境，明文仅用于演示） */
/** 演示账号（真实平台账号, PG users 表; 首次启动由服务端种子创建） */
export const ACCOUNTS: import('@/types').Account[] = [
  { email: 'admin@fde.local', password: 'admin123', roleId: 'admin' },
  { email: 'zhaopeng@fde.local', password: 'fde123', roleId: 'captain' },
  { email: 'chensiyuan@fde.local', password: 'fde123', roleId: 'engineer' },
]

export const initialChannels: Channel[] = [
  { id: 'CH01', name: '宁夏电信集客部', type: '战略协同', commissionRate: 0.08, contact: '张主任', phone: '0951-XXXXXXX', inFlight: 1, totalContribution: 5000000, commissionPaid: 0 },
  { id: 'CH02', name: '中科元融', type: '行业渠道', commissionRate: 0.10, contact: '刘工', phone: '010-XXXXXXX', inFlight: 0, totalContribution: 360000, commissionPaid: 36000 },
  { id: 'CH03', name: '类脑智能赛事组委会', type: '生态渠道', commissionRate: 0.05, contact: '秘书处', phone: '—', inFlight: 1, totalContribution: 0, commissionPaid: 0 },
]

export const initialKnowledge: KnowledgeItem[] = [
  { id: 'K01', kind: 'rule', title: '工业客户报价默认含运维条款', content: '流程工业客户（化工/能源）近 12 单中 9 单启用运维服务，建议报价时默认勾选并向客户说明年度保障价值。', source: '复盘：长庆油田项目复盘会', date: '2026-09-05', status: '已采纳', usedCount: 9, impactCount: 7, tags: ['报价', '工业'] },
  { id: 'K02', kind: 'rule', title: '央国企报价默认含私有化部署', content: '央企/国企客户合规要求数据不出内网，私有化部署选项默认启用，并在方案中转化为合规卖点表述。', source: '复盘：南方电网方案评审', date: '2026-09-08', status: '待审阅', usedCount: 7, impactCount: 6, tags: ['报价', '央国企', '合规'] },
  { id: 'K03', kind: 'rule', title: '渠道单 3 天无反馈主动跟进', content: '渠道合同报价发出后超过 3 天无反馈，主动联系渠道方确认评审节点，历史数据显示可显著提升转化率。', source: '复盘：渠道销售月度复盘', date: '2026-08-20', status: '已采纳', usedCount: 14, impactCount: 9, tags: ['渠道', '跟进节奏'] },
  { id: 'K04', kind: 'rule', title: '政府客户两周内必须首访', content: '政府类线索从会议接触到首次拜访不宜超过 2 周，否则热度衰减明显，转化概率大幅下降。', source: '复盘：教育就业平台线索分析', date: '2026-09-03', status: '待审阅', usedCount: 3, impactCount: 2, tags: ['政府客户', '拜访节奏'] },
  { id: 'K05', kind: 'skill', title: '化工场景方案生成模板', content: '面向流程工业的方案 PPT 结构：痛点数据开场 → 报警降噪 → 经验沉淀 → 预测预警 → 私有化合规 → 报价。', source: '提炼：长庆油田方案 PPT', date: '2026-07-09', status: '已采纳', usedCount: 4, impactCount: 3, tags: ['方案模板', '化工'] },
  { id: 'K06', kind: 'node', title: '案例：天然气净化厂报警降噪', content: '交付 3 周无效报警下降 80%、处置时长下降 62%，含前后对比数据与客户证言，可直接复用于同类方案。', source: '沉淀：长庆油田交付验收', date: '2026-09-05', status: '已采纳', usedCount: 2, impactCount: 2, tags: ['案例', '工业', '报警降噪'] },
  { id: 'K07', kind: 'node', title: '调研方案：流程工业预测预警', content: '覆盖化工/能源行业的预测预警调研报告，含竞品对比与需求排序，方案生成时可引用。', source: '沉淀：行业调研专项', date: '2026-08-02', status: '已采纳', usedCount: 5, impactCount: 4, tags: ['调研', '流程工业'] },
  { id: 'K08', kind: 'annotation', title: '专家批注：医疗客户先过法务', content: '医疗机构决策链中法务是前置卡点，方案阶段即应对齐「数据不出院」条款写法，可缩短约 2 周周期。', source: '批注：可孚医疗拜访纪要', date: '2026-09-06', status: '待审阅', usedCount: 1, impactCount: 1, tags: ['医疗', '合规', '法务'] },
  { id: 'K09', kind: 'rule', title: '预算冻结类流失客户季度回访', content: '因预算冻结流失的客户，登记后在下个预算窗口期（通常 Q1）回访，历史回访成功率约 30%。', source: '复盘：中原石化装备流失分析', date: '2026-08-12', status: '已采纳', usedCount: 2, impactCount: 1, tags: ['流失预警', '回访'] },
  { id: 'K10', kind: 'annotation', title: '专家批注：央企汇报先讲背书', content: '央企首次汇报开场应先讲资质背书（省级投资、行业大会报道、灯塔案例），建立信任后再展开技术细节。', source: '批注：南方电网汇报准备', date: '2026-09-08', status: '待审阅', usedCount: 1, impactCount: 1, tags: ['央企', '汇报话术'] },
  { id: 'K11', kind: 'memory', title: '时序记忆：余宣庆 × 数字员工 · 央企汇报话术讨论', content: '09-08 对话沉淀：央企首次汇报应先讲资质背书再讲技术；数字员工已将该偏好写入对余宣庆的服务记忆，后续生成汇报类建议时自动应用。', source: '交互沉淀：数字员工对话', date: '2026-09-08', status: '已采纳', usedCount: 2, impactCount: 1, tags: ['时序记忆', '汇报话术'] },
  { id: 'K12', kind: 'memory', title: '时序记忆：赵鹏 × 数字员工 · 工业报价偏好', content: '赵鹏在工业客户报价时固定启用运维+私有化部署，并要求给出「近 12 单启用率」作为说服素材。该习惯已沉淀为个人级记忆。', source: '交互沉淀：数字员工对话', date: '2026-09-06', status: '已采纳', usedCount: 5, impactCount: 3, tags: ['时序记忆', '报价'] },
  { id: 'K13', kind: 'template', title: '模板：工业预测预警方案（PPT 结构）', content: '痛点数据开场 → 报警降噪 → 经验沉淀 → 预测预警 → 私有化合规 → 报价。适用于化工/能源等流程工业客户。', source: '沉淀：长庆油田方案', date: '2026-07-09', status: '已采纳', usedCount: 4, impactCount: 3, tags: ['模板', '工业', 'PPT'] },
  { id: 'K14', kind: 'template', title: '模板：医疗合规方案（Word 结构）', content: '客户背景 → 数据不出院合规架构 → 知识沉淀方案 → 实施路径。法务条款前置对齐。', source: '沉淀：可孚医疗方案', date: '2026-09-06', status: '待审阅', usedCount: 1, impactCount: 1, tags: ['模板', '医疗', '合规'] },
]

export const initialActivities: Activity[] = [
  { id: 'A01', time: '09-08 16:20', text: '《南方电网智能赋能解决方案》已生成，等待审阅确认', source: '数字员工', page: 'proposal', refId: 'P02' },
  { id: 'A02', time: '09-08 11:40', text: '专家批注「央企汇报先讲背书」已沉淀，待审阅', source: '知识沉淀', page: 'lead', refId: 'L06' },
  { id: 'A03', time: '09-07 14:05', text: '宁夏电信联合项目报价发出 3 天，建议主动跟进', source: '数字员工', page: 'lead', refId: 'L02' },
  { id: 'A04', time: '09-06 10:30', text: '可孚医疗解决方案 Word 初稿已发送客户', source: '余宣庆', page: 'lead', refId: 'L03' },
  { id: 'A05', time: '09-05 17:50', text: '长庆油田项目复盘：2 条候选规则待审阅', source: '知识沉淀', page: 'lead', refId: 'L01' },
  { id: 'A06', time: '09-05 09:15', text: '长庆油田合同尾款 ¥144,000 到账，分佣 ¥36,000 已计入中科元融台账', source: '合同管理', page: 'contracts', refId: 'C03' },
]

export const knowledgeStats = {
  rule: 128, skill: 24, node: 87, case: 31, research: 12, annotation: 46,
  memory: 356, template: 9,
  weeklyNew: 9,
}

export const materialOptions = ['客户背景', '触点记录', '相似案例：天然气净化厂报警降噪', '调研方案：流程工业预测预警', '调研方案：家装智能体落地']

export const stageIndex = (s: LeadStage) => {
  const order: LeadStage[] = ['新线索', '已联系', '拜访中', '方案中', '报价中', '谈判中', '已签约', '已交付']
  return order.indexOf(s)
}

export const ROLES: import('@/types').RoleDef[] = [
  { id: 'admin', name: '余宣庆', title: '系统管理员 · 创始人', scope: 'all' },
  { id: 'captain', name: '赵鹏', title: 'FDE 行业队长 · 石化能源', scope: 'team', teamIndustries: ['石油化工', '能源电力'] },
  { id: 'engineer', name: '陈思远', title: 'FDE 工程师 · 石化能源组', scope: 'self' },
]

export const TEAM_MEMBERS = ['余宣庆', '赵鹏', '陈思远', '林芳']

export const PROPOSAL_TEMPLATES = ['通用方案模板', '工业预测预警模板', '医疗合规模板', '教育政务模板']

export const initialReminders: import('@/types').Reminder[] = [
  { id: 'R01', title: '「宁夏电信」报价已发 3 天未回：今天主动联系张主任，确认立项评审时间', leadId: 'L02', due: '今天', done: false, auto: true },
  { id: 'R02', title: '「省级教育就业平台」首次联系已满 7 天：本周内发出正式拜访函', leadId: 'L05', due: '明天', done: false, auto: true },
  { id: 'R03', title: '「可孚医疗」方案已进入报价中：09-12 前约法务对齐「数据不出院」条款', leadId: 'L03', due: '09-12', done: false, auto: true },
  { id: 'R04', title: '「长庆油田」已交付：安排复盘会，提炼报警降噪案例入库', leadId: 'L01', due: '09-12', done: false, auto: true },
]

export const initialTeamTasks: import('@/types').TeamTask[] = [
  { id: 'TT01', title: '「可孚医疗」私有化部署合规材料对齐', detail: '法务要求补充「数据不出院」条款说明与等保材料，随 v3 方案一起发出', assignee: '陈思远', creator: '余宣庆', due: '09-15', priority: '高', status: '进行中', page: { name: 'proposal', id: 'P02' }, source: '手动创建', createdAt: '09-11' },
  { id: 'TT02', title: '长庆油田报警降噪案例复盘入库', detail: '复盘会纪要 → 提炼为知识库案例，标注降噪率与复用边界', assignee: '赵鹏', creator: '余宣庆', due: '本周', priority: '中', status: '待处理', page: { name: 'knowledge' }, source: '本体建议', createdAt: '09-10' },
  { id: 'TT03', title: '渠道伙伴「华康信息」交付分成结算', detail: '待结算 ¥86,000，走结算流程并同步伙伴门户', assignee: '林芳', creator: '余宣庆', due: '09-18', priority: '中', status: '待处理', page: { name: 'channels' }, source: '本体建议', createdAt: '09-12' },
  { id: 'TT04', title: '一体机 M1 第二批备货确认', detail: 'Q4 预计 3 个私有化项目需要一体机，确认供应链排期', assignee: '余宣庆', creator: '余宣庆', due: '09-20', priority: '低', status: '待处理', source: '手动创建', createdAt: '09-09' },
  { id: 'TT05', title: '「宁夏电信」立项评审材料打印装订', assignee: '陈思远', creator: '赵鹏', due: '09-08', priority: '中', status: '已完成', source: '手动创建', createdAt: '09-05' },
]

export interface OntologyNode {
  name: string
  ontologyCount: number
  fromProjects: string[]
  samples: string[]
}

export const INDUSTRY_TREE: { industry: string; children: OntologyNode[] }[] = [
  {
    industry: '化工',
    children: [
      { name: '天然气净化', ontologyCount: 86, fromProjects: ['长庆油田 · 天然气净化厂'], samples: ['脱硫脱碳工艺流程本体', 'DCS 报警分级机理', '胺液系统异常工况图谱'] },
      { name: '油气田', ontologyCount: 64, fromProjects: ['长庆油田 · 天然气净化厂'], samples: ['井场集输工艺本体', '压缩机振动预警机理'] },
      { name: '煤化工', ontologyCount: 32, fromProjects: ['行业调研方案库'], samples: ['气化炉温度联锁机理', '煤气净化流程本体'] },
      { name: '磷化工', ontologyCount: 18, fromProjects: ['行业调研方案库'], samples: ['湿法磷酸工艺本体', '磷铵生产异常工况'] },
    ],
  },
  {
    industry: '能源电力',
    children: [
      { name: '电网运维', ontologyCount: 45, fromProjects: ['南方电网（广州）'], samples: ['设备检修经验本体', '预测性维护机理模型'] },
      { name: '发电', ontologyCount: 21, fromProjects: ['行业调研方案库'], samples: ['机组启停工况图谱'] },
    ],
  },
  {
    industry: '医疗',
    children: [
      { name: '院内知识管理', ontologyCount: 27, fromProjects: ['可孚医疗'], samples: ['数据不出院合规本体', '院内经验沉淀流程'] },
    ],
  },
  {
    industry: '家装服务',
    children: [
      { name: '施工交付', ontologyCount: 38, fromProjects: ['轩怡装饰'], samples: ['铺贴工艺决策本体', '工序排期经验图谱'] },
    ],
  },
]

export interface ProcessMemory {
  time: string
  type: '动作' | '需求' | '变更' | '决策'
  text: string
  why?: string
}

export const PROCESS_MEMORIES: Record<string, ProcessMemory[]> = {
  L01: [
    { time: '06-12', type: '动作', text: '首次进厂调研，确认报警降噪为第一优先级', why: '工艺总工程师明确报警泛滥是最痛的问题' },
    { time: '06-20', type: '需求', text: '客户追加安全审计要求：处置过程必须明文留痕' },
    { time: '06-25', type: '决策', text: '方案将私有化部署从可选项改为必选', why: '安监要求数据不出厂，顺势转化为合规卖点' },
    { time: '07-02', type: '动作', text: '发送方案 PPT v1 与报价单（含运维 + 私有化）' },
    { time: '07-09', type: '变更', text: '客户确认追加年度运维条款，报价升至 v2 ¥36 万', why: '「工业默认含运维」规则由此单沉淀' },
    { time: '09-05', type: '决策', text: '交付验收，复盘提炼报警降噪案例入库', why: '处置时长下降 62%，验证灯塔路径可复制' },
  ],
  L02: [
    { time: '08-10', type: '动作', text: '需求澄清会：确认只做软件层，不含硬件与算力' },
    { time: '08-15', type: '决策', text: '定价按软件层五模块拆分，运维放 10%', why: '运营商立项习惯分项报价，便于过审' },
    { time: '09-04', type: '需求', text: '渠道方反馈客户要求突出「预测预警」标杆场景' },
    { time: '09-07', type: '决策', text: '方案补充预测预警专章，泛化不具名灯塔', why: '乙方给甲方的方案，标杆场景要可复用不泄密' },
  ],
  L06: [
    { time: '09-08', type: '动作', text: '发送公司简介与智能报警解决方案 PPT' },
    { time: '09-08', type: '决策', text: '汇报开场改为先讲资质背书再讲技术', why: '专家批注规则：央企首次汇报先建立信任' },
  ],
}

export const DEFAULT_PROCESS_MEMORY: ProcessMemory[] = [
  { time: '本周', type: '动作', text: '线索录入工作台，完成首次联系' },
  { time: '本周', type: '决策', text: '根据客户行业匹配方案模板与报价规则', why: '系统依据行业机理知识与历史规则自动推荐' },
]

export interface LearningPath {
  member: string
  role: string
  steps: { title: string; done: boolean }[]
}

export const LEARNING_PATHS: LearningPath[] = [
  {
    member: '林芳', role: 'FDE 工程师 · 入职第 3 周',
    steps: [
      { title: '了解产品定位与「线索→方案→商务」全流程', done: true },
      { title: '学习报价规则引擎：五项配置与启用率依据', done: true },
      { title: '跟访一次客户拜访，阅读沉淀的纪要与批注', done: true },
      { title: '独立完成一份方案三件套并通过人在回路审阅', done: false },
      { title: '参与一次项目复盘，亲手提炼一条候选规则', done: false },
    ],
  },
  {
    member: '陈思远', role: 'FDE 工程师 · 石化能源组',
    steps: [
      { title: '了解产品定位与「线索→方案→商务」全流程', done: true },
      { title: '学习化工子行业本体知识（天然气/油气田/煤化工/磷化工）', done: true },
      { title: '学习报价规则引擎：五项配置与启用率依据', done: true },
      { title: '独立完成一份方案三件套并通过人在回路审阅', done: true },
      { title: '参与一次项目复盘，亲手提炼一条候选规则', done: true },
    ],
  },
]


/** 标准产品 SKU：记忆容量 / Token / 积分 / 一体机 / 私有化授权，标准化售卖 + 订阅续费长期捆绑 */
export const initialSkus: import('@/types').StandardSku[] = [
  {
    id: 'S01', name: '记忆容量包 · 标准', kind: '记忆容量', spec: '100GB 企业记忆容量', unit: '年',
    price: 30000, billing: '按年订阅',
    binding: '记忆沉淀越多迁移成本越高，按年续费形成天然锁定',
    desc: '企业级记忆流/规则库/知识库存储容量，含记忆写入与检索吞吐配额。',
  },
  {
    id: 'S02', name: '记忆容量包 · 扩容', kind: '记忆容量', spec: '500GB 企业记忆容量', unit: '年',
    price: 120000, billing: '按年订阅',
    binding: '容量随记忆资产增长滚动扩容，续费率接近 100%',
    desc: '面向记忆资产快速增长的头部客户，含专属索引与冷热分层。',
  },
  {
    id: 'S03', name: 'Token 流量包', kind: 'Token 包', spec: '1 亿 tokens 推理额度', unit: '次',
    price: 20000, billing: '按量消耗',
    binding: '用量随业务渗透持续增长，耗尽即充值，形成持续现金流',
    desc: '大模型推理调用额度，支持私有化模型与云端模型混合抵扣。',
  },
  {
    id: 'S04', name: '积分包', kind: '积分包', spec: '10 万积分', unit: '次',
    price: 10000, billing: '按量消耗',
    binding: '积分体系绑定内部功能解锁与高级能力，使用越深越离不开',
    desc: '平台通用积分，用于解锁高级分析、数字员工深度任务等增值能力。',
  },
  {
    id: 'S05', name: '边缘记忆一体机 M1', kind: '一体机', spec: '2U 机架 · 内置记忆底座 + 推理算力', unit: '套',
    price: 280000, billing: '一次性',
    binding: '硬件进场即绑定 3 年容量订阅与运维服务，长期捆绑起点',
    desc: '开箱即用的软硬一体交付，出厂预装记忆底座、规则引擎与演示场景。',
  },
  {
    id: 'S06', name: '私有化授权 · 标准版', kind: '私有化授权', spec: '单站点 · 不限用户数', unit: '年',
    price: 200000, billing: '按年订阅',
    binding: '授权按年激活，停用即失效，客户资产沉淀在授权体系内',
    desc: '私有化部署软件授权，含年度升级与补丁，央国企合规场景标配。',
  },
]

/** 集成服务商（交付伙伴）：与 FDE 合作推进解决方案落地，按项目额结算交付分成 */
export const initialPartners: import('@/types').IntegrationPartner[] = [
  {
    id: 'PA01', name: '云脉科技', region: '西北区 · 银川',
    capabilities: ['私有化部署', '工业网络集成', '等保合规'],
    contact: '马工', phone: '0951-XXXXXXX', shareRate: 0.15,
    projects: ['C01'], status: '合作中', totalSettled: 0, pendingSettle: 375000,
  },
  {
    id: 'PA02', name: '智启集成', region: '华南区 · 广州',
    capabilities: ['电力行业交付', 'OMS/调度系统对接', '驻场实施'],
    contact: '黄经理', phone: '020-XXXXXXX', shareRate: 0.18,
    projects: [], status: '合作中', totalSettled: 120000, pendingSettle: 0,
  },
  {
    id: 'PA03', name: '华康信息', region: '华中区 · 郑州',
    capabilities: ['医疗信息化', '院内系统集成'],
    contact: '周总', phone: '0371-XXXXXXX', shareRate: 0.15,
    projects: [], status: '待激活', totalSettled: 0, pendingSettle: 0,
  },
]

/** 订阅续费台账：标准化产品的到期续费与增购，长期捆绑客户的落脚点 */
export const initialRenewals: import('@/types').Renewal[] = [
  {
    id: 'RN01', contractId: 'C02', customer: '可孚医疗', item: 'Token 流量包充值（1 亿 tokens）',
    skuId: 'S03', dueDate: '2026-09-30', amount: 20000, status: '待续费',
    note: '私有化演示用量已达 78%，建议拜访时现场续充',
  },
  {
    id: 'RN02', contractId: 'C04', customer: '轩怡装饰', item: '记忆容量订阅 · 标准（100GB/年）',
    skuId: 'S01', dueDate: '2026-10-20', amount: 30000, status: '跟进中',
    note: '客服 SaaS 站点记忆量年增 3 倍，可引导升级扩容包',
  },
  {
    id: 'RN03', contractId: 'C01', customer: '宁夏电信 · 工业智能联合项目', item: '私有化授权年费（次年）',
    skuId: 'S06', dueDate: '2026-12-01', amount: 200000, status: '待续费',
    note: '首年授权含在合同内，次年订阅需提前 60 天对齐预算',
  },
  {
    id: 'RN04', contractId: 'C03', customer: '长庆油田 · 天然气净化厂', item: '积分包增购（10 万积分）',
    skuId: 'S04', dueDate: '2026-07-10', amount: 10000, status: '已续费',
    note: '报警降噪规则库高级分析消耗，已随尾款一起结算',
  },
]
