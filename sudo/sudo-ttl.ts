/**
 * sudo-ttl — 在 pi 里一键查看/修改 sudo_exec 凭据缓存有效期。
 *
 * 用法（TUI 内）：
 *   /sudo-ttl              # 查看当前 TTL
 *   /sudo-ttl 1h           # 设为 1 小时（支持 ms/s/m/h/d、2h30m）
 *   /sudo-ttl session      # 整个会话（≈24.8 天，会话结束即清）
 *   /sudo-ttl default      # 还原插件默认 15 分钟
 *
 * 实现：只做参数转发，真正逻辑在 `~/bin/pi-sudo-ttl`（同一份代码，命令行也能用），
 * 修改的是 `~/.pi/agent/settings.json` 的 `archimedes.sudo.ttlMs`。
 * @pi-archimedes/sudo 每次 sudo_exec 调用都会重新 loadSudoConfig()，改完下一次
 * 调用即生效，不需要 /reload。
 */
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const CLI = path.join(os.homedir(), "bin", "pi-sudo-ttl");

export default function sudoTtlExtension(pi: ExtensionAPI): void {
  pi.registerCommand("sudo-ttl", {
    description: "查看/修改 sudo 凭据缓存有效期（如 /sudo-ttl 1h、session、default）",
    getArgumentCompletions: (prefix: string) => {
      const items = [
        { value: "15m", label: "15m", description: "插件默认 15 分钟" },
        { value: "1h", label: "1h", description: "1 小时" },
        { value: "4h", label: "4h", description: "4 小时" },
        { value: "session", label: "session", description: "整个会话（≈24.8 天，会话结束即清）" },
        { value: "default", label: "default", description: "还原插件默认 15 分钟" },
      ].filter((i) => i.value.startsWith(prefix));
      return items.length > 0 ? items : null;
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const argv = args.trim() === "" ? [] : args.trim().split(/\s+/);
      try {
        const stdout = await new Promise<string>((resolve, reject) => {
          execFile(
            process.execPath,
            [CLI, ...argv],
            { timeout: 10_000, encoding: "utf-8" },
            (err, out, errOut) => {
              if (err) {
                const detail = (errOut || out || err.message).toString().trim();
                reject(new Error(detail));
                return;
              }
              resolve((out || "").toString().trim());
            },
          );
        });
        ctx.ui.notify(stdout, "info");
      } catch (err) {
        ctx.ui.notify(`/sudo-ttl 失败: ${(err as Error).message}`, "error");
      }
    },
  });
}
