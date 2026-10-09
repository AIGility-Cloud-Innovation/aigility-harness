# @aigility-harness/layer-orchestration

编排规划层包，提供任务编排与 agentd 客户端等能力。

## UDS 调试示例

当 `TIMEM_AGENTD_SOCK` 和 `TIMEM_AGENTD_TOKEN` 已配置时，可通过 Unix Domain Socket 查询任务列表：

```bash
curl --unix-socket "$TIMEM_AGENTD_SOCK" -H "Authorization: Bearer $TIMEM_AGENTD_TOKEN" http://localhost/v1/tasks
```
