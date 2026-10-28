// A browser context on youtube.com for research: optionally signed in from a
// Netscape cookie file (an authorized test session), and then read-only:
// every InnerTube POST that is not a known read is aborted, as are
// watch-history/telemetry pings, cookie rotation and uploads.
// ALLOW_WRITES=method,method lets a step perform a specific write.
import { readFileSync } from "node:fs";
import type { Browser, BrowserContextOptions } from "playwright-core";

// InnerTube methods that only read
const READS = /^(browse|next|player|search|guide|get_watch|get_panel|account\/account_menu|account\/accounts_list|notification\/get_unseen_count|notification\/get_notification_menu|share\/get_share_panel|att\/get|reel\/reel_item_watch|reel\/reel_watch_sequence|navigation\/resolve_url|playlist\/get_add_to_playlist|comment\/get_comment.*|creator\/(get|list|search|fetch)_.*|ars\/(get|list)_.*|updated_metadata|music\/get_.*|yta_web\/.*|creator_music\/(get|list|search)_.*|get_survey|promotions\/get_.*|feature_eligibility\/check_.*|creator\/check_.*|channel_edit\/get_.*|upload\/feedback)$/;

export const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

export async function liveContext(browser: Browser, cookieFile: string | undefined, options: BrowserContextOptions = {}) {
	const ctx = await browser.newContext({
		// requests from YouTube's service worker would bypass the route filter below
		...(cookieFile ? { serviceWorkers: "block" as const } : {}),
		locale: "en-US",
		userAgent: USER_AGENT,
		...options,
	});
	const blocked: string[] = [];
	if (!cookieFile) return { ctx, blocked };
	const cookies = readFileSync(cookieFile, "utf8")
		.split("\n")
		.map((l) => l.split("\t"))
		.filter((p) => p.length >= 7 && !p[0].startsWith("# "))
		.map(([domain, , path, secure, expires, name, value]) => ({
			name,
			value,
			domain: domain.replace(/^#HttpOnly_/, ""),
			path,
			secure: secure === "TRUE",
			httpOnly: domain.startsWith("#HttpOnly_"),
			expires: Number(expires) || -1,
			sameSite: (name.startsWith("__Secure-") || name.startsWith("__Host-") ? "None" : "Lax") as "None" | "Lax",
		}));
	await ctx.addCookies(cookies);
	const allowWrites = new Set((process.env.ALLOW_WRITES ?? "").split(",").filter(Boolean));
	await ctx.route("**/*", (route) => {
		const req = route.request();
		const u = new URL(req.url());
		const m = /\/youtubei\/v1\/(.+)$/.exec(u.pathname);
		const deny =
			/(^|\.)accounts\.(google|youtube)\.com$|^upload\.youtube\.com$/.test(u.hostname) ||
			(/(^|\.)youtube\.com$/.test(u.hostname) && /^\/(api\/stats\/|ptracking|generate_204)/.test(u.pathname)) ||
			(m && req.method() === "POST" && !READS.test(m[1]) && !allowWrites.has(m[1]));
		if (deny) {
			blocked.push(`${req.method()} ${u.hostname}${u.pathname}`);
			return route.abort();
		}
		return route.continue();
	});
	return { ctx, blocked };
}
