import { useRef, useState } from 'react'
import { themePresets, defaultBranding, tenants, type Branding } from '../mock/data'
import { Palette, KeyRound, Building2, Check, Download, Upload, RotateCcw } from 'lucide-react'

export default function SettingsPage({ branding, setBranding, tenantId }: {
  branding: Branding
  setBranding: (b: Branding) => void
  tenantId: string
}) {
  const [saved, setSaved] = useState(false)
  const [importMsg, setImportMsg] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const tenant = tenants.find(t => t.id === tenantId)

  const set = (k: keyof Branding, v: string) => { setBranding({ ...branding, [k]: v }); setSaved(false) }

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(branding, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${branding.shortName || 'brand'}-branding.json`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const importJson = (file: File) => {
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const cfg = JSON.parse(String(reader.result))
        if (cfg.platformName && cfg.primary) {
          setBranding({ ...defaultBranding, ...cfg })
          setImportMsg('导入成功，界面已按新配置生效')
        } else setImportMsg('配置缺少 platformName 或 primary 字段')
      } catch { setImportMsg('JSON 解析失败，请检查文件') }
      setTimeout(() => setImportMsg(''), 3000)
    }
    reader.readAsText(file)
  }

  return (
    <div className="space-y-5 max-w-4xl">
      <div>
        <h1 className="text-xl font-semibold text-slate-800">品牌与平台配置</h1>
        <p className="text-sm text-slate-500 mt-1">标品贴牌：品牌、主题、Logo 所见即所得 · 配置可导出迁移 · 私有化 / 一体机授权 · 租户管理</p>
      </div>

      {/* 品牌贴牌 */}
      <div className="bg-white rounded-xl border border-slate-200/80 p-6">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
          <div className="flex items-center gap-2"><Palette size={17} style={{ color: branding.primary }} /><h3 className="font-medium text-slate-800">品牌配置（左侧栏与首页实时生效）</h3></div>
          <div className="flex gap-2">
            <button onClick={exportJson} className="text-xs px-3 py-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 flex items-center gap-1"><Download size={12} />导出 JSON</button>
            <button onClick={() => fileRef.current?.click()} className="text-xs px-3 py-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 flex items-center gap-1"><Upload size={12} />导入 JSON</button>
            <button onClick={() => { setBranding(defaultBranding); setSaved(false) }} className="text-xs px-3 py-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 flex items-center gap-1"><RotateCcw size={12} />恢复默认</button>
            <input ref={fileRef} type="file" accept=".json" className="hidden" onChange={e => e.target.files?.[0] && importJson(e.target.files[0])} />
          </div>
        </div>
        {importMsg && <div className="mb-4 text-xs text-blue-600 bg-blue-50 rounded-lg px-3 py-2">{importMsg}</div>}

        {/* 预设主题 */}
        <div className="mb-5">
          <label className="text-xs text-slate-400 block mb-2">预设主题</label>
          <div className="flex gap-3 flex-wrap">
            {themePresets.map(p => {
              const active = branding.primary === p.primary && branding.accent === p.accent
              return (
                <button key={p.name} onClick={() => { setBranding({ ...branding, primary: p.primary, accent: p.accent }); setSaved(false) }}
                  className={`flex items-center gap-2.5 rounded-xl border-2 px-4 py-2.5 transition ${active ? 'border-slate-800' : 'border-slate-200 hover:border-slate-300'}`}>
                  <span className="flex"><span className="w-5 h-5 rounded-full" style={{ background: p.primary }} /><span className="w-5 h-5 rounded-full -ml-2 border-2 border-white" style={{ background: p.accent }} /></span>
                  <span className="text-xs text-slate-700">{p.name}</span>
                  {active && <Check size={13} className="text-slate-800" />}
                </button>
              )
            })}
          </div>
        </div>

        <div className="grid md:grid-cols-2 gap-5">
          <div>
            <label className="text-xs text-slate-400 block mb-1.5">平台名称</label>
            <input value={branding.platformName} onChange={e => set('platformName', e.target.value)}
              className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-100" />
          </div>
          <div>
            <label className="text-xs text-slate-400 block mb-1.5">平台简称</label>
            <input value={branding.shortName} onChange={e => set('shortName', e.target.value)}
              className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-100" />
          </div>
          <div>
            <label className="text-xs text-slate-400 block mb-1.5">Logo 文本（单字）</label>
            <input value={branding.logoText} maxLength={1} onChange={e => set('logoText', e.target.value)}
              className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-100" />
          </div>
          <div>
            <label className="text-xs text-slate-400 block mb-1.5">主色 / 辅助色</label>
            <div className="flex items-center gap-3">
              <input type="color" value={branding.primary} onChange={e => set('primary', e.target.value)} className="w-10 h-10 rounded-lg border border-slate-200 cursor-pointer" />
              <input type="color" value={branding.accent} onChange={e => set('accent', e.target.value)} className="w-10 h-10 rounded-lg border border-slate-200 cursor-pointer" />
              <code className="text-xs text-slate-400">{branding.primary} / {branding.accent}</code>
            </div>
          </div>
        </div>

        {/* 预览条 */}
        <div className="mt-5 rounded-xl border border-slate-100 p-4 bg-slate-50/60 flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl text-white flex items-center justify-center font-bold" style={{ background: `linear-gradient(135deg, ${branding.primary}, ${branding.accent})` }}>{branding.logoText}</div>
          <div>
            <div className="text-sm font-semibold text-slate-800">{branding.platformName}</div>
            <div className="text-[11px] text-slate-400">TiMEM 上下文基础设施驱动 · 当前租户：{tenant?.name}</div>
          </div>
          <button onClick={() => setSaved(true)} className="ml-auto text-sm px-4 py-2 rounded-lg text-white" style={{ background: branding.primary }}>保存配置</button>
          {saved && <span className="text-xs text-emerald-600">已保存，客户侧界面即时生效</span>}
        </div>
      </div>

      {/* 授权 */}
      <div className="grid md:grid-cols-2 gap-4">
        <div className="bg-white rounded-xl border border-slate-200/80 p-6">
          <div className="flex items-center gap-2 mb-3"><KeyRound size={17} className="text-sky-600" /><h3 className="font-medium text-slate-800">私有化授权</h3></div>
          <p className="text-xs text-slate-500 leading-relaxed mb-4">平台 + TiMEM 引擎 License 部署到客户机房，数据不出域，按年授权。</p>
          {[['燃气电厂智能运维', 'License-2026-0412', '有效期至 2027-04'], ['化工厂设备管家', 'License-2026-0788', '有效期至 2027-06']].map(([n, k, d]) => (
            <div key={k} className="flex items-center justify-between text-xs border border-slate-100 rounded-lg px-3 py-2.5 mb-2">
              <span className="text-slate-700">{n}</span>
              <span className="font-mono text-slate-400">{k}</span>
              <span className="text-emerald-600">{d}</span>
            </div>
          ))}
        </div>
        <div className="bg-white rounded-xl border border-slate-200/80 p-6">
          <div className="flex items-center gap-2 mb-3"><Building2 size={17} className="text-cyan-600" /><h3 className="font-medium text-slate-800">一体机交付</h3></div>
          <p className="text-xs text-slate-500 leading-relaxed mb-4">软硬一体（国产算力 · 海光 K100），开箱即用，面向工厂/园区现场部署。</p>
          {[['轩怡装饰 · 门店一体机', 'SN-TM-K100-0091', '运行 43 天 · 正常'], ['燃气电厂 · 集控室节点', 'SN-TM-K100-0107', '运行 12 天 · 正常']].map(([n, k, d]) => (
            <div key={k} className="flex items-center justify-between text-xs border border-slate-100 rounded-lg px-3 py-2.5 mb-2">
              <span className="text-slate-700">{n}</span>
              <span className="font-mono text-slate-400">{k}</span>
              <span className="text-emerald-600">{d}</span>
            </div>
          ))}
        </div>
      </div>

      {/* 租户 */}
      <div className="bg-white rounded-xl border border-slate-200/80 overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
          <h3 className="font-medium text-slate-800">租户 / 项目管理</h3>
          <button className="text-xs px-3 py-1.5 rounded-lg text-white" style={{ background: branding.primary }}>+ 新建项目</button>
        </div>
        <div className="overflow-x-auto -mx-1 px-1"><table className="w-full text-sm">
          <thead><tr className="text-xs text-slate-400 border-b border-slate-100 bg-slate-50/60">
            <th className="text-left font-medium px-6 py-2.5">企业客户</th>
            <th className="text-left font-medium px-3 py-2.5">行业</th>
            <th className="text-left font-medium px-3 py-2.5">接入系统</th>
            <th className="text-left font-medium px-3 py-2.5">交付形态</th>
            <th className="text-left font-medium px-3 py-2.5">状态</th>
          </tr></thead>
          <tbody>
            {[
              ['某燃气电厂', '能源电力（专精特新）', 'DCS', '私有化 License', '试运行'],
              ['某精细化工', '流程制造（小巨人）', 'SCADA / MES', '一体机', '图谱构建'],
              ['轩怡装饰', '家装服务', 'CRM / OA', '一体机 + 订阅', '已上线'],
              ['某装备制造', '装备制造（专精特新）', 'ERP / MES', '私有化 License', '数据接入'],
            ].map(r => (
              <tr key={r[0]} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/50">
                <td className="px-6 py-3 text-slate-700">{r[0]}</td>
                <td className="px-3 py-3 text-xs text-slate-500">{r[1]}</td>
                <td className="px-3 py-3 text-xs text-slate-500">{r[2]}</td>
                <td className="px-3 py-3 text-xs text-slate-500">{r[3]}</td>
                <td className="px-3 py-3"><span className={`text-xs px-2 py-0.5 rounded-full ${r[4] === '已上线' ? 'bg-emerald-50 text-emerald-600' : 'bg-blue-50 text-blue-600'}`}>{r[4]}</span></td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </div>
    </div>
  )
}
