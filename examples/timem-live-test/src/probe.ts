export {};

const BASE = "https://api.timem.cloud";
const KEY = "sk-Basv1SkKna1rdmTG5T45OrBeBidiHoBDyPVwPv4l";

async function post(path: string, body: unknown) {
  const resp = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": KEY },
    body: JSON.stringify(body),
  });
  return { status: resp.status, text: (await resp.text()).replace(/\s+/g, " ").slice(0, 350) };
}

// 1) 数字 user_id (README 示例用法: user_id: 12345)
console.log("数字 user_id:", JSON.stringify(await post("/api/v1/memory/search", { user_id: 12345, query_text: "test", limit: 3 })));
// 2) enhanced_semantic + query_text 正常对照
console.log("字符串 user_id:", JSON.stringify(await post("/api/v1/memory/search", { user_id: "dsh-plugin-live-test", query_text: "test", search_mode: "enhanced_semantic", limit: 3 })));
