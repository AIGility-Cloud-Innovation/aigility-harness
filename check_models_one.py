import json, os, pathlib, sys, urllib.request

def load_env(path=".env"):
    """从 .env 读取 KEY=VALUE 到环境变量 (已存在的环境变量不覆盖)"""
    env = pathlib.Path(__file__).with_name(path)
    if env.exists():
        for line in env.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, _, v = line.partition("=")
                os.environ.setdefault(k.strip(), v.strip().strip("'\""))

load_env()
KEY = os.environ.get("BIGMODEL_API_KEY")
if not KEY:
    sys.exit("缺少 BIGMODEL_API_KEY: 请在 .env 中配置")
body = json.dumps({
    "model": "glm-4.7-flash",
    "messages": [{"role": "user", "content": "hi"}],
    "max_tokens": 8,
    "thinking": {"type": "disabled"},
}).encode()
req = urllib.request.Request(
    "https://open.bigmodel.cn/api/paas/v4/chat/completions",
    data=body,
    headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"},
)
try:
    r = urllib.request.urlopen(req, timeout=30)
    print("glm-4.7-flash OK", r.read()[:100])
except Exception as e:
    print("glm-4.7-flash FAIL", getattr(e, "code", ""), str(e)[:150])
