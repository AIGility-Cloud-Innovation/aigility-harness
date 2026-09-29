#!/usr/bin/env node
/**
 * 最小 stdio MCP 测试 server（无第三方依赖，原生 JSON-RPC 2.0）
 * 暴露一个 echo 工具: mcp__demo__echo
 */
import readline from "node:readline";

const SERVER_INFO = { name: "demo-server", version: "0.1.0" };
const TOOLS = [
  {
    name: "echo",
    description: "原样返回输入文本，用于验证 MCP 通道",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "要回显的文本" } },
      required: ["text"],
    },
  },
];

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
function replyError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try { msg = JSON.parse(trimmed); } catch { return; }
  const { id, method, params } = msg;
  switch (method) {
    case "initialize":
      reply(id, {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
      break;
    case "notifications/initialized":
      break; // 通知无需应答
    case "tools/list":
      reply(id, { tools: TOOLS });
      break;
    case "tools/call": {
      const text = String(params?.arguments?.text ?? "");
      reply(id, {
        content: [{ type: "text", text: `📢 MCP echo: ${text}` }],
      });
      break;
    }
    default:
      if (id !== undefined) replyError(id, -32601, `method not found: ${method}`);
  }
});
