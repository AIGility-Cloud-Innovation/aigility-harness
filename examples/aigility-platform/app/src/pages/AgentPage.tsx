import { useEffect, useRef, useState } from 'react'
import { chatScripts, mcpTools, type ChatScript, type Skill } from '../mock/data'
import FlowCanvas from '../components/FlowCanvas'
import { getCurrentUser } from '../lib/api'
import { streamAigilityChat, fetchRegistry, type SkillInfo } from '../lib/harness'
import { Bot, Send, Wrench, CheckCircle2, Clock, User, Sparkles, Plug, PlusCircle, ChevronRight, Loader2, ShieldCheck, Play, Bug, History, Rocket, Radio } from 'lucide-react'

interface Msg {
  role: 'user' | 'agent'
  script?: ChatScript
  phase?: number // 0 tools.. answer.. task
  text?: string
  /** 真网关消息：数字员工名 / 流式中 / 失败 */
  liveName?: string
  streaming?: boolean
  error?: boolean
}

export default function AgentPage({ skillList }: { skillList: Skill[] }) {
  const [tab, setTab] = useState<'chat' | 'mcp' | 'skill'>('chat')
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [running, setRunning] = useState(false)
  const [ctx, setCtx] = useState<ChatScript | null>(null)
  const [approved, setApproved] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const timeouts = useRef<ReturnType<typeof setTimeout>[]>([])
  const sessionId = useRef(`zy-${Date.now().toString(36)}`)

  // ── 真网关对话（aigility-harness 五域链路）──
  const [draft, setDraft] = useState('')
  const [liveBusy, setLiveBusy] = useState(false)
  const [gwLlm, setGwLlm] = useState<string | null>(null) // null = 网关未接入
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [activeSkillId, setActiveSkillId] = useState('') // '' = 平台管家

  useEffect(() => () => timeouts.current.forEach(clearTimeout), [])
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [msgs])
  useEffect(() => {
    fetchRegistry()
      .then(r => { setGwLlm(r.llm); setSkills(r.skills) })
      .catch(() => setGwLlm(null))
  }, [])

  const activeSkill = skills.find(s => s.id === activeSkillId)
  const activeName = activeSkill ? activeSkill.name : 'Aigility 平台管家'

  const sendLive = async () => {
    const q = draft.trim()
    if (!q || running || liveBusy) return
    setDraft('')
    setRunning(true); setLiveBusy(true); setApproved(false); setCtx(null)
    setMsgs(m => [...m, { role: 'user', text: q }, { role: 'agent', text: '', streaming: true, liveName: activeName }])
    // 历史取最近的真对话消息（演示脚本不入上下文）
    const history = msgs.filter(m => !m.script && m.text && !m.error).slice(-6).map(m => ({
      role: (m.role === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
      content: m.text!,
    }))
    try {
      const full = await streamAigilityChat({
        user_input: q,
        ...(activeSkillId ? { skill_id: activeSkillId } : {}),
        session_id: sessionId.current,
        user_key: getCurrentUser()?.email ?? 'fde-local',
        history,
      }, full => {
        setMsgs(m => m.map((x, i) => i === m.length - 1 ? { ...x, text: full } : x))
      })
      setMsgs(m => m.map((x, i) => i === m.length - 1 ? { ...x, text: full, streaming: false } : x))
    } catch (e) {
      setMsgs(m => m.map((x, i) => i === m.length - 1
        ? { ...x, text: `对话调用失败：${e instanceof Error ? e.message : String(e)}`, streaming: false, error: true }
        : x))
    } finally {
      setRunning(false); setLiveBusy(false)
    }
  }

  const ask = (s: ChatScript) => {
    if (running) return
    setRunning(true)
    setApproved(false)
    setCtx(null)
    setMsgs(m => [...m, { role: 'user', text: s.question }, { role: 'agent', script: s, phase: 0 }])
    const later = (fn: () => void, ms: number) => timeouts.current.push(setTimeout(fn, ms))
    s.toolCalls.forEach((_, i) => later(() => setMsgs(m => m.map((x, j) => j === m.length - 1 ? { ...x, phase: i + 1 } : x)), 700 * (i + 1)))
    const base = 700 * (s.toolCalls.length + 1)
    later(() => setMsgs(m => m.map((x, j) => j === m.length - 1 ? { ...x, phase: 98 } : x)), base)
    later(() => {
      setMsgs(m => m.map((x, j) => j === m.length - 1 ? { ...x, phase: 99 } : x))
      setCtx(s)
      setRunning(false)
    }, base + 800)
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-800">数字员工工作台</h1>
          <p className="text-sm text-slate-500 mt-1">真对话走 aigility-harness 五域链路（http-ingress → persona → workflow-engine → LLM）· 演示场景走 Mock 脚本</p>
        </div>
        <div className="flex items-center gap-3">
          {gwLlm !== null && (
            <span className="text-xs px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-600 border border-emerald-100 flex items-center gap-1.5">
              <Radio size={11} />网关已接入 · LLM {gwLlm}
            </span>
          )}
          <div className="flex bg-slate-100 rounded-lg p-1">
            {[['chat', '对话工作台'], ['mcp', 'MCP 工具'], ['skill', 'Skill 编排']].map(([k, l]) => (
              <button key={k} onClick={() => setTab(k as any)}
                className={`text-sm px-4 py-1.5 rounded-md transition ${tab === k ? 'bg-white text-slate-800 shadow-sm font-medium' : 'text-slate-500'}`}>{l}</button>
            ))}
          </div>
        </div>
      </div>

      {tab === 'chat' && (
        <div className="grid lg:grid-cols-[1fr_300px] gap-4">
          {/* 对话区 */}
          <div className="bg-white rounded-xl border border-slate-200/80 flex flex-col h-[70vh] lg:h-[620px]">
            <div className="flex-1 overflow-y-auto p-5 space-y-5">
              {msgs.length === 0 && (
                <div className="pt-10 text-center">
                  <div className="w-14 h-14 rounded-2xl bg-blue-600 text-white flex items-center justify-center mx-auto mb-4"><Bot size={26} /></div>
                  <h3 className="font-semibold text-slate-800">数字员工已接入 aigility-harness 引擎</h3>
                  <p className="text-sm text-slate-400 mt-1 mb-2">选择下方演示场景体验完整执行链路，或直接输入与数字员工真实对话</p>
                  <p className="text-[11px] text-slate-400 mb-6">真对话按所选数字员工装配人设并隔离记忆（TiMEM 召回 → LLM → 沉淀）</p>
                  <div className="grid gap-2 max-w-lg mx-auto">
                    {chatScripts.map((s, i) => (
                      <button key={i} onClick={() => ask(s)} className="text-left text-sm px-4 py-3 rounded-xl border border-slate-200 hover:border-blue-300 hover:bg-blue-50/40 transition flex items-center justify-between gap-2">
                        <span className="text-slate-700">{s.question}</span>
                        <span className="text-xs text-blue-500 whitespace-nowrap flex items-center gap-1"><Sparkles size={12} />{s.skill}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {msgs.map((m, i) => m.role === 'user' ? (
                <div key={i} className="flex justify-end">
                  <div className="bg-blue-600 text-white text-sm rounded-2xl rounded-tr-sm px-4 py-2.5 max-w-[75%]">{m.text}</div>
                </div>
              ) : m.script ? (
                <div key={i} className="flex gap-3">
                  <div className="w-8 h-8 rounded-lg bg-blue-600 text-white flex items-center justify-center shrink-0 mt-0.5"><Bot size={16} /></div>
                  <div className="flex-1 space-y-3 max-w-[85%]">
                    <div className="text-xs text-slate-400">数字员工 · {m.script.skill} <span className="ml-1 px-1.5 py-0.5 rounded bg-slate-100 text-slate-400">演示脚本</span></div>
                    {/* 工具调用 */}
                    {m.script!.toolCalls.slice(0, Math.min(m.phase!, m.script!.toolCalls.length)).map((t, j) => (
                      <div key={j} className="flex items-center gap-2 text-xs bg-slate-50 border border-slate-100 rounded-lg px-3 py-2 text-slate-600" style={{ animation: 'fadeSlide .3s ease' }}>
                        {m.phase! > j + 1 || m.phase! >= 98 ? <CheckCircle2 size={13} className="text-emerald-500" /> : <Loader2 size={13} className="text-blue-500 animate-spin" />}
                        <Wrench size={12} className="text-slate-400" />
                        <code className="text-blue-600">{t.tool}</code>
                        <span className="text-slate-400">{t.detail}</span>
                      </div>
                    ))}
                    {m.phase! < 98 && m.phase! >= 0 && <div className="text-xs text-blue-500 animate-pulse pl-1">正在调用工具…</div>}
                    {/* 回答 */}
                    {m.phase! >= 98 && (
                      <div className="text-sm text-slate-700 leading-relaxed bg-slate-50/80 border border-slate-100 rounded-xl px-4 py-3 whitespace-pre-wrap" style={{ animation: 'fadeSlide .3s ease' }}>{m.script!.answer}</div>
                    )}
                    {/* 长程任务 */}
                    {m.phase! >= 99 && m.script!.task && (
                      <div className="border border-blue-100 bg-blue-50/40 rounded-xl p-4" style={{ animation: 'fadeSlide .3s ease' }}>
                        <div className="text-xs font-medium text-blue-700 mb-3">{m.script!.task.title}</div>
                        <div className="space-y-2">
                          {m.script!.task.steps.map((st, j) => (
                            <div key={j} className="flex items-center gap-2 text-xs">
                              {st.status === 'done' ? <CheckCircle2 size={14} className="text-emerald-500" /> : approved ? <CheckCircle2 size={14} className="text-emerald-500" /> : <Clock size={14} className="text-amber-500" />}
                              <span className={st.status === 'done' || approved ? 'text-slate-600' : 'text-amber-600 font-medium'}>{st.name}</span>
                            </div>
                          ))}
                        </div>
                        {!approved && (
                          <div className="flex gap-2 mt-4">
                            <button onClick={() => setApproved(true)} className="text-xs px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 flex items-center gap-1"><ShieldCheck size={12} />审阅通过并归档</button>
                            <button className="text-xs px-3 py-1.5 rounded-lg border border-slate-300 text-slate-600 hover:bg-white">提出修改</button>
                          </div>
                        )}
                        {approved && <div className="text-xs text-emerald-600 mt-3 flex items-center gap-1"><CheckCircle2 size={12} />已归档，审批轨迹已沉淀至太忆空间规则库</div>}
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                /* 真网关消息：流式文本 */
                <div key={i} className="flex gap-3">
                  <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-sky-500 text-white flex items-center justify-center shrink-0 mt-0.5"><Bot size={16} /></div>
                  <div className="flex-1 space-y-2 max-w-[85%]">
                    <div className="text-xs text-slate-400">{m.liveName} · <span className="text-emerald-500">aigility-harness 真对话</span></div>
                    <div className={`text-sm leading-relaxed rounded-xl px-4 py-3 whitespace-pre-wrap border ${m.error ? 'text-red-600 bg-red-50/60 border-red-100' : 'text-slate-700 bg-slate-50/80 border-slate-100'}`}>
                      {m.text || (m.streaming ? <span className="text-slate-400 animate-pulse">数字员工思考中…</span> : '')}
                      {m.streaming && m.text && <span className="inline-block w-1.5 h-4 bg-blue-500 animate-pulse align-middle ml-0.5" />}
                    </div>
                  </div>
                </div>
              ))}
              <div ref={bottomRef} />
            </div>

            {/* 输入区 */}
            <div className="border-t border-slate-100 p-4">
              <div className="flex flex-wrap gap-2 mb-3 items-center">
                <span className="text-[11px] text-slate-400 mr-1">对话身份：</span>
                <button disabled={running} onClick={() => setActiveSkillId('')}
                  className={`text-xs px-3 py-1.5 rounded-full transition disabled:opacity-40 ${activeSkillId === '' ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-blue-50 hover:text-blue-600'}`}>@平台管家</button>
                {skills.map(s => (
                  <button key={s.id} disabled={running} onClick={() => setActiveSkillId(s.id)}
                    className={`text-xs px-3 py-1.5 rounded-full transition disabled:opacity-40 ${activeSkillId === s.id ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-blue-50 hover:text-blue-600'}`}>@{s.name}</button>
                ))}
                {chatScripts.map((s, i) => (
                  <button key={i} disabled={running} onClick={() => ask(s)} className="text-xs px-3 py-1.5 rounded-full bg-white border border-dashed border-slate-200 text-slate-400 hover:text-blue-600 hover:border-blue-300 transition disabled:opacity-40">@{s.skill}</button>
                ))}
              </div>
              <div className="flex gap-2">
                <input value={draft} onChange={e => setDraft(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) void sendLive() }}
                  placeholder={running ? '数字员工执行中…' : gwLlm !== null ? `向 ${activeName} 提问（真对话 · Enter 发送）…` : '网关未接入（无网关注入），仅可运行演示场景'}
                  disabled={running}
                  className="flex-1 text-sm border border-slate-200 rounded-lg px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-300 disabled:bg-slate-50" />
                <button disabled={running || !draft.trim() || gwLlm === null} onClick={() => void sendLive()}
                  title={gwLlm === null ? '网关未接入' : '发送'}
                  className="px-4 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40"><Send size={16} /></button>
              </div>
            </div>
          </div>

          {/* 上下文面板 */}
          <div className="space-y-4">
            <div className="bg-white rounded-xl border border-slate-200/80 p-5">
              <h4 className="text-sm font-medium text-slate-800 mb-3">当前数字员工</h4>
              <div className="rounded-lg border border-slate-100 bg-slate-50/60 p-3 space-y-1.5">
                <div className="text-xs font-medium text-slate-700 flex items-center gap-1.5"><Bot size={12} className="text-blue-500" />{activeName}</div>
                <div className="text-[11px] text-slate-400 leading-relaxed">
                  {activeSkill
                    ? <>智能体工厂发布 · skill_id=<code className="text-blue-500">{activeSkill.id}</code><br />{activeSkill.description}</>
                    : <>平台默认管家，介绍 Aigility（智悦）平台与 aigility-harness 引擎的封装关系；工厂发布技能后可在此切换。</>}
                </div>
                {activeSkill && activeSkill.tools.length > 0 && (
                  <div className="flex flex-wrap gap-1 pt-1">
                    {activeSkill.tools.map(t => <code key={t} className="text-[10px] px-1.5 py-0.5 rounded bg-sky-50 text-sky-600">{t}</code>)}
                  </div>
                )}
              </div>
              <p className="text-[11px] text-slate-400 mt-3 leading-relaxed">链路：POST /api/aigility-chat → @persona/aigility-agent → workflow-engine（记忆召回 → LLM → 沉淀）</p>
            </div>
            <div className="bg-white rounded-xl border border-slate-200/80 p-5">
              <h4 className="text-sm font-medium text-slate-800 mb-3">执行上下文</h4>
              {!ctx ? <p className="text-xs text-slate-400 leading-relaxed">演示场景执行时，这里实时展示引用的图谱实体、命中的规则与写入的记忆。</p> : (
                <div className="space-y-4">
                  <div>
                    <div className="text-xs text-slate-400 mb-1.5">引用实体</div>
                    <div className="flex flex-wrap gap-1.5">{ctx.context.entities.map(e => <span key={e} className="text-xs bg-blue-50 text-blue-600 px-2 py-1 rounded-md">{e}</span>)}</div>
                  </div>
                  <div>
                    <div className="text-xs text-slate-400 mb-1.5">命中规则</div>
                    <div className="flex flex-wrap gap-1.5">{ctx.context.rules.map(r => <span key={r} className="text-xs bg-emerald-50 text-emerald-600 px-2 py-1 rounded-md">{r}</span>)}</div>
                  </div>
                  <div>
                    <div className="text-xs text-slate-400 mb-1.5">记忆写入</div>
                    <div className="text-xs bg-amber-50 text-amber-700 px-2.5 py-2 rounded-md">{ctx.context.memory}</div>
                  </div>
                </div>
              )}
            </div>
            <div className="bg-white rounded-xl border border-slate-200/80 p-5">
              <h4 className="text-sm font-medium text-slate-800 mb-3">人在回路 · 三档协作</h4>
              <div className="space-y-2.5">
                {[
                  { l: '低风险 · 自动执行', d: '查数、汇总、生成草稿', c: 'bg-emerald-50 text-emerald-600 border-emerald-100' },
                  { l: '中风险 · 建议待批', d: '派发工单、对外发文', c: 'bg-amber-50 text-amber-600 border-amber-100' },
                  { l: '高风险 · 仅作参考', d: '停机等不可逆操作', c: 'bg-red-50 text-red-600 border-red-100' },
                ].map(x => (
                  <div key={x.l} className={`text-xs rounded-lg border px-3 py-2 ${x.c}`}>
                    <span className="font-medium">{x.l}</span>
                    <span className="opacity-70 ml-1.5">{x.d}</span>
                  </div>
                ))}
              </div>
              <p className="text-[11px] text-slate-400 mt-3 leading-relaxed">置信度低于阈值自动升级一档；审批轨迹沉淀为规则</p>
            </div>
            <div className="bg-gradient-to-br from-slate-800 to-slate-900 rounded-xl p-5 text-white">
              <div className="flex items-center gap-2 mb-2"><Plug size={15} className="text-blue-300" /><span className="text-sm font-medium">MCP 执行链路</span></div>
              <p className="text-xs text-slate-300 leading-relaxed">对话 → TiMEM 记忆检索 → 规则匹配 → 客户系统 API（DCS / SCADA / CRM）→ 生成结果 → 人审 → 沉淀记忆与规则</p>
            </div>
          </div>
        </div>
      )}

      {tab === 'mcp' && (
        <div className="space-y-4">
          <div className="bg-white rounded-xl border border-slate-200/80 p-5 flex items-center justify-between flex-wrap gap-3">
            <div>
              <h3 className="font-medium text-slate-800">MCP 工具总线</h3>
              <p className="text-xs text-slate-400 mt-1">太忆底层能力开箱即用；把客户系统 API 封装成 MCP 工具，数字员工即可调用</p>
            </div>
            <button className="text-sm px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 flex items-center gap-1.5"><PlusCircle size={15} />封装新 API 为 MCP 工具</button>
          </div>
          <div className="grid md:grid-cols-2 gap-4">
            {mcpTools.map(t => (
              <div key={t.name} className="bg-white rounded-xl border border-slate-200/80 p-5 hover:shadow-md transition">
                <div className="flex items-start justify-between mb-2">
                  <code className="text-sm font-semibold text-blue-700">{t.name}</code>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${t.status === '已连接' ? 'bg-emerald-50 text-emerald-600' : 'bg-amber-50 text-amber-600'}`}>{t.status}</span>
                </div>
                <p className="text-xs text-slate-500 leading-relaxed mb-3">{t.desc}</p>
                <div className="flex items-center justify-between text-xs text-slate-400">
                  <span>{t.source}</span>
                  <span className={`px-2 py-0.5 rounded ${t.type === '太忆内置' ? 'bg-blue-50 text-blue-600' : 'bg-sky-50 text-sky-600'}`}>{t.type}</span>
                </div>
                <div className="text-xs text-slate-400 mt-2 pt-2 border-t border-slate-50">累计调用 {t.calls} 次</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === 'skill' && <SkillPanel skillList={skillList} skills={skills} />}
      <style>{`@keyframes fadeSlide { from { opacity: 0; transform: translateY(4px);} to { opacity: 1; transform: none; } }`}</style>
    </div>
  )
}

function SkillPanel({ skillList, skills }: { skillList: Skill[]; skills: SkillInfo[] }) {
  const [creating, setCreating] = useState(false)
  const [published, setPublished] = useState(false)
  const [name, setName] = useState('设备巡检管家')
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <p className="text-sm text-slate-500">Skill = 提示词封装 + 图谱上下文 + MCP 工具组合 + 人在回路节点，可跨项目复用</p>
        <button onClick={() => { setCreating(!creating); setPublished(false) }} className="text-sm px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 flex items-center gap-1.5">
          <PlusCircle size={15} />{creating ? '收起创建器' : '创建 Skill'}
        </button>
      </div>

      {creating && (
        <div className="bg-white rounded-xl border border-blue-200 p-5 space-y-4" style={{ animation: 'fadeSlide .3s ease' }}>
          <h3 className="font-medium text-slate-800">Skill 创建器</h3>
          <div className="grid md:grid-cols-2 gap-4">
            <div>
              <label className="text-xs text-slate-400 block mb-1">Skill 名称</label>
              <input value={name} onChange={e => setName(e.target.value)} className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-100" />
            </div>
            <div>
              <label className="text-xs text-slate-400 block mb-1">数字员工角色</label>
              <select className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 bg-white"><option>设备工程师的数字同事</option><option>值长助手</option><option>家装设计师助手</option><option>门店经理助手</option></select>
            </div>
            <div>
              <label className="text-xs text-slate-400 block mb-1">上下文范围（太忆空间）</label>
              <div className="flex gap-2 flex-wrap">{['记忆流', '规则库', '知识库', '图谱实体'].map(x => <span key={x} className="text-xs px-2.5 py-1.5 rounded-lg bg-blue-50 text-blue-600 border border-blue-100">{x} ✓</span>)}</div>
            </div>
            <div>
              <label className="text-xs text-slate-400 block mb-1">MCP 工具组合</label>
              <div className="flex gap-2 flex-wrap">{['scada.device.list', 'timem.rule.match', 'timem.memory.search'].map(x => <code key={x} className="text-xs px-2.5 py-1.5 rounded-lg bg-sky-50 text-sky-600 border border-sky-100">{x}</code>)}</div>
            </div>
          </div>
          <div>
            <label className="text-xs text-slate-400 block mb-2">执行步骤编排</label>
            <div className="flex items-center gap-2 flex-wrap">
              {['读取设备台账', '比对保养周期', '生成巡检工单', '人审后派发'].map((s, i, arr) => (
                <span key={s} className="flex items-center gap-2">
                  <span className={`text-xs px-3 py-2 rounded-lg border ${s.includes('人审') ? 'border-amber-300 bg-amber-50 text-amber-700' : 'border-slate-200 bg-slate-50 text-slate-600'}`}>{s}</span>
                  {i < arr.length - 1 && <ChevronRight size={14} className="text-slate-300" />}
                </span>
              ))}
            </div>
          </div>
          <div>
            <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
              <label className="text-xs text-slate-400">编排画布 · 低代码 DAG</label>
              <div className="flex gap-1.5 flex-wrap">
                {['开始', '模型', '知识库', '工具', '条件', '输出'].map(n => (
                  <span key={n} className="text-[10px] px-2 py-1 rounded border border-dashed border-slate-300 text-slate-500 cursor-grab hover:border-blue-300 hover:text-blue-600">+ {n}</span>
                ))}
              </div>
            </div>
            <FlowCanvas />
            <div className="flex items-center justify-between mt-3 flex-wrap gap-2">
              <div className="flex gap-2">
                {[['单步调试', Play], ['断点回放', History], ['灰度发布', Rocket]].map(([l, I]: any) => (
                  <button key={l} className="text-xs px-3 py-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 flex items-center gap-1"><I size={12} />{l}</button>
                ))}
              </div>
              <div className="text-[11px] text-slate-400 flex items-center gap-1"><Bug size={11} />执行路径：开始 → 知识库检索 → 大模型推理 → 置信度 0.91 ≥ 0.85 → 输出</div>
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={() => setPublished(true)} className="text-sm px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700">试运行并发布</button>
            <button className="text-sm px-4 py-2 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50">保存草稿</button>
          </div>
          {published && (
            <div className="space-y-1">
              <div className="text-xs text-emerald-600 flex items-center gap-1"><CheckCircle2 size={13} />「{name}」试运行通过（演示模式）</div>
              <div className="text-[11px] text-slate-400">完整发布请到「智能体工厂」，发布后即在对话工作台的对话身份中出现</div>
            </div>
          )}
        </div>
      )}

      <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
        {skills.map(s => (
          <div key={s.id} className="bg-white rounded-xl border border-sky-300 ring-1 ring-sky-100 p-5">
            <div className="flex items-start justify-between mb-2">
              <div className="font-medium text-slate-800">{s.name}</div>
              <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-600">已发布 · 真对话</span>
            </div>
            <p className="text-xs text-slate-500 mb-3">智能体工厂发布 · skill_id={s.id}</p>
            <p className="text-xs text-slate-500 leading-relaxed mb-3">{s.description}</p>
            <div className="text-[11px] text-slate-400 pt-3 border-t border-slate-50">对话工作台输入区可直接切换 @{s.name}</div>
          </div>
        ))}
        {skillList.map(s => (
          <div key={s.id} className={`bg-white rounded-xl border p-5 hover:shadow-md transition ${s.id.startsWith('gen-') ? 'border-sky-300 ring-1 ring-sky-100' : 'border-slate-200/80'}`}>
            <div className="flex items-start justify-between mb-2">
              <div className="font-medium text-slate-800">{s.name}</div>
              <span className={`text-xs px-2 py-0.5 rounded-full ${s.status === '已发布' ? 'bg-emerald-50 text-emerald-600' : s.status === '试运行' ? 'bg-amber-50 text-amber-600' : 'bg-slate-100 text-slate-500'}`}>{s.status}</span>
            </div>
            <p className="text-xs text-slate-500 mb-3">{s.role} · 来源：{s.from}</p>
            <div className="space-y-1.5 mb-3">
              {s.steps.map((st, i) => (
                <div key={i} className="flex items-center gap-2 text-xs text-slate-500">
                  <span className="w-4 h-4 rounded-full bg-slate-100 text-slate-400 flex items-center justify-center text-[10px]">{i + 1}</span>{st}
                </div>
              ))}
            </div>
            <div className="flex items-center justify-between text-xs text-slate-400 pt-3 border-t border-slate-50">
              <span className="truncate mr-2">上下文：{s.scope}</span>
              <span className="whitespace-nowrap flex items-center gap-1"><User size={11} />{s.usage} 次</span>
            </div>
          </div>
        ))}
      </div>
      <style>{`@keyframes fadeSlide { from { opacity: 0; transform: translateY(4px);} to { opacity: 1; transform: none; } }`}</style>
    </div>
  )
}
