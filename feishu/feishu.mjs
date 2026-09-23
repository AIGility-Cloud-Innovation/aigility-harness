// feishu.mjs — 用 Node(OpenSSL) 直连飞书 Open API，绕开本机损坏的 Schannel
// 用法：
//   node feishu\feishu.mjs auth "<回调完整URL或code>"     # 首次授权换 token
//   node feishu\feishu.mjs call GET /open-apis/task/v2/tasks "page_size=50"
//   node feishu\feishu.mjs call POST /open-apis/task/v2/tasks '{"summary":"测试"}'
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
const write = (f, data) => fs.writeFileSync(path.join(dir, f), JSON.stringify(data, null, 2));
const cred = read("app.local.json");
const BASE = "https://open.feishu.cn";

async function postJson(url, body, headers = {}) {
    const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8", ...headers },
        body: JSON.stringify(body),
    });
    return r.json();
}

async function getFreshUserToken() {
    const t = read("user_token.local.json");
    if (Date.now() < Date.parse(t.expires_at)) return t.access_token;
    const resp = await postJson(`${BASE}/open-apis/authen/v2/oauth/token`, {
        grant_type: "refresh_token",
        client_id: cred.app_id,
        client_secret: cred.app_secret,
        refresh_token: t.refresh_token,
    });
    if (!resp.access_token) throw new Error("刷新 token 失败: " + JSON.stringify(resp));
    const next = { ...t, access_token: resp.access_token, refresh_token: resp.refresh_token ?? t.refresh_token, expires_at: new Date(Date.now() + (resp.expires_in - 60) * 1000).toISOString() };
    write("user_token.local.json", next);
    return next.access_token;
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "auth") {
    const arg = rest[0];
    const code = arg.includes("code=") ? new URL(arg).searchParams.get("code") : arg;
    const resp = await postJson(`${BASE}/open-apis/authen/v2/oauth/token`, {
        grant_type: "authorization_code",
        client_id: cred.app_id,
        client_secret: cred.app_secret,
        code,
        redirect_uri: "http://localhost:18080/callback",
    });
    if (!resp.access_token) { console.error("换取失败:", JSON.stringify(resp)); process.exit(1); }
    write("user_token.local.json", {
        access_token: resp.access_token,
        refresh_token: resp.refresh_token,
        expires_at: new Date(Date.now() + (resp.expires_in - 60) * 1000).toISOString(),
        scope: resp.scope,
    });
    console.log("OK, scope:", resp.scope);
} else if (cmd === "call") {
    const [method = "GET", p = "", ...q] = rest;
    const token = await getFreshUserToken();
    let url = BASE + p;
    if (q[0]) url += "?" + q[0];
    const init = { method, headers: { authorization: `Bearer ${token}` } };
    if (q[1]) init.body = q[1], init.headers["content-type"] = "application/json; charset=utf-8";
    const r = await fetch(url, init);
    const data = await r.json();
    console.log(JSON.stringify(data, null, 2));
    if (data.code !== 0) process.exit(1);
} else {
    console.log("用法: node feishu.mjs auth <回调URL> | call <METHOD> <PATH> [query] [bodyJSON]");
}
