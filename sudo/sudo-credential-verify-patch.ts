/**
 * sudo-credential-verify-patch — 让 `sudo_exec` 在「命令自己失败」时用**密码**（而不是票据）
 * 判定缓存凭据是否有效，避免误报「cached credential could not be verified」并清缓存重新要密码。
 *
 * 背景：@pi-archimedes/sudo 在命令非零退出后跑 `sudo -n -v` 探测票据：
 * 票据有效 ⇒ 认为凭据没问题；票据无效 ⇒ 记一击「凭据无法验证」，两连击就清掉缓存重新弹密码框。
 * 但 Ubuntu 默认 `timestamp_type=tty`，而 sudo_exec 用 `spawn(..., {detached:true})` 没有控制终端，
 * 票据实际不可复用 ⇒ 探测对「密码完全正确的运行」也照样失败。后果：
 *   - 任何命令级失败（命令写错、文件不存在、shell 元字符被当参数……）都被贴上
 *     「缓存凭据可能有问题」的 WARNING；
 *   - 同一会话里连丢两次，缓存被清，人又被弹一次密码框 → 看起来像 sudo 缓存出 bug。
 *
 * 补丁把它换成权威判定：`sudo -k -S -v -p ''`（-v 只校验凭据、不执行任何程序，密码走 stdin，
 * 不落盘、不进 argv）。退出码 0 ⇒ 密码有效 ⇒ 记为普通命令失败；非 0 ⇒ 才记一击。
 * 判定仍先看票据（成本低、成功即返回），票据失败才补这次密码校验。
 *
 * 为什么静态补丁：调用点在包内部，ESM 导出不可写；`pi install` 升级会覆盖 src，
 * 故每次启动幂等重打。文本变了（上游升级）就跳过并提示，不影响启动。
 * 卸载：删本文件，并把 tool.ts 里带 [pi-sudo-verify-password-not-ticket] 的那段删掉/还原。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const FILE = path.join(
  os.homedir(),
  ".pi/agent/npm/node_modules/@pi-archimedes/sudo/src/tool.ts",
);

const MARKER = "[pi-sudo-verify-password-not-ticket]";

const ORIGINAL = [
  "\t\t\t\t} catch {",
  "\t\t\t\t\tticketValid = false; // probe transport error → non-terminal probe",
  "\t\t\t\t}",
  "\t\t\t\tif (ticketValid) {",
].join("\n");

const PATCHED = [
  "\t\t\t\t} catch {",
  "\t\t\t\t\tticketValid = false; // probe transport error → non-terminal probe",
  "\t\t\t\t}",
  "\t\t\t\t// [pi-sudo-verify-password-not-ticket] 票据探测在没有可复用票据的环境里",
  "\t\t\t\t// （Ubuntu 默认 timestamp_type=tty，而 sudo_exec 的 spawn 没有控制终端）",
  "\t\t\t\t// 即使密码完全正确也必然失败，于是任何命令级失败都被误报成",
  "\t\t\t\t// 「缓存凭据无法验证」，两连击后清缓存重新要密码。改用缓存密码做权威判定：",
  "\t\t\t\t// `sudo -k -S -v -p ''`（-v 只校验凭据、不执行程序，密码走 stdin）。",
  "\t\t\t\t// 退出码 0 ⇒ 密码有效 ⇒ 只是命令自身失败，不再记击。",
  "\t\t\t\tlet passwordVerified = false;",
  "\t\t\t\tif (!ticketValid) {",
  "\t\t\t\t\ttry {",
  "\t\t\t\t\t\tconst verify = await runSudo(",
  "\t\t\t\t\t\t\t[\"sudo\", \"-k\", \"-S\", \"-v\", \"-p\", \"\"],",
  "\t\t\t\t\t\t\tcredential.password,",
  "\t\t\t\t\t\t\tAUTH_PROBE_TIMEOUT_MS,",
  "\t\t\t\t\t\t\tsignal,",
  "\t\t\t\t\t\t\tspawner,",
  "\t\t\t\t\t\t);",
  "\t\t\t\t\t\tpasswordVerified = verify.exitCode === 0;",
  "\t\t\t\t\t} catch {",
  "\t\t\t\t\t\tpasswordVerified = false;",
  "\t\t\t\t\t}",
  "\t\t\t\t}",
  "\t\t\t\tif (ticketValid || passwordVerified) {",
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
    console.error(
      "[sudo-credential-verify-patch] 已打补丁：命令失败时用密码校验缓存凭据，不再误清缓存（下次启动生效）",
    );
  } else if (result === "unexpected") {
    console.error(
      "[sudo-credential-verify-patch] 跳过：@pi-archimedes/sudo 的 tool.ts 文本已变（升级后需更新补丁）",
    );
  }
}
