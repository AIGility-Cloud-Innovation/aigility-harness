/**
 * LogMonitorPage — 日志监察员（log-monitor 收编）· 展示与配置
 *
 * 与「团队记忆总结」页（TeamMemoryPage）同构，本页把 examples/apps 的日志监察
 * 守护进程收编为智悦平台可展示、可配置的功能：
 *   - 状态卡：daemon 运行徽标（API 探测）+ 启动 / 停止 / 重启 + 检查次数与运行时长
 *   - 告警卡：飞书 Webhook + 错误关键字（保存即时生效，daemon 落盘持久化）
 *   - 自动化卡：定时拉取日志的自动化列表（host / p / s / 间隔 / 开关），可增删
 *   - 最近错误：daemon 最近捕获的错误行（最多 20 条）
 *   - 运行日志：daemon stdout/stderr Tab，10s 轮询可暂停
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  fetchLogMonitorStatus, updateLogMonitorConfig, operateLogMonitor, fetchLogMonitorLogs,
  type LogMonitorStatus, type LogMonitorAuto, type LogMonitorLogTail,
} from '../lib/harness'
import {
  Play, Save, RefreshCw, Pause, Square, ScanSearch, Plus, Trash2, BellRing, ListChecks, FileWarning,
} from 'lucide-react'

const emptyAuto = (): LogMonitorAuto => ({ host: 'https://', p: '', s: 'app', n: 150, interval: 5, on: true })

function fmtTime(ms?: number): string {
  if (!ms) return '—'
  return new Date(ms).toLocaleString('zh-CN', { hour12: false })
}

function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  return d > 0 ? `${d}天${h}小时` : h > 0 ? `${h}小时${m}分` : `${m}分${s % 60}秒`
}

const card = 'bg-white rounded-xl border border-slate-200 p-4 space-y-3'
const label = 'block text-xs font-medium text-slate-500 mb-1'
const input = 'w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-300'

export default function LogMonitorPage({ navVisible = true, onToggleNav, navEditable = true }: {
  /** 是否固定在左侧导航（独立于「模块装配」的用户偏好，默认不进导航、从应用中心进入） */
  navVisible?: boolean
  /** 切换左侧导航显示 */
  onToggleNav?: () => void
  /** 导航布局编辑权限（现阶段仅管理员可改，普通用户只读） */
  navEditable?: boolean
} = {}) {
  const [status, setStatus] = useState<LogMonitorStatus | null>(null)
  const [banner, setBanner] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)

  // 配置草稿
  const [webhook, setWebhook] = useState('')
  const [keywords, setKeywords] = useState('ERROR,Traceback,Exception')
  const [autos, setAutos] = useState<LogMonitorAuto[]>([])

  // 日志
  const [tab, setTab] = useState<'stdout' | 'stderr'>('stdout')
  const [logs, setLogs] = useState<{ stdout: LogMonitorLogTail; stderr: LogMonitorLogTail } | null>(null)
  const [autoRefresh, setAutoRefresh] = useState(true)
  const logBoxRef = useRef<HTMLPreElement>(null)

  const running = status?.state === 'running'

  const reload = useCallback(async () => {
    const s = await fetchLogMonitorStatus(20)
    setStatus(s)
    if (s.config) {
      setWebhook(s.config.webhook ?? '')
      setKeywords(s.config.keywords || 'ERROR,Traceback,Exception')
      setAutos((s.config.autos ?? []).map((a) => ({ ...a })))
    }
  }, [])

  const loadLogs = useCallback(async () => {
    fetchLogMonitorLogs(200).then((l) => {
      setLogs(l)
      const box = logBoxRef.current
      if (box) box.scrollTop = box.scrollHeight
    }).catch(() => {})
  }, [])

  useEffect(() => { reload().catch((e) => setError(String(e))) }, [reload])
  useEffect(() => {
    loadLogs()
    if (!autoRefresh) return
    const t = setInterval(loadLogs, 10000)
    return () => clearInterval(t)
  }, [loadLogs, autoRefresh])

  const saveConfig = async () => {
    setBusy('save'); setError(''); setBanner('')
    try {
      const clean = autos
        .map((a) => ({ ...a, host: a.host.trim(), p: a.p.trim(), s: (a.s || 'app').trim() }))
        .filter((a) => a.host && a.p)
      if (clean.length !== autos.length) setAutos(clean)
      await updateLogMonitorConfig({
        webhook: webhook.trim(),
        keywords: keywords.trim() || 'ERROR',
        autos: clean.map((a) => ({ host: a.host, p: a.p, s: a.s || 'app', n: a.n || 150, interval: a.interval || 5, on: a.on !== false })),
      })
      setBanner('配置已下发，daemon 即时生效（开启中的自动化会立即检查一次）')
      await reload()
    } catch (e) {
      setError(`保存失败：${String(e)}（daemon 未运行时无法下发配置，请先启动）`)
    } finally {
      setBusy(null)
    }
  }

  const op = async (action: 'start' | 'stop' | 'restart') => {
    setBusy(action); setError(''); setBanner('')
    try {
      const r = await operateLogMonitor(action)
      if (r.ok) setBanner(r.message)
      else setError(r.message || `${action} 失败`)
      await reload()
      loadLogs()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(null)
    }
  }

  const patchAuto = (i: number, patch: Partial<LogMonitorAuto>) =>
    setAutos((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-4">
      <h1 className="text-xl font-semibold text-slate-800 flex items-center gap-2"><ScanSearch size={22} className="text-amber-500" />日志监察员</h1>

      {banner && <div className="text-sm bg-emerald-50 text-emerald-700 border border-emerald-200 rounded-lg px-3 py-2">{banner}</div>}
      {error && <div className="text-sm bg-rose-50 text-rose-700 border border-rose-200 rounded-lg px-3 py-2 whitespace-pre-wrap">{error}</div>}

      {/* 左侧导航显示开关（独立于「模块装配」的用户偏好；默认不进导航，从应用中心进入） */}
      <div className="bg-white rounded-xl border border-slate-200/80 px-5 py-3.5 flex items-center justify-between flex-wrap gap-2">
        <div>
          <div className="text-sm text-slate-700">在左侧导航栏显示「日志监察员」</div>
          <p className="text-[11px] text-slate-400 mt-0.5">只控制导航可见性，不影响 daemon 运行；关闭后仍可从应用中心进入本页</p>
        </div>
        <button onClick={() => onToggleNav?.()} disabled={!navEditable}
          title={navEditable ? '切换左侧导航显示' : '导航布局由管理员统一配置'}
          className={`w-11 h-[24px] rounded-full transition relative shrink-0 ${navVisible ? 'bg-blue-600' : 'bg-slate-200'} ${!navEditable ? 'opacity-50 cursor-not-allowed' : ''}`}>
          <span className={`absolute top-[4px] w-4 h-4 rounded-full bg-white shadow transition-all ${navVisible ? 'left-[23px]' : 'left-[4px]'}`} />
        </button>
      </div>

      {/* 状态卡 */}
      <div className={card}>
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-3">
            <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border ${running ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-slate-100 text-slate-500 border-slate-200'}`}>
              <span className={`w-2 h-2 rounded-full ${running ? 'bg-emerald-500 animate-pulse' : 'bg-slate-400'}`} />
              {running ? '监察中' : '已停止'}
            </span>
            {running && status?.daemon && (
              <span className="text-xs text-slate-500">
                pid {status.daemon.pid} · API :{status.port} · 已巡检 {status.daemon.checkCount} 次 · 运行 {fmtDuration(Date.now() - status.daemon.startedAt)} · 开启自动化 {status.daemon.autos.filter((a) => a.on).length}/{status.daemon.autos.length} 条
              </span>
            )}
            {status?.managedByPlatform && <span className="text-xs text-slate-400">由平台托管</span>}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => op('start')} disabled={busy !== null || running} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40"><Play size={14} />启动</button>
            <button onClick={() => op('restart')} disabled={busy !== null} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 disabled:opacity-40"><RefreshCw size={14} />重启</button>
            <button onClick={() => op('stop')} disabled={busy !== null || !running} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-rose-600 text-white hover:bg-rose-700 disabled:opacity-40"><Square size={14} />停止</button>
          </div>
        </div>
      </div>

      {/* 告警配置卡 */}
      <div className={card}>
        <h2 className="text-sm font-semibold text-slate-700 flex items-center gap-1.5"><BellRing size={15} className="text-amber-500" />告警通知与匹配</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className={label}>飞书 Webhook（自定义机器人）</label>
            <input className={input} value={webhook} onChange={(e) => setWebhook(e.target.value)} placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/xxx" />
          </div>
          <div>
            <label className={label}>错误关键字（英文逗号分隔，不区分大小写）</label>
            <input className={input} value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder="ERROR,Traceback,Exception" />
          </div>
        </div>
      </div>

      {/* 自动化列表卡 */}
      <div className={card}>
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-700 flex items-center gap-1.5"><ListChecks size={15} className="text-sky-500" />巡检自动化</h2>
          <button onClick={() => setAutos((rows) => [...rows, emptyAuto()])} className="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded-lg border border-slate-300 text-slate-600 hover:bg-slate-50"><Plus size={13} />新增</button>
        </div>
        {autos.length === 0 && <p className="text-xs text-slate-400">暂无巡检项。新增一条：填日志来源 host（如 http://127.0.0.1:1236）、路径参数 p / s 与轮询间隔，保存后按间隔定时拉取并匹配关键字。</p>}
        <div className="space-y-2">
          {autos.map((a, i) => (
            <div key={i} className="flex items-end gap-2 flex-wrap border border-slate-100 rounded-lg p-2">
              <div className="flex-1 min-w-44">
                <label className={label}>Host</label>
                <input className={input} value={a.host} onChange={(e) => patchAuto(i, { host: e.target.value })} placeholder="https://host" />
              </div>
              <div className="w-24">
                <label className={label}>p</label>
                <input className={input} value={a.p} onChange={(e) => patchAuto(i, { p: e.target.value })} placeholder="路径参数" />
              </div>
              <div className="w-24">
                <label className={label}>s</label>
                <input className={input} value={a.s ?? ''} onChange={(e) => patchAuto(i, { s: e.target.value })} placeholder="app" />
              </div>
              <div className="w-24">
                <label className={label}>间隔(分)</label>
                <input type="number" min={1} className={input} value={a.interval ?? 5} onChange={(e) => patchAuto(i, { interval: Number(e.target.value) })} />
              </div>
              <label className="flex items-center gap-1.5 text-sm text-slate-600 pb-2">
                <input type="checkbox" checked={a.on !== false} onChange={(e) => patchAuto(i, { on: e.target.checked })} className="accent-sky-500" />启用
              </label>
              {running && (
                <span className={`text-xs pb-2.5 ${a.lastErr ? 'text-rose-500' : 'text-slate-400'}`} title={a.lastErr ?? ''}>
                  {a.lastErr ? `⚠ ${a.lastErr}` : a.lastAt ? `上次 ${fmtTime(a.lastAt)}` : '未巡检'}
                </span>
              )}
              <button onClick={() => setAutos((rows) => rows.filter((_, idx) => idx !== i))} className="p-2 text-slate-400 hover:text-rose-500" title="删除"><Trash2 size={15} /></button>
            </div>
          ))}
        </div>
        <button onClick={saveConfig} disabled={busy !== null || !running} className="inline-flex items-center gap-1.5 px-4 py-2 text-sm rounded-lg bg-sky-600 text-white hover:bg-sky-700 disabled:opacity-40"><Save size={15} />{busy === 'save' ? '下发中…' : '保存并下发配置'}</button>
        {!running && <p className="text-xs text-slate-400">daemon 未运行——配置无法下发（配置由 daemon 进程读取落盘）。请先在上方启动。</p>}
      </div>

      {/* 最近错误卡 */}
      <div className={card}>
        <h2 className="text-sm font-semibold text-slate-700 flex items-center gap-1.5"><FileWarning size={15} className="text-rose-500" />最近捕获的错误</h2>
        {(status?.daemon?.errs?.length ?? 0) === 0
          ? <p className="text-xs text-slate-400">暂无错误记录（或 daemon 未运行）。</p>
          : (
            <div className="space-y-1.5 max-h-64 overflow-y-auto">
              {status!.daemon!.errs.map((e, i) => (
                <div key={i} className="text-xs border border-rose-100 bg-rose-50/50 rounded-lg px-2.5 py-1.5">
                  <span className="text-slate-400 mr-2">{e.t}</span>
                  <span className="text-slate-500 mr-2">[{e.src}]</span>
                  <span className="font-mono text-rose-700 break-all">{e.line}</span>
                </div>
              ))}
            </div>
          )}
      </div>

      {/* 运行日志卡 */}
      <div className={card}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm">
            {(['stdout', 'stderr'] as const).map((t) => (
              <button key={t} onClick={() => setTab(t)} className={`px-3 py-1 rounded-lg ${tab === t ? 'bg-slate-800 text-white' : 'text-slate-500 hover:bg-slate-100'}`}>{t === 'stdout' ? '标准输出' : '错误输出'}</button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setAutoRefresh((v) => !v)} className="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded-lg border border-slate-300 text-slate-600 hover:bg-slate-50">
              {autoRefresh ? <Pause size={13} /> : <Play size={13} />}{autoRefresh ? '暂停轮询' : '恢复轮询'}
            </button>
            <button onClick={loadLogs} className="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded-lg border border-slate-300 text-slate-600 hover:bg-slate-50"><RefreshCw size={13} />刷新</button>
          </div>
        </div>
        <pre ref={logBoxRef} className="bg-slate-900 text-slate-100 text-xs rounded-lg p-3 h-64 overflow-auto whitespace-pre-wrap font-mono">
{logs ? (logs[tab].lines.join('\n') || '（暂无日志）') : '加载中…'}
        </pre>
        {logs && <p className="text-xs text-slate-400 truncate" title={logs[tab].file}>{logs[tab].file}</p>}
      </div>
    </div>
  )
}
