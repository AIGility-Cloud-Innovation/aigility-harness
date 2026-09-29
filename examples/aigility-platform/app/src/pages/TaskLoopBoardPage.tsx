/**
 * TaskLoopBoardPage — 项目小助理 · 任务看板（使用界面）
 *
 * 回答「项目小助理管得怎么样」：流水线把群聊里确认归属的飞书任务落单为
 * Gitea 工单（git.aigility.cloud），看板按工单状态分列跟踪：
 *   待派发（open · 无执行人）→ 执行中（open · 有执行人）→ 已完成（closed · 已回写飞书）
 * 启停 / 凭证 / featureFlags / 日志等运维操作在独立的配置页（task-loop-config）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Bot, RefreshCw, Loader2, ExternalLink, Pause, Play, Settings2, ListTodo, CircleDot, CheckCircle2, GitBranch,
} from 'lucide-react'
import {
  fetchTaskLoopBoard, fetchTaskLoopStatus,
  type TaskLoopBoardIssue, type TaskLoopStatus,
} from '../lib/harness'

interface ColumnDef {
  key: string
  label: string
  hint: string
  icon: any
  dot: string
  chip: string
  match: (i: TaskLoopBoardIssue) => boolean
}

const COLUMNS: ColumnDef[] = [
  {
    key: 'pending', label: '待派发', hint: '已建单 · 待认领执行人', icon: ListTodo,
    dot: 'bg-amber-500', chip: 'bg-amber-50 text-amber-700 border-amber-200',
    match: (i) => i.state === 'open' && i.assignees.length === 0,
  },
  {
    key: 'doing', label: '执行中', hint: 'open · 已有执行人', icon: CircleDot,
    dot: 'bg-blue-500', chip: 'bg-blue-50 text-blue-700 border-blue-200',
    match: (i) => i.state === 'open' && i.assignees.length > 0,
  },
  {
    key: 'done', label: '已完成', hint: 'closed · 状态已回写飞书', icon: CheckCircle2,
    dot: 'bg-emerald-500', chip: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    match: (i) => i.state === 'closed',
  },
]

const fmtDate = (s: string) => String(s ?? '').replace('T', ' ').slice(5, 16)

export default function TaskLoopBoardPage({ go }: { go?: (p: string) => void }) {
  const [issues, setIssues] = useState<TaskLoopBoardIssue[]>([])
  const [repos, setRepos] = useState<string[]>([])
  const [errors, setErrors] = useState<string[]>([])
  const [bot, setBot] = useState<TaskLoopStatus | null>(null)
  const [repoFilter, setRepoFilter] = useState('all')
  const [loading, setLoading] = useState(true)
  const [autoRefresh, setAutoRefresh] = useState(true)

  const load = useCallback(() => {
    setLoading(true)
    fetchTaskLoopBoard()
      .then((b) => { setIssues(b.issues ?? []); setRepos(b.repos ?? []); setErrors(b.errors ?? []) })
      .catch((e) => setErrors([e instanceof Error ? e.message : String(e)]))
      .finally(() => setLoading(false))
    fetchTaskLoopStatus(5).then(setBot).catch(() => {})
  }, [])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    if (!autoRefresh) return
    const t = setInterval(load, 30_000)
    return () => clearInterval(t)
  }, [autoRefresh, load])

  const filtered = useMemo(
    () => (repoFilter === 'all' ? issues : issues.filter((i) => i.repo === repoFilter)),
    [issues, repoFilter],
  )
  const counts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const col of COLUMNS) c[col.key] = filtered.filter(col.match).length
    return c
  }, [filtered])
  const running = bot?.state === 'running'

  return (
    <div className="space-y-5">
      {/* 页头 */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-800 flex items-center gap-2"><Bot size={22} className="text-indigo-500" />项目小助理 · 任务看板</h1>
          <p className="text-sm text-slate-500 mt-1">飞书群里收集的任务，确认归属后自动落单为 Gitea 工单 —— 看板跟踪每一单从建单到完成回写</p>
        </div>
        <div className="flex items-center gap-2">
          <span className={`inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-full border ${running ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-slate-100 text-slate-500 border-slate-200'}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${running ? 'bg-emerald-500 animate-pulse' : 'bg-slate-400'}`} />
            机器人{running ? `运行中${bot?.pid ? ` · pid ${bot.pid}` : ''}` : '未运行'}
          </span>
          <button onClick={() => go?.('task-loop-config')}
            className="text-xs px-3 py-1.5 rounded-lg border border-slate-300 text-slate-600 hover:border-indigo-300 hover:text-indigo-600 flex items-center gap-1.5">
            <Settings2 size={13} />配置与运维
          </button>
          <button onClick={() => setAutoRefresh((v) => !v)}
            className={`text-xs px-2.5 py-1.5 rounded-lg border flex items-center gap-1 ${autoRefresh ? 'border-emerald-300 text-emerald-600 bg-emerald-50' : 'border-slate-300 text-slate-500'}`}>
            {autoRefresh ? <><Pause size={12} />30s 自动刷新</> : <><Play size={12} />已暂停</>}
          </button>
          <button onClick={load} disabled={loading}
            className="text-xs px-2.5 py-1.5 rounded-lg border border-slate-300 text-slate-600 hover:bg-slate-50 flex items-center gap-1 disabled:opacity-50">
            {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}刷新
          </button>
        </div>
      </div>

      {/* 流水线说明条 */}
      <div className="rounded-xl bg-gradient-to-br from-slate-800 to-slate-900 p-4 text-white">
        <div className="flex items-center gap-2 mb-1.5"><GitBranch size={14} className="text-indigo-300" /><span className="text-xs font-medium">任务闭环链路</span></div>
        <p className="text-[11px] text-slate-300 leading-relaxed">
          飞书群消息静默汇总 → 识别任务并建飞书任务（规划中）→ 「任务归属 / 安排执行者」确认 → 落单 Gitea 工单（本看板）→ 完成后状态回写飞书
        </p>
      </div>

      {/* 错误横幅（单仓库失败等，不阻塞看板） */}
      {errors.length > 0 && (
        <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 leading-relaxed">
          部分仓库拉取失败（不影响其余数据，常为令牌/网络问题）：{errors.join('；')}
        </div>
      )}

      {/* 仓库筛选 */}
      <div className="flex gap-2 flex-wrap">
        <button onClick={() => setRepoFilter('all')}
          className={`text-xs px-3.5 py-1.5 rounded-full transition ${repoFilter === 'all' ? 'bg-indigo-600 text-white' : 'bg-white border border-slate-200 text-slate-600 hover:border-indigo-300'}`}>
          全部仓库{repoFilter === 'all' ? ` · ${filtered.length}` : ''}
        </button>
        {repos.map((r) => (
          <button key={r} onClick={() => setRepoFilter(r)}
            className={`text-xs px-3.5 py-1.5 rounded-full font-mono transition ${repoFilter === r ? 'bg-indigo-600 text-white' : 'bg-white border border-slate-200 text-slate-600 hover:border-indigo-300'}`}>
            {r.replace(/^TiMEM-AI\//, '')}
          </button>
        ))}
      </div>

      {/* 看板 */}
      {loading && issues.length === 0 ? (
        <div className="text-sm text-slate-400 py-16 text-center flex items-center justify-center gap-2"><Loader2 size={16} className="animate-spin" />加载工单中…</div>
      ) : filtered.length === 0 ? (
        <div className="bg-white rounded-xl border border-slate-200/80 p-16 text-center max-w-xl mx-auto">
          <div className="w-14 h-14 rounded-2xl bg-slate-100 flex items-center justify-center mx-auto mb-4"><Bot size={24} className="text-slate-400" /></div>
          <h3 className="font-semibold text-slate-800">看板上还没有工单</h3>
          <p className="text-sm text-slate-400 mt-2 leading-relaxed">
            在飞书群里让「项目小助理」收集任务并确认归属后，工单会自动出现在这里。<br />
            {!running && '当前机器人未运行，请先到「配置与运维」启动。'}
          </p>
        </div>
      ) : (
        <div className="grid md:grid-cols-3 gap-4 items-start">
          {COLUMNS.map((col) => {
            const list = filtered.filter(col.match)
            return (
              <div key={col.key} className="bg-slate-100/70 rounded-xl p-3 space-y-2.5">
                <div className="flex items-center justify-between px-1">
                  <div className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full ${col.dot}`} />
                    <span className="text-sm font-semibold text-slate-700 flex items-center gap-1.5"><col.icon size={14} className="text-slate-400" />{col.label}</span>
                    <span className={`text-[11px] px-1.5 py-0.5 rounded-full border ${col.chip}`}>{counts[col.key] ?? 0}</span>
                  </div>
                </div>
                <p className="text-[10px] text-slate-400 px-1 -mt-1">{col.hint}</p>
                {list.length === 0 && <div className="text-xs text-slate-400 text-center py-8">暂无工单</div>}
                {list.map((i) => (
                  <a key={`${i.repo}#${i.number}`} href={i.htmlUrl} target="_blank" rel="noreferrer"
                    className="block bg-white rounded-lg border border-slate-200/80 p-3 hover:border-indigo-300 hover:shadow-sm transition group">
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-sm font-medium text-slate-800 leading-snug">{i.title}</span>
                      <ExternalLink size={12} className="text-slate-300 group-hover:text-indigo-400 shrink-0 mt-0.5" />
                    </div>
                    {i.labels.length > 0 && (
                      <div className="flex gap-1 flex-wrap mt-1.5">
                        {i.labels.slice(0, 4).map((l) => (
                          <span key={l} className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">{l}</span>
                        ))}
                      </div>
                    )}
                    <div className="flex items-center justify-between gap-2 mt-2 text-[10px] text-slate-400">
                      <span className="font-mono truncate">{i.repo.replace(/^TiMEM-AI\//, '')} #{i.number}</span>
                      <span className="shrink-0">
                        {i.assignees.length > 0 ? `👤 ${i.assignees.join(', ')}` : '待认领'} · {fmtDate(i.updatedAt)}
                      </span>
                    </div>
                  </a>
                ))}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
