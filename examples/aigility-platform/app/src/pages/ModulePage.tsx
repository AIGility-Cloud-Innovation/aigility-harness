import { moduleRegistry } from '../mock/data'
import { Blocks, LayoutGrid, Hexagon, Wrench, Lock, CheckCircle2, Building2 } from 'lucide-react'
import { useState } from 'react'

const catIcon: Record<string, any> = { 平台层: LayoutGrid, 'TiMEM 上下文层': Hexagon, 平台能力: Wrench, 订阅模块: Blocks }
const catDesc: Record<string, string> = {
  平台层: '智能体的创建、使用与分发',
  'TiMEM 上下文层': '图谱 · 记忆 · 规则 · 知识中间件（太忆上下文基础设施）',
  平台能力: '工具、模型与运营支撑',
  订阅模块: '面向业务场景的增值模块',
}

export default function ModulePage({ enabled, toggle }: { enabled: Set<string>; toggle: (id: string) => void }) {
  const [saved, setSaved] = useState(false)
  const cats = ['平台层', 'TiMEM 上下文层', '平台能力', '订阅模块'] as const

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-800">模块装配</h1>
          <p className="text-sm text-slate-500 mt-1">像搭积木一样组装企业的数字员工中后台 —— 开关即时生效，左侧导航实时变化；支持按项目覆盖配置</p>
        </div>
        <button onClick={() => setSaved(true)} className="text-sm px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700">保存为项目模板</button>
      </div>

      {saved && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3 text-xs text-emerald-700 flex items-center gap-2" style={{ animation: 'fadeSlide .3s ease' }}>
          <CheckCircle2 size={14} /> 已保存为「能源化工标准模板」，新建同类型项目时一键套用当前模块组合
        </div>
      )}

      {/* 项目覆盖选择（演示态） */}
      <div className="bg-white rounded-xl border border-slate-200/80 px-5 py-3.5 flex items-center gap-3 flex-wrap">
        <Building2 size={15} className="text-slate-400" />
        <span className="text-sm text-slate-600">当前配置作用于：</span>
        {['全部项目（默认）', '华精细化工', '燃气电厂', '轩怡装饰'].map((p, i) => (
          <span key={p} className={`text-xs px-3 py-1.5 rounded-full ${i === 0 ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-500'}`}>{p}</span>
        ))}
      </div>

      {cats.map(cat => (
        <div key={cat}>
          <div className="flex items-center gap-2 mb-3">
            <span className="w-8 h-8 rounded-lg bg-slate-100 text-slate-500 flex items-center justify-center">{(() => { const I = catIcon[cat]; return <I size={16} /> })()}</span>
            <h2 className="text-base font-semibold text-slate-800">{cat}</h2>
            <span className="text-xs text-slate-400">{catDesc[cat]}</span>
          </div>
          <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
            {moduleRegistry.filter(m => m.category === cat).map(m => {
              const on = enabled.has(m.id)
              return (
                <div key={m.id} className={`bg-white rounded-xl border p-5 transition ${on ? 'border-blue-300 ring-1 ring-blue-100' : 'border-slate-200/80'} ${!m.available ? 'opacity-75' : ''}`}>
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <Blocks size={16} className={on ? 'text-blue-600' : 'text-slate-400'} />
                      <span className="font-medium text-slate-800">{m.name}</span>
                      {m.core && <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-white flex items-center gap-0.5"><Lock size={9} />核心</span>}
                      {m.badge && <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-600 border border-amber-200">{m.badge}</span>}
                    </div>
                    {/* 开关 */}
                    <button disabled={m.core || !m.available} onClick={() => { toggle(m.id); setSaved(false) }}
                      className={`w-11 h-[24px] rounded-full transition relative shrink-0 ${on ? 'bg-blue-600' : 'bg-slate-200'} ${(m.core || !m.available) ? 'opacity-50 cursor-not-allowed' : ''}`}>
                      <span className={`absolute top-[4px] w-4 h-4 rounded-full bg-white shadow transition-all ${on ? 'left-[23px]' : 'left-[4px]'}`} />
                    </button>
                  </div>
                  <p className="text-xs text-slate-500 leading-relaxed">{m.desc}</p>
                  <div className="flex items-center justify-between mt-3 pt-3 border-t border-slate-50 text-[11px]">
                    <span className="text-slate-400">{m.deps || (m.available ? '独立模块，开箱即用' : '联系太忆开通订阅')}</span>
                    <span className={on ? 'text-blue-600 font-medium' : 'text-slate-300'}>{on ? '已装配 · 导航可见' : '未装配'}</span>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      ))}

      <div className="bg-gradient-to-r from-slate-800 to-slate-900 rounded-xl p-5 text-white flex items-center justify-between flex-wrap gap-3">
        <div>
          <div className="text-sm font-medium mb-1">自进化，是装出来的</div>
          <p className="text-xs text-slate-300 leading-relaxed max-w-2xl">TiMEM 上下文层让 AI 读懂企业（图谱/记忆/规则/知识），平台层让智能体干活，平台能力按需叠加。模块越用越聪明——审批沉淀规则、交互生成画像、趋势变成预判，中后台交付之后仍在持续增值。</p>
        </div>
        <div className="text-xs text-slate-400">已装配 {enabled.size} / {moduleRegistry.filter(m => m.available).length} 个可用模块</div>
      </div>
      <style>{`@keyframes fadeSlide { from { opacity: 0; transform: translateY(4px);} to { opacity: 1; transform: none; } }`}</style>
    </div>
  )
}
