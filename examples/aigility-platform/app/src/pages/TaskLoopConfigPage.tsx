/**
 * TaskLoopConfigPage — 项目小助理（feishu-task-loop）· 配置与运维（配置界面）
 *
 * 与使用界面（任务看板 TaskLoopBoardPage）分离，本页只管运维：
 *   - 状态卡：running/stopped/stale 徽标 + pid + 锁路径，启动/停止/重启（带确认）
 *   - 飞书接入卡：App ID / Secret / 播报群（页面配置优先于仓库 .env）
 *   - 配置卡：LLM 兜底模型、流水线轮询间隔、自动派发/通知开关（保存后需重启生效）
 *   - 功能开关：featureFlags 动态 key-value 开关（可新增/删除行）
 *   - 日志卡：stdout/stderr Tab 切换，10s 轮询（可暂停）
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  fetchTaskLoopStatus, startTaskLoop, stopTaskLoop, restartTaskLoop,
  fetchTaskLoopConfig, updateTaskLoopConfig, fetchTaskLoopLogs, fetchFeishuChats,
  type TaskLoopStatus, type TaskLoopConfig, type TaskLoopState,
  type TaskLoopLogTail, type FeishuChatItem,
} from '../lib/harness'
import {
  Play, Square, RotateCw, Save, Plus, Trash2, Pause, RefreshCw, KeyRound, MessageSquareShare, ArrowLeft, Settings2,
} from 'lucide-react'

const COMMON_MODELS = ['sensenova-deepseek-v4-flash', 'qwen-plus', 'qwen-turbo', 'sensenova-glm-5.2']

const stateMeta: Record<TaskLoopState, { label: string; cls: string; dot: string }> = {
  running: { label: '运行中', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200', dot: 'bg-emerald-500' },
  stopped: { label: '已停止', cls: 'bg-slate-100 text-slate-600 border-slate-200', dot: 'bg-slate-400' },
  stale: { label: '僵锁（stale）', cls: 'bg-amber-50 text-amber-700 border-amber-200', dot: 'bg-amber-500' },
}

interface FlagRow { key: string; value: boolean }
interface EnvRow { key: string; value: string }

export default function TaskLoopConfigPage({ go, navVisible = true, onToggleNav }: {
  go?: (p: string) => void
  /** 是否显示在左侧导航（与 App.tsx enabledModules /「模块装配」页同一状态） */
  navVisible?: boolean
  /** 切换左侧导航显示 */
  onToggleNav?: () => void
}) {
  const [status, setStatus] = useState<TaskLoopStatus | null>(null)
  const [banner, setBanner] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [confirmOp, setConfirmOp] = useState<'start' | 'stop' | 'restart' | null>(null)

  // 配置草稿
  const [cfg, setCfg] = useState<TaskLoopConfig>({ featureFlags: {}, env: {} })
  const [model, setModel] = useState('')
  const [interval, setIntervalMs] = useState('')
  const [flags, setFlags] = useState<FlagRow[]>([])
  const [envRows, setEnvRows] = useState<EnvRow[]>([])
  const [newFlagKey, setNewFlagKey] = useState('')

  // 飞书接入（页面可视化配置：App ID / Secret / 播报群）
  const [appId, setAppId] = useState('')
  const [secret, setSecret] = useState('')
  const [chats, setChats] = useState<FeishuChatItem[]>([])
  const [chatErr, setChatErr] = useState('')
  const [loadingChats, setLoadingChats] = useState(false)

  // 日志
  const [tab, setTab] = useState<'stdout' | 'stderr'>('stdout')
  const [logs, setLogs] = useState<{ stdout: TaskLoopLogTail; stderr: TaskLoopLogTail } | null>(null)
  const [autoRefresh, setAutoRefresh] = useState(true)
  const logBoxRef = useRef<HTMLPreElement>(null)

  const reload = useCallback(async () => {
    const s = await fetchTaskLoopStatus(30)
    setStatus(s)
    const c = await fetchTaskLoopConfig()
    setCfg(c)
    setModel(c.llmModel ?? '')
    setIntervalMs(c.pipelineIntervalMs !== undefined ? String(c.pipelineIntervalMs) : '')
    setFlags(Object.entries(c.featureFlags ?? {}).map(([key, value]) => ({ key, value })))
    setEnvRows(Object.entries(c.env ?? {}).map(([key, value]) => ({ key, value })))
    setAppId(c.feishuAppId ?? '')
    setSecret('') // Secret 不回显原文；留空 = 不修改
  }, [])

  const loadLogs = useCallback(async () => {
    fetchTaskLoopLogs(200).then((l) => {
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

  const runOp = async (op: 'start' | 'stop' | 'restart') => {
    setBusy(op); setError(''); setBanner(''); setConfirmOp(null)
    try {
      const r = op === 'start' ? await startTaskLoop() : op === 'stop' ? await stopTaskLoop() : await restartTaskLoop()
      if (r.ok) setBanner(r.message)
      else setError(r.message)
      await reload()
    } catch (e) { setError(String((e as Error).message ?? e)) } finally { setBusy(null) }
  }

  const saveConfig = async () => {
    setBusy('save'); setError(''); setBanner('')
    try {
      const featureFlags: Record<string, boolean> = {}
      flags.forEach((f) => { if (f.key.trim()) featureFlags[f.key.trim()] = f.value })
      const env: Record<string, string> = {}
      envRows.forEach((r) => { if (r.key.trim()) env[r.key.trim()] = r.value })
      const next = await updateTaskLoopConfig({
        llmModel: model || undefined,
        pipelineIntervalMs: interval.trim() ? Number(interval) : undefined,
        autoDispatch: cfg.autoDispatch,
        notifyEnabled: cfg.notifyEnabled,
        feishuAppId: appId.trim() || undefined,
        // 留空或掩码 = 不修改已保存 Secret
        ...(secret.trim() ? { feishuAppSecret: secret.trim() } : {}),
        featureFlags,
        env,
      })
      setCfg(next)
      setBanner('配置已保存；运行中的进程不热加载，需重启后生效')
      await reload()
    } catch (e) { setError(String((e as Error).message ?? e)) } finally { setBusy(null) }
  }

  const loadChats = async () => {
    setLoadingChats(true); setChatErr(''); setChats([])
    try {
      // 输入框里填了新凭证就用新凭证验证（可不先保存），否则用已保存配置
      const credentials = (appId.trim() && secret.trim()) ? { appId: appId.trim(), appSecret: secret.trim() } : undefined
      const r = await fetchFeishuChats(credentials)
      if (r.ok) { setChats(r.chats); if (r.chats.length === 0) setChatErr('机器人尚未加入任何群') }
      else setChatErr(r.error ?? '获取群列表失败')
    } catch (e) { setChatErr(String((e as Error).message ?? e)) } finally { setLoadingChats(false) }
  }

  const pickNotifyChat = async (chat: FeishuChatItem) => {
    setBusy('chat'); setError(''); setBanner('')
    try {
      await updateTaskLoopConfig({ notifyChatId: chat.chatId, notifyChatName: chat.name })
      setBanner(`播报群已设为「${chat.name}」；运行中的进程需重启后生效`)
      await reload()
    } catch (e) { setError(String((e as Error).message ?? e)) } finally { setBusy(null) }
  }

  const meta = status ? stateMeta[status.state] : null
  const currentLog = logs ? (tab === 'stdout' ? logs.stdout : logs.stderr) : null
  const logText = currentLog?.lines.join('\n') || '（暂无日志）'

  return (
    <div className="space-y-5">
      {/* 页头 */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-800 flex items-center gap-2"><Settings2 size={22} className="text-indigo-500" />项目小助理 · 配置与运维</h1>
          <p className="text-sm text-slate-500 mt-1">机器人启停、飞书接入凭证、功能开关与运行日志 —— 任务进展请看「任务看板」</p>
        </div>
        <button onClick={() => go?.('task-loop')}
          className="text-xs px-3 py-1.5 rounded-lg border border-slate-300 text-slate-600 hover:border-indigo-300 hover:text-indigo-600 flex items-center gap-1.5">
          <ArrowLeft size={13} />返回任务看板
        </button>
      </div>

      {banner && <div className="bg-emerald-50 border border-emerald-200 text-emerald-700 text-sm rounded-lg px-4 py-2.5">{banner}</div>}
      {error && <div className="bg-rose-50 border border-rose-200 text-rose-700 text-sm rounded-lg px-4 py-2.5">{error}</div>}

      {/* 状态卡 */}
      <div className="bg-white rounded-xl border border-slate-200/80 p-5">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            {meta && (
              <span className={`inline-flex items-center gap-1.5 text-sm font-medium px-3 py-1 rounded-full border ${meta.cls}`}>
                <span className={`w-2 h-2 rounded-full ${meta.dot} ${status?.state === 'running' ? 'animate-pulse' : ''}`} />{meta.label}
              </span>
            )}
            <span className="text-sm text-slate-500">pid：<span className="font-mono text-slate-700">{status?.pid ?? '—'}</span></span>
            {status?.managedByPlatform && <span className="text-xs px-2 py-0.5 rounded bg-indigo-50 text-indigo-600">本平台托管</span>}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setConfirmOp('start')} disabled={busy !== null || status?.state === 'running'}
              className="text-sm px-3.5 py-2 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5">
              <Play size={14} />启动
            </button>
            <button onClick={() => setConfirmOp('stop')} disabled={busy !== null || status?.state !== 'running'}
              className="text-sm px-3.5 py-2 rounded-lg bg-rose-600 text-white hover:bg-rose-700 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5">
              <Square size={14} />停止
            </button>
            <button onClick={() => setConfirmOp('restart')} disabled={busy !== null}
              className="text-sm px-3.5 py-2 rounded-lg bg-slate-800 text-white hover:bg-slate-900 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5">
              <RotateCw size={14} />重启
            </button>
          </div>
        </div>
        <div className="mt-3 text-xs text-slate-400 font-mono">锁文件：{status?.lock.path ?? '/tmp/aigility-feishu-task-loop.lock'}{status?.lock.stale ? ' · stale（pid 已死，启动时自愈接管）' : ''}</div>

        {/* 左侧导航显示开关（与「模块装配」页同一状态；应用中心的启用开关与此无关） */}
        <div className="mt-3 pt-3 border-t border-slate-100 flex items-center justify-between flex-wrap gap-2">
          <div>
            <div className="text-sm text-slate-700">在左侧导航栏显示「项目小助理」</div>
            <p className="text-[11px] text-slate-400 mt-0.5">只控制导航可见性，不影响机器人运行；与「模块装配」页是同一个开关</p>
          </div>
          <button onClick={() => onToggleNav?.()}
            className={`w-11 h-[24px] rounded-full transition relative shrink-0 ${navVisible ? 'bg-blue-600' : 'bg-slate-200'}`}>
            <span className={`absolute top-[4px] w-4 h-4 rounded-full bg-white shadow transition-all ${navVisible ? 'left-[23px]' : 'left-[4px]'}`} />
          </button>
        </div>

        {confirmOp && (
          <div className="mt-4 bg-amber-50 border border-amber-200 rounded-lg p-4">
            <p className="text-sm text-amber-800">
              确认要{confirmOp === 'start' ? '启动' : confirmOp === 'stop' ? '停止' : '重启'}项目小助理吗？
              {confirmOp !== 'start' && ' 停止后飞书机器人将不再处理消息。'}
            </p>
            <div className="mt-3 flex gap-2">
              <button onClick={() => runOp(confirmOp)} disabled={busy !== null}
                className="text-sm px-3.5 py-1.5 rounded-lg bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-40">确认</button>
              <button onClick={() => setConfirmOp(null)} disabled={busy !== null}
                className="text-sm px-3.5 py-1.5 rounded-lg border border-slate-300 text-slate-600 hover:bg-white">取消</button>
            </div>
          </div>
        )}
      </div>

      {/* 飞书接入卡 */}
      <div className="bg-white rounded-xl border border-slate-200/80 p-5 space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h2 className="font-semibold text-slate-800 text-sm flex items-center gap-1.5"><KeyRound size={14} className="text-indigo-500" />飞书接入</h2>
          <span className="text-xs text-slate-400">页面配置优先于仓库 .env；Secret 保存后只显示掩码</span>
        </div>
        <div className="grid md:grid-cols-2 gap-4">
          <div>
            <label className="text-xs text-slate-500 block mb-1.5">App ID（FEISHU_APP_ID）</label>
            <input value={appId} onChange={(e) => setAppId(e.target.value)} placeholder="cli_xxx（留空沿用 .env）"
              className="w-full text-sm border border-slate-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-200 font-mono" />
          </div>
          <div>
            <label className="text-xs text-slate-500 block mb-1.5">
              App Secret（FEISHU_APP_SECRET）
              {cfg.feishuAppSecretMasked && <span className="ml-2 text-slate-400">已保存：{cfg.feishuAppSecretMasked}</span>}
            </label>
            <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={cfg.feishuAppSecret ? '输入新值以更换；留空不修改' : '应用凭证 App Secret'}
              className="w-full text-sm border border-slate-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-200 font-mono" />
          </div>
        </div>
        <div className="text-xs text-slate-500">
          修改凭证后先点「保存配置」，再拉取群列表；或直接在两个输入框都填好的情况下点「拉取群列表」先验证。
        </div>
        <div className="border-t border-slate-100 pt-4">
          <div className="flex items-center justify-between flex-wrap gap-2 mb-2">
            <label className="text-xs text-slate-500 flex items-center gap-1.5">
              <MessageSquareShare size={13} className="text-slate-400" />
              播报群（TASK_NOTIFY_CHAT_ID）——配置后静默收集的汇总/澄清播报只发该群（如「机器人群」），不回各源群
            </label>
            <button onClick={loadChats} disabled={loadingChats}
              className="text-xs px-3 py-1.5 rounded-lg border border-indigo-300 text-indigo-600 hover:bg-indigo-50 disabled:opacity-40 flex items-center gap-1">
              {loadingChats ? <RefreshCw size={12} className="animate-spin" /> : <RefreshCw size={12} />}拉取群列表
            </button>
          </div>
          {chatErr && <p className="text-xs text-rose-600 bg-rose-50 border border-rose-100 rounded px-2.5 py-1.5 mb-2">{chatErr}</p>}
          {cfg.notifyChatId && (
            <p className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-100 rounded px-2.5 py-1.5 mb-2">
              当前播报群：{cfg.notifyChatName || '（未命名群）'} <span className="font-mono text-slate-400">{cfg.notifyChatId}</span>
            </p>
          )}
          {chats.length > 0 && (
            <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-2">
              {chats.map((c) => (
                <button key={c.chatId} onClick={() => pickNotifyChat(c)} disabled={busy !== null}
                  className={`text-left text-xs px-3 py-2 rounded-lg border transition disabled:opacity-40 ${cfg.notifyChatId === c.chatId ? 'border-emerald-300 bg-emerald-50 text-emerald-700' : 'border-slate-200 text-slate-600 hover:border-indigo-300 hover:bg-indigo-50'}`}>
                  <span className="font-medium">{c.name}</span>
                  <span className="block font-mono text-[10px] text-slate-400 truncate">{c.chatId}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="pt-1">
          <button onClick={saveConfig} disabled={busy !== null}
            className="text-sm px-4 py-2 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-40 flex items-center gap-1.5">
            {busy === 'save' ? <RefreshCw size={14} className="animate-spin" /> : <Save size={14} />}保存接入配置
          </button>
        </div>
      </div>

      {/* 配置卡 */}
      <div className="bg-white rounded-xl border border-slate-200/80 p-5 space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h2 className="font-semibold text-slate-800 text-sm">配置管理</h2>
          <span className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded px-2 py-1">配置保存后需重启生效（运行中进程不热加载）</span>
        </div>

        <div className="grid md:grid-cols-2 gap-4">
          <div>
            <label className="text-xs text-slate-500 block mb-1.5">LLM 兜底模型（TASK_ASSISTANT_MODEL）</label>
            <div className="flex gap-2">
              <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="留空使用模块默认"
                className="flex-1 text-sm border border-slate-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-200 font-mono" />
              <select value={COMMON_MODELS.includes(model) ? model : ''} onChange={(e) => e.target.value && setModel(e.target.value)}
                className="text-sm border border-slate-300 rounded-lg px-2 py-2 bg-white text-slate-600">
                <option value="">常用模型…</option>
                {COMMON_MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="text-xs text-slate-500 block mb-1.5">流水线轮询间隔（ms，TASK_PIPELINE_INTERVAL_MS）</label>
            <input value={interval} onChange={(e) => setIntervalMs(e.target.value.replace(/[^\d]/g, ''))} placeholder="留空使用模块默认"
              className="w-full text-sm border border-slate-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-200 font-mono" />
          </div>
        </div>

        <div className="flex flex-wrap gap-6">
          <label className="flex items-center gap-2 text-sm text-slate-600 cursor-pointer">
            <input type="checkbox" checked={cfg.autoDispatch ?? false} onChange={(e) => setCfg({ ...cfg, autoDispatch: e.target.checked })} className="accent-indigo-600" />
            自动派发（TASK_AUTO_DISPATCH）
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-600 cursor-pointer">
            <input type="checkbox" checked={cfg.notifyEnabled ?? false} onChange={(e) => setCfg({ ...cfg, notifyEnabled: e.target.checked })} className="accent-indigo-600" />
            通知开关（TASK_NOTIFY_ENABLED）
          </label>
        </div>

        {/* 功能开关 featureFlags */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-xs text-slate-500">功能开关 featureFlags（注入 TASK_FLAG_&lt;KEY&gt;）</label>
            <div className="flex gap-2">
              <input value={newFlagKey} onChange={(e) => setNewFlagKey(e.target.value)} placeholder="新开关名，如 deep_think"
                className="text-xs border border-slate-300 rounded-lg px-2.5 py-1.5 font-mono" />
              <button onClick={() => { if (newFlagKey.trim()) { setFlags((f) => [...f, { key: newFlagKey.trim(), value: true }]); setNewFlagKey('') } }}
                className="text-xs px-2.5 py-1.5 rounded-lg border border-slate-300 text-slate-600 hover:bg-slate-50 flex items-center gap-1"><Plus size={12} />新增</button>
            </div>
          </div>
          {flags.length === 0 && <p className="text-xs text-slate-400">暂无功能开关</p>}
          <div className="space-y-1.5">
            {flags.map((f, i) => (
              <div key={`${f.key}-${i}`} className="flex items-center gap-2.5 text-sm">
                <span className="font-mono text-slate-700 w-56 truncate">{f.key}</span>
                <button onClick={() => setFlags((fs) => fs.map((x, j) => (j === i ? { ...x, value: !x.value } : x)))}
                  className={`relative w-9 h-5 rounded-full transition ${f.value ? 'bg-emerald-500' : 'bg-slate-300'}`}>
                  <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full transition-all ${f.value ? 'left-[18px]' : 'left-0.5'}`} />
                </button>
                <span className={`text-xs ${f.value ? 'text-emerald-600' : 'text-slate-400'}`}>{f.value ? '开' : '关'}</span>
                <button onClick={() => setFlags((fs) => fs.filter((_, j) => j !== i))} className="text-slate-300 hover:text-rose-500 ml-1"><Trash2 size={14} /></button>
              </div>
            ))}
          </div>
        </div>

        {/* 自定义 env */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-xs text-slate-500">自定义环境变量 env（透传子进程）</label>
            <button onClick={() => setEnvRows((r) => [...r, { key: '', value: '' }])}
              className="text-xs px-2.5 py-1.5 rounded-lg border border-slate-300 text-slate-600 hover:bg-slate-50 flex items-center gap-1"><Plus size={12} />新增</button>
          </div>
          {envRows.length === 0 && <p className="text-xs text-slate-400">暂无自定义环境变量</p>}
          <div className="space-y-1.5">
            {envRows.map((r, i) => (
              <div key={i} className="flex items-center gap-2">
                <input value={r.key} onChange={(e) => setEnvRows((rs) => rs.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))} placeholder="VAR_NAME"
                  className="text-xs border border-slate-300 rounded-lg px-2.5 py-1.5 font-mono w-48" />
                <span className="text-slate-400">=</span>
                <EnvValueInput value={r.value} onChange={(v) => setEnvRows((rs) => rs.map((x, j) => (j === i ? { ...x, value: v } : x)))} />
                <button onClick={() => setEnvRows((rs) => rs.filter((_, j) => j !== i))} className="text-slate-300 hover:text-rose-500"><Trash2 size={14} /></button>
              </div>
            ))}
          </div>
        </div>

        <div className="pt-1">
          <button onClick={saveConfig} disabled={busy !== null}
            className="text-sm px-4 py-2 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-40 flex items-center gap-1.5">
            {busy === 'save' ? <RefreshCw size={14} className="animate-spin" /> : <Save size={14} />}保存配置
          </button>
        </div>
      </div>

      {/* 日志卡 */}
      <div className="bg-white rounded-xl border border-slate-200/80 p-5">
        <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
          <h2 className="font-semibold text-slate-800 text-sm">运行日志</h2>
          <div className="flex items-center gap-2">
            <div className="flex rounded-lg border border-slate-300 overflow-hidden text-xs">
              {(['stdout', 'stderr'] as const).map((t) => (
                <button key={t} onClick={() => setTab(t)}
                  className={`px-3 py-1.5 transition ${tab === t ? 'bg-slate-800 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}>{t}</button>
              ))}
            </div>
            <button onClick={() => setAutoRefresh((v) => !v)}
              className={`text-xs px-2.5 py-1.5 rounded-lg border flex items-center gap-1 ${autoRefresh ? 'border-emerald-300 text-emerald-600 bg-emerald-50' : 'border-slate-300 text-slate-500'}`}>
              {autoRefresh ? <><Pause size={12} />10s 自动刷新中</> : <><Play size={12} />已暂停</>}
            </button>
            <button onClick={loadLogs} className="text-xs px-2.5 py-1.5 rounded-lg border border-slate-300 text-slate-600 hover:bg-slate-50 flex items-center gap-1"><RefreshCw size={12} />刷新</button>
          </div>
        </div>
        <pre ref={logBoxRef} className="bg-slate-950 text-slate-200 rounded-lg p-4 text-xs font-mono leading-5 max-h-96 overflow-auto whitespace-pre-wrap break-all">
{logText}
        </pre>
        <p className="text-xs text-slate-400 mt-2">日志文件：{currentLog?.file ?? '—'}</p>
      </div>
    </div>
  )
}

function EnvValueInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <input value={value} onChange={(e) => onChange(e.target.value)} placeholder="值"
      className="text-xs border border-slate-300 rounded-lg px-2.5 py-1.5 font-mono flex-1 min-w-0" />
  )
}
