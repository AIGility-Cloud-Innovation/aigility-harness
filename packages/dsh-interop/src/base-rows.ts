/**
 * dshBaseRows — 只读解析官方 dsh-base 的 `cordis.patch.yml` 行清单。
 *
 * 这是官方能力的「库存」来源：每行 {id, name, config, disabled} 挂一个
 * cordis 插件，行上方注释说明其意图。安全约束：`!!js` 表达式是官方清单
 * 里的配置求值（信任边界内由官方组合器执行），本模块**只保留原文、绝不
 * 求值**——产出供展示与装载规划使用。
 */

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import yaml from "js-yaml";

const localRequire = createRequire(import.meta.url);

/** `!!js` 表达式的原样载体（不做任何求值） */
export interface JsExpr {
  __jsExpr: string;
}

export interface DshBaseRow {
  id?: string;
  /** 官方插件 npm 包名 */
  name: string;
  /** 官方默认配置；嵌套值里可能含 JsExpr（原样保留） */
  config?: unknown;
  /** 静态禁用为 boolean；平台等条件禁用为 JsExpr（原样保留） */
  disabled?: boolean | JsExpr;
  /** 行上方紧邻的官方注释块（剥离 `#`，原文保留） */
  notes?: string;
}

export function isJsExpr(v: unknown): v is JsExpr {
  return (
    typeof v === "object" &&
    v !== null &&
    "__jsExpr" in v &&
    typeof (v as JsExpr).__jsExpr === "string"
  );
}

/**
 * 解析官方清单：顶层是操作条目（`- insert:` 等），行清单挂在操作键下；
 * `!!js` 标签折叠为 {__jsExpr} 原文，不执行。
 */
function parsePatchYml(raw: string): Array<Record<string, unknown>> {
  const jsType = new yaml.Type("tag:yaml.org,2002:js", {
    kind: "scalar",
    resolve: () => true,
    construct: (src: string) => ({ __jsExpr: String(src) }),
  });
  const schema = yaml.DEFAULT_SCHEMA.extend({ explicit: [jsType] });
  const doc = yaml.load(raw, { schema });
  const out: Array<Record<string, unknown>> = [];
  for (const op of Array.isArray(doc) ? doc : []) {
    if (typeof op !== "object" || op === null) continue;
    for (const [, rows] of Object.entries(op as Record<string, unknown>)) {
      if (!Array.isArray(rows)) continue;
      for (const row of rows) {
        if (typeof row === "object" && row !== null && "name" in row) {
          out.push(row as Record<string, unknown>);
        }
      }
    }
  }
  return out;
}

/** 把每个行条目上方紧邻的注释块归给它（空行可穿越，非注释内容打断） */
function associateNotes(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  let buf: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*-\s+id:\s*([^#]+?)\s*$/);
    if (m) {
      const notes = buf.join("\n").trim();
      const id = m[1].replace(/^['"]|['"]$/g, "");
      if (notes && !out.has(id)) out.set(id, notes);
      buf = [];
    } else if (/^\s*#/.test(line)) {
      buf.push(line.replace(/^\s*#\s?/, ""));
    } else if (/^\s*$/.test(line)) {
      buf.push("");
    } else {
      buf = [];
    }
  }
  return out;
}

/** 读取并解析官方 dsh-base 行清单（同步、纯内存、零副作用） */
export function dshBaseRows(): DshBaseRow[] {
  const ymlPath = localRequire.resolve("@deepseek-ai/dsh-base/cordis.patch.yml");
  const raw = readFileSync(ymlPath, "utf8");
  const notesById = associateNotes(raw);
  return parsePatchYml(raw).map((r) => {
    const id = typeof r.id === "string" ? r.id : undefined;
    return {
      id,
      name: String(r.name),
      config: r.config ?? undefined,
      disabled: (r.disabled ?? undefined) as DshBaseRow["disabled"],
      notes: id ? notesById.get(id) : undefined,
    };
  });
}
