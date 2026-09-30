import { useEffect, useState } from 'react'
import { projects, deliveryStages, defaultBranding, type Branding } from '../mock/data'
import { fetchRegistry, fetchUsage, fetchTasks } from '../lib/harness'
import { Database, Network, Bot, Layers, ArrowRight, CheckCircle2 } from 'lucide-react'

/** 顶部四卡为真数据（registry/skill-registry/网关计量/任务板），加载失败显示 — */
interface RealStats {
  personas?: number
  skills?: number
  calls?: number
  tokens?: number
  openTasks?: number
}

export default function Dashboard({ go, branding = defaultBranding }: { go: (p: string) => void; branding?: Branding }) {
  const [real, setReal] = useState<RealStats>({})

  useEffect(() => {
    fetchRegistry()
      .then(r => setReal(prev => ({ ...prev, personas: r.personas?.length ?? 0, skills: r.skills?.length ?? 0 })))
      .catch(() => {})
    fetchUsage()
      .then(u => setReal(prev => ({ ...prev, calls: u.summary?.calls ?? 0, tokens: u.summary?.totalTokens ?? 0 })))
      .catch(() => {})
    fetchTasks()
      .then(ts => setReal(prev => ({ ...prev, openTasks: ts.filter(t => t.status === 'open' || t.status === 'running').length })))
      .catch(() => {})
  }, [])

  const stats = [
    { label: '引擎原生角色', value: real.personas, sub: '五域注册表 · 市场页可对话', icon: Bot, color: 'text-emerald-600 bg-emerald-50' },
    { label: '已发布技能', value: real.skills, sub: '智能体工厂真注册', icon: Layers, color: 'text-blue-600 bg-blue-50' },
    { label: 'LLM 调用（累计）', value: real.calls, sub: real.tokens != null ? `Token ${real.tokens.toLocaleString()} · 网关计量` : '网关全量计量', icon: Database, color: 'text-cyan-600 bg-cyan-50' },
    { label: '开放任务', value: real.openTasks, sub: '任务板实时派发中', icon: Network, color: 'text-sky-600 bg-sky-50' },
  ]

  return (
    <div className="space-y-6">
      {/* 欢迎条 */}
      <div className="rounded-2xl text-white p-7 relative overflow-hidden" style={{ background: `linear-gradient(100deg, ${branding.primary}, ${branding.accent})` }}>
        <div className="absolute -right-10 -top-16 w-64 h-64 rounded-full bg-white/10" />
        <div className="absolute right-24 -bottom-20 w-52 h-52 rounded-full bg-white/10" />
        <p className="text-white/80 text-sm mb-1">{branding.platformName} · 自进化数字员工中后台（标准版）</p>
        <h1 className="text-2xl font-semibold mb-2">让 AI 能力快速进入业务场景</h1>
        <p className="text-white/80 text-sm max-w-2xl leading-relaxed">可配置、可贴牌、可快速交付的智能体平台标品：智能体创建、编排、发布、运行与运营全流程开箱即用；底层由 <b>TiMEM 上下文基础设施</b>（图谱 · 记忆 · 规则 · 知识中间件）统一供能，交付之后系统仍在自我进化。</p>
        <div className="flex gap-3 mt-5 flex-wrap">
          <button onClick={() => go('workspace')} className="bg-white text-sm font-medium px-4 py-2 rounded-lg hover:bg-white/90 transition flex items-center gap-1.5" style={{ color: branding.primary }}>
            进入工作台 <ArrowRight size={15} />
          </button>
          <button onClick={() => go('market')} className="border border-white/40 text-white text-sm px-4 py-2 rounded-lg hover:bg-white/10 transition">
            浏览智能体市场
          </button>
          <button onClick={() => go('ingest')} className="border border-white/40 text-white text-sm px-4 py-2 rounded-lg hover:bg-white/10 transition">
            接入企业数据（TiMEM）
          </button>
        </div>
      </div>

      {/* 指标（真 · registry/skill-registry/网关计量/任务表） */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {stats.map(s => (
          <div key={s.label} className="bg-white rounded-xl border border-slate-200/80 p-5 relative">
            <span className="absolute top-3 right-3 text-[10px] px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-600 border border-emerald-100">真</span>
            <div className={`w-9 h-9 rounded-lg flex items-center justify-center mb-3 ${s.color}`}>
              <s.icon size={18} />
            </div>
            <div className="text-2xl font-semibold text-slate-800">{s.value != null ? s.value.toLocaleString() : '—'}</div>
            <div className="text-sm text-slate-500 mt-0.5">{s.label}</div>
            <div className="text-xs text-slate-400 mt-1">{s.sub}</div>
          </div>
        ))}
      </div>

      {/* 项目卡片（演示数据） */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold text-slate-800">进行中的交付项目</h2>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-600 border border-amber-100">演示数据</span>
          </div>
          <span className="text-xs text-slate-400">交付四阶段：数据接入 → 图谱构建 → Skill 配置 → 上线试运行</span>
        </div>
        <div className="grid md:grid-cols-3 gap-4">
          {projects.map(p => (
            <div key={p.name} className="bg-white rounded-xl border border-slate-200/80 p-5 hover:shadow-md hover:border-blue-200 transition cursor-pointer" onClick={() => go('ingest')}>
              <div className="flex items-start justify-between mb-3">
                <div>
                  <div className="font-medium text-slate-800">{p.name}</div>
                  <div className="text-xs text-slate-400 mt-1">{p.industry} · 接入 {p.systems.join(' / ')}</div>
                </div>
                <span className="text-xs px-2 py-1 rounded-full bg-blue-50 text-blue-600 whitespace-nowrap">{p.stageText}</span>
              </div>
              <div className="flex items-center gap-1.5 mb-2">
                {deliveryStages.map((st, i) => (
                  <div key={st} className="flex-1" title={st}>
                    <div className={`h-1.5 rounded-full ${i < p.stage ? 'bg-blue-500' : 'bg-slate-100'}`} />
                  </div>
                ))}
              </div>
              <div className="flex justify-between text-xs text-slate-400">
                <span>交付进度 {p.progress}%</span>
                {p.stage === 4 && <span className="text-emerald-600 flex items-center gap-1"><CheckCircle2 size={12} />试运行中</span>}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 平台成效（演示数据 · 宣传口径） */}
      <div className="rounded-xl border border-slate-200/80 bg-white p-5">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold text-slate-800">平台成效 · 交付客户实测</h2>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-600 border border-amber-100">演示数据 · 宣传口径</span>
          </div>
          <span className="text-xs text-slate-400">数字员工：有岗位、有职责、有技能、可考核</span>
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[
            { v: '+70%', l: '报告编制效率', d: '检测报告/周报初稿自动生成' },
            { v: '24-72h', l: '设备预警提前量', d: '从被动响应到主动维护' },
            { v: '-60%', l: '权限运维成本', d: '角色×模块矩阵开箱即用' },
            { v: '99.9%', l: '平台可用性', d: '私有化部署 · 等保三级' },
          ].map(k => (
            <div key={k.l} className="rounded-xl bg-slate-50/80 border border-slate-100 p-4">
              <div className="text-2xl font-semibold bg-gradient-to-r from-blue-600 to-sky-500 bg-clip-text text-transparent">{k.v}</div>
              <div className="text-sm text-slate-700 mt-1">{k.l}</div>
              <div className="text-xs text-slate-400 mt-0.5">{k.d}</div>
            </div>
          ))}
        </div>
      </div>

      {/* 架构说明 */}
      <div className="grid md:grid-cols-2 xl:grid-cols-4 gap-4">
        {[
          { title: '静态层 · TiMEM 让数据被理解', desc: 'ERP / CRM / MES / SCADA / DCS / OA 多表接入，字段再乱也归一到同一本体，构建企业知识图谱。', page: 'graph', c: 'from-blue-500 to-cyan-500' },
          { title: '动态层 · 智能体能干活', desc: '数字员工基于 MCP 调用 TiMEM 中间件与客户系统 API，智能体工厂编排长程任务，人在回路审批。', page: 'agent', c: 'from-sky-500 to-cyan-400' },
          { title: '渠道层 · 智能体上飞书', desc: '在智能体工厂「角色能力」给 IM 渠道的 AI 角色勾选 Skill 与 MCP 工具，保存即热生效，机器人即刻按新能力对话。', page: 'studio', c: 'from-violet-500 to-purple-400' },
          { title: '自进化 · 越用越聪明', desc: '五层记忆流沉淀碎片→画像→预判，审批轨迹自动转规则，交付之后系统仍在持续增值。', page: 'space', c: 'from-emerald-500 to-teal-500' },
        ].map(b => (
          <div key={b.title} onClick={() => go(b.page)} className="bg-white rounded-xl border border-slate-200/80 p-5 cursor-pointer hover:shadow-md transition group">
            <div className={`h-1 w-10 rounded-full bg-gradient-to-r ${b.c} mb-4`} />
            <div className="font-medium text-slate-800 mb-1.5">{b.title}</div>
            <p className="text-sm text-slate-500 leading-relaxed">{b.desc}</p>
            <div className="text-xs text-blue-600 mt-3 opacity-0 group-hover:opacity-100 transition flex items-center gap-1">进入模块 <ArrowRight size={12} /></div>
          </div>
        ))}
      </div>
    </div>
  )
}
