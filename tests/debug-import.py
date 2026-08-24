#!/usr/bin/env python3
"""调试 aigility 导入"""
import sys
sys.path.insert(0, "/home/johnny/AI/aigility")

print("sys.path[:3]:", sys.path[:3])

# Test import
try:
    import aigility
    print("aigility:", aigility.__version__)
except Exception as e:
    print("import aigility failed:", e)

try:
    from aigility.memory import Memory
    print("Memory:", Memory)
except Exception as e:
    print("from aigility.memory import Memory failed:", e)

try:
    import aigility.memory
    print("aigility.memory module:", aigility.memory)
    print("has Memory:", hasattr(aigility.memory, "Memory"))
except Exception as e:
    print("import aigility.memory failed:", e)

try:
    import importlib
    mod = importlib.import_module("aigility.memory")
    print("importlib.import_module('aigility.memory'):", mod)
    print("getattr(mod, 'Memory'):", getattr(mod, "Memory"))
except Exception as e:
    print("importlib failed:", e)
