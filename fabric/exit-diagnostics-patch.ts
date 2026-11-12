/**
 * exit-diagnostics-patch — 让被信号杀死的子代理留下真实死因。
 *
 * 背景（2026-10-19 真实事故）：
 *   pi-fabric 的 durable 子代理以 `--no-session` 启动，pi-fold 的 evidence 钩子拿到
 *   `sessionFile === undefined` 后在 `evidence.js:138` 抛
 *       "Evidence ingestion requires an absolute Pi session file"
 *   这条报错进入子进程 stderr；`worker.js:1281` 用
 *       record.error = stderr.trim() || ...exited with code ${exitCode ?? "unknown"}
 *   把它当成死因，于是 6 个 lane 全部误报成这条文案，真实死因
 *   （子进程 SIGSEGV / signal 11）被完全掩盖，排查方向一度跑偏。
 *
 * 两处补丁：
 *   1. pi-fold `extensions/evidence.js`：无持久化 session 文件时静默跳过 evidence 归档，
 *      不再抛错（只损失超大工具结果的 evidence 折叠，不影响功能）。
 *   2. pi-fabric `dist/worker.js`：
 *      - 从 child 的 close 事件捕获 signal 并写入 record.exitSignal；
 *      - 失败文案改成「退出方式在前，stderr 作为附加细节在后」，不再是 stderr 独占。
 *
 * 为什么用扩展在启动时打：`pi install` 带 `--ignore-scripts`，升级会整体覆盖
 * node_modules，所以补丁必须每次启动幂等重打（已打过则跳过，文件缺失则静默跳过）。
 *
 * 卸载：删除本文件即可。要彻底还原，把两处补丁文本改回原文（见下方 original 常量）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const NPM = path.join(os.homedir(), ".pi/agent/npm/node_modules");

type Patch = {
  file: string;
  marker: string;
  original: string;
  patched: string;
  label: string;
};

/** 1) pi-fold：无 session 文件时静默跳过 evidence 归档（tool_result 主处理器） */
const FOLD_TOOL_RESULT: Patch = {
  file: path.join(NPM, "pi-fold/extensions/evidence.js"),
  marker: "pi-fold-evidence-nosession-guard",
  label: "pi-fold evidence 无 session 守卫",
  original: [
    '    const sessionFile = ctx.sessionManager.getSessionFile();',
    '    const sessionId = ctx.sessionManager.getSessionId();',
    '    const details = ownDataProperty(event, "details");',
    '    if (ownDataProperty(details, "evidence") !== undefined) return;',
  ].join("\n"),
  patched: [
    '    const sessionFile = ctx.sessionManager.getSessionFile();',
    '    const sessionId = ctx.sessionManager.getSessionId();',
    '    // [pi-fold-evidence-nosession-guard] 无持久化 session 文件时（fabric durable 子代理以',
    '    // --no-session 启动，getSessionFile() 返回 undefined）跳过 evidence 归档，而不是抛错。',
    '    // 抛错会被 pi-fabric worker 当作子进程 stderr，掩盖真实死因（如 signal 11）。',
    '    if (typeof sessionFile !== "string" || !isAbsolute(sessionFile)) return;',
    '    const details = ownDataProperty(event, "details");',
    '    if (ownDataProperty(details, "evidence") !== undefined) return;',
  ].join("\n"),
};

/** 2a) pi-fabric：close 事件捕获 signal */
const FABRIC_SIGNAL: Patch = {
  file: path.join(NPM, "pi-fabric/dist/worker.js"),
  marker: "exitSignal = signal",
  label: "pi-fabric 记录退出信号",
  original: '    child.once("close", (code) => resolve(code));',
  patched: '    child.once("close", (code, signal) => { exitSignal = signal; resolve(code); }); // [pi-fabric-exitSignal-capture]',
};

/** 2b) pi-fabric：声明 exitSignal 并落盘 */
const FABRIC_DECL: Patch = {
  file: path.join(NPM, "pi-fabric/dist/worker.js"),
  marker: "pi-fabric-exitSignal-decl",
  label: "pi-fabric exitSignal 声明",
  original: "  const exitCode = await new Promise((resolve) => {",
  patched: [
    "  // [pi-fabric-exitSignal-decl] 记录终止信号，避免被信号杀死时只报 \"code unknown\"。",
    "  let exitSignal = null;",
    "  const exitCode = await new Promise((resolve) => {",
  ].join("\n"),
};

/** 2c) pi-fabric：record.exitSignal 落盘 */
const FABRIC_RECORD: Patch = {
  file: path.join(NPM, "pi-fabric/dist/worker.js"),
  marker: "pi-fabric-exitSignal-record",
  label: "pi-fabric exitSignal 落盘",
  original: [
    "  record.exitCode = exitCode;",
    "  record.stderr = stderr.slice(-MAX_STDERR_CHARS);",
  ].join("\n"),
  patched: [
    "  record.exitCode = exitCode;",
    "  if (exitSignal) record.exitSignal = exitSignal; // [pi-fabric-exitSignal-record]",
    "  record.stderr = stderr.slice(-MAX_STDERR_CHARS);",
  ].join("\n"),
};

/** 2d) pi-fabric：错误文案改为「退出方式在前，stderr 在后」 */
const FABRIC_ERROR: Patch = {
  file: path.join(NPM, "pi-fabric/dist/worker.js"),
  marker: "pi-fabric-error-ordering",
  label: "pi-fabric 死因文案不掩盖",
  original:
    '    record.error = stderr.trim() || (exitCode === 0 ? `${runnerLabel(options.runner)} agent reported an error before exiting` : `${runnerLabel(options.runner)} exited with code ${exitCode ?? "unknown"}`);',
  patched: [
    '    // [pi-fabric-error-ordering] stderr 可能是无关的扩展报错（例如 pi-fold 的',
    '    // "Evidence ingestion requires an absolute Pi session file"），会掩盖真实死因。',
    '    // 因此把退出方式放在最前面，stderr 作为附加细节附在后面。',
    '    const howDied = exitSignal !== null && exitSignal !== void 0',
    '      ? `${runnerLabel(options.runner)} was killed by ${exitSignal} (no exit code)`',
    '      : `${runnerLabel(options.runner)} exited with code ${exitCode ?? "unknown"}`;',
    '    const stderrTail = stderr.trim();',
    '    record.error = stderrTail && exitCode !== 0',
    '      ? `${howDied}; last stderr: ${stderrTail}`',
    '      : (stderrTail || howDied);',
  ].join("\n"),
};

const PATCHES = [FOLD_TOOL_RESULT, FABRIC_SIGNAL, FABRIC_DECL, FABRIC_RECORD, FABRIC_ERROR];

type Result = "patched" | "already" | "missing" | "unexpected";

function ensurePatched(patch: Patch): Result {
  let content: string;
  try {
    content = fs.readFileSync(patch.file, "utf8");
  } catch {
    return "missing";
  }
  if (content.includes(patch.marker)) return "already";
  if (!content.includes(patch.original)) return "unexpected";
  try {
    fs.writeFileSync(patch.file, content.replace(patch.original, patch.patched));
    return "patched";
  } catch {
    return "unexpected";
  }
}

export default function (_pi: ExtensionAPI) {
  const results = PATCHES.map((patch) => ({ patch, result: ensurePatched(patch) }));
  const applied = results.filter((r) => r.result === "patched");
  if (applied.length > 0) {
    console.error(
      `[exit-diagnostics-patch] 已应用：${applied.map((r) => r.patch.label).join(" / ")}`,
    );
  }
  for (const { patch, result } of results) {
    if (result === "unexpected") {
      console.error(
        `[exit-diagnostics-patch] 跳过 ${patch.label}：上游文本已变（升级后需更新补丁）`,
      );
    }
  }
}
