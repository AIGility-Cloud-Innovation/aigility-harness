import { useEffect, useState } from 'react'
import { useStore } from '@/store/AppContext'
import { Money } from '@/components/bits'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { fmtMoneyFull, type CaseRef } from '@/types'
import { ArrowLeft, CheckCircle2, Download, Presentation, FileText, Table2, History, MessageSquarePlus, MessagesSquare, GitBranch, CornerDownRight, Blocks, Package, Sparkles, Plus, ChevronRight, Cpu, Loader2, Unplug, BookMarked, Rocket, ScrollText, FileStack } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getHarnessCfg, saveHarnessCfg as persistHarnessCfg, testHarnessConnection, generateProposalDocx } from '@/lib/harness'
import { buildProposalDoc } from '@/lib/proposalDoc'
import { toast } from 'sonner'

const CASE_KIND_META: Record<CaseRef['kind'], { label: string; icon: typeof Rocket; cls: string }> = {
  proposal: { label: '历史方案', icon: FileStack, cls: 'border-blue-200 bg-blue-50 text-[#3370ff]' },
  deployment: { label: '已交付案例', icon: Rocket, cls: 'border-emerald-200 bg-emerald-50 text-emerald-600' },
  knowledge: { label: '知识库', icon: ScrollText, cls: 'border-indigo-200 bg-indigo-50 text-indigo-600' },
}

export function ProposalDetail({ id }: { id: string }) {
  const { proposals, leads, navigate, toggleRule, confirmProposal, addProposalFeedback, respondFeedback, modules, toggleProposalModule, skus, toggleProposalSku, deployments, knowledge, toggleProposalCase } = useStore()
  const p = proposals.find(x => x.id === id)
  const [pendingToggle, setPendingToggle] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [fbOpen, setFbOpen] = useState(false)
  const [fbAuthor, setFbAuthor] = useState('甲方 · ')
  const [fbContent, setFbContent] = useState('')
  const [respondId, setRespondId] = useState<string | null>(null)
  const [changeNote, setChangeNote] = useState('')

  if (!p) return <div className="py-20 text-center text-slate-400">方案不存在</div>
  const lead = leads.find(l => l.id === p.leadId)
  const pendingFb = p.feedbacks.filter(f => f.status === '待处理')

  // 数字员工自动检索相似案例：同行业 / 共用模块 / 知识库命中，人工确认后才进入上下文
  const linkedKeys = new Set(p.caseRefs.map(r => `${r.kind}:${r.id}`))
  const caseRecs: CaseRef[] = []
  proposals.filter(x => x.id !== p.id).forEach(x => {
    const xl = leads.find(l => l.id === x.leadId)
    const shared = x.modules.filter(m => p.modules.includes(m)).map(m => modules.find(mm => mm.id === m)?.name).filter(Boolean)
    const reason = xl && lead && xl.industry === lead.industry ? `同行业 · ${xl.industry}` : shared.length ? `共用模块 · ${shared.slice(0, 2).join('、')}` : ''
    if (reason) caseRecs.push({ kind: 'proposal', id: x.id, title: x.title, reason })
  })
  deployments.forEach(d => {
    const dl = d.leadId ? leads.find(l => l.id === d.leadId) : undefined
    const shared = d.modules.filter(m => p.modules.includes(m)).map(m => modules.find(mm => mm.id === m)?.name).filter(Boolean)
    const reason = dl && lead && dl.industry === lead.industry ? `同行业交付 · ${dl.industry}` : shared.length ? `共用模块 · ${shared.slice(0, 2).join('、')}` : ''
    if (reason) caseRecs.push({ kind: 'deployment', id: d.id, title: `${d.customer} · ${d.site}`, reason })
  })
  knowledge.filter(k => ['node', 'template', 'skill'].includes(k.kind) && k.status === '已采纳').forEach(k => {
    const tagHit = lead && (k.tags ?? []).some(t => lead.industry.includes(t) || t.includes(lead.industry))
    const caseLike = k.title.startsWith('案例') || k.title.startsWith('调研方案')
    if (tagHit || caseLike) caseRecs.push({ kind: 'knowledge', id: k.id, title: k.title, reason: tagHit ? `行业标签匹配 · ${lead!.industry}` : '知识库沉淀 · 可引用素材' })
  })
  const unlinkedRecs = caseRecs.filter(r => !linkedKeys.has(`${r.kind}:${r.id}`)).slice(0, 6)

  const requestToggle = (key: string) => { setPendingToggle(key); setReason('') }
  const confirmToggle = () => {
    if (!pendingToggle || !reason.trim()) return
    toggleRule(p.id, pendingToggle, reason.trim())
    setPendingToggle(null)
  }

  const submitFeedback = () => {
    if (!fbAuthor.trim() || !fbContent.trim()) return
    addProposalFeedback(p.id, fbAuthor.trim(), fbContent.trim())
    setFbOpen(false); setFbContent(''); setFbAuthor('甲方 · ')
  }
  const submitRespond = () => {
    if (!respondId || !changeNote.trim()) return
    respondFeedback(p.id, respondId, changeNote.trim())
    setRespondId(null); setChangeNote('')
  }

  const [exporting, setExporting] = useState<string | null>(null)
  const [harnessOpen, setHarnessOpen] = useState(false)
  const [harnessCfg, setHarnessCfg] = useState(getHarnessCfg)
  const [harnessOk, setHarnessOk] = useState(false)
  const [testing, setTesting] = useState(false)

  // 手工配置了网关 → 探测直连；未配置 → 走同源会话代理（服务端持有主密钥），视为可用
  useEffect(() => {
    if (harnessCfg.url) testHarnessConnection(harnessCfg.url).then(setHarnessOk)
    else setHarnessOk(true)
  }, [harnessCfg.url])

  const realExport = async (kind: 'ppt' | 'word' | 'excel') => {
    if (exporting) return
    setExporting(kind)
    const label = kind === 'ppt' ? '方案 PPT' : kind === 'word' ? '解决方案 Word' : '报价 Excel'
    try {
      // Word 优先移交 D3 文档工人（服务端 doc-worker 确定性渲染），不可用再回退浏览器引擎
      if (kind === 'word' && harnessOk) {
        try {
          const r = await generateProposalDocx(harnessCfg, buildProposalDoc(p, lead, skus))
          toast.success(`D3 文档工人已产出 ${r.filename}`, {
            description: `服务端 doc-worker 渲染 · ${(r.bytes / 1024).toFixed(1)} KB · 内容与方案 v${p.version} 一致`,
          })
          return
        } catch {
          toast.info('文档工人不可达，本次回退浏览器内置引擎')
        }
      }
      // 按需加载生成库（pptxgenjs/docx/xlsx 体积大，不进入首屏包）
      const exp = await import('@/lib/exporters')
      if (kind === 'ppt') await exp.exportProposalPptx(p, lead, skus)
      if (kind === 'word') await exp.exportProposalDocx(p, lead, skus)
      if (kind === 'excel') exp.exportQuoteXlsx(p, lead, skus)
      toast.success(`${label}已生成为真实文件并开始下载`, {
        description: '由浏览器内置引擎生成 · 接入本地 Harness 后 Word 改由 D5 文档工人产出',
      })
    } catch {
      toast.error(`${label}生成失败，请重试`)
    } finally {
      setExporting(null)
    }
  }

  const saveCfg = () => {
    persistHarnessCfg(harnessCfg)
    toast.success('Harness 网关配置已保存')
  }

  const testHarness = async () => {
    if (!harnessCfg.url) { toast.error('请先填写网关地址'); return }
    setTesting(true)
    try {
      const ctl = new AbortController()
      const t = setTimeout(() => ctl.abort(), 2500)
      await fetch(harnessCfg.url, { mode: 'no-cors', signal: ctl.signal })
      clearTimeout(t)
      setHarnessOk(true)
      toast.success('检测到本地 Harness 网关，文档生成将交由 D5 行动域执行')
    } catch {
      setHarnessOk(false)
      toast.error('未检测到本地网关（演示环境继续使用浏览器内置引擎）')
    } finally {
      setTesting(false)
    }
  }

  return (
    <div>
      <button onClick={() => navigate({ name: 'proposals' })} className="mb-4 flex items-center gap-1 text-[13px] text-slate-500 hover:text-[#3370ff]">
        <ArrowLeft className="h-3.5 w-3.5" />返回方案列表
      </button>

      {/* 头部 */}
      <div className="rounded-xl border border-slate-200/60 bg-white shadow-sm p-4 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 sm:gap-3">
              <h1 className="text-lg sm:text-xl font-bold text-slate-900">{p.title}</h1>
              <span className={cn('rounded border px-2 py-0.5 text-xs font-medium',
                p.status === '已确认' ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-amber-200 bg-amber-50 text-amber-700')}>
                {p.status}
              </span>
              <span className="rounded border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs text-slate-500 tnum">v{p.version}</span>
              {pendingFb.length > 0 && (
                <span className="rounded border border-orange-200 bg-orange-50 px-2 py-0.5 text-xs font-medium text-orange-600 tnum">
                  {pendingFb.length} 条甲方意见待响应
                </span>
              )}
            </div>
            <p className="mt-1.5 text-[13px] text-slate-500">
              客户：{lead?.name} · 生成于 {p.createdAt} · 参考模板：{p.template ?? '通用方案模板'} · 引用素材：{p.materials.join('、')}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-right">
              <Money value={p.total} className="text-[24px] sm:text-[28px] leading-none text-slate-900" />
              <p className="mt-1 text-xs text-slate-400">报价总额（含税）</p>
            </div>
            {p.status === '待审阅' ? (
              <Button className="bg-[#3370ff] hover:bg-[#2952cc]" onClick={() => confirmProposal(p.id)}>
                <CheckCircle2 className="h-4 w-4 mr-1.5" />确认为正式版本
              </Button>
            ) : (
              <span className="flex items-center gap-1.5 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-[13px] font-medium text-emerald-700">
                <CheckCircle2 className="h-4 w-4" />已生效
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-3">
        {/* 三件套预览 */}
        <div className="rounded-xl border border-slate-200/60 bg-white shadow-sm lg:col-span-2">
          <Tabs defaultValue="ppt">
            <div className="flex items-center justify-between border-b border-slate-200 px-3 sm:px-5 pt-3 overflow-x-auto">
              <TabsList className="bg-slate-100">
                <TabsTrigger value="ppt" className="text-[13px]"><Presentation className="h-3.5 w-3.5 mr-1 sm:mr-1.5" />方案 PPT</TabsTrigger>
                <TabsTrigger value="word" className="text-[13px]"><FileText className="h-3.5 w-3.5 mr-1 sm:mr-1.5" />解决方案 Word</TabsTrigger>
                <TabsTrigger value="excel" className="text-[13px]"><Table2 className="h-3.5 w-3.5 mr-1 sm:mr-1.5" />报价 Excel</TabsTrigger>
              </TabsList>
            </div>

            <TabsContent value="ppt" className="p-5 space-y-4">
              <div className="mb-1 flex justify-end">
                <Button variant="outline" size="sm" className="h-8 text-xs" disabled={exporting === 'ppt'} onClick={() => realExport('ppt')}>
                  {exporting === 'ppt' ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Download className="h-3 w-3 mr-1" />}导出 PPTX（真实文件）
                </Button>
              </div>
              {p.slides.map((s, i) => (
                <div key={i} className="rounded-lg border border-slate-200 overflow-hidden">
                  <div className="bg-gradient-to-r from-[#3370ff] to-[#2952cc] px-5 py-2.5 flex items-center justify-between">
                    <span className="text-[13px] font-semibold text-white">{s.title}</span>
                    <span className="tnum text-[11px] text-blue-100">{String(i + 1).padStart(2, '0')}</span>
                  </div>
                  <ul className="space-y-2 px-5 py-4">
                    {s.bullets.map((b, j) => (
                      <li key={j} className="flex gap-2 text-[13px] leading-relaxed text-slate-600">
                        <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-[#3370ff]" />{b}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </TabsContent>

            <TabsContent value="word" className="p-5">
              <div className="mb-3 flex justify-end">
                <Button variant="outline" size="sm" className="h-8 text-xs" disabled={exporting === 'word'} onClick={() => realExport('word')}>
                  {exporting === 'word' ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Download className="h-3 w-3 mr-1" />}导出 DOCX（真实文件）
                </Button>
              </div>
              <div className="rounded-lg border border-slate-200 px-4 py-5 sm:px-8 sm:py-7">
                <h2 className="text-center text-lg font-bold text-slate-900">{p.title}</h2>
                <p className="mt-1 text-center text-xs text-slate-400">太忆 TiMEM.ai · 机密</p>
                {p.word.map((w, i) => (
                  <div key={i} className="mt-6">
                    <h3 className="text-[15px] font-semibold text-slate-900">{w.heading}</h3>
                    <p className="mt-2 text-[13px] leading-[1.9] text-slate-600">{w.body}</p>
                  </div>
                ))}
              </div>
            </TabsContent>

            <TabsContent value="excel" className="p-5">
              <div className="mb-3 flex justify-end">
                <Button variant="outline" size="sm" className="h-8 text-xs" disabled={exporting === 'excel'} onClick={() => realExport('excel')}>
                  {exporting === 'excel' ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Download className="h-3 w-3 mr-1" />}导出 XLSX（真实文件）
                </Button>
              </div>
              <div className="overflow-hidden rounded-lg border border-slate-200">
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-500">
                      <th className="px-4 py-2.5 font-medium">费用项</th>
                      <th className="hidden sm:table-cell px-4 py-2.5 font-medium">说明</th>
                      <th className="px-4 py-2.5 font-medium text-right">金额</th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.quote.map((q, i) => (
                      <tr key={i} className="border-b border-slate-100 last:border-0">
                        <td className="px-4 py-3 font-medium text-slate-800">{q.item}</td>
                        <td className="hidden sm:table-cell px-4 py-3 text-slate-500">{q.desc}</td>
                        <td className="tnum px-4 py-3 text-right text-slate-800">{fmtMoneyFull(q.amount)}</td>
                      </tr>
                    ))}
                    <tr className="bg-blue-50/60">
                      <td className="px-4 py-3 font-bold text-slate-900" colSpan={2}>合计</td>
                      <td className="tnum px-4 py-3 text-right font-bold text-[#3370ff]">{fmtMoneyFull(p.total)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p className="mt-3 text-xs text-slate-400">报价由规则引擎约束生成；修改配置会生成新版本，已出报价单不受影响。</p>
            </TabsContent>
          </Tabs>
        </div>

        {/* 右侧：生成引擎 + 规则引擎 + 版本历史 */}
        <div className="space-y-7">
          {/* 生成引擎：浏览器内置 ↔ aigility-harness 本地网关（Seam 接缝） */}
          <div className="rounded-xl border border-slate-200/60 bg-white shadow-sm p-5">
            <h2 className="flex items-center gap-2 text-[15px] font-semibold text-slate-900">
              <Cpu className="h-4 w-4 text-[#3370ff]" />文档生成引擎
            </h2>
            <div className="mt-3 space-y-2 text-[12px]">
              <div className="flex items-center justify-between rounded-lg border border-emerald-200 bg-emerald-50/60 px-3 py-2">
                <span className="font-medium text-emerald-700">浏览器内置引擎</span>
                <span className="flex items-center gap-1 text-[11px] text-emerald-600"><CheckCircle2 className="h-3 w-3" />生效中 · 真实文件</span>
              </div>
              <div className={cn('flex items-center justify-between rounded-lg border px-3 py-2',
                harnessOk ? 'border-emerald-200 bg-emerald-50/60' : 'border-slate-200 bg-slate-50/60')}>
                <span className={cn('font-medium', harnessOk ? 'text-emerald-700' : 'text-slate-500')}>aigility-harness 本地网关</span>
                {harnessOk
                  ? <span className="flex items-center gap-1 text-[11px] text-emerald-600"><CheckCircle2 className="h-3 w-3" />已连接 · Word 走 D3 文档工人</span>
                  : <span className="flex items-center gap-1 text-[11px] text-slate-400"><Unplug className="h-3 w-3" />未连接</span>}
              </div>
            </div>
            <p className="mt-3 text-[11px] leading-relaxed text-slate-400">
              按五域架构预留接缝：D5 人格理解需求 → D4 编排拆解三件套任务 → D2 认知生成内容 → D3 行动域文档工人产出文件。
              本地启动 Harness 后，Word 导出移交文档工人执行，验收仍由人确认。
            </p>
            <Button size="sm" variant="outline" className="mt-3 w-full text-xs" onClick={() => setHarnessOpen(true)}>
              配置 Harness 网关
            </Button>
          </div>

          <div className="rounded-xl border border-slate-200/60 bg-white shadow-sm p-5">
            <h2 className="text-[15px] font-semibold text-slate-900">报价规则引擎</h2>
            <p className="mt-1 text-xs text-slate-400">每次修改需填理由并留痕，自动生成新版本</p>
            <div className="mt-4 space-y-3">
              {p.rules.map(r => (
                <div key={r.key} className="rounded-lg border border-slate-200 p-3.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-[13px] font-medium text-slate-800">{r.label}</p>
                      <p className="mt-0.5 text-xs text-slate-400">{r.priceNote}</p>
                    </div>
                    <Switch checked={r.enabled} onCheckedChange={() => requestToggle(r.key)} disabled={r.key === 'base'} />
                  </div>
                  <p className="mt-1.5 text-xs leading-relaxed text-slate-500">{r.desc}</p>
                  <p className="mt-2 rounded bg-blue-50 px-2 py-1 text-[11px] text-[#3370ff]">规则沉淀提示：{r.recentStat}</p>
                  {r.reason && <p className="mt-1.5 text-[11px] text-slate-400">最近修改理由：{r.reason}</p>}
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-xl border border-slate-200/60 bg-white shadow-sm p-5">
            <h2 className="flex items-center gap-2 text-[15px] font-semibold text-slate-900"><History className="h-4 w-4 text-slate-400" />版本历史</h2>
            <div className="mt-3 space-y-2">
              {[...p.versions].reverse().map(v => (
                <div key={v.version} className="flex items-center justify-between rounded-lg border border-slate-100 bg-slate-50/60 px-3.5 py-2.5">
                  <div>
                    <span className={cn('tnum text-[13px] font-semibold', v.version === p.version ? 'text-[#3370ff]' : 'text-slate-600')}>v{v.version}</span>
                    <span className="ml-2 text-xs text-slate-500">{v.note}</span>
                    <p className="tnum mt-0.5 text-[11px] text-slate-400">{v.time}</p>
                  </div>
                  <Money value={v.total} className="text-[13px] text-slate-700" />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* 案例参考：数字员工推荐 → 人工关联 → 生成时注入上下文 */}
      <div className="mt-5 rounded-xl border border-slate-200/60 bg-white shadow-sm p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-[15px] font-semibold text-slate-900">
              <BookMarked className="h-4 w-4 text-indigo-500" />案例参考 · 生成上下文
            </h2>
            <p className="mt-1 text-xs text-slate-400">数字员工按「行业 + 模块 + 场景」自动检索相似案例，人工确认关联后，再生成三件套时作为背景知识注入 D2 认知上下文</p>
          </div>
          <span className={cn('tnum rounded-full border px-2.5 py-1 text-[11px] font-semibold',
            p.caseRefs.length > 0 ? 'border-indigo-200 bg-indigo-50 text-indigo-600' : 'border-slate-200 bg-slate-50 text-slate-400')}>
            已关联 {p.caseRefs.length} 项
          </span>
        </div>

        {/* 已关联的案例 */}
        {p.caseRefs.length > 0 ? (
          <div className="mt-4 flex flex-wrap gap-2">
            {p.caseRefs.map(r => {
              const m = CASE_KIND_META[r.kind]
              return (
                <span key={`${r.kind}:${r.id}`} title={r.reason}
                  className="group flex items-center gap-1.5 rounded-lg border border-indigo-200 bg-indigo-50/70 px-2.5 py-1.5 text-[12px] font-medium text-indigo-700">
                  <m.icon className="h-3.5 w-3.5" />{r.title}
                  <span className="rounded bg-white/80 px-1 py-px text-[10px] text-indigo-400">{m.label}</span>
                  <button onClick={() => toggleProposalCase(p.id, r)} className="ml-0.5 text-indigo-400/60 hover:text-rose-500" title="移除">×</button>
                </span>
              )
            })}
          </div>
        ) : (
          <p className="mt-4 rounded-lg border border-dashed border-slate-200 bg-slate-50/50 px-4 py-3 text-[12px] text-slate-400">
            尚未关联案例。从下方数字员工推荐中确认关联，生成/再生成时即作为上下文背景知识，导出的 PPT/Word 附录也会附上「参考案例」。
          </p>
        )}

        {/* 数字员工推荐 */}
        {unlinkedRecs.length > 0 && (
          <div className="mt-4 rounded-xl border border-dashed border-indigo-200 bg-indigo-50/40 p-4">
            <p className="flex items-center gap-1.5 text-[12px] font-medium text-slate-600">
              <Sparkles className="h-3.5 w-3.5 text-indigo-500" />数字员工检索到 {unlinkedRecs.length} 个相似案例（自动推荐 · 人工确认后生效）
            </p>
            <div className="mt-2.5 space-y-2">
              {unlinkedRecs.map(r => {
                const m = CASE_KIND_META[r.kind]
                return (
                  <div key={`${r.kind}:${r.id}`} className="flex items-center gap-3 rounded-lg border border-slate-100 bg-white px-3 py-2.5">
                    <span className={cn('flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium', m.cls)}>
                      <m.icon className="h-3 w-3" />{m.label}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] font-medium text-slate-800">{r.title}</p>
                      <p className="mt-0.5 text-[11px] text-slate-400">{r.reason}</p>
                    </div>
                    <Button size="sm" variant="outline" className="h-7 shrink-0 text-xs" onClick={() => toggleProposalCase(p.id, r)}>
                      <Plus className="h-3 w-3 mr-1" />关联进上下文
                    </Button>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>

      {/* 积木式组装：产品模块 */}
      <div className="mt-5 rounded-xl border border-slate-200/60 bg-white shadow-sm p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-[15px] font-semibold text-slate-900">
              <Blocks className="h-4 w-4 text-[#3370ff]" />积木式组装 · 产品模块
            </h2>
            <p className="mt-1 text-xs text-slate-400">不是从零定制：优先组装已有产品模块，缺口部分才定制开发</p>
          </div>
          <button onClick={() => navigate({ name: 'modules' })} className="flex items-center gap-1 text-[12px] font-medium text-[#3370ff] hover:underline">
            模块库 <ChevronRight className="h-3 w-3" />
          </button>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          {p.modules.length === 0 && <p className="text-[13px] text-slate-400">尚未组装模块，可从下方 AI 推荐中采纳</p>}
          {p.modules.map(id => {
            const m = modules.find(x => x.id === id)
            if (!m) return null
            return (
              <span key={id} className="group flex items-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50 px-2.5 py-1.5 text-[12px] font-medium text-[#3370ff]">
                <Package className="h-3.5 w-3.5" />{m.name}
                <span className={cn('rounded px-1 py-px text-[10px]',
                  m.maturity === '标准产品' ? 'bg-emerald-100 text-emerald-700' : m.maturity === '半产品' ? 'bg-amber-100 text-amber-700' : 'bg-slate-200 text-slate-500')}>{m.maturity}</span>
                <button onClick={() => toggleProposalModule(p.id, id)} className="ml-0.5 text-[#3370ff]/50 hover:text-rose-500" title="移除">×</button>
              </span>
            )
          })}
        </div>

        {modules.filter(m => !p.modules.includes(m.id)).length > 0 && (
          <div className="mt-4 rounded-xl border border-dashed border-blue-200 bg-blue-50/40 p-4">
            <p className="flex items-center gap-1.5 text-[12px] font-medium text-slate-600">
              <Sparkles className="h-3.5 w-3.5 text-[#3370ff]" />AI 推荐组装（按行业与客户场景匹配，采纳后进入方案）
            </p>
            <div className="mt-2.5 space-y-2">
              {modules.filter(m => !p.modules.includes(m.id)).map(m => (
                <div key={m.id} className="flex items-center gap-3 rounded-lg border border-slate-100 bg-white px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-medium text-slate-800">{m.name}
                      <span className="ml-2 text-[11px] font-normal text-slate-400">{m.kind} · {m.maturity}{m.price != null ? ` · ¥${m.price} 万/年起` : ''}</span>
                    </p>
                    <p className="mt-0.5 truncate text-[11px] text-slate-400">{m.desc}</p>
                  </div>
                  <Button size="sm" variant="outline" className="h-7 shrink-0 text-xs" onClick={() => toggleProposalModule(p.id, m.id)}>
                    <Plus className="h-3 w-3 mr-1" />采纳
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 标准产品 SKU：记忆容量 / Token / 积分 / 一体机 / 私有化授权 */}
        <div className="mt-5 border-t border-slate-100 pt-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="flex items-center gap-2 text-[13px] font-semibold text-slate-800">
              <Package className="h-4 w-4 text-emerald-600" />标准产品 SKU
              <span className="hidden sm:inline text-[11px] font-normal text-slate-400">订阅/消耗类产品自带续费属性，长期捆绑客户</span>
            </p>
            {p.skus.length > 0 && (
              <span className="tnum rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-700">
                SKU 小计 {fmtMoneyFull(p.skus.reduce((s, id) => s + (skus.find(x => x.id === id)?.price ?? 0), 0))}
              </span>
            )}
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            {p.skus.length === 0 && <p className="text-[13px] text-slate-400">尚未组装标准产品，可从下方推荐中采纳进报价</p>}
            {p.skus.map(id => {
              const s = skus.find(x => x.id === id)
              if (!s) return null
              return (
                <span key={id} className="flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-[12px] font-medium text-emerald-700">
                  <Package className="h-3.5 w-3.5" />{s.name}
                  <span className="tnum rounded bg-white/80 px-1 py-px text-[10px]">{fmtMoneyFull(s.price)}/{s.unit}</span>
                  <button onClick={() => toggleProposalSku(p.id, id)} className="ml-0.5 text-emerald-600/50 hover:text-rose-500" title="移除">×</button>
                </span>
              )
            })}
          </div>

          {skus.filter(s => !p.skus.includes(s.id)).length > 0 && (
            <div className="mt-3 rounded-xl border border-dashed border-emerald-200 bg-emerald-50/40 p-4">
              <p className="flex items-center gap-1.5 text-[12px] font-medium text-slate-600">
                <Sparkles className="h-3.5 w-3.5 text-emerald-600" />推荐搭配标准产品（标准化售卖 · 订阅续费长期捆绑）
              </p>
              <div className="mt-2.5 space-y-2">
                {skus.filter(s => !p.skus.includes(s.id)).map(s => (
                  <div key={s.id} className="flex items-center gap-3 rounded-lg border border-slate-100 bg-white px-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] font-medium text-slate-800">{s.name}
                        <span className="tnum ml-2 text-[11px] font-normal text-slate-400">{s.kind} · {s.billing} · {fmtMoneyFull(s.price)}/{s.unit}</span>
                      </p>
                      <p className="mt-0.5 truncate text-[11px] text-slate-400">{s.binding}</p>
                    </div>
                    <Button size="sm" variant="outline" className="h-7 shrink-0 text-xs" onClick={() => toggleProposalSku(p.id, s.id)}>
                      <Plus className="h-3 w-3 mr-1" />采纳
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 客户反馈与版本迭代 */}
      <div className="mt-5 rounded-xl border border-slate-200/60 bg-white shadow-sm p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-[15px] font-semibold text-slate-900">
              <MessagesSquare className="h-4 w-4 text-[#3370ff]" />甲方反馈与版本迭代
            </h2>
            <p className="mt-1 text-xs text-slate-400">报价发出后甲方的每轮意见都记录在此，响应后自动生成新版本，全程留痕</p>
          </div>
          <Button size="sm" variant="outline" onClick={() => setFbOpen(true)}>
            <MessageSquarePlus className="h-3.5 w-3.5 mr-1.5" />录入甲方反馈
          </Button>
        </div>

        {p.versions.length === 0 && p.feedbacks.length === 0 ? (
          <p className="mt-4 rounded-lg border border-dashed border-slate-300 py-8 text-center text-[13px] text-slate-400">暂无反馈记录</p>
        ) : (
          <div className="mt-5 space-y-0">
            {p.versions.map((v, vi) => {
              const vFeedbacks = p.feedbacks.filter(f => f.version === v.version)
              const isLast = vi === p.versions.length - 1
              return (
                <div key={v.version} className="relative flex gap-4 pb-6 last:pb-0">
                  {/* 时间线 */}
                  <div className="flex flex-col items-center">
                    <span className={cn('tnum flex h-8 w-8 shrink-0 items-center justify-center rounded-full border text-[12px] font-bold',
                      v.version === p.version ? 'border-[#3370ff] bg-[#3370ff] text-white' : 'border-slate-200 bg-slate-50 text-slate-500')}>
                      v{v.version}
                    </span>
                    {!isLast && <span className="mt-1 w-px flex-1 bg-slate-200" />}
                  </div>
                  <div className="min-w-0 flex-1 pt-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[13px] font-semibold text-slate-800">{v.note}</span>
                      <Money value={v.total} className="text-xs text-slate-500" />
                      <span className="tnum text-[11px] text-slate-400">{v.time}</span>
                    </div>
                    {v.opinion && (
                      <p className="mt-2 flex items-start gap-1.5 rounded-lg bg-indigo-50/70 px-3 py-2 text-xs leading-relaxed text-indigo-700">
                        <GitBranch className="mt-0.5 h-3 w-3 shrink-0" />响应意见：{v.opinion}
                      </p>
                    )}
                    {/* 挂在该版本上的甲方反馈 */}
                    {vFeedbacks.map(f => (
                      <div key={f.id} className={cn('mt-2.5 rounded-lg border px-3.5 py-3',
                        f.status === '待处理' ? 'border-orange-200 bg-orange-50/60' : 'border-slate-200 bg-slate-50/60')}>
                        <div className="flex flex-wrap items-center gap-2">
                          <CornerDownRight className="h-3.5 w-3.5 text-slate-400" />
                          <span className="text-xs font-medium text-slate-600">{f.author}</span>
                          <span className="tnum text-[11px] text-slate-400">{f.at}</span>
                          <span className={cn('ml-auto rounded border px-1.5 py-0.5 text-[11px] font-medium',
                            f.status === '待处理' ? 'border-orange-200 bg-white text-orange-600' : 'border-emerald-200 bg-white text-emerald-600')}>
                            {f.status}
                          </span>
                        </div>
                        <p className="mt-1.5 pl-5 text-[13px] leading-relaxed text-slate-700">{f.content}</p>
                        {f.status === '待处理' && (
                          <div className="mt-2.5 pl-5">
                            <Button size="sm" className="h-7 bg-[#3370ff] text-xs hover:bg-[#2952cc]" onClick={() => { setRespondId(f.id); setChangeNote('') }}>
                              响应并生成 v{v.version + 1}
                            </Button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* 录入甲方反馈 */}
      <Dialog open={fbOpen} onOpenChange={setFbOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>录入甲方反馈</DialogTitle>
            <DialogDescription>记录客户对当前 v{p.version} 方案/报价的意见，响应后自动生成新版本。</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Input value={fbAuthor} onChange={e => setFbAuthor(e.target.value)} placeholder="反馈人，如：甲方 · 采购办" />
            <Textarea value={fbContent} onChange={e => setFbContent(e.target.value)} rows={4} placeholder="客户的具体意见，例如：运维费用希望按年列示，便于走年度预算科目…" />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFbOpen(false)}>取消</Button>
            <Button className="bg-[#3370ff] hover:bg-[#2952cc]" disabled={!fbAuthor.trim() || !fbContent.trim()} onClick={submitFeedback}>录入反馈</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 响应反馈生成新版本 */}
      <Dialog open={respondId !== null} onOpenChange={v => !v && setRespondId(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>响应甲方意见 → 生成 v{p.version + 1}</DialogTitle>
            <DialogDescription>填写本轮修改说明。新版本会记录所响应的甲方意见，历史版本与已发报价单不受影响。</DialogDescription>
          </DialogHeader>
          <div className="rounded-lg border border-orange-200 bg-orange-50/60 px-3.5 py-3 text-[13px] leading-relaxed text-slate-700">
            {p.feedbacks.find(f => f.id === respondId)?.content}
          </div>
          <Textarea value={changeNote} onChange={e => setChangeNote(e.target.value)} rows={3} placeholder="修改说明，例如：运维费拆分为按年列示，补充 OMS 对接说明专章…" />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRespondId(null)}>取消</Button>
            <Button className="bg-[#3370ff] hover:bg-[#2952cc]" disabled={!changeNote.trim()} onClick={submitRespond}>生成新版本</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 修改理由 */}
      <Dialog open={pendingToggle !== null} onOpenChange={v => !v && setPendingToggle(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>调整报价配置</DialogTitle>
            <DialogDescription>请填写调整理由（留痕，并沉淀为规则优化素材）。调整后生成新版本，历史报价单不受影响。</DialogDescription>
          </DialogHeader>
          <Textarea value={reason} onChange={e => setReason(e.target.value)} rows={3} placeholder="例如：客户明确要求数据不出内网，启用私有化部署…" />
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingToggle(null)}>取消</Button>
            <Button className="bg-[#3370ff] hover:bg-[#2952cc]" disabled={!reason.trim()} onClick={confirmToggle}>确认调整</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* aigility-harness 网关配置 */}
      <Dialog open={harnessOpen} onOpenChange={setHarnessOpen}>
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-[15px]">
              <Cpu className="h-4 w-4 text-[#3370ff]" />接入 aigility-harness 本地智能体
            </DialogTitle>
            <DialogDescription>
              五域可插拔架构：契约是主体，插件是过客。工作台按 Seam 契约对接，本地 Harness 启动后文档生成移交 D3 行动域文档工人。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="rounded-xl bg-slate-50 border border-slate-100 p-3.5 text-[12px] leading-relaxed text-slate-500">
              <p className="font-semibold text-slate-700">生成链路（五域映射）</p>
              <p className="mt-1.5">D1 底座 · http-ingress 网关收口 → D5 人格 · fde-assistant 理解需求 → D4 编排 · workflow-engine 拆解三件套 → D2 认知 · llm-inference 生成内容 → D3 行动 · doc-worker 文档工人产出 DOCX</p>
              <p className="mt-1.5">工人契约：领活 → 执行 → 交产出 → 受验收判定。产出回到工作台后仍需你在「方案审阅」中确认，人在回路不变。</p>
            </div>
            <Input
              value={harnessCfg.url ?? ''}
              onChange={e => setHarnessCfg(c => ({ ...c, url: e.target.value }))}
              placeholder="网关地址，如 http://127.0.0.1:1235（pnpm example:fde 启动时自动注入）"
            />
            <Input
              type="password"
              value={harnessCfg.key ?? ''}
              onChange={e => setHarnessCfg(c => ({ ...c, key: e.target.value }))}
              placeholder="API Key（如网关开启鉴权）"
            />
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" disabled={testing} onClick={testHarness}>
                {testing ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Unplug className="h-3.5 w-3.5 mr-1" />}测试连接
              </Button>
              <Button className="flex-1 bg-[#3370ff] hover:bg-[#2952cc]" onClick={saveCfg}>保存配置</Button>
            </div>
            <p className="text-[11px] text-slate-400">
              当前状态：{harnessOk ? '已连接本地网关，Word 导出由 D5 文档工人产出' : '未连接 —— Word 暂由浏览器内置引擎生成'}。本地启动：pnpm install && pnpm example:fde（见 examples/fde-workbench/README）。
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
