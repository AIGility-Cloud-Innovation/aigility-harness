import { useEffect, useState } from 'react'
import { marketAgents, agentCats, type MarketAgent } from '../mock/data'
import { getCurrentUser } from '../lib/api'
import { fetchRegistry, fetchMarketConfig, type MarketDataMode, type SkillInfo } from '../lib/harness'
import { Search, Star, ArrowLeft, Bot, CheckCircle2, BookOpen, Wrench, Play, Store, Settings2, ScrollText, ShieldCheck } from 'lucide-react'

/**
 * 智能体市场 = 面向普通用户的应用货架，内容由管理员控制：
 *   - 真实数据模式：只显示工厂发布且可见范围=企业内 的数字员工（选企业内可见 = 上架市场）；
 *   - 模拟数据模式（缺省，管理员未设置时）：只显示演示模板，不暴露工厂/引擎内部能力。
 * 引擎原生角色（@persona/*）属引擎内部能力，不再进市场。
 */
export default function MarketPage({ go }: { go: (p: string) => void }) {
  const [cat, setCat] = useState('全部')
  const [kw, setKw] = useState('')
  const [detail, setDetail] = useState<MarketAgent | null>(null)
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [dataMode, setDataMode] = useState<MarketDataMode>('mock')

  useEffect(() => {
    fetchRegistry().then(r => setSkills(r.skills)).catch(() => {})
    fetchMarketConfig().then(c => setDataMode(c.dataMode)).catch(() => {})
  }, [])

  const isAdmin = !!getCurrentUser()?.isAdmin
  const real = dataMode === 'real'
  // 真实数据货架 = 工厂发布且可见范围=企业内（「仅自己」不上架市场）
  const shelf = skills
    .filter(s => s.visibility === '企业内')
    .filter(s => (cat === '全部' || s.category === cat) &&
      (!kw || s.name.includes(kw) || s.description.includes(kw) || s.tags.some(t => t.includes(kw))))
  const list = marketAgents.filter(a =>
    (cat === '全部' || a.cat === cat) &&
    (!kw || a.name.includes(kw) || a.desc.includes(kw) || a.tags.some(t => t.includes(kw))))

  if (detail) return <AgentDetail agent={detail} back={() => setDetail(null)} />

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-800">智能体市场</h1>
          <p className="text-sm text-slate-500 mt-1">
            {real
              ? '智能体工厂发布上架的数字员工 —— 选择即可直接对话使用，全部私有化运行'
              : '当前展示演示模板（模拟数据）；管理员上架后，这里显示真实可用的数字员工'}
          </p>
        </div>
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input value={kw} onChange={e => setKw(e.target.value)} placeholder="搜索智能体名称、能力标签…"
            className="pl-9 pr-3 py-2 text-sm border border-slate-200 rounded-lg w-64 focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-300" />
        </div>
      </div>

      {isAdmin && !real && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-xs text-amber-700 flex items-center gap-2 flex-wrap">
          <ShieldCheck size={14} />
          <span>管理员提示：市场处于<b>模拟数据模式</b>，普通用户看到的是演示模板。到智能体工厂切换为「真实数据」，并把发布的数字员工可见范围设为「企业内」即可上架。</span>
          <button onClick={() => go('studio')} className="ml-auto text-xs px-3 py-1.5 rounded-lg bg-amber-500 text-white hover:bg-amber-600">去智能体工厂配置</button>
        </div>
      )}

      <div className="flex gap-2 flex-wrap">
        {agentCats.map(c => (
          <button key={c} onClick={() => setCat(c)}
            className={`text-xs px-3.5 py-1.5 rounded-full transition ${cat === c ? 'bg-blue-600 text-white' : 'bg-white border border-slate-200 text-slate-600 hover:border-blue-300'}`}>{c}</button>
        ))}
        <span className="text-xs text-slate-400 self-center ml-auto">
          {real ? `${shelf.length} 个已上架智能体 · 真实数据` : `${list.length} 个演示模板 · 模拟数据`}
        </span>
      </div>

      {real ? (
        /* 真实数据模式：工厂发布（企业内可见）的数字员工货架 */
        shelf.length > 0 ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Store size={14} className="text-sky-500" />
              <h2 className="text-sm font-semibold text-slate-700">已上架 · 数字员工</h2>
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-sky-50 text-sky-600 border border-sky-100">工厂发布 · 真对话 · 对话工作台可直接切换</span>
            </div>
            <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
              {shelf.map(s => (
                <div key={s.id} className="bg-white rounded-xl border border-sky-200 ring-1 ring-sky-100/60 p-5 hover:shadow-md transition flex flex-col">
                  <div className="flex items-start justify-between mb-2.5">
                    <div className="flex items-center gap-2.5">
                      <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-blue-500 to-sky-500 text-white flex items-center justify-center"><Bot size={17} /></div>
                      <div>
                        <div className="font-medium text-slate-800 text-sm">{s.name}</div>
                        <div className="text-[10px] text-slate-400 mt-0.5">skill_id={s.id} · 更新 {s.updatedAt}</div>
                      </div>
                    </div>
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-600">已上架</span>
                  </div>
                  <p className="text-xs text-slate-500 leading-relaxed mb-3 flex-1">{s.description}</p>
                  <div className="flex gap-1.5 flex-wrap mb-4">
                    {s.tags.map(t => <span key={t} className="text-[10px] px-2 py-0.5 rounded bg-slate-50 border border-slate-100 text-slate-500">{t}</span>)}
                  </div>
                  <div className="flex gap-2 pt-3 border-t border-slate-50">
                    <button onClick={() => go('agent')} className="flex-1 text-xs py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 flex items-center justify-center gap-1"><Play size={12} />立即使用</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="bg-white rounded-xl border border-dashed border-slate-200 p-16 text-center">
            <Store size={28} className="text-slate-300 mx-auto mb-3" />
            <div className="text-sm text-slate-500">暂无上架的智能体</div>
            <div className="text-xs text-slate-400 mt-1.5">
              {isAdmin
                ? '到智能体工厂发布数字员工，可见范围选「企业内」即自动上架本市场'
                : '管理员正在筹备中，敬请期待'}
            </div>
            {isAdmin && (
              <button onClick={() => go('studio')} className="mt-4 text-xs px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700">去智能体工厂发布</button>
            )}
          </div>
        )
      ) : (
        /* 模拟数据模式：官方演示模板库（Mock） */
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <BookOpen size={14} className="text-slate-400" />
            <h2 className="text-sm font-semibold text-slate-700">官方模板库</h2>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-500">模拟数据 · 演示效果</span>
          </div>
          <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
            {list.map(a => (
              <div key={a.id} className="bg-white rounded-xl border border-slate-200/80 p-5 hover:shadow-md transition flex flex-col">
                <div className="flex items-start justify-between mb-2.5">
                  <div className="flex items-center gap-2.5">
                    <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-blue-500 to-sky-500 text-white flex items-center justify-center"><Bot size={17} /></div>
                    <div>
                      <div className="font-medium text-slate-800 text-sm">{a.name}</div>
                      <div className="flex items-center gap-1 mt-0.5">
                        <Star size={11} className="text-amber-400 fill-amber-400" />
                        <span className="text-xs text-slate-500">{a.rating}</span>
                        <span className="text-[10px] text-slate-300 mx-1">·</span>
                        <span className="text-xs text-slate-400">{a.calls} 次调用</span>
                      </div>
                    </div>
                  </div>
                  <span className={`text-[10px] px-2 py-0.5 rounded-full ${a.status === '运行中' ? 'bg-emerald-50 text-emerald-600' : 'bg-amber-50 text-amber-600'}`}>{a.status}</span>
                </div>
                <p className="text-xs text-slate-500 leading-relaxed mb-3 flex-1">{a.desc}</p>
                <div className="flex gap-1.5 flex-wrap mb-4">
                  {a.tags.map(t => <span key={t} className="text-[10px] px-2 py-0.5 rounded bg-slate-50 border border-slate-100 text-slate-500">{t}</span>)}
                </div>
                <div className="flex gap-2 pt-3 border-t border-slate-50">
                  <button onClick={() => go('agent')} className="flex-1 text-xs py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 flex items-center justify-center gap-1"><Play size={12} />立即使用</button>
                  <button onClick={() => setDetail(a)} className="flex-1 text-xs py-2 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50">详情</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── 官方模板详情：对话式交互 + 引用来源可溯 + 配置/工具/知识库/日志（演示数据） ───
function AgentDetail({ agent, back }: { agent: MarketAgent; back: () => void }) {
  const [tab, setTab] = useState<'chat' | 'history'>('chat')
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3 flex-wrap">
        <button onClick={back} className="w-8 h-8 rounded-lg border border-slate-200 bg-white flex items-center justify-center text-slate-500 hover:bg-slate-50"><ArrowLeft size={15} /></button>
        <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-blue-500 to-sky-500 text-white flex items-center justify-center"><Bot size={17} /></div>
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-semibold text-slate-800">{agent.name}</h1>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-600">{agent.status}</span>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-500">模拟数据</span>
          </div>
          <p className="text-xs text-slate-400 mt-0.5">{agent.cat} · 评分 {agent.rating} · {agent.calls} 次调用</p>
        </div>
        <div className="ml-auto flex bg-slate-100 rounded-lg p-1">
          {[['chat', '能力详情'], ['history', '历史任务']].map(([k, l]) => (
            <button key={k} onClick={() => setTab(k as any)}
              className={`text-xs px-4 py-1.5 rounded-md transition ${tab === k ? 'bg-white text-slate-800 shadow-sm font-medium' : 'text-slate-500'}`}>{l}</button>
          ))}
        </div>
      </div>

      {tab === 'history' ? (
        <div className="bg-white rounded-xl border border-slate-200/80 p-5">
          <div className="overflow-x-auto -mx-1 px-1"><table className="w-full text-sm">
            <thead><tr className="text-xs text-slate-400 border-b border-slate-100">
              <th className="text-left font-medium py-2.5">任务</th><th className="text-left font-medium py-2.5">发起时间</th><th className="text-left font-medium py-2.5">耗时</th><th className="text-left font-medium py-2.5">状态</th>
            </tr></thead>
            <tbody>
              {[
                { t: '汇总华精细化工本周设备巡检异常', time: '08-28 09:12', cost: '42s' },
                { t: '生成燃气电厂 DCS 周报初稿', time: '08-27 16:40', cost: '1m 18s' },
                { t: '比对轩怡装饰 8 月客户跟进记录', time: '08-27 11:05', cost: '33s' },
              ].map((r, i) => (
                <tr key={i} className="border-b border-slate-50 last:border-0">
                  <td className="py-3 text-slate-700">{r.t}</td>
                  <td className="py-3 text-xs text-slate-400">{r.time}</td>
                  <td className="py-3 text-xs text-slate-400">{r.cost}</td>
                  <td className="py-3"><span className="text-xs px-2 py-0.5 rounded bg-emerald-50 text-emerald-600 flex items-center gap-1 w-fit"><CheckCircle2 size={11} />已完成</span></td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </div>
      ) : (
        <div className="grid lg:grid-cols-[1fr_320px] gap-4">
          {/* 对话演示 */}
          <div className="bg-white rounded-xl border border-slate-200/80 p-5 space-y-4">
            <div className="flex justify-end">
              <div className="bg-blue-600 text-white text-sm rounded-2xl rounded-tr-sm px-4 py-2.5 max-w-[75%]">2 号锅炉今天有没有异常？后续怎么安排？</div>
            </div>
            <div className="flex gap-3">
              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-sky-500 text-white flex items-center justify-center shrink-0 mt-0.5"><Bot size={15} /></div>
              <div className="flex-1 space-y-3 max-w-[88%]">
                <div className="text-xs text-slate-400">{agent.name} · 回答已按置信度校验（0.91 ≥ 阈值 0.85，直接输出）</div>
                <div className="text-sm text-slate-700 leading-relaxed bg-slate-50/80 border border-slate-100 rounded-xl px-4 py-3">
                  2 号锅炉今日 11:23 出现主汽温度 578.2℃，超一级报警线 3.2℃，持续 72 秒后回落，已按规程投入减温水并减负荷 5%。检修建议：本周五低负荷窗口安排减温水调节阀检查，预估工时 2 小时。
                </div>
                {/* 引用来源可溯 */}
                <div>
                  <div className="text-xs text-slate-400 mb-1.5">引用来源（点击可下钻原文）</div>
                  <div className="flex gap-2 flex-wrap">
                    {['DCS 实时点位 #2B-TIC-301', '锅炉运行规程 4.2 节', '记忆流 · 2 号锅炉历史报警画像'].map(s => (
                      <span key={s} className="text-xs px-2.5 py-1.5 rounded-lg bg-blue-50 text-blue-600 border border-blue-100 flex items-center gap-1 cursor-pointer hover:bg-blue-100"><BookOpen size={11} />{s}</span>
                    ))}
                  </div>
                </div>
                <div className="text-[11px] text-slate-400">要与此类能力真实对话，请管理员在「智能体工厂」发布数字员工并上架市场。</div>
              </div>
            </div>
          </div>

          {/* 右侧配置面板 */}
          <div className="space-y-4">
            <div className="bg-white rounded-xl border border-slate-200/80 p-5">
              <div className="flex items-center gap-2 mb-3"><Settings2 size={14} className="text-slate-400" /><h4 className="text-sm font-medium text-slate-800">配置参数</h4></div>
              <div className="space-y-2.5 text-xs">
                {[['编排方式', '单 Agent（ReAct）'], ['模型', 'Kimi K3 · 私有推理'], ['置信度阈值', '0.85（低于转人工）'], ['温度', '0.3'], ['最大工具调用轮次', '8']].map(([k, v]) => (
                  <div key={k} className="flex justify-between"><span className="text-slate-400">{k}</span><span className="text-slate-700 font-medium">{v}</span></div>
                ))}
              </div>
            </div>
            <div className="bg-white rounded-xl border border-slate-200/80 p-5">
              <div className="flex items-center gap-2 mb-3"><Wrench size={14} className="text-slate-400" /><h4 className="text-sm font-medium text-slate-800">相关工具</h4></div>
              <div className="flex gap-1.5 flex-wrap">
                {['timem.memory.search', 'timem.rule.match', 'dcs.point.read', 'scada.device.list'].map(t => (
                  <code key={t} className="text-[10px] px-2 py-1 rounded bg-sky-50 text-sky-600 border border-sky-100">{t}</code>
                ))}
              </div>
            </div>
            <div className="bg-white rounded-xl border border-slate-200/80 p-5">
              <div className="flex items-center gap-2 mb-3"><BookOpen size={14} className="text-slate-400" /><h4 className="text-sm font-medium text-slate-800">关联知识库</h4></div>
              <div className="space-y-2">
                {[['锅炉运行规程库', '90.1%'], ['流程制度知识库', '87.2%'], ['通用办公知识库', '92.4%']].map(([n, h]) => (
                  <div key={n} className="flex justify-between text-xs"><span className="text-slate-600">{n}</span><span className="text-slate-400">命中率 {h}</span></div>
                ))}
              </div>
            </div>
            <div className="bg-white rounded-xl border border-slate-200/80 p-5">
              <div className="flex items-center gap-2 mb-3"><ScrollText size={14} className="text-slate-400" /><h4 className="text-sm font-medium text-slate-800">运行日志</h4></div>
              <div className="space-y-2 text-[11px] font-mono text-slate-500">
                <div>10:42:18 <span className="text-blue-600">memory.search</span> 命中 3 条</div>
                <div>10:42:19 <span className="text-blue-600">dcs.point.read</span> #2B-TIC-301</div>
                <div>10:42:21 <span className="text-emerald-600">置信度 0.91</span> ≥ 0.85 直接输出</div>
                <div>10:42:21 <span className="text-slate-400">写入记忆流 L1 碎片</span></div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
