import { useEffect, useState } from 'react'
import { centerApps, meetingDetail, type CenterApp } from '../mock/data'
import {
  generateDoc, fetchReportTemplates, saveReportTemplate, deleteReportTemplate,
  fetchTaskLoopStatus, startTaskLoop, stopTaskLoop,
  type ReportTemplate, type DocBlock, type TaskLoopOpResult,
} from '../lib/harness'
import { ArrowLeft, PlusCircle, CheckCircle2, Clock, Loader2, FileText, CalendarClock, BarChart3, Workflow, ClipboardList, Headset, FileBarChart, MessageSquareText, FolderOpen, Sparkles, Bot } from 'lucide-react'

const appIcon: Record<string, any> = {
  'app-qa': MessageSquareText, 'app-doc': FolderOpen, 'app-meeting': CalendarClock, 'app-data': BarChart3,
  'app-flow': Workflow, 'app-task': ClipboardList, 'app-service': Headset, 'app-report': FileBarChart,
  'app-task-loop': Bot,
}
const iconColor: Record<string, string> = {
  知识服务: 'bg-blue-50 text-blue-600', 办公效率: 'bg-emerald-50 text-emerald-600', 数据分析: 'bg-sky-50 text-sky-600',
  内容生成: 'bg-amber-50 text-amber-600', 流程辅助: 'bg-cyan-50 text-cyan-600', 客户服务: 'bg-rose-50 text-rose-600',
}

export default function AppCenterPage({ openPage }: {
  /** 「打开」跳转站内页面（如项目小助理 → task-loop 任务看板） */
  openPage?: (p: string) => void
} = {}) {
  const [apps, setApps] = useState(centerApps)
  const [open, setOpen] = useState<CenterApp | null>(null)

  // 「项目小助理」卡片开关 = 机器人进程启停（真）：状态读服务端真实运行态，
  // 与「配置与运维」页的启动/停止按钮等价、双向同步；导航可见性不归它管
  const [tlRunning, setTlRunning] = useState<boolean | null>(null) // null=查询中
  const [tlBusy, setTlBusy] = useState(false)
  const [tlNote, setTlNote] = useState('')
  const [tlNoteErr, setTlNoteErr] = useState(false)

  useEffect(() => {
    let alive = true
    fetchTaskLoopStatus(1)
      .then(s => { if (alive) setTlRunning(s.state === 'running') })
      .catch(() => { if (alive) setTlRunning(false) })
    return () => { alive = false }
  }, [])

  const applyTlResult = (r: TaskLoopOpResult) => {
    setTlRunning(r.state === 'running')
    setTlNote(r.message)
    setTlNoteErr(!r.ok)
    setTimeout(() => setTlNote(''), 6000)
  }

  const toggleTaskLoopRun = async () => {
    if (tlBusy) return
    setTlBusy(true); setTlNote('')
    try {
      applyTlResult(tlRunning ? await stopTaskLoop() : await startTaskLoop())
    } catch (e) {
      setTlNote(String((e as Error).message ?? e)); setTlNoteErr(true)
      fetchTaskLoopStatus(1).then(s => setTlRunning(s.state === 'running')).catch(() => {})
    } finally {
      setTlBusy(false)
    }
  }

  // 其余应用的开关仍为货架演示状态；左侧导航是否显示模块由「模块装配」页单独控制
  const toggle = (id: string) => setApps(list => list.map(a => a.id === id ? { ...a, on: !a.on } : a))

  if (open?.id === 'app-meeting') return <MeetingApp back={() => setOpen(null)} />
  if (open?.id === 'app-report') return <ReportApp back={() => setOpen(null)} />

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-800">应用中心</h1>
          <p className="text-sm text-slate-500 mt-1">8 大场景应用一键开启、按需配置 —— 应用之下是同一套图谱、记忆与规则底座</p>
        </div>
        <span className="text-xs text-slate-400">{apps.filter(a => a.on).length} / {apps.length} 已开启 · 使用人数合计 {apps.reduce((s, a) => s + a.users, 0).toLocaleString()}</span>
      </div>

      <div className="grid md:grid-cols-2 xl:grid-cols-4 gap-4">
        {apps.map(a => {
          const Icon = appIcon[a.id] || FileText
          const isTl = a.id === 'app-task-loop'
          const tlPending = tlBusy || tlRunning === null
          return (
            <div key={a.id} className={`bg-white rounded-xl border p-5 transition hover:shadow-md ${(isTl ? tlRunning : a.on) ? 'border-slate-200/80' : 'border-dashed border-slate-200 opacity-75'}`}>
              <div className="flex items-start justify-between mb-3">
                <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${iconColor[a.cat] || 'bg-slate-50 text-slate-500'}`}><Icon size={19} /></div>
                {isTl ? (
                  <button onClick={toggleTaskLoopRun} disabled={tlPending}
                    title={tlRunning ? '停用 = 停止机器人进程' : '启用 = 启动机器人进程'}
                    className={`w-10 h-[22px] rounded-full transition relative ${tlRunning ? 'bg-blue-600' : 'bg-slate-200'} ${tlPending ? 'opacity-50 cursor-wait' : ''}`}>
                    <span className={`absolute top-[3px] w-4 h-4 rounded-full bg-white shadow transition-all ${tlRunning ? 'left-[22px]' : 'left-[3px]'}`} />
                  </button>
                ) : (
                  <button onClick={() => toggle(a.id)} className={`w-10 h-[22px] rounded-full transition relative ${a.on ? 'bg-blue-600' : 'bg-slate-200'}`}>
                    <span className={`absolute top-[3px] w-4 h-4 rounded-full bg-white shadow transition-all ${a.on ? 'left-[22px]' : 'left-[3px]'}`} />
                  </button>
                )}
              </div>
              <div className="flex items-center gap-2">
                <div className="font-medium text-slate-800 text-sm">{a.name}{a.id === 'app-report' && <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-50 text-emerald-600 border border-emerald-100 align-middle">真 · doc-worker</span>}</div>
                {isTl ? (
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${tlRunning ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-100 text-slate-500'} flex items-center gap-1`}>
                    {tlPending && <Loader2 size={9} className="animate-spin" />}{tlRunning === null ? '查询中…' : tlRunning ? '机器人运行中' : '机器人已停止'}
                  </span>
                ) : (
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${a.status === '已上线' ? 'bg-emerald-50 text-emerald-600' : 'bg-amber-50 text-amber-600'}`}>{a.status}</span>
                )}
              </div>
              <p className="text-xs text-slate-400 leading-relaxed mt-1.5 mb-3 min-h-[32px]">{a.desc}</p>
              <div className="text-[11px] text-slate-400 mb-3">{a.users.toLocaleString()} 人在用 · 更新 {a.updated}</div>
              {isTl && tlNote && (
                <p className={`text-[11px] rounded-lg px-2.5 py-1.5 mb-3 ${tlNoteErr ? 'text-rose-600 bg-rose-50' : 'text-emerald-700 bg-emerald-50'}`}>{tlNote}</p>
              )}
              <div className="flex gap-2 pt-3 border-t border-slate-50">
                <button disabled={!isTl && !a.on} onClick={() => isTl ? openPage?.('task-loop') : (a.detail || a.id === 'app-report') && setOpen(a)}
                  className={`flex-1 text-xs py-1.5 rounded-lg transition ${(!isTl && !a.on) ? 'bg-slate-100 text-slate-400 cursor-not-allowed' : 'bg-blue-600 text-white hover:bg-blue-700'}`}>打开</button>
                <button disabled={!isTl && !a.on}
                  onClick={() => isTl && openPage?.('task-loop-config')}
                  className={`flex-1 text-xs py-1.5 rounded-lg border transition ${isTl || a.on ? 'border-slate-200 text-slate-600 hover:bg-slate-50 hover:border-indigo-300 hover:text-indigo-600' : 'border-slate-100 text-slate-300 cursor-not-allowed'}`}>配置</button>
              </div>
            </div>
          )
        })}
      </div>

      <div className="rounded-xl bg-gradient-to-br from-slate-800 to-slate-900 p-5 text-white flex items-center justify-between flex-wrap gap-3">
        <div>
          <div className="text-sm font-medium flex items-center gap-2"><Sparkles size={15} className="text-blue-300" />应用不是孤岛</div>
          <p className="text-xs text-slate-300 mt-1">每个应用产生的对话、审批、纪要，都回流太忆空间沉淀为记忆与规则——装得越多，系统越聪明</p>
        </div>
        <span className="text-xs text-slate-400">集成商可按客户行业裁剪上架应用</span>
      </div>
    </div>
  )
}

// ─── 会议助手应用详情 ───
function MeetingApp({ back }: { back: () => void }) {
  const [gen, setGen] = useState<Record<string, 'idle' | 'ing' | 'done'>>({})
  const [todos, setTodos] = useState(meetingDetail.todos)

  const generate = (name: string) => {
    setGen(g => ({ ...g, [name]: 'ing' }))
    setTimeout(() => setGen(g => ({ ...g, [name]: 'done' })), 1500)
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3 flex-wrap">
        <button onClick={back} className="w-8 h-8 rounded-lg border border-slate-200 bg-white flex items-center justify-center text-slate-500 hover:bg-slate-50"><ArrowLeft size={15} /></button>
        <div className="w-9 h-9 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center"><CalendarClock size={18} /></div>
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-semibold text-slate-800">会议助手</h1>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-600">已上线</span>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-500">办公效率</span>
          </div>
          <p className="text-xs text-slate-400 mt-0.5">会议全流程管理：会议列表、纪要生成与待办事项同步</p>
        </div>
        <button className="ml-auto text-sm px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 flex items-center gap-1.5"><PlusCircle size={15} />新建会议</button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {meetingDetail.stats.map(s => (
          <div key={s.label} className="bg-white rounded-xl border border-slate-200/80 p-4">
            <div className="text-xs text-slate-400">{s.label}</div>
            <div className="text-2xl font-semibold text-slate-800 mt-1">{s.value}</div>
          </div>
        ))}
      </div>

      <div className="grid lg:grid-cols-[1fr_300px] gap-4">
        <div className="bg-white rounded-xl border border-slate-200/80 overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-100 font-medium text-slate-800 text-sm">会议列表</div>
          <div className="overflow-x-auto -mx-1 px-1"><table className="w-full text-sm">
            <thead><tr className="text-xs text-slate-400 border-b border-slate-100 bg-slate-50/60">
              <th className="text-left font-medium px-5 py-2.5">会议</th>
              <th className="text-left font-medium px-3 py-2.5">时间</th>
              <th className="text-left font-medium px-3 py-2.5">参会人</th>
              <th className="text-left font-medium px-3 py-2.5">状态</th>
              <th className="text-left font-medium px-3 py-2.5">操作</th>
            </tr></thead>
            <tbody>
              {meetingDetail.meetings.map(m => (
                <tr key={m.name} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/50">
                  <td className="px-5 py-3.5 text-slate-700 font-medium">{m.name}</td>
                  <td className="px-3 py-3.5 text-xs text-slate-400">{m.time}</td>
                  <td className="px-3 py-3.5 text-xs text-slate-400 max-w-[200px] truncate">{m.people}</td>
                  <td className="px-3 py-3.5">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${m.status === '进行中' ? 'bg-blue-50 text-blue-600' : 'bg-slate-100 text-slate-500'}`}>{m.status}</span>
                  </td>
                  <td className="px-3 py-3.5">
                    {m.action && (
                      gen[m.name] === 'done'
                        ? <span className="text-xs text-emerald-600 flex items-center gap-1"><CheckCircle2 size={12} />纪要已生成，要点与待办已提取</span>
                        : gen[m.name] === 'ing'
                          ? <span className="text-xs text-blue-500 flex items-center gap-1"><Loader2 size={12} className="animate-spin" />转写分析中…</span>
                          : <button onClick={() => generate(m.name)} className="text-xs px-2.5 py-1 rounded-lg border border-blue-200 text-blue-600 hover:bg-blue-50">{m.action}</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </div>

        <div className="bg-white rounded-xl border border-slate-200/80 p-5">
          <div className="font-medium text-slate-800 text-sm mb-1">待办同步</div>
          <p className="text-[11px] text-slate-400 mb-4">纪要生成后自动提取待办，同步到责任人任务列表</p>
          <div className="space-y-3">
            {todos.map((t, i) => (
              <button key={i} onClick={() => setTodos(list => list.map((x, j) => j === i ? { ...x, done: !x.done } : x))}
                className="w-full text-left flex items-start gap-2.5 group">
                {t.done ? <CheckCircle2 size={16} className="text-emerald-500 mt-0.5 shrink-0" /> : <Clock size={16} className="text-amber-500 mt-0.5 shrink-0" />}
                <div>
                  <div className={`text-xs leading-relaxed ${t.done ? 'text-slate-400 line-through' : 'text-slate-700'}`}>{t.text}</div>
                  <div className="text-[10px] text-slate-300 mt-0.5">来自：{t.from}</div>
                </div>
              </button>
            ))}
          </div>
          <div className="mt-4 pt-4 border-t border-slate-50 text-[11px] text-slate-400 leading-relaxed">
            已完成的待办与会议纪要，自动沉淀至太忆空间 L3 日报周报层
          </div>
        </div>
      </div>
    </div>
  )
}


// ── 报告中心（真）：D3 @action/doc-worker，结构化块 → 服务端 docx 下载 ──

/** 文本行 → 文档块："# " 标题 / "- " 项目符号 / 其余段落 */
function parseBlocks(text: string): DocBlock[] {
  const blocks: DocBlock[] = []
  let bullets: string[] = []
  const flush = () => { if (bullets.length) { blocks.push({ type: 'bullets', items: bullets }); bullets = [] } }
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) { flush(); continue }
    if (line.startsWith('- ')) { bullets.push(line.slice(2)); continue }
    flush()
    if (line.startsWith('# ')) blocks.push({ type: 'heading', text: line.slice(2), level: 2 })
    else blocks.push({ type: 'paragraph', text: line })
  }
  flush()
  return blocks
}

function ReportApp({ back }: { back: () => void }) {
  const [title, setTitle] = useState('周运行报告')
  const [subtitle, setSubtitle] = useState('Aigility 智悦智能平台 · 文档工人自动生成')
  const [templates, setTemplates] = useState<ReportTemplate[]>([])
  const [activeTpl, setActiveTpl] = useState('')
  const [content, setContent] = useState(
    '# 一、运行摘要\n本周平台对话与 MCP 工具调用运行正常。\n- 数字员工对话链路全通\n- MCP 工具总线 13 个工具可用\n\n# 二、下一步\n- 挂载更多客户系统工具\n- 审批沉淀规则入库')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState('')

  const loadTpl = () => { fetchReportTemplates().then(setTemplates).catch(() => {}) }
  useEffect(() => { loadTpl() }, [])
  const applyTpl = (name: string) => {
    const t = templates.find(x => x.name === name)
    if (!t) return
    setActiveTpl(name); setTitle(t.title); setSubtitle(t.subtitle); setContent(t.content)
  }
  const saveTpl = async () => {
    if (!title.trim()) return
    const existing = templates.find(x => x.name === title.trim())
    await saveReportTemplate({ name: title.trim(), title: title.trim(), subtitle, content }, existing?.rowId)
    loadTpl()
  }
  const delTpl = async (name: string) => {
    const t = templates.find(x => x.name === name)
    if (t?.rowId) await deleteReportTemplate(t.rowId)
    if (activeTpl === name) setActiveTpl('')
    loadTpl()
  }

  const gen = async () => {
    if (busy || !title.trim()) return
    setBusy(true); setError(''); setDone('')
    try {
      const r = await generateDoc({ title: title.trim(), subtitle: subtitle.trim(), blocks: parseBlocks(content) })
      setDone(`已生成 ${r.filename}（${(r.bytes / 1024).toFixed(1)} KB）并开始下载`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3 flex-wrap">
        <button onClick={back} className="w-8 h-8 rounded-lg border border-slate-200 bg-white flex items-center justify-center text-slate-500 hover:bg-slate-50"><ArrowLeft size={15} /></button>
        <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-amber-500 to-orange-500 text-white flex items-center justify-center"><FileBarChart size={17} /></div>
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-semibold text-slate-800">报告中心</h1>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-600">真 · D3 @action/doc-worker</span>
          </div>
          <p className="text-xs text-slate-400 mt-0.5">结构化块 → 服务端确定性渲染 docx（非 LLM 生成文件内容），base64 回传下载</p>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-slate-200/80 p-6 space-y-4 max-w-3xl">
        {/* 模板库（真存储 · /app/data JSONB） */}
        <div className="rounded-lg border border-slate-100 bg-slate-50/60 p-3 flex items-center gap-2 flex-wrap">
          <span className="text-xs text-slate-500 flex items-center gap-1"><FolderOpen size={13} className="text-slate-400" />模板库
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-50 text-emerald-600 border border-emerald-100">真 · /app/data</span>
          </span>
          <select value={activeTpl} onChange={e => applyTpl(e.target.value)}
            className="text-xs border border-slate-200 rounded-lg px-2 py-1.5 bg-white">
            <option value="">选择模板套用…</option>
            {templates.map(t => <option key={t.rowId ?? t.name} value={t.name}>{t.name}</option>)}
          </select>
          <button onClick={() => void saveTpl()} disabled={!title.trim()} className="text-xs px-2.5 py-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-50">另存为模板</button>
          {activeTpl && <button onClick={() => void delTpl(activeTpl)} className="text-xs px-2.5 py-1.5 rounded-lg border border-red-200 text-red-500 hover:bg-red-50">删除</button>}
        </div>
        <div className="grid md:grid-cols-2 gap-4">
          <div>
            <label className="text-xs text-slate-400 block mb-1">报告标题 *</label>
            <input value={title} onChange={e => setTitle(e.target.value)}
              className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-100" />
          </div>
          <div>
            <label className="text-xs text-slate-400 block mb-1">副标题</label>
            <input value={subtitle} onChange={e => setSubtitle(e.target.value)}
              className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-100" />
          </div>
        </div>
        <div>
          <label className="text-xs text-slate-400 block mb-1.5">正文块（每行一块：# 小标题 / - 项目符号 / 其余为段落）</label>
          <textarea value={content} onChange={e => setContent(e.target.value)} rows={10}
            className="w-full text-xs font-mono border border-slate-200 rounded-lg px-3 py-2.5 leading-relaxed focus:outline-none focus:ring-2 focus:ring-blue-100" />
        </div>
        {error && <div className="text-xs text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{error}</div>}
        {done && <div className="text-xs text-emerald-600 bg-emerald-50 border border-emerald-100 rounded-lg px-3 py-2 flex items-center gap-1.5"><CheckCircle2 size={13} />{done}</div>}
        <button onClick={() => void gen()} disabled={busy || !title.trim()}
          className="text-sm px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1.5">
          {busy ? <Loader2 size={14} className="animate-spin" /> : <FileText size={14} />}{busy ? '生成中…' : '生成 .docx 并下载'}
        </button>
      </div>
    </div>
  )
}
