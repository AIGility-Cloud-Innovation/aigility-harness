# 本机 qwen3.5 接入事实核查（含对我此前错误结论的更正）

> 来源：本机实际进程 + 实际配置文件 + 实测请求，2026-10-07 逐条复现。
> 核查对象：LiteLLM 兜底链末位的本机 ollama `qwen3.5`，以及 `11434` 直连 vs `48724` 网关的行为差异。
>
> **本文的主要目的是更正我在之前对话中给出的三条错误结论**（见文末「修正记录」）。
> 那些错误已经说出口了，不落文档的话，下次排查会重新走一遍同样的弯路。

---

## 0. 一句话总览

让本机 `qwen3.5` 正常出正文的**唯一变量是协议**，不是参数：

```
11434  /v1/chat/completions  + think:false  →  content 0，全进 reasoning   ❌
11434  /api/chat  (ollama 原生) + think:false  →  content 正常，thinking 0   ✅
48724  litellm → 11434（走 ollama/ 原生）    →  content 正常，reasoning 0   ✅
```

**真正的单点风险不是「有人删掉 `think:false`」，而是「有人把 litellm 上游从 `ollama/` 原生协议改成 `/v1` 兼容层」。**
`think` 参数在 `/v1` 上**无效**，到那时它救不了你，而症状恰好是规范第五条那个探针的样子 —— 按现行规范排查会指向错误方向。

---

## 1. 权威配置文件是哪一份（易踩）

本机存在**两份** litellm config，只有一份是活的：

| 路径 | 内容 | 状态 |
|---|---|---|
| `~/.local/litellm-venv/config.yaml` | 含 `qwen3.5` ollama 条目、`master_key: sk-1234` | ✅ **活的**（进程实际加载） |
| `~/.local/share/litellm-proxy/config.yaml` | 仅 ModelArts/金山云，**无 qwen3.5 条目** | ⚠️ 未被当前进程加载 |

判定依据（实测）：

```
$ ss -ltnp | grep 48724
LISTEN 127.0.0.1:48724  users:(("litellm",pid=1471033,...))

$ ps aux | grep litellm
litellm --config /home/johnny/.local/litellm-venv/config.yaml --port 48724 --host 127.0.0.1
```

> 结论：**排查 qwen3.5 兜底链时只认 `~/.local/litellm-venv/config.yaml`。** 改另一份不会生效。

---

## 2. 关键配置行（`~/.local/litellm-venv/config.yaml`）

```yaml
  6  - model_name: qwen3.5
  7    litellm_params:
  8      model: ollama/qwen3.5:latest      # ← 原生协议，这是它工作正常的原因
  9      api_base: http://127.0.0.1:11434  # ← 确实直连 11434，但这本身不是 bug
 12      think: false                      # ← 注记「必须在参数层关」具有误导性，见 §3
...
483    - {"ksyun-deepseek-v4-flash": ["bigmodel-glm-5.3-flash", "qwen3.5"]}
484    - {"ksyun-deepseek-v4.1-flash": ["bigmodel-glm-5.3-flash", "qwen3.5"]}
...
491    default_keep_alive_timeout: 600     # ← 被窗口预热的 keep_alive 覆盖，见 §5
```

**「经 11434 出去」本身不是问题** —— 问题是**协议层**（`/v1` vs `/api/chat`），而 litellm 恰好选对了（`ollama/` 前缀 → 原生协议）。
之前把「litellm 直连 11434」报成 bug 是**报错了对象**。

---

## 3. 决定性 A/B：`think` 在 `/v1` 上失效（实测复现）

同 prompt（「说"正常"两个字」）、同 `max_tokens`，只差端点：

| 端点 | `think` | 结果 |
|---|---|---|
| `11434 /v1/chat/completions` | `false` | `content_len 0`，`reasoning_len 58` ❌ |
| `11434 /api/chat`（原生） | `false` | `content_len 3`（「正常。」），`thinking_len 0` ✅ |
| `48724 /v1/chat/completions`（litellm） | 不传 | `content_len 2`（「正常」），`reasoning_len 0` ✅ |

> **要点：`think:false` 在 11434 的 `/v1` 路径上被无视，和不传一模一样。**
> 真正起作用的是 **ollama 原生 `/api/chat`** —— 它在服务端就把思考剥掉了。
> 所以第 12 行的注释「必须在参数层关 `think`」是**误导性注记**：参数不是防线，**协议才是**。

---

## 4. 排查探针（诊断用）

```bash
# 原生协议是否正常（唯一该信的判据）
curl -s http://127.0.0.1:11434/api/chat -H 'Content-Type: application/json' \
  -d '{"model":"qwen3.5","messages":[{"role":"user","content":"说\"正常\"两个字"}],"stream":false,"think":false}' \
  | python3 -c "import sys,json;m=json.load(sys.stdin)['message'];print('content_len',len(m.get('content') or ''),'| thinking_len',len(m.get('thinking') or ''))"
# 期望：content_len > 0，thinking_len 0

# 兜底链端到端
curl -s http://127.0.0.1:48724/v1/chat/completions -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer sk-1234' \
  -d '{"model":"qwen3.5","messages":[{"role":"user","content":"说\"正常\"两个字"}],"max_tokens":32}' \
  | python3 -c "import sys,json;m=json.load(sys.stdin)['choices'][0]['message'];print('content_len',len(m.get('content') or ''),'| reasoning_len',len(m.get('reasoning_content') or ''))"
```

**若端到端 `content_len 0` 而 `/api/chat` 正常** → 去查 litellm 第 8 行是否被人改成了 `/v1` 兼容写法（如 `openai/...` 指向 11434），**不要去查 `think` 参数、也不要去查「谁直连了 11434」**。

---

## 5. 显存窗口机制（实存，且之前的说法两次都不对）

### 5.1 窗口调度确实存在

```
$ systemctl --user list-timers --all | grep qwen
Thu 2026-10-08 09:58:00  qwen-warmup.timer     qwen-warmup.service
Thu 2026-10-08 14:58:00  qwen-warmup-pm.timer  qwen-warmup-pm.service
```

`~/.local/bin/qwen-warmup.sh` 打 `/api/generate` 带 `keep_alive=<150m|200m>`，**提前 2 分钟预热**。
（之前说「全机找不到任何窗口调度逻辑」是**检索口径太窄**：只查了 `config.yaml` 和 `crontab`，没查 systemd user timers。）

### 5.2 `expires_at` 续期语义（受控实测）

```
T0 expires: 20:07:45   (17:37:48)
  空闲 30s，无请求
T1 expires: 20:07:45   → delta +0.0s    # 闲置不漂移
  发 1 次请求（约 33s 往返）
T2 expires: 20:08:18   → delta +33.4s   # 请求确实续期，且按 now+keep_alive 重算
```

**更正后的语义：**
- **空闲时 `expires_at` 不漂移**；**发请求会续期**，续到 `now + keep_alive`。
- 当前 `keep_alive` ≈ **150m**（17:37 时到期 20:07），**不是** `default_keep_alive_timeout: 600`(10m) —— 窗口预热的 `keep_alive` **覆盖**了默认值。
- 因此真实图景是：**预热窗口内被 150m 钉住；窗口外回归默认 600s**。

> 之前的两版说法**都不准确**：第一版说「一调就续 10 分钟、永不卸载」（时长错，且忽略了窗口覆盖）；
> 第二版说「请求不改 `expires_at`」（采样太粗，**结论错**）。

---

## 6. 修正记录

本文更正了我在之前对话中给出的以下结论。原话已出口，此处留存以免将来被旧说法带偏：

| # | 我此前的说法 | 实测结论 | 判定 |
|---|---|---|---|
| 1 | `think:false` 是那道「唯一防线」，删了 48724 就坏 | `/v1` 上 `think:false` 被无视；防线是**协议**（原生 `/api/chat`） | ❌ **推翻** |
| 2 | 全机找不到任何显存窗口调度逻辑 | systemd user timer `09:58`/`14:58` 实存，预热脚本带 `keep_alive` | ❌ **推翻**（检索口径太窄） |
| 3 | 请求会续期，一调续 10 分钟、永不卸载 | 续期属实，但时长是窗口的 **150m**，非 600s | ⚠️ **修正** |
| 4 | 请求不改 `expires_at`（第二轮的说法） | 受控实测：请求 **+33.4s**，确实续期 | ❌ **推翻**（我第二轮的"更正"本身是错的） |
| 5 | litellm 直连 11434 是 bug | 经 11434 出去本身没问题，问题是协议层；litellm 选对了 | ❌ **报错了对象** |
| 6 | 兜底链末位是 qwen3.5（第 483/484 行）；`master_key: sk-1234` | 属实 | ✅ |
| 7 | 11434 `/v1` 直连静默失败（200 但无正文） | 复现：`content 0 / reasoning 58` | ✅ |

**规范第一、四、五条本身依然成立**；被推翻的是**我对成因的解释**。

---

## 7. 处置记录（T2 / T3 已执行）

### 7.1 T2 —— 已改：误导性注记（已完成 ✅）

**被改对象**：`~/.local/litellm-venv/config.yaml` 的注记（**不在本仓库内**，是活的网关配置）。

原文：
```yaml
      think: false   # qwen3.5 思考模式啰嗦且 /no_think 软开关无效，必须在参数层关
```

**为什么改**：该注记现为**活性误导** —— 真出故障时它把人指向「是不是删了参数」，
而真正的单点是「上游协议是否被换成 `/v1`」。照它排查会走错方向。

改后（**仅注释，行为不变**）：
```yaml
      # think: false 保留无害，但它不是防线 —— 真正让 qwen3.5 出正文的是上面
      # 第 8 行的 ollama/ 前缀（原生 /api/chat 协议）。若把第 8 行换成 /v1 兼容
      # 写法（openai/... 指向 11434），本参数会被无视，症状是 200 但 content 为空、
      # 内容全进 reasoning。排查见 docs/local-qwen3.5-access-notes.md §3/§4。
      think: false
```

**安全性验证（实测）**：
- YAML 解析通过；`yaml.safe_load(新) == yaml.safe_load(旧)` → **True**（语义完全一致）。
- 只动注释行，`litellm_params` 逐键相等（`think: False` 保留）。
- 进程未重启（pid 1471033 未变；该配置本就在启动时加载）；网关实测仍 `content_len 2 / reasoning_len 0`。
- 改前已备份：`config.yaml.bak-20261007`（回退 = `cp` 覆盖回去）。

### 7.2 T3 —— 不做：给 litellm 换路（已关闭 ❌）

**结论：不做，永久关闭**。它走的原生协议**本来就是正确的那条**，换路是**纯粹的风险增量、收益为零**。
（T3 当初进列表的前提「`think:false` 是唯一防线」已被本文 §3/§6 推翻。）

**关闭依据（本轮复测）**：
- litellm → 11434 走 `ollama/` 前缀 = 原生 `/api/chat`，实测 `content_len 2 / reasoning_len 0` ✅
- 兜底链端到端（`ksyun-deepseek-v4.1-flash` → … → `qwen3.5`）实测正常出正文 ✅
- 即「本机 qwen3.5 兜底」这条链路**当前是健康的**，没有需要修的故障。

**附带核实**（针对新加的「思考等级」参数直通，见平台侧改动）：
`general_settings.drop_params: true` 使客户端多带的供应商专有参数
（如 `enable_thinking` / `thinking_budget`）被**静默忽略**而非报错 ——
实测对 `qwen3.5` 带 `enable_thinking:true` 与 `thinking_budget:1024` 均正常返回正文，
**不会因参数不兼容而炸链路**。这与认知层注释「drop_params 会静默忽略」的假设一致。

### 7.3 仍建议保留的两条

1. **不要加 `keep_alive` 防护**：实测无显存泄漏，语义是「窗口内钉住、窗口外回归默认」。
2. **改动 litellm config 第 8 行前先读本文 §3**：`ollama/` 前缀是那条链路的活性单点 ——
   改它 = 改协议 = 唯一会让 qwen3.5 静默失效（200 但零正文）的动作。