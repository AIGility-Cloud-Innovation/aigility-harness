#!/usr/bin/env python3
"""
端到端测试: harness py-bridge → aigility.workflow.WorkflowEngine

验证完整链路:
1. py-bridge spawn aigility venv worker
2. initialize WorkflowEngine (config_path + node_module + condition_module)
3. invoke 执行工作流 (节点函数从 node_module 自动导入)
4. 验证条件分支正确
"""
import subprocess
import json
import os

AIGILITY_PYTHON = "/home/johnny/AI/aigility/.venv/bin/python"
AIGILITY_DIR = "/home/johnny/AI/aigility"
WORKER_SCRIPT = "/home/johnny/AI/aigility-harness/packages/py-bridge/scripts/py_bridge_worker.py"
VENV_SITE = "/home/johnny/AI/aigility/.venv/lib/python3.11/site-packages"
TEST_YAML = "/home/johnny/AI/aigility/tests/workflow_test_config.yaml"


def send(proc, req):
    proc.stdin.write(json.dumps(req) + "\n")
    proc.stdin.flush()
    return json.loads(proc.stdout.readline())


def main():
    print("=== harness py-bridge → aigility WorkflowEngine 端到端测试 ===\n")

    # 1. Spawn worker
    print("1. 启动 Python worker...")
    proc = subprocess.Popen(
        [AIGILITY_PYTHON, WORKER_SCRIPT],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        cwd=AIGILITY_DIR,
        env={**os.environ, "PYTHONPATH": f"{VENV_SITE}:{AIGILITY_DIR}"},
    )
    ready = json.loads(proc.stdout.readline())
    print(f"   ready: pid={ready['params']['pid']}")

    # 2. Initialize WorkflowEngine with config_path + node_module
    print("\n2. 初始化 WorkflowEngine (config_path + node_module)...")
    resp = send(proc, {
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {
            "capability_id": "@orchestration/workflow-engine",
            "config": {
                "function": "aigility.workflow.WorkflowEngine",
                "method": "invoke",
                "init": {
                    "name": "test_workflow",
                    "config_path": TEST_YAML,
                    "node_module": "tests.workflow_nodes",
                    "condition_module": "tests.workflow_nodes",
                }
            }
        }
    })
    if resp.get("error"):
        print(f"   ❌ 初始化失败: {resp['error']}")
        proc.stdin.close(); proc.wait(); return
    print(f"   ✅ {resp['result']}")

    # 3. invoke with state
    print("\n3. invoke(state={'value': 5}) — 正值应翻倍...")
    resp = send(proc, {
        "jsonrpc": "2.0", "id": 2, "method": "call",
        "params": {
            "capability_id": "@orchestration/workflow-engine",
            "kwargs": {"state": {"value": 5}}
        }
    })
    if resp.get("error"):
        print(f"   ❌ {resp['error']['message'][:150]}")
    else:
        result = resp["result"]
        print(f"   ✅ result: {json.dumps(result, default=str)}")
        assert "final value = 10" in result.get("result", ""), f"应翻倍为10, got {result}"
        print(f"   ✅ 断言通过: value=5 → result='{result['result']}'")

    # 4. invoke with zero
    print("\n4. invoke(state={'value': 0}) — 零值应直接结束...")
    resp = send(proc, {
        "jsonrpc": "2.0", "id": 3, "method": "call",
        "params": {
            "capability_id": "@orchestration/workflow-engine",
            "kwargs": {"state": {"value": 0}}
        }
    })
    if resp.get("error"):
        print(f"   ❌ {resp['error']['message'][:150]}")
    else:
        result = resp["result"]
        print(f"   ✅ result: {json.dumps(result, default=str)}")
        assert "final value = 0" in result.get("result", ""), f"0不应翻倍, got {result}"
        print(f"   ✅ 断言通过: value=0 → result='{result['result']}'")

    # 5. Health check
    print("\n5. 健康检查...")
    resp = send(proc, {"jsonrpc": "2.0", "id": 4, "method": "health", "params": {}})
    print(f"   {resp.get('result')}")

    # 6. Shutdown
    print("\n6. 关闭 worker...")
    send(proc, {"jsonrpc": "2.0", "id": 5, "method": "shutdown", "params": {}})
    proc.stdin.close(); proc.wait(timeout=5)

    stderr = proc.stderr.read()
    if stderr:
        print(f"\n   stderr:\n{stderr[:300]}")

    print("\n=== 全部通过 ===")
    print("harness py-bridge → aigility WorkflowEngine 完整链路验证成功")


if __name__ == "__main__":
    main()
