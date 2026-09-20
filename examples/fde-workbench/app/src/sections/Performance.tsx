import { useState } from 'react'
import { useStore } from '@/store/AppContext'
import { cn } from '@/lib/utils'
import { fmtMoneyFull } from '@/types'
import { commissionRateOf, CONTRIBUTION_STAGES } from '@/data/mock'
import { Medal, Sparkles, Lock, Handshake, Users, CircleDollarSign, Info, Network, Plus, CheckCircle2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'

const MEMBER_COLORS = ['#3370ff', '#7c3aed', '#059669', '#d97706', '#dc2626']
const memberColor = (name: string, members: string[]) => MEMBER_COLORS[members.indexOf(name) % MEMBER_COLORS.length]

/** 绩效提成：从线索到签单全流程贡献度计量，多人协商分配 */
export function Performance() {
  const { contracts, allocations, role, setContributionShare, autoAllocate, confirmAllocation, navigate,
    channels, channelCommissions, registerChannelCommission, settleChannelCommission } = useStore()
  const [regFor, setRegFor] = useState<string | null>(null)
  const [regChannel, setRegChannel] = useState('')
  const [regRate, setRegRate] = useState('8')

  const tracked = contracts.filter(c => allocations.some(a => a.contractId === c.id))
  const members = [...new Set(allocations.flatMap(a => a.shares.map(s => s.member)))]

  const poolTotal = tracked.reduce((s, c) => s + c.amount * commissionRateOf(c.amount), 0)
  const confirmedTotal = tracked
    .filter(c => allocations.find(a => a.contractId === c.id)?.status === '已确认')
    .reduce((s, c) => s + c.amount * commissionRateOf(c.amount), 0)

  /** 个人汇总 */
  const memberStats = members.map(m => {
    let total = 0, projects = 0
    const stageSet = new Set<string>()
    tracked.forEach(c => {
      const a = allocations.find(x => x.contractId === c.id)
      const sh = a?.shares.find(s => s.member === m)
      if (sh) {
        total += c.amount * commissionRateOf(c.amount) * sh.share / 100
        projects += 1
        sh.stages.forEach(st => stageSet.add(st))
      }
    })
    return { member: m, total, projects, stages: [...stageSet] }
  }).sort((a, b) => b.total - a.total)
  const maxTotal = Math.max(...memberStats.map(x => x.total), 1)

  return (
    <div className="space-y-7">
      {/* 头部 */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-[18px] font-bold text-slate-900">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-50"><Medal className="h-[18px] w-[18px] text-[#3370ff]" /></span>
            绩效提成
          </h2>
          <p className="mt-1.5 text-[12px] text-slate-400">从线索到签单全流程贡献度计量 · 提成 1%–3% 按金额阶梯 · 多人协助协商分配</p>
        </div>
        <div className="flex gap-2">
          <span className="tnum rounded-full border border-slate-200 bg-white px-3 py-1 text-[12px] text-slate-500">
            提成池 <b className="text-slate-800">{fmtMoneyFull(Math.round(poolTotal))}</b>
          </span>
          <span className="tnum rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-[12px] text-emerald-700">
            已确认 {fmtMoneyFull(Math.round(confirmedTotal))}
          </span>
        </div>
      </div>

      {/* 规则说明 */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-2xl border border-blue-100 bg-blue-50/50 px-5 py-3.5 text-[12px] text-slate-600">
        <span className="flex items-center gap-1.5 font-medium text-[#3370ff]"><Info className="h-3.5 w-3.5" />计提规则</span>
        <span className="tnum">合同 ≥ 100 万 → <b>3%</b></span>
        <span className="tnum">30–100 万 → <b>2%</b></span>
        <span className="tnum">&lt; 30 万 → <b>1%</b></span>
        <span className="text-slate-400">环节参考权重：{CONTRIBUTION_STAGES.map(s => `${s.name} ${s.weight}%`).join(' · ')}</span>
      </div>

      {/* 个人提成榜 */}
      <div className="rounded-2xl border border-slate-200/60 bg-white shadow-sm p-6">
        <h3 className="flex items-center gap-2 text-[15px] font-semibold text-slate-900"><Users className="h-4 w-4 text-slate-400" />个人提成汇总</h3>
        <div className="mt-5 space-y-4">
          {memberStats.map((ms, i) => (
            <div key={ms.member} className="flex items-center gap-3">
              <span className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[12px] font-bold text-white')}
                style={{ background: memberColor(ms.member, members) }}>{ms.member[0]}</span>
              <div className="w-20 shrink-0">
                <p className="text-[13px] font-medium text-slate-800">{ms.member}{ms.member === role.name && <span className="ml-1 text-[10px] text-[#3370ff]">(我)</span>}</p>
                <p className="tnum text-[10px] text-slate-400">{ms.projects} 个项目</p>
              </div>
              <div className="h-6 min-w-0 flex-1 overflow-hidden rounded-md bg-slate-100">
                <div className="flex h-full items-center rounded-md pl-2 transition-all" style={{ width: `${Math.max(ms.total / maxTotal * 100, 8)}%`, background: memberColor(ms.member, members) }}>
                  <span className="tnum whitespace-nowrap text-[11px] font-semibold text-white">{fmtMoneyFull(Math.round(ms.total))}</span>
                </div>
              </div>
              <span className="hidden sm:block w-40 shrink-0 text-right text-[10px] leading-tight text-slate-400">{ms.stages.join(' · ')}</span>
              {i === 0 && <Medal className="h-4 w-4 shrink-0 text-amber-500" />}
            </div>
          ))}
        </div>
      </div>

      {/* 按合同分配 */}
      <div className="space-y-5">
        {tracked.map(c => {
          const a = allocations.find(x => x.contractId === c.id)!
          const rate = commissionRateOf(c.amount)
          const bonus = c.amount * rate
          const sum = a.shares.reduce((s, x) => s + x.share, 0)
          const locked = a.status === '已确认'
          return (
            <div key={c.id} className="rounded-2xl border border-slate-200/60 bg-white shadow-sm p-6">
              <div className="flex flex-wrap items-center gap-2.5">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <button onClick={() => navigate({ name: 'contracts' })} className="text-[15px] font-semibold text-slate-900 hover:text-[#3370ff]">{c.customer}</button>
                    <span className={cn('rounded border px-1.5 py-0.5 text-[11px] font-medium',
                      locked ? 'border-emerald-200 bg-emerald-50 text-emerald-600' : 'border-amber-200 bg-amber-50 text-amber-700')}>
                      {locked ? <Lock className="mr-0.5 inline h-3 w-3" /> : <Handshake className="mr-0.5 inline h-3 w-3" />}{a.status}
                    </span>
                  </div>
                  <p className="tnum mt-1 text-[12px] text-slate-400">
                    {c.code} · 合同额 {fmtMoneyFull(c.amount)} · 提成比例 {Math.round(rate * 100)}% · {c.status}
                  </p>
                </div>
                <div className="text-right">
                  <p className="tnum flex items-center justify-end gap-1 text-[17px] font-bold text-slate-900">
                    <CircleDollarSign className="h-4 w-4 text-amber-500" />{fmtMoneyFull(Math.round(bonus))}
                  </p>
                  <p className="text-[10px] text-slate-400">本单提成池</p>
                </div>
              </div>

              {/* 分配表 */}
              <div className="mt-5 space-y-2.5">
                {a.shares.map(s => (
                  <div key={s.member} className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-100 bg-slate-50/60 px-4 py-3">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white"
                      style={{ background: memberColor(s.member, members) }}>{s.member[0]}</span>
                    <div className="min-w-[100px]">
                      <p className="text-[13px] font-medium text-slate-800">{s.member}{s.member === role.name && <span className="ml-1 text-[10px] text-[#3370ff]">(我)</span>}</p>
                    </div>
                    <div className="flex min-w-0 flex-1 flex-wrap gap-1">
                      {s.stages.map(st => (
                        <span key={st} className="rounded bg-white border border-slate-200 px-1.5 py-0.5 text-[10px] text-slate-500">{st}</span>
                      ))}
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="h-2 w-20 overflow-hidden rounded-full bg-slate-200">
                        <div className="h-full rounded-full" style={{ width: `${s.share}%`, background: memberColor(s.member, members) }} />
                      </div>
                      {locked ? (
                        <span className="tnum w-14 text-right text-[13px] font-bold text-slate-800">{s.share}%</span>
                      ) : (
                        <span className="flex items-center gap-1">
                          <input
                            type="number" min={0} max={100} value={s.share}
                            onChange={e => setContributionShare(c.id, s.member, Math.max(0, Math.min(100, Number(e.target.value) || 0)))}
                            className="tnum h-7 w-14 rounded-md border border-slate-200 bg-white px-1.5 text-right text-[13px] font-bold text-slate-800 focus:border-[#3370ff] focus:outline-none"
                          />
                          <span className="text-[12px] text-slate-400">%</span>
                        </span>
                      )}
                      <span className="tnum w-20 text-right text-[12px] font-medium text-slate-600">{fmtMoneyFull(Math.round(bonus * s.share / 100))}</span>
                    </div>
                  </div>
                ))}
              </div>

              {/* 操作行 */}
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <span className={cn('tnum rounded-full px-2.5 py-1 text-[11px] font-medium',
                  sum === 100 ? 'bg-emerald-50 border border-emerald-200 text-emerald-600' : 'bg-rose-50 border border-rose-200 text-rose-600')}>
                  合计 {sum}%{sum !== 100 && '，需调整到 100%'}
                </span>
                {!locked && (
                  <>
                    <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => autoAllocate(c.id)}>
                      <Sparkles className="h-3.5 w-3.5 mr-1 text-[#3370ff]" />按环节权重智能分配
                    </Button>
                    <Button size="sm" className="ml-auto h-8 bg-[#3370ff] text-xs hover:bg-[#2952cc]" disabled={sum !== 100} onClick={() => confirmAllocation(c.id)}>
                      <Lock className="h-3 w-3 mr-1" />协商一致，确认分配
                    </Button>
                  </>
                )}
                {locked && <span className="ml-auto text-[11px] text-slate-400">分配已锁定，如需调整请联系管理员解锁</span>}
              </div>
            </div>
          )
        })}
      </div>

      {/* 渠道分佣（对外）：与内部个人提成分开核算 */}
      <div className="rounded-2xl border border-slate-200/60 bg-white shadow-sm p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="flex items-center gap-2 text-[15px] font-semibold text-slate-900">
              <Network className="h-4 w-4 text-[#3370ff]" />渠道分佣（对外）
            </h3>
            <p className="mt-1 text-[12px] text-slate-400">渠道方带来或促成的单子按合同登记分佣比例，与团队内部个人提成是两条账，分开核算</p>
          </div>
          <span className="tnum rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-[12px] font-medium text-amber-700">
            待结算 {fmtMoneyFull(Math.round(channelCommissions.filter(x => x.status === '待结算').reduce((s, x) => {
              const c = contracts.find(c => c.id === x.contractId); return s + (c ? c.amount * x.rate : 0)
            }, 0)))}
          </span>
        </div>

        <div className="mt-5 space-y-2.5">
          {tracked.map(c => {
            const cc = channelCommissions.find(x => x.contractId === c.id)
            const ch = channels.find(x => x.id === cc?.channelId)
            return (
              <div key={c.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-100 bg-slate-50/60 px-4 py-3.5">
                <div className="min-w-[180px] flex-1">
                  <p className="text-[13px] font-medium text-slate-800">{c.customer}</p>
                  <p className="tnum mt-0.5 text-[11px] text-slate-400">{c.code} · 合同额 {fmtMoneyFull(c.amount)} · {c.status}</p>
                </div>
                {cc && ch ? (
                  <>
                    <div className="flex items-center gap-2">
                      <span className="rounded-lg border border-violet-200 bg-violet-50 px-2.5 py-1 text-[12px] font-medium text-violet-700">{ch.name}</span>
                      <span className="tnum rounded border border-slate-200 bg-white px-2 py-1 text-[12px] font-semibold text-slate-700">{(cc.rate * 100).toFixed(0)}%</span>
                    </div>
                    <span className="tnum text-[14px] font-bold text-slate-900">{fmtMoneyFull(Math.round(c.amount * cc.rate))}</span>
                    {cc.status === '待结算' ? (
                      <div className="flex items-center gap-2 ml-auto">
                        <button
                          onClick={() => { setRegFor(c.id); setRegChannel(cc.channelId); setRegRate(String(cc.rate * 100)) }}
                          className="text-[11px] text-slate-400 hover:text-[#3370ff]"
                        >调整</button>
                        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => settleChannelCommission(c.id)}>
                          <CheckCircle2 className="h-3 w-3 mr-1" />结算
                        </Button>
                      </div>
                    ) : (
                      <span className="tnum ml-auto rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[11px] font-medium text-emerald-600">已结算 {cc.settledAt}</span>
                    )}
                  </>
                ) : (
                  <button
                    onClick={() => { setRegFor(c.id); setRegChannel(channels[0]?.id ?? ''); setRegRate('8') }}
                    className="ml-auto flex items-center gap-1 rounded-lg border border-dashed border-slate-300 px-3 py-1.5 text-[12px] text-slate-500 hover:border-[#3370ff] hover:text-[#3370ff] transition-colors"
                  >
                    <Plus className="h-3.5 w-3.5" />登记渠道分佣
                  </button>
                )}
              </div>
            )
          })}
        </div>
        <p className="mt-4 text-[11px] leading-relaxed text-slate-400">
          直销单无渠道分佣；间接单分佣在合同回款后结算，与上方内部个人提成互不影响、分别列支。
        </p>
      </div>

      {/* 登记/调整渠道分佣 */}
      <Dialog open={!!regFor} onOpenChange={v => !v && setRegFor(null)}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle className="text-[15px]">登记渠道分佣 · {contracts.find(c => c.id === regFor)?.code}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <p className="mb-1.5 text-[12px] font-medium text-slate-600">渠道方</p>
              <div className="space-y-1.5">
                {channels.map(ch => (
                  <button
                    key={ch.id}
                    onClick={() => setRegChannel(ch.id)}
                    className={cn('flex w-full items-center justify-between rounded-lg border px-3 py-2.5 text-left transition-colors',
                      regChannel === ch.id ? 'border-[#3370ff] bg-blue-50' : 'border-slate-200 hover:border-slate-300')}
                  >
                    <span className="text-[13px] font-medium text-slate-800">{ch.name}</span>
                    <span className="text-[11px] text-slate-400">{ch.type} · 联系人 {ch.contact}</span>
                  </button>
                ))}
              </div>
            </div>
            <div>
              <p className="mb-1.5 text-[12px] font-medium text-slate-600">分佣比例（%）</p>
              <Input type="number" min={1} max={30} value={regRate} onChange={e => setRegRate(e.target.value)} />
              {regFor && (
                <p className="tnum mt-1.5 text-[12px] text-slate-400">
                  预计分佣 {fmtMoneyFull(Math.round((contracts.find(c => c.id === regFor)?.amount ?? 0) * (Number(regRate) || 0) / 100))}
                </p>
              )}
            </div>
            <Button
              className="w-full bg-[#3370ff] hover:bg-[#2952cc]"
              disabled={!regChannel || !(Number(regRate) > 0)}
              onClick={() => { registerChannelCommission(regFor!, regChannel, (Number(regRate) || 0) / 100); setRegFor(null) }}
            >保存登记</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
