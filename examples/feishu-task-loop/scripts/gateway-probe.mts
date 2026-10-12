/**
 * 网关模型清单探测（只读）：远端（config/default.json litellm.url）+ 本地（localhost:48724）。
 * 只打印模型 id，不回显任何 key。
 */
import { readFileSync } from "node:fs";

interface GatewayCfg { url?: string; key?: string }

function remoteCfg(): GatewayCfg {
  try {
    const raw = JSON.parse(readFileSync(new URL("../../../config/default.json", import.meta.url), "utf8")) as { litellm?: GatewayCfg };
    return raw.litellm ?? {};
  } catch {
    return {};
  }
}

async function probe(name: string, base: string, key: string): Promise<void> {
  try {
    const r = await fetch(`${base.replace(/\/$/, "")}/v1/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) {
      console.log(`[${name}] HTTP ${r.status}`);
      return;
    }
    const d = (await r.json()) as { data?: Array<{ id: string }> };
    const ids = (d.data ?? []).map((m) => m.id).sort();
    console.log(`[${name}] ${base} → ${ids.length} 个模型：`);
    for (const id of ids) console.log("  -", id);
  } catch (e) {
    console.log(`[${name}] 探测失败: ${String((e as Error)?.message ?? e)}`);
  }
}

const remote = remoteCfg();
const localEnv = readFileSync("/home/johnny/.local/litellm-venv/.env", "utf8")
  .split("\n").find((l) => l.startsWith("LITELLM_MASTER_KEY="));
const localKey = localEnv?.slice("LITELLM_MASTER_KEY=".length).trim() ?? "";

await probe("远端(harness用)", remote.url ?? "(未配置)", remote.key ?? "");
await probe("本地(48724)", "http://localhost:48724", localKey);
