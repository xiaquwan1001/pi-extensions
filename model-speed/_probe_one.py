#!/usr/bin/env python3
"""单个模型的 TTFT 探针：每个尺寸一个冷前缀（随机 tag 防缓存），流式读首 chunk。

输出一行 JSON：{model, ok, status, ttft, total, first_size, err, samples:[...]}
"""
import json, os, random, sys, time, urllib.error, urllib.request

model, sizes, mk, endpoint = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
FILLER = "The quick brown fox jumps over the lazy dog. "

def call(model, ntok, timeout):
    tag = "%016x" % random.getrandbits(64)
    text = f"[{tag}] " + FILLER * max(1, ntok // 8)
    body = {
        "model": model,
        "messages": [{"role": "user", "content": "Reply: OK\n\n" + text}],
        "max_tokens": 16,
        "stream": True,
    }
    req = urllib.request.Request(
        endpoint,
        data=json.dumps(body).encode(),
        headers={"Authorization": "Bearer " + mk, "Content-Type": "application/json"},
    )
    t0 = time.time()
    first = None
    served = None
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            served = resp.headers.get("x-litellm-model-name")
            for line in resp:
                if line.startswith(b"data:") and b"[DONE]" not in line and first is None:
                    first = time.time() - t0
        return {"ok": True, "ttft": round(first, 2) if first else None,
                "total": round(time.time() - t0, 2), "served": served, "size": ntok}
    except urllib.error.HTTPError as e:
        msg = e.read()[:180].decode("utf8", "replace")
        return {"ok": False, "status": e.code, "total": round(time.time() - t0, 2),
                "ttft": first, "err": msg, "size": ntok}
    except Exception as e:
        return {"ok": False, "status": "timeout", "total": round(time.time() - t0, 2),
                "ttft": first, "err": type(e).__name__, "size": ntok}

samples = []
for s in sizes.split():
    r = call(model, int(s), 40)
    samples.append(r)
    if not r["ok"]:
        break

worst = max(samples, key=lambda r: (not r["ok"], r.get("ttft") or 1e9))
out = {
    "model": model,
    "ok": all(s["ok"] for s in samples),
    "status": "ok" if all(s["ok"] for s in samples) else worst.get("status"),
    "ttft": worst.get("ttft"),
    "total": worst.get("total"),
    "first_size": samples[0].get("size") if samples else None,
    "err": worst.get("err"),
    "samples": samples,
}
print(json.dumps(out, ensure_ascii=False))
