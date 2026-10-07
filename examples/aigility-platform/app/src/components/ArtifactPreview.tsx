/**
 * ArtifactPreview — 文档产物四格式可视化预览（harness #3）
 *
 * 数据源 = @action/doc-worker 返回的 base64 + mime（前端本地解码为 Blob，
 * 不落服务器）。按 MIME 分发：
 *   pdf  → <iframe> 浏览器原生查看器（零依赖）
 *   html → <iframe sandbox srcDoc>（隔离脚本）
 *   docx → docx-preview 浏览器内渲染（还原 docx 版式）
 *   xlsx → SheetJS 解析 → 工作表标签 + HTML 表格
 * 不支持的 MIME 给出下载引导。所有 Blob URL 随卸载回收。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { renderAsync } from 'docx-preview'
import * as XLSX from 'xlsx'
import { Download, FileWarning } from 'lucide-react'
import { downloadArtifact, type DocArtifact } from '../lib/harness'

type PreviewKind = 'pdf' | 'html' | 'docx' | 'xlsx' | 'unknown'

function kindOf(mime: string): PreviewKind {
  if (mime === 'application/pdf') return 'pdf'
  if (mime.includes('wordprocessingml')) return 'docx'
  if (mime.includes('spreadsheetml')) return 'xlsx'
  if (mime.startsWith('text/html')) return 'html'
  return 'unknown'
}

export function ArtifactPreview({ artifact, height = 520 }: { artifact: DocArtifact; height?: number }) {
  const kind = useMemo(() => kindOf(artifact.mime), [artifact.mime])
  const bytes = useMemo(() => {
    const bin = atob(artifact.base64)
    const u = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i)
    return u
  }, [artifact.base64])

  // pdf：Blob URL（卸载时回收）
  const blobUrl = useMemo(
    () => (kind === 'pdf' ? URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' })) : null),
    [kind, bytes],
  )
  useEffect(() => () => { if (blobUrl) URL.revokeObjectURL(blobUrl) }, [blobUrl])

  // html：解码为文本，走 sandbox srcDoc（脚本隔离）
  const html = useMemo(() => (kind === 'html' ? new TextDecoder().decode(bytes) : null), [kind, bytes])

  // docx：docx-preview 渲染进容器
  const docxRef = useRef<HTMLDivElement>(null)
  const [docxErr, setDocxErr] = useState('')
  useEffect(() => {
    if (kind !== 'docx' || !docxRef.current) return
    setDocxErr('')
    renderAsync(bytes, docxRef.current, undefined, { inWrapper: true, ignoreLastRenderedPageBreak: false })
      .catch((e: Error) => setDocxErr(e.message || String(e)))
  }, [kind, bytes])

  // xlsx：SheetJS → 每个工作表一段 HTML 表格
  const sheets = useMemo(() => {
    if (kind !== 'xlsx') return null
    try {
      const wb = XLSX.read(bytes, { type: 'array' })
      return wb.SheetNames.map(name => ({ name, html: XLSX.utils.sheet_to_html(wb.Sheets[name]) }))
    } catch { return null }
  }, [kind, bytes])
  const [sheetIdx, setSheetIdx] = useState(0)
  useEffect(() => setSheetIdx(0), [artifact.base64])

  const download = () => downloadArtifact(artifact)

  return (
    <div className="rounded-xl border border-slate-200/80 bg-white overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-100 bg-slate-50/60">
        <div className="text-xs text-slate-600 flex items-center gap-2 min-w-0">
          <span className="font-medium truncate">{artifact.filename}</span>
          <span className="text-slate-400 shrink-0">{(artifact.bytes / 1024).toFixed(1)} KB · {artifact.format.toUpperCase()}</span>
        </div>
        <button onClick={download}
          className="text-xs px-2.5 py-1.5 rounded-lg border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 flex items-center gap-1.5 shrink-0">
          <Download size={13} />下载
        </button>
      </div>

      <div style={{ height }} className="overflow-auto bg-slate-100/60">
        {kind === 'pdf' && blobUrl && (
          <iframe title={artifact.filename} src={blobUrl} className="w-full h-full border-0" />
        )}

        {kind === 'html' && (
          <iframe title={artifact.filename} srcDoc={html ?? ''} sandbox="" className="w-full h-full border-0 bg-white" />
        )}

        {kind === 'docx' && (
          <div className="bg-slate-200/50 p-4 min-h-full">
            {docxErr
              ? <div className="text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2 flex items-center gap-1.5"><FileWarning size={13} />docx 浏览器渲染失败（{docxErr}），可用「下载」打开原文件。</div>
              : <div ref={docxRef} />}
          </div>
        )}

        {kind === 'xlsx' && (sheets && sheets.length > 0 ? (
          <div className="p-4 space-y-3">
            {sheets.length > 1 && (
              <div className="flex gap-1.5 flex-wrap">
                {sheets.map((s, i) => (
                  <button key={s.name} onClick={() => setSheetIdx(i)}
                    className={`text-xs px-2.5 py-1 rounded-lg border ${i === sheetIdx ? 'bg-blue-50 border-blue-200 text-blue-700' : 'bg-white border-slate-200 text-slate-500 hover:bg-slate-50'}`}>
                    {s.name}
                  </button>
                ))}
              </div>
            )}
            <div className="bg-white rounded-lg border border-slate-200 p-1 overflow-auto"
              dangerouslySetInnerHTML={{ __html: sheets[sheetIdx]?.html ?? '' }} />
          </div>
        ) : (
          <div className="text-xs text-slate-500 p-4">工作簿解析失败，可用「下载」打开原文件。</div>
        ))}

        {kind === 'unknown' && (
          <div className="h-full flex flex-col items-center justify-center gap-2 text-slate-500 text-xs">
            <FileWarning size={20} className="text-slate-400" />
            该格式暂不支持内嵌预览，点击右上角「下载」查看原文件。
          </div>
        )}
      </div>
    </div>
  )
}
