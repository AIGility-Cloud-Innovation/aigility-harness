import { useState } from 'react'
import { useStore } from '@/store/AppContext'
import { PageHeader } from '@/components/bits'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  Plug2, Database, Server, Bot, ShieldCheck, Copy, Play, ChevronRight,
  Users, FileStack, Rocket, RefreshCw, BrainCircuit, ScrollText, Upload, Sparkles,
} from 'lucide-react'
import { toast } from 'sonner'

/** 对外暴露的 MCP 工具清单：内部业务后台（FastAPI + PG）的确定性能力，封装给外部 Harness 调用 */
interface McpTool {
  name: string
  desc: string
  module: string
  icon: typeof Users
  access: '只读' | '写入 · 需审批' | '只读 · 管理员'
}

const TOOLS: McpTool[] = [
  { name: 'fde.leads.query', desc: '查询线索列表，支持按阶段/行业/负责人筛选', module: '线索管理', icon: Users, access: '只读' },
  { name: 'fde.leads.create', desc: '创建线索草稿，进入工作台待确认队列', module: '线索管理', icon: Users, access: '写入 · 需审批' },
  { name: 'fde.proposals.get', desc: '获取方案三件套结构、报价与版本历史', module: '方案生成', icon: FileStack, access: '只读' },
  { name: 'fde.cases.recommend', desc: '按行业/模块/场景为方案检索相似案例参考', module: '方案生成', icon: Sparkles, access: '只读' },
  { name: 'fde.deployments.query', desc: '部署台账查询：站点、版本、域名到期、更新时间', module: '部署台账', icon: Rocket, access: '只读' },
  { name: 'fde.deployments.import', desc: '台账批量导入：数字员工解析后进入人工审阅队列', module: '数据导入', icon: Upload, access: '写入 · 需审批' },
  { name: 'fde.renewals.query', desc: '订阅续费台账查询：到期倒计时与跟进状态', module: '合同管理', icon: RefreshCw, access: '只读' },
  { name: 'fde.knowledge.search', desc: '知识库检索：经验规则 / 案例 / 模板 / 行业机理', module: '知识沉淀', icon: BrainCircuit, access: '只读' },
  { name: 'fde.audit.query', desc: '审计日志查询：按模块/时间/操作人筛选', module: '审计日志', icon: ScrollText, access: '只读 · 管理员' },
]

const ACCESS_CLS: Record<McpTool['access'], string> = {
  '只读': 'border-emerald-200 bg-emerald-50 text-emerald-600',
  '写入 · 需审批': 'border-amber-200 bg-amber-50 text-amber-600',
  '只读 · 管理员': 'border-slate-200 bg-slate-50 text-slate-500',
}

const CONFIG_JSON = `{
  "mcp_servers": {
    "timem-fde": {
      "url": "http://127.0.0.1:3400/mcp",
      "description": "TiMEM FDE 工作台连接器：线索/方案/合同/台账/知识/审计",
      "auth": { "type": "bearer", "token_env": "TIMEM_FDE_TOKEN" },
      "write_policy": "human_in_the_loop"
    }
  }
}`

export function Mcp() {
  const { leads, proposals, deployments, renewals, knowledge, activities, importBatches } = useStore()
  const [preview, setPreview] = useState<{ name: string; json: string } | null>(null)

  /** 试调用：用工作台实时数据构造一份真实的响应示例 */
  const tryCall = (t: McpTool) => {
    let payload: unknown
    switch (t.name) {
      case 'fde.leads.query':
        payload = { count: leads.length, items: leads.slice(0, 2).map(l => ({ id: l.id, name: l.name, industry: l.industry, stage: l.stage, owner: l.owner })) }
        break
      case 'fde.leads.create':
        payload = { status: 'pending_review', queue: '线索待确认', message: '草稿已进入工作台，需人工确认后正式入库' }
        break
      case 'fde.proposals.get': {
        const p = proposals[0]
        payload = { id: p?.id, title: p?.title, version: p?.version, total: p?.total, slides: p?.slides.length, caseRefs: p?.caseRefs.map(r => r.title) }
        break
      }
      case 'fde.cases.recommend':
        payload = { proposal: proposals[1]?.title, recommendations: [
          { kind: 'deployment', title: `${deployments[0]?.customer} · ${deployments[0]?.site}`, reason: '共用模块 · 报警降噪/经验沉淀' },
          { kind: 'knowledge', title: knowledge.find(k => k.kind === 'node')?.title, reason: '同行业 · 含对比数据与客户证言' },
        ] }
        break
      case 'fde.deployments.query':
        payload = { count: deployments.length, items: deployments.slice(0, 2).map(d => ({ customer: d.customer, site: d.site, env: d.env, version: d.currentVersion, domainExpire: d.domainExpire })) }
        break
      case 'fde.deployments.import':
        payload = { status: 'pending_review', batches: importBatches.length, message: '解析结果已进入人工审阅队列，审批通过后正式录入并留痕' }
        break
      case 'fde.renewals.query':
        payload = { count: renewals.length, items: renewals.slice(0, 2).map(r => ({ customer: r.customer, item: r.item, dueDate: r.dueDate, status: r.status })) }
        break
      case 'fde.knowledge.search':
        payload = { count: knowledge.length, items: knowledge.slice(0, 3).map(k => ({ id: k.id, kind: k.kind, title: k.title, status: k.status })) }
        break
      default:
        payload = { count: activities.length, items: activities.slice(0, 3) }
    }
    setPreview({ name: t.name, json: JSON.stringify(payload, null, 2) })
  }

  const copyConfig = async () => {
    try {
      await navigator.clipboard.writeText(CONFIG_JSON)
      toast.success('MCP 接入配置已复制，粘贴到 Harness 配置即可')
    } catch {
      toast.error('复制失败，请手动选择复制')
    }
  }

  return (
    <div>
      <PageHeader
        title="MCP 连接器"
        desc="把工作台封装成标准连接器/插件：内部传统业务后台，外部 MCP 工具封装，供任何 Harness 实例调用"
      />

      {/* 分层架构 */}
      <div className="rounded-2xl border border-slate-200/60 bg-white shadow-sm p-6">
        <h2 className="flex items-center gap-2 text-[15px] font-semibold text-slate-900">
          <Server className="h-4 w-4 text-[#3370ff]" />内部架构：传统后台打底，AI 做分析，MCP 做边界
        </h2>
        <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-3">
          <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
            <p className="flex items-center gap-2 text-[13px] font-semibold text-slate-800">
              <Database className="h-4 w-4 text-[#3370ff]" />业务后台（确定性）
            </p>
            <p className="mt-2 text-[12px] leading-relaxed text-slate-500">
              FastAPI + PostgreSQL 单库多职：线索、方案、合同、台账、权限、审计的增删改查全部走传统业务代码，
              事务一致、可审计、可回放——这部分不交给模型。
            </p>
            <div className="tnum mt-3 space-y-1 text-[11px] text-slate-400">
              <p>POST /api/leads · /api/proposals · /api/deployments</p>
              <p>PG 表：leads / proposals / contracts / deployments / audit_log …</p>
            </div>
          </div>
          <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
            <p className="flex items-center gap-2 text-[13px] font-semibold text-slate-800">
              <Bot className="h-4 w-4 text-indigo-500" />AI 数字员工（分析生成）
            </p>
            <p className="mt-2 text-[12px] leading-relaxed text-slate-500">
              方案撰写、案例推荐、导入解析、知识提炼这类「分析型」工作由 Harness 数字员工完成，
              产出全部进入人在回路审阅，确认后才落库。
            </p>
            <div className="mt-3 space-y-1 text-[11px] text-slate-400">
              <p>D2 认知 · 生成内容 → D4 编排 · 拆任务 → D5 行动 · 产出文件</p>
              <p>验收口径：审阅确认 / 修改 / 拒绝，全程留痕</p>
            </div>
          </div>
          <div className="rounded-xl border-2 border-dashed border-[#3370ff]/40 bg-blue-50/40 p-4">
            <p className="flex items-center gap-2 text-[13px] font-semibold text-[#3370ff]">
              <Plug2 className="h-4 w-4" />MCP Server（对外边界）
            </p>
            <p className="mt-2 text-[12px] leading-relaxed text-slate-600">
              业务后台的能力按 MCP 协议封装成工具，任何 Harness 实例把本页配置粘进去，
              就能把 FDE 工作台当作插件调用——写操作一律带 human_in_the_loop 策略。
            </p>
            <p className="tnum mt-3 text-[11px] text-slate-400">http://127.0.0.1:3400/mcp · Bearer 鉴权</p>
          </div>
        </div>
        <div className="mt-4 flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50/60 px-4 py-3 text-[13px] text-emerald-700">
          <ShieldCheck className="h-4 w-4 shrink-0" />
          分工原则：业务数据的生命周期由传统后台代码保证确定性；分析与生成由 AI 完成但不得直接落库，审批闸门在工作台内。
        </div>
      </div>

      {/* 工具清单 */}
      <div className="mt-6 rounded-2xl border border-slate-200/60 bg-white shadow-sm p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-[15px] font-semibold text-slate-900">对外工具清单（{TOOLS.length}）</h2>
          <span className="text-[11px] text-slate-400">点击「试调用」查看基于当前台账数据的真实响应结构</span>
        </div>
        <div className="mt-4 space-y-2">
          {TOOLS.map(t => (
            <div key={t.name} className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-100 bg-slate-50/50 px-4 py-3">
              <t.icon className="h-4 w-4 shrink-0 text-slate-400" />
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2">
                  <span className="tnum text-[13px] font-semibold text-slate-800">{t.name}</span>
                  <span className={cn('rounded border px-1.5 py-0.5 text-[10px] font-medium', ACCESS_CLS[t.access])}>{t.access}</span>
                </p>
                <p className="mt-0.5 text-[11px] text-slate-400">{t.desc} · 归属：{t.module}</p>
              </div>
              <Button size="sm" variant="outline" className="h-7 shrink-0 text-xs" onClick={() => tryCall(t)}>
                <Play className="h-3 w-3 mr-1" />试调用
              </Button>
            </div>
          ))}
        </div>

        {preview && (
          <div className="mt-4 rounded-xl border border-slate-200 bg-slate-900 p-4">
            <p className="flex items-center gap-2 text-[12px] font-medium text-slate-300">
              <ChevronRight className="h-3.5 w-3.5 text-emerald-400" />{preview.name} → 200 OK（示例响应，数据来自当前工作台）
            </p>
            <pre className="tnum mt-2 max-h-64 overflow-auto text-[11px] leading-relaxed text-emerald-200/90">{preview.json}</pre>
          </div>
        )}
      </div>

      {/* 接入配置 */}
      <div className="mt-6 rounded-2xl border border-slate-200/60 bg-white shadow-sm p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-[15px] font-semibold text-slate-900">接入任意 Harness 实例</h2>
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={copyConfig}>
            <Copy className="h-3 w-3 mr-1" />复制配置
          </Button>
        </div>
        <p className="mt-1 text-xs text-slate-400">把下面这段粘进 Harness 的 mcp_servers 配置，FDE 工作台即成为它的一个插件；写操作自动带审批策略。</p>
        <pre className="tnum mt-3 overflow-auto rounded-xl border border-slate-200 bg-slate-50/70 p-4 text-[12px] leading-relaxed text-slate-600">{CONFIG_JSON}</pre>
      </div>
    </div>
  )
}
