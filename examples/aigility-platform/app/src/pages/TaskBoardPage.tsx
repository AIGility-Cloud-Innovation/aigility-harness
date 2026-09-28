import { useCallback, useEffect, useMemo, useState } from 'react'
import { ListChecks, RefreshCw, ChevronDown, ChevronUp, Check, X, Play, Loader2, CircleAlert, FileCode2, FileText, Workflow, User } from 'lucide-react'
import { fetchTasks, transitionTask, type TaskItem, type TaskResult } from '../lib/harness'

const EXECUTOR_META: Record<string, { label: string; icon: any; cls: string }> = {
  code: { label: '编码代理', icon: FileCode2, cls: 'bg-violet-50 text-violet-600' },
  workflow: { label: 'PDCA 拆解', icon: Workflow, cls: 'bg-blue-50 text-blue-600' },
  content: { label: '文本执行', icon: FileText, cls: 'bg-sky-50 text-sky-600' },
  docx: { label: '文档执行', icon: FileText, cls: 'bg-cyan-50 text-cyan-600' },
  human: { label: '人工处理', icon: User, cls: 'bg-slate-100 text-slate-600' },
}

const STATUS_META: Record<string, { label: string; cls: string }> = {
  open: { label: '待执行', cls: 'bg-slate-100 text-slate-600' },
  running: { label: '执行中', cls: 'bg-amber-50 text-amber-600' },
  review: { label: '待人审', cls: 'bg-blue-50 text-blue-600' },
  done: { label: '已完成', cls: 'bg-emerald-50 text-emerald-600' },
  failed: { label: '失败', cls: 'bg-rose-50 text-rose-600' },
}

const FILTERS: Array<{ key: string; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'review', label: '待人审' },
  { key: 'running', label: '执行中' },
  { key: 'open', label: '待执行' },
  { key: 'done', label: '已完成' },
  { key: 'failed', label: '失败' },
]

/** 人审/流转的合法迁移（与服务端 transition 白名单一致） */
const NEXT_ACTIONS: Record<string, Array<{ to: string; label: string; icon: any; cls: string }>> = {
  review: [
    { to: 'done', label: '通过', icon: Check, cls: 'bg-emerald-600 hover:bg-emerald-500 text-white' },
    { to: 'rejected', label: '驳回', icon: X, cls: 'bg-white border border-slate-200 text-slate-600 hover:border-rose-300 hover:text-rose-600' },
  ],
  open: [
    { to: 'done', label: '标记完成', icon: Check, cls: 'bg-white border border-slate-200 text-slate-600 hover:border-emerald-300 hover:text-emerald-600' },
  ],
}

export default function TaskBoardPage() {
  const [tasks, setTasks] = useState<TaskItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('all')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [busyId, setBusyId] = useState('')

  const load = useCallback(() => {
    setLoading(true)
    fetchTasks({ status: undefined, mine: undefined })
      .then(setTasks)
      .catch(e => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { load() }, [load])

  // running 的任务每 15s 自动刷新, 让"执行中"的用户看到状态推进
  useEffect(() => {
    if (!tasks.some(t => t.status === 'running')) return
    const timer = setInterval(load, 15_000)
    return () => clearInterval(timer)
  }, [tasks, load])

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: tasks.length }
    for (const t of tasks) c[t.status] = (c[t.status] ?? 0) + 1
    return c
  }, [tasks])

  const list = filter === 'all' ? tasks : tasks.filter(t => t.status === filter)

  const transition = async (t: TaskItem, to: string) => {
    setBusyId(t.id)
    setError('')
    try {
      const updated = await transitionTask(t.id, to)
      setTasks(ts => ts.map(x => (x.id === t.id ? { ...x, ...updated } : x)))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyId('')
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-800 flex items-center gap-2"><ListChecks size={20} className="text-blue-600" />任务板</h1>
          <p className="text-sm text-slate-500 mt-1">对话式改站的任务流水线：「平台改进专员」落任务 → 执行器自动执行 → 人在回路审批 → 发布生效</p>
        </div>
        <button onClick={load} disabled={loading}
          className="text-xs px-3 py-1.5 rounded-lg bg-white border border-slate-200 text-slate-600 hover:border-blue-300 flex items-center gap-1.5 disabled:opacity-50">
          {loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}刷新
        </button>
      </div>

      <div className="flex gap-2 flex-wrap">
        {FILTERS.map(f => (
          <button key={f.key} onClick={() => setFilter(f.key)}
            className={`text-xs px-3.5 py-1.5 rounded-full transition ${filter === f.key ? 'bg-blue-600 text-white' : 'bg-white border border-slate-200 text-slate-600 hover:border-blue-300'}`}>
            {f.label}{f.key !== 'all' && counts[f.key] ? ` · ${counts[f.key]}` : ''}
          </button>
        ))}
      </div>

      {error && <div className="text-xs text-rose-600 bg-rose-50 border border-rose-100 rounded-lg px-3 py-2">{error}</div>}

      {loading && tasks.length === 0 ? (
        <div className="text-sm text-slate-400 py-16 text-center flex items-center justify-center gap-2"><Loader2 size={16} className="animate-spin" />加载中…</div>
      ) : list.length === 0 ? (
        <div className="text-sm text-slate-400 py-16 text-center">该状态下暂无任务 —— 到「数字员工」对话「平台改进专员」即可提交网站修改意见</div>
      ) : (
        <div className="space-y-3">
          {list.map(t => {
            const ex = EXECUTOR_META[t.executor] ?? EXECUTOR_META.human
            const st = STATUS_META[t.status] ?? STATUS_META.open
            const res = (t.result ?? {}) as TaskResult
            // 服务端错误产出是 {kind:'error', text:'...'}, 普通产出在 text, docx 才有 filename
            const resultText = res.text ?? res.error ?? ''
            const isOpen = expanded[t.id] ?? t.status === 'review'
            const ExIcon = ex.icon
            const actions = NEXT_ACTIONS[t.status] ?? []
            return (
              <div key={t.id} className="bg-white rounded-xl border border-slate-200/80 p-4">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-semibold text-slate-800">{t.title}</span>
                      <span className={`text-[11px] px-2 py-0.5 rounded-full ${st.cls}`}>{st.label}</span>
                      <span className={`text-[11px] px-2 py-0.5 rounded-full ${ex.cls} flex items-center gap-1`}><ExIcon size={11} />{ex.label}</span>
                      {t.priority && t.priority !== '中' && <span className="text-[11px] px-2 py-0.5 rounded-full bg-orange-50 text-orange-600">{t.priority}优先</span>}
                    </div>
                    <div className="text-[11px] text-slate-400 mt-1">
                      {t.id.slice(0, 8)} · {t.createdBy} · 更新于 {String(t.updatedAt ?? '').replace('T', ' ').slice(0, 16)}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {actions.map(a => (
                      <button key={a.to} disabled={busyId === t.id} onClick={() => transition(t, a.to)}
                        className={`text-xs px-3 py-1.5 rounded-lg transition disabled:opacity-50 flex items-center gap-1 ${a.cls}`}>
                        {busyId === t.id ? <Loader2 size={12} className="animate-spin" /> : <a.icon size={12} />}{a.label}
                      </button>
                    ))}
                  </div>
                </div>

                {t.detail && (
                  <p className="text-xs text-slate-500 mt-2 leading-relaxed line-clamp-2">{t.detail}</p>
                )}

                {resultText && (
                  <div className="mt-3">
                    <button onClick={() => setExpanded(m => ({ ...m, [t.id]: !isOpen }))}
                      className="text-[11px] text-blue-600 hover:text-blue-500 flex items-center gap-1">
                      {isOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                      {res.kind === 'error' ? '执行错误详情' : '执行产出 / 编码代理汇报'}
                    </button>
                    {isOpen && (
                      <pre className="mt-2 text-[11px] leading-relaxed text-slate-600 bg-slate-50 border border-slate-100 rounded-lg p-3 whitespace-pre-wrap max-h-72 overflow-y-auto">{resultText}</pre>
                    )}
                  </div>
                )}

                {t.status === 'running' && (
                  <div className="mt-3 text-[11px] text-amber-600 bg-amber-50 rounded-lg px-3 py-2 flex items-center gap-1.5">
                    <Play size={11} />执行器处理中，页面会自动刷新状态（编码改动的审查以 git diff 为准，通过后需构建/重启发布）
                  </div>
                )}
                {t.status === 'review' && t.executor === 'code' && (
                  <div className="mt-3 text-[11px] text-blue-600 bg-blue-50 rounded-lg px-3 py-2 flex items-start gap-1.5">
                    <CircleAlert size={11} className="mt-0.5 shrink-0" />编码代理已完成改动并自检：通过 = 接受改动（再构建/重启发布）；驳回 = 改动留在工作区，请自行 git 恢复
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
