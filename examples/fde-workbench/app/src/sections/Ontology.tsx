import { useEffect, useRef, useState } from 'react'
import { useStore } from '@/store/AppContext'
import { PageHeader } from '@/components/bits'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import { fmtMoneyFull } from '@/types'
import {
  Waypoints, Database, Columns3, Compass, Upload, CheckCircle2, Sparkles,
  TriangleAlert, TrendingUp, Wrench, Send, Bot, User, CornerDownRight, ChevronRight,
  Users, FileStack, FileText, Rocket, RefreshCw, Network, BrainCircuit, ScrollText, Package,
  ArrowRight, GitMerge, MousePointerClick, Rotate3d, Grid2x2, Maximize2, Minimize2,
} from 'lucide-react'
import { toast } from 'sonner'
import { TwinGraph3D, type N3, type L3 } from '@/components/TwinGraph3D'

const daysUntil = (date: string) => Math.ceil((new Date(date).getTime() - Date.now()) / 86400000)
const daysSince = (date: string) => Math.floor((Date.now() - new Date(date).getTime()) / 86400000)
const confDot = (c: number) => c >= 0.9 ? 'bg-emerald-500' : c >= 0.7 ? 'bg-amber-400' : 'bg-rose-400'

/* ================= 数据源 → 本体实体 ================= */
interface FieldMap { from: string; to: string; conf: number }
interface DataSource {
  key: string
  table: string
  entity: string
  icon: typeof Users
  mappings: FieldMap[]
  confirmed: boolean
  /** 导入时的原始记录（原表头原值） */
  raw: Record<string, string>
  /** 映射后的统一实体属性 */
  unified: Record<string, string>
}

const INIT_SOURCES: DataSource[] = [
  {
    key: 'leads', table: 'leads 线索表', entity: '客户 · 线索', icon: Users, confirmed: true,
    mappings: [
      { from: '客户名称', to: 'customer.name', conf: 0.98 }, { from: '行业', to: 'customer.industry', conf: 0.98 },
      { from: '客户规模', to: 'customer.scale', conf: 0.95 }, { from: '线索来源', to: 'lead.source', conf: 0.96 },
      { from: '联系人', to: 'customer.contact', conf: 0.94 }],
    raw: { 客户名称: '中原石化装备', 行业: '石油化工', 客户规模: '中小', 线索来源: '官网', 联系人: '设备部李工', 备注: '展会接触，对设备记忆感兴趣' },
    unified: { 'customer.name': '中原石化装备', 'customer.industry': '石油化工（枚举）', 'customer.scale': '中小（枚举）', 'lead.source': '官网（枚举）', 'lead.stage': '新线索（初始状态）', 'lead.owner': '导入人（自动归属）' },
  },
  {
    key: 'proposals', table: 'proposals 方案表', entity: '方案 · 报价', icon: FileStack, confirmed: true,
    mappings: [
      { from: '方案标题', to: 'proposal.title', conf: 0.98 }, { from: '报价总额', to: 'proposal.total', conf: 0.97 },
      { from: '引用素材', to: 'proposal.materials', conf: 0.91 }],
    raw: { 方案标题: '天然气净化厂智能报警解决方案', 报价总额: '¥360,000', 引用素材: '客户背景；相似案例：化工园区报警降噪' },
    unified: { 'proposal.title': '天然气净化厂智能报警解决方案', 'proposal.total': '360000（数值 · 含税）', 'proposal.materials': '[客户背景, 案例:化工园区报警降噪]（数组）', 'proposal.version': '1（初始版本）' },
  },
  {
    key: 'contracts', table: 'contracts 合同表', entity: '合同 · 回款', icon: FileText, confirmed: true,
    mappings: [
      { from: '合同编号', to: 'contract.code', conf: 0.99 }, { from: '合同金额', to: 'contract.amount', conf: 0.98 },
      { from: '签约日期', to: 'contract.signDate', conf: 0.95 }],
    raw: { 合同编号: 'HT-2026-011', 客户: '宁夏电信 · 工业智能联合项目', 合同金额: '5,000,000 元', 销售类型: '间接', 签约日期: '2026/8/18' },
    unified: { 'contract.code': 'HT-2026-011', 'contract.amount': '5000000（数值）', 'contract.salesType': '间接（枚举）', 'contract.signDate': '2026-08-18（ISO 日期）', 'contract.customer': '→ 关联实体：客户' },
  },
  {
    key: 'deployments', table: 'deployments 部署台账', entity: '站点 · 部署', icon: Rocket, confirmed: true,
    mappings: [
      { from: '客户', to: 'site.customer', conf: 0.98 }, { from: '站点名称', to: 'site.name', conf: 0.98 },
      { from: '域名', to: 'site.domain', conf: 0.99 }, { from: '环境', to: 'site.env', conf: 0.97 },
      { from: '代码平台', to: 'site.platform', conf: 0.96 }, { from: '当前版本', to: 'site.version', conf: 0.97 },
      { from: '域名到期日', to: 'site.domainExpire', conf: 0.93 }],
    raw: { 客户: '华菱钢铁', 站点名称: '设备记忆演示站', 域名: 'demo-hlsteel.timem.site', 环境: '演示', 代码平台: 'gitea', 仓库地址: 'gitea.timem.internal/fde/hlsteel-demo', 域名到期日: '2026-11-30', 当前版本: 'v0.2' },
    unified: { 'site.customer': '→ 关联实体：客户（华菱钢铁）', 'site.name': '设备记忆演示站', 'site.domain': 'demo-hlsteel.timem.site', 'site.env': '演示（枚举）', 'site.platform': 'gitea（枚举）', 'site.version': 'v0.2（语义化版本）', 'site.domainExpire': '2026-11-30（ISO 日期）' },
  },
  {
    key: 'renewals', table: 'renewals 续费台账', entity: '订阅 · 续费', icon: RefreshCw, confirmed: false,
    mappings: [
      { from: '客户', to: 'subscription.customer', conf: 0.97 }, { from: '续费项目', to: 'subscription.item', conf: 0.88 },
      { from: '到期日期', to: 'subscription.dueDate', conf: 0.96 }, { from: '续费金额', to: 'subscription.amount', conf: 0.94 }],
    raw: { 客户: '可孚医疗', 续费项目: 'Token 流量包充值', 到期日期: '9月30日', 续费金额: '2万', 备注: '按量消耗，关注余额' },
    unified: { 'subscription.customer': '→ 关联实体：客户（可孚医疗）', 'subscription.item': 'Token 流量包（→ SKU 实体）', 'subscription.dueDate': '2026-09-30（年份自动补全）', 'subscription.amount': '20000（"2万"→数值）', 'subscription.status': '待续费（初始状态）' },
  },
  {
    key: 'partners', table: 'partners 渠道伙伴表', entity: '伙伴 · 分佣', icon: Network, confirmed: true,
    mappings: [
      { from: '伙伴名称', to: 'partner.name', conf: 0.98 }, { from: '地区', to: 'partner.region', conf: 0.95 },
      { from: '分成比例', to: 'partner.shareRate', conf: 0.92 }],
    raw: { 伙伴名称: '云脉科技', 地区: '西北', 分成比例: '15%', 联系方式: '王经理 138****2210' },
    unified: { 'partner.name': '云脉科技', 'partner.region': '西北', 'partner.shareRate': '0.15（百分比→小数）', 'partner.contact': '王经理（脱敏存储）', 'partner.role': '集成服务商（枚举）' },
  },
  {
    key: 'knowledge', table: 'knowledge 知识库', entity: '规则 · 案例 · 模板', icon: BrainCircuit, confirmed: true,
    mappings: [
      { from: '标题', to: 'asset.title', conf: 0.97 }, { from: '类型', to: 'asset.kind', conf: 0.96 },
      { from: '标签', to: 'asset.tags', conf: 0.95 }, { from: '来源', to: 'asset.source', conf: 0.93 }],
    raw: { 标题: '案例：天然气净化厂报警降噪', 类型: '案例', 标签: '案例,工业,报警降噪', 来源: '长庆油田交付验收' },
    unified: { 'asset.title': '案例：天然气净化厂报警降噪', 'asset.kind': 'node（本体类型）', 'asset.tags': '[案例, 工业, 报警降噪]（数组）', 'asset.source': '沉淀：长庆油田交付验收', 'asset.status': '已采纳（审阅状态机）' },
  },
  {
    key: 'audit', table: 'audit_log 审计日志', entity: '事件 · 留痕', icon: ScrollText, confirmed: false,
    mappings: [
      { from: '时间', to: 'event.at', conf: 0.99 }, { from: '操作人', to: 'event.actor', conf: 0.99 },
      { from: '动作内容', to: 'event.text', conf: 0.96 }, { from: '归属模块', to: 'event.module', conf: 0.9 }],
    raw: { 时间: '09-12 16:20', 操作人: '余宣庆', 动作内容: '部署台账录入：「设备记忆演示站」', 归属模块: 'deployments' },
    unified: { 'event.at': '2026-09-12T16:20（时间戳）', 'event.actor': '余宣庆（→ 人员实体）', 'event.text': '部署台账录入：「设备记忆演示站」', 'event.module': 'deployments（模块枚举）', 'event.type': '人在回路（动作分类）' },
  },
]

/* ================= 主动建议 ================= */
interface Insight {
  id: string
  level: '风险' | '机会' | '效率'
  title: string
  evidence: string[]
  action: string
}
const LEVEL_CLS: Record<Insight['level'], string> = {
  '风险': 'border-rose-200 bg-rose-50 text-rose-600',
  '机会': 'border-emerald-200 bg-emerald-50 text-emerald-600',
  '效率': 'border-blue-200 bg-blue-50 text-[#3370ff]',
}
const LEVEL_ICON: Record<Insight['level'], typeof TriangleAlert> = { '风险': TriangleAlert, '机会': TrendingUp, '效率': Wrench }

interface QA { role: 'user' | 'assistant'; text: string; refs?: string[] }

/* ================= ECharts 图谱（动态加载，不进入首屏包） ================= */
interface GraphNode { key: string; label: string; color: string; rel: string; x: number; y: number; count: number }

function TwinGraph({ nodes, expandedKey, instsFor, onPickEntity, onPickInst, fill }: {
  nodes: GraphNode[]
  /** 当前展开实例的实体 key（点击实体节点下钻） */
  expandedKey?: string | null
  instsFor: (key: string) => { id: string; name: string; sub: string }[]
  onPickEntity: (key: string | null) => void
  onPickInst: (id: string | null) => void
  fill?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const chartRef = useRef<{ dispose: () => void; resize: () => void } | null>(null)

  useEffect(() => {
    let disposed = false
    ;(async () => {
      const echarts = await import('echarts/core')
      const { GraphChart } = await import('echarts/charts')
      const { CanvasRenderer } = await import('echarts/renderers')
      const { TooltipComponent } = await import('echarts/components')
      echarts.use([GraphChart, CanvasRenderer, TooltipComponent])
      if (disposed || !ref.current) return
      const chart = echarts.init(ref.current)
      chartRef.current = chart as never
      // 暴露给测试/调试：精确读取节点像素坐标
      ;(ref.current as unknown as { __twinChart?: unknown }).__twinChart = chart

      // 展开的实体 → 环形排布的实例节点（最多 10 个，作为力导种子位置）
      const ent = nodes.find(n => n.key === expandedKey)
      const insts = ent ? instsFor(ent.key).slice(0, 10) : []
      const instNodes = insts.map((it, i) => {
        const a = (Math.PI * 2 * i) / Math.max(insts.length, 1) - Math.PI / 2
        return {
          id: `inst:${it.id}`, instId: it.id, entityKey: null,
          name: it.name.length > 12 ? it.name.slice(0, 11) + '…' : it.name,
          x: (ent!.x) + 120 * Math.cos(a), y: (ent!.y) + 120 * Math.sin(a),
          symbolSize: 20,
          itemStyle: { color: ent!.color, opacity: 0.85, shadowBlur: 8, shadowColor: ent!.color, borderColor: 'rgba(255,255,255,0.4)', borderWidth: 1 },
          label: { color: '#cbd5e1', fontSize: 9, fontWeight: 400 as const },
        }
      })

      chart.setOption({
        backgroundColor: '#0b1220',
        tooltip: { show: false },
        series: [{
          type: 'graph', layout: 'force', roam: true, draggable: true, zoom: 0.82,
          force: {
            initLayout: 'none', // 用预设坐标作为力导初始种子，展开更稳定
            repulsion: 800, edgeLength: [70, 190], gravity: 0.12, friction: 0.6, layoutAnimation: true,
          },
          label: { show: true, position: 'bottom', fontSize: 11, fontWeight: 600, color: '#e2e8f0' },
          edgeSymbol: ['none', 'arrow'], edgeSymbolSize: 6,
          edgeLabel: { show: true, fontSize: 9, color: '#7dd3fc', formatter: (p: { data: { rel?: string } }) => p.data.rel ?? '' },
          lineStyle: { color: 'rgba(125,180,250,0.45)', width: 1.2, type: 'dashed', curveness: 0.08 },
          emphasis: { focus: 'adjacency', lineStyle: { width: 2.5, color: '#60a5fa' } },
          data: [
            {
              id: 'twin', entityKey: null, name: `企业数字孪生`, x: 360, y: 185, fixed: true, symbolSize: 78,
              itemStyle: { color: '#3370ff', shadowBlur: 28, shadowColor: 'rgba(51,112,255,0.9)', borderColor: 'rgba(191,219,254,0.8)', borderWidth: 1.5 },
              label: { position: 'inside', color: '#fff', fontSize: 12, fontWeight: 700, formatter: '企业数字孪生' },
            },
            ...nodes.map(n => ({
              id: n.key, entityKey: n.key, name: `${n.label} ${n.count}`,
              x: n.x, y: n.y, symbolSize: 48,
              itemStyle: {
                color: n.color, opacity: 0.95, shadowBlur: 12, shadowColor: n.color,
                borderColor: expandedKey === n.key ? '#ffffff' : 'rgba(255,255,255,0.55)',
                borderWidth: expandedKey === n.key ? 2.5 : 1,
              },
              label: { color: n.color, formatter: `{b}`, textShadowBlur: 4, textShadowColor: n.color },
            })),
            ...instNodes,
          ],
          links: [
            // edgeLength 是数组时按 value 映射：实体间长边(1)，实体→实例短边(0)，实例贴着实体展开
            ...nodes.map(n => ({ source: 'twin', target: n.key, rel: n.rel, value: 1 })),
            ...insts.map(it => ({ source: expandedKey!, target: `inst:${it.id}`, value: 0 })),
          ],
        }],
      })
      chart.on('click', (p: unknown) => {
        const d = (p as { data?: { entityKey?: string | null; instId?: string } }).data
        if (d?.instId) { onPickInst(d.instId); return }
        onPickInst(null)
        onPickEntity(d?.entityKey ?? null)
      })
      const onResize = () => chart.resize()
      window.addEventListener('resize', onResize)
      if (disposed) { window.removeEventListener('resize', onResize); chart.dispose() }
      chartRef.current = chart as never
    })()
    return () => { disposed = true; chartRef.current?.dispose(); chartRef.current = null }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes.map(n => n.count).join(','), expandedKey])

  return <div ref={ref} className={fill ? 'h-full w-full' : 'h-[420px] w-full min-w-[520px] overflow-hidden rounded-xl'} />
}

/* ================= 页面 ================= */
export function Ontology() {
  const {
    leads, proposals, contracts, deployments, renewals, channels, partners, knowledge,
    activities, modules, skus, navigate, addTeamTask, addActivity, role,
  } = useStore()

  const [sources, setSources] = useState(INIT_SOURCES)
  const [mapSel, setMapSel] = useState('deployments')
  const [picked, setPicked] = useState<string | null>('deployments')
  const [view3d, setView3d] = useState(true)
  const [pickedInstance, setPickedInstance] = useState<string | null>(null)
  const [expandedEntity, setExpandedEntity] = useState<string | null>(null)
  const [fullscreen, setFullscreen] = useState(false)

  // ESC 退出全屏
  useEffect(() => {
    if (!fullscreen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFullscreen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [fullscreen])

  const recordCount = (k: string) =>
    k === 'leads' ? leads.length : k === 'proposals' ? proposals.length
    : k === 'contracts' ? contracts.length : k === 'deployments' ? deployments.length
    : k === 'renewals' ? renewals.length : k === 'partners' ? channels.length + partners.length
    : k === 'knowledge' ? knowledge.length : activities.length
  const totalRecords = leads.length + proposals.length + contracts.length + deployments.length + renewals.length + channels.length + partners.length + knowledge.length + activities.length
  const mappedFields = sources.reduce((s, x) => s + x.mappings.length, 0)
  const confirmedFields = sources.filter(x => x.confirmed).reduce((s, x) => s + x.mappings.length, 0)
  const pendingSources = sources.filter(s => !s.confirmed)

  const confirmMapping = (key: string) => {
    setSources(prev => prev.map(s => s.key === key ? { ...s, confirmed: true } : s))
    const s = sources.find(x => x.key === key)
    addActivity(`字段映射确认：「${s?.table}」→ 本体实体「${s?.entity}」，${s?.mappings.length} 个字段生效`, role.name, 'ontology')
    toast.success('字段映射已确认生效，本体同步更新')
  }

  /* ---------- 图谱节点（实时计数） ---------- */
  const graphNodes: GraphNode[] = [
    { key: 'leads', label: '客户', count: leads.length, x: 100, y: 70, color: '#3370ff', rel: '跟进' },
    { key: 'proposals', label: '方案', count: proposals.length, x: 90, y: 220, color: '#8b5cf6', rel: '生成' },
    { key: 'contracts', label: '合同', count: contracts.length, x: 220, y: 320, color: '#059669', rel: '签约' },
    { key: 'deployments', label: '站点', count: deployments.length, x: 420, y: 325, color: '#0ea5e9', rel: '部署' },
    { key: 'renewals', label: '订阅', count: renewals.length, x: 625, y: 260, color: '#f59e0b', rel: '续费' },
    { key: 'partners', label: '伙伴', count: channels.length + partners.length, x: 635, y: 90, color: '#f43f5e', rel: '协作' },
    { key: 'modules', label: '模块/SKU', count: modules.length + skus.length, x: 425, y: 40, color: '#10b981', rel: '组装' },
    { key: 'knowledge', label: '知识资产', count: knowledge.length, x: 200, y: 30, color: '#6366f1', rel: '沉淀' },
    { key: 'audit', label: '事件', count: activities.length, x: 545, y: 175, color: '#64748b', rel: '留痕' },
  ]

  /* 点击节点 → 属性与实例 */
  const entityDetail = (key: string | null): { title: string; attrs: FieldMap[]; instances: { id: string; name: string; sub: string }[] } | null => {
    if (!key) return null
    const src = sources.find(s => s.key === key)
    if (src) {
      const instances =
        key === 'leads' ? leads.map(l => ({ id: l.id, name: l.name, sub: `${l.industry} · ${l.stage} · ${l.owner}` }))
        : key === 'proposals' ? proposals.map(p => ({ id: p.id, name: p.title, sub: `${p.status} · v${p.version} · ${fmtMoneyFull(p.total)}` }))
        : key === 'contracts' ? contracts.map(c => ({ id: c.id, name: `${c.code} · ${c.customer}`, sub: `${fmtMoneyFull(c.amount)} · ${c.status}` }))
        : key === 'deployments' ? deployments.map(d => ({ id: d.id, name: d.site, sub: `${d.customer} · ${d.env} · ${d.currentVersion}` }))
        : key === 'renewals' ? renewals.map(r => ({ id: r.id, name: `${r.customer} · ${r.item}`, sub: `${r.dueDate} 到期 · ${r.status}` }))
        : key === 'partners' ? [...channels.map(c => ({ id: c.id, name: c.name, sub: `获客渠道 · 分佣 ${Math.round(c.commissionRate * 100)}%` })), ...partners.map(pa => ({ id: pa.id, name: pa.name, sub: `集成服务商 · 分成 ${Math.round(pa.shareRate * 100)}%` }))]
        : key === 'audit' ? activities.slice(0, 12).map(a => ({ id: a.id, name: a.text.length > 22 ? a.text.slice(0, 21) + '…' : a.text, sub: `${a.time} · ${a.source}` }))
        : knowledge.map(k => ({ id: k.id, name: k.title, sub: `${k.kind} · ${k.status} · 被引用 ${k.usedCount} 次` }))
      return { title: src.entity, attrs: src.mappings, instances }
    }
    if (key === 'modules') {
      return {
        title: '模块 · 标准产品 SKU',
        attrs: [
          { from: '模块名称', to: 'module.name', conf: 0.98 }, { from: '成熟度', to: 'module.maturity', conf: 0.97 },
          { from: 'SKU 类别', to: 'sku.kind', conf: 0.96 }, { from: '计费模式', to: 'sku.billing', conf: 0.95 }],
        instances: [
          ...modules.map(m => ({ id: m.id, name: m.name, sub: `${m.kind} · ${m.maturity}` })),
          ...skus.map(s => ({ id: s.id, name: s.name, sub: `${s.kind} · ${s.billing} · ${fmtMoneyFull(s.price)}/${s.unit}` })),
        ],
      }
    }
    return null
  }
  const detail = entityDetail(picked)

  /* ---------- 3D 实例级孪生全景（真实台账记录连成关系网） ---------- */
  const G3_GROUP = [
    { key: '客户', color: '#60a5fa' }, { key: '方案', color: '#a78bfa' }, { key: '合同', color: '#34d399' },
    { key: '站点', color: '#38bdf8' }, { key: '订阅', color: '#fbbf24' }, { key: '伙伴', color: '#fb7185' },
    { key: '产品', color: '#2dd4bf' }, { key: '知识', color: '#818cf8' },
  ]
  const g3Nodes: N3[] = [{ id: 'twin', name: '企业数字孪生', group: 'core', color: '#3370ff', val: 10, tip: `${totalRecords} 条记录 · 关系实时同步` }]
  const g3Links: L3[] = []
  const cust4 = (s: string) => s.slice(0, 4)
  // 知识节点先确定入选集合（被引用最多的 8 条 + 被方案参考的条目），避免悬空连线
  const kTop = [...knowledge].sort((a, b) => b.usedCount - a.usedCount)
  const kRefIds = new Set(proposals.flatMap(p => p.caseRefs.filter(r => r.kind === 'knowledge').map(r => r.id)))
  const kPicked = [...kTop.filter(k => kRefIds.has(k.id)), ...kTop.filter(k => !kRefIds.has(k.id)).slice(0, Math.max(0, 8 - kRefIds.size))]
  const kPickedIds = new Set(kPicked.map(k => k.id))
  leads.forEach(l => {
    g3Nodes.push({ id: l.id, name: l.name, group: '客户', color: '#60a5fa', val: 4.5, tip: `${l.industry} · ${l.stage} · 负责人 ${l.owner}` })
    g3Links.push({ source: 'twin', target: l.id, rel: '跟进' })
  })
  proposals.forEach(p => {
    g3Nodes.push({ id: p.id, name: p.title, group: '方案', color: '#a78bfa', val: 3.4, tip: `${p.status} · v${p.version} · ${fmtMoneyFull(p.total)}` })
    g3Links.push({ source: p.leadId, target: p.id, rel: '生成' })
    p.modules.forEach(m => g3Links.push({ source: p.id, target: m, rel: '组装' }))
    p.skus.forEach(s => g3Links.push({ source: p.id, target: s, rel: '组装' }))
    p.caseRefs.filter(r => r.kind === 'knowledge' && kPickedIds.has(r.id)).forEach(r => g3Links.push({ source: r.id, target: p.id, rel: '参考' }))
  })
  contracts.forEach(c => {
    g3Nodes.push({ id: c.id, name: `${c.code}`, group: '合同', color: '#34d399', val: 3.8, tip: `${c.customer} · ${fmtMoneyFull(c.amount)} · ${c.status}` })
    if (c.leadId) g3Links.push({ source: c.leadId, target: c.id, rel: '签约' })
  })
  deployments.forEach(d => {
    g3Nodes.push({ id: d.id, name: d.site, group: '站点', color: '#38bdf8', val: 3.2, tip: `${d.customer} · ${d.env} · ${d.currentVersion}` })
    if (d.leadId) g3Links.push({ source: d.leadId, target: d.id, rel: '部署' })
  })
  renewals.forEach(r => {
    g3Nodes.push({ id: r.id, name: `${r.customer} · ${r.item}`, group: '订阅', color: '#fbbf24', val: 2.8, tip: `${r.dueDate} 到期 · ${fmtMoneyFull(r.amount)} · ${r.status}` })
    const dep = deployments.find(x => cust4(x.customer) === cust4(r.customer))
    if (dep) g3Links.push({ source: dep.id, target: r.id, rel: '续费' })
  })
  partners.forEach(pa => {
    g3Nodes.push({ id: pa.id, name: pa.name, group: '伙伴', color: '#fb7185', val: 3, tip: `集成服务商 · 分成 ${Math.round(pa.shareRate * 100)}% · ${pa.region}` })
    pa.projects.forEach(cid => g3Links.push({ source: pa.id, target: cid, rel: '交付' }))
  })
  channels.forEach(c => {
    g3Nodes.push({ id: c.id, name: c.name, group: '伙伴', color: '#fb7185', val: 2.6, tip: `获客渠道 · 分佣 ${Math.round(c.commissionRate * 100)}%` })
  })
  modules.forEach(m => g3Nodes.push({ id: m.id, name: m.name, group: '产品', color: '#2dd4bf', val: 2.4, tip: `${m.kind} · ${m.maturity}` }))
  skus.forEach(s => g3Nodes.push({ id: s.id, name: s.name, group: '产品', color: '#2dd4bf', val: 2.2, tip: `${s.kind} · ${s.billing} · ${fmtMoneyFull(s.price)}/${s.unit}` }))
  kPicked.forEach(k =>
    g3Nodes.push({ id: k.id, name: k.title, group: '知识', color: '#818cf8', val: 2, tip: `${k.kind} · 被引用 ${k.usedCount} 次` }))

  /* 点击 3D 实例节点 → 属性明细 */
  const instanceDetail = (id: string | null): { title: string; badge: string; rows: [string, string][] } | null => {
    if (!id) return null
    const l = leads.find(x => x.id === id)
    if (l) return { title: l.name, badge: '客户', rows: [['行业', l.industry], ['规模', l.scale], ['阶段', l.stage], ['来源', l.source], ['负责人', l.owner], ['最近触点', l.lastTouchAt]] }
    const p = proposals.find(x => x.id === id)
    if (p) return { title: p.title, badge: '方案', rows: [['状态', p.status], ['版本', `v${p.version}`], ['报价', fmtMoneyFull(p.total)], ['模块', `${p.modules.length} 个`], ['SKU', `${p.skus.length} 个`], ['案例参考', `${p.caseRefs.length} 项`]] }
    const c = contracts.find(x => x.id === id)
    if (c) return { title: `${c.code} · ${c.customer}`, badge: '合同', rows: [['金额', fmtMoneyFull(c.amount)], ['状态', c.status], ['销售类型', c.salesType], ['回款节点', `${c.payments.length} 期`]] }
    const d = deployments.find(x => x.id === id)
    if (d) return { title: d.site, badge: '站点', rows: [['客户', d.customer], ['域名', d.domain], ['环境', d.env], ['平台', d.platform], ['当前版本', d.currentVersion], ['域名到期', d.domainExpire], ['最近更新', `${d.updatedAt}（${daysSince(d.updatedAt)} 天前）`]] }
    const r = renewals.find(x => x.id === id)
    if (r) return { title: `${r.customer} · ${r.item}`, badge: '订阅', rows: [['到期日', `${r.dueDate}（${daysUntil(r.dueDate)} 天后）`], ['金额', fmtMoneyFull(r.amount)], ['状态', r.status]] }
    const pa = partners.find(x => x.id === id)
    if (pa) return { title: pa.name, badge: '伙伴', rows: [['类型', '集成服务商'], ['地区', pa.region], ['分成比例', `${Math.round(pa.shareRate * 100)}%`], ['在交付项目', `${pa.projects.length} 个`], ['待结算', fmtMoneyFull(pa.pendingSettle)]] }
    const ch = channels.find(x => x.id === id)
    if (ch) return { title: ch.name, badge: '伙伴', rows: [['类型', `获客渠道 · ${ch.type}`], ['分佣比例', `${Math.round(ch.commissionRate * 100)}%`], ['在途线索', `${ch.inFlight} 条`], ['累计贡献', fmtMoneyFull(ch.totalContribution)]] }
    const m = modules.find(x => x.id === id)
    if (m) return { title: m.name, badge: '产品', rows: [['类别', m.kind], ['成熟度', m.maturity], ['能力', m.capabilities.join('、')]] }
    const s = skus.find(x => x.id === id)
    if (s) return { title: s.name, badge: '产品', rows: [['类别', s.kind], ['规格', s.spec], ['计费', `${s.billing} · ${fmtMoneyFull(s.price)}/${s.unit}`], ['捆绑点', s.binding]] }
    const k = knowledge.find(x => x.id === id)
    if (k) return { title: k.title, badge: '知识', rows: [['类型', k.kind], ['状态', k.status], ['来源', k.source], ['被引用', `${k.usedCount} 次`], ['影响成单', `${k.impactCount} 单`]] }
    const a = activities.find(x => x.id === id)
    if (a) return { title: a.text, badge: '事件', rows: [['时间', a.time], ['来源', a.source], ['所属模块', a.page]] }
    return null
  }
  const instDetail = instanceDetail(pickedInstance)

  /* ---------- 图谱舞台（普通/全屏共用） ---------- */
  const renderStage = (fs: boolean) => (
    <div className={fs ? 'flex h-full flex-col' : ''}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className={cn('flex items-center gap-2 text-[15px] font-semibold', fs ? 'text-slate-100' : 'text-slate-900')}>
          <Waypoints className="h-4 w-4 text-[#3370ff]" />企业本体图谱{fs && <span className="text-[11px] font-normal text-slate-400">全屏模式</span>}
        </h2>
        <div className="flex items-center gap-2">
          <div className="flex items-center rounded-lg border border-slate-200 bg-slate-50 p-0.5">
            <button onClick={() => setView3d(true)}
              className={cn('flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors',
                view3d ? 'bg-[#3370ff] text-white shadow-sm' : 'text-slate-500 hover:text-slate-700')}>
              <Rotate3d className="h-3 w-3" />3D 孪生全景
            </button>
            <button onClick={() => setView3d(false)}
              className={cn('flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors',
                !view3d ? 'bg-[#3370ff] text-white shadow-sm' : 'text-slate-500 hover:text-slate-700')}>
              <Grid2x2 className="h-3 w-3" />2D 类型视图
            </button>
          </div>
          <Button size="sm" variant="outline" className={cn('h-7 text-xs', fs && 'border-slate-600 bg-slate-800 text-slate-200 hover:bg-slate-700')}
            onClick={() => setFullscreen(!fs)}>
            {fs ? <Minimize2 className="h-3 w-3 mr-1" /> : <Maximize2 className="h-3 w-3 mr-1" />}
            {fs ? '退出全屏' : '全屏'}
          </Button>
        </div>
      </div>
      <p className={cn('mt-1.5 text-[11px]', fs ? 'text-slate-400' : 'text-slate-400')}>
        {view3d ? '实例级关系网 · 拖拽旋转 · 滚轮缩放 · 点击节点弹出属性卡片 · 粒子流即业务流向' : '实体类型力导图 · 点击实体节点展开/收起实例 · 节点可拖拽 · 点击节点弹出属性卡片'}
      </p>

      <div className={cn('relative mt-2', fs ? 'min-h-0 flex-1 overflow-hidden rounded-xl' : 'overflow-x-auto')}>
        <div className={cn('relative', fs ? 'h-full' : '')}>
          {view3d ? (
            <TwinGraph3D key={fs ? 'fs3' : 'n3'} nodes={g3Nodes} links={g3Links} fill={fs} onPick={id => setPickedInstance(id)} />
          ) : (
            <TwinGraph key={`${fs ? 'fs2' : 'n2'}`} nodes={graphNodes} fill={fs}
              expandedKey={expandedEntity}
              instsFor={k => entityDetail(k)?.instances ?? []}
              onPickEntity={k => {
                setPicked(k)
                setPickedInstance(null)
                setExpandedEntity(prev => (k === null ? null : prev === k ? null : k))
              }}
              onPickInst={id => setPickedInstance(id)} />
          )}

          {/* 点击节点的内部弹窗卡片：实例优先（2D 展开的实例与 3D 实例共用） */}
          {instDetail && (
            <div className="msg-in absolute right-3 top-3 z-10 w-80 max-w-[86%] rounded-xl border border-blue-400/30 bg-slate-900/85 p-4 shadow-2xl backdrop-blur-md">
              <div className="flex items-start justify-between gap-2">
                <h3 className="min-w-0 flex-1 text-[14px] font-semibold leading-snug text-slate-100">{instDetail.title}</h3>
                <span className="shrink-0 rounded border border-blue-400/40 bg-blue-500/20 px-1.5 py-0.5 text-[10px] font-medium text-blue-300">{instDetail.badge}</span>
                <button onClick={() => setPickedInstance(null)} className="shrink-0 text-slate-500 hover:text-slate-300">×</button>
              </div>
              <p className="mt-1 text-[10px] text-slate-500">实例属性 · 来自统一本体</p>
              <div className="mt-2 max-h-60 space-y-1.5 overflow-y-auto pr-1">
                {instDetail.rows.map(([k, v]) => (
                  <div key={k} className="flex gap-2 rounded-lg border border-slate-700/60 bg-slate-800/60 px-2.5 py-1.5 text-[11px]">
                    <span className="w-16 shrink-0 text-slate-500">{k}</span>
                    <span className="min-w-0 flex-1 break-all text-slate-200">{v}</span>
                  </div>
                ))}
              </div>
              <p className="mt-2 text-[10px] text-slate-500">关系已在图谱中高亮连接 · 点击空白处取消选中</p>
            </div>
          )}
          {!view3d && !instDetail && detail && (
            <div className="msg-in absolute right-3 top-3 z-10 w-80 max-w-[86%] rounded-xl border border-blue-400/30 bg-slate-900/85 p-4 shadow-2xl backdrop-blur-md">
              <div className="flex items-start justify-between gap-2">
                <h3 className="min-w-0 flex-1 text-[14px] font-semibold leading-snug text-slate-100">实体「{detail.title}」</h3>
                <span className="tnum shrink-0 rounded border border-slate-600 bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-300">{detail.instances.length} 个实例</span>
                <button onClick={() => setPicked(null)} className="shrink-0 text-slate-500 hover:text-slate-300">×</button>
              </div>
              <p className="mt-1 text-[10px] text-slate-500">属性结构（源字段 → 本体属性）</p>
              <div className="mt-2 space-y-1.5">
                {detail.attrs.map(a => (
                  <div key={a.to} className="flex items-center gap-1.5 rounded-lg border border-slate-700/60 bg-slate-800/60 px-2.5 py-1.5">
                    <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', confDot(a.conf))} />
                    <span className="tnum text-[10px] text-slate-400">{a.from}</span>
                    <ArrowRight className="h-3 w-3 shrink-0 text-slate-600" />
                    <span className="tnum text-[10px] text-slate-200">{a.to}</span>
                  </div>
                ))}
              </div>
              <p className="mt-2.5 text-[10px] text-slate-500">实时实例</p>
              <div className="mt-1.5 max-h-40 space-y-1.5 overflow-y-auto pr-1">
                {detail.instances.slice(0, 6).map(i => (
                  <div key={i.id} className="rounded-lg border border-slate-700/60 bg-slate-800/40 px-2.5 py-1.5">
                    <p className="text-[11px] font-medium leading-snug text-slate-200">{i.name}</p>
                    <p className="tnum mt-0.5 text-[9px] text-slate-500">{i.id} · {i.sub}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {view3d && (
        <div className="mt-3 flex flex-wrap gap-2">
          {G3_GROUP.map(g => (
            <span key={g.key} className={cn('flex items-center gap-1.5 text-[11px]', fs ? 'text-slate-400' : 'text-slate-500')}>
              <span className="h-2 w-2 rounded-full" style={{ background: g.color }} />{g.key}
            </span>
          ))}
          <span className={cn('tnum ml-auto text-[11px]', fs ? 'text-slate-500' : 'text-slate-400')}>{g3Nodes.length - 1} 个实例 · {g3Links.length} 条关系</span>
        </div>
      )}
    </div>
  )

  /* ---------- 主动决策建议 ---------- */
  const insights: Insight[] = []
  renewals.filter(r => r.status !== '已续费' && r.status !== '已流失').forEach(r => {
    const d = daysUntil(r.dueDate)
    if (d > 45) return
    const dep = deployments.find(x => x.customer.includes(r.customer.slice(0, 4)) || r.customer.includes(x.customer.slice(0, 4)))
    const stale = dep ? daysSince(dep.updatedAt) : 0
    insights.push({
      id: `ins-rn-${r.id}`, level: '风险',
      title: `「${r.customer}」${r.item} ${d} 天后到期（${fmtMoneyFull(r.amount)}）${dep && stale >= 14 ? '，且站点久未更新，存在流失风险' : ''}`,
      evidence: [`续费台账 · ${r.dueDate}`, ...(dep ? [`部署台账 · ${dep.site} 已 ${stale} 天未更新`] : [])],
      action: '本周发起续费沟通，同步最新版本能力',
    })
  })
  deployments.filter(d => d.status === '运行中' && daysSince(d.updatedAt) >= 14).forEach(d => {
    if (insights.some(i => i.title.includes(d.customer.slice(0, 4)))) return
    insights.push({
      id: `ins-dp-${d.id}`, level: '机会',
      title: `「${d.site}」已 ${daysSince(d.updatedAt)} 天未更新（${d.customer}）`,
      evidence: [`部署台账 · 当前版本 ${d.currentVersion}`, '规则库 · 沉默客户主动回访'],
      action: '主动回访，推送最新版本能力或收集反馈',
    })
  })
  proposals.filter(p => p.skus.length === 0).forEach(p => {
    const lead = leads.find(l => l.id === p.leadId)
    insights.push({
      id: `ins-p-${p.id}`, level: '机会',
      title: `《${p.title}》未组装标准产品（${lead?.name ?? ''}）`,
      evidence: ['方案库 · SKU 为空', '知识库 · 订阅类产品自带续费属性'],
      action: '补充记忆容量/Token 包，锁定长期订阅收入',
    })
  })
  const pendingK = knowledge.filter(k => k.status === '待审阅')
  if (pendingK.length >= 2) insights.push({
    id: 'ins-k', level: '效率',
    title: `${pendingK.length} 条知识候选积压待审，规则库更新停滞`,
    evidence: pendingK.slice(0, 2).map(k => `知识库 · ${k.title}`),
    action: '安排 30 分钟集中审阅，采纳后进入规则库生效',
  })
  partners.filter(pa => pa.pendingSettle > 0).forEach(pa => insights.push({
    id: `ins-pa-${pa.id}`, level: '效率',
    title: `「${pa.name}」交付分成 ${fmtMoneyFull(pa.pendingSettle)} 待结算`,
    evidence: ['伙伴台账 · 待结算', `在交付项目 ${pa.projects.length} 个`],
    action: '走结算流程，维护伙伴交付积极性',
  }))

  const [adopted, setAdopted] = useState<string[]>([])
  const [dismissed, setDismissed] = useState<string[]>([])
  const visibleInsights = insights.filter(i => !dismissed.includes(i.id)).slice(0, 6)

  const adoptInsight = (i: Insight) => {
    setAdopted(prev => [...prev, i.id])
    addTeamTask({
      title: `【本体建议】${i.title}`,
      detail: `建议动作：${i.action} · 依据：${i.evidence.join('；')}`,
      assignee: role.name, due: '本周',
      priority: i.level === '风险' ? '高' : i.level === '机会' ? '中' : '低',
      source: '本体建议',
    })
    addActivity(`主动建议采纳：「${i.title}」已转为团队任务`, role.name, 'ontology')
  }

  /* ---------- 问答 ---------- */
  const quickQs = ['长庆油田现在是什么情况？', '哪些客户 45 天内有续费到期？', '标准产品渗透情况怎么样？', '当前有哪些风险和建议？']
  const [qa, setQa] = useState<QA[]>([
    { role: 'assistant', text: `本体已就绪：${totalRecords} 条业务记录统一为 9 类实体、关系实时同步。可以直接问我任何客户全景、续费风险、产品渗透的问题，我的回答会标注引用的实体，可溯源。` },
  ])
  const [input, setInput] = useState('')

  const answer = (q: string): QA => {
    const hitLead = leads.find(l => q.includes(l.name.slice(0, 4)))
    const hitDep = deployments.find(d => q.includes(d.customer.slice(0, 4)))
    const name = hitLead?.name.slice(0, 4) ?? hitDep?.customer.slice(0, 4)
    if (name) {
      const l = leads.find(x => x.name.startsWith(name))
      const ps = proposals.filter(x => x.leadId === l?.id)
      const cs = contracts.filter(x => x.leadId === l?.id || x.customer.includes(name))
      const ds = deployments.filter(x => x.customer.includes(name) || (l && x.leadId === l.id))
      const rs = renewals.filter(x => x.customer.includes(name))
      const parts = [
        l ? `线索阶段「${l.stage}」（${l.industry} · ${l.scale}，负责人 ${l.owner}）` : '',
        ps.length ? `方案 ${ps.length} 份：${ps.map(x => `《${x.title}》${x.status} v${x.version} · ${fmtMoneyFull(x.total)}`).join('；')}` : '暂无方案',
        cs.length ? `合同 ${cs.length} 份：${cs.map(x => `${x.code} ${fmtMoneyFull(x.amount)} · ${x.status}`).join('；')}` : '暂无合同',
        ds.length ? `站点 ${ds.length} 个：${ds.map(x => `${x.site}（${x.env} · ${x.currentVersion} · ${daysSince(x.updatedAt)} 天前更新）`).join('；')}` : '暂无部署站点',
        rs.length ? `续费：${rs.map(x => `${x.item} ${x.dueDate} 到期 · ${x.status}`).join('；')}` : '暂无续费事项',
      ].filter(Boolean)
      return {
        role: 'assistant',
        text: `「${name}」的客户 360 视图：${parts.join('；')}。`,
        refs: [...(l ? [`线索 ${l.id}`] : []), ...ps.map(x => `方案 ${x.id}`), ...cs.map(x => `合同 ${x.id}`), ...ds.map(x => `站点 ${x.id}`), ...rs.map(x => `续费 ${x.id}`)],
      }
    }
    if (/续费|到期/.test(q)) {
      const list = renewals.filter(r => r.status !== '已续费' && r.status !== '已流失' && daysUntil(r.dueDate) <= 45)
      return {
        role: 'assistant',
        text: list.length
          ? `45 天内有 ${list.length} 项续费到期：${list.map(r => `「${r.customer}」${r.item} ${daysUntil(r.dueDate)} 天后到期（${fmtMoneyFull(r.amount)} · ${r.status}）`).join('；')}。建议按到期日倒序逐个发起沟通。`
          : '45 天内暂无续费到期事项。',
        refs: list.map(r => `续费 ${r.id}`),
      }
    }
    if (/渗透|标准产品|sku|SKU/.test(q)) {
      const withSku = proposals.filter(p => p.skus.length > 0)
      const skuValue = withSku.reduce((s, p) => s + p.skus.reduce((x, id) => x + (skus.find(k => k.id === id)?.price ?? 0), 0), 0)
      return {
        role: 'assistant',
        text: `标准产品渗透率 ${withSku.length}/${proposals.length} 份方案已组装 SKU，SKU 价值合计 ${fmtMoneyFull(skuValue)}（其中订阅类自带续费属性，是长期捆绑的主力）。${proposals.length - withSku.length > 0 ? `还有 ${proposals.length - withSku.length} 份方案未组装，已在主动建议中提示。` : '全部方案均已组装。'}`,
        refs: withSku.map(p => `方案 ${p.id}`),
      }
    }
    if (/风险|建议|决策/.test(q)) {
      const tops = insights.slice(0, 3)
      return {
        role: 'assistant',
        text: tops.length
          ? `基于本体交叉计算，当前最值得处理的 ${tops.length} 项：${tops.map((i, n) => `${n + 1}. [${i.level}] ${i.title}，建议${i.action}`).join('；')}。完整清单见「主动决策建议」，采纳后自动转待办。`
          : '当前没有需要处理的主动建议。',
        refs: tops.map(i => i.evidence[0]),
      }
    }
    return {
      role: 'assistant',
      text: `我基于企业本体回答：当前统一了 ${totalRecords} 条记录（线索 ${leads.length} · 方案 ${proposals.length} · 合同 ${contracts.length} · 站点 ${deployments.length} · 续费 ${renewals.length} · 伙伴 ${channels.length + partners.length} · 知识 ${knowledge.length}）。试试问某个客户的全景、续费到期或产品渗透。`,
    }
  }

  const ask = (text: string) => {
    const t = text.trim()
    if (!t) return
    setQa(prev => [...prev, { role: 'user', text: t }])
    setInput('')
    setTimeout(() => setQa(prev => [...prev, answer(t)]), 600)
  }

  const mapSrc = sources.find(s => s.key === mapSel) ?? sources[0]

  return (
    <div>
      <PageHeader
        title="企业本体 · 数字孪生"
        desc="把 FDE 方法先用在自己身上：接入数据 → 字段映射 → 本体图谱 → 主动决策与问答"
      />

      <Tabs defaultValue="sources">
        <TabsList className="bg-slate-100 mb-5 flex-wrap h-auto">
          <TabsTrigger value="sources" className="text-[13px]"><Database className="h-3.5 w-3.5 mr-1.5" />01 数据接入</TabsTrigger>
          <TabsTrigger value="mapping" className="text-[13px]">
            <Columns3 className="h-3.5 w-3.5 mr-1.5" />02 字段映射
            {pendingSources.length > 0 && <span className="tnum ml-1.5 rounded-full bg-amber-100 px-1.5 text-[10px] font-semibold text-amber-700">{pendingSources.length}</span>}
          </TabsTrigger>
          <TabsTrigger value="graph" className="text-[13px]"><Waypoints className="h-3.5 w-3.5 mr-1.5" />03 本体图谱</TabsTrigger>
          <TabsTrigger value="decide" className="text-[13px]">
            <Compass className="h-3.5 w-3.5 mr-1.5" />04 决策与问答
            {visibleInsights.filter(i => !adopted.includes(i.id)).length > 0 && (
              <span className="tnum ml-1.5 rounded-full bg-rose-100 px-1.5 text-[10px] font-semibold text-rose-600">{visibleInsights.filter(i => !adopted.includes(i.id)).length}</span>
            )}
          </TabsTrigger>
        </TabsList>

        {/* ============ 01 数据接入 ============ */}
        <TabsContent value="sources">
          <div className="rounded-2xl border border-slate-200/60 bg-white shadow-sm p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-[15px] font-semibold text-slate-900">业务数据表接入情况</h2>
                <p className="mt-1 text-xs text-slate-400">各业务系统的表导入后统一进入本体 · 新增数据走「数据导入」的解析-审阅-审批流</p>
              </div>
              <div className="flex items-center gap-2">
                <span className="tnum rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-[12px] text-slate-500">共 {totalRecords} 条记录</span>
                <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => navigate({ name: 'import' })}>
                  <Upload className="h-3 w-3 mr-1" />导入更多数据表
                </Button>
              </div>
            </div>
            <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {sources.map(s => (
                <button key={s.key} onClick={() => { setMapSel(s.key) }}
                  className="group rounded-xl border border-slate-200 bg-slate-50/50 p-4 text-left transition-colors hover:border-[#3370ff]">
                  <div className="flex items-center gap-2">
                    <s.icon className="h-4 w-4 shrink-0 text-slate-400 group-hover:text-[#3370ff]" />
                    <span className="tnum min-w-0 flex-1 truncate text-[13px] font-semibold text-slate-800">{s.table}</span>
                    {s.confirmed
                      ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                      : <span className="shrink-0 rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-600">待确认</span>}
                  </div>
                  <p className="mt-2 text-[11px] text-slate-400">→ 实体「{s.entity}」</p>
                  <p className="tnum mt-1.5 text-[20px] font-bold leading-none text-slate-900">{recordCount(s.key)}<span className="ml-1 text-[11px] font-normal text-slate-400">条</span></p>
                </button>
              ))}
            </div>
            <p className="mt-4 flex items-center gap-1.5 text-[11px] text-slate-400">
              <MousePointerClick className="h-3.5 w-3.5" />点击数据表卡片可查看字段映射与「原始 → 统一」对照（进入 02 字段映射）
            </p>
          </div>
        </TabsContent>

        {/* ============ 02 字段映射 ============ */}
        <TabsContent value="mapping">
          <div className="rounded-2xl border border-slate-200/60 bg-white shadow-sm p-6">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-[15px] font-semibold text-slate-900">字段映射审阅</h2>
              <span className="tnum text-[11px] text-slate-400">数字员工自动识别别名并归一 · {confirmedFields}/{mappedFields} 字段已确认 · 全程留痕</span>
            </div>

            {/* 数据表选择 */}
            <div className="mt-4 flex flex-wrap gap-1.5">
              {sources.map(s => (
                <button key={s.key} onClick={() => setMapSel(s.key)}
                  className={cn('tnum rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
                    mapSel === s.key ? 'border-[#3370ff] bg-[#3370ff] text-white' : 'border-slate-200 bg-white text-slate-600 hover:text-[#3370ff]')}>
                  {s.table}
                  {!s.confirmed && <span className="ml-1 text-[10px] opacity-80">· 待确认</span>}
                </button>
              ))}
            </div>

            {/* 字段映射明细 */}
            <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-5">
              <div className="lg:col-span-2">
                <p className="text-[12px] font-medium text-slate-500">映射明细（{mapSrc.table} → {mapSrc.entity}）</p>
                <div className="mt-2.5 space-y-2">
                  {mapSrc.mappings.map(m => (
                    <div key={m.from} className="flex items-center gap-2 rounded-lg border border-slate-100 bg-slate-50/60 px-3 py-2.5">
                      <span className={cn('h-2 w-2 shrink-0 rounded-full', confDot(m.conf))} title={`置信度 ${Math.round(m.conf * 100)}%`} />
                      <span className="tnum text-[12px] text-slate-600">{m.from}</span>
                      <ArrowRight className="h-3 w-3 shrink-0 text-slate-300" />
                      <span className="tnum text-[12px] font-medium text-slate-800">{m.to}</span>
                      <span className="tnum ml-auto text-[10px] text-slate-400">{Math.round(m.conf * 100)}%</span>
                    </div>
                  ))}
                </div>
                <div className="mt-4">
                  {mapSrc.confirmed ? (
                    <span className="flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[12px] font-medium text-emerald-600">
                      <CheckCircle2 className="h-3.5 w-3.5" />映射已确认生效 · 本体实时同步
                    </span>
                  ) : (
                    <Button className="w-full bg-[#3370ff] hover:bg-[#2952cc]" onClick={() => confirmMapping(mapSrc.key)}>
                      <CheckCircle2 className="h-4 w-4 mr-1.5" />确认映射 · 写入本体
                    </Button>
                  )}
                </div>
              </div>

              {/* 原始 → 统一 前后对照 */}
              <div className="lg:col-span-3">
                <p className="flex items-center gap-1.5 text-[12px] font-medium text-slate-500">
                  <GitMerge className="h-3.5 w-3.5 text-[#3370ff]" />「原始 → 统一」对照（以一条真实导入记录为例）
                </p>
                <div className="mt-2.5 grid grid-cols-1 gap-3 md:grid-cols-2">
                  <div className="rounded-xl border border-slate-200 bg-white">
                    <p className="border-b border-slate-100 px-3.5 py-2 text-[11px] font-semibold text-slate-400">导入时的原始记录</p>
                    <div className="space-y-2 p-3.5">
                      {Object.entries(mapSrc.raw).map(([k, v]) => (
                        <div key={k} className="flex gap-2 text-[12px]">
                          <span className="w-20 shrink-0 text-slate-400">{k}</span>
                          <span className="min-w-0 flex-1 break-all text-slate-600">{v}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="rounded-xl border border-[#3370ff]/30 bg-blue-50/40">
                    <p className="border-b border-[#3370ff]/10 px-3.5 py-2 text-[11px] font-semibold text-[#3370ff]">统一后的本体属性</p>
                    <div className="space-y-2 p-3.5">
                      {Object.entries(mapSrc.unified).map(([k, v]) => (
                        <div key={k} className="flex gap-2 text-[12px]">
                          <span className="tnum w-32 shrink-0 text-[#3370ff]/80">{k}</span>
                          <span className="min-w-0 flex-1 break-all text-slate-700">{v}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
                <p className="mt-2.5 text-[11px] leading-relaxed text-slate-400">
                  归一动作由数字员工执行：金额「2万」→ 20000、日期「9月30日」→ 2026-09-30、枚举标准化、客户名 → 关联实体。低置信字段需人工补录后才生效。
                </p>
              </div>
            </div>
          </div>
        </TabsContent>

        {/* ============ 03 本体图谱 ============ */}
        <TabsContent value="graph">
          <div className="rounded-2xl border border-slate-200/60 bg-white shadow-sm p-4 sm:p-5">
            {renderStage(false)}
          </div>
          {fullscreen && (
            <div className="fixed inset-0 z-50 flex flex-col bg-[#060b16]/95 p-4 sm:p-6 backdrop-blur">
              {renderStage(true)}
            </div>
          )}
        </TabsContent>

        {/* ============ 04 决策与问答 ============ */}
        <TabsContent value="decide">
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
            {/* 主动决策建议 */}
            <div className="rounded-2xl border border-slate-200/60 bg-white shadow-sm p-6 lg:col-span-2">
              <h2 className="flex items-center gap-2 text-[15px] font-semibold text-slate-900">
                <Sparkles className="h-4 w-4 text-[#3370ff]" />主动决策建议
              </h2>
              <p className="mt-1 text-[11px] text-slate-400">AI 基于本体交叉计算（续费 × 站点活跃度 × SKU 渗透 × 知识积压），预测式给出建议，人确认后执行</p>
              <div className="mt-4 space-y-2.5">
                {visibleInsights.length === 0 && (
                  <p className="rounded-lg border border-dashed border-slate-200 py-8 text-center text-[12px] text-slate-400">当前没有待处理的建议</p>
                )}
                {visibleInsights.map(i => {
                  const Icon = LEVEL_ICON[i.level]
                  const done = adopted.includes(i.id)
                  return (
                    <div key={i.id} className={cn('rounded-xl border p-3.5', done ? 'border-emerald-200 bg-emerald-50/40' : 'border-slate-200 bg-slate-50/50')}>
                      <p className="flex items-start gap-2 text-[12px] font-medium leading-snug text-slate-800">
                        <span className={cn('flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-semibold', LEVEL_CLS[i.level])}>
                          <Icon className="h-3 w-3" />{i.level}
                        </span>
                        {i.title}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {i.evidence.map(e => (
                          <span key={e} className="tnum rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] text-slate-400">{e}</span>
                        ))}
                      </div>
                      <div className="mt-2.5 flex items-center gap-2">
                        <p className="min-w-0 flex-1 text-[11px] text-slate-500">建议：{i.action}</p>
                        {done ? (
                          <span className="flex shrink-0 items-center gap-1 text-[11px] font-medium text-emerald-600"><CheckCircle2 className="h-3 w-3" />已转待办</span>
                        ) : (
                          <>
                            <Button size="sm" className="h-6.5 shrink-0 bg-[#3370ff] px-2.5 text-[11px] hover:bg-[#2952cc]" onClick={() => adoptInsight(i)}>采纳转待办</Button>
                            <button onClick={() => setDismissed(prev => [...prev, i.id])} className="shrink-0 text-[11px] text-slate-400 hover:text-slate-600">忽略</button>
                          </>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>

            {/* 本体问答 */}
            <div className="rounded-2xl border border-slate-200/60 bg-white shadow-sm flex flex-col lg:col-span-3">
              <div className="border-b border-slate-100 px-5 py-3.5 flex flex-wrap items-center gap-2">
                <Bot className="h-4 w-4 text-[#3370ff]" />
                <span className="text-[15px] font-semibold text-slate-900">本体问答</span>
                <span className="text-xs text-slate-400">沿本体关系检索，回答标注引用实体，可溯源</span>
              </div>
              <div className="max-h-[460px] flex-1 overflow-y-auto px-4 py-4 space-y-4">
                {qa.map((m, i) => (
                  <div key={i} className={cn('msg-in flex gap-2.5', m.role === 'user' && 'flex-row-reverse')}>
                    <div className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-lg', m.role === 'assistant' ? 'bg-[#3370ff]' : 'bg-slate-300')}>
                      {m.role === 'assistant' ? <Bot className="h-4 w-4 text-white" /> : <User className="h-4 w-4 text-white" />}
                    </div>
                    <div className={cn('max-w-[85%] rounded-lg px-3.5 py-2.5 text-[13px] leading-relaxed',
                      m.role === 'assistant' ? 'border border-slate-200 border-l-[3px] border-l-[#3370ff] bg-slate-50/60 text-slate-700' : 'bg-[#3370ff] text-white')}>
                      {m.text}
                      {m.refs && m.refs.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1.5 border-t border-slate-200 pt-2">
                          {m.refs.map(r => (
                            <span key={r} className="tnum flex items-center gap-1 rounded border border-blue-100 bg-blue-50/60 px-1.5 py-0.5 text-[10px] text-[#3370ff]">
                              <CornerDownRight className="h-2.5 w-2.5" />{r}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              <div className="border-t border-slate-100 p-4">
                <div className="mb-2.5 flex flex-wrap gap-1.5">
                  {quickQs.map(q => (
                    <button key={q} onClick={() => ask(q)} className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] text-slate-600 hover:border-[#3370ff] hover:text-[#3370ff] transition-colors">{q}</button>
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && ask(input)}
                    placeholder="问企业本体：客户全景 / 续费到期 / 产品渗透 / 风险建议…"
                    className="h-9 flex-1 rounded-md border border-slate-200 px-3 text-[13px] placeholder:text-slate-400 focus:border-[#3370ff]" />
                  <button onClick={() => ask(input)} className="flex h-9 w-9 items-center justify-center rounded-md bg-[#3370ff] text-white hover:bg-[#2952cc]">
                    <Send className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* 底座说明 */}
          <div className="mt-6 flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-slate-50/70 px-4 py-3 text-[12px] text-slate-500">
            <Package className="h-4 w-4 shrink-0 text-slate-400" />
            本体数据存于 PostgreSQL 单库（业务表即实体表，映射关系落库可回放）；AI 的识别与建议由 Harness 数字员工产出，人在回路确认后生效；整个本体通过
            <button onClick={() => navigate({ name: 'mcp' })} className="flex items-center gap-0.5 font-medium text-[#3370ff] hover:underline">
              MCP 连接器 <ChevronRight className="h-3 w-3" />
            </button>
            对外开放给其他 Harness 实例。
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}
