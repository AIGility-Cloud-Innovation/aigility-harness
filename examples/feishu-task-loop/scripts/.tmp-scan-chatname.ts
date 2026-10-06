/** 临时：扫描含「来源群：oc_」的任务（含已完成），列出后改写（读完即删） */
import { readFileSync } from "node:fs";
import { feishuApiProvider } from "@aigility-harness/layer-action";

for (const line of readFileSync(new URL("../../../.env", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}
const ctx = { emit: () => {}, traceId: "scan" } as never;
const call = async (req: Record<string, unknown>) => {
  const r = await feishuApiProvider.execute(req as never, ctx);
  return r.ok ? { ok: true, value: { code: r.value?.code, msg: r.value?.msg, data: r.value?.data } } : { ok: false, error: r.error };
};
const nameCache = new Map<string, string>();
async function chatName(id: string): Promise<string> {
  if (nameCache.has(id)) return nameCache.get(id)!;
  const r = await call({ method: "GET", path: `/open-apis/im/v1/chats/${id}`, query: { user_id_type: "open_id" }, identity: "user" });
  const name = r.ok && (r.value?.code ?? -1) === 0 ? ((r.value?.data as { name?: string })?.name ?? id) : id;
  nameCache.set(id, name);
  return name;
}
const DO_FIX = process.argv.includes("--fix");
const lists = (await call({ path: "/open-apis/task/v2/tasklists", query: { page_size: 50, user_id_type: "open_id" }, identity: "user" })).value?.data as { items?: Array<{ guid: string; name: string }> } | undefined;
for (const l of lists?.items ?? []) {
  for (const completed of [false, true]) {
    let token: string | undefined;
    do {
      const d = (await call({ path: `/open-apis/task/v2/tasklists/${l.guid}/tasks`, query: { completed: String(completed), page_size: 100, user_id_type: "open_id", ...(token ? { page_token: token } : {}) }, identity: "user" })).value?.data as { items?: Array<{ guid: string; description?: string; summary: string }>; page_token?: string } | undefined;
      for (const t of d?.items ?? []) {
        const m = t.description?.match(/来源群：(oc_[0-9a-f]+)/);
        if (!m) continue;
        const name = await chatName(m[1]!);
        console.log(`[${l.name}|${completed ? "已完成" : "未完成"}] ${t.summary.slice(0, 30)} → 来源群应为「${name}」`);
        if (DO_FIX) {
          const pr = await call({
            method: "PATCH",
            path: `/open-apis/task/v2/tasks/${t.guid}`,
            query: { user_id_type: "open_id" },
            identity: "user",
            body: { update_fields: ["description"], task: { description: t.description!.replaceAll(m[1]!, name) } },
          });
          console.log(`   修正: ${pr.ok && (pr.value?.code ?? -1) === 0 ? "✅" : `❌ ${pr.value?.msg ?? pr.error}`}`);
        }
      }
      token = d?.page_token;
    } while (token);
  }
}
console.log("扫描完成");
