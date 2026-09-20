import { useState } from 'react'
import { useStore } from '@/store/AppContext'
import { Money, PageHeader } from '@/components/bits'
import { fmtMoneyFull } from '@/types'
import { Phone, User, Handshake, MapPin, Wrench, CheckCircle2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

const typeColor: Record<string, string> = {
  '行业渠道': 'bg-blue-50 text-blue-700 border-blue-200',
  '生态渠道': 'bg-emerald-50 text-emerald-700 border-emerald-200',
  '战略协同': 'bg-indigo-50 text-indigo-700 border-indigo-200',
}

export function Channels() {
  const { channels, contracts, partners, settlePartner } = useStore()
  const [tab, setTab] = useState<'channels' | 'partners'>('channels')

  const direct = contracts.filter(c => c.salesType === '直接').reduce((s, c) => s + c.amount, 0)
  const indirect = contracts.filter(c => c.salesType !== '直接').reduce((s, c) => s + c.amount, 0)
  const total = direct + indirect || 1
  const maxContribution = Math.max(...channels.map(c => c.totalContribution), 1)
  const pendingTotal = partners.reduce((s, p) => s + p.pendingSettle, 0)

  return (
    <div>
      <PageHeader
        title="渠道与伙伴"
        desc="获客渠道按单分佣 · 集成服务商按项目交付结算 · 两条线分开核算"
        actions={
          <div className="flex rounded-lg border border-slate-200/60 bg-white shadow-sm p-0.5">
            <button onClick={() => setTab('channels')} className={cn('rounded-md px-3 py-1.5 text-xs font-medium', tab === 'channels' ? 'bg-[#3370ff] text-white' : 'text-slate-500')}>获客渠道</button>
            <button onClick={() => setTab('partners')} className={cn('rounded-md px-3 py-1.5 text-xs font-medium', tab === 'partners' ? 'bg-[#3370ff] text-white' : 'text-slate-500')}>集成服务商</button>
          </div>
        }
      />

      {tab === 'partners' ? (
        <div className="space-y-5">
          {/* 合作模式说明 */}
          <div className="rounded-2xl border border-[#3370ff]/20 bg-gradient-to-r from-blue-50/80 to-indigo-50/60 p-5">
            <p className="flex items-center gap-2 text-[13px] font-semibold text-slate-800">
              <Handshake className="h-4 w-4 text-[#3370ff]" />FDE × 集成服务商：我们出标准产品与记忆底座，伙伴做落地交付
            </p>
            <p className="mt-2 text-[12px] leading-relaxed text-slate-500">
              一体机进场、私有化部署、行业系统对接由当地集成服务商实施，按项目额 {`10%~20%`} 结算交付分成；
              记忆容量 / Token / 授权等订阅续费始终回到太忆，客户长期捆绑在标准产品体系内。
            </p>
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            {partners.map(pa => {
              const projContracts = pa.projects.map(id => contracts.find(c => c.id === id)).filter(Boolean)
              return (
                <div key={pa.id} className="rounded-xl border border-slate-200/60 bg-white shadow-sm p-5">
                  <div className="flex items-start justify-between">
                    <div>
                      <h3 className="text-[15px] font-semibold text-slate-900">{pa.name}</h3>
                      <p className="mt-1 flex items-center gap-1 text-[12px] text-slate-400"><MapPin className="h-3 w-3" />{pa.region}</p>
                    </div>
                    <span className={cn('rounded border px-1.5 py-0.5 text-[11px] font-medium',
                      pa.status === '合作中' ? 'border-emerald-200 bg-emerald-50 text-emerald-600' : 'border-slate-200 bg-slate-50 text-slate-500')}>{pa.status}</span>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {pa.capabilities.map(c => (
                      <span key={c} className="flex items-center gap-1 rounded-md bg-slate-50 border border-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">
                        <Wrench className="h-2.5 w-2.5" />{c}
                      </span>
                    ))}
                  </div>
                  <div className="mt-3 space-y-1.5 text-[12px] text-slate-500">
                    <p className="flex items-center gap-2"><User className="h-3.5 w-3.5 text-slate-400" />{pa.contact} · <span className="tnum">{pa.phone}</span></p>
                    <p>交付结算比例：<span className="tnum font-semibold text-[#3370ff]">{(pa.shareRate * 100).toFixed(0)}%</span>（按项目额）</p>
                  </div>
                  <div className="mt-3 border-t border-slate-100 pt-3">
                    <p className="text-[11px] font-medium text-slate-400">在交付项目（{projContracts.length}）</p>
                    {projContracts.length === 0 ? (
                      <p className="mt-1 text-[12px] text-slate-400">暂无在交付项目{pa.status === '待激活' ? '，待激活后派单' : '，POC 阶段跟进中'}</p>
                    ) : (
                      <div className="mt-1.5 space-y-1">
                        {projContracts.map(c => c && (
                          <p key={c.id} className="text-[12px] text-slate-600">· {c.customer}（<span className="tnum">{c.code}</span> · {fmtMoneyFull(c.amount)}）</p>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="mt-4 grid grid-cols-2 gap-2 border-t border-slate-100 pt-4 text-center">
                    <div><p className="tnum text-[15px] font-bold text-slate-900"><Money value={pa.totalSettled} /></p><p className="text-[11px] text-slate-400">累计已结算</p></div>
                    <div><p className="tnum text-[15px] font-bold text-amber-600"><Money value={pa.pendingSettle} /></p><p className="text-[11px] text-slate-400">待结算</p></div>
                  </div>
                  {pa.pendingSettle > 0 && (
                    <Button size="sm" variant="outline" className="mt-3 w-full text-xs" onClick={() => settlePartner(pa.id)}>
                      <CheckCircle2 className="h-3.5 w-3.5 mr-1" />结算交付分成 {fmtMoneyFull(pa.pendingSettle)}
                    </Button>
                  )}
                </div>
              )
            })}
          </div>

          {pendingTotal > 0 && (
            <p className="tnum text-right text-[12px] text-slate-400">伙伴待结算合计 <span className="font-semibold text-amber-600">{fmtMoneyFull(pendingTotal)}</span></p>
          )}
        </div>
      ) : (
      <>
      {/* 直接 vs 间接 */}
      <div className="rounded-xl border border-slate-200/60 bg-white shadow-sm p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-[15px] font-semibold text-slate-900">直接 vs 间接销售占比</h2>
          <span className="text-xs text-slate-400">按合同金额</span>
        </div>
        <div className="flex h-9 w-full overflow-hidden rounded-lg">
          <div className="flex items-center justify-center bg-[#3370ff] text-[13px] font-semibold text-white tnum" style={{ width: `${(direct / total) * 100}%` }}>
            直接 {Math.round((direct / total) * 100)}%
          </div>
          <div className="flex flex-1 items-center justify-center bg-[#7db8e8] text-[13px] font-semibold text-white tnum">
            间接 {Math.round((indirect / total) * 100)}%
          </div>
        </div>
        <div className="mt-3 flex gap-6 text-[13px] text-slate-500">
          <span>直接销售 <span className="tnum font-semibold text-slate-800">{fmtMoneyFull(direct)}</span></span>
          <span>间接销售（渠道/转介绍） <span className="tnum font-semibold text-slate-800">{fmtMoneyFull(indirect)}</span></span>
        </div>
      </div>

      {/* 渠道商档案 */}
      <div className="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-3">
        {channels.map(ch => (
          <div key={ch.id} className="rounded-xl border border-slate-200/60 bg-white shadow-sm p-5">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-[15px] font-semibold text-slate-900">{ch.name}</h3>
                <span className={cn('mt-1.5 inline-block rounded border px-1.5 py-0.5 text-[11px] font-medium', typeColor[ch.type])}>{ch.type}</span>
              </div>
              <div className="text-right">
                <p className="tnum text-lg font-bold text-[#3370ff]">{(ch.commissionRate * 100).toFixed(0)}%</p>
                <p className="text-[11px] text-slate-400">分佣比例</p>
              </div>
            </div>
            <div className="mt-4 space-y-2 text-[13px]">
              <div className="flex items-center gap-2 text-slate-600"><User className="h-3.5 w-3.5 text-slate-400" />{ch.contact}</div>
              <div className="flex items-center gap-2 text-slate-600"><Phone className="h-3.5 w-3.5 text-slate-400" /><span className="tnum">{ch.phone}</span></div>
            </div>
            <div className="mt-4 grid grid-cols-3 gap-2 border-t border-slate-100 pt-4 text-center">
              <div><p className="tnum text-[15px] font-bold text-slate-900">{ch.inFlight}</p><p className="text-[11px] text-slate-400">在途单数</p></div>
              <div><p className="tnum text-[15px] font-bold text-slate-900"><Money value={ch.totalContribution} /></p><p className="text-[11px] text-slate-400">历史贡献</p></div>
              <div><p className="tnum text-[15px] font-bold text-emerald-600"><Money value={ch.commissionPaid} /></p><p className="text-[11px] text-slate-400">已付分佣</p></div>
            </div>
          </div>
        ))}
      </div>

      {/* 贡献排行 */}
      <div className="mt-5 rounded-xl border border-slate-200/60 bg-white shadow-sm p-5">
        <h2 className="text-[15px] font-semibold text-slate-900">渠道贡献排行</h2>
        <div className="mt-4 space-y-3">
          {[...channels].sort((a, b) => b.totalContribution - a.totalContribution).map((ch, i) => (
            <div key={ch.id} className="flex items-center gap-3">
              <span className={cn('tnum flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-xs font-bold',
                i === 0 ? 'bg-[#3370ff] text-white' : 'bg-slate-100 text-slate-500')}>{i + 1}</span>
              <span className="w-24 sm:w-40 truncate text-[13px] font-medium text-slate-700">{ch.name}</span>
              <div className="h-5 flex-1 overflow-hidden rounded bg-slate-100">
                <div className="h-full rounded bg-gradient-to-r from-[#3370ff]/70 to-[#3370ff]" style={{ width: `${Math.max((ch.totalContribution / maxContribution) * 100, 2)}%` }} />
              </div>
              <span className="tnum w-24 text-right text-[13px] font-semibold text-slate-800">{fmtMoneyFull(ch.totalContribution)}</span>
            </div>
          ))}
        </div>
      </div>
      </>
      )}
    </div>
  )
}
