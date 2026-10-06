/**
 * OrchestrationPage — 编排管理（数据面工作流统一可视化编排入口）
 *
 * v2：画布与属性面板统一为 @aigility-harness/workflow-studio 的 WorkflowYamlEditor
 * （与智能体工厂弹窗、项目小助理配置页同一实现）——gyzy 移植画布（自由拖拽/贝塞尔连线/
 * 节点库拖入/端口建边）+ workflow-doc 保守写回引擎（system_prompt/conditional_edges/
 * 注释零破坏；旧版 js-yaml 全量 dump 会洗掉整份文件注释，已被取代）。
 * 本页只保留：工作流清单选择 + 编辑器装配；数据源 = 平台 flows/:id（服务端结构校验）。
 */
import { useCallback, useEffect, useState } from 'react'
import { fetchFlows, fetchFlowYaml, saveFlowYaml, type FlowInfo } from '../lib/harness'
import { WorkflowYamlEditor } from '@aigility-harness/workflow-studio'
import { GitBranch, Loader2, AlertTriangle } from 'lucide-react'

export default function OrchestrationPage() {
  const [flows, setFlows] = useState<FlowInfo[]>([])
  const [currentId, setCurrentId] = useState<string>('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const loadList = useCallback(async () => {
    try {
      const fs = await fetchFlows()
      setFlows(fs)
      if (fs.length) setCurrentId((cur) => cur || fs[0].id)
    } catch (e) { setError(String(e)) }
  }, [])
  useEffect(() => { loadList() }, [loadList])

  const pick = (id: string) => { setCurrentId(id); setBusy(true); setError(''); setTimeout(() => setBusy(false), 300) }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-800">编排管理</h1>
          <p className="text-sm text-slate-500 mt-1">数据面工作流可视化编排（统一 Studio）：节点增删/连线/旁路与端口建边 —— 保守写回，system_prompt 与条件边零破坏，保存走结构校验</p>
        </div>
      </div>

      {error && <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-2.5 text-xs text-red-600 flex items-center gap-2"><AlertTriangle size={13} />{error}</div>}

      <div className="flex gap-4 items-start">
        {/* 左：工作流清单 */}
        <div className="w-60 shrink-0 space-y-2">
          <div className="text-[11px] font-medium text-slate-400 px-1">工作流（数据面 YAML）</div>
          {flows.map((f) => (
            <button key={f.id} onClick={() => pick(f.id)}
              className={`w-full text-left rounded-xl border px-3.5 py-3 transition ${currentId === f.id ? 'border-violet-300 ring-1 ring-violet-100 bg-violet-50/40' : 'bg-white border-slate-200/80 hover:border-violet-200'}`}>
              <div className="flex items-center gap-2">
                <GitBranch size={13} className={currentId === f.id ? 'text-violet-600' : 'text-slate-400'} />
                <span className="text-xs font-medium text-slate-700 truncate">{f.name}</span>
                {f.builtin && <span className="text-[9px] px-1.5 py-0.5 rounded bg-slate-800 text-white shrink-0">内置</span>}
              </div>
              <code className="text-[10px] text-slate-400 block mt-1 truncate">{f.source}</code>
            </button>
          ))}
          {flows.length === 0 && <div className="text-xs text-slate-400 px-1 py-4">加载中…</div>}
          <div className="text-[10px] text-slate-300 px-1 pt-2 leading-relaxed">
            新工作流由任务板「workflow 执行器」Plan 拆解产生（人审后入库）；项目小助理的 chat-briefing 在其配置页或智能体工厂弹窗编排
          </div>
        </div>

        {/* 右：统一 Studio 编辑器 */}
        <div className="flex-1 min-w-0">
          {currentId ? (
            busy ? (
              <div className="bg-white rounded-xl border border-slate-200/80 p-16 text-center text-sm text-slate-400"><Loader2 size={20} className="animate-spin mx-auto" /></div>
            ) : (
              <WorkflowYamlEditor key={currentId}
                title={`flows/${currentId}.yaml · 平台工作流`}
                load={() => fetchFlowYaml(currentId)}
                save={(t) => saveFlowYaml(currentId, t)}
              />
            )
          ) : (
            <div className="bg-white rounded-xl border border-slate-200/80 p-16 text-center text-sm text-slate-400">选择左侧工作流加载画布</div>
          )}
        </div>
      </div>
    </div>
  )
}
