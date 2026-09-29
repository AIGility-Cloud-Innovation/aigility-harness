import { useEffect, useRef, useState } from 'react'
import { studioSteps, studioSeed, models, knowledgeBases, mcpTools, pluginTools, agentCats, type StudioAgent } from '../mock/data'
import FlowCanvas from '../components/FlowCanvas'
import { publishSkill, deleteSkill, fetchRegistry, createDshSkill, fetchRoles } from '../lib/harness'
import { Plus, Bot, ChevronLeft, ChevronRight, Save, Rocket, FlaskConical, Trash2, PenLine, CheckCircle2, Loader2, Circle, Store, SearchX, Loader } from 'lucide-react'

const blank: Omit<StudioAgent, 'id' | 'status' | 'updatedAt'> = {
  name: '', category: '知识服务', description: '', tags: [],
  modelId: 'kimi-k3', prompt: '', temperature: 0.3, knowledge: [], tools: [],
  visibility: '企业内', releaseNote: '',
}

/** 列表条目 = 服务端真注册（factory）+ 本地演示种子（demo） */
type Listed = StudioAgent & { src: 'factory' | 'demo' }

const demoSeed: Listed[] = studioSeed.map(a => ({ ...a, src: 'demo' }))

export default function StudioPage() {
  const [view, setView] = useState<'list' | 'create'>('list')
  const [agents, setAgents] = useState<Listed[]>(demoSeed)
  const [filter, setFilter] = useState<'全部' | '已发布' | '草稿'>('全部')
  const [step, setStep] = useState(0)
  const [form, setForm] = useState(blank)
  const [editId, setEditId] = useState<string | null>(null)
  const [tagInput, setTagInput] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [banner, setBanner] = useState('')
  const [pubBusy, setPubBusy] = useState(false)
  const [pubError, setPubError] = useState('')
  const [running, setRunning] = useState(false)
  const [runLog, setRunLog] = useState<{ text: string; done: boolean }[]>([])
  const timeouts = useRef<ReturnType<typeof setTimeout>[]>([])
  // DSH 渠道同步（发布时一并注册为 DSH 技能，飞书 zcode 热生效）
  const [dshSync, setDshSync] = useState(false)
  const [dshRole, setDshRole] = useState('')
  const [dshRoles, setDshRoles] = useState<string[]>([])
  useEffect(() => { fetchRoles().then(r => setDshRoles(Object.keys(r.roles))).catch(() => {}) }, [])

  const refresh = () => {
    fetchRegistry().then(r => {
      const fromServer: Listed[] = r.skills.map(s => ({ ...s, visibility: s.visibility as StudioAgent['visibility'], src: 'factory' }))
      setAgents([...fromServer, ...demoSeed])
    }).catch(() => {})
  }
  useEffect(() => { refresh() }, [])

  const today = () => new Date().toISOString().slice(0, 10)
  const set = (k: string, v: any) => { setForm(f => ({ ...f, [k]: v })); setErrors(e => ({ ...e, [k]: '' })) }

  const validate = (s: number) => {
    const e: Record<string, string> = {}
    if (s === 0) {
      if (!form.name.trim()) e.name = '请填写智能体名称'
      if (!form.description.trim()) e.description = '请填写能力描述'
    }
    if (s === 1 && !form.prompt.trim()) e.prompt = '请填写角色 Prompt'
    setErrors(e)
    return Object.keys(e).length === 0
  }

  const next = () => { if (validate(step)) setStep(s => Math.min(s + 1, studioSteps.length - 1)) }

  const saveDraft = () => {
    if (!form.name.trim()) { setErrors({ name: '草稿至少需要名称' }); setStep(0); return }
    setAgents(list => [{ ...form, id: `st-${Date.now()}`, status: '草稿', updatedAt: today(), src: 'demo' }, ...list])
    setBanner(`草稿「${form.name}」已保存（本地演示草稿；正式发布请走「发布到智能体市场」）`)
    setView('list'); setForm(blank); setStep(0); setEditId(null)
  }

  /** 发布 → 服务端 skill-registry 真注册（data/aigility-skills.json），立即可对话 */
  const publish = async () => {
    if (!validate(0) || !validate(1)) return
    setPubBusy(true); setPubError('')
    try {
      const skill = await publishSkill({
        ...(editId ? { id: editId } : {}),
        name: form.name,
        category: form.category,
        description: form.description,
        tags: form.tags,
        modelId: form.modelId,
        prompt: form.prompt,
        temperature: form.temperature,
        knowledge: form.knowledge,
        tools: form.tools,
        visibility: form.visibility,
        releaseNote: form.releaseNote,
      })
      setBanner(`「${skill.name}」发布成功（skill_id=${skill.id}，已注册 @persona/aigility-agent）—— 对话工作台与智能体市场立即可用`)
      if (dshSync) {
        try {
          const r = await createDshSkill({
            name: form.name,
            description: form.description,
            prompt: form.prompt,
            attachRole: dshRole || undefined,
          })
          setBanner(b => `${b}；已同步 DSH 技能「${r.skill.dir}」${r.attached ? `并挂到角色 ${r.attached}` : ''}（飞书 zcode 热生效）`)
        } catch (e) {
          setPubError(`平台发布成功，但 DSH 同步失败：${e instanceof Error ? e.message : String(e)}`)
        }
      }
      setView('list'); setForm(blank); setStep(0); setEditId(null)
      refresh()
    } catch (e) {
      setPubError(e instanceof Error ? e.message : String(e))
    } finally {
      setPubBusy(false)
    }
  }

  const testRun = () => {
    if (running) return
    setRunning(true); setRunLog([])
    const lines = [
      '正在理解任务意图……',
      `调用知识库检索（${form.knowledge[0] || '通用办公知识库'}）……命中 3 个分片`,
      `调用工具 ${form.tools[0] || 'timem.memory.search'}……返回 5 条记忆`,
      '大模型推理中……',
      '生成回答。置信度 0.91 ≥ 阈值 0.85，直接输出；正式发布后将按当前 Prompt 与编排配置处理真实请求。',
    ]
    lines.forEach((text, i) => {
      timeouts.current.push(setTimeout(() => {
        setRunLog(log => [...log.map(l => ({ ...l, done: true })), { text, done: false }])
        if (i === lines.length - 1) setRunning(false)
      }, 650 * (i + 1)))
    })
  }

  const toggleArr = (k: 'knowledge' | 'tools', v: string) =>
    set(k, form[k].includes(v) ? form[k].filter(x => x !== v) : [...form[k], v])

  const removeAgent = async (a: Listed) => {
    if (a.src === 'factory') {
      const ok = await deleteSkill(a.id)
      if (ok) setBanner(`「${a.name}」已下架（skill-registry 已移除）`)
      refresh()
    } else {
      setAgents(list => list.filter(x => x.id !== a.id))
    }
  }

  const shown = agents.filter(a => filter === '全部' || a.status === filter)

  if (view === 'create') {
    return (
      <div className="space-y-5">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-xl font-semibold text-slate-800">{editId ? '编辑智能体' : '新建智能体'}</h1>
            <p className="text-sm text-slate-500 mt-1">五步向导：从基础信息到发布上架，发布即真注册（@persona/aigility-agent 按 skill_id 加载）</p>
          </div>
          <button onClick={() => { setView('list'); setForm(blank); setStep(0); setEditId(null) }} className="text-sm px-4 py-2 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50">取消</button>
        </div>

        {/* 步骤条 */}
        <div className="bg-white rounded-xl border border-slate-200/80 px-6 py-4 flex items-center gap-2 overflow-x-auto">
          {studioSteps.map((s, i) => (
            <div key={s} className="flex items-center gap-2 shrink-0">
              <button onClick={() => i < step && setStep(i)} className="flex items-center gap-2">
                <span className={`w-6 h-6 rounded-full text-xs flex items-center justify-center ${i < step ? 'bg-emerald-500 text-white' : i === step ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-400'}`}>
                  {i < step ? <CheckCircle2 size={13} /> : i + 1}
                </span>
                <span className={`text-sm ${i === step ? 'text-slate-800 font-medium' : 'text-slate-400'}`}>{s}</span>
              </button>
              {i < studioSteps.length - 1 && <div className={`w-10 h-px ${i < step ? 'bg-emerald-400' : 'bg-slate-200'}`} />}
            </div>
          ))}
        </div>

        <div className="bg-white rounded-xl border border-slate-200/80 p-6">
          {step === 0 && (
            <div className="space-y-4 max-w-2xl">
              <div>
                <label className="text-xs text-slate-400 block mb-1">智能体名称 *</label>
                <input value={form.name} onChange={e => set('name', e.target.value)} placeholder="例如：班组安全问答员"
                  className={`w-full text-sm border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-100 ${errors.name ? 'border-red-300' : 'border-slate-200'}`} />
                {errors.name && <div className="text-xs text-red-500 mt-1">{errors.name}</div>}
              </div>
              <div>
                <label className="text-xs text-slate-400 block mb-1">分类</label>
                <div className="flex gap-2 flex-wrap">
                  {agentCats.filter(c => c !== '全部').map(c => (
                    <button key={c} onClick={() => set('category', c)}
                      className={`text-xs px-3 py-1.5 rounded-full transition ${form.category === c ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>{c}</button>
                  ))}
                </div>
              </div>
              <div>
                <label className="text-xs text-slate-400 block mb-1">能力描述 *</label>
                <textarea value={form.description} onChange={e => set('description', e.target.value)} rows={3} placeholder="一句话说明这个智能体帮谁、解决什么问题"
                  className={`w-full text-sm border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-100 ${errors.description ? 'border-red-300' : 'border-red-200'}`} />
                {errors.description && <div className="text-xs text-red-500 mt-1">{errors.description}</div>}
              </div>
              <div>
                <label className="text-xs text-slate-400 block mb-1">能力标签（回车添加）</label>
                <div className="flex gap-1.5 flex-wrap mb-2">{form.tags.map(t => <span key={t} className="text-xs px-2 py-1 rounded bg-blue-50 text-blue-600">{t}</span>)}</div>
                <input value={tagInput} onChange={e => setTagInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && tagInput.trim()) { set('tags', [...form.tags, tagInput.trim()]); setTagInput('') } }}
                  placeholder="例如：引用可溯、周报" className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-100" />
              </div>
            </div>
          )}

          {step === 1 && (
            <div className="space-y-5">
              <div className="grid md:grid-cols-2 gap-4 max-w-3xl">
                <div>
                  <label className="text-xs text-slate-400 block mb-1">推理模型（展示配置；v1 路由走全局上游）</label>
                  <select value={form.modelId} onChange={e => set('modelId', e.target.value)} className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 bg-white">
                    {models.filter(m => m.type === '通用语言模型').map(m => <option key={m.id} value={m.id}>{m.name}{m.isDefault ? '（默认）' : ''} · {m.contextLength}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs text-slate-400 block mb-1">温度：{form.temperature}</label>
                  <input type="range" min={0} max={1} step={0.1} value={form.temperature} onChange={e => set('temperature', Number(e.target.value))} className="w-full mt-2.5 accent-blue-600" />
                  <div className="flex justify-between text-[10px] text-slate-300"><span>严谨</span><span>发散</span></div>
                </div>
              </div>
              <div className="max-w-3xl">
                <label className="text-xs text-slate-400 block mb-1">角色 Prompt *（发布后即该数字员工的 system prompt 主体）</label>
                <textarea value={form.prompt} onChange={e => set('prompt', e.target.value)} rows={4}
                  placeholder="定义角色、职责边界与输出要求。例如：你是班组安全问答员，只回答安全规程相关问题，回答必须引用规程条款……"
                  className={`w-full text-sm border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-100 ${errors.prompt ? 'border-red-300' : 'border-slate-200'}`} />
                {errors.prompt && <div className="text-xs text-red-500 mt-1">{errors.prompt}</div>}
              </div>
              <div>
                <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
                  <label className="text-xs text-slate-400">编排画布（DAG）· 拖拽节点可扩展</label>
                  <div className="flex gap-1.5">
                    {['开始', '模型', '知识库', '工具', '条件', '输出'].map(n => (
                      <span key={n} className="text-[10px] px-2 py-1 rounded border border-dashed border-slate-300 text-slate-500 hover:border-blue-300 hover:text-blue-600 cursor-grab">+ {n}</span>
                    ))}
                  </div>
                </div>
                <FlowCanvas height={270} />
                <div className="flex items-center justify-between mt-3 flex-wrap gap-2">
                  <button onClick={testRun} disabled={running} className="text-xs px-3.5 py-2 rounded-lg border border-blue-200 text-blue-600 hover:bg-blue-50 flex items-center gap-1.5 disabled:opacity-50">
                    <FlaskConical size={13} />{running ? '试运行中…' : '试运行'}
                  </button>
                  <span className="text-[11px] text-slate-400">置信度低于 0.85 自动转人工，审批轨迹沉淀至规则库</span>
                </div>
                {runLog.length > 0 && (
                  <div className="mt-3 bg-slate-900 rounded-xl p-4 space-y-1.5">
                    {runLog.map((l, i) => (
                      <div key={i} className="text-[11px] font-mono text-slate-300 flex items-center gap-2">
                        {l.done ? <CheckCircle2 size={12} className="text-emerald-400" /> : <Loader2 size={12} className="text-blue-400 animate-spin" />}{l.text}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="max-w-3xl">
              <label className="text-xs text-slate-400 block mb-2">挂载知识库（由 TiMEM 上下文层统一召回，可多选）</label>
              <div className="grid md:grid-cols-2 gap-3">
                {knowledgeBases.map(k => {
                  const on = form.knowledge.includes(k.name)
                  return (
                    <button key={k.name} onClick={() => toggleArr('knowledge', k.name)}
                      className={`text-left rounded-xl border p-4 transition ${on ? 'border-blue-400 ring-2 ring-blue-100 bg-blue-50/40' : 'border-slate-200 hover:border-slate-300'}`}>
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium text-slate-700">{k.name}</span>
                        {on ? <CheckCircle2 size={16} className="text-blue-600" /> : <Circle size={16} className="text-slate-300" />}
                      </div>
                      <div className="text-[11px] text-slate-400 mt-1.5">{k.docs} 文档 · {k.chunks.toLocaleString()} 分片 · 命中率 {k.hit}</div>
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="max-w-3xl">
              <label className="text-xs text-slate-400 block mb-2">配置工具（MCP 工具总线，可多选）</label>
              <div className="flex flex-wrap gap-2">
                {[...mcpTools.map(t => t.name), ...pluginTools.filter(t => t.enabled).map(t => t.name)].map(n => {
                  const on = form.tools.includes(n)
                  return (
                    <button key={n} onClick={() => toggleArr('tools', n)}
                      className={`text-xs px-3 py-2 rounded-lg border transition font-mono ${on ? 'border-sky-300 bg-sky-50 text-sky-700' : 'border-slate-200 text-slate-500 hover:border-slate-300'}`}>{n}</button>
                  )
                })}
              </div>
              <div className="text-[11px] text-slate-400 mt-4 rounded-lg bg-slate-50 border border-slate-100 p-3 leading-relaxed">
                已选 {form.tools.length} 个工具。发布后工具清单随人设注入对话上下文；写操作类工具的执行接真在后续迭代（当前为声明配置）。
              </div>
            </div>
          )}

          {step === 4 && (
            <div className="space-y-4 max-w-2xl">
              <div>
                <label className="text-xs text-slate-400 block mb-2">可见范围</label>
                <div className="flex gap-2">
                  {(['企业内', '仅自己'] as const).map(v => (
                    <button key={v} onClick={() => set('visibility', v)}
                      className={`text-xs px-4 py-2 rounded-lg border transition ${form.visibility === v ? 'border-blue-400 bg-blue-50 text-blue-700' : 'border-slate-200 text-slate-500'}`}>{v}</button>
                  ))}
                </div>
              </div>
              <div>
                <label className="text-xs text-slate-400 block mb-1">发布说明</label>
                <textarea value={form.releaseNote} onChange={e => set('releaseNote', e.target.value)} rows={3} placeholder="本版本的能力与变更说明"
                  className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-100" />
              </div>
              <div className="rounded-xl bg-slate-50 border border-slate-100 p-4 text-xs text-slate-500 leading-relaxed">
                发布流水线：保存草稿 → 试运行 → 发布。发布动作会<b className="text-slate-700">真注册</b>到服务端 skill-registry（data/aigility-skills.json），
                并挂到 <code className="text-blue-600">@persona/aigility-agent</code> —— 对话工作台与智能体市场立即可用，记忆按 skill_id 隔离。
              </div>
              <div className="rounded-xl border border-sky-200 bg-sky-50/40 p-4 space-y-2.5">
                <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                  <input type="checkbox" checked={dshSync} onChange={e => setDshSync(e.target.checked)} className="accent-sky-600" />
                  同时注册为 <b>DSH 技能</b>（IM 渠道热生效）
                </label>
                {dshSync && (
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs text-slate-500">创建后挂到角色：</span>
                    <select value={dshRole} onChange={e => setDshRole(e.target.value)}
                      className="text-xs px-2.5 py-1.5 rounded-lg border border-slate-200 bg-white">
                      <option value="">（仅创建，不挂角色）</option>
                      {dshRoles.map(r => <option key={r} value={r}>{r}</option>)}
                    </select>
                    <span className="text-[11px] text-slate-400">将按当前名称/描述/Prompt 生成 skillsRoot/&lt;slug&gt;/SKILL.md</span>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* 底部操作 */}
        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={() => setStep(s => Math.max(0, s - 1))} disabled={step === 0}
            className="text-sm px-4 py-2 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-40 flex items-center gap-1"><ChevronLeft size={15} />上一步</button>
          {step < studioSteps.length - 1 && (
            <button onClick={next} className="text-sm px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 flex items-center gap-1">下一步<ChevronRight size={15} /></button>
          )}
          <button onClick={saveDraft} className="text-sm px-4 py-2 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 flex items-center gap-1.5"><Save size={14} />保存草稿</button>
          {step === studioSteps.length - 1 && (
            <button onClick={() => void publish()} disabled={pubBusy}
              className="text-sm px-4 py-2 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 flex items-center gap-1.5 disabled:opacity-50">
              {pubBusy ? <Loader size={14} className="animate-spin" /> : <Rocket size={14} />}{pubBusy ? '发布中…' : '发布到智能体市场'}
            </button>
          )}
          {pubError && <span className="text-xs text-red-500">发布失败：{pubError}</span>}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-800">智能体工厂</h1>
          <p className="text-sm text-slate-500 mt-1">智能体的创建、编排、调试与发布 —— 发布即真注册到 aigility-harness（@persona/aigility-agent）</p>
        </div>
        <button onClick={() => { setView('create'); setEditId(null); setForm(blank); setStep(0) }} className="text-sm px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 flex items-center gap-1.5"><Plus size={15} />新建智能体</button>
      </div>

      {banner && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3 text-xs text-emerald-700 flex items-center gap-2" style={{ animation: 'fadeSlide .3s ease' }}>
          <CheckCircle2 size={14} />{banner}
        </div>
      )}

      <div className="flex gap-2 items-center flex-wrap">
        {(['全部', '已发布', '草稿'] as const).map(f => (
          <button key={f} onClick={() => setFilter(f)}
            className={`text-xs px-3.5 py-1.5 rounded-full transition ${filter === f ? 'bg-blue-600 text-white' : 'bg-white border border-slate-200 text-slate-600 hover:border-blue-300'}`}>
            {f}{f !== '全部' && ` ${agents.filter(a => a.status === f).length}`}
          </button>
        ))}
        <span className="text-xs text-slate-400 ml-auto flex items-center gap-1"><Store size={12} />另有官方模板库可在智能体市场直接复用改造</span>
      </div>

      {shown.length === 0 ? (
        <div className="bg-white rounded-xl border border-slate-200/80 p-16 text-center">
          <SearchX size={28} className="text-slate-300 mx-auto mb-3" />
          <div className="text-sm text-slate-500">暂无{filter}的智能体</div>
          <button onClick={() => { setView('create'); setEditId(null); setForm(blank); setStep(0) }} className="mt-4 text-xs px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700">新建第一个智能体</button>
        </div>
      ) : (
        <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
          {shown.map(a => (
            <div key={a.id} className={`bg-white rounded-xl border p-5 hover:shadow-md transition ${a.src === 'factory' ? 'border-sky-300 ring-1 ring-sky-100' : 'border-slate-200/80'}`}>
              <div className="flex items-start justify-between mb-2">
                <div className="flex items-center gap-2.5">
                  <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-blue-500 to-sky-500 text-white flex items-center justify-center"><Bot size={16} /></div>
                  <div>
                    <div className="font-medium text-slate-800 text-sm">{a.name}</div>
                    <div className="text-[11px] text-slate-400">{a.category} · 更新 {a.updatedAt}</div>
                  </div>
                </div>
                <span className={`text-[10px] px-2 py-0.5 rounded-full ${a.status === '已发布' ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-100 text-slate-500'}`}>
                  {a.status}{a.src === 'factory' ? ' · 真注册' : ''}
                </span>
              </div>
              <p className="text-xs text-slate-500 leading-relaxed mb-3 min-h-[32px]">{a.description}</p>
              <div className="flex gap-1.5 flex-wrap mb-3">
                {a.tags.map(t => <span key={t} className="text-[10px] px-2 py-0.5 rounded bg-slate-50 border border-slate-100 text-slate-500">{t}</span>)}
              </div>
              <div className="text-[11px] text-slate-400 mb-3">
                模型 {models.find(m => m.id === a.modelId)?.name || a.modelId} · 知识库 {a.knowledge.length} 个 · 工具 {a.tools.length} 个
                {a.src === 'factory' && <> · <code className="text-sky-600">skill_id={a.id}</code></>}
              </div>
              <div className="flex gap-2 pt-3 border-t border-slate-50">
                <button onClick={() => { const { id, status, updatedAt, src, ...rest } = a; setForm(rest); setEditId(src === 'factory' ? id : null); setStep(0); setView('create') }}
                  className="flex-1 text-xs py-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 flex items-center justify-center gap-1"><PenLine size={12} />编辑</button>
                <button onClick={() => void removeAgent(a)}
                  className="text-xs py-1.5 px-3 rounded-lg border border-slate-200 text-slate-400 hover:text-red-500 hover:border-red-200"><Trash2 size={12} /></button>
              </div>
            </div>
          ))}
        </div>
      )}
      <style>{`@keyframes fadeSlide { from { opacity: 0; transform: translateY(4px);} to { opacity: 1; transform: none; } }`}</style>
    </div>
  )
}
