#!/usr/bin/env python3
"""
API Protocol Router / Adapter Proxy
===================================
  POST /v1/messages         → Anthropic Messages API (Claude Code)
  POST /v1/chat/completions → OpenAI Chat Completions (OpenCode/Codex)
  POST /v1/responses        → OpenAI Responses API (Codex 0.146+)
纯协议转换，fallback/重试由 LiteLLM 处理。
"""

import asyncio, json, os, time, uuid, httpx
from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import StreamingResponse, JSONResponse
from typing import Optional

BACKEND_URL = os.environ.get("BACKEND_URL", "http://127.0.0.1:48724/v1")
BACKEND_KEY = os.environ.get("BACKEND_KEY", os.environ.get("LITELLM_MASTER_KEY", os.environ.get("MODELARTS_API_KEY", os.environ.get("HERMES_CUSTOM_API_MODELARTS_MAAS_COM_API_KEY", ""))))
DEFAULT_MODEL = os.environ.get("PROXY_DEFAULT_MODEL", "huawei-glm-5.2")
MODEL_MAP = {}
PORT = int(os.environ.get("PROXY_PORT", "4000"))

app = FastAPI(title="API Protocol Router")

def map_model(m): return MODEL_MAP.get(m, m)
def check_auth(req): return True

# ─── 调用者识别 ───

def detect_caller(request: Request) -> str:
    """根据 User-Agent / X-App 等 header 识别实际调用者，用于 LiteLLM 用量追踪。"""
    ua = request.headers.get("user-agent", "").lower()
    x_app = request.headers.get("x-app", "").lower()
    # Claude Code: user-agent 含 claude-cli 或 anthropic
    if "claude" in ua or "anthropic" in ua or "claude-code" in x_app:
        return "claude-code"
    # Codex: user-agent 含 codex 或 openai
    if "codex" in ua or "codex" in x_app:
        return "codex"
    # OpenCode
    if "opencode" in ua or "opencode" in x_app:
        return "opencode"
    # OpenClaw
    if "openclaw" in ua or "openclaw" in x_app:
        return "openclaw"
    # Hermes (内部 Feishu agent)
    if "hermes" in ua or "hermes" in x_app:
        return "hermes"
    # 其他 OpenAI 兼容客户端
    if "openai" in ua:
        return "openai-client"
    return "unknown"

def inject_user(body: dict, request: Request) -> dict:
    """将调用者标识注入请求体的 user 字段，LiteLLM 会记录到 SpendLogs。"""
    if isinstance(body, dict) and "user" not in body:
        body["user"] = detect_caller(request)
    return body

# ─── Anthropic → OpenAI 翻译 ───

def anthropic_to_openai(body: dict) -> dict:
    messages = []
    if "system" in body:
        s = body["system"]
        if isinstance(s, str): messages.append({"role": "system", "content": s})
        elif isinstance(s, list):
            parts = [b.get("text","") if isinstance(b,dict) else b for b in s if isinstance(b,dict) and b.get("type")=="text" or isinstance(b,str)]
            if parts: messages.append({"role": "system", "content": "\n".join(parts)})
    for msg in body.get("messages", []):
        role, content = msg["role"], msg["content"]
        if isinstance(content, str):
            messages.append({"role": role, "content": content})
        elif isinstance(content, list):
            tp, tc, tr = [], [], []
            for b in content:
                if isinstance(b, str): tp.append(b)
                elif isinstance(b, dict):
                    t = b.get("type")
                    if t == "text": tp.append(b.get("text",""))
                    elif t == "tool_use": tc.append({"id": b.get("id",f"call_{uuid.uuid4().hex[:24]}"),"type":"function","function":{"name":b.get("name",""),"arguments":json.dumps(b.get("input",{}))}})
                    elif t == "tool_result":
                        c = b.get("content","")
                        if isinstance(c, list): c = "\n".join([x.get("text","") if isinstance(x,dict) else x for x in c])
                        elif not isinstance(c, str): c = json.dumps(c)
                        tr.append({"role":"tool","tool_call_id":b.get("tool_use_id",""),"content":c})
                    elif t == "image":
                        src = b.get("source",{})
                        if src.get("type")=="base64": tp.append({"type":"image_url","image_url":{"url":f"data:{src.get('media_type','image/png')};base64,{src.get('data','')}"}});
            if tr: messages.extend(tr)
            elif tc: messages.append({"role":role,"content":"\n".join(tp) if tp else None,"tool_calls":tc})
            else: messages.append({"role":role,"content":"\n".join(tp) if tp else ""})
    oai = {"model": map_model(body.get("model", DEFAULT_MODEL)), "messages": messages}
    for k in ("max_tokens","temperature","top_p"):
        if k in body: oai[k] = body[k]
    if "stop_sequences" in body: oai["stop"] = body["stop_sequences"]
    if "stream" in body: oai["stream"] = body["stream"]
    if "tools" in body:
        ot = []
        for tool in body["tools"]:
            if tool.get("type","").startswith("computer_"): continue
            ot.append({"type":"function","function":{"name":tool.get("name",""),"description":tool.get("description",""),"parameters":tool.get("input_schema",{"type":"object","properties":{}})}})
        if ot: oai["tools"] = ot
    if "tool_choice" in body:
        tc = body["tool_choice"]
        if isinstance(tc, dict):
            oai["tool_choice"] = {"auto":"auto","any":"required"}.get(tc.get("type"), {"type":"function","function":{"name":tc.get("name","")}} if tc.get("type")=="tool" else None)
        elif isinstance(tc, str): oai["tool_choice"] = tc
    return oai

def openai_response_to_anthropic(resp: dict, model: str) -> dict:
    ch = resp.get("choices",[{}])[0]
    msg = ch.get("message",{})
    blocks = []
    if msg.get("content"): blocks.append({"type":"text","text":msg["content"]})
    for tc in msg.get("tool_calls",[]):
        f = tc.get("function",{})
        try: inp = json.loads(f.get("arguments","{}"))
        except: inp = {}
        blocks.append({"type":"tool_use","id":tc.get("id",f"toolu_{uuid.uuid4().hex[:24]}"),"name":f.get("name",""),"input":inp})
    if not blocks: blocks.append({"type":"text","text":""})
    fm = {"stop":"end_turn","length":"max_tokens","tool_calls":"tool_use","function_call":"tool_use","content_filter":"end_turn"}
    u = resp.get("usage",{})
    return {"id":f"msg_{uuid.uuid4().hex[:24]}","type":"message","role":"assistant","model":model,"content":blocks,"stop_reason":fm.get(ch.get("finish_reason","stop"),"end_turn"),"stop_sequence":None,"usage":{"input_tokens":u.get("prompt_tokens",0),"output_tokens":u.get("completion_tokens",0)}}

async def stream_anthropic(oai_stream, model_name):
    mid = f"msg_{uuid.uuid4().hex[:24]}"
    yield f"event: message_start\ndata: {json.dumps({'type':'message_start','message':{'id':mid,'type':'message','role':'assistant','model':model_name,'content':[],'stop_reason':None,'stop_sequence':None,'usage':{'input_tokens':0,'output_tokens':0}}})}\n\n"
    yield f"event: content_block_start\ndata: {json.dumps({'type':'content_block_start','index':0,'content_block':{'type':'text','text':''}})}\n\n"
    bi, tcb, stb = 0, {}, True
    async for line in oai_stream.aiter_lines():
        if not line.startswith("data: "): continue
        d = line[6:].strip()
        if d == "[DONE]": break
        try: ch = json.loads(d)
        except: continue
        cs = ch.get("choices",[])
        if not cs: continue
        delta = cs[0].get("delta",{})
        fr = cs[0].get("finish_reason")
        td = delta.get("content")
        if td and stb: yield f"event: content_block_delta\ndata: {json.dumps({'type':'content_block_delta','index':0,'delta':{'type':'text_delta','text':td}})}\n\n"
        for tcd in delta.get("tool_calls",[]):
            ti = tcd.get("index",0)
            if ti not in tcb:
                if stb: yield f"event: content_block_stop\ndata: {json.dumps({'type':'content_block_stop','index':0})}\n\n"; stb = False
                bi = ti + 1
                f = tcd.get("function",{})
                tcb[ti] = {"id":tcd.get("id",f"toolu_{uuid.uuid4().hex[:24]}"),"name":f.get("name","")}
                yield f"event: content_block_start\ndata: {json.dumps({'type':'content_block_start','index':bi,'content_block':{'type':'tool_use','id':tcb[ti]['id'],'name':tcb[ti]['name'],'input':{}}})}\n\n"
            ad = tcd.get("function",{}).get("arguments","")
            if ad: yield f"event: content_block_delta\ndata: {json.dumps({'type':'content_block_delta','index':bi,'delta':{'type':'input_json_delta','partial_json':ad}})}\n\n"
        if fr:
            if stb: yield f"event: content_block_stop\ndata: {json.dumps({'type':'content_block_stop','index':0})}\n\n"; stb = False
            for i in tcb: yield f"event: content_block_stop\ndata: {json.dumps({'type':'content_block_stop','index':i+1})}\n\n"
            fm = {"stop":"end_turn","length":"max_tokens","tool_calls":"tool_use","function_call":"tool_use","content_filter":"end_turn"}
            u = ch.get("usage",{})
            yield f"event: message_delta\ndata: {json.dumps({'type':'message_delta','delta':{'stop_reason':fm.get(fr,'end_turn'),'stop_sequence':None},'usage':{'output_tokens':u.get('completion_tokens',0)}})}\n\n"
    yield f"event: message_stop\ndata: {json.dumps({'type':'message_stop'})}\n\n"

# ─── Anthropic Messages 端点 ───

@app.post("/v1/messages")
async def anthropic_messages(request: Request):
    check_auth(request)
    body = await request.json()
    inject_user(body, request)
    cm = body.get("model", DEFAULT_MODEL)
    is_stream = body.get("stream", False)
    oai = anthropic_to_openai(body)
    hs = {"Content-Type":"application/json","Authorization":f"Bearer {BACKEND_KEY}"}
    if is_stream:
        oai["stream"] = True
        async def sg():
            async with httpx.AsyncClient(timeout=httpx.Timeout(300.0)) as c:
                async with c.stream("POST",f"{BACKEND_URL}/chat/completions",json=oai,headers=hs) as r:
                    if r.status_code!=200:
                        eb = await r.aread()
                        yield f"event: error\ndata: {json.dumps({'type':'error','error':{'type':'api_error','message':eb.decode()}})}\n\n"; return
                    async for ch in stream_anthropic(r, cm): yield ch
        return StreamingResponse(sg(), media_type="text/event-stream")
    else:
        async with httpx.AsyncClient(timeout=httpx.Timeout(300.0)) as c:
            r = await c.post(f"{BACKEND_URL}/chat/completions",json=oai,headers=hs)
            if r.status_code!=200: raise HTTPException(status_code=r.status_code,detail=r.text)
            return JSONResponse(openai_response_to_anthropic(r.json(), cm))

# ─── OpenAI Chat Completions 端点 ───

@app.post("/v1/chat/completions")
@app.post("/chat/completions")
async def openai_chat_completions(request: Request):
    check_auth(request)
    body = await request.json()
    inject_user(body, request)
    body["model"] = map_model(body.get("model", DEFAULT_MODEL))
    is_stream = body.get("stream", False)
    hs = {"Content-Type":"application/json","Authorization":f"Bearer {BACKEND_KEY}"}
    # 2026-10-07: LiteLLM 1.95 流式转发 ollama 时丢失 tool_calls 结构(模型输出当纯文本吐回,
    # OpenClaw 等客户端拿到 JSON 文本无法执行工具)。对流式+带tools的本地ollama模型:
    # 后端改非流式拿完整 tool_calls, 再合成标准 SSE 流吐回, 对客户端透明。
    _OLLAMA_PREFIXES = ("qwen3.5", "qwen2.5", "qwen3:")
    def _is_ollama(m):
        base = m.split("/")[-1]
        return any(base == p or base.startswith(p) for p in _OLLAMA_PREFIXES)
    if is_stream and body.get("tools") and _is_ollama(body.get("model","")):
        body2 = dict(body); body2["stream"] = False
        async with httpx.AsyncClient(timeout=httpx.Timeout(300.0)) as c:
            r = await c.post(f"{BACKEND_URL}/chat/completions",json=body2,headers=hs)
        if r.status_code!=200:
            async def er():
                yield f"data: {json.dumps({'error':{'message':r.text,'type':'api_error','code':r.status_code}})}\n\n"
            return StreamingResponse(er(), media_type="text/event-stream")
        resp = r.json()
        msg = resp.get("choices",[{}])[0].get("message",{})
        finish = resp.get("choices",[{}])[0].get("finish_reason")
        tcs = msg.get("tool_calls") or []
        delta = {"role":"assistant"}
        if msg.get("content"): delta["content"] = msg["content"]
        if tcs:
            delta["tool_calls"] = [dict(tc, index=i) for i, tc in enumerate(tcs)]
        base_id = resp.get("id","buffered"); model_id = resp.get("model", body.get("model"))
        created = resp.get("created", 0)
        async def sr():
            yield "data: "+json.dumps({"id":base_id,"object":"chat.completion.chunk","created":created,"model":model_id,"choices":[{"index":0,"delta":delta,"finish_reason":None}]})+"\n\n"
            yield "data: "+json.dumps({"id":base_id,"object":"chat.completion.chunk","created":created,"model":model_id,"choices":[{"index":0,"delta":{},"finish_reason":finish or ("tool_calls" if tcs else "stop")}]})+"\n\n"
            yield "data: [DONE]\n\n"
        return StreamingResponse(sr(), media_type="text/event-stream")
    if is_stream:
        async def sr():
            async with httpx.AsyncClient(timeout=httpx.Timeout(300.0)) as c:
                async with c.stream("POST",f"{BACKEND_URL}/chat/completions",json=body,headers=hs) as r:
                    if r.status_code!=200:
                        eb = await r.aread()
                        yield f"data: {json.dumps({'error':{'message':eb.decode(),'type':'api_error','code':r.status_code}})}\n\n"; return
                    async for line in r.aiter_lines():
                        if not line: continue
                        if not line.startswith("data: "): yield line+"\n"; continue
                        d = line[6:]
                        if d.strip()=="[DONE]": yield "data: [DONE]\n\n"; continue
                        try: json.loads(d)
                        except: yield line+"\n"; continue
                        yield "data: "+d+"\n\n"
        return StreamingResponse(sr(), media_type="text/event-stream")
    else:
        async with httpx.AsyncClient(timeout=httpx.Timeout(300.0)) as c:
            r = await c.post(f"{BACKEND_URL}/chat/completions",json=body,headers=hs)
            if r.status_code!=200: raise HTTPException(status_code=r.status_code,detail=r.text)
            return JSONResponse(r.json())


# ─── Responses API → Chat Completions 翻译 ───

def responses_to_chat(body: dict) -> dict:
    messages = []
    if body.get("instructions"):
        messages.append({"role": "system", "content": body["instructions"]})
    inp = body.get("input", "")
    if isinstance(inp, str):
        messages.append({"role": "user", "content": inp})
    elif isinstance(inp, list):
        for item in inp:
            if isinstance(item, str):
                messages.append({"role": "user", "content": item})
                continue
            if not isinstance(item, dict):
                continue
            itype = item.get("type")
            if itype == "function_call":
                call_id = item.get("call_id") or item.get("id") or f"call_{uuid.uuid4().hex[:24]}"
                args = item.get("arguments", "")
                if not args:
                    args = "{}"
                messages.append({
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [{
                        "id": call_id,
                        "type": "function",
                        "function": {"name": item.get("name", ""), "arguments": args},
                    }],
                })
            elif itype == "function_call_output":
                call_id = item.get("call_id") or f"call_{uuid.uuid4().hex[:24]}"
                out = item.get("output", "")
                if not isinstance(out, str):
                    try:
                        out = json.dumps(out, ensure_ascii=False)
                    except (TypeError, ValueError):
                        out = str(out)
                messages.append({"role": "tool", "tool_call_id": call_id, "content": out})
            else:
                role = item.get("role", "user")
                content = item.get("content", "")
                if isinstance(content, list):
                    parts = [b.get("text","") for b in content if isinstance(b,dict) and b.get("type") in ("input_text","output_text")]
                    content = "\n".join(parts) if parts else ""
                messages.append({"role": role, "content": content})
    oai = {"model": body.get("model",""), "messages": messages, "stream": body.get("stream", False)}
    if "max_output_tokens" in body: oai["max_tokens"] = body["max_output_tokens"]
    elif "max_tokens" in body: oai["max_tokens"] = body["max_tokens"]
    if "tools" in body:
        ct = []
        for t in body["tools"]:
            if not isinstance(t, dict): continue
            if "function" in t and isinstance(t["function"], dict):
                fn = {k: v for k, v in t["function"].items() if k in ("name","description","parameters")}
                ct.append({"type": "function", "function": fn})
            elif t.get("type") == "function" and "name" in t:
                fn = {"name": t.get("name",""), "description": t.get("description",""), "parameters": t.get("parameters", {"type":"object","properties":{}})}
                ct.append({"type": "function", "function": fn})
            elif "name" in t:
                fn = {"name": t.get("name",""), "description": t.get("description",""), "parameters": t.get("parameters", {"type":"object","properties":{}})}
                ct.append({"type": "function", "function": fn})
        if ct: oai["tools"] = ct
    if "tool_choice" in body: oai["tool_choice"] = body["tool_choice"]
    return oai

@app.post("/v1/responses")
@app.post("/responses")
async def openai_responses(request: Request):
    check_auth(request)
    body = await request.json()
    inject_user(body, request)
    is_stream = body.get("stream", False)
    oai = responses_to_chat(body)
    mn = body.get("model", DEFAULT_MODEL)
    hs = {"Content-Type":"application/json","Authorization":f"Bearer {BACKEND_KEY}"}
    rid = f"resp_{uuid.uuid4().hex[:24]}"

    if is_stream:
        oai["stream"] = True
        async def srs():
            async with httpx.AsyncClient(timeout=httpx.Timeout(300.0)) as c:
                async with c.stream("POST",f"{BACKEND_URL}/chat/completions",json=oai,headers=hs) as r:
                    if r.status_code!=200:
                        eb = await r.aread()
                        yield f"event: error\ndata: {json.dumps({'type':'error','error':{'message':eb.decode(),'type':'api_error','code':r.status_code}})}\n\n"; return
                    mid = f"msg_{uuid.uuid4().hex[:24]}"
                    yield f"event: response.created\ndata: {json.dumps({'type':'response.created','response':{'id':rid,'object':'response','created_at':int(time.time()),'model':mn,'status':'in_progress','output':[]}})}\n\n"
                    yield f"event: response.output_item.added\ndata: {json.dumps({'type':'response.output_item.added','output_index':0,'item':{'id':mid,'type':'message','role':'assistant','content':[]}})}\n\n"
                    yield f"event: response.content_part.added\ndata: {json.dumps({'type':'response.content_part.added','item_id':mid,'content_index':0,'part':{'type':'output_text','text':''}})}\n\n"
                    ft = []
                    tool_calls_acc = {}  # index → {id, name, arguments}
                    async for line in r.aiter_lines():
                        if not line.startswith("data: "): continue
                        d = line[6:].strip()
                        if d == "[DONE]": break
                        try: ch = json.loads(d)
                        except: continue
                        cs = ch.get("choices",[])
                        if not cs: continue
                        delta = cs[0].get("delta",{})
                        td = delta.get("content")
                        if td: ft.append(td); yield f"event: response.output_text.delta\ndata: {json.dumps({'type':'response.output_text.delta','item_id':mid,'content_index':0,'delta':td})}\n\n"
                        # 处理 tool_calls
                        for tcd in delta.get("tool_calls",[]) or []:
                            idx = tcd.get("index",0)
                            if idx not in tool_calls_acc:
                                tool_calls_acc[idx] = {"id": tcd.get("id",f"call_{uuid.uuid4().hex[:24]}"), "name": "", "arguments": ""}
                            fn = tcd.get("function",{})
                            if fn.get("name"): tool_calls_acc[idx]["name"] = fn["name"]
                            if fn.get("arguments"): tool_calls_acc[idx]["arguments"] += fn["arguments"]
                    final = "".join(ft)
                    if final:
                        yield f"event: response.output_text.done\ndata: {json.dumps({'type':'response.output_text.done','item_id':mid,'content_index':0,'text':final})}\n\n"
                        yield f"event: response.content_part.done\ndata: {json.dumps({'type':'response.content_part.done','item_id':mid,'content_index':0,'part':{'type':'output_text','text':final}})}\n\n"
                        mi = {'id':mid,'type':'message','role':'assistant','content':[{'type':'output_text','text':final}]}
                        yield f"event: response.output_item.done\ndata: {json.dumps({'type':'response.output_item.done','output_index':0,'item':mi})}\n\n"
                    # 输出 tool_calls 作为 function_call items
                    all_output = []
                    if final:
                        all_output.append({'id':mid,'type':'message','role':'assistant','content':[{'type':'output_text','text':final}]})
                    for idx in sorted(tool_calls_acc.keys()):
                        tc = tool_calls_acc[idx]
                        call_id = tc["id"]
                        fc_item = {"id": call_id, "type": "function_call", "call_id": call_id, "name": tc["name"], "arguments": tc["arguments"]}
                        oi = len(all_output)
                        yield f"event: response.output_item.added\ndata: {json.dumps({'type':'response.output_item.added','output_index':oi,'item':fc_item})}\n\n"
                        yield f"event: response.output_item.done\ndata: {json.dumps({'type':'response.output_item.done','output_index':oi,'item':fc_item})}\n\n"
                        all_output.append(fc_item)
                    yield f"event: response.completed\ndata: {json.dumps({'type':'response.completed','response':{'id':rid,'object':'response','created_at':int(time.time()),'model':mn,'status':'completed','output':all_output,'usage':{'input_tokens':0,'output_tokens':0,'total_tokens':0}}})}\n\n"
                    yield "\n"
                    await asyncio.sleep(0.5)
        return StreamingResponse(srs(), media_type="text/event-stream")
    else:
        async with httpx.AsyncClient(timeout=httpx.Timeout(300.0)) as c:
            r = await c.post(f"{BACKEND_URL}/chat/completions",json=oai,headers=hs)
            if r.status_code!=200: raise HTTPException(status_code=r.status_code,detail=r.text)
            data = r.json()
        ch = data.get("choices",[])
        output = []
        if ch:
            msg = ch[0].get("message",{})
            txt = msg.get("content","") or ""
            if txt:
                output.append({"id":f"msg_{uuid.uuid4().hex[:24]}","type":"message","role":"assistant","content":[{"type":"output_text","text":txt}]})
            # 转换 tool_calls → responses API function_call
            for tc in msg.get("tool_calls",[]) or []:
                fn = tc.get("function",{})
                call_id = tc.get("id",f"call_{uuid.uuid4().hex[:24]}")
                try:
                    args = json.loads(fn.get("arguments","{}"))
                except:
                    args = {}
                output.append({
                    "id": call_id,
                    "type": "function_call",
                    "call_id": call_id,
                    "name": fn.get("name",""),
                    "arguments": json.dumps(args, ensure_ascii=False),
                })
        u = data.get("usage",{})
        return JSONResponse({"id":rid,"object":"response","created_at":int(time.time()),"model":mn,"status":"completed","output":output,"usage":{"input_tokens":u.get("prompt_tokens",0),"output_tokens":u.get("completion_tokens",0),"total_tokens":u.get("total_tokens",0)}})

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=PORT)
