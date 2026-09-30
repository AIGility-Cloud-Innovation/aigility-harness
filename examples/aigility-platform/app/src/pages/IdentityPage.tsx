/**
 * IdentityPage — 身份对齐 · 花名册审查
 *
 * 目标：同一个人在 飞书 / Gitea / 太忆云 中是同一个人。
 * 流程：① 一键自动匹配（Gitea 组织成员 + 飞书通讯录 × 花名册别名打分，
 * ≥70 分自动绑定为 auto 待确认）；② 本页逐条核对——采纳建议 / 手动绑定 /
 * 解绑 / 确认（manual 永不被自动匹配覆盖）。
 * 数据落盘 config/timem-team-registry.json，项目小助理按 mtime 自动重载。
 */
import { useCallback, useEffect, useState } from 'react'
import {
  fetchIdentityOverview, runIdentityAutoMatch, identityBind,
  type IdentityOverview, type IdentityMemberView, type IdentityAxisView,
} from '../lib/harness'
import { UserCheck, Sparkles, RefreshCw, X, Check, Plus } from 'lucide-react'

const AXIS_META: Record<IdentityAxisView, { label: string; hint: string }> = {
  feishu: { label: '飞书 open_id', hint: 'ou_ 开头，群消息/私聊身份' },
  wecom: { label: '企微 userid', hint: '企微回调身份（通道收口后启用）' },
  gitea: { label: 'Gitea 用户名', hint: 'git.aigility.cloud login，工单/PR 归属' },
  web: { label: '网页邮箱', hint: '平台登录账号，网页内勤对话身份' },
  timem: { label: '太忆云 user_id', hint: 'space_uuid，个人记忆归属' },
}

const SOURCE_CLS: Record<string, string> = {
  manual: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  auto: 'bg-amber-50 text-amber-700 border-amber-200',
}

export default function IdentityPage() {
  const [data, setData] = useState<IdentityOverview | null>(null)
  const [banner, setBanner] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  // 手动绑定输入：memberId:axis → 草稿值
  const [drafts, setDrafts] = useState<Record<string, string>>({})

  const reload = useCallback(async () => {
    const d = await fetchIdentityOverview()
    setData(d)
  }, [])

  useEffect(() => { reload().catch((e) => setError(String((e as Error).message ?? e))) }, [reload])

  const act = async (key: string, fn: () => Promise<string>) => {
    setBusy(key); setError(''); setBanner('')
    try { setBanner(await fn()) } catch (e) { setError(String((e as Error).message ?? e)) } finally { setBusy(null) }
  }

  const autoMatch = () => act('auto', async () => {
    const r = await runIdentityAutoMatch()
    await reload()
    if (r.feishu_error) setError(`飞书通讯录不可用，已仅按 Gitea 匹配：${r.feishu_error}`)
    return r.bound.length > 0
      ? `自动绑定 ${r.bound.length} 条（auto，待确认）：${r.bound.map((b) => `${b.name}←${b.id}`).join('、')}`
      : '没有新的自动绑定（可能都已绑定或分数未达阈值），下方建议可人工采纳'
  })

  const doBind = (memberId: string, axis: IdentityAxisView, id: string) => act(`bind-${memberId}-${axis}`, async () => {
    const r = await identityBind({ memberId, axis, id, op: 'bind' })
    if (!r.ok) throw new Error(r.error ?? '绑定失败')
    await reload()
    return `已绑定 ${axis}：${id} → ${memberId}（manual）`
  })

  const doUnbind = (memberId: string, axis: IdentityAxisView, id: string) => act(`unbind-${memberId}-${axis}`, async () => {
    const r = await identityBind({ memberId, axis, id, op: 'unbind' })
    if (!r.ok) throw new Error(r.error ?? '解绑失败')
    await reload()
    return `已解绑 ${axis}：${id}`
  })

  const doConfirm = (memberId: string, axis: IdentityAxisView) => act(`confirm-${memberId}-${axis}`, async () => {
    const r = await identityBind({ memberId, axis, id: '', op: 'confirm' })
    if (!r.ok) throw new Error(r.error ?? '确认失败')
    await reload()
    return `已确认 ${memberId} 的 ${axis} 绑定（此后自动匹配不再触碰）`
  })

  const suggestionsFor = (m: IdentityMemberView, axis: 'feishu' | 'gitea') =>
    (data?.suggestions ?? []).filter((s) => s.member_id === m.member_id && s.axis === axis)

  return (
    <div className="space-y-5">
      {/* 页头 */}
      <div>
        <h1 className="text-xl font-semibold text-slate-800 flex items-center gap-2"><UserCheck size={22} className="text-violet-500" />身份对齐</h1>
        <p className="text-sm text-slate-500 mt-1">同一个人在 飞书 / Gitea / 太忆云 中是同一个人 —— 自动匹配后请在此逐条核对；manual 绑定永不被自动匹配覆盖</p>
      </div>

      {banner && <div className="bg-emerald-50 border border-emerald-200 text-emerald-700 text-sm rounded-lg px-4 py-2.5">{banner}</div>}
      {error && <div className="bg-rose-50 border border-rose-200 text-rose-700 text-sm rounded-lg px-4 py-2.5 break-all">{error}</div>}

      {/* 自动匹配卡 */}
      <div className="bg-white rounded-xl border border-slate-200/80 p-5">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="text-sm text-slate-600 space-y-1">
            <div className="font-medium text-slate-800">花名册自动匹配</div>
            <div className="text-slate-500">
              候选来源：Gitea 组织成员（{(data?.orgs ?? []).join('、') || '项目登记表未登记组织'}）＋ 飞书通讯录；
              ≥70 分自动绑定（auto 待确认），50-69 分仅列为下方建议
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => reload().catch(() => {})} disabled={busy !== null}
              className="inline-flex items-center gap-1.5 text-sm px-3 py-2 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-40">
              <RefreshCw size={14} className={busy === null ? '' : 'animate-spin'} />刷新
            </button>
            <button onClick={autoMatch} disabled={busy !== null}
              className="inline-flex items-center gap-1.5 text-sm px-4 py-2 rounded-lg bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-40">
              <Sparkles size={14} />{busy === 'auto' ? '匹配中…' : '运行自动匹配'}
            </button>
          </div>
        </div>
        {data?.feishu_error && (
          <div className="mt-3 text-xs bg-amber-50 border border-amber-200 text-amber-700 rounded-lg px-3 py-2">
            飞书通讯录不可用（已仅按 Gitea 匹配）：{data.feishu_error}
          </div>
        )}
      </div>

      {/* 成员卡 */}
      <div className="space-y-3">
        {(data?.members ?? []).map((m) => (
          <div key={m.member_id} className="bg-white rounded-xl border border-slate-200/80 p-5">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-medium text-slate-800">{m.name}</span>
              <span className="text-xs text-slate-400">{m.member_id}</span>
              {m.aliases.length > 0 && <span className="text-xs text-slate-400">别名：{m.aliases.join(' / ')}</span>}
            </div>
            <div className="mt-3 grid gap-3 md:grid-cols-3 xl:grid-cols-5">
              {(Object.keys(AXIS_META) as IdentityAxisView[]).map((axis) => {
                const ids = axis === 'feishu' ? m.feishu_open_ids
                  : axis === 'wecom' ? m.wecom_user_ids
                  : axis === 'gitea' ? m.gitea_usernames
                  : axis === 'web' ? m.web_emails
                  : m.timem_user_ids
                const source = m.match_source?.[axis]
                // 建议来自 Gitea/飞书通讯录自动匹配：仅这两轴有候选；wecom/web 轴为手动登记
                const sugg = axis === 'feishu' || axis === 'gitea' ? suggestionsFor(m, axis) : []
                const draft = drafts[`${m.member_id}:${axis}`] ?? ''
                const placeholder = axis === 'gitea' ? '输入用户名'
                  : axis === 'feishu' ? '输入 open_id'
                  : axis === 'wecom' ? '输入企微 userid'
                  : axis === 'web' ? '输入登录邮箱'
                  : '输入 user_id'
                return (
                  <div key={axis} className="border border-slate-100 rounded-lg p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-slate-500">{AXIS_META[axis].label}</span>
                      {source && (
                        <span className={`text-[11px] px-1.5 py-0.5 rounded border ${SOURCE_CLS[source] ?? ''}`}>
                          {source === 'manual' ? '人工确认' : '自动·待确认'}
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-slate-400">{AXIS_META[axis].hint}</div>
                    <div className="space-y-1.5">
                      {ids.length === 0 && <div className="text-xs text-slate-300">未绑定</div>}
                      {ids.map((id) => (
                        <div key={id} className="flex items-center justify-between gap-2 text-xs bg-slate-50 rounded px-2 py-1">
                          <span className="truncate font-mono" title={id}>{id}</span>
                          <span className="flex items-center gap-1 shrink-0">
                            {source === 'auto' && axis !== 'timem' && (
                              <button title="确认无误，标记为人工确认" onClick={() => doConfirm(m.member_id, axis)} disabled={busy !== null}
                                className="text-emerald-600 hover:text-emerald-700 disabled:opacity-40"><Check size={13} /></button>
                            )}
                            <button title="解绑" onClick={() => doUnbind(m.member_id, axis, id)} disabled={busy !== null}
                              className="text-slate-400 hover:text-rose-500 disabled:opacity-40"><X size={13} /></button>
                          </span>
                        </div>
                      ))}
                    </div>
                    {sugg.filter((s) => s.axis === axis).map((s) => (
                      <div key={s.id} className="flex items-center justify-between gap-2 text-xs bg-violet-50 rounded px-2 py-1">
                        <span className="truncate" title={`${s.id}${s.name ? ` · ${s.name}` : ''}（${s.reason}，${s.score} 分）`}>
                          建议：{s.name ?? s.id}<span className="text-violet-400">（{s.score}分）</span>
                        </span>
                        <button onClick={() => doBind(m.member_id, axis, s.id)} disabled={busy !== null}
                          className="text-violet-600 hover:text-violet-700 shrink-0 disabled:opacity-40">采纳</button>
                      </div>
                    ))}
                    <div className="flex items-center gap-1.5">
                      <input value={draft} onChange={(e) => setDrafts({ ...drafts, [`${m.member_id}:${axis}`]: e.target.value })}
                        placeholder={placeholder}
                        className="flex-1 min-w-0 text-xs border border-slate-200 rounded px-2 py-1 focus:outline-none focus:border-violet-300" />
                      <button onClick={() => { if (draft.trim()) { doBind(m.member_id, axis, draft.trim()); setDrafts({ ...drafts, [`${m.member_id}:${axis}`]: '' }) } }}
                        disabled={busy !== null || !draft.trim()}
                        className="text-slate-400 hover:text-violet-600 disabled:opacity-30"><Plus size={14} /></button>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        ))}
        {(data?.members?.length ?? 0) === 0 && (
          <div className="bg-white rounded-xl border border-slate-200/80 p-8 text-center text-sm text-slate-400">花名册为空（config/timem-team-registry.json）</div>
        )}
      </div>
    </div>
  )
}
