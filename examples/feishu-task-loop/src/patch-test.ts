import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../../");
for (const line of readFileSync(resolve(REPO_ROOT, ".env"), "utf-8").split(/\r?\n/)) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("="); if (eq > 0 && !(t.slice(0, eq).trim() in process.env)) process.env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
}
const { access_token: token } = JSON.parse(readFileSync(resolve(REPO_ROOT, "feishu/user_token.local.json"), "utf-8"));
const guid = process.argv[2];
const body = JSON.parse(process.argv[3]);
const r = await fetch(`https://open.feishu.cn/open-apis/task/v2/tasks/${guid}?user_id_type=open_id&update_fields=summary,description`, {
  method: "PATCH", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body),
});
console.log(await r.text());
