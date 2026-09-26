import { describe, it, expect } from "vitest";
import { extractRepoSpec, parseTaskIntent } from "./feishu-task-assistant.js";

describe("parseTaskIntent — 飞书任务意图", () => {
  it("建任务：<标题>", () => {
    expect(parseTaskIntent("建任务：周五交周报")).toEqual({
      kind: "task-need-repo",
      title: "周五交周报",
    });
  });

  it("建任务带截止日期", () => {
    expect(parseTaskIntent("创建任务 写周报 截止 2026-10-16")).toEqual({
      kind: "task-need-repo",
      title: "写周报",
      dueDate: "2026-10-16",
    });
  });

  it("建任务 @仓库 → 双建意图（C 方案）", () => {
    expect(parseTaskIntent("建任务 @video：修复登录页白屏")).toEqual({
      kind: "create",
      title: "修复登录页白屏",
      repo: "video",
    });
  });

  it("建任务 @仓库 + 截止日期 → 双建意图带截止", () => {
    expect(parseTaskIntent("建任务 @TiMEM-AI/x：写周报 截止 2026-10-16")).toEqual({
      kind: "create",
      title: "写周报",
      dueDate: "2026-10-16",
      repo: "TiMEM-AI/x",
    });
  });

  it("标题为空的建任务不算创建意图", () => {
    expect(parseTaskIntent("建任务：")).toEqual({ kind: "help" });
  });

  it("查询意图（多个触发词）", () => {
    for (const text of ["我的任务", "任务列表", "列出任务", "查任务", "看看任务"]) {
      expect(parseTaskIntent(text)).toEqual({ kind: "list" });
    }
  });

  it("完成 <关键字>", () => {
    expect(parseTaskIntent("完成 周报")).toEqual({ kind: "complete", keyword: "周报" });
    expect(parseTaskIntent("完成了 周报")).toEqual({ kind: "complete", keyword: "周报" });
  });

  it("其他输入 → 帮助", () => {
    expect(parseTaskIntent("你好")).toEqual({ kind: "help" });
  });
});

describe("parseTaskIntent — Gitea 工单意图", () => {
  it("建工单 @组织/仓库：<标题>（单行，显式全名）", () => {
    expect(
      parseTaskIntent("建工单 @TiMEM-AI/timem-platform-backend：修复登录页白屏"),
    ).toEqual({
      kind: "issue-create",
      repo: "TiMEM-AI/timem-platform-backend",
      title: "修复登录页白屏",
    });
  });

  it("建工单 @短名：<标题> —— 短名原样保留，full_name 解析在执行层", () => {
    expect(parseTaskIntent("建工单 @video：修复登录页白屏")).toEqual({
      kind: "issue-create",
      repo: "video",
      title: "修复登录页白屏",
    });
  });

  it("建工单缺仓库 → issue-need-repo（反问分支，不静默落默认仓库）", () => {
    expect(parseTaskIntent("建工单：修复登录页白屏")).toEqual({
      kind: "issue-need-repo",
      title: "修复登录页白屏",
    });
  });

  it("建工单多行 @仓库：首行标题其余为正文", () => {
    const intent = parseTaskIntent(
      "建工单 @video：修复登录页白屏\n复现步骤：打开首页\n期望：不白屏",
    );
    expect(intent).toEqual({
      kind: "issue-create",
      repo: "video",
      title: "修复登录页白屏",
      body: "复现步骤：打开首页\n期望：不白屏",
    });
  });

  it("标题为空的建工单不算创建意图", () => {
    expect(parseTaskIntent("建工单：")).toEqual({ kind: "help" });
  });

  it("extractRepoSpec：邮箱误触防护", () => {
    expect(parseTaskIntent("建工单：bob@example.com 收到投诉").kind).toBe("issue-need-repo");
  });

  it("工单列表（多个触发词）", () => {
    for (const text of ["工单列表", "我的工单", "列出工单"]) {
      expect(parseTaskIntent(text)).toEqual({ kind: "issue-list" });
    }
  });

  it("查工单 <#编号或关键字>", () => {
    expect(parseTaskIntent("查工单 #12")).toEqual({
      kind: "issue-show",
      ref: "#12",
    });
    expect(parseTaskIntent("查工单 登录页")).toEqual({
      kind: "issue-show",
      ref: "登录页",
    });
  });

  it("关闭工单 <#编号或关键字>（多个触发词）", () => {
    for (const text of ["关闭工单 #3", "完成工单 #3", "关单 #3"]) {
      expect(parseTaskIntent(text)).toEqual({
        kind: "issue-close",
        ref: "#3",
      });
    }
  });

  it("重开工单 <#编号或关键字>", () => {
    expect(parseTaskIntent("重开工单 #3")).toEqual({
      kind: "issue-reopen",
      ref: "#3",
    });
  });

  it("评论工单 <#编号> <内容>", () => {
    expect(parseTaskIntent("评论工单 #12 已修复，待发布")).toEqual({
      kind: "issue-comment",
      ref: "12",
      comment: "已修复，待发布",
    });
  });

  it("「完成工单 x」优先于任务意图「完成 x」，不被吞掉", () => {
    expect(parseTaskIntent("完成工单 白屏").kind).toBe("issue-close");
  });

  it("「建任务：修工单流程」仍是飞书任务意图（工单触发词优先但需命中）", () => {
    expect(parseTaskIntent("建任务：修工单流程")).toEqual({
      kind: "task-need-repo",
      title: "修工单流程",
    });
  });

  it("项目概览", () => {
    for (const text of ["项目概览", "项目状态", "整体概览", "概览"]) {
      expect(parseTaskIntent(text)).toEqual({ kind: "overview" });
    }
  });
});

describe("extractRepoSpec", () => {
  it("全名与短名均提取，并从文本剥离", () => {
    expect(extractRepoSpec("建工单 @TiMEM-AI/x：标题")).toEqual({
      text: "建工单 ：标题",
      repo: "TiMEM-AI/x",
    });
    expect(extractRepoSpec("建工单@video：标题")).toEqual({
      text: "建工单 ：标题",
      repo: "video",
    });
  });

  it("无仓库片段返回原文", () => {
    expect(extractRepoSpec("建工单：标题")).toEqual({ text: "建工单：标题" });
  });
});
