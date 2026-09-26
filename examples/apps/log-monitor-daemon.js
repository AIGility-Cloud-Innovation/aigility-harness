#!/usr/bin/env node
/**
 * 日志监察员 · 后台守护进程（零依赖，Node 18+）
 *
 * 用法:
 *   node log-monitor-daemon.js            # 前台运行
 *   Windows: 双击 log-monitor-install.cmd  # 注册登录自启(隐藏窗口), 卸载用 log-monitor-uninstall.cmd
 *   Linux:   pm2 start log-monitor-daemon.js
 * 就绪后浏览器直接打开 http://<本机>:39467/ 即监控页面(daemon 同目录托管 log-monitor.html)
 *
 * 功能:
 *   - 按 config.json 中的自动化列表定时拉取日志、匹配错误关键字、飞书通知
 *   - 去重表 / 错误记录持久化到 daemon-state.json，重启不丢、不重复告警
 *   - HTTP API (默认 :39467) 供 log-monitor.html 页面查看状态 / 下发配置
 *     GET  /status   状态 + 最近错误
 *     GET  /config   当前配置
 *     PUT  /config   下发配置 {webhook, keywords, autos:[...]}
 */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");

const BASE = __dirname;
const CFG_FILE = path.join(BASE, "log-monitor-daemon-config.json");
const STATE_FILE = path.join(BASE, "log-monitor-daemon-state.json");
const API_PORT = parseInt(process.env.LOGMON_PORT || "39467", 10);
const SCAN_MS = 15 * 1000;

// ---- 配置与状态 ----
let cfg = { webhook: "", keywords: "ERROR,Traceback,Exception", autos: [] };
let state = { seen: {}, errs: [], startedAt: Date.now(), checkCount: 0 };

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return fallback; }
}
function saveJson(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch (e) { console.error("[daemon] 写文件失败:", e.message); }
}
function loadAll() {
  cfg = Object.assign(cfg, loadJson(CFG_FILE, {}));
  if (!Array.isArray(cfg.autos)) cfg.autos = [];
  state = Object.assign(state, loadJson(STATE_FILE, {}));
  if (!state.seen) state.seen = {};
  if (!state.errs) state.errs = [];
  // 每条自动化维护运行时字段
  cfg.autos.forEach(a => {
    a.interval = Math.max(1, a.interval || 5);
    a.n = Math.max(10, a.n || 150);
    if (!a.nextAt) a.nextAt = 0;
    a.checking = false; a.lastAt = a.lastAt || 0; a.lastErr = "";
  });
}

function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return "" + h; }
function matchKeywords(line) {
  const kws = (cfg.keywords || "ERROR").split(",").map(k => k.trim().toLowerCase()).filter(Boolean);
  const low = line.toLowerCase();
  for (const k of kws) if (low.indexOf(k) >= 0) return k;
  return null;
}
function logUrl(a) {
  return a.host + "/look_log?p=" + encodeURIComponent(a.p) + "&s=" + encodeURIComponent(a.s) + "&n=" + a.n;
}

// ---- 飞书通知（Node 18+ 全局 fetch）----
async function sendFeishu(text) {
  if (!cfg.webhook) throw new Error("未配置飞书 Webhook");
  const r = await fetch(cfg.webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ msg_type: "text", content: { text } })
  });
  const d = await r.json();
  if (d.code !== undefined && d.code !== 0) throw new Error("飞书返回: " + (d.msg || d.code));
}

// ---- 拉取日志（服务端直连，无 CORS 问题）----
async function fetchLog(a) {
  const r = await fetch(logUrl(a), { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.text();
}

async function checkOnce(a) {
  if (a.checking) return;
  a.checking = true;
  try {
    const text = await fetchLog(a);
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    const fresh = [];
    lines.forEach(l => {
      if (!matchKeywords(l)) return;
      const h = hash(l);
      const m = state.seen[a.id] = state.seen[a.id] || {};
      if (m[h]) return;
      m[h] = 1;
      const keys = Object.keys(m);
      if (keys.length > 500) delete m[keys[0]];
      fresh.push(l);
    });
    a.lastAt = Date.now();
    a.nextAt = a.lastAt + a.interval * 60 * 1000;
    a.lastErr = "";
    state.checkCount++;
    if (fresh.length) {
      const now = new Date().toLocaleString("zh-CN");
      fresh.slice(0, 5).forEach(l => state.errs.unshift({ t: now, src: a.p + " / " + a.s, line: l }));
      state.errs = state.errs.slice(0, 100);
      const notice = "🚨 [守护进程] 日志监察员发现 " + fresh.length + " 条新错误\n" +
        "目标: " + a.p + " / " + a.s + "\n时间: " + now + "\n\n" +
        fresh.slice(0, 10).join("\n").slice(0, 2500) + "\n\n查看: " + logUrl(a);
      try { await sendFeishu(notice); }
      catch (e) { console.error("[" + a.p + "] 飞书通知失败:", e.message); }
      console.log("[" + a.p + "] 发现 " + fresh.length + " 条新错误");
    }
  } catch (e) {
    a.lastErr = e.message;
    console.error("[" + a.p + "] 拉取失败:", e.message);
  } finally {
    a.checking = false;
    saveJson(STATE_FILE, state);
  }
}

// ---- 主循环 ----
loadAll();
setInterval(async () => {
  const now = Date.now();
  for (const a of cfg.autos) {
    if (a.on && !a.checking && now >= a.nextAt) {
      a.nextAt = now + a.interval * 60 * 1000; // 先约下次，避免长耗时导致重复触发
      await checkOnce(a);
    }
  }
}, SCAN_MS);
// 启动即各查一次
cfg.autos.filter(a => a.on).forEach(a => { a.nextAt = 0; checkOnce(a); });

// ---- HTTP API（供页面查看状态 / 下发配置）----
const server = http.createServer((req, res) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
  // 同目录托管监控页面: 浏览器直接开 http://<本机>:39467/ 即用, 页面无需另行部署
  if (req.method === "GET" && (req.url === "/" || req.url.split("?")[0] === "/log-monitor.html")) {
    try {
      res.writeHead(200, Object.assign({ "Content-Type": "text/html; charset=utf-8" }, cors));
      res.end(fs.readFileSync(path.join(BASE, "log-monitor.html")));
    } catch (e) {
      res.writeHead(500, cors);
      res.end("log-monitor.html 未与 daemon 同目录部署");
    }
    return;
  }
  res.writeHead(200, cors);
  if (req.method === "OPTIONS") return res.end();

  if (req.method === "GET" && req.url.startsWith("/status")) {
    const q = new URL(req.url, "http://x").searchParams;
    const limit = Math.min(100, parseInt(q.get("errs") || "20", 10));
    res.end(JSON.stringify({
      ok: true, pid: process.pid, startedAt: state.startedAt,
      checkCount: state.checkCount, time: Date.now(),
      autos: cfg.autos.map(a => ({
        p: a.p, s: a.s, host: a.host, interval: a.interval, on: a.on,
        checking: a.checking, lastAt: a.lastAt, lastErr: a.lastErr
      })),
      errs: state.errs.slice(0, limit)
    }));
    return;
  }
  if (req.method === "GET" && req.url.startsWith("/config")) {
    res.end(JSON.stringify({ ok: true, cfg }));
    return;
  }
  if (req.method === "PUT" && req.url.startsWith("/config")) {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      try {
        const d = JSON.parse(body);
        if (typeof d.webhook === "string") cfg.webhook = d.webhook;
        if (typeof d.keywords === "string" && d.keywords.trim()) cfg.keywords = d.keywords.trim();
        if (Array.isArray(d.autos)) {
          const keepIds = new Set();
          let seq = 1;
          cfg.autos = d.autos.map(x => {
            const id = x.id && state.seen[x.id] ? x.id : "d" + (seq++) + "_" + x.p;
            keepIds.add(id);
            return {
              id, host: x.host, p: x.p, s: x.s || "app",
              n: Math.max(10, x.n || 150), interval: Math.max(1, x.interval || 5),
              on: x.on !== false, nextAt: 0, checking: false, lastAt: 0, lastErr: ""
            };
          });
          Object.keys(state.seen).forEach(k => { if (!keepIds.has(k)) delete state.seen[k]; });
        }
        saveJson(CFG_FILE, cfg);
        saveJson(STATE_FILE, state);
        cfg.autos.filter(a => a.on).forEach(a => checkOnce(a));
        res.end(JSON.stringify({ ok: true }));
        console.log("[daemon] 已接收页面下发配置: " + cfg.autos.length + " 条自动化");
      } catch (e) {
        res.statusCode = 400;
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ ok: false, error: "not found" }));
});
server.on("error", e => {
  console.error("[daemon] API 端口 " + API_PORT + " 启动失败:", e.message, "（监控仍继续运行，仅页面无法连接）");
});
server.listen(API_PORT, "0.0.0.0", () => {
  console.log("[daemon] 日志监察守护进程已启动");
  console.log("[daemon] 监控 " + cfg.autos.filter(a => a.on).length + " 条自动化, API: http://0.0.0.0:" + API_PORT + "/status");
});
