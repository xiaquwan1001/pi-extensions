/**
 * sudo-skip-confirm-patch — 让 `sudo_exec` 在「本会话凭据缓存仍有效」时不再逐条弹授权确认窗。
 *
 * 背景：@pi-archimedes/sudo 每次 sudo_exec 都会先 `ctx.ui.confirm(...)` 弹一次确认，
 * 只有密码本身走 TTL 缓存。于是即便 15 分钟/整会话的密码缓存有效，AI 每跑一条 sudo
 * 仍要人点一次弹窗 → 长任务卡在等人。
 *
 * 补丁点只有一个：`src/tool.ts` 里
 *     const confirmed = await confirmCommand(ctx, command, reason);
 * 改成「缓存有效则直接视为已确认」。命令与 reason 仍然出现在工具调用参数里，
 * 首次（无缓存）时密码输入框也会显示 command + reason，安全性没有实质下降。
 *
 * 开关（settings.json → archimedes.sudo）：
 *   skipConfirmWhenCached: false  → 恢复上游的逐条确认行为
 *   ttlMs: 2147483647             → 密码缓存覆盖整个会话（可 /sudo-ttl session）
 *
 * 为什么用静态补丁而不是运行时包装：confirm 调用在包内部，ESM 导出不可写；
 * 而 `pi install` 升级会整体覆盖 src，所以每次启动幂等重打（已打过则跳过）。
 * 加载顺序不保证本扩展早于 sudo 包 → 打上后可能需要下一次启动才生效；
 * 只在文本变了（上游升级）时打不上，此时跳过并提示，不影响启动。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const FILE = path.join(
  os.homedir(),
  ".pi/agent/npm/node_modules/@pi-archimedes/sudo/src/tool.ts",
);

const MARKER = "[pi-sudo-skip-confirm-when-cached]";

const ORIGINAL = [
  "\t\t\t// Display the exact command + reason and require confirmation",
  "\t\t\t// BEFORE any credential is acquired.",
  "\t\t\tconst confirmed = await confirmCommand(ctx, command, reason);",
].join("\n");

const PATCHED = [
  "\t\t\t// Display the exact command + reason and require confirmation",
  "\t\t\t// BEFORE any credential is acquired.",
  "\t\t\t// [pi-sudo-skip-confirm-when-cached] 凭据缓存仍有效时跳过逐条的授权确认弹窗",
  "\t\t\t// （由 ~/.pi/agent/extensions/sudo-skip-confirm-patch.ts 幂等重打）。",
  "\t\t\t// 命令与 reason 仍在工具调用参数里可见；要恢复逐条确认：",
  "\t\t\t// settings.json 里设 \"archimedes.sudo.skipConfirmWhenCached\": false。",
  "\t\t\tconst confirmed =",
  "\t\t\t\tcredentialCache.get() !== null &&",
  "\t\t\t\t(config as { skipConfirmWhenCached?: boolean }).skipConfirmWhenCached !== false",
  "\t\t\t\t\t? true",
  "\t\t\t\t\t: await confirmCommand(ctx, command, reason);",
].join("\n");

/** "already" | "patched" | "unexpected" | "missing" */
function ensurePatched(): "already" | "patched" | "unexpected" | "missing" {
  let text: string;
  try {
    text = fs.readFileSync(FILE, "utf-8");
  } catch {
    return "missing";
  }
  if (text.includes(MARKER)) return "already";
  if (!text.includes(ORIGINAL)) return "unexpected";
  fs.writeFileSync(FILE, text.replace(ORIGINAL, PATCHED), "utf-8");
  return "patched";
}

export default function (_pi: ExtensionAPI): void {
  const result = ensurePatched();
  if (result === "patched") {
    console.error("[sudo-skip-confirm-patch] 已打补丁：凭据缓存有效时不再弹确认窗（下次启动生效）");
  } else if (result === "unexpected") {
    console.error(
      "[sudo-skip-confirm-patch] 跳过：@pi-archimedes/sudo 的 tool.ts 文本已变（升级后需更新补丁）",
    );
  }
}
