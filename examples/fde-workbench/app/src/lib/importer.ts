import type { ImportTarget, ImportRow } from '@/types'

export interface FieldSpec {
  key: string
  label: string
  required: boolean
  aliases: string[]
}

/** 各台账的字段口径：表头别名越全，数字员工解析越准 */
export const TARGET_SCHEMAS: Record<ImportTarget, FieldSpec[]> = {
  deployments: [
    { key: 'customer', label: '客户', required: true, aliases: ['客户', '客户名称', 'customer'] },
    { key: 'site', label: '站点名称', required: true, aliases: ['站点', '站点名称', 'site', '名称'] },
    { key: 'domain', label: '域名', required: true, aliases: ['域名', 'domain', 'url', '网址'] },
    { key: 'env', label: '环境', required: true, aliases: ['环境', 'env', '类型'] },
    { key: 'platform', label: '代码平台', required: true, aliases: ['平台', '代码平台', 'platform', 'git平台'] },
    { key: 'repo', label: '仓库地址', required: false, aliases: ['仓库', '仓库地址', 'repo', 'repository'] },
    { key: 'domainExpire', label: '域名到期日', required: false, aliases: ['域名到期日', '到期日', 'expire', '到期时间'] },
    { key: 'currentVersion', label: '当前版本', required: false, aliases: ['当前版本', '版本', 'version'] },
  ],
  leads: [
    { key: 'name', label: '客户名称', required: true, aliases: ['客户', '客户名称', 'name', '公司'] },
    { key: 'industry', label: '行业', required: true, aliases: ['行业', 'industry'] },
    { key: 'scale', label: '客户规模', required: false, aliases: ['规模', '客户规模', 'scale'] },
    { key: 'source', label: '线索来源', required: false, aliases: ['来源', '线索来源', 'source'] },
    { key: 'contact', label: '联系人', required: false, aliases: ['联系人', 'contact'] },
    { key: 'note', label: '备注', required: false, aliases: ['备注', 'note', '说明'] },
  ],
  contracts: [
    { key: 'code', label: '合同编号', required: true, aliases: ['合同编号', '编号', 'code', '合同号'] },
    { key: 'customer', label: '客户', required: true, aliases: ['客户', '客户名称', 'customer'] },
    { key: 'amount', label: '合同金额', required: true, aliases: ['金额', '合同金额', 'amount'] },
    { key: 'salesType', label: '销售类型', required: false, aliases: ['销售类型', '类型', 'salesType'] },
    { key: 'signDate', label: '签约日期', required: false, aliases: ['签约日期', '签约时间', 'signDate', '日期'] },
  ],
  renewals: [
    { key: 'customer', label: '客户', required: true, aliases: ['客户', '客户名称', 'customer'] },
    { key: 'item', label: '续费项目', required: true, aliases: ['续费项目', '项目', 'item', '内容'] },
    { key: 'dueDate', label: '到期日', required: true, aliases: ['到期日', '到期时间', 'dueDate', '续费日期'] },
    { key: 'amount', label: '金额', required: true, aliases: ['金额', '续费金额', 'amount'] },
    { key: 'note', label: '备注', required: false, aliases: ['备注', 'note', '说明'] },
  ],
}

export const TARGET_LABEL: Record<ImportTarget, string> = {
  deployments: '部署台账', leads: '线索', contracts: '合同', renewals: '订阅续费',
}

const norm = (s: string) => s.trim().toLowerCase()

/** 表头匹配：返回 schema.key → 列下标；命中率 >=2 认为首行是表头 */
function mapHeaders(target: ImportTarget, headerCells: string[]): { colOf: Record<string, number>; hits: number } {
  const colOf: Record<string, number> = {}
  const cells = headerCells.map(norm)
  let hits = 0
  for (const f of TARGET_SCHEMAS[target]) {
    const idx = cells.findIndex(c => f.aliases.some(a => norm(a) === c || c.includes(norm(a)) && norm(a).length >= 2))
    if (idx >= 0) { colOf[f.key] = idx; hits++ }
  }
  return { colOf, hits }
}

/** 解析二维表（首行可为表头）为带置信度的导入行 */
export function parseAoa(target: ImportTarget, aoa: string[][]): ImportRow[] {
  const rows = aoa.filter(r => r.some(c => String(c ?? '').trim()))
  if (rows.length === 0) return []
  const { colOf, hits } = mapHeaders(target, rows[0].map(String))
  const hasHeader = hits >= 2
  const dataRows = hasHeader ? rows.slice(1) : rows
  const schema = TARGET_SCHEMAS[target]

  return dataRows.map((cells, i) => {
    const fields: Record<string, string> = {}
    const meta: ImportRow['meta'] = {}
    schema.forEach((f, fi) => {
      const colIdx = hasHeader ? colOf[f.key] : fi
      const raw = colIdx != null && colIdx >= 0 ? String(cells[colIdx] ?? '').trim() : ''
      fields[f.key] = raw
      meta[f.key] = {
        confidence: raw ? (hasHeader ? (colOf[f.key] != null ? 0.98 : 0.6) : 0.6) : (f.required ? 0.3 : 0.5),
        source: raw,
      }
    })
    return { id: `R${i + 1}`, fields, meta, status: '待审' as const }
  })
}

/** 粘贴文本（CSV/TSV/中文逗号）→ 二维表 */
export function parseText(text: string): string[][] {
  return text
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => l.split(/\t|,|，/).map(c => c.trim()))
}

/** Excel/CSV 文件 → 二维表（xlsx 库按需加载） */
export async function parseFile(file: File): Promise<string[][]> {
  const XLSX = await import('xlsx')
  const buf = await file.arrayBuffer()
  const wb = XLSX.read(buf)
  const ws = wb.Sheets[wb.SheetNames[0]]
  return XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, defval: '' }).map(r => r.map(c => String(c ?? '')))
}

/** 行内是否有「必填但缺失/低置信」字段，有则必须先编辑再确认 */
export function rowNeedsEdit(target: ImportTarget, row: ImportRow): boolean {
  return TARGET_SCHEMAS[target].some(f => f.required && (!row.fields[f.key] || row.meta[f.key].confidence < 0.5))
}

/** 示例数据（演示与测试用） */
export const SAMPLE_TEXT: Record<ImportTarget, string> = {
  deployments: `客户,站点名称,域名,环境,代码平台,仓库地址,域名到期日,当前版本
中原石化装备,报警降噪演示站,demo-zhongyuan.timem.site,演示,gitea,gitea.timem.internal/fde/zhongyuan-alarm-demo,2027-01-15,v0.3
恒瑞医药,知识库 POC 站,poc-hengrui.timem.site,试用,github,github.com/timem-ai/hengrui-poc,2026-10-08,v0.8
华菱钢铁,设备记忆演示站,demo-hlsteel.timem.site,演示,,gitea.timem.internal/fde/hlsteel-demo,2026-11-30,v0.2`,
  leads: `客户名称,行业,客户规模,线索来源,联系人,备注
华菱钢铁,钢铁冶金,央企,会议,设备部李工,展会接触，对设备记忆感兴趣
恒瑞医药,医药制造,上市,转介绍,信息科王工,老客户介绍`,
  contracts: `合同编号,客户,合同金额,销售类型,签约日期
HT-2026-021,华菱钢铁,860000,直接,2026-09-10
HT-2026-022,恒瑞医药,450000,间接,`,
  renewals: `客户,续费项目,到期日,金额,备注
轩怡装饰,Token 流量包充值,2026-11-15,20000,客服 SaaS 用量增长
长庆油田 · 天然气净化厂,记忆容量订阅扩容,2027-01-20,120000,升级为 500GB 扩容包`,
}
