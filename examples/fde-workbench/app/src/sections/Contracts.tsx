import { useState } from 'react'
import { useStore } from '@/store/AppContext'
import { Money, PageHeader } from '@/components/bits'
import { fmtMoneyFull } from '@/types'
import type { ContractStatus, Contract } from '@/types'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { LayoutList, Columns3, ChevronRight, CheckCircle2, History, ShoppingCart, Truck, FilePlus2, ArrowDownToLine, ArrowUpFromLine, Wallet, Repeat, BellRing } from 'lucide-react'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'

const STATUS_FLOW: ContractStatus[] = ['草拟', '法务审核', '待签约', '履约中', '已回款']
const statusColor: Record<ContractStatus, string> = {
  '草拟': 'bg-slate-100 text-slate-600 border-slate-200',
  '法务审核': 'bg-amber-50 text-amber-700 border-amber-200',
  '待签约': 'bg-blue-50 text-blue-700 border-blue-200',
  '履约中': 'bg-indigo-50 text-indigo-700 border-indigo-200',
  '已回款': 'bg-emerald-50 text-emerald-700 border-emerald-200',
}
const purchaseStatusColor: Record<string, string> = {
  '草拟中': 'bg-slate-100 text-slate-600 border-slate-200',
  '已签订': 'bg-blue-50 text-blue-700 border-blue-200',
  '执行中': 'bg-indigo-50 text-indigo-700 border-indigo-200',
  '已完成': 'bg-emerald-50 text-emerald-700 border-emerald-200',
}

/** 合同详情抽屉：修订记录 + 关联采购合同 + 毛利概览 */
function ContractDetailSheet({ contract, onClose }: { contract: Contract; onClose: () => void }) {
  const { purchaseContracts, channels, addContractRevision, settlePayment, leads } = useStore()
  const [revOpen, setRevOpen] = useState(false)
  const [revBy, setRevBy] = useState('甲方法务')
  const [revOpinion, setRevOpinion] = useState('')
  const [revChange, setRevChange] = useState('')

  const channel = channels.find(ch => ch.id === contract.channelId)
  const lead = leads.find(l => l.id === contract.leadId)
  const purchases = purchaseContracts.filter(pc => pc.contractId === contract.id)
  const purchaseTotal = purchases.reduce((s, p) => s + p.amount, 0)
  const margin = contract.amount - purchaseTotal
  const marginRate = contract.amount > 0 ? (margin / contract.amount) * 100 : 0
  const currentVersion = contract.revisions[contract.revisions.length - 1]?.version ?? 1

  const submitRevision = () => {
    if (!revOpinion.trim() || !revChange.trim()) return
    addContractRevision(contract.id, revBy.trim() || '我方商务', revOpinion.trim(), revChange.trim())
    setRevOpen(false); setRevOpinion(''); setRevChange('')
  }

  return (
    <Sheet open onOpenChange={v => !v && onClose()}>
      <SheetContent side="right" className="w-full sm:w-[560px] sm:max-w-[560px] overflow-y-auto bg-slate-50 p-0">
        <SheetHeader className="border-b border-slate-200 bg-white px-5 py-4">
          <SheetTitle className="flex flex-wrap items-center gap-2 text-[15px]">
            <span className="tnum">{contract.code}</span>
            <span className={cn('rounded border px-1.5 py-0.5 text-[11px] font-medium', statusColor[contract.status])}>{contract.status}</span>
            <span className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[11px] text-slate-500">{contract.salesType}销售</span>
            <span className="tnum rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[11px] text-slate-500">v{currentVersion}</span>
          </SheetTitle>
          <p className="text-[13px] text-slate-500">{contract.customer}{lead && <> · 行业：{lead.industry}</>}{channel && <> · 渠道方：{channel.name}（分佣 {(contract.commissionRate * 100).toFixed(0)}%）</>}</p>
        </SheetHeader>

        <div className="space-y-4 p-4 sm:p-5">
          {/* 金额与毛利 */}
          <div className="grid grid-cols-3 gap-3">
            <div className="rounded-xl border border-slate-200/60 bg-white shadow-sm p-3.5">
              <p className="flex items-center gap-1 text-[11px] text-slate-400"><ArrowUpFromLine className="h-3 w-3" />销售额</p>
              <Money value={contract.amount} className="mt-1.5 text-lg text-slate-900" />
            </div>
            <div className="rounded-xl border border-slate-200/60 bg-white shadow-sm p-3.5">
              <p className="flex items-center gap-1 text-[11px] text-slate-400"><ArrowDownToLine className="h-3 w-3" />采购成本</p>
              <Money value={purchaseTotal} className="mt-1.5 text-lg text-slate-900" />
            </div>
            <div className="rounded-xl border border-emerald-200 bg-emerald-50/50 p-3.5">
              <p className="flex items-center gap-1 text-[11px] text-emerald-600"><Wallet className="h-3 w-3" />预估毛利</p>
              <Money value={margin} className="mt-1.5 text-lg text-emerald-700" />
              <p className="tnum mt-0.5 text-[11px] text-emerald-600/80">{marginRate.toFixed(0)}%</p>
            </div>
          </div>

          {/* 修订记录 */}
          <div className="rounded-xl border border-slate-200/60 bg-white shadow-sm p-4 sm:p-5">
            <div className="flex items-center justify-between">
              <h3 className="flex items-center gap-2 text-[14px] font-semibold text-slate-900">
                <History className="h-4 w-4 text-[#3370ff]" />销售合同修订记录
              </h3>
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setRevOpen(true)}>
                <FilePlus2 className="h-3 w-3 mr-1" />登记修订
              </Button>
            </div>
            <p className="mt-1 text-xs text-slate-400">合同从草拟到签约往往多轮修改，每轮意见与改动都留痕</p>
            <div className="mt-4 space-y-0">
              {[...contract.revisions].reverse().map((rv, i) => (
                <div key={rv.id} className="relative flex gap-3 pb-5 last:pb-0">
                  <div className="flex flex-col items-center">
                    <span className={cn('tnum flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-[11px] font-bold',
                      i === 0 ? 'border-[#3370ff] bg-[#3370ff] text-white' : 'border-slate-200 bg-slate-50 text-slate-500')}>
                      v{rv.version}
                    </span>
                    {i < contract.revisions.length - 1 && <span className="mt-1 w-px flex-1 bg-slate-200" />}
                  </div>
                  <div className="min-w-0 flex-1 pt-0.5">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="font-medium text-slate-700">{rv.by}</span>
                      <span className="tnum text-slate-400">{rv.at}</span>
                    </div>
                    <p className="mt-1.5 rounded-lg bg-amber-50/70 px-3 py-2 text-xs leading-relaxed text-amber-800">意见：{rv.opinion}</p>
                    <p className="mt-1.5 rounded-lg bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-600">修改：{rv.change}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* 关联采购合同 */}
          <div className="rounded-xl border border-slate-200/60 bg-white shadow-sm p-4 sm:p-5">
            <h3 className="flex items-center gap-2 text-[14px] font-semibold text-slate-900">
              <ShoppingCart className="h-4 w-4 text-[#3370ff]" />关联采购合同
              <span className="tnum rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-500">{purchases.length}</span>
            </h3>
            <p className="mt-1 text-xs text-slate-400">该销售合同对应的供应商采购：硬件、授权、算力等</p>
            <div className="mt-4 space-y-2.5">
              {purchases.length === 0 && (
                <p className="rounded-lg border border-dashed border-slate-300 py-7 text-center text-[13px] text-slate-400">纯软件交付，暂无采购合同</p>
              )}
              {purchases.map(pc => (
                <div key={pc.id} className="rounded-lg border border-slate-200 p-3.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <Truck className="h-4 w-4 text-slate-400" />
                    <span className="text-[13px] font-semibold text-slate-800">{pc.supplier}</span>
                    <span className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[11px] text-slate-500">{pc.category}</span>
                    <span className={cn('rounded border px-1.5 py-0.5 text-[11px] font-medium', purchaseStatusColor[pc.status])}>{pc.status}</span>
                    <span className="tnum ml-auto text-[13px] font-bold text-slate-900">{fmtMoneyFull(pc.amount)}</span>
                  </div>
                  <p className="mt-1.5 pl-6 text-xs leading-relaxed text-slate-500">{pc.content}</p>
                  <p className="tnum mt-1 pl-6 text-[11px] text-slate-400">{pc.code}{pc.signDate && <> · 签订于 {pc.signDate}</>}</p>
                </div>
              ))}
            </div>
          </div>

          {/* 回款节点 */}
          <div className="rounded-xl border border-slate-200/60 bg-white shadow-sm p-4 sm:p-5">
            <h3 className="text-[14px] font-semibold text-slate-900">回款节点</h3>
            <div className="mt-3 flex flex-wrap gap-2">
              {contract.payments.map(py => (
                <div key={py.id} className={cn('flex items-center gap-2.5 rounded-lg border px-3.5 py-2 text-[13px]',
                  py.done ? 'border-emerald-200 bg-emerald-50/60' : 'border-slate-200 bg-slate-50/60')}>
                  {py.done ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <span className="h-4 w-4 rounded-full border-2 border-slate-300" />}
                  <span className="tnum text-slate-600">{py.date}</span>
                  <span className="tnum font-semibold text-slate-800">{fmtMoneyFull(py.amount)}</span>
                  <span className="text-xs text-slate-400">{(py.ratio * 100).toFixed(0)}%</span>
                  {!py.done && (
                    <Button size="sm" variant="ghost" className="h-6 px-2 text-xs text-[#3370ff] hover:bg-blue-50" onClick={() => settlePayment(contract.id, py.id)}>
                      登记回款
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* 登记修订 */}
        <Dialog open={revOpen} onOpenChange={setRevOpen}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>登记合同修订（v{currentVersion + 1}）</DialogTitle>
              <DialogDescription>记录本轮修改的来源意见与具体改动，版本留痕可追溯。</DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <Input value={revBy} onChange={e => setRevBy(e.target.value)} placeholder="意见来源，如：甲方法务 / 甲方采购办 / 我方商务" />
              <Textarea value={revOpinion} onChange={e => setRevOpinion(e.target.value)} rows={3} placeholder="对方意见，例如：验收标准需细化为可考核指标…" />
              <Textarea value={revChange} onChange={e => setRevChange(e.target.value)} rows={3} placeholder="对应修改，例如：验收条款修订为「试运行 30 天无重大故障」…" />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setRevOpen(false)}>取消</Button>
              <Button className="bg-[#3370ff] hover:bg-[#2952cc]" disabled={!revOpinion.trim() || !revChange.trim()} onClick={submitRevision}>登记修订</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </SheetContent>
    </Sheet>
  )
}

export function Contracts() {
  const { contracts, channels, advanceContract, settlePayment, purchaseContracts, renewals, followRenewal, confirmRenewal } = useStore()
  const [view, setView] = useState<'list' | 'board'>('list')
  const [detailId, setDetailId] = useState<string | null>(null)
  const detailContract = contracts.find(c => c.id === detailId)

  const daysUntil = (date: string) => Math.ceil((new Date(date).getTime() - Date.now()) / 86400000)
  const pendingRenewals = renewals.filter(r => r.status === '待续费' || r.status === '跟进中')

  return (
    <div>
      <PageHeader
        title="合同管理"
        desc="回款后分佣自动计入渠道台账 · 每份销售合同可关联供应商采购合同"
        actions={
          <div className="flex rounded-lg border border-slate-200/60 bg-white shadow-sm p-0.5">
            <button onClick={() => setView('list')} className={cn('flex items-center gap-1 rounded-md px-3 py-1.5 text-xs font-medium', view === 'list' ? 'bg-[#3370ff] text-white' : 'text-slate-500')}>
              <LayoutList className="h-3.5 w-3.5" />列表
            </button>
            <button onClick={() => setView('board')} className={cn('flex items-center gap-1 rounded-md px-3 py-1.5 text-xs font-medium', view === 'board' ? 'bg-[#3370ff] text-white' : 'text-slate-500')}>
              <Columns3 className="h-3.5 w-3.5" />状态看板
            </button>
          </div>
        }
      />

      {view === 'list' ? (
        <div className="space-y-3">
          {contracts.map(c => {
            const channel = channels.find(ch => ch.id === c.channelId)
            const nextStatus = STATUS_FLOW[STATUS_FLOW.indexOf(c.status) + 1]
            const pcList = purchaseContracts.filter(pc => pc.contractId === c.id)
            const pcTotal = pcList.reduce((s, p) => s + p.amount, 0)
            const revCount = c.revisions.length
            return (
              <div key={c.id} className="rounded-xl border border-slate-200/60 bg-white shadow-sm p-4 sm:p-5 transition-all hover:border-[#3370ff]/40 hover:shadow-sm">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <button className="text-left" onClick={() => setDetailId(c.id)}>
                    <div className="flex items-center gap-2.5">
                      <span className="tnum text-[15px] font-bold text-slate-900 hover:text-[#3370ff]">{c.code}</span>
                      <span className={cn('rounded border px-1.5 py-0.5 text-[11px] font-medium', statusColor[c.status])}>{c.status}</span>
                      <span className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[11px] text-slate-500">{c.salesType}销售</span>
                      {revCount > 1 && (
                        <span className="tnum rounded border border-indigo-200 bg-indigo-50 px-1.5 py-0.5 text-[11px] text-indigo-600">已修订至 v{revCount}</span>
                      )}
                    </div>
                    <p className="mt-1 text-[13px] text-slate-500">
                      {c.customer}
                      {channel && <> · 渠道方：{channel.name}（分佣 {(c.commissionRate * 100).toFixed(0)}%）</>}
                    </p>
                    <p className="mt-1 flex items-center gap-1.5 text-xs text-slate-400">
                      <ShoppingCart className="h-3 w-3" />
                      {pcList.length > 0 ? <>采购合同 {pcList.length} 份 · 采购成本 <span className="tnum">{fmtMoneyFull(pcTotal)}</span> · 预估毛利 <span className="tnum text-emerald-600">{fmtMoneyFull(c.amount - pcTotal)}</span></> : '纯软件交付，暂无采购合同'}
                      <span className="ml-1 font-medium text-[#3370ff]">详情 →</span>
                    </p>
                  </button>
                  <div className="flex items-center gap-4">
                    <div className="text-right">
                      <Money value={c.amount} className="text-xl text-slate-900" />
                      {c.channelId && <p className="text-xs text-slate-400">分佣 <span className="tnum">{fmtMoneyFull(Math.round(c.amount * c.commissionRate))}</span></p>}
                    </div>
                    {nextStatus && (
                      <Button size="sm" variant="outline" onClick={() => advanceContract(c.id)}>
                        推进到「{nextStatus}」<ChevronRight className="h-3.5 w-3.5 ml-1" />
                      </Button>
                    )}
                  </div>
                </div>

                {/* 回款节点 */}
                <div className="mt-4 border-t border-slate-100 pt-4">
                  <p className="mb-2.5 text-xs font-medium text-slate-500">回款节点</p>
                  <div className="flex flex-wrap gap-2">
                    {c.payments.map(py => (
                      <div key={py.id} className={cn('flex items-center gap-2.5 rounded-lg border px-3.5 py-2 text-[13px]',
                        py.done ? 'border-emerald-200 bg-emerald-50/60' : 'border-slate-200 bg-slate-50/60')}>
                        {py.done ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <span className="h-4 w-4 rounded-full border-2 border-slate-300" />}
                        <span className="tnum text-slate-600">{py.date}</span>
                        <span className="tnum font-semibold text-slate-800">{fmtMoneyFull(py.amount)}</span>
                        <span className="text-xs text-slate-400">{(py.ratio * 100).toFixed(0)}%</span>
                        {!py.done && (
                          <Button size="sm" variant="ghost" className="h-6 px-2 text-xs text-[#3370ff] hover:bg-blue-50" onClick={() => settlePayment(c.id, py.id)}>
                            登记回款
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      ) : (
        <div className="overflow-x-auto -mx-4 px-4 md:mx-0 md:px-0">
        <div className="grid grid-cols-5 gap-3 min-w-[920px]">
          {STATUS_FLOW.map(s => (
            <div key={s} className="rounded-xl border border-slate-200 bg-slate-50/60 p-3">
              <div className="mb-3 flex items-center justify-between px-1">
                <span className={cn('rounded border px-1.5 py-0.5 text-[11px] font-medium', statusColor[s])}>{s}</span>
                <span className="tnum text-xs text-slate-400">{contracts.filter(c => c.status === s).length}</span>
              </div>
              <div className="space-y-2">
                {contracts.filter(c => c.status === s).map(c => (
                  <button key={c.id} onClick={() => setDetailId(c.id)} className="w-full rounded-lg border border-slate-200/60 bg-white shadow-sm p-3 text-left shadow-sm transition-all hover:border-[#3370ff]/50">
                    <p className="text-[13px] font-medium text-slate-800 leading-snug">{c.customer}</p>
                    <div className="mt-2 flex items-center justify-between">
                      <Money value={c.amount} className="text-[13px] text-[#3370ff]" />
                      <span className="tnum text-[11px] text-slate-400">{c.code}</span>
                    </div>
                  </button>
                ))}
                {contracts.filter(c => c.status === s).length === 0 && (
                  <p className="py-6 text-center text-xs text-slate-400">暂无</p>
                )}
              </div>
            </div>
          ))}
        </div>
        </div>
      )}

      {/* 订阅续费台账：标准产品的长期捆绑落脚点 */}
      <div className="mt-6 rounded-xl border border-slate-200/60 bg-white shadow-sm p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="flex items-center gap-2 text-[15px] font-semibold text-slate-900">
              <Repeat className="h-4 w-4 text-[#3370ff]" />订阅续费台账
              <span className="hidden sm:inline text-[11px] font-normal text-slate-400">记忆容量 / Token / 积分 / 私有化授权 · 到期续费与增购，长期捆绑客户</span>
            </h2>
          </div>
          <span className="tnum rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-[12px] font-semibold text-[#3370ff]">
            {pendingRenewals.length} 项待跟进 · {fmtMoneyFull(pendingRenewals.reduce((s, r) => s + r.amount, 0))}
          </span>
        </div>

        <div className="mt-4 space-y-2.5">
          {renewals.map(r => {
            const d = daysUntil(r.dueDate)
            const active = r.status === '待续费' || r.status === '跟进中'
            return (
              <div key={r.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-100 bg-slate-50/60 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-medium text-slate-800">{r.customer} · {r.item}</p>
                  <p className="mt-0.5 text-[11px] text-slate-400">
                    到期 <span className="tnum">{r.dueDate}</span>
                    {active && <span className={cn('tnum ml-1.5 font-semibold', d <= 30 ? 'text-rose-500' : d <= 60 ? 'text-amber-600' : 'text-slate-400')}>
                      {d >= 0 ? `（${d} 天后）` : `（已逾期 ${-d} 天）`}
                    </span>}
                    {r.note && <span className="ml-1.5">· {r.note}</span>}
                  </p>
                </div>
                <span className="tnum text-[14px] font-bold text-slate-900">{fmtMoneyFull(r.amount)}</span>
                <span className={cn('rounded border px-1.5 py-0.5 text-[11px] font-medium',
                  r.status === '已续费' ? 'border-emerald-200 bg-emerald-50 text-emerald-600'
                  : r.status === '跟进中' ? 'border-blue-200 bg-blue-50 text-[#3370ff]'
                  : r.status === '已流失' ? 'border-slate-200 bg-slate-50 text-slate-400'
                  : 'border-amber-200 bg-amber-50 text-amber-700')}>{r.status}</span>
                {r.status === '待续费' && (
                  <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => followRenewal(r.id)}>
                    <BellRing className="h-3 w-3 mr-1" />转为跟进
                  </Button>
                )}
                {active && (
                  <Button size="sm" className="h-7 bg-[#3370ff] text-xs hover:bg-[#2952cc]" onClick={() => confirmRenewal(r.id)}>
                    <CheckCircle2 className="h-3 w-3 mr-1" />确认续费
                  </Button>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {detailContract && <ContractDetailSheet contract={detailContract} onClose={() => setDetailId(null)} />}
    </div>
  )
}
