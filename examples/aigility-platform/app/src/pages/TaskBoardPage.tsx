import { useCallback, useEffect, useMemo, useState } from 'react'
import { ListChecks, RefreshCw, Loader2, User, Bot, Link, Filter } from 'lucide-react'
import { fetchRegistryTasks, type RegistryTask } from '../lib/harness'

// ── PDCA 列定义 ─────────────────────────────────────────────────

const COLUMNS: Array<{ key: string; label: string; statuses: string[]; dot: string }> = [
  { key: 'planned',    label: 'P 规划中',  statuses: ['planned'],               dot: 'bg-slate-400' },
  { key: 'ready',      label: '已放行',    statuses: ['ready'],                  dot: 'bg-blue-400' },
  { key: 'dispatched', label: '已派发',    statuses: ['dispatched'],             dot: 'bg-amber-400' },
  { key: 'running',    label: '执行中',    statuses: ['running'],                dot: 'bg-orange-500' },
  { key: 'review',     label: 'C 待测试',  statuses: ['review'],                 dot: 'bg-cyan-400' },
  { key: 'done',       label: '已完成',    statuses: ['done'],                   dot: 'bg-emerald-400' },
  { key: 'failed',     label: 'A 待修复',  statuses: ['failed'],                 dot: 'bg-rose-400' },
  { key: 'cancelled',  label: '已取消',    statuses: ['cancelled', 'blocked'],   dot: 'bg-slate-300' },
]

const FILTERS = COLUMNS.map(c => ({ key: c.key, label: c.label }))

// ── 来源标签 ────────────────────────────────────────────────────

function sourceLabel(provider: string): { label: string; cls: string } {
  switch (provider) {
    case 'feishu-task':    return { label: '飞书',     cls: 'bg-blue-50 text-blue-600' }
    case 'gitea-issue':    return { label: 'Gitea',   cls: 'bg-orange-50 text-orange-600' }
    case 'agentd-task':    return { label: 'agentd',  cls: 'bg-violet-50 text-violet-600' }
    case 'chat-digest':    return { label: '群聊',     cls: 'bg-teal-50 text-teal-600' }
    default:               return { label: provider,  cls: 'bg-slate-50 text-slate-500' }
  }
}

function executorBadge(task: RegistryTask): { label: string; cls: string } | undefined {
  const exec = task.executor
  if (!exec) return undefined
  if (exec === 'agentd' || exec === 'codex') return { label: 'AI 执行', cls: 'bg-violet-50 text-violet-600' }
  return { label: `真人: ${exec}`, cls: 'bg-sky-50 text-sky-600' }
}

export default function TaskBoardPage() {
  const [tasks, setTasks] = useState<RegistryTask[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [projectFilter, setProjectFilter] = useState('all')

  const load = useCallback(() => {
    setLoading(true)
    fetchRegistryTasks()
      .then(setTasks)
      .catch(e => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { load() }, [load])

  // 自动刷新（30s）
  useEffect(() => {
    const timer = setInterval(load, 30_000)
    return () => clearInterval(timer)
  }, [load])

  // 项目列表（去重）
  const projects = useMemo(() => [...new Set(tasks.map(t => t.projectRef).filter(Boolean))], [tasks])

  // 按状态过滤
  const filtered = useMemo(() => {
    if (statusFilter === 'all') return tasks
    const col = COLUMNS.find(c => c.key === statusFilter)
    return col ? tasks.filter(t => col.statuses.includes(t.status)) : tasks
  }, [tasks, statusFilter])

  const projectFiltered = useMemo(() => {
    if (projectFilter === 'all') return filtered
    return filtered.filter(t => t.projectRef === projectFilter)
  }, [filtered, projectFilter])

  // 按列分组
  const columns = useMemo(() => {
    return COLUMNS.map(col => ({
      ...col,
      items: projectFiltered.filter(t => col.statuses.includes(t.status)),
    }))
  }, [projectFiltered])

  return (
    <div className="space-y-4">
      {/* 标题栏 */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-800 flex items-center gap-2">
            <ListChecks size={20} className="text-indigo-600" />
            统一任务看板
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            跨源任务台账 · {tasks.length} 条 · {projects.length} 个项目
          </p>
        </div>
        <button onClick={load} disabled={loading}
          className="text-xs px-3 py-1.5 rounded-lg bg-white border border-slate-200 text-slate-600 hover:border-indigo-300 flex items-center gap-1.5 disabled:opacity-50">
          {loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}刷新
        </button>
      </div>

      {/* 过滤栏 */}
      <div className="flex gap-2 flex-wrap items-center">
        <Filter size={12} className="text-slate-400" />
        <button onClick={() => setStatusFilter('all')}
          className={`text-xs px-3 py-1.5 rounded-full transition ${statusFilter === 'all' ? 'bg-indigo-600 text-white' : 'bg-white border border-slate-200 text-slate-600 hover:border-indigo-300'}`}>
          全部
        </button>
        {COLUMNS.map(col => {
          const count = tasks.filter(t => col.statuses.includes(t.status)).length
          if (!count) return null
          return (
            <button key={col.key} onClick={() => setStatusFilter(col.key)}
              className={`text-xs px-3 py-1.5 rounded-full transition ${statusFilter === col.key ? 'bg-indigo-600 text-white' : 'bg-white border border-slate-200 text-slate-600 hover:border-indigo-300'}`}>
              {col.label} · {count}
            </button>
          )
        })}
        {projects.length > 1 && (
          <select value={projectFilter} onChange={e => setProjectFilter(e.target.value)}
            className="text-xs px-2 py-1.5 rounded-lg border border-slate-200 bg-white text-slate-600 ml-auto">
            <option value="all">全部项目</option>
            {projects.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
        )}
      </div>

      {/* 看板列 */}
      {loading && tasks.length === 0 ? (
        <div className="text-sm text-slate-400 py-16 text-center flex items-center justify-center gap-2">
          <Loader2 size={16} className="animate-spin" />加载中…
        </div>
      ) : tasks.length === 0 ? (
        <div className="text-sm text-slate-400 py-16 text-center">暂无任务——等对齐器收集或群里 @项目小助理。</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
          {columns.map(col => (
            <div key={col.key} className="space-y-2">
              <div className="flex items-center gap-2 px-1">
                <span className={`w-2 h-2 rounded-full ${col.dot}`} />
                <span className="text-xs font-semibold text-slate-600">{col.label}</span>
                <span className="text-[10px] text-slate-400 bg-slate-100 px-1.5 rounded-full">{col.items.length}</span>
              </div>
              <div className="space-y-2">
                {col.items.map(t => {
                  const src = sourceLabel(t.originProvider ?? t.source ?? '')
                  const exec = executorBadge(t)
                  return (
                    <div key={t.uid}
                      className="bg-white rounded-lg border border-slate-200/80 p-3 hover:shadow-sm transition cursor-default">
                      <div className="flex items-start justify-between gap-1.5">
                        <span className="text-xs font-medium text-slate-700 leading-snug">{t.title.slice(0, 60)}</span>
                        <span className={`text-[9px] px-1.5 py-0.5 rounded shrink-0 ${src.cls}`}>{src.label}</span>
                      </div>
                      <div className="mt-1.5 flex items-center gap-1.5 flex-wrap text-[10px] text-slate-400">
                        {t.projectRef && <span>📁 {t.projectRef}</span>}
                        {t.links?.["gitea-issue"] && (
                          <a href={`https://git.aigility.cloud/${t.links["gitea-issue"].guid?.replace("#", "/issues/")}`}
                            target="_blank" rel="noreferrer" className="text-blue-500 hover:underline">
                            🎫 {t.links["gitea-issue"].guid}
                          </a>
                        )}
                        {t.links?.["agentd-task"] && <span>🤖 {t.links["agentd-task"].guid}</span>}
                      </div>
                      <div className="mt-1.5 flex items-center gap-1.5 flex-wrap text-[10px]">
                        {exec && (
                          <span className={`px-1.5 py-0.5 rounded ${exec.cls}`}>
                            {exec.label === 'AI 执行' ? '🤖' : '👤'} {exec.label}
                          </span>
                        )}
                        {t.reviewer && (
                          <span className="px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-600">
                            ✓ {t.reviewer}
                          </span>
                        )}
                      </div>
                      {t.review?.note && (
                        <div className="mt-1 text-[10px] text-slate-400 italic">{t.review.note}</div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {error && (
        <div className="text-xs text-rose-600 bg-rose-50 border border-rose-100 rounded-lg px-3 py-2">{error}</div>
      )}
    </div>
  )
}
