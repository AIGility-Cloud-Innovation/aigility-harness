/**
 * 把验证任务挪到 D 组，触发 dispatch-scan 派发。
 * 这是交付链基线修复后的**第一次真实派发**。
 */
import { userToken } from "./feishu-user-token.mts";

const LIST = "c9b5653d-c4d8-4ccc-bc0b-561ecbce11ba";
const P = "ba9c4d86-dcdd-479d-8093-2bd21782f9a5";
const D = "de1b7c2e-c015-4c18-822b-fedc119a049d";
const GUID = "a560ab62-6263-4b7c-b9a2-1d3239ab9c8b";

async function main() {
  const T = await userToken();
  const api = async (method: string, path: string, body?: unknown, query?: Record<string, string>) => {
    const url = new URL(`https://open.feishu.cn${path}`);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
    const r = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${T}` },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return (await r.json()) as { code?: number; msg?: string; data?: any };
  };

  const rm = await api("POST", `/open-apis/task/v2/tasks/${GUID}/remove_tasklist`, {
    tasklist_guid: LIST, section_guid: P,
  }, { user_id_type: "open_id" });
  console.log(`从 P 移除: ${rm.code === 0 ? "✅" : "跳过 " + rm.msg}`);

  const mv = await api("POST", `/open-apis/task/v2/tasks/${GUID}/add_tasklist`, {
    tasklist_guid: LIST, section_guid: D,
  }, { user_id_type: "open_id" });
  console.log(`挪入 D: ${mv.code === 0 ? "✅" : "❌ " + mv.msg}`);

  const chk = await api("GET", `/open-apis/task/v2/sections/${D}/tasks`, undefined, {
    page_size: "100", user_id_type: "open_id",
  });
  const inD = (chk.data?.items ?? []).some((t: any) => t.guid === GUID);
  console.log(`\n复核：验证任务在 D 组 = ${inD ? "✅ 是（等待下一拍派发）" : "❌ 否"}`);
  console.log(`现在时间: ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`);
  console.log(`下一扫描拍：约 10 分钟内（节拍 600s）`);
}

main().catch((e) => { console.error("失败:", String(e)); process.exit(1); });