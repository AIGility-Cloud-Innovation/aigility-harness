import { useEffect, useState } from 'react'
import { moduleRegistry } from '../modules/registry'
import { fetchModules, saveModulePreset, applyModulePreset, deleteModulePreset, type ModulePresetInfo } from '../lib/harness'
import { Blocks, LayoutGrid, Hexagon, Wrench, Lock, CheckCircle2, Building2, Plus, Trash2, Pin } from 'lucide-react'

const catIcon: Record<string, any> = { 平台层: LayoutGrid, 'TiMEM 上下文层': Hexagon, 平台能力: Wrench, 订阅模块: Blocks, 应用包: Blocks }
const catDesc: Record<string, string> = {
  平台层: '智能体的创建、使用与分发',
  'TiMEM 上下文层': '图谱 · 记忆 · 规则 · 知识中间件（太忆上下文基础设施）',
  平台能力: '工具、模型与运营支撑',
  订阅模块: '面向业务场景的增值模块',
  应用包: '面向场景的模块组合，一键装配成工作台',
}

interface Props {
  enabled: Set<string>
  toggle: (id: string) => void
  /** 预设套用后整体替换装配状态（App 层同步导航） */
  applyFullState: (state: Record<string, boolean>) => void
  /** 被用户从左侧导航隐藏的模块 id 集合（与装配无关的偏好，localStorage 持久化） */
  navHidden: Set<string>
  /** 切换某模块「固定到左侧导航」 */
  onToggleNav: (id: string) => void
  /** 导航布局编辑权限（现阶段仅管理员可改，普通用户只读） */
  navEditable?: boolean
}

export default function ModulePage({ enabled, toggle, applyFullState, navHidden, onToggleNav, navEditable = true }: Props) {
  const [presets, setPresets] = useState<ModulePresetInfo[]>([])
  const [presetName, setPresetName] = useState('')
  const [busy, setBusy] = useState(false)
  const [banner, setBanner] = useState('')
  const cats = ['平台层', 'TiMEM 上下文层', '平台能力', '订阅模块'] as const

  const loadPresets = () => { fetchModules().then(m => setPresets(m.presets ?? [])).catch(() => {}) }
  useEffect(loadPresets, [])

  const savePreset = async () => {
    const name = presetName.trim()
    if (!name || busy) return
    setBusy(true)
    try {
      await saveModulePreset(name, [...enabled])
      setBanner(`已保存预设「${name}」（PG 持久化）——同类客户一键套用当前模块组合`)
      setPresetName('')
      loadPresets()
    } catch (e) {
      setBanner(`保存失败：${String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  const applyPreset = async (p: ModulePresetInfo) => {
    if (busy) return
    setBusy(true)
    try {
      const state = await applyModulePreset(p.id)
      applyFullState(state)
      setBanner(`已套用预设「${p.name}」——导航与路由守卫即时生效（变更已入审计）`)
    } catch (e) {
      setBanner(`套用失败：${String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  const removePreset = async (p: ModulePresetInfo) => {
    try {
      await deleteModulePreset(p.id)
      loadPresets()
    } catch { /* 服务端拒绝（内置预设）时静默保留 */ }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-800">模块装配</h1>
          <p className="text-sm text-slate-500 mt-1">像搭积木一样组装企业的数字员工中后台 —— 开关即时生效且全端一致（PG 持久化，变更入审计）；预设 = 给某类客户的一套工作台</p>
        </div>
        <div className="flex items-center gap-2">
          <input value={presetName} onChange={e => setPresetName(e.target.value)} placeholder="预设名称，如：化工报警分析"
            className="text-sm px-3 py-2 w-48 bg-white border border-slate-200/80 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-100" />
          <button onClick={savePreset} disabled={busy || !presetName.trim()}
            className="text-sm px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1.5">
            <Plus size={14} /> 保存为预设
          </button>
        </div>
      </div>

      {banner && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3 text-xs text-emerald-700 flex items-center gap-2" style={{ animation: 'fadeSlide .3s ease' }}>
          <CheckCircle2 size={14} /> {banner}
        </div>
      )}

      {/* 预设模板（真 · app_module_presets） */}
      <div className="bg-white rounded-xl border border-slate-200/80 px-5 py-4">
        <div className="flex items-center gap-2 mb-3">
          <Building2 size={15} className="text-slate-400" />
          <span className="text-sm font-medium text-slate-700">工作台预设</span>
          <span className="text-xs text-slate-400">套用后导航即时切换 = 给一类人的一套工作台</span>
        </div>
        <div className="flex flex-wrap gap-2">
          {presets.map(p => (
            <div key={p.id} className={`group flex items-center gap-2 pl-3 pr-1.5 py-1.5 rounded-full border text-xs transition ${p.id === 'default' ? 'border-blue-200 bg-blue-50 text-blue-700' : 'border-slate-200 bg-slate-50 text-slate-600 hover:border-blue-200'}`}>
              <button onClick={() => applyPreset(p)} disabled={busy} className="font-medium disabled:opacity-50" title="套用预设">
                {p.name} · {p.enabledIds.length} 模块
              </button>
              {p.id !== 'default' && (
                <button onClick={() => removePreset(p)} className="opacity-0 group-hover:opacity-100 text-slate-400 hover:text-red-500 transition" title="删除预设">
                  <Trash2 size={12} />
                </button>
              )}
            </div>
          ))}
          {presets.length === 0 && <span className="text-xs text-slate-400">暂无预设，用右上角「保存为预设」把当前装配存成模板</span>}
        </div>
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
              const inNav = on && !navHidden.has(m.id)
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
                    <button disabled={m.core || !m.available} onClick={() => toggle(m.id)}
                      className={`w-11 h-[24px] rounded-full transition relative shrink-0 ${on ? 'bg-blue-600' : 'bg-slate-200'} ${(m.core || !m.available) ? 'opacity-50 cursor-not-allowed' : ''}`}>
                      <span className={`absolute top-[4px] w-4 h-4 rounded-full bg-white shadow transition-all ${on ? 'left-[23px]' : 'left-[4px]'}`} />
                    </button>
                  </div>
                  <p className="text-xs text-slate-500 leading-relaxed">{m.desc}</p>
                  <div className="flex items-center justify-between mt-3 pt-3 border-t border-slate-50 text-[11px]">
                    <span className="text-slate-400">{m.deps || (m.available ? '独立模块，开箱即用' : '联系太忆开通订阅')}</span>
                    {/* 导航固定开关（独立偏好）：装配 ≠ 占导航位，由用户决定 */}
                    {m.available && !m.core && (
                      <button onClick={() => onToggleNav(m.id)} disabled={!on || !navEditable}
                        title={navEditable ? (inNav ? '点击从左侧导航移除（模块仍可从应用中心进入）' : '点击固定到左侧导航') : '导航布局由管理员统一配置'}
                        className={`flex items-center gap-1 px-2 py-0.5 rounded-full border transition ${inNav ? 'border-blue-200 bg-blue-50 text-blue-600' : 'border-slate-200 text-slate-400 hover:border-blue-200 hover:text-blue-500'} ${!on || !navEditable ? 'opacity-50 cursor-not-allowed' : ''}`}>
                        <Pin size={11} className={inNav ? 'fill-blue-200' : ''} />{inNav ? '导航可见' : '不在导航'}
                      </button>
                    )}
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
          <p className="text-xs text-slate-300 leading-relaxed max-w-2xl">TiMEM 上下文层让 AI 读懂企业（图谱/记忆/规则/知识），平台层让智能体干活，平台能力按需叠加。装什么插件就变成什么工作台——工具插件在「工具插件中心」安装，模块组合存成预设，给不同的人配不同的工作台。</p>
        </div>
        <div className="text-xs text-slate-400">已装配 {enabled.size} / {moduleRegistry.filter(m => m.available).length} 个可用模块</div>
      </div>
      <style>{`@keyframes fadeSlide { from { opacity: 0; transform: translateY(4px);} to { opacity: 1; transform: none; } }`}</style>
    </div>
  )
}
