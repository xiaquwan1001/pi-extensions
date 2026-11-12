/**
 * model-speed — 池内模型速度实测 + 会话内慢速自动换档
 *
 * 1) 启动时读 `last-probe.json`（由 probe.sh 定期生成），把「可能很慢」的模型在终端里
 *    提示出来；也可随时 `/speed` 现场重测。
 * 2) 会话内统计每个模型的实际 TTFT/吞吐（从 message_start → 首个增量 → message_end）。
 *    当当前会话的模型连续 N 轮明显偏慢，就把会话切到池里另一档（同 provider 内的
 *    ustc-dsf / ustc-dsf2 / ustc-glm / ustc-qwen），并记一条状态，避免下一轮继续踩慢档。
 *
 * 设计约束：
 *  - 切档只在 `custom.ustc-pool` 内部进行，不跨 provider；用户手动 /model 会重置计数。
 *  - 只统计「主模型」调用：message_start 有 model 字段的 assistant 消息。
 *  - 采样窗口 3 轮，中位数超过阈值才切；切过就不再切（避免来回跳），直到用户手动换。
 */

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const DIR = join(homedir(), ".pi", "agent", "extensions", "model-speed");
const PROBE_JSON = join(DIR, "last-probe.json");
const LOG = join(DIR, "speed-log.jsonl");
const STATE = join(DIR, "state.json");

/** 慢的判据（毫秒）：首 token 中位数，按上下文规模分档 */
const envMs = (name: string, dflt: number) => {
	const v = Number(process.env[name]);
	return Number.isFinite(v) && v > 0 ? v : dflt;
};
const SLOW_TTFT_MS = {
	small: envMs("PI_MODEL_SPEED_SLOW_MS", 12_000), // < 30k prompt
	large: envMs("PI_MODEL_SPEED_SLOW_LARGE_MS", 25_000), // >= 30k prompt
};
const SLOW_TPOT_MS = envMs("PI_MODEL_SPEED_SLOW_TPOT_MS", 250); // 每输出 token 平均毫秒（≈4 tok/s 以下算慢）
const WINDOW = envMs("PI_MODEL_SPEED_WINDOW", 3); // 连续多少轮才判定
const COOLDOWN_MS = 10 * 60_000;
const EXTVER = "v3"; // EXTVER: 用来确认跑的是最新代码 // 切档后 10 分钟内不再动

type Sample = {
	model: string;
	served?: string;
	provider: string;
	promptTokens?: number;
	ttftMs?: number;
	tpotMs?: number;
	startedAt: number;
	endedAt?: number;
	error?: string;
};

type ProbeFile = {
	ts: number;
	models: Record<string, { ok: boolean; status?: string; ttft?: number | null; total?: number | null; err?: string }>;
};

let samples: Sample[] = [];
let pending: Array<Sample & { ttftMs?: number }> = [];
let lastSwitchAt = 0;
let switchedThisSession = false;

/** 跨实例共享的换档状态（pi 可能同时加载两份扩展实例，不能只靠进程内变量） */
async function readState(): Promise<{ lastSwitchAt: number; switchedSession?: string }> {
	try {
		return JSON.parse(await readFile(STATE, "utf8"));
	} catch {
		return { lastSwitchAt: 0 };
	}
}

async function writeState(patch: Record<string, unknown>) {
	try {
		const { writeFile } = await import("node:fs/promises");
		const cur = await readState();
		await writeFile(STATE, JSON.stringify({ ...cur, ...patch }));
	} catch {
		/* 统计/协调文件写失败不影响会话 */
	}
}

async function readProbe(): Promise<ProbeFile | null> {
	try {
		return JSON.parse(await readFile(PROBE_JSON, "utf8")) as ProbeFile;
	} catch {
		return null;
	}
}

/** 池内同 provider 的候选档位，按探针 TTFT 从快到慢 */
async function rankPoolModels(ctx: ExtensionContext): Promise<Array<{ id: string; ttft?: number }>> {
	const probe = await readProbe();
	const provider = ctx.model?.provider ?? "";
	const models = ctx.modelRegistry
		.getAvailable()
		.filter((m) => m.provider === provider)
		.map((m) => ({ id: m.id, ttft: probe?.models[m.id]?.ttft ?? undefined }));
	// 探针没数据或失败的一律排后（undefined / null）
	return models.sort((a, b) => {
		const av = a.ttft ?? Number.POSITIVE_INFINITY;
		const bv = b.ttft ?? Number.POSITIVE_INFINITY;
		return av - bv;
	});
}

function median(values: number[]): number {
	const v = [...values].sort((a, b) => a - b);
	const mid = Math.floor(v.length / 2);
	return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/** 当前会话最近 WINDOW 轮是否都明显慢 */
function slowStreak(): Sample[] | null {
	const usable = samples.filter((s) => !s.error && s.ttftMs !== undefined);
	if (usable.length < WINDOW) return null;
	const tail = usable.slice(-WINDOW);
	const now = Date.now();
	if (tail.some((s) => now - s.startedAt > COOLDOWN_MS)) return null; // 窗口太旧
	for (const s of tail) {
		const prompt = s.promptTokens ?? 0;
		const ttftLimit = prompt >= 30_000 ? SLOW_TTFT_MS.large : SLOW_TTFT_MS.small;
		const slowTtft = (s.ttftMs ?? 0) > ttftLimit;
		const slowTpot = (s.tpotMs ?? 0) > SLOW_TPOT_MS;
		if (!slowTtft && !slowTpot) return null;
	}
	return tail;
}

async function appendLog(entry: Record<string, unknown>) {
	try {
		const { appendFile, mkdir } = await import("node:fs/promises");
		await mkdir(DIR, { recursive: true });
		await appendFile(LOG, JSON.stringify({ ts: Date.now(), ...entry }) + "\n");
	} catch {
		// 统计日志失败不影响会话
	}
}

/** 后台跑一次探针（不阻塞 TUI） */
function runProbe(args: string[]): Promise<string> {
	return new Promise((resolve) => {
		const p = spawn("bash", [join(DIR, "probe.sh"), ...args], { stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		p.stdout?.on("data", (b) => (out += b.toString()));
		p.on("close", () => resolve(out.trim()));
		p.on("error", (e) => resolve(`spawn failed: ${e.message}`));
	});
}

function fmtMs(ms?: number | null): string {
	if (ms === undefined || ms === null) return "—";
	return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

export default function (pi: ExtensionAPI) {
	// ---- 会话内采样 ------------------------------------------------------
	// 计时锚点：before_provider_request（请求真正发出）→ 首个内容增量 = TTFT。
	// message_start 在响应头到达后才触发，用它算 TTFT 只会得到 ~0 的假值。
	// 用队列而不是单个变量：重试/嵌套调用会让请求重叠，单个变量会被后者覆盖。
	pi.on("before_provider_request", async (_event, ctx) => {
		pending.push({
			model: ctx.model?.id ?? "",
			provider: ctx.model?.provider ?? "",
			startedAt: Date.now(),
		});
		if (pending.length > 8) pending.shift();
	});

	pi.on("after_provider_response", async (event) => {
		// 网关回 x-litellm-model-name / x-litellm-model-id = 实际选中的上游部署
		const cur = pending[pending.length - 1];
		if (!cur) return;
		const h = (event.headers ?? {}) as Record<string, string>;
		const served = h["x-litellm-model-name"] ?? h["x-litellm-model-id"];
		if (typeof served === "string" && served.length > 0) cur.served = served;
		if (typeof event.status === "number" && event.status >= 400) cur.error = `HTTP ${event.status}`;
	});

	pi.on("message_update", async (event) => {
		const cur = pending[pending.length - 1];
		if (!cur || cur.ttftMs !== undefined) return;
		const ev = event.assistantMessageEvent as any;
		const hasPayload =
			ev?.type === "text_delta" || ev?.type === "thinking_delta" || ev?.type === "toolcall_delta" ||
			ev?.type === "toolcall_start";
		if (!hasPayload) return;
		const dt = Date.now() - cur.startedAt;
		if (dt >= 20) cur.ttftMs = dt; // <20ms 基本是钩子顺序假值，宁缺勿错
	});

	pi.on("message_end", async (event) => {
		const msg = event.message as any;
		if (msg?.role !== "assistant") return;
		const s = pending.shift(); // FIFO：最早的请求先收尾
		if (!s) return;
		s.endedAt = Date.now();
		const elapsed = s.endedAt - s.startedAt;
		// 队列可能因重试/钩子顺序错位：清掉不可能的 TTFT，别让脏样本影响判慢
		if (s.ttftMs !== undefined && (s.ttftMs < 50 || s.ttftMs > elapsed)) delete s.ttftMs;
		if (elapsed > 15 * 60_000) return; // 明显不是一次正常调用，丢弃
		const usage = msg?.usage;
		if (usage) {
			// 注意：网关的 input 只算「未命中缓存」的部分。totalTokens = input+cacheRead+cacheWrite+output，
			// 用 totalTokens 减 output 才是真实上下文规模。
			const outTok0 = usage.output ?? 0;
			const total = typeof usage.totalTokens === "number"
				? usage.totalTokens - outTok0
				: (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
			if (total > 0) s.promptTokens = total;
			const outTok = usage.output ?? 0;
			if (s.ttftMs !== undefined && outTok > 0) {
				s.tpotMs = Math.round((s.endedAt - s.startedAt - s.ttftMs) / outTok);
			}
		}
		if (msg?.stopReason === "error" || msg?.errorMessage) s.error = s.error ?? msg?.errorMessage ?? "error";
		samples.push(s);
		if (samples.length > 50) samples = samples.slice(-50);
		await appendLog({ kind: "sample", extver: EXTVER, pid: process.pid, ...s });
	});

	// ---- 慢速自动换档 ----------------------------------------------------
	pi.on("turn_end", async (_event, ctx) => {
		if (switchedThisSession) return;
		if (Date.now() - lastSwitchAt < COOLDOWN_MS) return;
		const shared = await readState();
		if (Date.now() - shared.lastSwitchAt < COOLDOWN_MS) return;
		const tail = slowStreak();
		if (!tail) return;

		const current = ctx.model;
		if (!current || current.provider !== "custom.ustc-pool") return; // 只在池内换

		const ranked = await rankPoolModels(ctx);
		const candidates = ranked.filter((m) => m.id !== current.id && m.ttft !== undefined);
		const best = candidates[0];
		if (!best) {
			ctx.ui.notify(
				`[model-speed] ${current.id} 连续 ${WINDOW} 轮偏慢（TTFT 中位 ${fmtMs(median(tail.map((s) => s.ttftMs!)))}），但池内没有更快的已测档位；可跑 /speed 重测`,
				"warning",
			);
			lastSwitchAt = Date.now();
			await writeState({ lastSwitchAt });
			return;
		}
		const target = ctx.modelRegistry.find(current.provider, best.id);
		if (!target) return;
		const ok = await pi.setModel(target);
		lastSwitchAt = Date.now();
		await writeState({ lastSwitchAt, lastFrom: current.id, lastTo: best.id });
		if (ok) {
			switchedThisSession = true;
			const before = current.id;
			ctx.ui.notify(
				`[model-speed] ${before} 连续 ${WINDOW} 轮偏慢（TTFT 中位 ${fmtMs(median(tail.map((s) => s.ttftMs!)))}），已切到池内较快的 ${best.id}（探针 ${fmtMs(best.ttft)}）`,
				"warning",
			);
			await appendLog({ kind: "switch", extver: EXTVER, pid: process.pid, from: before, to: best.id, reason: "slow", streak: tail });
		}
	});

	// ---- 启动时提示慢档 --------------------------------------------------
	pi.on("session_start", async (event, ctx) => {
		samples = [];
		pending = [];
		switchedThisSession = false;
		lastSwitchAt = 0;
		if (event.reason === "reload") return;

		const probe = await readProbe();
		const cur = ctx.model;
		if (probe) {
			const ageMin = Math.round((Date.now() / 1000 - probe.ts) / 60);
			const bad: string[] = [];
			for (const [id, v] of Object.entries(probe.models)) {
				if (!v.ok) bad.push(`${id}=失败(${v.status ?? "?"})`);
				else if ((v.ttft ?? 0) > SLOW_TTFT_MS.small / 1000) bad.push(`${id}=${fmtMs((v.ttft ?? 0) * 1000)}`);
			}
			const curBad = cur ? probe.models[cur.id] : undefined;
			if (bad.length > 0) {
				ctx.ui.notify(
					`[model-speed] 可能过慢的档位（${ageMin} 分钟前实测）：${bad.join("，")}` +
						(curBad && (!curBad.ok || (curBad.ttft ?? 0) > SLOW_TTFT_MS.small / 1000)
							? ` ⚠ 当前 ${cur?.id} 就在其中，可用 /model 换档`
							: ""),
					"warning",
				);
			}
		}

		const ranked = await rankPoolModels(ctx);
		if (ranked.length > 1) {
			const fastest = ranked[0];
			ctx.ui.setStatus("model-speed", `⚡ ${fastest.id}${fastest.ttft ? ` ${fmtMs(fastest.ttft * 1000)}` : ""}`);
		}
	});

	// ---- /speed 命令 -----------------------------------------------------
	pi.registerCommand("speed", {
		description: "实测池内各模型 TTFT（默认小上下文快测；加 full 测 2k+150k）",
		handler: async (args, ctx) => {
			const full = (args ?? "").includes("full");
			ctx.ui.notify(`[model-speed] 开始探针${full ? "（含 150k 大上下文，可能 1-2 分钟）" : "（快测）"}…`, "info");
			await runProbe(full ? ["--sizes", "2000 150000", "--budget", "120"] : ["--fast", "--budget", "60"]);
			const probe = await readProbe();
			if (!probe) {
				ctx.ui.notify("[model-speed] 探针没有产出结果", "error");
				return;
			}
			const lines = Object.entries(probe.models)
				.sort((a, b) => (a[1].ttft ?? 1e9) - (b[1].ttft ?? 1e9))
				.map(([id, v]) =>
					v.ok ? `${id}: ${fmtMs((v.ttft ?? 0) * 1000)}` : `${id}: 失败/${v.status ?? "?"}`,
				);
			ctx.ui.setWidget("model-speed", [`池内模型实测：`, ...lines.map((l) => `  ${l}`)], { placement: "belowEditor" });
			ctx.ui.notify(`[model-speed] ${lines.join(" | ")}`, "info");
		},
	});

	// ---- /speed-stats 命令 ----------------------------------------------
	pi.registerCommand("speed-stats", {
		description: "看本会话的实测速度统计（TTFT/TPOT）",
		handler: async (_args, ctx) => {
			if (samples.length === 0) {
				ctx.ui.notify("[model-speed] 本会话还没有采样", "info");
				return;
			}
			const byModel = new Map<string, Sample[]>();
			const seen = new Set<number>();
			for (const s of samples) {
				if (seen.has(s.startedAt)) continue; // 双实例会重复记同一次调用
				seen.add(s.startedAt);
				const arr = byModel.get(s.model || "?") ?? [];
				arr.push(s);
				byModel.set(s.model || "?", arr);
			}
			const lines: string[] = [];
			for (const [model, arr] of byModel) {
				const ttfts = arr.map((s) => s.ttftMs).filter((v): v is number => v !== undefined);
				const tpots = arr.map((s) => s.tpotMs).filter((v): v is number => v !== undefined);
				lines.push(
					`${model}: n=${arr.length} TTFT中位=${fmtMs(ttfts.length ? median(ttfts) : undefined)} TPOT中位=${tpots.length ? Math.round(median(tpots)) + "ms" : "—"}`,
				);
			}
			ctx.ui.setWidget("model-speed", ["本会话实测：", ...lines], { placement: "belowEditor" });
			ctx.ui.notify(`[model-speed] ${lines.join(" | ")}`, "info");
		},
	});

	pi.on("session_shutdown", async () => {
		if (samples.length) await appendLog({ kind: "session-end", samples: samples.length });
	});
}
