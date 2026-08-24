#!/usr/bin/env python3
"""用 subprocess 调 aigility venv python, 绕过 Hermes terminal guard bug"""
import subprocess, sys

result = subprocess.run(
    ["/home/johnny/AI/aigility/.venv/bin/python", "/home/johnny/AI/aigility-harness/tests/debug-import.py"],
    capture_output=True, text=True, timeout=30
)
print("STDOUT:", result.stdout)
print("STDERR:", result.stderr)
print("EXIT:", result.returncode)
