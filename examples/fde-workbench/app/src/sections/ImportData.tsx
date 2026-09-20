import { useRef, useState } from 'react'
import { useStore } from '@/store/AppContext'
import { cn } from '@/lib/utils'
import { TARGET_SCHEMAS, TARGET_LABEL, SAMPLE_TEXT, parseText, parseFile, parseAoa, rowNeedsEdit } from '@/lib/importer'
import type { ImportTarget, ImportBatch, ImportRow } from '@/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog'
import {
  Upload, Rocket, Users, FileText, Repeat, FileUp, Sparkles, CheckCircle2,
  PencilLine, Ban, CircleAlert, History, ShieldCheck, RotateCcw,
} from 'lucide-react'

const TARGETS: { key: ImportTarget; icon: typeof Rocket; desc: string }[] = [
  { key: 'deployments', icon: Rocket, desc: '域名 / 仓库 / 版本 / 到期日' },
  { key: 'leads', icon: Users, desc: '客户 / 行业 / 来源 / 联系人' },
  { key: 'contracts', icon: FileText, desc: '编号 / 金额 / 类型 / 签约日' },
  { key: 'renewals', icon: Repeat, desc: '续费项目 / 到期日 / 金额' },
]

const FLOW = [
  { icon: FileUp, title: '上传 / 粘贴', desc: 'Excel、CSV 或直接粘贴文本' },
  { icon: Sparkles, title: '数字员工解析', desc: '字段级置信度 + 来源原文' },
  { icon: ShieldCheck, title: '人工审阅', desc: '逐条确认 / 修改 / 拒绝' },
  { icon: CheckCircle2, title: '审批录入', desc: '全部审完才允许正式写入台账' },
]

const ROW_STATUS_CLS: Record<ImportRow['status'], string> = {
  '待审': 'border-amber-200 bg-amber-50 text-amber-700',
  '已确认': 'border-emerald-200 bg-emerald-50 text-emerald-600',
  '已修改': 'border-blue-200 bg-blue-50 text-[#3370ff]',
  '已拒绝': 'border-slate-200 bg-slate-50 text-slate-400',
}

function confDot(c: number) {
  return c >= 0.9 ? 'bg-emerald-500' : c >= 0.7 ? 'bg-amber-500' : 'bg-rose-500'
}

/** 数据导入：数字员工解析 → 人工审阅 → 审批录入，全程审计留痕 */
export function ImportData() {
  const { importBatches, createImportBatch, reviewImportRow, commitImportBatch, navigate } = useStore()
  const [target, setTarget] = useState<ImportTarget>('deployments')
  const [text, setText] = useState('')
  const [parsing, setParsing] = useState(false)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [editRow, setEditRow] = useState<ImportRow | null>(null)
  const [editFields, setEditFields] = useState<Record<string, string>>({})
  const fileRef = useRef<HTMLInputElement>(null)

  // 离开页面再回来时自动恢复最近的待审批次，不打断审阅流
  const active =
    importBatches.find(b => b.id === activeId && b.status === '待审阅')
    ?? (activeId === null ? [...importBatches].reverse().find(b => b.status === '待审阅') ?? null : null)
  const schema = TARGET_SCHEMAS[active?.target ?? target]

  const doParse = async (aoa: string[][], fileName: string) => {
    const rows = parseAoa(target, aoa)
    if (rows.length === 0) return
    const id = createImportBatch(target, fileName, rows)
    setActiveId(id)
    setText('')
  }

  const onFile = async (f: File) => {
    setParsing(true)
    try {
      const aoa = await parseFile(f)
      await doParse(aoa, f.name)
    } finally {
      setParsing(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const openEdit = (r: ImportRow) => {
    setEditRow(r)
    setEditFields({ ...r.fields })
  }

  const submitEdit = () => {
    if (!active || !editRow) return
    reviewImportRow(active.id, editRow.id, '已确认', editFields)
    setEditRow(null)
  }

  const counts = (b: ImportBatch) => ({
    pending: b.rows.filter(r => r.status === '待审').length,
    ok: b.rows.filter(r => r.status === '已确认').length,
    edited: b.rows.filter(r => r.status === '已修改').length,
    rejected: b.rows.filter(r => r.status === '已拒绝').length,
  })

  return (
    <div className="space-y-7">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-[18px] font-bold text-slate-900">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-50"><Upload className="h-[18px] w-[18px] text-[#3370ff]" /></span>
            数据导入
          </h2>
          <p className="mt-1.5 text-[12px] text-slate-400">数字员工解析的内容必须逐条人工审阅，审批通过后才正式录入台账 · 每一步都进审计日志</p>
        </div>
        <span className="tnum rounded-full border border-slate-200 bg-white px-3 py-1 text-[12px] text-slate-500">
          批次 {importBatches.length} · 待审阅 {importBatches.filter(b => b.status === '待审阅').length}
        </span>
      </div>

      {/* 审批流 */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {FLOW.map((s, i) => (
          <div key={s.title} className="rounded-2xl border border-slate-200/60 bg-white shadow-sm p-4">
            <div className="flex items-center gap-2">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-50"><s.icon className="h-4 w-4 text-[#3370ff]" /></span>
              <span className="tnum text-[11px] font-bold text-slate-300">0{i + 1}</span>
            </div>
            <p className="mt-2.5 text-[13px] font-semibold text-slate-800">{s.title}</p>
            <p className="mt-1 text-[11px] leading-snug text-slate-400">{s.desc}</p>
          </div>
        ))}
      </div>

      {/* 新建导入 */}
      <div className="rounded-2xl border border-slate-200/60 bg-white shadow-sm p-5">
        <h3 className="text-[15px] font-semibold text-slate-900">新建导入</h3>
        <div className="mt-4 grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
          {TARGETS.map(t => (
            <button
              key={t.key}
              onClick={() => setTarget(t.key)}
              className={cn('rounded-xl border p-3.5 text-left transition-all',
                target === t.key ? 'border-[#3370ff] bg-blue-50/60 shadow-sm' : 'border-slate-200 bg-slate-50/50 hover:border-slate-300')}
            >
              <div className="flex items-center gap-2">
                <t.icon className={cn('h-4 w-4', target === t.key ? 'text-[#3370ff]' : 'text-slate-400')} />
                <span className={cn('text-[13px] font-semibold', target === t.key ? 'text-[#3370ff]' : 'text-slate-700')}>{TARGET_LABEL[t.key]}</span>
              </div>
              <p className="mt-1.5 text-[11px] text-slate-400">{t.desc}</p>
            </button>
          ))}
        </div>

        <div className="mt-4 flex flex-col gap-3 lg:flex-row">
          <Textarea
            value={text}
            onChange={e => setText(e.target.value)}
            rows={5}
            placeholder={`粘贴 ${TARGET_LABEL[target]}数据（首行表头，逗号/制表符分隔）…`}
            className="flex-1 font-mono text-[12px]"
          />
          <div className="flex shrink-0 flex-col gap-2 lg:w-44">
            <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={e => e.target.files?.[0] && onFile(e.target.files[0])} />
            <Button variant="outline" className="h-9 text-xs" disabled={parsing} onClick={() => fileRef.current?.click()}>
              <FileUp className="h-3.5 w-3.5 mr-1" />{parsing ? '解析中…' : '上传 Excel / CSV'}
            </Button>
            <Button variant="outline" className="h-9 text-xs" onClick={() => setText(SAMPLE_TEXT[target])}>
              填入示例数据
            </Button>
            <Button
              className="h-9 bg-[#3370ff] text-xs hover:bg-[#2952cc]"
              disabled={!text.trim() || parsing}
              onClick={() => doParse(parseText(text), '粘贴文本')}
            >
              <Sparkles className="h-3.5 w-3.5 mr-1" />数字员工解析
            </Button>
          </div>
        </div>
        <p className="mt-3 text-[11px] text-slate-400">解析只生成候选记录，不会直接写入台账 —— 字段旁的圆点表示置信度：绿 ≥90% · 黄 70%~90% · 红 ＜70%（需人工补全）。</p>
      </div>

      {/* 审阅区 */}
      {active && (
        <div className="rounded-2xl border border-[#3370ff]/25 bg-white shadow-sm p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="flex flex-wrap items-center gap-2 text-[15px] font-semibold text-slate-900">
                审阅批次：{active.fileName}
                <span className="rounded border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-[11px] font-medium text-[#3370ff]">{TARGET_LABEL[active.target]}</span>
                <span className="tnum text-[11px] font-normal text-slate-400">{active.at} · 导入人 {active.by}</span>
              </h3>
              <p className="mt-1 text-[12px] text-slate-400">共 {active.rows.length} 条 · 红点字段必须先「修改」补全才能确认</p>
            </div>
            {(() => {
              const c = counts(active)
              const canCommit = c.pending === 0 && c.ok + c.edited > 0
              return (
                <div className="flex items-center gap-2">
                  <span className="tnum rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-[11px] text-slate-500">
                    待审 {c.pending} · 确认 {c.ok} · 修改 {c.edited} · 拒绝 {c.rejected}
                  </span>
                  <Button
                    className="h-8 bg-emerald-600 text-xs hover:bg-emerald-700"
                    disabled={!canCommit}
                    onClick={() => { commitImportBatch(active.id); setActiveId(null) }}
                  >
                    <CheckCircle2 className="h-3.5 w-3.5 mr-1" />审批通过 · 正式录入
                  </Button>
                </div>
              )
            })()}
          </div>

          <div className="mt-4 space-y-3">
            {active.rows.map((r, ri) => {
              const needEdit = rowNeedsEdit(active.target, r)
              return (
                <div key={r.id} className={cn('rounded-xl border p-4 transition-colors',
                  r.status === '已拒绝' ? 'border-slate-200 bg-slate-50/50 opacity-60'
                  : needEdit && r.status === '待审' ? 'border-rose-200 bg-rose-50/40'
                  : 'border-slate-200 bg-slate-50/60')}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="tnum text-[12px] font-bold text-slate-400">#{ri + 1}</span>
                      <span className={cn('rounded border px-1.5 py-0.5 text-[11px] font-medium', ROW_STATUS_CLS[r.status])}>{r.status}</span>
                      {needEdit && r.status === '待审' && (
                        <span className="flex items-center gap-1 rounded border border-rose-200 bg-rose-50 px-1.5 py-0.5 text-[11px] font-medium text-rose-600">
                          <CircleAlert className="h-3 w-3" />必填字段缺失，需人工补全
                        </span>
                      )}
                      {r.editedBy && <span className="text-[11px] text-slate-400">修改人：{r.editedBy}</span>}
                    </div>
                    <div className="flex items-center gap-1.5">
                      {r.status === '待审' && (
                        <>
                          <Button size="sm" variant="outline" className="h-7 text-xs" disabled={needEdit} title={needEdit ? '请先修改补全必填字段' : ''}
                            onClick={() => reviewImportRow(active.id, r.id, '已确认')}>
                            <CheckCircle2 className="h-3 w-3 mr-1 text-emerald-600" />确认
                          </Button>
                          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => openEdit(r)}>
                            <PencilLine className="h-3 w-3 mr-1" />修改
                          </Button>
                          <Button size="sm" variant="ghost" className="h-7 text-xs text-slate-400 hover:text-rose-500" onClick={() => reviewImportRow(active.id, r.id, '已拒绝')}>
                            <Ban className="h-3 w-3 mr-1" />拒绝
                          </Button>
                        </>
                      )}
                      {(r.status === '已确认' || r.status === '已修改') && (
                        <Button size="sm" variant="ghost" className="h-7 text-xs text-slate-400" onClick={() => reviewImportRow(active.id, r.id, '待审')}>
                          <RotateCcw className="h-3 w-3 mr-1" />撤回重审
                        </Button>
                      )}
                      {r.status === '已拒绝' && (
                        <Button size="sm" variant="ghost" className="h-7 text-xs text-slate-400" onClick={() => reviewImportRow(active.id, r.id, '待审')}>
                          <RotateCcw className="h-3 w-3 mr-1" />恢复
                        </Button>
                      )}
                    </div>
                  </div>
                  <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                    {TARGET_SCHEMAS[active.target].map(f => {
                      const meta = r.meta[f.key]
                      const val = r.fields[f.key]
                      return (
                        <div key={f.key} className={cn('rounded-lg border bg-white px-2.5 py-2',
                          f.required && !val ? 'border-rose-200' : 'border-slate-100')}
                          title={`置信度 ${Math.round((meta?.confidence ?? 0) * 100)}% · 来源：${meta?.source || '（空）'}`}>
                          <p className="flex items-center gap-1.5 text-[10px] text-slate-400">
                            <span className={cn('h-1.5 w-1.5 rounded-full', confDot(meta?.confidence ?? 0))} />
                            {f.label}{f.required && <span className="text-rose-400">*</span>}
                          </p>
                          <p className={cn('mt-1 truncate text-[12px]', val ? 'font-medium text-slate-800' : 'text-rose-400')}>{val || '缺失'}</p>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* 批次历史 */}
      <div className="rounded-2xl border border-slate-200/60 bg-white shadow-sm p-5">
        <h3 className="flex items-center gap-2 text-[15px] font-semibold text-slate-900">
          <History className="h-4 w-4 text-slate-400" />导入批次历史
        </h3>
        {importBatches.length === 0 ? (
          <p className="mt-4 rounded-lg border border-dashed border-slate-300 py-8 text-center text-[13px] text-slate-400">还没有导入记录，从上方发起第一次导入</p>
        ) : (
          <div className="mt-3 space-y-2">
            {importBatches.map(b => {
              const c = counts(b)
              return (
                <div key={b.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-100 bg-slate-50/60 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-medium text-slate-800">{b.fileName}</p>
                    <p className="tnum mt-0.5 text-[11px] text-slate-400">{b.at} · {b.by} · 采纳 {c.ok + c.edited} · 拒绝 {c.rejected}{c.pending > 0 ? ` · 待审 ${c.pending}` : ''}</p>
                  </div>
                  <span className="rounded border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-[11px] font-medium text-[#3370ff]">{TARGET_LABEL[b.target]}</span>
                  <span className={cn('rounded border px-1.5 py-0.5 text-[11px] font-medium',
                    b.status === '已录入' ? 'border-emerald-200 bg-emerald-50 text-emerald-600' : 'border-amber-200 bg-amber-50 text-amber-700')}>{b.status}</span>
                  {b.status === '待审阅' && (
                    <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setActiveId(b.id)}>继续审阅</Button>
                  )}
                  {b.status === '已录入' && (
                    <Button size="sm" variant="ghost" className="h-7 text-xs text-[#3370ff]"
                      onClick={() => navigate(b.target === 'leads' ? { name: 'leads' } : b.target === 'deployments' ? { name: 'deployments' } : { name: 'contracts' })}>
                      去台账查看
                    </Button>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* 行编辑 */}
      <Dialog open={!!editRow} onOpenChange={v => !v && setEditRow(null)}>
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle className="text-[15px]">人工修正 · {editRow?.id}</DialogTitle>
            <DialogDescription>修改内容会以「人工修正」标记留痕（保留原解析值），并计入审计日志。</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            {schema.map(f => (
              <div key={f.key}>
                <p className="mb-1 text-[11px] text-slate-500">{f.label}{f.required && <span className="text-rose-400"> *</span>}</p>
                <Input
                  value={editFields[f.key] ?? ''}
                  onChange={e => setEditFields(prev => ({ ...prev, [f.key]: e.target.value }))}
                  className={cn(f.required && !(editFields[f.key] ?? '').trim() && 'border-rose-300')}
                />
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditRow(null)}>取消</Button>
            <Button className="bg-[#3370ff] hover:bg-[#2952cc]" onClick={submitEdit}>保存并确认</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
