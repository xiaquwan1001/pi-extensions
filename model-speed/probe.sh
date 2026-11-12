#!/usr/bin/env bash
# 池内每个模型的 TTFT 探针。每个模型独立子进程 + 独立硬超时，谁慢不会拖住别人；
# 每测完一个立刻原子写盘（tmp + mv），被 Ctrl-C 也能留下已完成的结果。
#
# 用法: probe.sh [--fast] [--budget 秒] [--out 文件]
#   --fast        只测小上下文（2k），每次调用都很快（~2-10s/模型）
#   --budget N    每个模型的硬超时秒数（默认 45）
# 输出 JSON: {ts, models:{<id>:{ok,ttft,total,status,err}}, ...}
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$HOME/.pi/agent/extensions/model-speed/last-probe.json"
BUDGET=60
FAST=0
SIZES="2000 150000"

while [ $# -gt 0 ]; do
  case "$1" in
    --fast) FAST=1; shift ;;
    --budget) BUDGET="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --sizes) SIZES="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
[ "$FAST" = 1 ] && [ -z "${SIZES_ARG:-}" ] && SIZES="2000"

MK_FILE="$HOME/litellm/master.key"
[ -r "$MK_FILE" ] || { echo "master.key 不可读" >&2; exit 3; }
MK="$(cat "$MK_FILE")"
ENDPOINT="${PI_POOL_ENDPOINT:-http://127.0.0.1:4000/v1/chat/completions}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# 模型清单从网关自己报（谁在池里就以谁为准）
curl -s --noproxy '*' -m 5 -H "Authorization: Bearer $MK" "${ENDPOINT%/chat/completions}/models" \
  | python3 -c 'import json,sys
d=json.load(sys.stdin)
print(" ".join(m["id"] for m in d["data"]))' > "$WORK/models" || true
MODELS="$(cat "$WORK/models" 2>/dev/null)"
# 只探物理型号 + 默认别名；不带型号后缀的语义别名也测（它反映真实后备体验）
[ -n "$MODELS" ] || MODELS="ustc ustc-dsf ustc-dsf2 ustc-glm ustc-qwen"

one() {  # $1=model
  local model="$1"
  timeout -k 3 "$BUDGET" python3 "$HERE/_probe_one.py" "$model" "$SIZES" "$MK" "$ENDPOINT" \
    > "$WORK/$model.json" 2>"$WORK/$model.err"
  local rc=$?
  [ -s "$WORK/$model.json" ] || printf '{"model":"%s","ok":false,"status":"timeout","err":"rc=%s"}\n' \
    "$model" "$rc" > "$WORK/$model.json"
  mv -f "$WORK/$model.json" "$WORK/done-$model.json"
}

pids=()
i=0
for m in $MODELS; do
  # 错开启动：同一上游的并发探针会互相排队，导致假超时
  ( sleep "$(awk "BEGIN{print $i*1.5}")"; one "$m" ) &
  pids+=($!)
  i=$((i+1))
done
wait "${pids[@]}" 2>/dev/null

python3 - "$WORK" "$OUT" "$SIZES" <<'PY'
import json, sys, glob, os, time
work, out, sizes = sys.argv[1], sys.argv[2], sys.argv[3]
models = {}
for f in glob.glob(os.path.join(work, "done-*.json")):
    try:
        r = json.load(open(f))
    except Exception:
        continue
    models[r.pop("model", os.path.basename(f))] = r
payload = {"ts": int(time.time()), "sizes": sizes.split(), "models": models}
tmp = out + ".tmp"
with open(tmp, "w") as fh:
    json.dump(payload, fh, ensure_ascii=False, indent=1)
os.replace(tmp, out)
print(out)
PY
