/**
 * firefox-browser-prompt — 本机唯一的浏览器栈是 Firefox（WebDriver BiDi），
 * 无 Chromium / 无 agent-browser CLI。本扩展向主会话注入一段精简说明，
 * 取代已移除的 pi-agent-browser-native playbook。
 *
 * 背景：2026-10-18 决策「移除 Chromium 线，全部改用 Firefox，必要时发起真实渲染」。
 * 渲染后端：~/.pi/agent/extensions/web-search/bin/browserfetch.mjs
 *   - 无头默认；`touch ~/pi-firefox/headed` 切有头真实渲染，删除标记回无头
 *   - `PI_FIREFOX_PROFILE=<dir>` 复用登录态（默认一次性临时 profile）
 * 卸载：删除本目录即可。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SECTION = `浏览器（本机仅 Firefox，无 Chromium）：
- 读网页用 web_fetch，搜索用 web_search；provider="browser" = 本地 Firefox 渲染（auto 模式下作最后兜底）。两者都要过 WAF/需 JS 时才有必要。
- 真实渲染（有头窗口，过 Cloudflare/登录/人工确认）：bash 里 \`touch ~/pi-firefox/headed\` 后照常调用 web_fetch/web_search，用完 \`rm -f ~/pi-firefox/headed\` 回到无头。运行中的会话立即生效，无需重启。
- 需要保留登录态：设 \`PI_FIREFOX_PROFILE=~/pi-firefox/profile\`（需在 pi 进程环境里，改动后重启 pi），否则每次都是临时 profile。
- 直接驱动（批处理/自写脚本）: \`node ~/.pi/agent/extensions/web-search/bin/browserfetch.mjs fetch <url> [--headed] [--timeout 45000]\` 或 \`search <query> --limit 8\`，输出单行 JSON。
- 不要尝试 Chromium/agent-browser/playwright/puppeteer：本机都未安装，agent-browser 扩展已于 2026-10-18 移除。`;

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event) => {
		if (!event.systemPromptOptions) {
			(event as unknown as { systemPromptOptions: { sections: Record<string, string> } })
				.systemPromptOptions = { sections: {} };
		}
		if (!event.systemPromptOptions.sections) {
			event.systemPromptOptions.sections = {};
		}
		event.systemPromptOptions.sections.firefox_browser = SECTION;
	});
}
