/**
 * fabric-atomic-write-hardening — 让 pi-fabric 的状态落盘失败变成「降级」而不是「炸掉整个 pi」。
 *
 * 背景（2026-10-19 真实事故）：`/tmp` 是 tmpfs（systemd 的 tmp.mount，size=50%、usrquota），
 * 被一个 25.9 GB 的残留文件撑到 25107 MB / 31 GB，随后 pi-fabric 的
 * `AgentManager.#monitor` 轮询里 `writeRecord() -> writeJsonAtomic() -> writeFileSync()`
 * 抛 `EDQUOT`（errno -122，Node 显示为 `Unknown system error -122`），
 * 因为没被 catch，直接走 uncaughtException 把主 pi 进程带走。
 *
 * 两处补丁：
 *   1. `chunk-MPRBK7QD.js` 的 `writeRecord()`：整函数加 try/catch —— 状态文件写失败只降级为
 *      「本轮状态丢失」，不再毒化进程。（同文件 `_HostedRun.#write()` 早就这么做了，属于漏改。）
 *   2. `chunk-IZIBLVU2.js` 的 `atomic-write.ts`：
 *      - `renameAtomic` 的可重试码补 `EDQUOT / ENOSPC / EIO`（配额放开后重试即可成功）；
 *      - `writeFileAtomic` 在写临时文件时遇到 `EDQUOT / ENOSPC` 就回收临时文件、退避后重试，
 *        并且失败时不再掩盖「真正想抛的那个写错误」（当前 finally 里的 rmSync 会二次抛）。
 *
 * 为什么用扩展在启动时打：`pi install` 带 `--ignore-scripts`，升级会整体覆盖 dist，
 * 所以补丁必须每次启动幂等重打（已打过则跳过，文件缺失则静默跳过）。
 *
 * 另：本补丁只让「写失败」不再致命，不解决 tmpfs 容量本身。所以本扩展在启动时
 * 还会把 TMPDIR 指到磁盘（`~/.cache/pi-tmp`，可用 `PI_TMPDIR` 覆盖），使 pi-fabric 的
 * `mkdtemp(os.tmpdir() + "pi-fabric-runs-")` 落到 748 GB 可用的根盘而不是 31 GB 的 tmpfs。
 * 仍然保留 fabric 自己的 managedTempRoot 自动清理逻辑。
 *
 * 卸载：删除本文件即可；要彻底还原 dist，把两处补丁文本改回原文（见下方 original 常量）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CHUNKS = path.join(
  os.homedir(),
  ".pi/agent/npm/node_modules/pi-fabric/dist/chunks",
);

type Patch = {
  file: string;
  marker: string;
  original: string;
  patched: string;
  label: string;
};

/** 1) writeRecord：整函数兜底 */
const WRITE_RECORD: Patch = {
  file: path.join(CHUNKS, "chunk-MPRBK7QD.js"),
  marker: "pi-fabric-writeRecord-guard",
  label: "writeRecord() 写入降级",
  original: [
    "var writeRecord = (filePath, record) => {",
    "  writeJsonAtomic(filePath, record, { space: 2 });",
    "};",
  ].join("\n"),
  patched: [
    "var writeRecord = (filePath, record) => {",
    "  // [pi-fabric-writeRecord-guard] 状态落盘失败不能逃逸成 uncaughtException：",
    "  // tmpfs 配额/空间耗尽（EDQUOT/ENOSPC）曾把整个 pi 进程带走。降级为 stderr 提示。",
    "  try {",
    "    writeJsonAtomic(filePath, record, { space: 2 });",
    "  } catch (error) {",
    "    try {",
    "      process.stderr.write(`[pi-fabric] status write failed (${filePath}): ${error instanceof Error ? error.message : String(error)}\\n`);",
    "    } catch {",
    "    }",
    "  }",
    "};",
  ].join("\n"),
};

/** 2a) renameAtomic：可重试码补配额/空间/IO */
const RENAME_RETRY: Patch = {
  file: path.join(CHUNKS, "chunk-IZIBLVU2.js"),
  marker: "pi-fabric-rename-quota-retry",
  label: "renameAtomic() 重试码扩充",
  original:
    'var RETRYABLE_RENAME_CODES = /* @__PURE__ */ new Set(["EPERM", "EACCES", "EEXIST", "EBUSY"]);',
  patched:
    'var RETRYABLE_RENAME_CODES = /* @__PURE__ */ new Set(["EPERM", "EACCES", "EEXIST", "EBUSY", "EDQUOT", "ENOSPC", "EIO", "EMFILE", "ENFILE"]); // [pi-fabric-rename-quota-retry] 配额/空间/句柄耗尽是瞬时的',
};

/** 2b) writeFileAtomic：写临时文件遇 EDQUOT/ENOSPC 退避重试，且不掩盖首个错误 */
const WRITE_ATOMIC: Patch = {
  file: path.join(CHUNKS, "chunk-IZIBLVU2.js"),
  marker: "pi-fabric-writeFileAtomic-requota",
  label: "writeFileAtomic() 配额退避重试",
  original: [
    "  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;",
    "  try {",
    "    fs.writeFileSync(temporary, contents, {",
    '      encoding: "utf8",',
    "      mode: options?.mode ?? 384",
    "    });",
    "    renameAtomic(temporary, filePath, options);",
    "  } finally {",
    "    fs.rmSync(temporary, { force: true });",
    "  }",
  ].join("\n"),
  patched: [
    "  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;",
    "  // [pi-fabric-writeFileAtomic-requota] tmpfs 配额/空间耗尽（EDQUOT/ENOSPC）时退避重试，",
    "  // 让同一进程内其它写入/清理释放空间后仍能落盘；照抄 renameAtomic 的退避形状。",
    "  const writeAttempts = Math.max(1, options?.writeRetries ?? 6);",
    "  const writeDelay = options?.writeRetryDelayMs ?? 40;",
    "  const transient = /* @__PURE__ */ new Set([\"EDQUOT\", \"ENOSPC\", \"EIO\"]);",
    "  let firstError;",
    "  try {",
    "    for (let attempt = 1; attempt <= writeAttempts; attempt++) {",
    "      try {",
    "        fs.writeFileSync(temporary, contents, {",
    '          encoding: "utf8",',
    "          mode: options?.mode ?? 384",
    "        });",
    "        renameAtomic(temporary, filePath, options);",
    "        return;",
    "      } catch (error) {",
    "        const code = errorCode(error);",
    "        if (firstError === undefined) firstError = error;",
    "        if (attempt === writeAttempts || code === undefined || !transient.has(code)) throw error;",
    "        try {",
    "          fs.rmSync(temporary, { force: true });",
    "        } catch {",
    "        }",
    "        syncSleep(writeDelay * attempt);",
    "      }",
    "    }",
    "  } finally {",
    "    try {",
    "      fs.rmSync(temporary, { force: true });",
    "    } catch {",
    "    }",
    "  }",
  ].join("\n"),
};

const PATCHES = [WRITE_RECORD, RENAME_RETRY, WRITE_ATOMIC];

type Result = "patched" | "already" | "missing" | "unexpected";

/** 幂等打补丁。 */
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

/**
 * 把 TMPDIR 挪到磁盘。pi 进程内的 os.tmpdir() 每次都会读这个环境变量，
 * 而本扩展在 fabric 生成 run 目录之前加载，所以对 `agents.spawn` 生效。
 * 已由外部显式设置时不动（尊重用户的 shell/systemd 配置）。
 */
function relocateTmpDir(): string | undefined {
  const home = os.homedir();
  const target = process.env.PI_TMPDIR?.trim() || path.join(home, ".cache", "pi-tmp");
  const current = process.env.TMPDIR?.trim();
  if (current === target) return undefined;
  try {
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  } catch {
    return undefined;
  }
  // 只有原本指向 tmpfs 的 /tmp、或压根没设时才接管，避免覆盖用户自己选的位置。
  const previous = current || "/tmp";
  try {
    const stat = fs.statfsSync(previous);
    // TMPFS_MAGIC = 0x01021994
    if (stat.type !== 0x01021994) return undefined;
  } catch {
    return undefined;
  }
  process.env.TMPDIR = target;
  return `${previous} -> ${target}`;
}

export default function (_pi: ExtensionAPI) {
  const moved = relocateTmpDir();
  if (moved) {
    console.error(`[fabric-atomic-write-hardening] TMPDIR 已从 tmpfs 迁到磁盘：${moved}`);
  }
  const results = PATCHES.map((patch) => ({ patch, result: ensurePatched(patch) }));
  const applied = results.filter((r) => r.result === "patched");
  if (applied.length > 0) {
    console.error(
      `[fabric-atomic-write-hardening] 已加固 ${applied.map((r) => r.patch.label).join(" / ")}`,
    );
  }
  for (const { patch, result } of results) {
    if (result === "unexpected") {
      console.error(
        `[fabric-atomic-write-hardening] 跳过 ${patch.label}：pi-fabric 文本已变（升级后需更新补丁）`,
      );
    }
  }
}
