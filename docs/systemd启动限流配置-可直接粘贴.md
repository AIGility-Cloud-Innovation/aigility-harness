# systemd 服务配置：加装启动限流（紧急刹车）

> 配套：《待办-服务保活整改-通俗版.md》待办一
> 目标服务：`aigility-feishu-task-loop.service`

---

## 为什么改

今天的事故：这个服务每次启动都因"锁被占用"失败退出，而配置里 `Restart=always`
会**立刻无限重拉**，2 秒一次，累计 **140 次**，无上限、无告警、刷爆日志。

加两行限流后：**5 分钟内失败 5 次就停下**，进入 `failed` 状态等人处理，
不再无限重试。

---

## 改法：两个方案选一个

### 方案 A（推荐）：追加一个 override 文件，不动原文件

**好处**：原服务文件保持原样，改动可见、可随时删除回滚。

**第 1 步**：创建目录（若不存在）

```bash
mkdir -p ~/.config/systemd/user/aigility-feishu-task-loop.service.d
```

**第 2 步**：把下面内容写入该目录下的 `override.conf`

文件路径：`~/.config/systemd/user/aigility-feishu-task-loop.service.d/override.conf`

```ini
# 启动限流（2026-10-27）：防止崩溃后无限重拉刷爆日志/抢占资源
# 5 分钟内失败 5 次 → 停下进入 failed，等人处理
[Unit]
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Restart=always
RestartSec=10
```

**第 3 步**：生效

```bash
systemctl --user daemon-reload
systemctl --user restart aigility-feishu-task-loop.service
```

---

### 方案 B：直接改原服务文件

文件路径：`~/.config/systemd/user/aigility-feishu-task-loop.service`

完整内容（可直接整体替换）：

```ini
[Unit]
Description=AIGility Feishu Task Loop (agent 任务流水线)
After=network-online.target
Wants=network-online.target
# 启动限流（2026-10-27）：5 分钟内失败 5 次即停下，不无限重拉
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
WorkingDirectory=/home/johnny/AI/aigility-harness/examples/feishu-task-loop
Environment=NODE_ENV=production
Environment=WORKER_TEAM_TIMEOUT_MS=3600000
Environment=PATH=/home/johnny/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/home/johnny/AI/aigility-harness/node_modules/.bin/tsx /home/johnny/AI/aigility-harness/examples/feishu-task-loop/src/index.ts
Restart=always
RestartSec=10
StandardOutput=append:/tmp/aigility-feishu-task-loop.log
StandardError=append:/tmp/aigility-feishu-task-loop.log

[Install]
WantedBy=default.target
```

然后：

```bash
systemctl --user daemon-reload
systemctl --user restart aigility-feishu-task-loop.service
```

---

## 改完怎么验证

```bash
# 1. 服务应为 active (running)
systemctl --user status aigility-feishu-task-loop.service --no-pager | head -8

# 2. 限流参数应已生效（应输出 300000000 和 5）
systemctl --user show aigility-feishu-task-loop.service -p StartLimitIntervalUSec -p StartLimitBurst
```

**期望结果**：
- `Active: active (running)`
- `StartLimitIntervalUSec=5min`（或 300000000 微秒）
- `StartLimitBurst=5`

---

## 注意事项

1. **`StartLimitIntervalSec` / `StartLimitBurst` 属于 `[Unit]` 段**，
   不是 `[Service]` 段 —— 写错段落不生效（这是常见坑）。
2. 加限流后，若服务真的反复崩溃，**它会停下**。届时需人工排查后
   `systemctl --user reset-failed aigility-feishu-task-loop.service` 再启动。
   **这正是设计意图**：故障要显眼，不要静默。
3. 方案 A 里我**重复写了** `Restart` / `RestartSec`（override 会与主文件合并，
   这两项值相同，无副作用），目的是让 override 文件自成一体、便于阅读。
4. **本次不动手**：服务文件属系统配置，按约定由你确认后执行。

---

## 建议同时检查（可选）

`aigility-platform.service` 同样是 `Restart=on-failure` + `RestartSec=5`，
**也没有限流**。虽风险低于 loop（它不会因抢锁而失败），但建议一并加上：

```ini
[Unit]
StartLimitIntervalSec=300
StartLimitBurst=5
```

---

## 附：为什么不是"重启就好"

限流的价值不在恢复正常时，而在**故障时**：

| | 无限重试（现状） | 加限流后 |
|---|---|---|
| 日志 | 被失败记录刷爆 | 干净，一眼看到最后一条真实错误 |
| 资源 | 每 2 秒起进程，抢占 CPU/内存 | 停下，不占资源 |
| 排查 | 淹没在噪声里 | 明确看到 `failed` 状态 |
| 发现时机 | 等出大事才发现 | 立刻可见 |