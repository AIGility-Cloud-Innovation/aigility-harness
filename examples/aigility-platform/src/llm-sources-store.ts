/**
 * llm-sources-store —— litellm「来源节点」受控读写（LLM 来源节点管理 · 数据层）
 *
 * 单一事实源 = litellm 的 config.yaml（model_list）。本模块只做三件事：
 *   ① 解析：model_list → 来源节点分组（api_base+密钥引用 相同的条目同源）+ 别名识别
 *      （同源内 upstream 模型相同的多条目：首条为正名，其余视为该正名的别名）
 *   ② 受控变更：别名新增（克隆正名条目）、模型移除（仅别名可移，正名是来源唯一路由）
 *   ③ 安全落盘：写前备份（保留最近 5 份）+ 临时文件原子替换
 *
 * 密钥安全：api_key 恒为 os.environ/<VAR> 占位符引用——本模块不接触明文密钥，
 * keyRef 只暴露环境变量名供前端展示。
 */
import { readFileSync, writeFileSync, renameSync, unlinkSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import yaml from "js-yaml";

const DEFAULT_CONFIG_PATH = "/home/johnny/.local/litellm-venv/config.yaml";
const BACKUP_KEEP = 5;

export interface SourceModel {
  name: string;
  upstreamModel: string;
  rpm?: number;
  tpm?: number;
}

export interface SourceNode {
  id: string;
  label: string;
  apiBase: string;
  keyRef: string;
  models: SourceModel[];
  aliases: string[];
}

export interface SourcesSnapshot {
  configPath: string;
  sources: SourceNode[];
  modelCount: number;
  updatedAt: string;
}

interface ModelListEntry {
  model_name: string;
  litellm_params: Record<string, unknown>;
}

function configPathFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return env["LITELLM_CONFIG_PATH"] ?? DEFAULT_CONFIG_PATH;
}

function hostLabel(apiBase: string): string {
  let host = apiBase;
  try { host = new URL(apiBase).host; } catch { /* 保持原值 */ }
  if (/ksyun/i.test(host)) return "金山云 KSyun";
  if (/bigmodel/i.test(host)) return "智谱 BigModel";
  if (/timem/i.test(host)) return "太忆 Timem";
  if (/deepseek/i.test(host)) return "DeepSeek";
  if (/dashscope/i.test(host)) return "阿里云 DashScope";
  if (/localhost|127\.0\.0\.1/i.test(host)) return "本机网关";
  return host;
}

function keyRefOf(apiKey: unknown): string {
  const s = typeof apiKey === "string" ? apiKey : "";
  const m = s.match(/^os\.environ\/([A-Za-z_][A-Za-z0-9_]*)$/);
  return m ? m[1] : "(inline)";
}

interface EntryRef { upstreamModel: string; apiBase: string; keyRef: string }

function entryRef(p: Record<string, unknown>): EntryRef {
  return {
    upstreamModel: String(p["model"] ?? ""),
    apiBase: String(p["api_base"] ?? ""),
    keyRef: keyRefOf(p["api_key"]),
  };
}

export class LlmSourcesStore {
  constructor(private readonly configPath: string = configPathFromEnv()) {}

  private load(): { model_list: ModelListEntry[] } & Record<string, unknown> {
    if (!existsSync(this.configPath)) {
      throw new Error(`litellm 配置不存在: ${this.configPath}`);
    }
    const parsed = yaml.load(readFileSync(this.configPath, "utf8")) as
      | { model_list?: ModelListEntry[] }
      | null;
    if (!parsed || !Array.isArray(parsed.model_list)) {
      throw new Error("litellm 配置缺少 model_list，拒绝管理（防误伤其他网关）");
    }
    return { model_list: parsed.model_list } as { model_list: ModelListEntry[] } & Record<string, unknown>;
  }

  private save(modelList: ModelListEntry[]): void {
    const dir = dirname(this.configPath);
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    const backup = `${this.configPath}.bak-${stamp}`;
    if (existsSync(this.configPath)) writeFileSync(backup, readFileSync(this.configPath));
    this.pruneBackups(backup);
    const tmp = `${this.configPath}.tmp-${process.pid}`;
    writeFileSync(tmp, yaml.dump({ model_list: modelList }, { lineWidth: -1 }), "utf8");
    renameSync(tmp, this.configPath);
  }

  private pruneBackups(keepPath: string): void {
    const dir = dirname(keepPath);
    const base = this.configPath.replace(/^.*\//, "");
    const bakPrefix = `${base}.bak-`;
    const baks = readdirSync(dir).filter((f) => f.startsWith(bakPrefix)).sort().reverse();
    for (const old of baks.slice(BACKUP_KEEP)) {
      try { unlinkSync(join(dir, old)); } catch { /* 忽略 */ }
    }
  }

  /** 快照：来源分组 + 别名识别（纯只读） */
  snapshot(): SourcesSnapshot {
    const { model_list } = this.load();
    const groups = new Map<string, SourceNode & { aliases: string[] }>();
    const order: string[] = [];
    for (const e of model_list) {
      const p = (e.litellm_params ?? {}) as Record<string, unknown>;
      const ref = entryRef(p);
      const id = `${ref.apiBase}#${ref.upstreamModel}`;
      let node = groups.get(id);
      if (!node) {
        node = { id, label: hostLabel(ref.apiBase), apiBase: ref.apiBase, keyRef: ref.keyRef, models: [], aliases: [] };
        groups.set(id, node);
        order.push(id);
      }
      node.models.push({ name: e.model_name, upstreamModel: ref.upstreamModel, rpm: p["rpm"] as number | undefined, tpm: p["tpm"] as number | undefined });
    }
    // 别名识别：同源内 upstream 模型相同的非首条目 = 别名
    for (const node of groups.values()) {
      const seen = new Set<string>();
      for (const m of node.models) {
        if (seen.has(m.upstreamModel)) node.aliases.push(m.name);
        else seen.add(m.upstreamModel);
      }
    }
    const sources: SourceNode[] = order.map((id) => groups.get(id)!);
    const modelCount = sources.reduce((n, s) => n + s.models.length, 0);
    return {
      configPath: this.configPath,
      sources: sources.map(({ id, label, apiBase, keyRef, models, aliases }) => ({ id, label, apiBase, keyRef, models, aliases })),
      modelCount,
      updatedAt: new Date().toISOString(),
    };
  }

  /** 别名新增：克隆目标正名条目的上游参数（不改目标本身） */
  addAlias(aliasName: string, targetModelName: string): { model: SourceModel } {
    const snap = this.snapshot();
    const target = snap.sources.flatMap((s) => s.models).find((m) => m.name === targetModelName);
    if (!target) throw new Error(`目标模型不存在: ${targetModelName}`);
    if (snap.sources.some((s) => s.models.some((m) => m.name === aliasName))) {
      throw new Error(`模型名已存在: ${aliasName}`);
    }
    const { model_list } = this.load();
    const targetEntry = model_list.find((e) => e.model_name === targetModelName);
    if (!targetEntry) throw new Error(`目标条目不存在: ${targetModelName}`);
    model_list.push({
      model_name: aliasName,
      litellm_params: JSON.parse(JSON.stringify(targetEntry.litellm_params)) as Record<string, unknown>,
    });
    this.save(model_list);
    return { model: { name: aliasName, upstreamModel: target.upstreamModel, apiBase: target.apiBase, keyRef: target.keyRef } };
  }

  /** 模型移除：仅移除指名条目；同来源+同上游的最后一个模型拒绝移除（防来源悬空） */
  removeModel(name: string): { removed: boolean } {
    const { model_list } = this.load();
    const entry = model_list.find((e) => e.model_name === name);
    if (!entry) throw new Error(`模型不存在: ${name}`);
    const ref = entryRef((entry.litellm_params ?? {}) as Record<string, unknown>);
    const sameRoute = model_list.filter(
      (e) => e !== entry &&
        entryRef((e.litellm_params ?? {}) as Record<string, unknown>).apiBase === ref.apiBase &&
        entryRef((e.litellm_params ?? {}) as Record<string, unknown>).upstreamModel === ref.upstreamModel,
    );
    if (sameRoute.length === 0) {
      throw new Error(`拒绝移除：${name} 是路由 ${ref.apiBase} → ${ref.upstreamModel} 的最后一个模型，移除将导致来源悬空`);
    }
    this.save(model_list.filter((e) => e.model_name !== name));
    return { removed: true };
  }
}
