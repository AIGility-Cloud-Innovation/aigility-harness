import { useMemo, useState } from 'react'
import EChart from '../components/EChart'
import { processFlow, orgTree } from '../mock/data'
import { FileText, Sparkles, GitBranch, Network, PlusCircle, CheckCircle2 } from 'lucide-react'

export default function ProcessPage({ onGenerateSkill, go, generatedSkills }: { onGenerateSkill: (name: string) => void; go: (p: string) => void; generatedSkills: string[] }) {
  const [parsed, setParsed] = useState(false)
  const [parsing, setParsing] = useState(false)

  const start = () => {
    setParsing(true)
    setTimeout(() => { setParsing(false); setParsed(true) }, 1400)
  }

  const flowOption = useMemo(() => ({
    tooltip: {},
    series: [{
      type: 'graph', layout: 'none', roam: true,
      symbol: 'roundRect', symbolSize: [96, 40],
      label: { show: true, fontSize: 12, color: '#fff' },
      edgeSymbol: ['none', 'arrow'], edgeSymbolSize: 8,
      data: processFlow.nodes.map((n, i) => ({
        ...n,
        x: (i % 5) * 190 + (i >= 5 ? 95 : 0), y: i < 5 ? 80 : 260,
        itemStyle: { color: n.category === 1 ? '#3370FF' : '#64748B', borderRadius: 8 },
      })),
      links: processFlow.edges.map(e => ({
        ...e, lineStyle: { color: e.relation === '整改' ? '#F59E0B' : '#94a3b8', width: 2, curveness: e.relation === '整改' ? 0.4 : 0.05 },
        label: { show: !!e.relation, formatter: e.relation, fontSize: 11, color: '#F59E0B' },
      })),
    }],
  } as any), [])

  const orgOption = useMemo(() => ({
    tooltip: {},
    series: [{
      type: 'tree', roam: true, top: '8%', bottom: '8%',
      symbol: 'roundRect', symbolSize: [14, 14],
      label: { show: true, position: 'right', fontSize: 12, color: '#334155', backgroundColor: '#fff', borderColor: '#e2e8f0', borderWidth: 1, borderRadius: 6, padding: [5, 9] },
      lineStyle: { color: '#cbd5e1', width: 1.5 },
      itemStyle: { color: '#3370FF', borderColor: '#295FEF' },
      expandAndCollapse: false,
      data: [orgTree],
    }],
  } as any), [])

  const skillNodes = ['报价审批', '施工派单', '节点验收']

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-slate-800 flex items-center gap-2">业务流程与组织架构编排<span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 font-normal">产品壳演示 · 五域引擎暂无对应能力，暂不对接</span></h1>
        <p className="text-sm text-slate-500 mt-1">上传制度、流程说明、组织架构等文字资料，自动解析成流程图与架构图，并从流程节点一键生成 Skill</p>
      </div>

      {/* 上传区 */}
      <div className="bg-white rounded-xl border border-slate-200/80 p-5">
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-3 flex-1 min-w-[260px] border border-dashed border-slate-300 rounded-lg px-4 py-3 hover:border-blue-300 hover:bg-blue-50/30 transition cursor-pointer" onClick={start}>
            <FileText size={20} className="text-slate-400" />
            <div>
              <div className="text-sm text-slate-700">轩怡装饰-业务流程与组织架构说明.docx</div>
              <div className="text-xs text-slate-400">支持 Word / PDF / 会议纪要，自动提取流程节点与组织层级</div>
            </div>
          </div>
          <button onClick={start} disabled={parsing}
            className="text-sm px-4 py-2.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1.5">
            <Sparkles size={15} />{parsing ? '正在解析…' : parsed ? '重新解析' : '开始解析'}
          </button>
        </div>
        {parsing && <div className="mt-3 text-xs text-blue-500 animate-pulse">正在识别流程节点、审批环节与组织层级…</div>}
      </div>

      {parsed && (
        <>
          <div className="grid lg:grid-cols-2 gap-4" style={{ animation: 'fadeSlide .4s ease' }}>
            <div className="bg-white rounded-xl border border-slate-200/80 p-5">
              <div className="flex items-center gap-2 mb-2"><GitBranch size={16} className="text-blue-600" /><h3 className="font-medium text-slate-800">业务流程图 · 装修全链路</h3></div>
              <EChart option={flowOption} height={340} />
              <p className="text-xs text-slate-400 mt-1">蓝色为审批/关键节点 · 橙色回路为「验收不通过 → 整改」</p>
            </div>
            <div className="bg-white rounded-xl border border-slate-200/80 p-5">
              <div className="flex items-center gap-2 mb-2"><Network size={16} className="text-sky-600" /><h3 className="font-medium text-slate-800">组织架构图</h3></div>
              <EChart option={orgOption} height={340} />
              <p className="text-xs text-slate-400 mt-1">组织层级自动挂接为数字员工的汇报与派单关系</p>
            </div>
          </div>

          <div className="bg-white rounded-xl border border-slate-200/80 p-5" style={{ animation: 'fadeSlide .5s ease' }}>
            <h3 className="font-medium text-slate-800 mb-1">从流程节点生成 Skill</h3>
            <p className="text-xs text-slate-400 mb-4">系统识别出 3 个适合数字员工承接的节点，确认后生成 Skill 草稿进入编排器</p>
            <div className="grid md:grid-cols-3 gap-4">
              {skillNodes.map(n => (
                <div key={n} className="border border-slate-200 rounded-xl p-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm font-medium text-slate-700">{n}</span>
                    <span className="text-xs px-2 py-0.5 rounded bg-blue-50 text-blue-600">建议 Skill</span>
                  </div>
                  <p className="text-xs text-slate-500 leading-relaxed mb-3">
                    {n === '报价审批' && '读取客户面积与工艺包 → 匹配单价系数 → 生成报价单 → 设计师人审'}
                    {n === '施工派单' && '读取签约订单 → 匹配班组与档期 → 生成派工单 → 项目经理确认'}
                    {n === '节点验收' && '对照验收标准知识库 → 生成验收清单 → 质检填报 → 整改回路触发'}
                  </p>
                  <button onClick={() => onGenerateSkill(n)}
                    className={`w-full text-xs px-3 py-2 rounded-lg flex items-center justify-center gap-1.5 transition ${generatedSkills.includes(n) ? 'bg-emerald-50 text-emerald-600' : 'bg-blue-600 text-white hover:bg-blue-700'}`}>
                    {generatedSkills.includes(n) ? <><CheckCircle2 size={13} />已生成，进入技能管理</> : <><PlusCircle size={13} />生成 Skill</>}
                  </button>
                </div>
              ))}
            </div>
            {generatedSkills.some(n => skillNodes.includes(n)) && (
              <div className="mt-4 flex items-center justify-between bg-sky-50 border border-sky-200 rounded-xl px-4 py-3">
                <span className="text-xs text-sky-700">已生成 {generatedSkills.filter(n => skillNodes.includes(n)).length} 个 Skill 草稿，可在「数字员工 → Skill 编排」中查看、编排与发布</span>
                <button onClick={() => go('agent')} className="text-xs px-3 py-1.5 rounded-lg bg-sky-600 text-white hover:bg-sky-700 shrink-0">去技能管理</button>
              </div>
            )}
          </div>
        </>
      )}
      <style>{`@keyframes fadeSlide { from { opacity: 0; transform: translateY(6px);} to { opacity: 1; transform: none; } }`}</style>
    </div>
  )
}
