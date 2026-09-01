#!/usr/bin/env python3
"""端到端接入测试: harness py-bridge → aigility Memory + RAG"""
import sys
import os
import json
import subprocess
import time

# aigility venv python
AIGILITY_PYTHON = "/home/johnny/AI/aigility/.venv/bin/python"
AIGILITY_DIR = "/home/johnny/AI/aigility"
WORKER_SCRIPT = "/home/johnny/AI/aigility-harness/packages/py-bridge/scripts/py_bridge_worker.py"

def send(proc, req):
    """Send JSON-RPC request and read response."""
    proc.stdin.write(json.dumps(req) + "\n")
    proc.stdin.flush()
    line = proc.stdout.readline()
    return json.loads(line)

def main():
    print("=== py-bridge → aigility 端到端接入测试 ===\n")

    # 1. Spawn Python worker with aigility venv
    print("1. 启动 Python worker (aigility venv)...")
    venv_site = "/home/johnny/AI/aigility/.venv/lib/python3.11/site-packages"
    proc = subprocess.Popen(
        [AIGILITY_PYTHON, WORKER_SCRIPT],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        cwd=AIGILITY_DIR,
        env={**os.environ, "PYTHONPATH": f"{venv_site}:{AIGILITY_DIR}"},
    )

    # Read ready notification
    ready = json.loads(proc.stdout.readline())
    print(f"   ready: pid={ready['params']['pid']}, python={ready['params']['python']}")

    # 2. Initialize Memory capability
    print("\n2. 初始化 @cognitive/memory (aigility.memory.Memory)...")
    resp = send(proc, {
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {
            "capability_id": "@cognitive/memory",
            "config": {
                "function": "aigility.memory.Memory",
                "method": "search",
                "init": {},  # 默认配置, 从环境变量读 TIMEM_API_KEY
            }
        }
    })
    print(f"   result: {resp.get('result', resp.get('error'))}")

    if resp.get("error"):
        print("   ⚠️ Memory 初始化失败 (可能缺少 TIMEM_API_KEY), 跳过 Memory 测试")
    else:
        # 3. Call Memory.search
        print("\n3. 调用 Memory.search(query='你好', user_id='test_user')...")
        resp = send(proc, {
            "jsonrpc": "2.0", "id": 2, "method": "call",
            "params": {
                "capability_id": "@cognitive/memory",
                "kwargs": {
                    "query": "你好",
                    "user_id": "test_user",
                    "limit": 5,
                }
            }
        })
        if resp.get("error"):
            print(f"   ⚠️ Memory.search 失败: {resp['error']}")
        else:
            result = resp["result"]
            print(f"   ✅ Memory.search 成功!")
            print(f"   结果: {json.dumps(result, ensure_ascii=False, default=str)[:500]}")

    # 4. Initialize RAG capability (may fail without embedding config, that's OK)
    print("\n4. 初始化 @cognitive/rag-retrieval (aigility.rag.RAGService)...")
    resp = send(proc, {
        "jsonrpc": "2.0", "id": 3, "method": "initialize",
        "params": {
            "capability_id": "@cognitive/rag-retrieval",
            "config": {
                "function": "aigility.rag.RAGService",
                "method": "search",
                "init": {},  # 默认配置
            }
        }
    })
    print(f"   result: {resp.get('result', resp.get('error'))}")

    if resp.get("error"):
        print("   ⚠️ RAG 初始化失败 (可能缺少 embedding/向量库配置), 跳过 RAG 测试")
    else:
        # 5. Call RAG.search
        print("\n5. 调用 RAG.search(query='什么是机器学习')...")
        resp = send(proc, {
            "jsonrpc": "2.0", "id": 4, "method": "call",
            "params": {
                "capability_id": "@cognitive/rag-retrieval",
                "kwargs": {"query": "什么是机器学习"}
            }
        })
        if resp.get("error"):
            print(f"   ⚠️ RAG.search 失败: {resp['error']}")
        else:
            result = resp["result"]
            print(f"   ✅ RAG.search 成功!")
            print(f"   结果: {str(result)[:500]}")

    # 6. Health check
    print("\n6. 健康检查...")
    resp = send(proc, {
        "jsonrpc": "2.0", "id": 5, "method": "health",
        "params": {}
    })
    print(f"   {resp.get('result', resp.get('error'))}")

    # 7. Shutdown
    print("\n7. 关闭 worker...")
    send(proc, {
        "jsonrpc": "2.0", "id": 6, "method": "shutdown",
        "params": {}
    })
    proc.stdin.close()
    proc.wait(timeout=5)

    # Check stderr
    stderr = proc.stderr.read()
    if stderr:
        print(f"\n   stderr:\n{stderr[:1000]}")

    print("\n=== 测试完成 ===")

if __name__ == "__main__":
    main()
