#!/usr/bin/env python3
"""
py_bridge_worker.py — 通用 Python bridge worker for aigility-harness.

协议: JSON-RPC 2.0 over stdin/stdout (line-delimited, 无端口).
生命周期:
  1. TS 侧 spawn 本进程, 发 initialize 请求 (带配置)
  2. 本进程动态 import Python 模块, 实例化对象, 缓存
  3. 后续 call 请求直接调缓存实例的方法
  4. health 请求返回实例状态
  5. shutdown 请求优雅退出

性能设计:
  - 单进程多实例: 一个 worker 服务多个 capability, 避免反复 fork
  - 实例缓存: initialize 只跑一次, 后续 call 零开销导入
  - 批量调用: 支持 batch 请求 (JSON-RPC 2.0 数组), 一次往返多个调用
  - 预热: import 在 initialize 阶段完成, call 阶段纯执行
  - 无序列化开销: 用 json.dumps(ensure_ascii=False, separators=(',',':')) 紧凑序列化
"""

import sys
import os
import json
import asyncio
import importlib
import traceback
import inspect
from typing import Any, Optional
from concurrent.futures import ThreadPoolExecutor

# ── 紧凑 JSON 编解码 ──────────────────────────────────────────────

def _dumps(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, separators=(',', ':'), default=_json_default)

def _json_default(obj: Any) -> Any:
    """处理 JSON 不支持的类型 (set, bytes, datetime, etc.)"""
    if isinstance(obj, set):
        return list(obj)
    if isinstance(obj, bytes):
        return obj.decode('utf-8', errors='replace')
    if hasattr(obj, 'isoformat'):  # datetime, date, time
        return obj.isoformat()
    if hasattr(obj, '__dict__'):   # Pydantic, dataclass, etc.
        return obj.dict() if hasattr(obj, 'dict') else obj.__dict__
    return str(obj)

def _loads(line: str) -> Any:
    return json.loads(line)

# ── 写响应 (线程安全) ─────────────────────────────────────────────

_write_lock = asyncio.Lock()

async def _write_response(resp: Any) -> None:
    async with _write_lock:
        sys.stdout.write(_dumps(resp) + '\n')
        sys.stdout.flush()

# ── 动态导入与实例化 ──────────────────────────────────────────────

def resolve_object(path: str, init_args: Optional[dict] = None) -> Any:
    """
    从点分路径动态导入并可选实例化.

    例:
      'aigility.rag.RAGService' → import aigility.rag; RAGService(**init_args)
      'aigility.rag.RAGService.search' → 实例方法 (不实例化, 返回 (instance, method))
      'aigility.rag.create_rag_service' → 函数调用 create_rag_service(**init_args)
    """
    parts = path.rsplit('.', 1)
    if len(parts) == 2:
        module_path, attr_name = parts
    else:
        # 纯模块 or builtin
        import builtins as _bi
        if hasattr(_bi, parts[0]):
            obj = getattr(_bi, parts[0])
            if init_args and isinstance(obj, type):
                return obj(**init_args)
            return obj
        return importlib.import_module(parts[0])

    try:
        mod = importlib.import_module(module_path)
    except ImportError:
        # 可能是更深的模块路径, 逐步回退
        # e.g. 'aigility.rag.service.RAGService' → module='aigility.rag.service'
        # 但 'aigility.rag.RAGService.search' → module='aigility.rag', attr='RAGService', method='search'
        obj: Any = None
        for i in range(len(module_path.split('.')) - 1, 0, -1):
            try:
                mod = importlib.import_module('.'.join(module_path.split('.')[:i]))
                rest = module_path.split('.')[i:] + [attr_name]
                obj = mod
                for r in rest:
                    obj = getattr(obj, r)
                break
            except (ImportError, AttributeError):
                obj = None
                continue
        if obj is None:
            raise ImportError(f"Cannot resolve path: {path}")
        if init_args and isinstance(obj, type):
            return obj(**init_args)
        return obj

    obj = getattr(mod, attr_name)

    if init_args and isinstance(obj, type):
        return obj(**init_args)

    return obj


def resolve_method(instance: Any, method_path: str) -> Any:
    """在实例上解析方法路径, 如 'search' 或 'config.get'"""
    parts = method_path.split('.')
    obj = instance
    for p in parts:
        obj = getattr(obj, p)
    return obj


# ── 实例注册表 ────────────────────────────────────────────────────

class InstanceRegistry:
    def __init__(self):
        self._instances: dict[str, Any] = {}       # cap_id → instance
        self._configs: dict[str, dict] = {}         # cap_id → config
        self._executor = ThreadPoolExecutor(max_workers=4)  # 同步函数并行

    async def initialize(self, cap_id: str, config: dict) -> dict:
        """初始化一个 capability, 缓存实例."""
        if cap_id in self._instances:
            return {"status": "ok", "cached": True}

        func_path = config['function']           # e.g. 'aigility.rag.RAGService'
        method_name = config.get('method')        # e.g. 'search' (可选, 默认 '__call__')
        init_args = config.get('init', {})

        # 环境变量注入 (config 中 env 字段)
        env_overrides = config.get('env', {})
        for k, v in env_overrides.items():
            os.environ.setdefault(k, str(v))

        # 动态导入 + 实例化
        instance = resolve_object(func_path, init_args)

        # 如果指定了 method, 解析到具体方法
        if method_name:
            method = resolve_method(instance, method_name)
        else:
            method = instance  # 直接 callable

        self._instances[cap_id] = method
        self._configs[cap_id] = config

        return {"status": "ok", "cached": False, "function": func_path, "method": method_name}

    async def call(self, cap_id: str, kwargs: dict) -> Any:
        """调用一个已初始化的 capability."""
        if cap_id not in self._instances:
            raise KeyError(f"Capability '{cap_id}' not initialized. Call initialize first.")

        method = self._instances[cap_id]

        # 异步函数直接 await
        if asyncio.iscoroutinefunction(method):
            result = await method(**kwargs)
        elif inspect.iscoroutinefunction(method):
            result = await method(**kwargs)
        else:
            # 同步函数放线程池, 不阻塞事件循环
            loop = asyncio.get_event_loop()
            result = await loop.run_in_executor(
                self._executor,
                lambda: method(**kwargs)
            )

        return result

    async def health(self) -> dict:
        return {
            "healthy": True,
            "capabilities": list(self._instances.keys()),
            "count": len(self._instances),
        }

    async def shutdown(self) -> None:
        # 调用 dispose/cleanup 如果存在
        for cap_id, method in self._instances.items():
            instance = getattr(method, '__self__', None)
            if instance and hasattr(instance, 'close'):
                try:
                    result = instance.close()
                    if asyncio.iscoroutine(result):
                        await result
                except Exception:
                    pass
        self._instances.clear()
        self._configs.clear()
        self._executor.shutdown(wait=False)


# ── JSON-RPC 处理 ────────────────────────────────────────────────

registry = InstanceRegistry()

async def handle_single(req: dict) -> Any:
    """处理单个 JSON-RPC 请求, 返回 result 或 raise."""
    method = req.get('method', '')
    params = req.get('params', {})

    if method == 'initialize':
        return await registry.initialize(
            params['capability_id'],
            params['config'],
        )

    if method == 'call':
        return await registry.call(
            params['capability_id'],
            params.get('kwargs', {}),
        )

    if method == 'health':
        return await registry.health()

    if method == 'shutdown':
        await registry.shutdown()
        return {"status": "ok"}

    raise ValueError(f"Unknown method: {method}")


async def handle_request(req: Any) -> Any:
    """处理单个或批量 JSON-RPC 请求."""
    if isinstance(req, list):
        # 批量请求: 并发执行所有
        tasks = [handle_single(r) for r in req]
        results = await asyncio.gather(*tasks, return_exceptions=True)
        responses = []
        for r, result in zip(req, results):
            resp = {"jsonrpc": "2.0", "id": r.get("id")}
            if isinstance(result, Exception):
                resp["error"] = {"code": -32603, "message": str(result),
                                 "data": traceback.format_exc() if os.environ.get('PY_BRIDGE_DEBUG') else None}
            else:
                resp["result"] = result
            responses.append(resp)
        return responses
    else:
        return await handle_single(req)


async def main():
    """主循环: 逐行读 stdin, 处理 JSON-RPC, 写 stdout."""
    # 通知 TS 侧 worker 已就绪
    await _write_response({
        "jsonrpc": "2.0",
        "method": "ready",
        "params": {"pid": os.getpid(), "python": sys.version.split()[0]},
    })

    loop = asyncio.get_event_loop()

    # 用 asyncio 逐行读 stdin
    reader = asyncio.StreamReader()
    protocol = asyncio.StreamReaderProtocol(reader)
    await loop.connect_read_pipe(lambda: protocol, sys.stdin)

    while True:
        line = await reader.readline()
        if not line:
            break  # stdin closed (TS 侧 kill 了子进程)

        line_str = line.decode('utf-8').strip()
        if not line_str:
            continue

        try:
            req = _loads(line_str)
        except json.JSONDecodeError as e:
            await _write_response({
                "jsonrpc": "2.0",
                "id": None,
                "error": {"code": -32700, "message": f"Parse error: {e}"},
            })
            continue

        req_id = req.get('id') if isinstance(req, dict) else None

        try:
            result = await handle_request(req)
            if isinstance(req, list):
                await _write_response(result)
            else:
                await _write_response({"jsonrpc": "2.0", "id": req_id, "result": result})
        except Exception as e:
            await _write_response({
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {
                    "code": -32603,
                    "message": str(e),
                    "data": traceback.format_exc() if os.environ.get('PY_BRIDGE_DEBUG') else None,
                },
            })

        # shutdown 方法 → 退出
        if isinstance(req, dict) and req.get('method') == 'shutdown':
            break
        if isinstance(req, list) and any(r.get('method') == 'shutdown' for r in req):
            break


if __name__ == '__main__':
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
    sys.exit(0)
