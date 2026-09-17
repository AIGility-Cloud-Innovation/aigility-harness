/**
 * !!js 白名单求值器 —— 组合器的信任边界执行点。
 *
 * 官方清单里的 `!!js` 表达式要经求值才能变成插件配置（信任边界：只信任
 * 官方首包清单，见 docs/dsh-生态共建规划.md §三.3）。规划的对冲（§八）是
 * 「组合器白名单求值」：这里实现一个小型递归下降求值器，只接受官方清单
 * 里实际出现的表达式形态——
 *   字符串/整数 字面量、括号、process.env.<NAME>、process.platform、
 *   process.cwd()、dshHomePath('sub', ...)、=== / !==、?? / ||、三元。
 * 任何其他语法（任意标识符、函数调用、成员链、赋值、模板串……）一律拒绝。
 * 绝不使用 eval / new Function。
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { isJsExpr, type JsExpr } from "./base-rows.js";

export type { JsExpr };

export interface JsExprEvalContext {
  /** 表达式可见的环境变量（默认 process.env 快照） */
  env?: Record<string, string | undefined>;
  /** process.platform 的替身（默认真实值） */
  platform?: string;
  /** process.cwd() 的替身（默认真实值） */
  cwd?: string;
  /** dshHomePath() 的基准目录（默认 DSH_HOME 环境变量，再退 ~/.dsh） */
  dshHome?: string;
}

/* ── 词法 ─────────────────────────────────────────────────────── */

type Token =
  | { kind: "str"; value: string }
  | { kind: "num"; value: number }
  | { kind: "ident"; value: string }
  | { kind: "op"; value: string };

const OPS = ["===", "!==", "??", "||", "?", ":", ".", "(", ")", ","];

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      let s = "";
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\") {
          const n = src[j + 1];
          s += n === "n" ? "\n" : n === "t" ? "\t" : n;
          j += 2;
        } else {
          s += src[j++];
        }
      }
      if (j >= src.length) throw evalError(src, "字符串未闭合");
      out.push({ kind: "str", value: s });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(c)) {
      const m = /^\d+/.exec(src.slice(i))!;
      out.push({ kind: "num", value: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(src.slice(i))!;
      out.push({ kind: "ident", value: m[0] });
      i += m[0].length;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (op) {
      out.push({ kind: "op", value: op });
      i += op.length;
      continue;
    }
    throw evalError(src, `非法字符 ${JSON.stringify(c)}`);
  }
  return out;
}

function evalError(src: string, why: string): Error {
  return new Error(`!!js 白名单求值拒绝: ${why} —— 表达式: ${JSON.stringify(src)}`);
}

/* ── 语法（递归下降，全部白名单） ──────────────────────────────── */

class Parser {
  private pos = 0;
  constructor(
    private readonly tokens: Token[],
    private readonly src: string,
    private readonly ctx: Required<Omit<JsExprEvalContext, "dshHome">> & JsExprEvalContext,
  ) {}

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const t = this.tokens[this.pos++];
    if (!t) throw evalError(this.src, "表达式意外结束");
    return t;
  }

  private expectOp(op: string): void {
    const t = this.next();
    if (t.kind !== "op" || t.value !== op) {
      throw evalError(this.src, `期望 ${JSON.stringify(op)}，实际 ${JSON.stringify(t.value)}`);
    }
  }

  parse(): unknown {
    const v = this.ternary();
    if (this.pos !== this.tokens.length) {
      throw evalError(this.src, "表达式有多余尾部");
    }
    return v;
  }

  /** 三元: cond ? a : b（右结合，优先级最低） */
  private ternary(): unknown {
    const cond = this.nullish();
    const t = this.peek();
    if (t?.kind === "op" && t.value === "?") {
      this.next();
      const yes = this.ternary();
      this.expectOp(":");
      const no = this.ternary();
      return cond ? yes : no;
    }
    return cond;
  }

  /** ?? 与 ||（官方清单里只有这两个短路运算） */
  private nullish(): unknown {
    let left = this.equality();
    for (;;) {
      const t = this.peek();
      if (t?.kind === "op" && (t.value === "??" || t.value === "||")) {
        this.next();
        const right = this.equality();
        const nonNull = left !== null && left !== undefined;
        left = t.value === "??" ? (nonNull ? left : right) : nonNull ? left : right;
      } else {
        return left;
      }
    }
  }

  /** === 与 !==（官方清单里只有这两种比较） */
  private equality(): unknown {
    let left = this.primary();
    for (;;) {
      const t = this.peek();
      if (t?.kind === "op" && (t.value === "===" || t.value === "!==")) {
        this.next();
        const right = this.primary();
        left = t.value === "===" ? left === right : left !== right;
      } else {
        return left;
      }
    }
  }

  /** 字面量 / (expr) / process.* / dshHomePath('…') —— 白名单封闭集 */
  private primary(): unknown {
    const t = this.next();
    if (t.kind === "str") return t.value;
    if (t.kind === "num") return t.value;
    if (t.kind === "op" && t.value === "(") {
      const v = this.ternary();
      this.expectOp(")");
      return v;
    }
    if (t.kind === "ident") {
      if (t.value === "process") {
        this.expectOp(".");
        const member = this.next();
        if (member.kind !== "ident") throw evalError(this.src, "process 后必须是成员名");
        if (member.value === "env") {
          this.expectOp(".");
          const name = this.next();
          if (name.kind !== "ident") throw evalError(this.src, "process.env 后必须是变量名");
          return this.ctx.env[name.value];
        }
        if (member.value === "platform") return this.ctx.platform;
        if (member.value === "cwd") {
          this.expectOp("(");
          this.expectOp(")");
          return this.ctx.cwd;
        }
        throw evalError(this.src, `process.${member.value} 不在白名单`);
      }
      if (t.value === "dshHomePath") {
        this.expectOp("(");
        const segments: string[] = [];
        if (!(this.peek()?.kind === "op" && this.peek()!.value === ")")) {
          for (;;) {
            const a = this.next();
            if (a.kind !== "str") throw evalError(this.src, "dshHomePath 参数必须是字符串字面量");
            segments.push(a.value);
            const d = this.peek();
            if (d?.kind === "op" && d.value === ",") {
              this.next();
              continue;
            }
            break;
          }
        }
        this.expectOp(")");
        const home = this.ctx.dshHome ?? this.ctx.env.DSH_HOME ?? join(homedir(), ".dsh");
        return join(home, ...segments);
      }
      throw evalError(this.src, `标识符 ${JSON.stringify(t.value)} 不在白名单`);
    }
    throw evalError(this.src, `意外的记号 ${JSON.stringify(t.value)}`);
  }
}

/** 求值单个 `!!js` 表达式（只信官方清单；本工程自产清单禁止使用 `!!js`） */
export function evaluateJsExpr(expr: JsExpr, ctx?: JsExprEvalContext): unknown {
  const tokens = tokenize(expr.__jsExpr);
  if (tokens.length === 0) throw evalError(expr.__jsExpr, "空表达式");
  const parser = new Parser(tokens, expr.__jsExpr, {
    env: ctx?.env ?? ({ ...process.env } as Record<string, string | undefined>),
    platform: ctx?.platform ?? process.platform,
    cwd: ctx?.cwd ?? process.cwd(),
    dshHome: ctx?.dshHome,
  });
  return parser.parse();
}

/** 深遍历配置树，把其中的 JsExpr 原文替换为求值结果（白名单求值） */
export function evaluateDeep<T>(value: T, ctx?: JsExprEvalContext): T {
  if (isJsExpr(value)) return evaluateJsExpr(value, ctx) as T;
  if (Array.isArray(value)) return value.map((v) => evaluateDeep(v, ctx)) as T;
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = evaluateDeep(v, ctx);
    return out as T;
  }
  return value;
}
