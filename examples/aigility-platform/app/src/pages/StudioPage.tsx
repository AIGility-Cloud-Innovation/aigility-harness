import { useEffect, useState } from 'react'
import { studioSeed, agentCats, type StudioAgent } from '../mock/data'
import RoleDshEditor from '../components/RoleDshEditor'
import RolePackageEditor from '../components/RolePackageEditor'
import { publishSkill, deleteSkill, fetchRegistry, createDshSkill, fetchLlmModels, fetchRolePackages, type RolePackageInfo } from '../lib/harness'
import { Plus, Bot, Rocket, Trash2, PenLine, CheckCircle2, Loader, Store, SearchX, User, Wrench, Radio, Send, Cpu, ListTree, Package, Terminal, CalendarClock } from 'lucide-react'

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
      setBanner(`「${skill.name}」发布成功（skill_id=${skill.id}，已注册 @persona/aigility-agent）—— 对话工作台与智能体市场立即可用${dshNote}`)
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
              <div className="flex gap-2">
                {(['企业内', '仅自己'] as const).map(v => (
                  <button key={v} onClick={() => set('visibility', v)}
                    className={`text-xs px-4 py-2 rounded-lg border transition ${form.visibility === v ? 'border-blue-400 bg-blue-50 text-blue-700' : 'border-slate-200 text-slate-500'}`}>{v}</button>
                ))}
              </div>
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
              {pubBusy ? <Loader size={15} className="animate-spin" /> : <Rocket size={15} />}{pubBusy ? '发布中…' : '发布到对话工作台与市场'}
            </button>
          </div>
        </div>
        </div>
        <style>{`@keyframes fadeSlide { from { opacity: 0; transform: translateY(4px);} to { opacity: 1; transform: none; } }`}</style>
      </div>
      </div>
    )
  }

  // ── 列表视图 ──
  const shown = agents.filter(a => filter === '全部' || a.status === filter)

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-800">智能体工厂</h1>
          <p className="text-sm text-slate-500 mt-1">数字员工的角色产线：人设、能力、通道一站配齐 —— 发布即真注册（@persona/aigility-agent）</p>
        </div>
        <button onClick={openNew} className="text-sm px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 flex items-center gap-1.5"><Plus size={15} />新建数字员工</button>
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
          <div className="text-sm text-slate-500">暂无{filter}的数字员工</div>
          <button onClick={openNew} className="mt-4 text-xs px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700">新建第一个</button>
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
                  {a.status}{a.src === 'factory' ? ' · 真注册' : ' · 演示'}
                </span>
              </div>
              <p className="text-xs text-slate-500 leading-relaxed mb-3 min-h-[32px]">{a.description}</p>
              <div className="flex gap-1.5 flex-wrap mb-3">
                {a.tags.map((t: string) => <span key={t} className="text-[10px] px-2 py-0.5 rounded bg-slate-50 border border-slate-100 text-slate-500">{t}</span>)}
              </div>
              <div className="text-[11px] text-slate-400 mb-3">
                {a.src === 'factory'
                  ? <>角色 ID <code className="text-sky-600">{a.id}</code> · 编辑内可配 IM 能力与通道</>
                  : '演示数据 · 可作模板复用'}
              </div>
              <div className="flex gap-2 pt-3 border-t border-slate-50">
                <button onClick={() => openEdit(a)}
                  className="flex-1 text-xs py-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 flex items-center justify-center gap-1"><PenLine size={12} />{a.src === 'factory' ? '编辑' : '以此为基础新建'}</button>
                <button onClick={() => void removeAgent(a)}
                  className="text-xs py-1.5 px-3 rounded-lg border border-slate-200 text-slate-400 hover:text-red-500 hover:border-red-200"><Trash2 size={12} /></button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 角色包（roles/ 目录）：可移植角色单元 —— 命令面板/调度器在此配置 */}
      <div>
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <Package size={15} className="text-violet-500" />
          <h2 className="text-sm font-semibold text-slate-700">角色包 · roles/ 目录</h2>
          <span className="text-[11px] text-slate-400">可移植五要素单元（SKILL.md 人设 + role.json）；保存即原子写回包目录，git 可 diff/回滚</span>
        </div>
        <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
          {rolePkgs.map((p) => {
            const cmds = p.manifest.actions.commands ?? []
            const schs = p.manifest.actions.schedules ?? []
            return (
              <div key={p.id} className="bg-white rounded-xl border border-violet-200 ring-1 ring-violet-50 p-5 hover:shadow-md transition">
                <div className="flex items-start justify-between mb-2">
                  <div className="flex items-center gap-2.5">
                    <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-violet-500 to-purple-500 text-white flex items-center justify-center"><Package size={16} /></div>
                    <div>
                      <div className="font-medium text-slate-800 text-sm">{p.name}</div>
                      <code className="text-[10px] text-slate-400">{p.id}</code>
                    </div>
                  </div>
                  <span className={`text-[10px] px-2 py-0.5 rounded-full ${p.layer === 'public' ? 'bg-violet-50 text-violet-600' : 'bg-sky-50 text-sky-600'}`}>
                    {p.layer === 'public' ? '公共包' : '站点包'}
                  </span>
                </div>
                <p className="text-xs text-slate-500 leading-relaxed mb-3 min-h-[32px]">{p.description}</p>
                <div className="flex gap-1.5 flex-wrap mb-3">
                  <span className="text-[10px] px-2 py-0.5 rounded bg-slate-50 border border-slate-100 text-slate-500 flex items-center gap-1"><Terminal size={9} />命令 {cmds.length}</span>
                  <span className="text-[10px] px-2 py-0.5 rounded bg-slate-50 border border-slate-100 text-slate-500 flex items-center gap-1"><CalendarClock size={9} />调度 {schs.filter((s) => s.enabled !== false).length}/{schs.length}</span>
                  {(p.manifest.actions.tools ?? []).length > 0 && (
                    <span className="text-[10px] px-2 py-0.5 rounded bg-slate-50 border border-slate-100 text-slate-500">工具 {(p.manifest.actions.tools ?? []).length}</span>
                  )}
                  {p.issues.length > 0 && (
                    <span className="text-[10px] px-2 py-0.5 rounded bg-red-50 text-red-600 border border-red-100">校验未过</span>
                  )}
                </div>
                <div className="flex gap-2 pt-3 border-t border-slate-50">
                  <button onClick={() => { setPkgId(p.id); setView('pkg') }}
                    className="flex-1 text-xs py-1.5 rounded-lg border border-violet-200 text-violet-600 hover:bg-violet-50 flex items-center justify-center gap-1"><PenLine size={12} />配置角色包</button>
                </div>
              </div>
            )
          })}
          {rolePkgs.length === 0 && (
            <div className="md:col-span-2 xl:col-span-3 text-xs text-slate-400 px-4 py-8 text-center bg-white rounded-xl border border-dashed border-slate-200">
              roles/ 目录暂无角色包（目录下每个含 SKILL.md + role.json 的子目录即一个包）
            </div>
          )}
        </div>
      </div>
      <style>{`@keyframes fadeSlide { from { opacity: 0; transform: translateY(4px);} to { opacity: 1; transform: none; } }`}</style>
    </div>
  )
}
