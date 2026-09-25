/** 冒烟：通过 giteaApiProvider 真实调用（只读：仓库信息 + 工单列表；验证 DNS 绕行与令牌） */
import { giteaApiProvider } from "./src/gitea-api.js";

const ctx = { emit: () => {}, traceId: "smoke" } as never;
const repo = process.env.GITEA_DEFAULT_REPO ?? "TiMEM-AI/timem-platform-backend";

const health = await giteaApiProvider.health!();
console.log("health:", JSON.stringify(health, null, 2));

// 令牌验证（skill 惯例：/api/v1/user 403 属预期，用仓库路由验证）
const repoR = await giteaApiProvider.execute(
  { method: "GET", path: `/api/v1/repos/${repo}` },
  ctx,
);
if (!repoR.ok) {
  console.error("FAIL(repo):", repoR.error);
  process.exit(1);
}
const repoData = repoR.value.data as { full_name?: string; default_branch?: string } | string;
if (typeof repoData === "object") {
  console.log("repo:", repoData.full_name, "(默认分支:", repoData.default_branch + ")");
} else {
  console.error(`FAIL(repo): HTTP ${repoR.value.status}`, String(repoData).slice(0, 200));
  process.exit(1);
}

// 开放工单列表
const issuesR = await giteaApiProvider.execute(
  {
    method: "GET",
    path: `/api/v1/repos/${repo}/issues`,
    query: { state: "open", limit: 5, type: "issues" },
  },
  ctx,
);
if (!issuesR.ok) {
  console.error("FAIL(issues):", issuesR.error);
  process.exit(1);
}
if (issuesR.value.status !== 200) {
  console.error(`FAIL(issues): HTTP ${issuesR.value.status}`, String(issuesR.value.data).slice(0, 200));
  process.exit(1);
}
const issues = issuesR.value.data as { number: number; title: string; state: string }[];
console.log(`open issues (${issues.length}):`);
for (const i of issues) console.log(` - #${i.number} [${i.state}] ${i.title.slice(0, 40)}`);
console.log("\n✅ 冒烟通过（DNS 绕行 + 令牌 + 工单读取）");
process.exit(0);
