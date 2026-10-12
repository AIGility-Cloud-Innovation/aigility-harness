/** 方案三件套 → D3 文档生成器块结构映射（纯数据，无重依赖；浏览器引擎见 exporters.ts） */
import type { DocBlock, FdeDocPayload } from '@/lib/harness'
import type { Proposal, Lead, StandardSku } from '@/types'

const KIND_LABEL = { proposal: '历史方案', deployment: '已交付案例', knowledge: '知识库' } as const

/** 把方案对象映射为文档生成器契约（与 exporters.exportProposalDocx 的章节结构保持一致） */
export function buildProposalDoc(p: Proposal, lead: Lead | undefined, skus: StandardSku[]): FdeDocPayload {
  const blocks: DocBlock[] = []

  for (const w of p.word) {
    blocks.push({ type: 'heading', text: w.heading, level: 2 })
    blocks.push({ type: 'paragraph', text: w.body })
  }

  blocks.push({ type: 'heading', text: '四、报价清单', level: 2 })
  blocks.push({
    type: 'table',
    header: ['费用项', '说明', '金额（元）'],
    rows: p.quote.map(l => [l.item, l.desc, l.amount.toLocaleString()]),
  })

  const skuList = p.skus.map(id => skus.find(s => s.id === id)).filter((s): s is StandardSku => !!s)
  if (skuList.length > 0) {
    blocks.push({ type: 'heading', text: '五、组装标准产品', level: 2 })
    blocks.push({
      type: 'bullets',
      items: skuList.map(s => `${s.name}（${s.spec}）：¥${s.price.toLocaleString()}/${s.unit} · ${s.billing}`),
    })
  }
  blocks.push({ type: 'paragraph', text: `报价合计：¥${p.total.toLocaleString()}（含税）`, bold: true })

  if (p.caseRefs.length > 0) {
    blocks.push({ type: 'heading', text: '附录 · 参考案例', level: 2 })
    blocks.push({
      type: 'bullets',
      items: p.caseRefs.map(r => `【${KIND_LABEL[r.kind]}】${r.title} —— ${r.reason}`),
    })
    blocks.push({ type: 'paragraph', text: '以上案例由数字员工检索推荐、人工确认关联，作为本方案生成的上下文背景知识。' })
  }

  return {
    title: p.title,
    subtitle: `客户：${lead?.name ?? '—'} · 太忆 TiMEM · v${p.version} · ${p.createdAt}`,
    creator: '太忆 TiMEM FDE 工作台',
    basename: `${p.title}_v${p.version}`,
    blocks,
  }
}
