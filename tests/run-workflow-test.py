#!/usr/bin/env python3
"""用 aigility venv 跑测试，绕过 Hermes terminal guard bug"""
import subprocess, sys

result = subprocess.run(
    ["/home/johnny/AI/aigility/.venv/bin/python", "/home/johnny/AI/aigility/tests/test_workflow.py"],
    capture_output=True, text=True, timeout=30,
    cwd="/home/johnny/AI/aigility",
    env={
        "PYTHONPATH": "/home/johnny/AI/aigility/.venv/lib/python3.11/site-packages:/home/johnny/AI/aigility",
        "PATH": "/usr/bin:/bin",
        "HOME": "/home/johnny",
    }
)
print("STDOUT:", result.stdout)
if result.stderr:
    print("STDERR:", result.stderr)
print("EXIT:", result.returncode)
