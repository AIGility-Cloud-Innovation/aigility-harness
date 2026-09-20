import { useState } from 'react'
import { useStore } from '@/store/AppContext'
import { cn } from '@/lib/utils'
import type { ProductModule, StandardSku } from '@/types'
import {
  Blocks, Bot, Layers, Headset, FileSearch, BellOff, Server, Plus,
  ChevronRight, Package, Sparkles, CheckCircle2, Database, Zap, Ticket, KeyRound, Link2, Handshake, Repeat,
} from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'

const KIND_CLS: Record<ProductModule['kind'], string> = {
  '平台': 'border-blue-200 bg-blue-50 text-[#3370ff]',
  '行业方案': 'border-violet-200 bg-violet-50 text-violet-600',
  '功能模块': 'border-teal-200 bg-teal-50 text-teal-600',
}

const MATURITY_CLS: Record<ProductModule['maturity'], string> = {
  '标准产品': 'border-emerald-200 bg-emerald-50 text-emerald-600',
  '半产品': 'border-amber-200 bg-amber-50 text-amber-700',
  '沉淀中': 'border-slate-200 bg-slate-50 text-slate-500',
}

const MODULE_ICON: Record<string, typeof Bot> = {
  M01: Bot, M02: Layers, M03: Headset, M04: FileSearch, M05: BellOff, M06: Server,
}
const iconFor = (m: ProductModule) => MODULE_ICON[m.id] ?? Package

const SKU_KIND_CLS: Record<StandardSku['kind'], string> = {
  '记忆容量': 'border-blue-200 bg-blue-50 text-[#3370ff]',
  'Token 包': 'border-violet-200 bg-violet-50 text-violet-600',
  '积分包': 'border-amber-200 bg-amber-50 text-amber-700',
  '一体机': 'border-slate-300 bg-slate-100 text-slate-700',
  '私有化授权': 'border-emerald-200 bg-emerald-50 text-emerald-600',
}
const SKU_ICON: Record<StandardSku['kind'], typeof Bot> = {
  '记忆容量': Database, 'Token 包': Zap, '积分包': Ticket, '一体机': Server, '私有化授权': KeyRound,
}
const BILLING_CLS: Record<StandardSku['billing'], string> = {
  '一次性': 'bg-slate-100 text-slate-500',
  '按年订阅': 'bg-emerald-100 text-emerald-700',
  '按量消耗': 'bg-sky-100 text-sky-700',
}

/** 产品模块库：从项目沉淀的标准化能力 + 标准产品 SKU，方案积木式组装的零件仓 */
export function Modules() {
  const { modules, addProductModule, skus } = useStore()
  const [tab, setTab] = useState<'modules' | 'skus'>('modules')
  const [detail, setDetail] = useState<ProductModule | null>(null)
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState({ name: '', kind: '功能模块' as ProductModule['kind'], desc: '', capabilities: '', source: '' })

  const totalUsed = modules.reduce((s, m) => s + m.usedBy.length, 0)
  const byMaturity = (v: ProductModule['maturity']) => modules.filter(m => m.maturity === v).length

  const submit = () => {
    if (!form.name.trim() || !form.desc.trim()) return
    addProductModule({
      name: form.name.trim(), kind: form.kind, desc: form.desc.trim(),
      capabilities: form.capabilities.split(/[,，、]/).map(s => s.trim()).filter(Boolean),
      source: form.source.trim() || '手工登记',
    })
    setCreating(false)
    setForm({ name: '', kind: '功能模块', desc: '', capabilities: '', source: '' })
  }

  return (
    <div className="space-y-7">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-[18px] font-bold text-slate-900">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-50"><Blocks className="h-[18px] w-[18px] text-[#3370ff]" /></span>
            产品模块库
          </h2>
          <p className="mt-1.5 text-[12px] text-slate-400">项目做成产品，产品拼成方案 · 积木式组装，交付越来越快</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg border border-slate-200/60 bg-white shadow-sm p-0.5">
            <button onClick={() => setTab('modules')} className={cn('rounded-md px-3 py-1.5 text-xs font-medium', tab === 'modules' ? 'bg-[#3370ff] text-white' : 'text-slate-500')}>功能模块</button>
            <button onClick={() => setTab('skus')} className={cn('rounded-md px-3 py-1.5 text-xs font-medium', tab === 'skus' ? 'bg-[#3370ff] text-white' : 'text-slate-500')}>标准产品 SKU</button>
          </div>
          {tab === 'modules' && (
            <span className="tnum hidden md:inline rounded-full border border-slate-200 bg-white px-3 py-1 text-[12px] text-slate-500">
              标准产品 {byMaturity('标准产品')} · 半产品 {byMaturity('半产品')} · 沉淀中 {byMaturity('沉淀中')} · 累计复用 {totalUsed} 次
            </span>
          )}
          {tab === 'modules' && (
            <Button size="sm" className="h-8 bg-[#3370ff] hover:bg-[#2952cc]" onClick={() => setCreating(true)}>
              <Plus className="h-3.5 w-3.5 mr-1" />登记新模块
            </Button>
          )}
        </div>
      </div>

      {tab === 'skus' ? (
        <div className="space-y-5">
          {/* 商业模式说明 */}
          <div className="rounded-2xl border border-[#3370ff]/20 bg-gradient-to-r from-blue-50/80 to-indigo-50/60 p-5">
            <p className="flex items-center gap-2 text-[13px] font-semibold text-slate-800">
              <Repeat className="h-4 w-4 text-[#3370ff]" />标准化售卖 × 集成服务商交付 × 订阅续费 = 长期捆绑
            </p>
            <p className="mt-2 text-[12px] leading-relaxed text-slate-500">
              最终卖的是标准解决方案：记忆容量、Token、积分按订阅/用量持续收费，一体机与私有化授权做入场锚点；
              项目落地交给集成服务商伙伴，我们守住记忆底座与标准产品，客户的记忆资产越沉淀越深、续费越久。
            </p>
          </div>

          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {skus.map(s => {
              const Icon = SKU_ICON[s.kind]
              return (
                <div key={s.id} className="rounded-2xl border border-slate-200/60 bg-white shadow-sm p-6 transition-all duration-200 hover:-translate-y-0.5 hover:border-[#3370ff]/50 hover:shadow-md">
                  <div className="flex items-start justify-between gap-2">
                    <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-50">
                      <Icon className="h-5 w-5 text-[#3370ff]" />
                    </span>
                    <div className="flex gap-1.5">
                      <span className={cn('rounded border px-1.5 py-0.5 text-[10px] font-medium', SKU_KIND_CLS[s.kind])}>{s.kind}</span>
                      <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium', BILLING_CLS[s.billing])}>{s.billing}</span>
                    </div>
                  </div>
                  <h3 className="mt-3.5 text-[15px] font-semibold text-slate-900">{s.name}</h3>
                  <p className="mt-1 text-[12px] text-slate-400">{s.spec}</p>
                  <p className="mt-2 text-[12px] leading-relaxed text-slate-500 line-clamp-2">{s.desc}</p>
                  <div className="mt-3.5 flex items-start gap-1.5 rounded-lg bg-emerald-50/60 border border-emerald-100 px-2.5 py-2">
                    <Link2 className="mt-0.5 h-3 w-3 shrink-0 text-emerald-600" />
                    <p className="text-[11px] leading-snug text-emerald-700">{s.binding}</p>
                  </div>
                  <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-3.5">
                    <span className="tnum text-[15px] font-bold text-slate-900">¥{s.price.toLocaleString()}<span className="text-[11px] font-normal text-slate-400"> / {s.unit}</span></span>
                    <span className="flex items-center gap-1 text-[11px] text-slate-400"><Handshake className="h-3 w-3" />伙伴可交付</span>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      ) : (
      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {modules.map(m => {
          const Icon = iconFor(m)
          return (
            <button
              key={m.id}
              onClick={() => setDetail(m)}
              className="group rounded-2xl border border-slate-200/60 bg-white shadow-sm p-6 text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-[#3370ff]/50 hover:shadow-md"
            >
              <div className="flex items-start justify-between gap-2">
                <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-50">
                  <Icon className="h-5 w-5 text-[#3370ff]" />
                </span>
                <div className="flex gap-1.5">
                  <span className={cn('rounded border px-1.5 py-0.5 text-[10px] font-medium', KIND_CLS[m.kind])}>{m.kind}</span>
                  <span className={cn('rounded border px-1.5 py-0.5 text-[10px] font-medium', MATURITY_CLS[m.maturity])}>{m.maturity}</span>
                </div>
              </div>
              <h3 className="mt-3.5 text-[15px] font-semibold text-slate-900">{m.name}</h3>
              <p className="mt-1.5 text-[12px] leading-relaxed text-slate-500 line-clamp-2">{m.desc}</p>
              <div className="mt-3.5 flex flex-wrap gap-1.5">
                {m.capabilities.slice(0, 3).map(c => (
                  <span key={c} className="rounded-md bg-slate-50 border border-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">{c}</span>
                ))}
                {m.capabilities.length > 3 && <span className="text-[10px] text-slate-400">+{m.capabilities.length - 3}</span>}
              </div>
              <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-3.5">
                <span className="tnum text-[12px] font-medium text-slate-700">
                  {m.price != null ? `¥${m.price} 万/年起` : '随项目报价'}
                </span>
                <span className="flex items-center gap-1 text-[11px] text-slate-400 group-hover:text-[#3370ff]">
                  复用 {m.usedBy.length} 次 <ChevronRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5" />
                </span>
              </div>
            </button>
          )
        })}
      </div>
      )}

      {/* 模块详情 */}
      <Dialog open={!!detail} onOpenChange={v => !v && setDetail(null)}>
        <DialogContent className="sm:max-w-[520px]">
          {detail && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2.5 text-[16px]">
                  <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-50">
                    {(() => { const Icon = iconFor(detail); return <Icon className="h-[18px] w-[18px] text-[#3370ff]" /> })()}
                  </span>
                  {detail.name}
                </DialogTitle>
              </DialogHeader>
              <div className="flex gap-1.5">
                <span className={cn('rounded border px-1.5 py-0.5 text-[11px] font-medium', KIND_CLS[detail.kind])}>{detail.kind}</span>
                <span className={cn('rounded border px-1.5 py-0.5 text-[11px] font-medium', MATURITY_CLS[detail.maturity])}>{detail.maturity}</span>
                <span className="tnum rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[11px] text-slate-600">
                  {detail.price != null ? `¥${detail.price} 万/年起` : '随项目报价'}
                </span>
              </div>
              <p className="text-[13px] leading-relaxed text-slate-600">{detail.desc}</p>
              <div>
                <p className="text-[12px] font-semibold text-slate-700">核心能力</p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {detail.capabilities.map(c => (
                    <span key={c} className="flex items-center gap-1 rounded-md bg-blue-50 border border-blue-100 px-2 py-1 text-[11px] text-[#3370ff]">
                      <CheckCircle2 className="h-3 w-3" />{c}
                    </span>
                  ))}
                </div>
              </div>
              <div className="rounded-xl bg-slate-50 border border-slate-100 p-3.5">
                <p className="text-[12px] font-semibold text-slate-700">来源</p>
                <p className="mt-1 text-[12px] text-slate-500">{detail.source}</p>
                <p className="mt-3 text-[12px] font-semibold text-slate-700">复用记录（{detail.usedBy.length}）</p>
                {detail.usedBy.length === 0 ? (
                  <p className="mt-1 text-[12px] text-slate-400">还没有项目组装过这个模块</p>
                ) : (
                  <div className="mt-1.5 space-y-1">
                    {detail.usedBy.map(u => <p key={u} className="text-[12px] text-slate-500">· {u}</p>)}
                  </div>
                )}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* 登记新模块 */}
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-[15px]">
              <Sparkles className="h-4 w-4 text-[#3370ff]" />登记新模块 · 把项目能力沉淀为产品
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="模块名称，如：合同审查功能模块" />
            <div className="flex gap-2">
              {(['平台', '行业方案', '功能模块'] as const).map(k => (
                <button
                  key={k}
                  onClick={() => setForm(f => ({ ...f, kind: k }))}
                  className={cn('flex-1 rounded-lg border px-2 py-2 text-[12px] font-medium transition-colors',
                    form.kind === k ? 'border-[#3370ff] bg-blue-50 text-[#3370ff]' : 'border-slate-200 text-slate-500 hover:border-slate-300')}
                >{k}</button>
              ))}
            </div>
            <Textarea value={form.desc} onChange={e => setForm(f => ({ ...f, desc: e.target.value }))} rows={3} placeholder="一句话说清这个模块解决什么问题、来自哪个项目的沉淀" />
            <Input value={form.capabilities} onChange={e => setForm(f => ({ ...f, capabilities: e.target.value }))} placeholder="核心能力（用逗号分隔），如：条款抽取， 风险点提示" />
            <Input value={form.source} onChange={e => setForm(f => ({ ...f, source: e.target.value }))} placeholder="来源项目（可选），如：沉淀自：可孚医疗项目" />
            <Button className="w-full bg-[#3370ff] hover:bg-[#2952cc]" onClick={submit} disabled={!form.name.trim() || !form.desc.trim()}>
              登记入库（成熟度：沉淀中）
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
