/**
 * fabric-recovery-watchdog-patch — 放宽 pi-fabric 子代理的「恢复看门狗」硬编码 60s，
 * 避免模型网关响应慢时把仍在正常自动重试的子代理误杀。
 *
 * 背景：pi-fabric `dist/worker/recovery-watchdog.js` 里
 *     const PI_RECOVERY_TIMEOUT_MS = 60_000;
 * 该计时器在子代理出现模型错误 / `auto_retry_start` / `agent_end(willRetry)` 后才启动，
 * 且只在收到 text/thinking/toolcall **增量**时才重置。于是两类正常情况都会踩线：
 *   1. 网关慢，重试请求的 TTFT > 60s（首 token 前没有任何增量）；
 *   2. pi 自身退避重试：settings.retry.maxAgentDelayMs 可达 5min，退避期间无增量。
 * 结果子代理被 SIGTERM，报错
 *     "Pi made no recovery progress for 60000ms; terminating child"
 * （即之前 pi-subagents 时代那个「静默/无进展被终止」的坑）。
 *
 * 处理：把常量改为读环境变量 `PI_FABRIC_RECOVERY_TIMEOUT_MS`，默认 600000（10min），
 * 既覆盖最长退避又容忍慢 TTFT，同时仍能兜住真正卡死的恢复流程。
 * pi install 带 `--ignore-scripts`，升级又会整体覆盖 dist，所以用扩展在每次启动时
 * 幂等重打补丁（已打过则跳过、文件缺失则静默跳过）。
 *
 * 卸载：删除本文件；如需彻底还原，把 dist 里那行改回 `var PI_RECOVERY_TIMEOUT_MS = 6e4;`。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const TARGET = path.join(
  os.homedir(),
  ".pi/agent/npm/node_modules/pi-fabric/dist/worker/recovery-watchdog.js",
);

const ORIGINAL = "var PI_RECOVERY_TIMEOUT_MS = 6e4;";
const PATCHED =
  "var PI_RECOVERY_TIMEOUT_MS = (() => { const raw = Number(process.env.PI_FABRIC_RECOVERY_TIMEOUT_MS); return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 6e5; })();";
const MARKER = "PI_FABRIC_RECOVERY_TIMEOUT_MS";

/** 幂等打补丁：返回 "patched" | "already" | "missing" | "unexpected"。 */
function ensurePatched(): string {
  let content: string;
  try {
    content = fs.readFileSync(TARGET, "utf8");
  } catch {
    return "missing";
  }
  if (content.includes(MARKER)) return "already";
  if (!content.includes(ORIGINAL)) return "unexpected";
  try {
    fs.writeFileSync(TARGET, content.replace(ORIGINAL, PATCHED));
    return "patched";
  } catch {
    return "unexpected";
  }
}

export default function (_pi: ExtensionAPI) {
  const first = ensurePatched();
  if (first === "patched") {
    console.error(
      "[fabric-recovery-watchdog-patch] 已放宽子代理恢复看门狗：60s -> 10min（可用 PI_FABRIC_RECOVERY_TIMEOUT_MS 覆盖）",
    );
  }
}
