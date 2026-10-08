import { useEffect, useState } from 'react'
import { studioSeed, agentCats, type StudioAgent } from '../mock/data'
import RoleDshEditor from '../components/RoleDshEditor'
import RolePackageEditor from '../components/RolePackageEditor'
import { publishSkill, deleteSkill, fetchRegistry, createDshSkill, fetchLlmModels, fetchRolePackages, revertRolePackage, promoteRolePackage, fetchFlows, fetchFlowYaml, saveFlowYaml, fetchTaskLoopWorkflow, saveTaskLoopWorkflow, saveRolePackage, fetchRoleEliza, importRoleFile, fetchMarketConfig, saveMarketConfig, setSkillVisibility, type RolePackageInfo, type FlowInfo, type MarketDataMode } from '../lib/harness'
import { getCurrentUser } from '../lib/api'
import WorkflowYamlEditor from '../components/WorkflowYamlEditor'
import { X } from 'lucide-react'
import { Plus, Bot, Rocket, Trash2, PenLine, CheckCircle2, Loader, Store, SearchX, User, Wrench, Radio, Send, Cpu, ListTree, Package, Terminal, CalendarClock, Save, Download, Upload, Undo2, ArrowUpFromLine } from 'lucide-react'

const blank: Omit<StudioAgent, 'id' | 'status' | 'updatedAt'> = {
  name: '', category: '知识服务', description: '', tags: [],
  modelId: '', prompt: '', temperature: 0.3, knowledge: [], tools: [],
  visibility: '企业内', releaseNote: '',
}

/** 列表条目 = 服务端真注册（factory）+ 本地演示种子（demo） */
type Listed = StudioAgent & { src: 'factory' | 'demo' }

const demoSeed: Listed[] = studioSeed.map(a => ({ ...a, src: 'demo' }))

export default function StudioPage() {
  const [view, setView] = useState<'list' | 'edit' | 'pkg'>('list')
  const [agents, setAgents] = useState<Listed[]>(demoSeed)
  const [rolePkgs, setRolePkgs] = useState<RolePackageInfo[]>([])
  const [pkgId, setPkgId] = useState<string | null>(null)
  const [originFilter, setOriginFilter] = useState<'全部' | '已发布' | '引擎原生' | '站点定制' | '底座模板' | '演示'>('全部')
  const [wfModal, setWfModal] = useState<string | null>(null)
  const [flowList, setFlowList] = useState<FlowInfo[]>([])
  const [filter, setFilter] = useState<'全部' | '已发布' | '草稿'>('全部')
  const [form, setForm] = useState(blank)
  const [editId, setEditId] = useState<string | null>(null)
  const [tagInput, setTagInput] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [banner, setBanner] = useState('')
  const [pubBusy, setPubBusy] = useState(false)
  const [pubError, setPubError] = useState('')
  const [modelPool, setModelPool] = useState<string[]>([])
  const [section, setSection] = useState<'persona' | 'model' | 'ability' | 'workflow' | 'publish'>('persona')

  useEffect(() => { fetchLlmModels().then(r => setModelPool(r.models ?? [])).catch(() => {}) }, [])
  const refreshPkgs = () => { fetchRolePackages().then(setRolePkgs).catch(() => {}) }
  useEffect(() => { refreshPkgs() }, [])
  useEffect(() => { fetchFlows().then(setFlowList).catch(() => {}) }, [])

  // ── 智能体市场管理（仅管理员）：数据模式开关 + 已发布数字员工上架/撤下 ──
  const isAdmin = !!getCurrentUser()?.isAdmin
  const [dataMode, setDataMode] = useState<MarketDataMode>('mock')
  const [shelfBusy, setShelfBusy] = useState(false)
  useEffect(() => { if (isAdmin) fetchMarketConfig().then(c => setDataMode(c.dataMode)).catch(() => {}) }, [isAdmin])

  const changeDataMode = async (m: MarketDataMode) => {
    setShelfBusy(true)
    try {
      await saveMarketConfig(m)
      setDataMode(m)
      setBanner(m === 'real' ? '市场已切换为「真实数据」—— 可见范围=企业内 的已发布数字员工上架展示' : '市场已切换为「模拟数据」—— 普通用户看到演示模板')
    } catch (e) { setPubError(String((e as Error).message ?? e)) } finally { setShelfBusy(false) }
  }

  const toggleShelf = async (id: string, name: string, cur: string) => {
    const next = cur === '企业内' ? '仅自己' : '企业内'
    try {
      await setSkillVisibility(id, next)
      setBanner(next === '企业内' ? `「${name}」已上架智能体市场（企业内可见）` : `「${name}」已撤下市场（仅对话工作台自己可用）`)
      refresh()
      refreshPkgs()
    } catch (e) { setPubError(String((e as Error).message ?? e)) }
  }

  const SECTIONS = [
    { id: 'persona', label: '人设 · 它是谁', icon: User },
    { id: 'model', label: '模型 · 用什么脑子', icon: Cpu },
    { id: 'ability', label: '能力 · 能干什么', icon: Wrench },
    { id: 'workflow', label: '编排 · 复杂任务', icon: ListTree },
    { id: 'publish', label: '通道与发布', icon: Send },
  ] as const

  const jumpTo = (id: (typeof SECTIONS)[number]['id']) => {
    setSection(id)
    document.getElementById(`sec-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const refresh = () => {
    fetchRegistry().then(r => {
      const fromServer: Listed[] = r.skills.map(s => ({ ...s, visibility: s.visibility as StudioAgent['visibility'], src: 'factory' }))
      setAgents([...fromServer, ...demoSeed])
    }).catch(() => {})
  }
  useEffect(() => { refresh() }, [])

  const set = (k: string, v: any) => { setForm(f => ({ ...f, [k]: v })); setErrors(e => ({ ...e, [k]: '' })) }

  const openNew = () => { setForm(blank); setEditId(null); setView('edit') }
  const openEdit = (a: Listed) => {
    const { id, status, updatedAt, src, ...rest } = a
    setForm(rest); setEditId(src === 'factory' ? id : null); setView('edit')
  }
  const backToList = () => { setView('list'); setForm(blank); setEditId(null); setErrors({}) }

  /** 发布 → skill-registry 真注册 + DSH 技能同步（固定行为, IM 侧即刻可用） */
  const publish = async () => {
    const e: Record<string, string> = {}
    if (!form.name.trim()) e.name = '请填写智能体名称'
    if (!form.description.trim()) e.description = '请填写能力描述'
    if (!form.prompt.trim()) e.prompt = '请填写角色 Prompt'
    setErrors(e)
    if (Object.keys(e).length) return
    setPubBusy(true); setPubError('')
    try {
      const skill = await publishSkill({
        ...(editId ? { id: editId } : {}),
        name: form.name,
        category: form.category,
        description: form.description,
        tags: form.tags,
        modelId: form.modelId || 'unified-upstream', // 模型偏好（D2）：请求级透传到 workflow-engine → llm-inference
        prompt: form.prompt,
        temperature: 0.3,
        knowledge: [],
        tools: [],
        visibility: form.visibility,
        releaseNote: form.releaseNote,
      })
      let dshNote = ''
      try {
        const r = await createDshSkill({ name: form.name, description: form.description, prompt: form.prompt })
        dshNote = `；已同步 DSH 技能「${r.skill.dir}」（IM 渠道可用，可在下方能力分区勾选挂载）`
      } catch (err) {
        setPubError(`平台发布成功，但 DSH 技能同步失败：${err instanceof Error ? err.message : String(err)}`)
      }
      setBanner(`「${skill.name}」发布成功（skill_id=${skill.id}，已注册 @persona/aigility-agent）—— 对话工作台立即可用${skill.visibility === '企业内' ? '，已上架智能体市场' : '（仅自己 · 不上架市场）'}${dshNote}`)
      backToList()
      refresh()
    } catch (err) {
      setPubError(err instanceof Error ? err.message : String(err))
    } finally {
      setPubBusy(false)
    }
  }

  const removeAgent = async (a: Listed) => {
    if (a.src === 'factory') {
      const ok = await deleteSkill(a.id)
      if (ok) setBanner(`「${a.name}」已下架（skill-registry 已移除）`)
      refresh()
    } else {
      setAgents(list => list.filter(x => x.id !== a.id))
    }
  }

  // ── 角色包编辑视图：roles/ 目录的可移植角色单元（SKILL.md 人设 + 五要素声明）──
  if (view === 'pkg') {
    const pkg = rolePkgs.find((p) => p.id === pkgId)
    return (
      <div className="space-y-5">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-xl font-semibold text-slate-800">角色包 · {pkg?.name ?? pkgId}</h1>
            <p className="text-sm text-slate-500 mt-1">roles/ 目录可移植角色单元：SKILL.md 人设 + 五要素声明；命令面板（确定性意图）与调度器在此配置</p>
          </div>
          <button onClick={() => setView('list')} className="text-sm px-4 py-2 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50">← 返回列表</button>
        </div>
        {pkg ? (
          <RolePackageEditor pkg={pkg} onSaved={refreshPkgs} onClose={() => setView('list')} />
        ) : (
          <div className="bg-white rounded-xl border border-dashed border-slate-200 p-10 text-center text-sm text-slate-400">角色包不存在或已被移除</div>
        )}
      </div>
    )
  }

  // ── 编辑/新建：单页分区（人设 → 能力 → 通道/发布由 RoleDshEditor 承载）──
  if (view === 'edit') {
    const isEdit = editId !== null
    return (
      <div className="grid lg:grid-cols-[176px_1fr] gap-5 items-start">
      {/* 左侧粘性目录 */}
      <nav className="hidden lg:flex flex-col gap-1 sticky top-4 bg-white rounded-xl border border-slate-200/80 p-2">
        {SECTIONS.map(sec => (
          <button key={sec.id} onClick={() => jumpTo(sec.id)}
            className={`flex items-center gap-2 text-xs px-3 py-2 rounded-lg transition text-left ${section === sec.id ? 'bg-blue-50 text-blue-700 font-medium' : 'text-slate-500 hover:bg-slate-50'}`}>
            <sec.icon size={13} />{sec.label}
          </button>
        ))}
        <div className="text-[10px] text-slate-300 px-3 pt-2 leading-relaxed">按五域分区：人设 D5 · 模型 D2 · 能力 D3 · 通道 D1 · 编排 D4 · 发布</div>
      </nav>
      <div className="space-y-5 min-w-0">
        {/* 顶栏：名称 + 主动作 */}
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3 flex-wrap">
            <button onClick={backToList} className="text-sm px-3 py-2 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50">← 返回</button>
            <h1 className="text-xl font-semibold text-slate-800">{isEdit ? '编辑数字员工' : '新建数字员工'}</h1>
            {isEdit && <code className="text-xs text-sky-600">{editId}</code>}
          </div>
          <button onClick={() => void publish()} disabled={pubBusy}
            className="text-sm px-5 py-2 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 flex items-center gap-1.5 disabled:opacity-50">
            {pubBusy ? <Loader size={15} className="animate-spin" /> : <Rocket size={15} />}{pubBusy ? '发布中…' : '发布'}
          </button>
        </div>

        {banner && (
          <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3 text-xs text-emerald-700 flex items-center gap-2" style={{ animation: 'fadeSlide .3s ease' }}>
            <CheckCircle2 size={14} />{banner}
          </div>
        )}
        {pubError && <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-xs text-red-600">{pubError}</div>}

        {/* 工作流可视化编排弹窗（chat-briefing + 平台 flows） */}
        {wfModal && (
          <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-[2px] flex items-start justify-center p-4 overflow-auto"
            onClick={() => setWfModal(null)}>
            <div className="bg-white rounded-2xl w-full max-w-6xl my-6 p-5 space-y-3" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-sm font-semibold text-slate-800">工作流可视化编排</h3>
                <select value={wfModal} onChange={(e) => setWfModal(e.target.value)}
                  className="text-xs px-2.5 py-1.5 rounded-lg border border-slate-200 text-slate-600">
                  <option value="chat-briefing">chat-briefing · 项目小助理群聊整理</option>
                  {flowList.map((f) => <option key={f.id} value={f.id}>{f.id}{f.name ? ` · ${f.name}` : ''}</option>)}
                </select>
                <span className="text-[11px] text-slate-400">条件边/LLM system_prompt 只读保护，其余图形编辑保存即落盘</span>
                <div className="flex-1" />
                <button onClick={() => setWfModal(null)} className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100"><X size={16} /></button>
              </div>
              <WorkflowYamlEditor key={wfModal}
                title={wfModal === 'chat-briefing' ? 'chat-briefing.yaml · 项目小助理群聊整理' : `flows/${wfModal}.yaml · 平台工作流`}
                load={wfModal === 'chat-briefing' ? fetchTaskLoopWorkflow : () => fetchFlowYaml(wfModal)}
                save={wfModal === 'chat-briefing' ? saveTaskLoopWorkflow : (t) => saveFlowYaml(wfModal, t)} />
            </div>
          </div>
        )}

        {/* ① 人设 · 它是谁（D5） */}
        <div id="sec-persona" className="bg-white rounded-xl border border-slate-200/80 p-6 space-y-4 scroll-mt-4">
          <div className="flex items-center gap-2">
            <span className="w-7 h-7 rounded-lg bg-violet-100 text-violet-600 flex items-center justify-center"><User size={15} /></span>
            <h2 className="text-base font-semibold text-slate-800">人设 · 它是谁</h2>
            <span className="text-[11px] text-slate-400">发布后即 <code>@persona/aigility-agent</code> 按此装配对话</span>
          </div>
          <div className="grid md:grid-cols-2 gap-4 max-w-4xl">
            <div>
              <label className="text-xs text-slate-400 block mb-1">名称 *</label>
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
          </div>
          <div className="max-w-4xl">
            <label className="text-xs text-slate-400 block mb-1">能力描述 *</label>
            <textarea value={form.description} onChange={e => set('description', e.target.value)} rows={2} placeholder="一句话说明这个数字员工帮谁、解决什么问题"
              className={`w-full text-sm border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-100 ${errors.description ? 'border-red-300' : 'border-slate-200'}`} />
            {errors.description && <div className="text-xs text-red-500 mt-1">{errors.description}</div>}
          </div>
          <div className="max-w-4xl">
            <label className="text-xs text-slate-400 block mb-1">角色 Prompt *（system prompt 主体 —— 该数字员工最核心的配置）</label>
            <textarea value={form.prompt} onChange={e => set('prompt', e.target.value)} rows={6}
              placeholder="定义角色、职责边界与输出要求。例如：你是班组安全问答员，只回答安全规程相关问题，回答必须引用规程条款……"
              className={`w-full text-sm border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-100 ${errors.prompt ? 'border-red-300' : 'border-slate-200'}`} />
            {errors.prompt && <div className="text-xs text-red-500 mt-1">{errors.prompt}</div>}
          </div>
          <div className="max-w-4xl">
            <label className="text-xs text-slate-400 block mb-1">能力标签（回车添加）</label>
            <div className="flex gap-1.5 flex-wrap mb-2">{form.tags.map(t => <span key={t} className="text-xs px-2 py-1 rounded bg-blue-50 text-blue-600">{t}</span>)}</div>
            <input value={tagInput} onChange={e => setTagInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && tagInput.trim()) { set('tags', [...form.tags, tagInput.trim()]); setTagInput('') } }}
              placeholder="例如：引用可溯、周报" className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-100" />
          </div>
        </div>

        {/* ①.5 模型 · 它用什么脑子（D2）—— 真模型池, 请求级透传 */}
        <div id="sec-model" className="bg-white rounded-xl border border-slate-200/80 p-6 space-y-3 scroll-mt-4">
          <div className="flex items-center gap-2">
            <span className="w-7 h-7 rounded-lg bg-amber-100 text-amber-600 flex items-center justify-center"><Cpu size={15} /></span>
            <h2 className="text-base font-semibold text-slate-800">模型 · 它用什么脑子</h2>
            <span className="text-[11px] text-slate-400">对话请求级路由：选择即生效（workflow-engine → llm-inference）</span>
          </div>
          <div className="max-w-xl">
            <label className="text-xs text-slate-400 block mb-1">模型偏好</label>
            <select value={form.modelId || ''} onChange={e => set('modelId', e.target.value)}
              className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 bg-white">
              <option value="">跟随平台统一上游（{modelPool.length ? `模型池 ${modelPool.length} 个可选` : '模型池加载中…'}）</option>
              {modelPool.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
            <div className="text-[11px] text-slate-400 mt-1.5">
              {modelPool.length === 0
                ? '模型池来自 AI 网关 /v1/models（当前不可达时仅可跟随默认）'
                : `当前上游模型池（LiteLLM）：${modelPool.slice(0, 6).join('、')}${modelPool.length > 6 ? ` 等 ${modelPool.length} 个` : ''}`}
            </div>
          </div>
        </div>

        {/* ② 能力 · 它能干什么（D3）+ 通道 · 它出现在哪里（D1）—— 发布后可配（角色 ID = 智能体 ID） */}
        <div id="sec-ability" className="bg-white rounded-xl border border-slate-200/80 p-6 space-y-4 scroll-mt-4">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="w-7 h-7 rounded-lg bg-sky-100 text-sky-600 flex items-center justify-center"><Wrench size={15} /></span>
            <h2 className="text-base font-semibold text-slate-800">能力 · 它能干什么</h2>
            <span className="text-[11px] text-slate-400">DSH 技能包（IM 渠道热生效）+ MCP 工具（来自已安装插件）</span>
          </div>
          {isEdit ? (
            <RoleDshEditor roleId={editId} label={form.name} sections={['ability']} onChanged={refresh} />
          ) : (
            <div className="rounded-lg border border-dashed border-slate-200 p-4 text-center text-xs text-slate-400">
              发布后此区激活 —— 角色 ID = 发布生成的智能体 ID，届时可勾选 DSH 技能与 MCP 工具
            </div>
          )}
        </div>

        {/* ④ 编排 · 复杂任务拆解（D4） */}
        <div id="sec-workflow" className="bg-white rounded-xl border border-slate-200/80 p-6 space-y-4 scroll-mt-4">
          <div className="flex items-center gap-2">
            <span className="w-7 h-7 rounded-lg bg-violet-100 text-violet-600 flex items-center justify-center"><ListTree size={15} /></span>
            <h2 className="text-base font-semibold text-slate-800">编排 · 复杂任务拆解（D4）</h2>
            <span className="text-[11px] text-slate-400">角色可委托的数据面工作流（YAML 声明, 可版本化）</span>
            <button onClick={() => setWfModal('chat-briefing')}
              className="ml-auto text-xs px-3 py-1.5 rounded-lg bg-violet-600 text-white hover:bg-violet-700 flex items-center gap-1.5">
              <ListTree size={12} />可视化编排
            </button>
          </div>
          {isEdit ? (
            <RoleDshEditor roleId={editId} label={form.name} sections={['workflow']} onChanged={refresh} />
          ) : (
            <div className="rounded-lg border border-dashed border-slate-200 p-4 text-center text-xs text-slate-400">
              发布后此区激活 —— 勾选该角色可委托的编排工作流（如任务板执行器路由）
            </div>
          )}
        </div>

        {/* ⑤ 通道与发布（D1 · 交付） */}
        <div id="sec-publish" className="bg-white rounded-xl border border-slate-200/80 p-6 space-y-4 scroll-mt-4">
          <div className="flex items-center gap-2">
            <span className="w-7 h-7 rounded-lg bg-cyan-100 text-cyan-600 flex items-center justify-center"><Radio size={15} /></span>
            <h2 className="text-base font-semibold text-slate-800">通道 · 它出现在哪里</h2>
            <span className="text-[11px] text-slate-400">app 面貌与角色一致（一角色一平台一 app）</span>
          </div>
          {isEdit ? (
            <RoleDshEditor roleId={editId} label={form.name} sections={['channel']} onChanged={refresh} />
          ) : (
            <div className="rounded-lg border border-dashed border-slate-200 p-4 text-center text-xs text-slate-400">
              发布后此区激活 —— 声明该角色出现在哪些平台（不声明 = 纯网页/后台角色）
            </div>
          )}

          <div className="border-t border-slate-100 pt-4 space-y-4">
            <div className="flex items-center gap-2">
              <span className="w-7 h-7 rounded-lg bg-emerald-100 text-emerald-600 flex items-center justify-center"><Send size={15} /></span>
              <h2 className="text-base font-semibold text-slate-800">发布 · 交付设置</h2>
              <span className="text-[11px] text-slate-400">发布 = 真注册 + IM 侧自动同步（无隐藏步骤）</span>
            </div>
          <div className="max-w-3xl space-y-4">
            <div>
              <label className="text-xs text-slate-400 block mb-2">可见范围</label>
              {isAdmin ? (
                <>
                  <div className="flex gap-2">
                    {(['企业内', '仅自己'] as const).map(v => (
                      <button key={v} onClick={() => set('visibility', v)}
                        className={`text-xs px-4 py-2 rounded-lg border transition ${form.visibility === v ? 'border-blue-400 bg-blue-50 text-blue-700' : 'border-slate-200 text-slate-500'}`}>{v}</button>
                    ))}
                  </div>
                  <div className="text-[11px] text-slate-400 mt-1.5">「企业内」= 上架智能体市场，普通用户可见可用；「仅自己」= 不上架市场，仅对话工作台自己可用（管理员可在列表卡上随时上架/撤下）</div>
                </>
              ) : (
                <div className="text-[11px] text-slate-500 rounded-lg bg-slate-50 border border-slate-100 px-3 py-2 leading-relaxed">
                  你发布的数字员工为「仅自己」可见 —— 发布后直接在「数字员工工作台」可见可用，不上架智能体市场；如需企业内上架，请联系管理员。
                </div>
              )}
            </div>
            <div>
              <label className="text-xs text-slate-400 block mb-1">发布说明</label>
              <textarea value={form.releaseNote} onChange={e => set('releaseNote', e.target.value)} rows={2} placeholder="本版本的能力与变更说明（可选）"
                className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-100" />
            </div>
            <div className="rounded-xl bg-slate-50 border border-slate-100 p-4 text-xs text-slate-500 leading-relaxed">
              发布动作：<b className="text-slate-700">真注册</b>到 skill-registry → 挂到 <code className="text-blue-600">@persona/aigility-agent</code>（对话工作台/市场立即可用，记忆按 skill_id 隔离）→ 自动生成 DSH 技能（IM 渠道可用）。
              模型路由走平台统一上游（模型管理页可查当前上游）。
            </div>
            <button onClick={() => void publish()} disabled={pubBusy}
              className="text-sm px-5 py-2 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 flex items-center gap-1.5 disabled:opacity-50">
              {pubBusy ? <Loader size={15} className="animate-spin" /> : <Rocket size={15} />}{pubBusy ? '发布中…' : isAdmin ? '发布到对话工作台与市场' : '发布到数字员工工作台'}
            </button>
          </div>
        </div>
        </div>
        <style>{`@keyframes fadeSlide { from { opacity: 0; transform: translateY(4px);} to { opacity: 1; transform: none; } }`}</style>
      </div>
      </div>
    )
  }

  // ── 列表视图：统一角色卡（一种卡片 + 生命周期徽标）──
  // 领域模型：卡片 = 角色（角色包或引擎人格虚拟卡）；徽标 = 生命周期状态（模板/引擎原生/站点定制/已发布/演示）。
  // 「发布」是卡上的动作而非另一类卡 —— 数字员工 = 走到已发布这一步的角色。

  const ORIGIN_META: Record<string, { label: string; cls: string; grad: string }> = {
    published: { label: '已发布 · 数字员工', cls: 'bg-emerald-50 text-emerald-600 border-emerald-200', grad: 'from-emerald-500 to-teal-500' },
    site: { label: '站点定制', cls: 'bg-sky-50 text-sky-600 border-sky-200', grad: 'from-sky-500 to-blue-500' },
    engine: { label: '引擎原生', cls: 'bg-amber-50 text-amber-600 border-amber-200', grad: 'from-amber-500 to-orange-500' },
    template: { label: '底座模板', cls: 'bg-violet-50 text-violet-600 border-violet-200', grad: 'from-violet-500 to-purple-500' },
    demo: { label: '演示模板', cls: 'bg-slate-100 text-slate-500 border-slate-200', grad: 'from-slate-400 to-slate-500' },
  }
  const ORIGIN_ORDER: Array<'全部' | '已发布' | '引擎原生' | '站点定制' | '底座模板' | '演示'> = ['全部', '已发布', '引擎原生', '站点定制', '底座模板', '演示']
  const originCount = (o: string) =>
    o === '全部' ? rolePkgs.length + demoSeed.length
      : o === '演示' ? demoSeed.length
      : rolePkgs.filter((p) => ORIGIN_META[p.origin ?? 'template'].label.startsWith(o)).length

  const shownPkg = rolePkgs.filter((p) => originFilter === '全部' || ORIGIN_META[p.origin ?? 'template'].label.startsWith(originFilter))
  const shownDemo = demoSeed.filter(() => originFilter === '全部' || originFilter === '演示')

  const exportPkg = (p: RolePackageInfo) => {
    const bundle = { format: 'aigility-role-package', version: 1, exportedAt: new Date().toISOString(), manifest: p.manifest, prompt: p.prompt }
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `role-${p.id}.json`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  /** 定制副本：引擎虚拟卡 → 创建站点角色包（可编辑；capability_ref 指回引擎，对话仍走引擎） */
  const [forkBusy, setForkBusy] = useState<string | null>(null)
  const forkEngine = async (p: RolePackageInfo) => {
    setForkBusy(p.id)
    try {
      await saveRolePackage(p.id, {
        manifest: p.manifest,
        prompt: `你是「${p.name}」。${p.description || ''}\n\n（定制副本：在此撰写完整人设；capability_ref 指向引擎原生人格，保存后对话仍由引擎承载。）\n`,
      })
      await refreshPkgs()
      setBanner(`已创建「${p.name}」站点定制副本（data/roles/${p.id}）——可在角色包编辑器中完善人设`)
    } catch (e) { setPubError(String((e as Error).message ?? e)) } finally { setForkBusy(null) }
  }

  /** 发布预填：站点/模板包 → 打开发布表单（发布后成为数字员工） */
  const publishPrefill = (p: RolePackageInfo) => {
    setForm({ ...blank, name: p.name, description: p.description || p.manifest.identity.name, prompt: p.prompt || `你是「${p.name}」。`, category: agentCats.includes(p.manifest.identity.signature ?? '') ? (p.manifest.identity.signature ?? '知识服务') : '知识服务' })
    setEditId(null); setView('edit')
  }

  /** 提升回流（M-C）：站点定制版 → 出厂模板（仅管理员；服务端写回工作区未提交，走 git PR 人审） */
  const [promoteBusy, setPromoteBusy] = useState<string | null>(null)
  const promote = async (p: RolePackageInfo) => {
    if (!window.confirm(`将「${p.name}」的站点定制版提升为出厂模板？\n\n该操作会写回 packages/role-kit/roles/${p.id}/SKILL.md（工作区未提交），需经 git PR 人审后随版本分发所有站点。`)) return
    setPromoteBusy(p.id); setPubError('')
    try {
      const r = await promoteRolePackage(p.id)
      if (!r.ok) throw new Error(r.error ?? (r.issues?.join('；') ?? '提升失败'))
      setBanner(`已写回出厂模板：${r.target}（${r.bodyLength} 字符）——请在仓库 git diff 审阅后走 PR 合入。`)
      refreshPkgs()
    } catch (e) { setPubError(String((e as Error).message ?? e)) } finally { setPromoteBusy(null) }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-800">智能体工厂</h1>
          <p className="text-sm text-slate-500 mt-1">全量角色产线：一种卡片，徽标即生命周期 —— 定制、发布、分享一站完成（发布 = 真注册 @persona/aigility-agent）</p>
        </div>
        <div className="flex gap-2">
          <label className="text-sm px-4 py-2 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 flex items-center gap-1.5 cursor-pointer">
            <Upload size={15} />导入角色
            <input type="file" accept=".json" className="hidden" onChange={(e) => {
              const f = e.target.files?.[0]
              if (!f) return
              f.text().then((t) => importRoleFile(t).then((id) => { setBanner(`已导入角色「${id}」→ 站点角色包（data/roles/${id}）`); refreshPkgs() }).catch((err) => setPubError(String((err as Error).message ?? err))))
              e.target.value = ''
            }} />
          </label>
          <button onClick={openNew} className="text-sm px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 flex items-center gap-1.5"><Plus size={15} />新建数字员工</button>
        </div>
      </div>

      {banner && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3 text-xs text-emerald-700 flex items-center gap-2" style={{ animation: 'fadeSlide .3s ease' }}>
          <CheckCircle2 size={14} />{banner}
        </div>
      )}
      {pubError && <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-xs text-red-600">{pubError}</div>}

      {/* 生命周期筛选 */}
      <div className="flex gap-2 items-center flex-wrap">
        {ORIGIN_ORDER.map(f => (
          <button key={f} onClick={() => setOriginFilter(f)}
            className={`text-xs px-3.5 py-1.5 rounded-full transition ${originFilter === f ? 'bg-blue-600 text-white' : 'bg-white border border-slate-200 text-slate-600 hover:border-blue-300'}`}>
            {f} {originCount(f) > 0 && ` ${originCount(f)}`}
          </button>
        ))}
        <span className="text-xs text-slate-400 ml-auto flex items-center gap-1"><Store size={12} />角色包可导出分享（JSON），或经 git 直接分发 roles/ 目录</span>
      </div>

      {/* 智能体市场管理（仅管理员）：数据模式 + 上架范围 */}
      {isAdmin && (
        <div className="bg-white rounded-xl border border-sky-200 ring-1 ring-sky-100/60 p-5 space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="w-7 h-7 rounded-lg bg-sky-100 text-sky-600 flex items-center justify-center"><Store size={15} /></span>
            <h2 className="text-sm font-semibold text-slate-800">智能体市场 · 数据模式</h2>
            <span className="text-[11px] text-slate-400">市场面向普通用户，展示内容由管理员控制（站点级，全站生效）</span>
          </div>
          <div className="flex gap-2 flex-wrap items-center">
            {([['mock', '模拟数据', '市场显示演示模板（管理员未设置时的缺省）'], ['real', '真实数据', '市场显示已上架的数字员工（可见范围=企业内）']] as const).map(([m, label, tip]) => (
              <button key={m} onClick={() => void changeDataMode(m)} disabled={shelfBusy}
                className={`text-xs px-4 py-2 rounded-lg border transition text-left disabled:opacity-50 ${dataMode === m ? 'border-sky-400 bg-sky-50 text-sky-700' : 'border-slate-200 text-slate-500 hover:border-sky-300'}`}>
                <div className="font-medium flex items-center gap-1.5">{shelfBusy && dataMode !== m ? <Loader size={12} className="animate-spin" /> : null}{label}{dataMode === m && <span className="text-[10px] px-1.5 py-0.5 rounded bg-sky-100">当前</span>}</div>
                <div className="text-[10px] text-slate-400 mt-0.5">{tip}</div>
              </button>
            ))}
            <span className="text-[11px] text-slate-400 ml-auto">已发布 {rolePkgs.filter(p => p.origin === 'published').length} 个数字员工 · 其中 {rolePkgs.filter(p => p.origin === 'published' && (p.published?.visibility ?? '企业内') === '企业内').length} 个已上架（企业内可见）</span>
          </div>
        </div>
      )}

      {/* 统一角色卡网格 */}
      <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
        {shownPkg.map((p) => {
          const meta = ORIGIN_META[p.origin ?? 'template']
          const cmds = p.manifest.actions.commands ?? []
          const schs = p.manifest.actions.schedules ?? []
          const chs = p.manifest.sources.channels ?? []
          const vis = p.published?.visibility ?? '企业内'
          return (
            <div key={p.id} className={`bg-white rounded-xl border p-5 hover:shadow-md transition ${p.origin === 'published' ? 'border-emerald-200 ring-1 ring-emerald-50' : p.origin === 'engine' && p.virtual ? 'border-amber-200 border-dashed' : 'border-slate-200/80'}`}>
              <div className="flex items-start justify-between mb-2">
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className={`w-9 h-9 rounded-lg bg-gradient-to-br ${meta.grad} text-white flex items-center justify-center shrink-0`}>
                    {p.origin === 'engine' ? <Cpu size={16} /> : p.origin === 'published' ? <Rocket size={16} /> : <Package size={16} />}
                  </div>
                  <div className="min-w-0">
                    <div className="font-medium text-slate-800 text-sm truncate">{p.name}</div>
                    <code className="text-[10px] text-slate-400">{p.id}</code>
                  </div>
                </div>
                <span className={`text-[10px] px-2 py-0.5 rounded-full border shrink-0 ${meta.cls}`}>{meta.label}</span>
              </div>
              <p className="text-xs text-slate-500 leading-relaxed mb-3 min-h-[32px] line-clamp-2">{p.description || '（人设待补）'}</p>
              <div className="flex gap-1.5 flex-wrap mb-3">
                {p.published && <span className="text-[10px] px-2 py-0.5 rounded bg-emerald-50 border border-emerald-100 text-emerald-600">{p.published.visibility ?? '企业内'}</span>}
                {cmds.length > 0 && <span className="text-[10px] px-2 py-0.5 rounded bg-slate-50 border border-slate-100 text-slate-500">命令 {cmds.length}</span>}
                {schs.length > 0 && <span className="text-[10px] px-2 py-0.5 rounded bg-slate-50 border border-slate-100 text-slate-500">调度 {schs.filter((x) => x.enabled !== false).length}/{schs.length}</span>}
                {chs.length > 0 && <span className="text-[10px] px-2 py-0.5 rounded bg-slate-50 border border-slate-100 text-slate-500">通道 {chs.map((c) => c.platform).join('/')}</span>}
                {p.issues.length > 0 && <span className="text-[10px] px-2 py-0.5 rounded bg-red-50 text-red-600 border border-red-100">校验未过</span>}
              </div>
              <div className="flex gap-2 pt-3 border-t border-slate-50 flex-wrap">
                {p.origin === 'published' && (
                  <>
                    <button onClick={() => { setForm({ ...blank, name: p.name, description: p.description, prompt: p.prompt, category: p.published?.category ?? '知识服务', tags: p.published?.tags ?? [] }); setEditId(p.id); setView('edit') }}
                      className="flex-1 text-xs py-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 flex items-center justify-center gap-1"><PenLine size={12} />编辑</button>
                    <button onClick={() => { setPkgId(p.id); setView('pkg') }}
                      className="flex-1 text-xs py-1.5 rounded-lg border border-violet-200 text-violet-600 hover:bg-violet-50 flex items-center justify-center gap-1"><Package size={12} />角色包</button>
                    {isAdmin && (
                      <button title={vis === '企业内' ? '撤下市场：可见范围改为「仅自己」，智能体市场不再对普通用户展示' : '上架市场：可见范围改为「企业内」，普通用户在智能体市场可见可用'}
                        onClick={() => { if (window.confirm(vis === '企业内' ? `撤下「${p.name}」的市场上架？普通用户将不可见（对话工作台自己仍可用）。` : `将「${p.name}」上架智能体市场？普通用户将可见可用。`)) void toggleShelf(p.id, p.name, vis) }}
                        disabled={shelfBusy}
                        className={`text-xs py-1.5 px-3 rounded-lg border flex items-center gap-1 disabled:opacity-50 ${vis === '企业内' ? 'border-emerald-200 text-emerald-600 hover:bg-emerald-50' : 'border-sky-200 text-sky-600 hover:bg-sky-50'}`}>
                        <Store size={12} />{vis === '企业内' ? '撤下市场' : '上架市场'}
                      </button>
                    )}
                    <button title="下架：摘除发布账本（角色包保留，回到站点定制态）"
                      onClick={() => { if (window.confirm(`下架「${p.name}」？角色包保留，工作台/市场将不可再对话。`)) void deleteSkill(p.id).then(() => { refresh(); refreshPkgs(); setBanner(`「${p.name}」已下架——角色包保留，可重新发布`) }).catch((err) => setPubError(String((err as Error).message ?? err))) }}
                      className="text-xs py-1.5 px-3 rounded-lg border border-slate-200 text-slate-400 hover:text-amber-600 hover:border-amber-200"><Undo2 size={12} /></button>
                  </>
                )}
                {p.origin === 'site' && (
                  <>
                    <button onClick={() => { setPkgId(p.id); setView('pkg') }}
                      className="flex-1 text-xs py-1.5 rounded-lg border border-violet-200 text-violet-600 hover:bg-violet-50 flex items-center justify-center gap-1"><PenLine size={12} />编辑角色包</button>
                    <button onClick={() => publishPrefill(p)}
                      className="flex-1 text-xs py-1.5 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 flex items-center justify-center gap-1"><Rocket size={12} />发布上架</button>
                  </>
                )}
                {(p.origin === 'template' || (p.origin === 'engine' && !p.virtual)) && (
                  <button onClick={() => { setPkgId(p.id); setView('pkg') }}
                    className="flex-1 text-xs py-1.5 rounded-lg border border-violet-200 text-violet-600 hover:bg-violet-50 flex items-center justify-center gap-1"><PenLine size={12} />配置（自动站点化）</button>
                )}
                {p.origin === 'site' && (
                  <button title="删除站点定制版：模板来源回落底座模板，市场安装的回落引擎虚拟卡"
                    onClick={() => { if (window.confirm(`删除「${p.name}」的站点定制版？`)) void revertRolePackage(p.id).then(() => { refreshPkgs(); setBanner(`「${p.name}」站点定制版已删除`) }).catch((err) => setPubError(String((err as Error).message ?? err))) }}
                    className="text-xs py-1.5 px-3 rounded-lg border border-slate-200 text-slate-400 hover:text-amber-600 hover:border-amber-200"><Undo2 size={12} /></button>
                )}
                {p.origin === 'site' && isAdmin && (
                  <button title="提升为出厂模板（M-C）：把站点定制版正文写回 packages/role-kit/roles/<id>/SKILL.md，需 git PR 人审后随版本分发"
                    onClick={() => void promote(p)} disabled={promoteBusy === p.id}
                    className="flex-1 text-xs py-1.5 rounded-lg border border-fuchsia-200 text-fuchsia-600 hover:bg-fuchsia-50 disabled:opacity-50 flex items-center justify-center gap-1">
                    {promoteBusy === p.id ? <Loader size={12} className="animate-spin" /> : <ArrowUpFromLine size={12} />}提升为模板
                  </button>
                )}
                {p.origin !== 'engine' && (
                  <button title="导出 ElizaOS character file（官方 schema，settings.aigility 携带回转字段）"
                    onClick={() => { void fetchRoleEliza(p.id).then((c) => {
                      const blob = new Blob([JSON.stringify(c, null, 2)], { type: 'application/json' })
                      const a = document.createElement('a')
                      a.href = URL.createObjectURL(blob)
                      a.download = `${p.id}.character.json`
                      a.click()
                      URL.revokeObjectURL(a.href)
                    }).catch((err) => setPubError(String((err as Error).message ?? err))) }}
                    className="text-xs py-1.5 px-3 rounded-lg border border-slate-200 text-slate-400 hover:text-slate-700"><Download size={12} /></button>
                )}
                {p.origin === 'engine' && p.virtual && (
                  <button onClick={() => void forkEngine(p)} disabled={forkBusy === p.id}
                    className="flex-1 text-xs py-1.5 rounded-lg bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-50 flex items-center justify-center gap-1">
                    {forkBusy === p.id ? <Loader size={12} className="animate-spin" /> : <Plus size={12} />}定制副本
                  </button>
                )}
                {p.origin !== 'engine' && (
                  <button title="导出角色包 JSON（可直接分享/导入）" onClick={() => exportPkg(p)}
                    className="text-xs py-1.5 px-3 rounded-lg border border-slate-200 text-slate-400 hover:text-slate-700"><Save size={12} /></button>
                )}
              </div>
            </div>
          )
        })}
        {shownDemo.map(a => (
          <div key={a.id} className="bg-white rounded-xl border border-slate-200/80 p-5 hover:shadow-md transition opacity-90">
            <div className="flex items-start justify-between mb-2">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-slate-400 to-slate-500 text-white flex items-center justify-center"><Bot size={16} /></div>
                <div>
                  <div className="font-medium text-slate-800 text-sm">{a.name}</div>
                  <div className="text-[11px] text-slate-400">{a.category} · 更新 {a.updatedAt}</div>
                </div>
              </div>
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-500">演示模板</span>
            </div>
            <p className="text-xs text-slate-500 leading-relaxed mb-3 min-h-[32px]">{a.description}</p>
            <div className="flex gap-1.5 flex-wrap mb-3">
              {a.tags.map((t: string) => <span key={t} className="text-[10px] px-2 py-0.5 rounded bg-slate-50 border border-slate-100 text-slate-500">{t}</span>)}
            </div>
            <div className="flex gap-2 pt-3 border-t border-slate-50">
              <button onClick={() => openEdit(a)}
                className="flex-1 text-xs py-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 flex items-center justify-center gap-1"><PenLine size={12} />以此为基础新建</button>
            </div>
          </div>
        ))}
        {shownPkg.length === 0 && shownDemo.length === 0 && (
          <div className="md:col-span-2 xl:col-span-3 bg-white rounded-xl border border-dashed border-slate-200/80 p-16 text-center">
            <SearchX size={28} className="text-slate-300 mx-auto mb-3" />
            <div className="text-sm text-slate-500">该生命周期下暂无角色</div>
          </div>
        )}
      </div>
      <style>{`@keyframes fadeSlide { from { opacity: 0; transform: translateY(4px);} to { opacity: 1; transform: none; } }`}</style>
    </div>
  )
}
