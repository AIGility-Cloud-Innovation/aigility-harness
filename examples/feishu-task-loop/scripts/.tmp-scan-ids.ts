/** 临时：扫描任务标题/描述中疑似机器 ID（长字母数字串/oc_/ou_），读完即删 */
import { readFileSync } from "node:fs";
import { feishuApiProvider } from "@aigility-harness/layer-action";

for (const line of readFileSync(new URL("../../../.env", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}
const ctx = { emit: () => {}, traceId: "scan-ids" } as never;
const call = async (req: Record<string, unknown>) => {
  const r = await feishuApiProvider.execute(req as never, ctx);
  return r.ok ? { ok: true, value: { code: r.value?.code, msg: r.value?.msg, data: r.value?.data } } : { ok: false, error: r.error };
};
const idLike = /(oc_|ou_|wrVoX|[A-Za-z0-9]{22,}|[0-9a-f]{8}-[0-9a-f]{4})/;
const lists = (await call({ path: "/open-apis/task/v2/tasklists", query: { page_size: 50, user_id_type: "open_id" }, identity: "user" })).value?.data as { items?: Array<{ guid: string; name: string }> } | undefined;
for (const l of lists?.items ?? []) {
  const tasks = (await call({ path: `/open-apis/task/v2/tasklists/${l.guid}/tasks`, query: { completed: false, page_size: 100, user_id_type: "open_id" }, identity: "user" })).value?.data as { items?: Array<{ guid: string; description?: string; summary: string }> } | undefined;
  for (const t of tasks?.items ?? []) {
    const hits: string[] = [];
    const sm = t.summary?.match(idLike);
    if (sm) hits.push(`标题命中:${sm[0].slice(0, 30)}`);
    const dm = t.description?.match(idLike);
    if (dm) hits.push(`描述命中:${dm[0].slice(0, 30)}`);
    if (hits.length) console.log(`[${l.name}] ${t.summary.slice(0, 30)} || ${hits.join(" | ")}`);
  }
}
console.log("扫描完成");
