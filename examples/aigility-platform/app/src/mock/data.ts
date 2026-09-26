// 太忆 TiMEM 集成商工作台 · Mock 数据层

export interface FieldAnalysis {
  name: string
  semantic: string
  format: string
  missing: string
  issue: string
  suggestion: string
  ontology: string
}

export interface DemoCase {
  id: string
  name: string
  system: 'DCS' | 'SCADA' | 'CRM'
  industry: string
  desc: string
  tableName: string
  fields: FieldAnalysis[]
  sampleRows: string[][]
  mappings: { source: string; target: string; relation: string }[]
}

export const demoCases: DemoCase[] = [
  {
    id: 'dcs',
    name: '电厂 DCS 监测点表',
    system: 'DCS',
    industry: '能源电力',
    desc: '某燃气电厂 DCS 系统导出的锅炉/汽机测点清单，含量程与报警阈值',
    tableName: 'dcs_points_boiler3.xlsx',
    fields: [
      { name: 'POINT_ID', semantic: '测点编号', format: '字符串', missing: '0%', issue: '命名含空格', suggestion: '去除空格，统一大写', ontology: '测点.编号' },
      { name: '测点名称', semantic: '测点名称', format: '字符串', missing: '0%', issue: '—', suggestion: '—', ontology: '测点.名称' },
      { name: '所属系统', semantic: '系统归属', format: '枚举', missing: '0%', issue: '“锅炉/锅炉系统”混用', suggestion: '枚举值合并为统一字典', ontology: '测点.所属系统 → 系统' },
      { name: '工程单位', semantic: '计量单位', format: '枚举', missing: '2%', issue: 'Mpa/MPa 混写', suggestion: '单位归一（MPa、℃、t/h）', ontology: '测点.单位' },
      { name: '量程下限', semantic: '量程参数', format: '数值', missing: '0%', issue: '—', suggestion: '—', ontology: '测点.量程下限' },
      { name: '量程上限', semantic: '量程参数', format: '数值', missing: '0%', issue: '1 处文本“MAX”', suggestion: '人工确认后转数值', ontology: '测点.量程上限' },
      { name: '报警下限', semantic: '报警阈值', format: '数值', missing: '5%', issue: '缺失 3 条', suggestion: '按同型测点默认值补齐并标注', ontology: '测点.报警下限' },
      { name: '报警上限', semantic: '报警阈值', format: '数值', missing: '5%', issue: '缺失 3 条', suggestion: '按同型测点默认值补齐并标注', ontology: '测点.报警上限' },
      { name: '采集周期', semantic: '采集参数', format: '时间间隔', missing: '0%', issue: '“1s/1秒”混写', suggestion: '统一为秒（数值）', ontology: '测点.采集周期' },
    ],
    sampleRows: [
      ['BL3-T-101', '锅炉出口主汽温度', '锅炉系统', '℃', '0', '600', '520', '575'],
      ['BL3-P-102', '主汽压力', '锅炉系统', 'MPa', '0', '20', '16.2', '17.8'],
      ['BL3-F-103', '给水流量', '锅炉系统', 't/h', '0', '1200', '—', '1100'],
      ['TB2-V-201', '汽轮机轴振', '汽机系统', 'μm', '0', '250', '—', '125'],
    ],
    mappings: [
      { source: '测点', target: '系统', relation: '属于' },
      { source: '测点', target: '报警规则', relation: '触发' },
      { source: '系统', target: '电厂', relation: '部署于' },
    ],
  },
  {
    id: 'scada',
    name: '工厂 SCADA 设备台账',
    system: 'SCADA',
    industry: '流程制造',
    desc: '某化工厂 SCADA 系统设备台账，含产线归属与保养周期',
    tableName: 'scada_devices_lineA.csv',
    fields: [
      { name: '设备编号', semantic: '设备编号', format: '字符串', missing: '0%', issue: '—', suggestion: '—', ontology: '设备.编号' },
      { name: '设备名称', semantic: '设备名称', format: '字符串', missing: '0%', issue: '—', suggestion: '—', ontology: '设备.名称' },
      { name: '型号规格', semantic: '设备型号', format: '字符串', missing: '8%', issue: '缺失 4 条', suggestion: '从采购合同 OCR 补齐', ontology: '设备.型号' },
      { name: '所属产线', semantic: '产线归属', format: '枚举', missing: '0%', issue: '“A线/A产线”混用', suggestion: '枚举合并', ontology: '设备.所属产线 → 产线' },
      { name: '投运日期', semantic: '日期', format: '日期', missing: '0%', issue: '2021.3.5 等非标格式', suggestion: '统一为 YYYY-MM-DD', ontology: '设备.投运日期' },
      { name: '保养周期(天)', semantic: '保养参数', format: '数值', missing: '0%', issue: '—', suggestion: '—', ontology: '设备.保养周期' },
      { name: '责任人', semantic: '人员', format: '字符串', missing: '3%', issue: '1 人已离职', suggestion: '标记并提醒更新责任人', ontology: '设备.责任人 → 人员' },
      { name: '运行状态', semantic: '状态', format: '枚举', missing: '0%', issue: '—', suggestion: '—', ontology: '设备.状态' },
    ],
    sampleRows: [
      ['PUMP-A-001', '原料输送泵', 'SB-450/2', 'A产线', '2021-03-05', '90'],
      ['REAC-A-002', '酯化反应釜', 'R-3000L', 'A产线', '2019-11-20', '180'],
      ['COMP-B-007', '空压机', 'GA55+', 'B产线', '2022-06-15', '60'],
      ['VALV-A-118', '气动调节阀', 'FISHER-667', 'A产线', '2020-08-01', '120'],
    ],
    mappings: [
      { source: '设备', target: '产线', relation: '属于' },
      { source: '设备', target: '人员', relation: '由谁负责' },
      { source: '设备', target: '保养计划', relation: '生成' },
    ],
  },
  {
    id: 'crm',
    name: '装修公司 CRM 客户表',
    system: 'CRM',
    industry: '家装服务',
    desc: '某家装公司 CRM 导出的客户与跟进记录，含阶段与预算',
    tableName: 'crm_customers_2026Q3.xlsx',
    fields: [
      { name: '客户编号', semantic: '客户编号', format: '字符串', missing: '0%', issue: '—', suggestion: '—', ontology: '客户.编号' },
      { name: '姓名', semantic: '客户姓名', format: '字符串', missing: '0%', issue: '—', suggestion: '—', ontology: '客户.姓名' },
      { name: '联系电话', semantic: '联系方式', format: '手机号', missing: '1%', issue: '2 条座机混填', suggestion: '拆分座机字段', ontology: '客户.电话' },
      { name: '小区/楼盘', semantic: '地址', format: '字符串', missing: '0%', issue: '别名不统一', suggestion: '挂接标准楼盘库', ontology: '客户.小区 → 楼盘' },
      { name: '面积(㎡)', semantic: '房屋属性', format: '数值', missing: '4%', issue: '—', suggestion: '—', ontology: '客户.面积' },
      { name: '预算(万)', semantic: '金额', format: '数值', missing: '6%', issue: '含“面议”文本', suggestion: '转空值并标注待跟进', ontology: '客户.预算' },
      { name: '当前阶段', semantic: '商机阶段', format: '枚举', missing: '0%', issue: '阶段口径 7 种', suggestion: '归并为 5 阶段标准漏斗', ontology: '客户.阶段' },
      { name: '跟进人', semantic: '人员', format: '字符串', missing: '0%', issue: '—', suggestion: '—', ontology: '客户.跟进人 → 人员' },
      { name: '最近跟进时间', semantic: '时间', format: '日期时间', missing: '0%', issue: '—', suggestion: '—', ontology: '客户.最近跟进' },
    ],
    sampleRows: [
      ['C-2026-0812', '陈女士', '138****6621', '滨江壹号', '128', '35'],
      ['C-2026-0819', '刘先生', '159****3307', '翡翠湾', '96', '22'],
      ['C-2026-0902', '周先生', '186****9012', '云境天澄', '143', '面议'],
      ['C-2026-0908', '吴女士', '137****5540', '滨江壹号', '89', '18'],
    ],
    mappings: [
      { source: '客户', target: '楼盘', relation: '房屋位于' },
      { source: '客户', target: '人员', relation: '由谁跟进' },
      { source: '客户', target: '商机阶段', relation: '处于' },
    ],
  },
]

// ─── 知识图谱 ───
export interface GraphNode {
  id: string
  name: string
  category: number
  value?: string
  desc?: string
}
export interface GraphEdge {
  source: string
  target: string
  relation: string
}

export const graphCategories = [
  { name: '系统', color: '#3370FF' },
  { name: '设备/测点', color: '#0EA5E9' },
  { name: '产线/楼盘', color: '#0D9488' },
  { name: '人员', color: '#F59E0B' },
  { name: '规则/计划', color: '#10B981' },
  { name: '客户/商机', color: '#EC4899' },
]

export const graphNodes: GraphNode[] = [
  { id: 'n1', name: '燃气电厂', category: 0, desc: '企业主体 · 2×460MW 机组' },
  { id: 'n2', name: '锅炉系统', category: 0, desc: 'DCS 子系统' },
  { id: 'n3', name: '汽机系统', category: 0, desc: 'DCS 子系统' },
  { id: 'n4', name: 'BL3-T-101 主汽温度', category: 1, value: '548℃', desc: '测点 · 量程 0~600℃ · 报警上限 575℃' },
  { id: 'n5', name: 'BL3-P-102 主汽压力', category: 1, value: '16.9MPa', desc: '测点 · 报警区间 16.2~17.8MPa' },
  { id: 'n6', name: 'TB2-V-201 轴振', category: 1, value: '86μm', desc: '测点 · 报警上限 125μm' },
  { id: 'n7', name: '高温报警规则', category: 2, desc: '规则库 R-011 · 主汽温度>575℃ 触发' },
  { id: 'n8', name: 'A产线', category: 2, desc: '化工厂产线' },
  { id: 'n9', name: '原料输送泵 PUMP-A-001', category: 1, desc: '设备 · 保养周期 90 天' },
  { id: 'n10', name: '酯化反应釜 REAC-A-002', category: 1, desc: '设备 · 投运 2019-11-20' },
  { id: 'n11', name: '保养计划 9月', category: 2, desc: '由设备台账自动生成' },
  { id: 'n12', name: '王工（设备主管）', category: 3, desc: '人员 · 负责 A 产线' },
  { id: 'n13', name: '滨江壹号', category: 2, desc: '楼盘 · 装修公司重点小区' },
  { id: 'n14', name: '陈女士 C-2026-0812', category: 5, desc: '客户 · 128㎡ · 预算 35 万 · 量房阶段' },
  { id: 'n15', name: '刘先生 C-2026-0819', category: 5, desc: '客户 · 96㎡ · 预算 22 万 · 报价阶段' },
  { id: 'n16', name: '设计师 林然', category: 3, desc: '人员 · 跟进 12 位客户' },
  { id: 'n17', name: '7日未跟进提醒', category: 4, desc: '规则库 R-023 · 商机停滞预警' },
  { id: 'n18', name: '报价生成 Skill', category: 4, desc: '技能 · 面积×单价系数×工艺包' },
  { id: 'n19', name: '运行健康周报 Skill', category: 4, desc: '技能 · 测点越限统计+趋势研判' },
]

export const graphEdges: GraphEdge[] = [
  { source: 'n2', target: 'n1', relation: '部署于' },
  { source: 'n3', target: 'n1', relation: '部署于' },
  { source: 'n4', target: 'n2', relation: '属于' },
  { source: 'n5', target: 'n2', relation: '属于' },
  { source: 'n6', target: 'n3', relation: '属于' },
  { source: 'n4', target: 'n7', relation: '触发' },
  { source: 'n5', target: 'n7', relation: '关联' },
  { source: 'n9', target: 'n8', relation: '属于' },
  { source: 'n10', target: 'n8', relation: '属于' },
  { source: 'n9', target: 'n11', relation: '生成' },
  { source: 'n10', target: 'n11', relation: '生成' },
  { source: 'n12', target: 'n8', relation: '负责' },
  { source: 'n12', target: 'n9', relation: '维护' },
  { source: 'n14', target: 'n13', relation: '房屋位于' },
  { source: 'n16', target: 'n14', relation: '跟进' },
  { source: 'n16', target: 'n15', relation: '跟进' },
  { source: 'n15', target: 'n17', relation: '命中' },
  { source: 'n18', target: 'n15', relation: '服务' },
  { source: 'n19', target: 'n4', relation: '读取' },
  { source: 'n19', target: 'n6', relation: '读取' },
]

// ─── MCP 工具 ───
export interface McpTool {
  name: string
  source: string
  type: '太忆内置' | '集成商封装'
  status: '已连接' | '待配置'
  calls: number
  desc: string
}

export const mcpTools: McpTool[] = [
  { name: 'timem.memory.search', source: 'TiMEM MCP Server', type: '太忆内置', status: '已连接', calls: 1284, desc: '记忆检索：按实体/时间/语义召回历史交互与案件' },
  { name: 'timem.rule.match', source: 'TiMEM MCP Server', type: '太忆内置', status: '已连接', calls: 967, desc: '规则匹配：命中规则库并返回动作建议' },
  { name: 'timem.knowledge.qa', source: 'TiMEM MCP Server', type: '太忆内置', status: '已连接', calls: 1531, desc: '知识问答：基于知识库切片的引用式回答' },
  { name: 'dcs.read_point', source: '电厂 DCS 接口（集成商封装）', type: '集成商封装', status: '已连接', calls: 402, desc: '读取指定测点实时值与历史曲线' },
  { name: 'scada.device.list', source: 'SCADA OPC-UA 网关（集成商封装）', type: '集成商封装', status: '已连接', calls: 318, desc: '查询设备台账与运行状态' },
  { name: 'crm.customer.query', source: '装修 CRM OpenAPI（集成商封装）', type: '集成商封装', status: '已连接', calls: 655, desc: '按阶段/小区/跟进人查询客户与商机' },
  { name: 'erp.order.query', source: 'ERP 接口（集成商封装）', type: '集成商封装', status: '待配置', calls: 0, desc: '查询销售订单与采购订单' },
]

// ─── Skill ───
export interface Skill {
  id: string
  name: string
  role: string
  scope: string
  steps: string[]
  usage: number
  status: '已发布' | '试运行' | '草稿'
  from: '太忆模板' | '流程节点生成' | '自建'
}

export const skills: Skill[] = [
  { id: 's1', name: '设备巡检管家', role: '设备工程师的数字同事', scope: 'SCADA 台账 + 保养规则 + 巡检知识库', steps: ['读取设备台账', '比对保养周期', '生成巡检工单', '人审后派发'], usage: 342, status: '已发布', from: '太忆模板' },
  { id: 's2', name: '运行健康周报', role: '电厂值长助手', scope: 'DCS 测点 + 报警规则 + 历史记忆', steps: ['统计越限测点', '趋势研判', '生成周报', '值长审阅'], usage: 56, status: '已发布', from: '流程节点生成' },
  { id: 's3', name: '报价生成', role: '家装设计师助手', scope: 'CRM 客户 + 报价知识库 + 工艺规则', steps: ['读取面积与工艺包', '匹配单价系数', '生成报价单', '设计师确认'], usage: 189, status: '已发布', from: '自建' },
  { id: 's4', name: '报警研判', role: '安全员助手', scope: 'DCS 实时点位 + GB30871 规则库', steps: ['接收报警', '关联图谱上下文', '给出处置建议', '记录处置结果'], usage: 78, status: '试运行', from: '太忆模板' },
  { id: 's5', name: '客户跟进提醒', role: '门店经理助手', scope: 'CRM 阶段 + 跟进规则', steps: ['扫描停滞商机', '生成跟进建议', '推送责任人'], usage: 0, status: '草稿', from: '流程节点生成' },
]

// ─── 太忆空间 ───
export const memoryItems = [
  { time: '09-12 14:32', entity: 'BL3-T-101 主汽温度', type: '报警处置', content: '温度触及 576℃ 触发高温报警，值长按建议减负荷 5%，15 分钟后回落至 561℃。处置过程已沉淀。', status: '已沉淀' },
  { time: '09-11 10:05', entity: '陈女士 C-2026-0812', type: '客户跟进', content: '量房完成，客户偏好现代简约、预算敏感点在水电改造，已关联报价生成 Skill 草稿。', status: '已沉淀' },
  { time: '09-10 16:48', entity: '原料输送泵 PUMP-A-001', type: '保养记录', content: '完成季度保养，更换机械密封。王工批注：该型号密封件寿命偏短，建议下次缩短周期至 75 天。', status: '已转规则' },
  { time: '09-09 09:20', entity: '刘先生 C-2026-0819', type: '审批轨迹', content: '报价单第 2 版被设计师修改：柜体板材升级为 ENF 级，修改原因已记录并进入报价规则。', status: '已转规则' },
  { time: '09-08 11:15', entity: 'TB2-V-201 轴振', type: '趋势研判', content: '轴振 7 日均线由 72μm 缓升至 86μm，系统预判 20 天内触及报警线，建议安排停机检查窗口。', status: '已沉淀' },
]

export const rules = [
  { id: 'R-011', name: '主汽温度高温报警', condition: 'BL3-T-101 > 575℃ 持续 60s', action: '推送值长 + 生成处置建议', source: '专家录入', status: true },
  { id: 'R-019', name: '密封件保养周期缩短', condition: 'PUMP-A 系列密封件更换', action: '下次保养周期 90 → 75 天', source: '审批轨迹沉淀', status: true },
  { id: 'R-023', name: '商机 7 日未跟进提醒', condition: '客户最近跟进 > 7 天且未签单', action: '提醒跟进人 + 抄送门店经理', source: '专家录入', status: true },
  { id: 'R-027', name: '报价板材升级规则', condition: '客户预算 > 30 万且有儿童', action: '默认推荐 ENF 级板材', source: '审批轨迹沉淀', status: true },
  { id: 'R-031', name: '轴振趋势预警', condition: '7 日均线周增幅 > 8%', action: '生成停机检查建议', source: '专家录入', status: false },
]

export const knowledgeDocs = [
  { name: '锅炉运行规程（2026 修订版）', type: '工艺规程', chunks: 342, updated: '09-01', project: '燃气电厂' },
  { name: 'GB30871 动火作业安全规范', type: '安全规范', chunks: 128, updated: '08-28', project: '燃气电厂' },
  { name: '酯化工艺操作手册', type: '工艺手册', chunks: 216, updated: '09-05', project: '化工厂' },
  { name: '2026 家装报价工艺包（标准版）', type: '报价知识', chunks: 95, updated: '09-10', project: '装修公司' },
  { name: '水电改造验收标准与常见增项', type: '验收标准', chunks: 74, updated: '09-06', project: '装修公司' },
]

// ─── 流程与组织 ───
export const processFlow = {
  nodes: [
    { id: 'p1', name: '线索登记', category: 0 },
    { id: 'p2', name: '上门量房', category: 0 },
    { id: 'p3', name: '方案设计', category: 0 },
    { id: 'p4', name: '报价审批', category: 1 },
    { id: 'p5', name: '签约收款', category: 1 },
    { id: 'p6', name: '施工派单', category: 0 },
    { id: 'p7', name: '节点验收', category: 1 },
    { id: 'p8', name: '竣工交付', category: 0 },
    { id: 'p9', name: '售后回访', category: 0 },
  ],
  edges: [
    { source: 'p1', target: 'p2', relation: '' },
    { source: 'p2', target: 'p3', relation: '' },
    { source: 'p3', target: 'p4', relation: '' },
    { source: 'p4', target: 'p5', relation: '' },
    { source: 'p5', target: 'p6', relation: '' },
    { source: 'p6', target: 'p7', relation: '' },
    { source: 'p7', target: 'p8', relation: '' },
    { source: 'p8', target: 'p9', relation: '' },
    { source: 'p7', target: 'p6', relation: '整改' },
  ],
}

export const orgTree = {
  name: '轩怡装饰',
  children: [
    { name: '总经办', children: [{ name: '总经理' }, { name: '运营总监' }] },
    { name: '设计部', children: [{ name: '首席设计师' }, { name: '设计师 ×6' }] },
    { name: '工程部', children: [{ name: '项目经理 ×4' }, { name: '管家 ×8' }, { name: '质检 ×2' }] },
    { name: '市场部', children: [{ name: '门店经理 ×3' }, { name: '顾问 ×12' }] },
  ],
}

// ─── 对话演示脚本 ───
export interface ChatScript {
  question: string
  skill: string
  toolCalls: { tool: string; detail: string }[]
  answer: string
  context: { entities: string[]; rules: string[]; memory: string }
  task?: { title: string; steps: { name: string; status: string }[] }
}

export const chatScripts: ChatScript[] = [
  {
    question: '#3锅炉这周运行状态怎么样？生成一份健康简报',
    skill: '运行健康周报',
    toolCalls: [
      { tool: 'dcs.read_point', detail: '读取 BL3-T-101 / BL3-P-102 / TB2-V-201 近 7 日曲线' },
      { tool: 'timem.rule.match', detail: '命中 R-011 高温报警规则、R-031 轴振趋势预警' },
      { tool: 'timem.memory.search', detail: '召回 09-12 高温报警处置记忆' },
    ],
    answer: '本周 #3 锅炉整体平稳，需关注两点：\n\n1. 主汽温度 09-12 触及 576℃ 报警一次，按 R-011 规则处置后回落，建议复核减温水调门响应；\n2. 汽轮机轴振 7 日均线由 72μm 升至 86μm，按当前斜率约 20 天触及报警线，建议在本月下旬负荷低谷安排停机检查窗口。\n\n简报已生成，提交值长审阅后可归档。',
    context: {
      entities: ['BL3-T-101 主汽温度', 'TB2-V-201 轴振', '#3 锅炉'],
      rules: ['R-011 高温报警', 'R-031 轴振趋势预警'],
      memory: '已写入：本周健康简报 v1（待审阅）',
    },
    task: {
      title: '长程任务：生成 #3 锅炉周度健康简报',
      steps: [
        { name: '检索图谱：定位 #3 锅炉关联测点', status: 'done' },
        { name: '读取 DCS 近 7 日点位数据', status: 'done' },
        { name: '规则匹配与趋势研判', status: 'done' },
        { name: '生成简报草稿', status: 'done' },
        { name: '值长审阅（人在回路）', status: 'waiting' },
      ],
    },
  },
  {
    question: '滨江壹号有哪些客户超过 7 天没跟进了？',
    skill: '客户跟进提醒',
    toolCalls: [
      { tool: 'crm.customer.query', detail: '筛选 小区=滨江壹号 且 最近跟进>7天' },
      { tool: 'timem.rule.match', detail: '命中 R-023 商机 7 日未跟进提醒' },
    ],
    answer: '滨江壹号有 2 位客户超过 7 天未跟进：\n\n1. 陈女士（C-2026-0812）：128㎡、预算 35 万，量房阶段，上次跟进 09-04，已停滞 10 天；\n2. 吴女士（C-2026-0908）：89㎡、预算 18 万，初谈阶段，上次跟进 09-05。\n\n已按 R-023 规则生成跟进建议并推送设计师林然，同时抄送门店经理。是否把陈女士的报价草稿一并生成？',
    context: {
      entities: ['滨江壹号', '陈女士 C-2026-0812', '吴女士 C-2026-0908'],
      rules: ['R-023 商机停滞提醒'],
      memory: '已写入：跟进提醒 ×2（09-14）',
    },
  },
  {
    question: 'A 产线下个月有哪些设备该保养了？',
    skill: '设备巡检管家',
    toolCalls: [
      { tool: 'scada.device.list', detail: '查询 A 产线设备台账与上次保养日期' },
      { tool: 'timem.memory.search', detail: '召回 09-10 密封件更换批注（周期缩短建议）' },
      { tool: 'timem.rule.match', detail: '命中 R-019 密封件保养周期缩短' },
    ],
    answer: 'A 产线 10 月应保养设备 3 台：\n\n1. 原料输送泵 PUMP-A-001：按 R-019 新周期 75 天计算，10 月 2 日到期（原计划 11 月）；\n2. 酯化反应釜 REAC-A-002：180 天周期，10 月 18 日到期；\n3. 气动调节阀 VALV-A-118：120 天周期，10 月 25 日到期。\n\n巡检工单草稿已生成，待王工确认后派发。',
    context: {
      entities: ['A 产线', 'PUMP-A-001', 'REAC-A-002', 'VALV-A-118'],
      rules: ['R-019 保养周期缩短'],
      memory: '已写入：10 月保养计划草稿（待确认）',
    },
  },
]

// ─── 首页看板 ───
export const projects = [
  { name: '燃气电厂智能运维', industry: '能源电力', stage: 3, stageText: 'Skill 配置', systems: ['DCS'], progress: 68 },
  { name: '化工厂设备管家', industry: '流程制造', stage: 2, stageText: '图谱构建', systems: ['SCADA', 'MES'], progress: 45 },
  { name: '轩怡装饰数字员工', industry: '家装服务', stage: 4, stageText: '试运行', systems: ['CRM', 'OA'], progress: 88 },
]

export const deliveryStages = ['数据接入', '图谱构建', 'Skill 配置', '上线试运行']

// ─── 项目（租户下的企业客户项目）───
export interface Project {
  id: string
  name: string
  enterprise: string
  industry: string
  systems: string[]
  tables: number
  entities: number
}

export const tenantProjects: Project[] = [
  { id: 'power', name: '燃气电厂智能运维', enterprise: '某燃气电厂', industry: '能源电力', systems: ['DCS'], tables: 3, entities: 1284 },
  { id: 'chem', name: '华精细化工智能工厂', enterprise: '华精细化工集团', industry: '流程制造', systems: ['DCS', 'SCADA', 'ERP', 'MES', 'OA'], tables: 5, entities: 2451 },
  { id: 'deco', name: '轩怡装饰数字员工', enterprise: '轩怡装饰', industry: '家装服务', systems: ['CRM', 'OA'], tables: 4, entities: 331 },
]

// ─── 大型企业多表接入（华精细化工）───
export interface EnterpriseTable {
  id: string
  name: string
  system: string
  file: string
  rows: number
  fieldCount: number
  status: '已入图谱' | '理解中' | '待确认'
  keyFields: { name: string; semantic: string; ontology: string }[]
}

export const chemTables: EnterpriseTable[] = [
  {
    id: 't-dcs', name: 'DCS 监测点表', system: 'DCS', file: 'dcs_tag_list.xlsx', rows: 1284, fieldCount: 12, status: '已入图谱',
    keyFields: [
      { name: 'TAG_NO', semantic: '测点编号', ontology: '测点.编号' },
      { name: 'TAG_DESC', semantic: '测点名称', ontology: '测点.名称' },
      { name: 'UNIT_NAME', semantic: '所属装置', ontology: '测点.所属装置 → 装置' },
      { name: 'HI_ALM / LO_ALM', semantic: '报警阈值', ontology: '测点.报警上限/下限' },
    ],
  },
  {
    id: 't-scada', name: 'SCADA 设备台账', system: 'SCADA', file: 'scada_devices.csv', rows: 356, fieldCount: 9, status: '已入图谱',
    keyFields: [
      { name: '设备位号', semantic: '设备编号', ontology: '设备.编号' },
      { name: '设备名称', semantic: '设备名称', ontology: '设备.名称' },
      { name: '所属工段', semantic: '装置归属', ontology: '设备.所属装置 → 装置' },
      { name: '保养周期(天)', semantic: '保养参数', ontology: '设备.保养周期' },
    ],
  },
  {
    id: 't-erp', name: 'ERP 采购合同表', system: 'ERP', file: 'erp_purchase_2026.xlsx', rows: 892, fieldCount: 14, status: '已入图谱',
    keyFields: [
      { name: 'PO_NUMBER', semantic: '合同编号', ontology: '采购合同.编号' },
      { name: 'VENDOR', semantic: '供应商', ontology: '采购合同.供应商 → 供应商' },
      { name: 'EQUIP_TAG', semantic: '关联设备', ontology: '采购合同.关联设备 → 设备' },
      { name: 'AMOUNT', semantic: '金额', ontology: '采购合同.金额' },
    ],
  },
  {
    id: 't-mes', name: 'MES 维修工单表', system: 'MES', file: 'mes_workorders.csv', rows: 567, fieldCount: 11, status: '已入图谱',
    keyFields: [
      { name: '工单号', semantic: '工单编号', ontology: '工单.编号' },
      { name: '设备位号', semantic: '关联设备', ontology: '工单.关联设备 → 设备' },
      { name: '故障描述', semantic: '故障现象', ontology: '工单.故障' },
      { name: '处理人', semantic: '维修人员', ontology: '工单.处理人 → 人员' },
    ],
  },
  {
    id: 't-oa', name: 'OA 人员花名册', system: 'OA', file: 'oa_staff.xlsx', rows: 218, fieldCount: 8, status: '待确认',
    keyFields: [
      { name: '工号', semantic: '人员编号', ontology: '人员.工号' },
      { name: '姓名', semantic: '人员姓名', ontology: '人员.姓名' },
      { name: '岗位', semantic: '岗位职责', ontology: '人员.岗位' },
      { name: '所属工段', semantic: '装置归属', ontology: '人员.所属装置 → 装置' },
    ],
  },
]

// 跨表同一本体对齐：不同字段名 → 同一本体节点
export const ontologyAlignment = [
  { ontology: '设备.编号', sources: ['SCADA.设备位号', 'ERP.EQUIP_TAG', 'MES.设备位号'], note: '三套系统同一设备编码口径，自动合并为同一设备实体' },
  { ontology: '测点.编号', sources: ['DCS.TAG_NO'], note: '测点与设备通过「安装于」关系挂接' },
  { ontology: '装置', sources: ['DCS.UNIT_NAME', 'SCADA.所属工段', 'OA.所属工段'], note: '“装置/工段”语义归一为同一层级' },
  { ontology: '人员', sources: ['MES.处理人', 'OA.姓名'], note: '工单向花名册自动对齐，补齐岗位信息' },
  { ontology: '供应商', sources: ['ERP.VENDOR'], note: '采购合同挂接设备，支撑备件溯源' },
]

// ─── 图谱节点 → 项目归属 ───
export const nodeProject: Record<string, string> = {
  n1: 'power', n2: 'power', n3: 'power', n4: 'power', n5: 'power', n6: 'power', n7: 'power', n19: 'power',
  n8: 'chem', n9: 'chem', n10: 'chem', n11: 'chem', n12: 'chem',
  n13: 'deco', n14: 'deco', n15: 'deco', n16: 'deco', n17: 'deco', n18: 'deco',
}

// ─── 事件动态关联演示 ───
export const eventCategory = { name: '事件/记忆', color: '#EF4444' }

export const eventDemo = {
  title: '模拟事件：主汽温度 09-14 14:32 触及 576℃',
  nodes: [
    { id: 'ev1', name: '高温报警事件', category: 6, desc: '09-14 14:32 · 主汽温度 576℃ 持续 75s', value: '576℃' },
    { id: 'mem1', name: '处置记忆 09-12', category: 6, desc: '记忆流 · 上次同类事件处置过程已归档' },
  ],
  edges: [
    { source: 'ev1', target: 'n4', relation: '发生于' },
    { source: 'ev1', target: 'n7', relation: '触发' },
    { source: 'ev1', target: 'n19', relation: '调用' },
    { source: 'ev1', target: 'mem1', relation: '关联历史处置' },
    { source: 'mem1', target: 'n4', relation: '经验作用于' },
  ],
  narrative: '事件发生瞬间，图谱自动完成动态关联：定位测点 → 触发规则 → 调用 Skill → 召回 09-12 同类处置记忆作为决策上下文。本次处置完成后，新记忆将回写并与该测点、规则建立持久关联——图谱随经验持续生长。',
}

// ─── 记忆流分层 ───
export interface MemoryLayer {
  id: string
  level: string
  name: string
  desc: string
  count: number
  color: string
  items: { time: string; entity: string; content: string; tag?: string }[]
}

export const memoryLayers: MemoryLayer[] = [
  {
    id: 'fragment', level: 'L1', name: '碎片记忆', color: '#F59E0B',
    desc: '原始交互片段：告警、批注、录音转写、字段修改，秒级写入，保真不加工',
    count: 8642,
    items: [
      { time: '09-14 14:32:07', entity: 'BL3-T-101', content: 'DCS 推送：主汽温度 576.2℃，越限持续 75s', tag: '告警片段' },
      { time: '09-14 11:20:41', entity: 'PUMP-A-001', content: '王工批注：这个型号密封件上次用了不到 80 天', tag: '专家批注' },
      { time: '09-14 09:05:12', entity: '陈女士', content: '量房录音转写片段：客户提到“小孩房要用环保板”', tag: '语音转写' },
    ],
  },
  {
    id: 'session', level: 'L2', name: '会话记忆', color: '#0EA5E9',
    desc: '一次任务/对话的完整上下文：意图、调用、结论、人审结果',
    count: 1296,
    items: [
      { time: '09-14 14:40', entity: '#3 锅炉', content: '健康简报任务会话：检索 3 测点 → 命中 2 规则 → 简报 v1 → 值长审阅通过', tag: '任务会话' },
      { time: '09-13 16:22', entity: '刘先生', content: '报价会话：ENF 板材升级为设计师主动修改，原因“有儿童 + 预算充足”已记录', tag: '人审轨迹' },
      { time: '09-12 15:05', entity: 'BL3-T-101', content: '报警处置会话：减负荷 5% → 15 分钟回落 → 处置有效确认', tag: '处置会话' },
    ],
  },
  {
    id: 'report', level: 'L3', name: '日报 / 周报', color: '#14C0FF',
    desc: '按周期自动聚合：运行摘要、业务漏斗、异常 TOP 榜，可追溯回原始碎片',
    count: 186,
    items: [
      { time: 'W37 周报', entity: '燃气电厂', content: '报警 7 次（环比 -2），轴振缓升趋势需关注，建议下旬停机窗口', tag: '周报' },
      { time: '09-13 日报', entity: '轩怡装饰', content: '新增线索 4、量房 2、签约 1；滨江壹号 2 位客户停滞超 7 天', tag: '日报' },
      { time: 'W37 周报', entity: '华精细化工', content: 'A 产线保养完成率 92%，反应釜振动值连续 3 周小幅上行', tag: '周报' },
    ],
  },
  {
    id: 'profile', level: 'L4', name: '画像', color: '#10B981',
    desc: '实体长期特征：设备健康画像、客户偏好画像、人员经验画像',
    count: 342,
    items: [
      { time: '持续更新', entity: 'PUMP-A-001', content: '设备画像：故障间隔 78 天，密封件为薄弱部件，维修成本年均 4.2 万', tag: '设备画像' },
      { time: '持续更新', entity: '陈女士', content: '客户画像：预算敏感点在水电，偏好现代简约，重视环保等级，决策周期约 3 周', tag: '客户画像' },
      { time: '持续更新', entity: '王工', content: '人员画像：泵类设备专家，处置平均时长 2.1 小时，其批注 83% 被采纳为规则', tag: '人员画像' },
    ],
  },
  {
    id: 'foresight', level: 'L5', name: '前瞻预判', color: '#EF4444',
    desc: '基于趋势 + 规则 + 画像的未来事件预测，是记忆反哺决策的出口',
    count: 27,
    items: [
      { time: '预测窗口 20 天', entity: 'TB2-V-201', content: '轴振按当前斜率约 20 天触及 125μm 报警线，置信度 78%，建议下旬停机检查', tag: '设备预判' },
      { time: '预测窗口 14 天', entity: 'PUMP-A-001', content: '按画像故障间隔推算，10 月初密封件进入高风险期，建议备件提前到货', tag: '备件预判' },
      { time: '预测窗口 7 天', entity: '陈女士', content: '客户已停滞 10 天，流失概率升至 61%，建议 48 小时内由门店经理介入', tag: '商机预判' },
    ],
  },
]

// ─── 模块化中后台：模块注册表（类 RuoYi 装配）───
export interface ModuleDef {
  id: string
  name: string
  page: string
  category: '平台层' | 'TiMEM 上下文层' | '平台能力' | '订阅模块'
  desc: string
  core?: boolean        // 核心模块不可关闭
  available: boolean    // false = 可订阅未上线
  badge?: string
  deps?: string         // 依赖说明
}

export const moduleRegistry: ModuleDef[] = [
  // 平台层：智能体的创建、使用与分发
  { id: 'workspace', name: '工作台', page: 'workspace', category: '平台层', desc: '个人工作入口：任务、消息、Token 用量、最近使用、待办审批', available: true },
  { id: 'agent', name: '数字员工', page: 'agent', category: '平台层', desc: '对话工作台、MCP 执行链路、Skill 编排', core: true, available: true },
  { id: 'market', name: '智能体市场', page: 'market', category: '平台层', desc: '12 类通用智能体开箱即用，一键启用按需配置', available: true },
  { id: 'apps', name: '应用中心', page: 'apps', category: '平台层', desc: '8 大场景应用一键开启：问答、文档、会议、分析、审批、督办、客服、报告', available: true },
  { id: 'studio', name: '智能体工厂', page: 'studio', category: '平台层', desc: '五步向导创建智能体、低代码编排画布、草稿/试运行/发布流水线', available: true },
  // TiMEM 上下文层：图谱·记忆·规则·知识中间件（太忆上下文基础设施）
  { id: 'ingest', name: '数据接入', page: 'ingest', category: 'TiMEM 上下文层', desc: '字段表上传、自动理解、清洗建议、跨表本体对齐', core: true, available: true },
  { id: 'graph', name: '知识图谱', page: 'graph', category: 'TiMEM 上下文层', desc: '图谱构建、分项目查看、事件动态关联', available: true, deps: '依赖数据接入产出' },
  { id: 'space', name: 'TiMEM 空间', page: 'space', category: 'TiMEM 上下文层', desc: '上下文基础设施可视化：五层记忆流、规则库、多知识库挂载', available: true },
  { id: 'process', name: '流程与组织', page: 'process', category: 'TiMEM 上下文层', desc: '资料解析、流程/架构编排、节点生成 Skill', available: true },
  // 平台能力：工具、模型与运营
  { id: 'tools', name: '工具插件', page: 'tools', category: '平台能力', desc: 'TiMEM 中间件能力 + 客户系统 MCP 封装 + 通用插件，统一工具总线', available: true },
  { id: 'models', name: '模型管理', page: 'models', category: '平台能力', desc: '多模型接入与路由：语言/代码/视觉/向量/重排序，私有推理可计量', available: true },
  { id: 'ops', name: '运营驾驶舱', page: 'ops', category: '平台能力', desc: '调用量、Token、成功率、知识库命中率与今日任务一屏总览', available: true },
  // 订阅模块
  { id: 'monitor', name: '监控预警', page: '', category: '订阅模块', desc: '实时点位监控、异常预警、止损联动', available: false, badge: '可订阅' },
  { id: 'report', name: '报表大屏', page: '', category: '订阅模块', desc: '领导驾驶舱、经营分析可视化大屏', available: false, badge: '可订阅' },
  { id: 'approval', name: '审批中心', page: '', category: '订阅模块', desc: '人在回路审批流、轨迹自动沉淀为规则', available: false, badge: '可订阅' },
]

// ─── 角色权限（RuoYi 式）───
export interface RoleDef {
  id: string
  name: string
  desc: string
  userCount: number
  scope: string
}

export const roles: RoleDef[] = [
  { id: 'r-admin', name: '集成商管理员', desc: '租户级全部权限，含模块装配与白标', userCount: 2, scope: '全部项目' },
  { id: 'r-fde', name: '交付工程师', desc: '数据接入、图谱、Skill 配置与调试', userCount: 5, scope: '全部项目' },
  { id: 'r-boss', name: '企业管理员', desc: '客户侧管理：用户、规则启停、报表', userCount: 3, scope: '本企业项目' },
  { id: 'r-user', name: '业务用户', desc: '使用数字员工与知识问答，无配置权', userCount: 46, scope: '本企业项目' },
  { id: 'r-agent', name: '数字员工', desc: '通过 MCP 调用模块能力，写操作必经人审', userCount: 8, scope: '按 Skill 授权' },
]

export const rolePermissions: Record<string, Record<string, string>> = {
  // 模块 id → 角色 id → 权限（manage 管理 / use 使用 / view 只读 / '' 无）
  ingest:  { 'r-admin': 'manage', 'r-fde': 'manage', 'r-boss': 'view', 'r-user': '', 'r-agent': 'use' },
  graph:   { 'r-admin': 'manage', 'r-fde': 'manage', 'r-boss': 'view', 'r-user': 'view', 'r-agent': 'use' },
  agent:   { 'r-admin': 'manage', 'r-fde': 'manage', 'r-boss': 'use', 'r-user': 'use', 'r-agent': '' },
  space:   { 'r-admin': 'manage', 'r-fde': 'manage', 'r-boss': 'use', 'r-user': 'view', 'r-agent': 'use' },
  process: { 'r-admin': 'manage', 'r-fde': 'manage', 'r-boss': 'view', 'r-user': '', 'r-agent': '' },
  workspace:{ 'r-admin': 'use', 'r-fde': 'use', 'r-boss': 'use', 'r-user': 'use', 'r-agent': '' },
  studio:  { 'r-admin': 'manage', 'r-fde': 'manage', 'r-boss': 'use', 'r-user': '', 'r-agent': '' },
  tools:   { 'r-admin': 'manage', 'r-fde': 'manage', 'r-boss': 'view', 'r-user': '', 'r-agent': 'use' },
  models:  { 'r-admin': 'manage', 'r-fde': 'view', 'r-boss': 'view', 'r-user': '', 'r-agent': '' },
  market:  { 'r-admin': 'manage', 'r-fde': 'manage', 'r-boss': 'use', 'r-user': 'use', 'r-agent': '' },
  apps:    { 'r-admin': 'manage', 'r-fde': 'manage', 'r-boss': 'manage', 'r-user': 'use', 'r-agent': '' },
  ops:     { 'r-admin': 'manage', 'r-fde': 'view', 'r-boss': 'use', 'r-user': 'view', 'r-agent': '' },
  modules: { 'r-admin': 'manage', 'r-fde': '', 'r-boss': '', 'r-user': '', 'r-agent': '' },
  auth:    { 'r-admin': 'manage', 'r-fde': '', 'r-boss': 'manage', 'r-user': '', 'r-agent': '' },
  settings:{ 'r-admin': 'manage', 'r-fde': 'view', 'r-boss': 'view', 'r-user': '', 'r-agent': '' },
}

export const users = [
  { name: '陈工', account: 'chen.g@partner.cn', role: '集成商管理员', project: '全部项目', status: '启用' },
  { name: '李晓峰', account: 'lixf@partner.cn', role: '交付工程师', project: '华精细化工 / 燃气电厂', status: '启用' },
  { name: '王工', account: 'wangg@huajing.com', role: '企业管理员', project: '华精细化工', status: '启用' },
  { name: '林然', account: 'linran@xuanyi.cn', role: '业务用户', project: '轩怡装饰', status: '启用' },
  { name: '设备巡检管家', account: 'agent-inspect@timem', role: '数字员工', project: '华精细化工', status: '启用' },
  { name: '赵明', account: 'zhaom@xuanyi.cn', role: '业务用户', project: '轩怡装饰', status: '停用' },
]

// ─── 智能体市场（12 类通用智能体，开箱即用）───
export interface MarketAgent {
  id: string
  name: string
  cat: string
  desc: string
  tags: string[]
  rating: number
  calls: string
  status: '运行中' | '灰度中'
}

export const marketAgents: MarketAgent[] = [
  { id: 'a1', name: '智能问答 Agent', cat: '知识服务', desc: '多路对话与知识检索问答，回答强制引用来源、逐级可下钻', tags: ['多轮对话', '引用可溯', '置信度'], rating: 4.8, calls: '128.4k', status: '运行中' },
  { id: 'a2', name: '知识库助手 Agent', cat: '知识服务', desc: '企业知识库的挂载、召回测试与效果评估，多库统一检索', tags: ['召回测试', '命中率', '多库挂载'], rating: 4.7, calls: '98.2k', status: '运行中' },
  { id: 'a3', name: '文档写作 Agent', cat: '办公效率', desc: '方案、通知、纪要、报告等文档的草稿生成与润色改写', tags: ['模板库', '风格迁移', '版本管理'], rating: 4.6, calls: '74.5k', status: '运行中' },
  { id: 'a4', name: '会议纪要 Agent', cat: '办公效率', desc: '会议录音转写、要点提炼、待办提取并自动同步责任人', tags: ['转写', '待办提取', '同步'], rating: 4.7, calls: '66.9k', status: '运行中' },
  { id: 'a5', name: '数据分析 Agent', cat: '数据分析', desc: '自然语言取数绘图，自动生成图表与结论摘要', tags: ['取数绘图', '图表生成', '结论摘要'], rating: 4.5, calls: '58.1k', status: '运行中' },
  { id: 'a6', name: '报告生成 Agent', cat: '内容生成', desc: '日报/周报/检测报告初稿自动编制，引用数据可溯源', tags: ['报告初稿', '数据引用', '效率+70%'], rating: 4.8, calls: '45.3k', status: '运行中' },
  { id: 'a7', name: '翻译助手 Agent', cat: '办公效率', desc: '技术文档与商务文件多语互译，术语库自动对齐', tags: ['术语库', '双语对照'], rating: 4.4, calls: '39.8k', status: '运行中' },
  { id: 'a8', name: '合规审查 Agent', cat: '流程辅助', desc: '合同条款合规校验、风险点标注，匹配等保与行业规范', tags: ['条款校验', '风险标注', '等保三级'], rating: 4.6, calls: '32.5k', status: '运行中' },
  { id: 'a9', name: '预测性维护 Agent', cat: '数据分析', desc: '设备预警与根因分析，保养工单自动流转', tags: ['预警提前24-72h', '根因分析', '工单流转'], rating: 4.7, calls: '28.7k', status: '运行中' },
  { id: 'a10', name: '智能拆单 Agent', cat: '流程辅助', desc: '订单自动拆解排产，物料与产能约束校验', tags: ['拆单', '排产优化'], rating: 4.5, calls: '21.2k', status: '灰度中' },
  { id: 'a11', name: '政策解读 Agent', cat: '知识服务', desc: '政策匹配推送、申报事项在线跟踪，一网通办', tags: ['政策匹配', '申报跟踪'], rating: 4.6, calls: '18.9k', status: '运行中' },
  { id: 'a12', name: '客服工作台 Agent', cat: '客户服务', desc: '会话分流、智能应答、人工接管与服务质量评估', tags: ['智能应答', '人工接管'], rating: 4.5, calls: '52.6k', status: '运行中' },
]

export const agentCats = ['全部', '办公效率', '知识服务', '数据分析', '内容生成', '流程辅助', '客户服务']

// ─── 应用中心（8 大场景应用）───
export interface CenterApp {
  id: string
  name: string
  cat: string
  desc: string
  users: number
  updated: string
  status: '已上线' | '灰度中'
  on: boolean
  detail?: boolean
}

export const centerApps: CenterApp[] = [
  { id: 'app-qa', name: '智能问答应用', cat: '知识服务', desc: '内置知识问答、历史会话与引用溯源的一站式问答门户', users: 1286, updated: '08-26', status: '已上线', on: true },
  { id: 'app-doc', name: '文档中心', cat: '办公效率', desc: '团队文档统一管理，支持新建文档、状态流转与 AI 一键润色', users: 964, updated: '08-25', status: '已上线', on: true },
  { id: 'app-meeting', name: '会议助手', cat: '办公效率', desc: '会议全流程管理：会议列表、纪要生成与待办事项同步', users: 857, updated: '08-24', status: '已上线', on: true, detail: true },
  { id: 'app-data', name: '数据分析应用', cat: '数据分析', desc: '业务指标洞察与图表生成，支持自然语言取数与 AI 结论生成', users: 692, updated: '08-23', status: '已上线', on: true },
  { id: 'app-flow', name: '流程审批应用', cat: '流程辅助', desc: '审批流、状态流转与审批详情跟踪，支持通过/驳回/加签', users: 754, updated: '08-22', status: '已上线', on: true },
  { id: 'app-task', name: '任务督办应用', cat: '办公效率', desc: '任务看板、新建任务、状态切换与到期提醒的一体化督办工具', users: 416, updated: '08-21', status: '灰度中', on: false },
  { id: 'app-service', name: '客服工作台', cat: '客户服务', desc: '会话分流、智能应答、人工接管与服务质检的完整客服闭环', users: 1053, updated: '08-20', status: '已上线', on: true },
  { id: 'app-report', name: '报告中心', cat: '内容生成', desc: '报告模板库、生成记录、批量下载与定时生成配置', users: 576, updated: '08-19', status: '已上线', on: true },
]

export const meetingDetail = {
  stats: [
    { label: '会议总数', value: 5 }, { label: '进行中', value: 1 }, { label: '已生成纪要', value: 0 }, { label: '未完成任务', value: 2 },
  ],
  meetings: [
    { name: '项目 A 周例会', status: '进行中', time: '08-28 10:00–11:00', people: '当前用户、项目 A 产品组、项目 A 研发组', action: '' },
    { name: '平台月度运营复盘', status: '已结束', time: '08-27 16:00–17:30', people: '当前用户、运营组、数据组', action: '生成纪要' },
    { name: '项目 B 需求评审', status: '已结束', time: '08-26 14:00–15:30', people: '当前用户、项目 B 产品组、设计组', action: '生成纪要' },
  ],
  todos: [
    { text: '整理项目 A 需求问题清单', from: '项目 A 周例会', done: false },
    { text: '输出新手指引流程改造点', from: '平台月度运营复盘', done: false },
    { text: '整理项目 B 需求优先级', from: '项目 B 需求评审', done: true },
  ],
}

// ─── 运营驾驶舱 ───
export const opsStats = [
  { label: '智能体调用量', value: '12,842', delta: '+8.4% 较上一周期' },
  { label: '活跃用户', value: '1,863', delta: '+5.2% 较上一周期' },
  { label: 'Token 消耗', value: '426 万', delta: '+12.6% 较上一周期' },
  { label: '工具调用次数', value: '6,931', delta: '+6.1% 较上一周期' },
  { label: '知识库命中率', value: '91.6%', delta: '+1.4% 较上一周期' },
  { label: '平均响应时间', value: '1.24s', delta: '-3.8% 较上一周期' },
  { label: '调用成功率', value: '98.2%', delta: '+0.3% 较上一周期' },
  { label: '运行成功率', value: '99.2%', delta: '近 24 小时无重大异常' },
]

export const opsTrend = {
  days: ['08-22', '08-23', '08-24', '08-25', '08-26', '08-27', '08-28'],
  agent: [1580, 1690, 1820, 1750, 1960, 1880, 2162],
  tool: [820, 880, 940, 910, 1050, 990, 1341],
}

export const opsCatShare = [
  { name: '办公效率', value: 32 },
  { name: '知识服务', value: 26 },
  { name: '数据分析', value: 18 },
  { name: '内容生成', value: 12 },
  { name: '流程辅助', value: 8 },
  { name: '客户服务', value: 4 },
]

export const opsToken = { balance: '826.0 万', today: '12.8 万', forecast: '按当前消耗趋势，预计可用约 64 天' }

export const opsTasks = [
  { text: '审核待发布的 3 个智能体', from: '智能体工厂', due: '今天 18:00', done: false },
  { text: '确认知识库「流程制度知识库」的新增文档', from: '知识库', due: '今天 10:00', done: false },
  { text: '查看上周运营驾驶舱周报', from: '运营驾驶舱', done: true },
]

// ─── Skill 编排画布（DAG）───
export const flowCanvas = {
  nodes: [
    { id: 'f0', name: '开始', x: 40, y: 150, c: '#10B981' },
    { id: 'f1', name: '知识库检索', x: 180, y: 60, c: '#3370FF' },
    { id: 'f2', name: '本体查询', x: 180, y: 240, c: '#14C0FF' },
    { id: 'f3', name: '大模型推理', x: 340, y: 150, c: '#3370FF' },
    { id: 'f4', name: '置信度判断', x: 500, y: 150, c: '#F59E0B' },
    { id: 'f5', name: '输出结果', x: 660, y: 60, c: '#0EA5E9' },
    { id: 'f6', name: '转人工', x: 660, y: 240, c: '#EF4444' },
  ],
  edges: [
    { source: 'f0', target: 'f1' }, { source: 'f0', target: 'f2' },
    { source: 'f1', target: 'f3' }, { source: 'f2', target: 'f3' },
    { source: 'f3', target: 'f4' },
    { source: 'f4', target: 'f5', label: '≥ 0.85' },
    { source: 'f4', target: 'f6', label: '< 0.85' },
  ],
}

// ─── 知识库挂载管理 ───
export const knowledgeBases = [
  { name: '通用办公知识库', docs: 128, chunks: 9642, hit: '92.4%', enabled: true, updated: '08-28' },
  { name: '产品说明知识库', docs: 86, chunks: 7218, hit: '89.7%', enabled: true, updated: '08-24' },
  { name: '流程制度知识库', docs: 54, chunks: 4306, hit: '87.2%', enabled: true, updated: '08-28' },
  { name: '锅炉运行规程库', docs: 32, chunks: 2844, hit: '90.1%', enabled: true, updated: '08-18' },
  { name: '客服应答知识库', docs: 47, chunks: 3912, hit: '85.6%', enabled: false, updated: '08-15' },
  { name: '数据分析案例库', docs: 21, chunks: 1630, hit: '83.9%', enabled: true, updated: '08-12' },
]

// ─── 工作台（个人工作入口）───
export interface WsTask { id: string; title: string; source: string; due: string; priority: '高' | '中' | '低'; done: boolean }
export interface WsMessage { id: string; title: string; content: string; type: '系统' | '审批' | '运行'; read: boolean; time: string }

export const wsTasks: WsTask[] = [
  { id: 't1', title: '审核待发布的 3 个智能体', source: '智能体工厂', due: '今天 18:00', priority: '高', done: false },
  { id: 't2', title: '确认知识库「流程制度知识库」的新增文档', source: 'TiMEM 空间', due: '明天 10:00', priority: '中', done: false },
  { id: 't3', title: '审批：A 产线 PUMP-A-001 停机检查工单', source: '数字员工', due: '今天 16:00', priority: '高', done: false },
  { id: 't4', title: '查看上周运营驾驶舱周报', source: '运营驾驶舱', due: '本周五', priority: '低', done: true },
]

export const wsMessages: WsMessage[] = [
  { id: 'm1', title: '审批提醒', content: '设备巡检管家提交了 1 张停机检查工单，等待你处理', type: '审批', read: false, time: '10 分钟前' },
  { id: 'm2', title: '运行异常已自愈', content: '数据分析 Agent 出现 1 次超时，已自动重试成功', type: '运行', read: false, time: '1 小时前' },
  { id: 'm3', title: '图谱事件关联', content: 'TiMEM 检测到主汽温度越限事件，已自动关联 2 号锅炉画像与 3 条历史经验', type: '运行', read: false, time: '2 小时前' },
  { id: 'm4', title: '系统通知', content: '平台将于本周日凌晨进行例行维护', type: '系统', read: true, time: '昨天 18:30' },
]

export const wsApprovals = [
  { id: 'ap1', title: 'A 产线 PUMP-A-001 停机检查工单', from: '设备巡检管家', risk: '中风险', detail: '密封件画像进入高风险期，建议本周五低负荷窗口停机 2 小时检查', status: '' },
  { id: 'ap2', title: '对客发送：滨江壹号报价单 V2', from: '报价生成 Skill', risk: '中风险', detail: '按更新后的工艺包重算，总价 23.6 万，较 V1 上浮 4.2%', status: '' },
]

export const tokenUsage: Record<'today' | 'week' | 'month', { total: string; points: { label: string; tokens: number; calls: number }[] }> = {
  today: { total: '12.8 万', points: [
    { label: '08:00', tokens: 0.8, calls: 46 }, { label: '10:00', tokens: 2.1, calls: 118 }, { label: '12:00', tokens: 1.9, calls: 97 },
    { label: '14:00', tokens: 2.7, calls: 142 }, { label: '16:00', tokens: 3.1, calls: 168 }, { label: '18:00', tokens: 2.2, calls: 121 }] },
  week: { total: '86.4 万', points: [
    { label: '周一', tokens: 11.2, calls: 620 }, { label: '周二', tokens: 12.9, calls: 704 }, { label: '周三', tokens: 12.2, calls: 668 },
    { label: '周四', tokens: 13.6, calls: 742 }, { label: '周五', tokens: 14.9, calls: 815 }, { label: '周六', tokens: 9.6, calls: 512 }, { label: '周日', tokens: 12.0, calls: 638 }] },
  month: { total: '348.6 万', points: [
    { label: '第 1 周', tokens: 80.2, calls: 4380 }, { label: '第 2 周', tokens: 86.4, calls: 4699 },
    { label: '第 3 周', tokens: 91.2, calls: 5021 }, { label: '第 4 周', tokens: 90.8, calls: 4870 }] },
}

export const recentUsed = [
  { id: 'a1', kind: 'agent', name: '智能问答 Agent', time: '10 分钟前' },
  { id: 'app-doc', kind: 'app', name: '文档中心', time: '1 小时前' },
  { id: 'a5', kind: 'agent', name: '数据分析 Agent', time: '昨天 16:20' },
  { id: 'app-meeting', kind: 'app', name: '会议助手', time: '昨天 11:05' },
]

// ─── 模型管理（多模型接入与路由）───
export interface ModelInfo {
  id: string; name: string; type: string; provider: string; status: '已启用' | '已停用'
  isDefault: boolean; pricePer1k: number; contextLength: string; latencyMs: number
  successRate: number; calls: string; description: string; trend: number[]; updatedAt: string
}

export const models: ModelInfo[] = [
  { id: 'kimi-k3', name: 'Kimi K3', type: '通用语言模型', provider: '平台内置 · 私有推理', status: '已启用', isDefault: true, pricePer1k: 0.012, contextLength: '128K', latencyMs: 820, successRate: 99.6, calls: '48.6 万', description: '平台默认通用语言模型，兼顾效果与成本，适合绝大多数对话、生成与长程任务场景。', trend: [58, 61, 60, 65, 71, 68, 74], updatedAt: '08-26' },
  { id: 'zy-lite', name: 'ZY-Chat-Lite', type: '通用语言模型', provider: '平台内置 · 私有推理', status: '已启用', isDefault: false, pricePer1k: 0.004, contextLength: '32K', latencyMs: 320, successRate: 99.8, calls: '36.2 万', description: '轻量级语言模型，低延迟低成本，适合高频简单问答、字段理解与文本改写。', trend: [42, 45, 44, 48, 52, 50, 55], updatedAt: '08-25' },
  { id: 'zy-code', name: 'ZY-Code', type: '代码模型', provider: '平台内置', status: '已启用', isDefault: false, pricePer1k: 0.01, contextLength: '64K', latencyMs: 680, successRate: 99.4, calls: '8.4 万', description: '代码生成与理解专用模型，支撑 MCP 工具封装时的接口代码生成与参数映射。', trend: [9, 10, 11, 10, 12, 13, 14], updatedAt: '08-24' },
  { id: 'zy-vision', name: 'ZY-Vision', type: '视觉模型', provider: '平台内置', status: '已启用', isDefault: false, pricePer1k: 0.015, contextLength: '32K', latencyMs: 940, successRate: 99.1, calls: '3.6 万', description: '多模态视觉模型，支持扫描件识别、版面分析与图文混合问答，用于资料上传解析。', trend: [4, 4, 5, 5, 6, 5, 6], updatedAt: '08-23' },
  { id: 'timem-embed', name: 'TiMEM-Embed', type: '向量模型', provider: 'TiMEM 上下文基础设施', status: '已启用', isDefault: false, pricePer1k: 0.001, contextLength: '8K', latencyMs: 45, successRate: 99.9, calls: '126.8 万', description: '记忆与知识的向量化底座：记忆流检索、知识库召回、图谱语义对齐的基础组件。', trend: [150, 162, 158, 171, 185, 178, 196], updatedAt: '08-26' },
  { id: 'timem-rerank', name: 'TiMEM-Rerank', type: '重排序模型', provider: 'TiMEM 上下文基础设施', status: '已停用', isDefault: false, pricePer1k: 0.002, contextLength: '8K', latencyMs: 92, successRate: 99.7, calls: '64.3 万', description: '召回结果重排序，提升知识库问答与记忆检索的引用准确率，可随知识库挂载启停。', trend: [80, 84, 82, 88, 94, 91, 98], updatedAt: '08-22' },
]

// ─── 工具插件中心（通用插件，TiMEM 能力与客户系统封装沿用 mcpTools）───
export interface PluginTool {
  id: string; name: string; category: '检索增强' | '数据处理' | '消息集成' | '执行引擎'
  description: string; enabled: boolean; calls: string; version: string
}

export const pluginTools: PluginTool[] = [
  { id: 'web-search', name: '网页搜索', category: '检索增强', description: '接入公开网页搜索能力，为智能体提供实时信息检索。', enabled: true, calls: '8.2 万', version: 'v1.4' },
  { id: 'db-query', name: '数据库查询', category: '数据处理', description: '通过自然语言或 SQL 查询业务数据库，返回结构化结果。', enabled: true, calls: '5.6 万', version: 'v1.2' },
  { id: 'file-parse', name: '文件解析', category: '数据处理', description: '解析 PDF、Word、PPT 等常见文档，提取正文与表格内容，供流程资料解析使用。', enabled: true, calls: '4.8 万', version: 'v1.6' },
  { id: 'ocr', name: 'OCR 识别', category: '数据处理', description: '识别图片与扫描件中的文字，支持多语言与版面还原。', enabled: false, calls: '1.1 万', version: 'v1.1' },
  { id: 'sheet-process', name: '表格处理', category: '数据处理', description: '读取与加工 Excel / CSV 表格，支持筛选、聚合与透视——字段表接入的前置处理器。', enabled: true, calls: '6.9 万', version: 'v1.3' },
  { id: 'http-request', name: 'HTTP 请求', category: '执行引擎', description: '向外部系统发起 HTTP 请求，MCP 工具封装的底层执行器。', enabled: true, calls: '12.4 万', version: 'v2.0' },
  { id: 'code-exec', name: '代码执行', category: '执行引擎', description: '在隔离沙箱中执行 Python / JavaScript 代码片段，供数据分析智能体使用。', enabled: true, calls: '3.2 万', version: 'v1.0' },
  { id: 'workflow-trigger', name: '流程触发器', category: '执行引擎', description: '按事件或定时规则触发已编排的智能体工作流，驱动图谱事件联动。', enabled: true, calls: '2.8 万', version: 'v1.2' },
  { id: 'message-notify', name: '消息通知', category: '消息集成', description: '向站内消息、群组机器人推送通知，预警与待办的出口通道。', enabled: true, calls: '7.5 万', version: 'v1.5' },
  { id: 'email-send', name: '邮件发送', category: '消息集成', description: '通过 SMTP 或邮件服务接口发送邮件，支持附件与模板。', enabled: false, calls: '0.9 万', version: 'v1.0' },
]

// ─── 租户与品牌贴牌 ───
export interface Tenant {
  id: string; name: string; plan: string
  branding: { platformName: string; englishName?: string; shortName: string; logoText: string; primary: string; accent: string }
}

export const tenants: Tenant[] = [
  { id: 'standard', name: '标准版演示环境', plan: '标准版', branding: { platformName: '智悦智能平台', shortName: '智悦', logoText: '智', primary: '#3370FF', accent: '#14C0FF' } },
  { id: 'huajing', name: '华精细化工', plan: '项目版', branding: { platformName: '华精数智协同平台', shortName: '华精', logoText: '华', primary: '#0D9488', accent: '#3370FF' } },
  { id: 'power', name: '燃气电厂', plan: '项目版', branding: { platformName: '燃气电厂智慧运行平台', shortName: '电厂', logoText: '电', primary: '#1E40AF', accent: '#0EA5E9' } },
  { id: 'xuanyi', name: '轩怡装饰', plan: '项目版', branding: { platformName: '轩怡数字员工平台', shortName: '轩怡', logoText: '轩', primary: '#DB2777', accent: '#F59E0B' } },
]

export const themePresets = [
  { name: '飞书蓝', primary: '#3370FF', accent: '#14C0FF' },
  { name: '深空蓝', primary: '#1E3A8A', accent: '#0EA5E9' },
  { name: '青绿色', primary: '#0D9488', accent: '#059669' },
]

export interface Branding { platformName: string; englishName?: string; shortName: string; logoText: string; primary: string; accent: string }

export const defaultBranding: Branding = { platformName: '智悦智能平台', englishName: 'Aigility', shortName: '智悦', logoText: '智', primary: '#3370FF', accent: '#14C0FF' }

// ─── 智能体工厂 ───
export interface StudioAgent {
  id: string; name: string; category: string; description: string; tags: string[]
  modelId: string; prompt: string; temperature: number; knowledge: string[]; tools: string[]
  visibility: '企业内' | '仅自己'; releaseNote: string; status: '草稿' | '已发布'; updatedAt: string
}

export const studioSteps = ['基础信息', '能力配置', '知识配置', '工具配置', '发布配置']

export const studioSeed: StudioAgent[] = [
  { id: 'st1', name: '班组安全问答员', category: '知识服务', description: '面向一线班组的安全规程问答，强制引用规程条款', tags: ['安全规程', '引用可溯'], modelId: 'kimi-k3', prompt: '你是班组安全问答员……', temperature: 0.3, knowledge: ['锅炉运行规程库', '流程制度知识库'], tools: ['timem.memory.search', 'timem.rule.match'], visibility: '企业内', releaseNote: '首个版本', status: '草稿', updatedAt: '08-27' },
  { id: 'st2', name: '周报汇总助手', category: '内容生成', description: '汇总各项目周报素材，生成统一格式的汇总周报', tags: ['周报', '汇总'], modelId: 'zy-lite', prompt: '你是周报汇总助手……', temperature: 0.5, knowledge: ['通用办公知识库'], tools: ['sheet-process', 'message-notify'], visibility: '企业内', releaseNote: 'V1.0', status: '已发布', updatedAt: '08-25' },
]
