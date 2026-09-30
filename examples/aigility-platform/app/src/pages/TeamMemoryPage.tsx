/**
 * TeamMemoryPage — 团队记忆总结（team-memory-console 收编）· 展示与配置
 *
 * 与「项目小助理」配置页（TaskLoopConfigPage）同构，本页把团队记忆日报/晨报
 * 收编为智悦平台可展示、可配置的功能：
 *   - 状态卡：调度器运行徽标 + 总开关 + 下次触发倒计时 + 最近运行历史（10 条）
 *   - 立即生成卡：日报 / 晨报手动触发（同步等待，最长 5 分钟）
 *   - TiMEM 接入卡：API Key（掩码回显）/ Base URL / 摘要模型
 *   - 飞书推送卡：App ID / Secret / 推送群可视化选取（先保存再拉群，或填新凭证直接验证）
 *   - 调度卡：日报 / 晨报触发时刻（HH:MM，保存即生效，无需重启）
 *   - 自定义 env + 运行日志（stdout/stderr Tab，10s 轮询可暂停）
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  fetchTeamMemoryStatus, fetchTeamMemoryConfig, updateTeamMemoryConfig,
  runTeamMemoryJob, fetchTeamMemoryLogs, fetchTeamMemoryChats,
  type TeamMemoryStatus, type TeamMemoryConfig, type TeamMemoryJobKind,
  type TeamMemoryLogTail, type FeishuChatItem,
} from '../lib/harness'
import {
  Play, Save, RefreshCw, Pause, KeyRound, MessageSquareShare, Clock, BookOpenCheck, Plus, Trash2, Sparkles,
} from 'lucide-react'

interface EnvRow { key: string; value: string }

const KIND_META: Record<TeamMemoryJobKind, { label: string; icon: string }> = {
  report: { label: '团队日报', icon: '🌆' },
  morning: { label: '团队晨报', icon: '🌅' },
}

const RUN_STATUS_META: Record<string, { label: string; cls: string }> = {
  ok: { label: '成功', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  failed: { label: '失败', cls: 'bg-rose-50 text-rose-700 border-rose-200' },
  timeout: { label: '超时', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  running: { label: '运行中', cls: 'bg-blue-50 text-blue-700 border-blue-200' },
}

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/

export default function TeamMemoryPage({ navVisible = true, onToggleNav, navEditable = true }: {
  /** 是否固定在左侧导航（独立于「模块装配」的用户偏好，默认不进导航、从应用中心进入） */
  navVisible?: boolean
  /** 切换左侧导航显示 */
  onToggleNav?: () => void
  /** 导航布局编辑权限（现阶段仅管理员可改，普通用户只读） */
  navEditable?: boolean
} = {}) {
  const [status, setStatus] = useState<TeamMemoryStatus | null>(null)
  const [cfg, setCfg] = useState<TeamMemoryConfig>({ enabled: false, dailyReportTime: '18:30', morningReportTime: '08:30', env: {} })
  const [banner, setBanner] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)

  // 配置草稿
  const [dailyTime, setDailyTime] = useState('18:30')
  const [morningTime, setMorningTime] = useState('08:30')
  const [timemKey, setTimemKey] = useState('')
  const [timemUrl, setTimemUrl] = useState('')
  const [summaryModel, setSummaryModel] = useState('')
  const [appId, setAppId] = useState('')
  const [appSecret, setAppSecret] = useState('')
  const [litellmUrl, setLitellmUrl] = useState('')
  const [litellmKey, setLitellmKey] = useState('')
  const [envRows, setEnvRows] = useState<EnvRow[]>([])

  // 飞书群枚举
  const [chats, setChats] = useState<FeishuChatItem[]>([])
  const [chatErr, setChatErr] = useState('')
  const [loadingChats, setLoadingChats] = useState(false)

  // 运行输出（立即生成的同步结果）+ 日志
  const [runOutput, setRunOutput] = useState<{ kind: TeamMemoryJobKind; text: string } | null>(null)
  const [tab, setTab] = useState<'stdout' | 'stderr'>('stdout')
  const [logs, setLogs] = useState<{ stdout: TeamMemoryLogTail; stderr: TeamMemoryLogTail } | null>(null)
  const [autoRefresh, setAutoRefresh] = useState(true)
  const logBoxRef = useRef<HTMLPreElement>(null)

  const reload = useCallback(async () => {
    const s = await fetchTeamMemoryStatus(30)
    setStatus(s)
    const c = await fetchTeamMemoryConfig()
    setCfg(c)
    setDailyTime(c.dailyReportTime || '18:30')
    setMorningTime(c.morningReportTime || '08:30')
    setTimemUrl(c.timemBaseUrl ?? '')
    setSummaryModel(c.summaryModel ?? '')
    setAppId(c.feishuAppId ?? '')
    setAppSecret('') // Secret 不回显原文；留空 = 不修改
    setLitellmUrl(c.litellmUrl ?? '')
    setEnvRows(Object.entries(c.env ?? {}).map(([key, value]) => ({ key, value })))
  }, [])

  const loadLogs = useCallback(async () => {
    fetchTeamMemoryLogs(200).then((l) => {
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

  const saveConfig = async (patch?: Partial<TeamMemoryConfig>, note?: string) => {
    setBusy('save'); setError(''); setBanner('')
    try {
      for (const [label, v] of [['日报时刻', dailyTime], ['晨报时刻', morningTime]] as const) {
        if (!HHMM_RE.test(v)) { setError(`${label}格式应为 HH:MM（24 小时制）`); return }
      }
      const env: Record<string, string> = {}
      envRows.forEach((r) => { if (r.key.trim()) env[r.key.trim()] = r.value })
      const next = await updateTeamMemoryConfig({
        enabled: cfg.enabled,
        dailyReportTime: dailyTime,
        morningReportTime: morningTime,
        timemBaseUrl: timemUrl.trim() || undefined,
        summaryModel: summaryModel.trim() || undefined,
        feishuAppId: appId.trim() || undefined,
        ...(appSecret.trim() ? { feishuAppSecret: appSecret.trim() } : {}),
        litellmUrl: litellmUrl.trim() || undefined,
        ...(litellmKey.trim() ? { litellmKey: litellmKey.trim() } : {}),
        ...(timemKey.trim() ? { timemApiKey: timemKey.trim() } : {}),
        env,
        ...patch,
      })
      setCfg(next)
      setBanner(note ?? '配置已保存；调度时刻保存即生效（凭证留空/掩码 = 不修改）')
      await reload()
    } catch (e) { setError(String((e as Error).message ?? e)) } finally { setBusy(null) }
  }

  const toggleEnabled = async () => {
    const next = !cfg.enabled
    setCfg({ ...cfg, enabled: next })
    await saveConfig({ enabled: next }, next ? '调度已开启：到点自动生成并推送日报/晨报' : '调度已关闭：到点不再触发，「立即生成」仍可用')
  }

  const runNow = async (kind: TeamMemoryJobKind) => {
    setBusy(`run-${kind}`); setError(''); setBanner(''); setRunOutput(null)
    try {
      const r = await runTeamMemoryJob(kind)
      setBanner(r.message)
      setRunOutput({ kind, text: [r.stdoutTail, r.stderrTail ? `── stderr ──\n${r.stderrTail}` : ''].filter(Boolean).join('\n') })
      await Promise.all([reload(), loadLogs()])
    } catch (e) {
      // 非 200 也带 message/stdoutTail，尽量还原
      setError(String((e as Error).message ?? e))
    } finally { setBusy(null) }
  }

  const loadChats = async () => {
    setLoadingChats(true); setChatErr(''); setChats([])
    try {
      const credentials = (appId.trim() && appSecret.trim()) ? { appId: appId.trim(), appSecret: appSecret.trim() } : undefined
      const r = await fetchTeamMemoryChats(credentials)
      if (r.ok) { setChats(r.chats); if (r.chats.length === 0) setChatErr('机器人尚未加入任何群') }
      else setChatErr(r.error ?? '获取群列表失败')
    } catch (e) { setChatErr(String((e as Error).message ?? e)) } finally { setLoadingChats(false) }
  }

  const pickChat = async (chat: FeishuChatItem) => {
    setBusy('chat'); setError(''); setBanner('')
    try {
      await updateTeamMemoryConfig({ reportChatId: chat.chatId, reportChatName: chat.name })
      setBanner(`推送群已设为「${chat.name}」`)
      await reload()
    } catch (e) { setError(String((e as Error).message ?? e)) } finally { setBusy(null) }
  }

  // 下次触发倒计时
  const nextRunText = (() => {
    const n = status?.nextRun
    if (!n) return cfg.enabled ? '—' : '调度已关闭'
    const ms = new Date(n.at).getTime() - Date.now()
    if (ms <= 0) return '即将触发'
    const h = Math.floor(ms / 3600000), m = Math.ceil((ms % 3600000) / 60000)
    return `${KIND_META[n.kind].label} · ${h > 0 ? `${h} 小时 ` : ''}${m} 分钟后`
  })()

  const currentLog = logs ? (tab === 'stdout' ? logs.stdout : logs.stderr) : null
  const logText = currentLog?.lines.join('\n') || '（暂无日志）'

  return (
    <div className="space-y-5">
      {/* 页头 */}
      <div>
        <h1 className="text-xl font-semibold text-slate-800 flex items-center gap-2"><BookOpenCheck size={22} className="text-sky-500" />团队记忆总结</h1>
        <p className="text-sm text-slate-500 mt-1">把 TiMEM 云端沉淀的团队记忆按时聚合成日报 / 晨报并推送飞书群 —— 展示、调度与凭证全在平台内配置</p>
      </div>

      {banner && <div className="bg-emerald-50 border border-emerald-200 text-emerald-700 text-sm rounded-lg px-4 py-2.5">{banner}</div>}
      {error && <div className="bg-rose-50 border border-rose-200 text-rose-700 text-sm rounded-lg px-4 py-2.5 break-all">{error}</div>}

      {/* 左侧导航显示开关（独立于「模块装配」的用户偏好；默认不进导航，从应用中心进入） */}
      <div className="bg-white rounded-xl border border-slate-200/80 px-5 py-3.5 flex items-center justify-between flex-wrap gap-2">
        <div>
          <div className="text-sm text-slate-700">在左侧导航栏显示「团队记忆总结」</div>
          <p className="text-[11px] text-slate-400 mt-0.5">只控制导航可见性，不影响调度与推送；关闭后仍可从应用中心进入本页</p>
        </div>
        <button onClick={() => onToggleNav?.()} disabled={!navEditable}
          title={navEditable ? '切换左侧导航显示' : '导航布局由管理员统一配置'}
          className={`w-11 h-[24px] rounded-full transition relative shrink-0 ${navVisible ? 'bg-blue-600' : 'bg-slate-200'} ${!navEditable ? 'opacity-50 cursor-not-allowed' : ''}`}>
          <span className={`absolute top-[4px] w-4 h-4 rounded-full bg-white shadow transition-all ${navVisible ? 'left-[23px]' : 'left-[4px]'}`} />
        </button>
      </div>

      {/* 状态卡 */}
      <div className="bg-white rounded-xl border border-slate-200/80 p-5">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3 flex-wrap">
            <span className={`inline-flex items-center gap-1.5 text-sm font-medium px-3 py-1 rounded-full border ${status?.schedulerRunning ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-slate-100 text-slate-600 border-slate-200'}`}>
              <span className={`w-2 h-2 rounded-full ${status?.schedulerRunning ? 'bg-emerald-500 animate-pulse' : 'bg-slate-400'}`} />
              {status?.schedulerRunning ? '调度器运行中' : '调度器未启动'}
            </span>
            <span className="text-sm text-slate-500 flex items-center gap-1.5"><Clock size={13} className="text-slate-400" />{nextRunText}</span>
            {cfg.enabled && <span className="text-xs px-2 py-0.5 rounded bg-sky-50 text-sky-600">自动调度已开启</span>}
          </div>
          {/* 总开关 */}
          <label className="flex items-center gap-2.5 text-sm text-slate-600 cursor-pointer">
            每日自动调度
            <button onClick={toggleEnabled} disabled={busy !== null}
              className={`w-11 h-[24px] rounded-full transition relative shrink-0 disabled:opacity-40 ${cfg.enabled ? 'bg-blue-600' : 'bg-slate-200'}`}>
              <span className={`absolute top-[4px] w-4 h-4 rounded-full bg-white shadow transition-all ${cfg.enabled ? 'left-[23px]' : 'left-[4px]'}`} />
            </button>
          </label>
        </div>

        {/* 运行历史 */}
        <div className="mt-4 border-t border-slate-100 pt-3">
          <div className="text-xs text-slate-400 mb-2">最近运行（含调度与手动触发，最多保留 50 条）</div>
          {!status?.runs.length && <p className="text-xs text-slate-400">暂无运行记录 —— 可点下方「立即生成」跑一次验证链路</p>}
          <div className="space-y-1.5">
            {status?.runs.map((r) => {
              const meta = RUN_STATUS_META[r.status] ?? RUN_STATUS_META.failed
              return (
                <div key={r.startedAt} className="flex items-center gap-2.5 text-xs flex-wrap">
                  <span className={`px-1.5 py-0.5 rounded border ${meta.cls}`}>{meta.label}</span>
                  <span>{KIND_META[r.kind].icon} {KIND_META[r.kind].label}</span>
                  <span className="text-slate-400">{r.trigger === 'manual' ? '手动' : '调度'} · {new Date(r.startedAt).toLocaleString()}</span>
                  {r.exitCode !== undefined && <span className="text-slate-300 font-mono">exit {r.exitCode}</span>}
                  {r.error && <span className="text-rose-500 truncate max-w-md" title={r.error}>{r.error}</span>}
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {/* 立即生成卡 */}
      <div className="bg-white rounded-xl border border-slate-200/80 p-5 space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h2 className="font-semibold text-slate-800 text-sm flex items-center gap-1.5"><Sparkles size={14} className="text-amber-500" />立即生成</h2>
          <span className="text-xs text-slate-400">拉取 TiMEM 近期团队记忆 → LLM 聚合 → 推送飞书群（同步等待，最长 5 分钟）</span>
        </div>
        <div className="flex gap-2 flex-wrap">
          {(['report', 'morning'] as const).map((k) => (
            <button key={k} onClick={() => runNow(k)} disabled={busy !== null}
              className="text-sm px-4 py-2 rounded-lg bg-sky-600 text-white hover:bg-sky-700 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5">
              {busy === `run-${k}` ? <RefreshCw size={14} className="animate-spin" /> : <><span>{KIND_META[k].icon}</span><Play size={13} /></>}
              {busy === `run-${k}` ? '生成中…' : `立即生成${KIND_META[k].label}`}
            </button>
          ))}
        </div>
        {runOutput && (
          <pre className="bg-slate-950 text-slate-200 rounded-lg p-4 text-xs font-mono leading-5 max-h-64 overflow-auto whitespace-pre-wrap break-all">{runOutput.text || '（无输出）'}</pre>
        )}
      </div>

      {/* TiMEM / LLM 接入卡 */}
      <div className="bg-white rounded-xl border border-slate-200/80 p-5 space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h2 className="font-semibold text-slate-800 text-sm flex items-center gap-1.5"><KeyRound size={14} className="text-sky-500" />TiMEM 与 LLM 接入</h2>
          <span className="text-xs text-slate-400">页面配置优先于仓库 .env；Key 保存后只显示掩码</span>
        </div>
        <div className="grid md:grid-cols-2 gap-4">
          <div>
            <label className="text-xs text-slate-500 block mb-1.5">
              TiMEM API Key（TIMEM_API_KEY）
              {cfg.timemApiKeyMasked && <span className="ml-2 text-slate-400">已保存：{cfg.timemApiKeyMasked}</span>}
            </label>
            <input type="password" value={timemKey} onChange={(e) => setTimemKey(e.target.value)} placeholder={cfg.timemApiKey ? '输入新值以更换；留空不修改' : 'tim_…（TiMEM 云 API Key）'}
              className="w-full text-sm border border-slate-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-sky-200 font-mono" />
          </div>
          <div>
            <label className="text-xs text-slate-500 block mb-1.5">TiMEM Base URL（TIMEM_BASE_URL）</label>
            <input value={timemUrl} onChange={(e) => setTimemUrl(e.target.value)} placeholder="https://api.timem.cloud（留空用默认）"
              className="w-full text-sm border border-slate-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-sky-200 font-mono" />
          </div>
          <div>
            <label className="text-xs text-slate-500 block mb-1.5">摘要模型（REPORT_SUMMARY_MODEL）</label>
            <input value={summaryModel} onChange={(e) => setSummaryModel(e.target.value)} placeholder="如 deepseek-v4-flash（留空用默认）"
              className="w-full text-sm border border-slate-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-sky-200 font-mono" />
          </div>
          <div>
            <label className="text-xs text-slate-500 block mb-1.5">LLM 网关地址（LITELLM_URL）</label>
            <input value={litellmUrl} onChange={(e) => setLitellmUrl(e.target.value)} placeholder="http://127.0.0.1:48724（留空沿用 .env）"
              className="w-full text-sm border border-slate-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-sky-200 font-mono" />
          </div>
          <div>
            <label className="text-xs text-slate-500 block mb-1.5">
              LLM 网关 Key（LITELLM_KEY）
              {cfg.litellmKeyMasked && <span className="ml-2 text-slate-400">已保存：{cfg.litellmKeyMasked}</span>}
            </label>
            <input type="password" value={litellmKey} onChange={(e) => setLitellmKey(e.target.value)} placeholder={cfg.litellmKey ? '输入新值以更换；留空不修改' : 'sk-…'}
              className="w-full text-sm border border-slate-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-sky-200 font-mono" />
          </div>
        </div>
      </div>

      {/* 飞书推送卡 */}
      <div className="bg-white rounded-xl border border-slate-200/80 p-5 space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h2 className="font-semibold text-slate-800 text-sm flex items-center gap-1.5"><MessageSquareShare size={14} className="text-indigo-500" />飞书推送</h2>
          <span className="text-xs text-slate-400">日报 / 晨报生成后推送到选定群</span>
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
            <input type="password" value={appSecret} onChange={(e) => setAppSecret(e.target.value)} placeholder={cfg.feishuAppSecret ? '输入新值以更换；留空不修改' : '应用凭证 App Secret'}
              className="w-full text-sm border border-slate-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-200 font-mono" />
          </div>
        </div>
        <div className="text-xs text-slate-500">修改凭证后先「保存全部配置」，再拉取群列表；或两个输入框都填好后直接「拉取群列表」先验证。</div>
        <div className="border-t border-slate-100 pt-4">
          <div className="flex items-center justify-between flex-wrap gap-2 mb-2">
            <label className="text-xs text-slate-500">推送群（FEISHU_REPORT_CHAT_ID）</label>
            <button onClick={loadChats} disabled={loadingChats}
              className="text-xs px-3 py-1.5 rounded-lg border border-indigo-300 text-indigo-600 hover:bg-indigo-50 disabled:opacity-40 flex items-center gap-1">
              <RefreshCw size={12} className={loadingChats ? 'animate-spin' : ''} />拉取群列表
            </button>
          </div>
          {chatErr && <p className="text-xs text-rose-600 bg-rose-50 border border-rose-100 rounded px-2.5 py-1.5 mb-2">{chatErr}</p>}
          {cfg.reportChatId && (
            <p className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-100 rounded px-2.5 py-1.5 mb-2">
              当前推送群：{cfg.reportChatName || '（未命名群）'} <span className="font-mono text-slate-400">{cfg.reportChatId}</span>
            </p>
          )}
          {chats.length > 0 && (
            <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-2">
              {chats.map((c) => (
                <button key={c.chatId} onClick={() => pickChat(c)} disabled={busy !== null}
                  className={`text-left text-xs px-3 py-2 rounded-lg border transition disabled:opacity-40 ${cfg.reportChatId === c.chatId ? 'border-emerald-300 bg-emerald-50 text-emerald-700' : 'border-slate-200 text-slate-600 hover:border-indigo-300 hover:bg-indigo-50'}`}>
                  <span className="font-medium">{c.name}</span>
                  <span className="block font-mono text-[10px] text-slate-400 truncate">{c.chatId}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 调度 + 自定义 env + 保存 */}
      <div className="bg-white rounded-xl border border-slate-200/80 p-5 space-y-4">
        <h2 className="font-semibold text-slate-800 text-sm flex items-center gap-1.5"><Clock size={14} className="text-emerald-500" />调度与高级配置</h2>
        <div className="grid md:grid-cols-2 gap-4">
          <div>
            <label className="text-xs text-slate-500 block mb-1.5">团队日报触发时刻（每天一次）</label>
            <input value={dailyTime} onChange={(e) => setDailyTime(e.target.value)} placeholder="18:30"
              className="w-full text-sm border border-slate-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-emerald-200 font-mono" />
          </div>
          <div>
            <label className="text-xs text-slate-500 block mb-1.5">团队晨报触发时刻（每天一次）</label>
            <input value={morningTime} onChange={(e) => setMorningTime(e.target.value)} placeholder="08:30"
              className="w-full text-sm border border-slate-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-emerald-200 font-mono" />
          </div>
        </div>
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-xs text-slate-500">自定义环境变量 env（透传生成子进程，优先级最高）</label>
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
                <input value={r.value} onChange={(e) => setEnvRows((rs) => rs.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} placeholder="值"
                  className="text-xs border border-slate-300 rounded-lg px-2.5 py-1.5 font-mono flex-1 min-w-0" />
                <button onClick={() => setEnvRows((rs) => rs.filter((_, j) => j !== i))} className="text-slate-300 hover:text-rose-500"><Trash2 size={14} /></button>
              </div>
            ))}
          </div>
        </div>
        <div className="pt-1">
          <button onClick={() => saveConfig()} disabled={busy !== null}
            className="text-sm px-4 py-2 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-40 flex items-center gap-1.5">
            {busy === 'save' ? <RefreshCw size={14} className="animate-spin" /> : <Save size={14} />}保存全部配置
          </button>
        </div>
      </div>

      {/* 日志卡 */}
      <div className="bg-white rounded-xl border border-slate-200/80 p-5">
        <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
          <h2 className="font-semibold text-slate-800 text-sm">生成日志</h2>
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
