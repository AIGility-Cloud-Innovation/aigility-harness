import { useMemo, useState } from 'react'
import { useStore } from '@/store/AppContext'
import { cn } from '@/lib/utils'
import type { Page, TeamTask } from '@/types'
import { fmtMoney } from '@/types'
import { TEAM_MEMBERS } from '@/data/mock'
import {
  ListTodo, MessageSquareReply, FileSearch, Mic, BrainCircuit, BellRing,
  CircleDollarSign, PackageCheck, ChevronRight, RefreshCw, type LucideIcon,
  Users, Plus, Play, CheckCheck, Undo2, Trash2, Link2,
} from 'lucide-react'

interface TaskItem {
  id: string
  title: string
  meta: string
  tone: 'orange' | 'blue' | 'amber' | 'violet' | 'rose' | 'emerald' | 'indigo' | 'cyan'
  page: Page
}

interface TaskGroup {
  key: string
  label: string
  icon: LucideIcon
  desc: string
  items: TaskItem[]
}

const PRIORITY_META: Record<TeamTask['priority'], { cls: string; dot: string }> = {
  高: { cls: 'border-rose-200 bg-rose-50 text-rose-600', dot: 'bg-rose-500' },
  中: { cls: 'border-amber-200 bg-amber-50 text-amber-600', dot: 'bg-amber-500' },
  低: { cls: 'border-slate-200 bg-slate-50 text-slate-500', dot: 'bg-slate-400' },
}
const STATUS_META: Record<TeamTask['status'], { cls: string; next: string }> = {
  待处理: { cls: 'border-slate-200 bg-slate-50 text-slate-500', next: '开始处理' },
  进行中: { cls: 'border-blue-200 bg-blue-50 text-[#3370ff]', next: '标记完成' },
  已完成: { cls: 'border-emerald-200 bg-emerald-50 text-emerald-600', next: '重新打开' },
}

/** 待办中心：团队任务（可分派流转）+ 全流程智能待办聚合 */
export function Tasks() {
  const {
    scopedLeads, proposals, contracts, knowledge, reminders, deliveries, renewals, navigate,
    teamTasks, addTeamTask, advanceTeamTask, deleteTeamTask, role,
  } = useStore()
  const [tab, setTab] = useState<'team' | 'auto'>('team')

  /* ---------- 团队任务看板 ---------- */
  const [showForm, setShowForm] = useState(false)
  const [fTitle, setFTitle] = useState('')
  const [fDetail, setFDetail] = useState('')
  const [fAssignee, setFAssignee] = useState(TEAM_MEMBERS[0])
  const [fDue, setFDue] = useState('本周')
  const [fPriority, setFPriority] = useState<TeamTask['priority']>('中')
  const [filter, setFilter] = useState<'全部' | '我负责' | TeamTask['status']>('全部')

  const openCount = teamTasks.filter(t => t.status !== '已完成').length
  const mineCount = teamTasks.filter(t => t.assignee === role.name && t.status !== '已完成').length
  const doingCount = teamTasks.filter(t => t.status === '进行中').length
  const doneCount = teamTasks.filter(t => t.status === '已完成').length

  const filteredTasks = teamTasks.filter(t =>
    filter === '全部' ? true : filter === '我负责' ? t.assignee === role.name : t.status === filter)

  const submitTask = () => {
    if (!fTitle.trim()) return
    addTeamTask({ title: fTitle.trim(), detail: fDetail.trim() || undefined, assignee: fAssignee, due: fDue, priority: fPriority })
    setFTitle(''); setFDetail(''); setFPriority('中'); setShowForm(false)
  }

  /* ---------- 智能待办聚合（原逻辑） ---------- */
  const groups = useMemo<TaskGroup[]>(() => {
    const leadName = (id: string) => scopedLeads.find(l => l.id === id)?.name ?? ''
    const g: TaskGroup[] = []

    const feedbacks = proposals.flatMap(p => p.feedbacks.filter(f => f.status === '待处理').map(f => ({
      id: `${p.id}-${f.id}`, title: `${p.title} · ${f.author}：${f.content}`,
      meta: `v${f.version} 甲方意见 · 响应后自动生成 v${p.version + 1}`,
      tone: 'orange' as const, page: { name: 'proposal', id: p.id } as Page,
    })))
    g.push({ key: 'feedback', label: '甲方反馈待响应', icon: MessageSquareReply, desc: '方案报价后的客户修改意见', items: feedbacks })

    const review = proposals.filter(p => p.status === '待审阅').map(p => ({
      id: p.id, title: `《${p.title}》v${p.version} 待审阅`,
      meta: `数字员工生成 · ${leadName(p.leadId)}`, tone: 'blue' as const,
      page: { name: 'proposal', id: p.id } as Page,
    }))
    g.push({ key: 'review', label: '方案待审阅', icon: FileSearch, desc: 'AI 三件套需人工确认后发出', items: review })

    const interviews = scopedLeads.flatMap(l => l.interviews.filter(iv => iv.status === '待确认').map(iv => ({
      id: iv.id, title: `「${l.name}」访谈「${iv.title}」转写待确认`,
      meta: `AI 已提炼 ${iv.extracted.length} 条要点 · 确认后沉淀过程记忆`, tone: 'violet' as const,
      page: { name: 'lead', id: l.id } as Page,
    })))
    g.push({ key: 'interview', label: '访谈转写待确认', icon: Mic, desc: '录音转文字要点需人工核对', items: interviews })

    const pendingK = knowledge.filter(k => k.status === '待审阅').map(k => ({
      id: k.id, title: k.title, meta: `${k.source} · ${k.date}`, tone: 'indigo' as const,
      page: { name: 'knowledge' } as Page,
    }))
    g.push({ key: 'knowledge', label: '知识候选待审阅', icon: BrainCircuit, desc: '规则/批注/模板采纳后才会复用', items: pendingK })

    const pays = contracts.flatMap(c => c.payments.filter(p => !p.done).map(p => ({
      id: p.id, title: `${c.customer} · ${c.code} 待回款 ${fmtMoney(p.amount)}`,
      meta: `约定 ${p.date} · 占比 ${Math.round(p.ratio * 100)}% · 合同${c.status}`, tone: 'emerald' as const,
      page: { name: 'contracts' } as Page,
    })))
    g.push({ key: 'payment', label: '回款节点待跟进', icon: CircleDollarSign, desc: '临近账期主动对齐开票与验收', items: pays })

    const rens = renewals.filter(r => r.status === '待续费' || r.status === '跟进中').map(r => ({
      id: r.id, title: `「${r.customer}」${r.item}`,
      meta: `到期 ${r.dueDate} · 续费 ${fmtMoney(r.amount)} 元 · 长期捆绑关键动作`, tone: 'cyan' as const,
      page: { name: 'contracts' } as Page,
    }))
    g.push({ key: 'renewal', label: '订阅续费待跟进', icon: RefreshCw, desc: '容量 / Token / 授权到期续费与增购', items: rens })

    const ms = deliveries.filter(d => d.status === '交付中' || d.status === '待启动').map(d => {
      const cur = d.milestones.find(m => m.status === '进行中')
      return {
        id: d.id, title: d.status === '待启动' ? `「${d.customer}」交付项目待启动` : `「${d.customer}」${cur ? `里程碑「${cur.name}」进行中` : '交付推进中'}`,
        meta: `${d.name} · 负责人 ${d.owner}`, tone: 'rose' as const,
        page: { name: 'delivery' } as Page,
      }
    })
    g.push({ key: 'delivery', label: '交付项目推进', icon: PackageCheck, desc: '里程碑 / 验收材料 / 回访', items: ms })

    const rems = reminders.filter(r => !r.done).map(r => ({
      id: r.id, title: r.title, meta: `${r.due} 到期${r.auto ? ' · 系统自动创建' : ''}`, tone: 'amber' as const,
      page: (r.leadId ? { name: 'lead', id: r.leadId } : { name: 'dashboard' }) as Page,
    }))
    g.push({ key: 'reminder', label: '跟进提醒', icon: BellRing, desc: '按跟进节奏自动生成', items: rems })

    return g
  }, [scopedLeads, proposals, contracts, knowledge, reminders, deliveries, renewals])

  const autoTotal = groups.reduce((s, g) => s + g.items.length, 0)

  return (
    <div className="space-y-7">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-[18px] font-bold text-slate-900">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-50"><ListTodo className="h-[18px] w-[18px] text-[#3370ff]" /></span>
            待办中心
          </h2>
          <p className="mt-1.5 text-[12px] text-slate-400">团队任务在这里分派与流转 · 全流程系统待办自动聚合 · AI 只准备，人来决定</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="tnum rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-[12px] font-semibold text-[#3370ff]">{openCount + autoTotal} 项待处理</span>
          <div className="flex rounded-lg border border-slate-200 bg-slate-50 p-0.5 text-[12px] font-medium">
            <button onClick={() => setTab('team')}
              className={cn('flex items-center gap-1.5 rounded-md px-3 py-1.5 transition-colors', tab === 'team' ? 'bg-[#3370ff] text-white shadow-sm' : 'text-slate-500 hover:text-slate-700')}>
              <Users className="h-3.5 w-3.5" />团队任务<span className="tnum">{openCount}</span>
            </button>
            <button onClick={() => setTab('auto')}
              className={cn('flex items-center gap-1.5 rounded-md px-3 py-1.5 transition-colors', tab === 'auto' ? 'bg-[#3370ff] text-white shadow-sm' : 'text-slate-500 hover:text-slate-700')}>
              <BellRing className="h-3.5 w-3.5" />智能待办<span className="tnum">{autoTotal}</span>
            </button>
          </div>
        </div>
      </div>

      {tab === 'team' ? (
        <div className="space-y-4">
          {/* 统计 + 新建 */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              { label: '待处理', val: teamTasks.filter(t => t.status === '待处理').length, cls: 'text-slate-700' },
              { label: '进行中', val: doingCount, cls: 'text-[#3370ff]' },
              { label: '已完成', val: doneCount, cls: 'text-emerald-600' },
              { label: '我负责的', val: mineCount, cls: 'text-violet-600' },
            ].map(s => (
              <div key={s.label} className="rounded-2xl border border-slate-200/60 bg-white shadow-sm px-4 py-3">
                <p className="text-[11px] text-slate-400">{s.label}</p>
                <p className={cn('tnum mt-1 text-[22px] font-bold leading-none', s.cls)}>{s.val}</p>
              </div>
            ))}
          </div>

          <div className="rounded-2xl border border-slate-200/60 bg-white shadow-sm p-4 md:p-5 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap gap-1.5">
                {(['全部', '我负责', '待处理', '进行中', '已完成'] as const).map(f => (
                  <button key={f} onClick={() => setFilter(f)}
                    className={cn('rounded-full border px-3 py-1 text-[12px] font-medium transition-colors',
                      filter === f ? 'border-[#3370ff] bg-blue-50 text-[#3370ff]' : 'border-slate-200 text-slate-500 hover:border-slate-300')}>
                    {f}
                  </button>
                ))}
              </div>
              <button onClick={() => setShowForm(v => !v)}
                className="flex items-center gap-1.5 rounded-lg bg-[#3370ff] px-3 py-1.5 text-[12px] font-medium text-white hover:bg-blue-600">
                <Plus className="h-3.5 w-3.5" />新建任务
              </button>
            </div>

            {showForm && (
              <div className="rounded-xl border border-blue-200/70 bg-blue-50/40 p-4 space-y-3 msg-in">
                <input value={fTitle} onChange={e => setFTitle(e.target.value)} placeholder="任务标题（必填）"
                  className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-[13px] outline-none focus:border-[#3370ff]" />
                <textarea value={fDetail} onChange={e => setFDetail(e.target.value)} placeholder="补充说明（可选）" rows={2}
                  className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-[12px] outline-none focus:border-[#3370ff]" />
                <div className="flex flex-wrap items-center gap-2">
                  <select value={fAssignee} onChange={e => setFAssignee(e.target.value)}
                    className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[12px] outline-none">
                    {TEAM_MEMBERS.map(m => <option key={m} value={m}>负责人：{m}</option>)}
                  </select>
                  <input value={fDue} onChange={e => setFDue(e.target.value)} placeholder="截止时间，如 09-20 / 本周"
                    className="w-40 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[12px] outline-none focus:border-[#3370ff]" />
                  <div className="flex rounded-lg border border-slate-200 p-0.5">
                    {(['高', '中', '低'] as const).map(p => (
                      <button key={p} onClick={() => setFPriority(p)}
                        className={cn('rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors',
                          fPriority === p ? 'bg-slate-900 text-white' : 'text-slate-500')}>{p}</button>
                    ))}
                  </div>
                  <button onClick={submitTask}
                    className="ml-auto rounded-lg bg-[#3370ff] px-4 py-1.5 text-[12px] font-medium text-white hover:bg-blue-600">
                    分派任务
                  </button>
                </div>
              </div>
            )}

            <div className="space-y-2">
              {filteredTasks.length === 0 && (
                <p className="py-8 text-center text-[13px] text-slate-400">该筛选下暂无任务</p>
              )}
              {filteredTasks.map(t => {
                const pm = PRIORITY_META[t.priority]
                const sm = STATUS_META[t.status]
                return (
                  <div key={t.id} className={cn('flex items-start gap-3 rounded-xl border p-3.5 transition-colors',
                    t.status === '已完成' ? 'border-slate-100 bg-slate-50/50 opacity-70' : 'border-slate-100 bg-slate-50/60 hover:border-[#3370ff]/40 hover:bg-blue-50/30')}>
                    <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', pm.dot)} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className={cn('text-[13px] font-medium leading-snug', t.status === '已完成' ? 'text-slate-400 line-through' : 'text-slate-800')}>{t.title}</p>
                        <span className={cn('rounded border px-1.5 py-0.5 text-[10px] font-medium', pm.cls)}>{t.priority}</span>
                        <span className={cn('rounded border px-1.5 py-0.5 text-[10px] font-medium', sm.cls)}>{t.status}</span>
                        {t.source !== '手动创建' && (
                          <span className="rounded border border-violet-200 bg-violet-50 px-1.5 py-0.5 text-[10px] font-medium text-violet-600">{t.source}</span>
                        )}
                      </div>
                      {t.detail && <p className="mt-1 text-[12px] leading-relaxed text-slate-400">{t.detail}</p>}
                      <p className="mt-1.5 text-[11px] text-slate-400">
                        负责人 <span className={cn('font-medium', t.assignee === role.name ? 'text-[#3370ff]' : 'text-slate-600')}>{t.assignee}</span>
                        {' · '}截止 {t.due}{' · '}{t.creator} 创建于 {t.createdAt}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {t.page && (
                        <button onClick={() => navigate(t.page!)} title="跳转关联业务"
                          className="flex h-7 w-7 items-center justify-center rounded-lg text-slate-400 hover:bg-blue-50 hover:text-[#3370ff]">
                          <Link2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                      <button onClick={() => advanceTeamTask(t.id)}
                        className={cn('flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-[11px] font-medium transition-colors',
                          t.status === '已完成' ? 'border-slate-200 text-slate-400 hover:text-slate-600' : 'border-[#3370ff]/40 text-[#3370ff] hover:bg-blue-50')}>
                        {t.status === '待处理' ? <Play className="h-3 w-3" /> : t.status === '进行中' ? <CheckCheck className="h-3 w-3" /> : <Undo2 className="h-3 w-3" />}
                        {sm.next}
                      </button>
                      <button onClick={() => deleteTeamTask(t.id)} title="删除任务"
                        className="flex h-7 w-7 items-center justify-center rounded-lg text-slate-300 hover:bg-rose-50 hover:text-rose-500">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      ) : (
        <>
          {autoTotal === 0 && (
            <div className="rounded-2xl border border-dashed border-slate-300 bg-white py-16 text-center text-sm text-slate-400">全部处理完了，数字员工持续盯盘中</div>
          )}
          <div className="grid gap-4 lg:grid-cols-2">
            {groups.filter(g => g.items.length > 0).map(g => (
              <div key={g.key} className="rounded-2xl border border-slate-200/60 bg-white shadow-sm p-4 md:p-5">
                <div className="flex items-center gap-2.5">
                  <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-50"><g.icon className="h-4 w-4 text-slate-500" /></span>
                  <div className="min-w-0 flex-1">
                    <p className="text-[14px] font-semibold text-slate-800">{g.label}
                      <span className="tnum ml-2 rounded-full bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-500">{g.items.length}</span>
                    </p>
                    <p className="mt-0.5 text-[11px] text-slate-400">{g.desc}</p>
                  </div>
                </div>
                <div className="mt-3 space-y-2">
                  {g.items.map(it => (
                    <button
                      key={it.id}
                      onClick={() => navigate(it.page)}
                      className="group flex w-full items-start gap-2.5 rounded-xl border border-slate-100 bg-slate-50/60 p-3 text-left transition-colors hover:border-[#3370ff]/40 hover:bg-blue-50/40"
                    >
                      <span className={cn('mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full', {
                        'bg-orange-500': it.tone === 'orange', 'bg-[#3370ff]': it.tone === 'blue', 'bg-amber-500': it.tone === 'amber',
                        'bg-violet-500': it.tone === 'violet', 'bg-rose-500': it.tone === 'rose', 'bg-emerald-500': it.tone === 'emerald',
                        'bg-indigo-500': it.tone === 'indigo', 'bg-cyan-500': it.tone === 'cyan',
                      })} />
                      <span className="min-w-0 flex-1">
                        <span className="block text-[13px] leading-snug text-slate-700">{it.title}</span>
                        <span className="mt-1 block text-[11px] text-slate-400">{it.meta}</span>
                      </span>
                      <ChevronRight className="mt-1 h-3.5 w-3.5 shrink-0 text-slate-300 transition-transform group-hover:translate-x-0.5 group-hover:text-[#3370ff]" />
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
