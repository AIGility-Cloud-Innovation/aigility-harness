/**
 * 产品板块模块注册表（manifest）—— 装配底座的清单侧
 *
 * 职责边界（docs/platform-module-plugin-design.md §4 / docs/插件与应用安装体系设计.md）：
 *  - manifest（本文件）随代码评审：名称/描述/图标强耦合的清单不进库；
 *  - 装配状态（开/关、预设）：PG app_modules / app_module_presets，经 /api/aigility/modules 读写；
 *  - 服务端只保留装配校验标志（platform.ts SERVER_MODULE_META：core / available）。
 * manifest 描述与装配有关的事实，页面实现照旧 —— 声明与实现分离。
 */

export type ModuleKind = 'page' | 'app-package'
export type ModuleCategory = '平台层' | 'TiMEM 上下文层' | '平台能力' | '订阅模块' | '应用包'

export interface ModuleManifest {
  id: string
  name: string
  kind: ModuleKind
  category: ModuleCategory
  desc: string
  /** 核心模块不可关闭（服务端 SERVER_MODULE_META.core 同步拒写） */
  core?: boolean
  /** false = 可订阅未上线（服务端拒写开关） */
  available: boolean
  /** 依赖说明（文案；依赖图拓扑校验留后续） */
  deps?: string
  badge?: string
  /** kind='page'：SPA 内路由 key */
  page?: string
  /** kind='app-package' 预留：redirect/iframe/inline 三态（S1/S2/S3），本期全部为 page */
  entry?: {
    mode: 'redirect' | 'iframe' | 'inline'
    url?: string
    routePrefix?: string
  }
  /** 依赖的封装 API 前缀（审计/权限归集用，标注性质） */
  serverRoutes?: string[]
  /** 依赖的引擎能力（标注性质，不驱动装载） */
  enginePlugins?: string[]
}

export const moduleRegistry: ModuleManifest[] = [
  // 平台层：智能体的创建、使用与分发
  { id: 'workspace', name: '工作台', kind: 'page', page: 'workspace', category: '平台层', desc: '个人工作入口：任务、消息、Token 用量、最近使用、待办审批', available: true },
  { id: 'agent', name: '数字员工', kind: 'page', page: 'agent', category: '平台层', desc: '对话工作台、MCP 执行链路、Skill 编排', core: true, available: true },
  { id: 'market', name: '智能体市场', kind: 'page', page: 'market', category: '平台层', desc: '12 类通用智能体开箱即用，一键启用按需配置', available: true },
  { id: 'apps', name: '应用中心', kind: 'page', page: 'apps', category: '平台层', desc: '8 大场景应用一键开启：问答、文档、会议、分析、审批、督办、客服、报告', available: true },
  { id: 'studio', name: '智能体工厂', kind: 'page', page: 'studio', category: '平台层', desc: '五步向导创建智能体、低代码编排画布、草稿/试运行/发布流水线', available: true },
  { id: 'tasks', name: '任务台账看板', kind: 'page', page: 'tasks', category: '平台层', desc: '所有人和 Agent 的任务统一管理：跨源收集（飞书/Gitea/群聊/agentd）、五要素复核、PDCA 状态流转、执行指派', core: true, available: true },
  // TiMEM 上下文层：图谱·记忆·规则·知识中间件（太忆上下文基础设施）
  { id: 'ingest', name: '数据接入', kind: 'page', page: 'ingest', category: 'TiMEM 上下文层', desc: '字段表上传、自动理解、清洗建议、跨表本体对齐', core: true, available: true },
  { id: 'graph', name: '知识图谱', kind: 'page', page: 'graph', category: 'TiMEM 上下文层', desc: '图谱构建、分项目查看、事件动态关联', available: true, deps: '依赖数据接入产出' },
  { id: 'space', name: 'TiMEM 空间', kind: 'page', page: 'space', category: 'TiMEM 上下文层', desc: '上下文基础设施可视化：五层记忆流、规则库、多知识库挂载', available: true },
  { id: 'process', name: '流程与组织', kind: 'page', page: 'process', category: 'TiMEM 上下文层', desc: '资料解析、流程/架构编排、节点生成 Skill', available: true },
  // 平台能力：工具、模型与运营
  { id: 'tools', name: '工具管理', kind: 'page', page: 'tools', category: '平台能力', desc: '工具插件安装/启停/卸载 + 能力总线 + MCP 工具总线，统一工具管理', available: true, serverRoutes: ['/api/aigility/plugins', '/api/aigility/dsh/tools'] },
  { id: 'orchestration', name: '编排管理', kind: 'page', page: 'orchestration', category: '平台能力', desc: '数据面工作流图形化管理：节点画布、条件分支、循环与编排委托', available: true, serverRoutes: ['/api/aigility/flows'] },
  { id: 'models', name: '模型管理', kind: 'page', page: 'models', category: '平台能力', desc: '多模型接入与路由：语言/代码/视觉/向量/重排序，私有推理可计量', available: true },
  { id: 'llm-sources', name: 'LLM 来源节点', kind: 'page', page: 'llm-sources', category: '平台能力', desc: '上游渠道与别名映射管理：来源健康、探活、增删别名，模型路由故障就地修复', available: true, serverRoutes: ['/api/aigility/llm-sources'] },
  { id: 'ops', name: '运营驾驶舱', kind: 'page', page: 'ops', category: '平台能力', desc: '调用量、Token、成功率、知识库命中率与今日任务一屏总览', available: true },
  { id: 'task-loop', name: '项目小助理运维', kind: 'app-package', category: '平台能力', desc: '机器人进程启停 / 凭证 / 配置 / 运行日志（看板已并入任务台账看板）', available: true, entry: { mode: 'redirect', url: 'task-loop-config' }, serverRoutes: ['/api/aigility/task-loop'] },
  { id: 'identity', name: '身份对齐', kind: 'page', page: 'identity', category: '平台能力', desc: '同一个人在 飞书/Gitea/太忆云 是同一个人：花名册自动匹配 + 人工审查绑定', available: true, serverRoutes: ['/api/aigility/identity'] },
  { id: 'team-memory', name: '团队记忆总结', kind: 'page', page: 'team-memory', category: '平台能力', desc: 'TiMEM 团队记忆日报/晨报：调度配置 / 凭证管理 / 一键生成 / 运行日志', available: true },
  { id: 'log-monitor', name: '日志监察员', kind: 'page', page: 'log-monitor', category: '平台能力', desc: '定时拉取目标日志匹配错误关键字并飞书告警：巡检自动化 / Webhook / 启停运维 / 运行日志', available: true, serverRoutes: ['/api/aigility/log-monitor'] },
  // 订阅模块
  { id: 'monitor', name: '监控预警', kind: 'page', category: '订阅模块', desc: '实时点位监控、异常预警、止损联动', available: false, badge: '可订阅' },
  { id: 'report', name: '报表大屏', kind: 'page', category: '订阅模块', desc: '领导驾驶舱、经营分析可视化大屏', available: false, badge: '可订阅' },
  { id: 'approval', name: '审批中心', kind: 'page', category: '订阅模块', desc: '人在回路审批流、轨迹自动沉淀为规则', available: false, badge: '可订阅' },
]
