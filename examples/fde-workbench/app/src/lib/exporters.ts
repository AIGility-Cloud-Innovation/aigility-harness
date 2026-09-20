import PptxGenJS from 'pptxgenjs'
import { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } from 'docx'
import * as XLSX from 'xlsx'
import type { Proposal, Lead, StandardSku } from '@/types'

const safeName = (s: string) => s.replace(/[\\/:*?"<>|]/g, '_')

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 3000)
}

const PRIMARY = '3370FF'
const DARK = '1F2937'
const GRAY = '6B7280'

/** 方案 PPT → 真实 .pptx（封面 + 内容页 + 报价页） */
export async function exportProposalPptx(p: Proposal, lead: Lead | undefined, skus: StandardSku[]) {
  const pptx = new PptxGenJS()
  pptx.layout = 'LAYOUT_WIDE'
  pptx.author = '太忆 TiMEM'
  pptx.title = p.title

  // 封面
  const cover = pptx.addSlide()
  cover.background = { color: PRIMARY }
  cover.addText(p.title, { x: 0.8, y: 2.0, w: 11.7, h: 1.2, fontSize: 36, bold: true, color: 'FFFFFF', align: 'left' })
  cover.addText(`客户：${lead?.name ?? '—'}　·　太忆 TiMEM　·　v${p.version}　·　${p.createdAt}`, { x: 0.8, y: 3.3, w: 11.7, fontSize: 14, color: 'D6E4FF' })
  cover.addText('记忆驱动 · 人在回路 · 越用越聪明', { x: 0.8, y: 4.1, w: 11.7, fontSize: 12, color: 'B3CCFF', italic: true })

  // 内容页
  p.slides.forEach(s => {
    const slide = pptx.addSlide()
    slide.addText(s.title, { x: 0.6, y: 0.35, w: 12, h: 0.8, fontSize: 24, bold: true, color: DARK })
    slide.addShape('rect' as never, { x: 0.6, y: 1.15, w: 1.2, h: 0.06, fill: { color: PRIMARY } })
    slide.addText(
      s.bullets.map(b => ({ text: b, options: { bullet: { code: '2022', indent: 18 }, breakLine: true, paraSpaceAfter: 14 } })),
      { x: 0.9, y: 1.5, w: 11.4, h: 4.6, fontSize: 16, color: '374151', valign: 'top' },
    )
    slide.addText(`太忆 TiMEM · ${p.title} · v${p.version}`, { x: 0.6, y: 7.0, w: 8, fontSize: 9, color: '9CA3AF' })
  })

  // 报价页
  const q = pptx.addSlide()
  q.addText('建设方案与报价', { x: 0.6, y: 0.35, w: 12, h: 0.8, fontSize: 24, bold: true, color: DARK })
  const rows: { text: string; options: Record<string, unknown> }[][] = [
    [
      { text: '费用项', options: { bold: true, color: 'FFFFFF', fill: { color: PRIMARY } } },
      { text: '说明', options: { bold: true, color: 'FFFFFF', fill: { color: PRIMARY } } },
      { text: '金额（元）', options: { bold: true, color: 'FFFFFF', fill: { color: PRIMARY }, align: 'right' } },
    ],
    ...p.quote.map(l => [
      { text: l.item, options: { color: DARK } },
      { text: l.desc, options: { color: GRAY } },
      { text: l.amount.toLocaleString(), options: { align: 'right' as const, color: DARK } },
    ]),
    [
      { text: '合计', options: { bold: true, fill: { color: 'EBF1FF' } } },
      { text: '', options: { fill: { color: 'EBF1FF' } } },
      { text: p.total.toLocaleString(), options: { bold: true, align: 'right' as const, color: PRIMARY, fill: { color: 'EBF1FF' } } },
    ],
  ]
  q.addTable(rows, { x: 0.6, y: 1.4, w: 12, colW: [3.4, 6.0, 2.6], fontSize: 12, border: { pt: 0.5, color: 'E5E7EB' }, rowH: 0.42 })

  const skuList = p.skus.map(id => skus.find(s => s.id === id)).filter((s): s is StandardSku => !!s)
  if (skuList.length > 0) {
    q.addText(
      '组装标准产品：' + skuList.map(s => `${s.name}（¥${s.price.toLocaleString()}/${s.unit} · ${s.billing}）`).join('、'),
      { x: 0.6, y: 1.6 + rows.length * 0.42 + 0.25, w: 12, fontSize: 11, color: GRAY },
    )
  }

  // 附录：参考案例（人工确认关联的生成上下文）
  if (p.caseRefs.length > 0) {
    const ref = pptx.addSlide()
    ref.addText('附录 · 参考案例', { x: 0.6, y: 0.35, w: 12, h: 0.8, fontSize: 24, bold: true, color: DARK })
    ref.addShape('rect' as never, { x: 0.6, y: 1.15, w: 1.2, h: 0.06, fill: { color: PRIMARY } })
    const KIND_LABEL = { proposal: '历史方案', deployment: '已交付案例', knowledge: '知识库' } as const
    ref.addText(
      p.caseRefs.map(r => ({ text: `【${KIND_LABEL[r.kind]}】${r.title} —— ${r.reason}`, options: { bullet: { code: '2022', indent: 18 }, breakLine: true, paraSpaceAfter: 14 } })),
      { x: 0.9, y: 1.5, w: 11.4, h: 4.6, fontSize: 14, color: '374151', valign: 'top' },
    )
    ref.addText('以上案例由数字员工检索推荐、人工确认关联，作为本方案生成的上下文背景知识', { x: 0.6, y: 7.0, w: 11.4, fontSize: 9, color: '9CA3AF' })
  }

  await pptx.writeFile({ fileName: `${safeName(p.title)}_v${p.version}.pptx` })
}

/** 解决方案 Word → 真实 .docx */
export async function exportProposalDocx(p: Proposal, lead: Lead | undefined, skus: StandardSku[]) {
  const children: Paragraph[] = [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: p.title, bold: true, size: 44, color: DARK })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 480 },
      children: [new TextRun({ text: `客户：${lead?.name ?? '—'} · 太忆 TiMEM · v${p.version} · ${p.createdAt}`, size: 20, color: GRAY })],
    }),
  ]

  p.word.forEach(sec => {
    children.push(new Paragraph({
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 360, after: 160 },
      children: [new TextRun({ text: sec.heading, bold: true, size: 28, color: PRIMARY })],
    }))
    children.push(new Paragraph({
      spacing: { after: 200, line: 360 },
      children: [new TextRun({ text: sec.body, size: 22, color: '374151' })],
    }))
  })

  // 报价章节
  children.push(new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 360, after: 160 },
    children: [new TextRun({ text: '四、报价清单', bold: true, size: 28, color: PRIMARY })],
  }))
  p.quote.forEach(l => {
    children.push(new Paragraph({
      spacing: { after: 120 },
      children: [new TextRun({ text: `· ${l.item}：¥${l.amount.toLocaleString()} —— ${l.desc}`, size: 22, color: '374151' })],
    }))
  })
  const skuList = p.skus.map(id => skus.find(s => s.id === id)).filter((s): s is StandardSku => !!s)
  if (skuList.length > 0) {
    children.push(new Paragraph({
      spacing: { before: 200, after: 120 },
      children: [new TextRun({ text: '组装标准产品（订阅/消耗类自带续费属性）：', bold: true, size: 22, color: DARK })],
    }))
    skuList.forEach(s => {
      children.push(new Paragraph({
        spacing: { after: 100 },
        children: [new TextRun({ text: `· ${s.name}（${s.spec}）：¥${s.price.toLocaleString()}/${s.unit} · ${s.billing}`, size: 22, color: '374151' })],
      }))
    })
  }
  children.push(new Paragraph({
    spacing: { before: 240 },
    children: [new TextRun({ text: `报价合计：¥${p.total.toLocaleString()}（含税）`, bold: true, size: 26, color: PRIMARY })],
  }))

  // 附录：参考案例（人工确认关联的生成上下文）
  if (p.caseRefs.length > 0) {
    const KIND_LABEL = { proposal: '历史方案', deployment: '已交付案例', knowledge: '知识库' } as const
    children.push(new Paragraph({
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 360, after: 160 },
      children: [new TextRun({ text: '附录 · 参考案例', bold: true, size: 28, color: PRIMARY })],
    }))
    p.caseRefs.forEach(r => {
      children.push(new Paragraph({
        spacing: { after: 120 },
        children: [new TextRun({ text: `· 【${KIND_LABEL[r.kind]}】${r.title} —— ${r.reason}`, size: 22, color: '374151' })],
      }))
    })
    children.push(new Paragraph({
      spacing: { before: 120 },
      children: [new TextRun({ text: '以上案例由数字员工检索推荐、人工确认关联，作为本方案生成的上下文背景知识。', size: 18, color: GRAY, italics: true })],
    }))
  }

  const doc = new Document({
    creator: '太忆 TiMEM FDE 工作台',
    title: p.title,
    sections: [{ children }],
  })
  const blob = await Packer.toBlob(doc)
  saveBlob(blob, `${safeName(p.title)}_v${p.version}.docx`)
}

/** 报价 Excel → 真实 .xlsx（报价单 + 标准产品两个工作表） */
export function exportQuoteXlsx(p: Proposal, lead: Lead | undefined, skus: StandardSku[]) {
  const wb = XLSX.utils.book_new()

  const aoa: (string | number)[][] = [
    [p.title + ' —— 报价单'],
    [`客户：${lead?.name ?? '—'}`, '', `版本：v${p.version}`, `日期：${p.createdAt}`],
    [],
    ['费用项', '说明', '金额（元）', '备注'],
    ...p.quote.map(l => [l.item, l.desc, l.amount, '']),
    [],
    ['合计', '', p.total, '含税'],
  ]
  const ws = XLSX.utils.aoa_to_sheet(aoa)
  ws['!cols'] = [{ wch: 28 }, { wch: 52 }, { wch: 14 }, { wch: 16 }]
  ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 3 } }]
  XLSX.utils.book_append_sheet(wb, ws, '报价单')

  const skuList = p.skus.map(id => skus.find(s => s.id === id)).filter((s): s is StandardSku => !!s)
  if (skuList.length > 0) {
    const aoa2: (string | number)[][] = [
      ['组装标准产品 SKU'],
      [],
      ['产品', '类别', '规格', '计费模式', '单价（元）', '单位', '长期捆绑点'],
      ...skuList.map(s => [s.name, s.kind, s.spec, s.billing, s.price, s.unit, s.binding]),
      [],
      ['SKU 小计', '', '', '', skuList.reduce((sum, s) => sum + s.price, 0), '', ''],
    ]
    const ws2 = XLSX.utils.aoa_to_sheet(aoa2)
    ws2['!cols'] = [{ wch: 22 }, { wch: 12 }, { wch: 30 }, { wch: 10 }, { wch: 12 }, { wch: 8 }, { wch: 40 }]
    XLSX.utils.book_append_sheet(wb, ws2, '标准产品')
  }

  XLSX.writeFile(wb, `${safeName(p.title)}_报价_v${p.version}.xlsx`)
}
