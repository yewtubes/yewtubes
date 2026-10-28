// Research capture of youtube.com: HAR with bodies, individual youtubei/HTML
// responses, screenshots. Output goes to captures/<name>/ (gitignored, raw).
//   bun scripts/research/capture.ts <name> <url> [--narrow] [--cookies file.txt]
//   STEPS=/abs/path/steps.ts runs extra interactions after load.
//
// --cookies loads a Netscape cookie file (an authorized test session); the
// session is then read-only (live.ts).
import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { liveContext } from "./live";

const [name, url] = process.argv.slice(2);
const narrow = process.argv.includes("--narrow");
const cookieFile = process.argv.includes("--cookies") ? process.argv[process.argv.indexOf("--cookies") + 1] : undefined;
const out = join("captures", name);
mkdirSync(join(out, "bodies"), { recursive: true });
const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined;
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", proxy, args: ["--autoplay-policy=no-user-gesture-required"] });
const { ctx, blocked } = await liveContext(browser, cookieFile, {
	// a HAR would carry the session's cookies; not recorded for signed-in captures
	...(cookieFile ? {} : { recordHar: { path: join(out, "capture.har"), content: "embed" as const } }),
	viewport: narrow ? { width: 412, height: 860 } : { width: 1400, height: 900 },
	recordVideo: { dir: join(out, "video"), size: narrow ? { width: 412, height: 860 } : { width: 1400, height: 900 } },
});
const page = await ctx.newPage();
// InnerTube request bodies are gzipped
const postBody = (req: any) => {
	const b: Buffer | null = req.postDataBuffer();
	if (!b) return null;
	try {
		return JSON.parse((b[0] === 0x1f && b[1] === 0x8b ? gunzipSync(b) : b).toString());
	} catch {
		return b.toString("latin1").slice(0, 2000);
	}
};
const log: string[] = [];
let n = 0;
page.on("console", (m) => log.push(`console.${m.type()}: ${m.text()}`));
page.on("pageerror", (e) => log.push(`pageerror: ${e.message}`));
page.on("response", async (r) => {
	const u = r.url();
	const req = r.request();
	log.push(`${r.status()} ${req.method()} ${u.slice(0, 300)}`);
	if (/\/youtubei\/v1\/|[?&]pbj=1|\/getAccountSwitcherEndpoint/.test(u) || (req.resourceType() === "document")) {
		try {
			const body = await r.text();
			const file = `${String(++n).padStart(3, "0")}-${new URL(u).pathname.replace(/[^\w]+/g, "_").slice(0, 60)}`;
			writeFileSync(join(out, "bodies", file + ".resp"), body);
			writeFileSync(join(out, "bodies", file + ".req.json"), JSON.stringify({ url: u, method: req.method(), headers: Object.fromEntries(Object.entries(req.headers()).filter(([k]) => !/^(cookie|authorization|x-goog-authuser|x-goog-visitor-id)$/i.test(k))), post: postBody(req) }, null, 1));
		} catch {}
	}
});
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(8000);
await page.screenshot({ path: join(out, "01-loaded.png") });
const steps = process.env.STEPS ? (await import(process.env.STEPS)).default : null;
if (steps) await steps(page, out);
writeFileSync(join(out, "log.txt"), log.join("\n") + `\nblocked:\n${blocked.join("\n")}\n`);
if (cookieFile) console.log(`blocked ${blocked.length} requests: ${[...new Set(blocked.map((b) => b.replace(/\/youtubei\/v1\//, " ")))].slice(0, 12).join(", ")}`);
await ctx.close();
await browser.close();
console.log(`captured ${name}: ${log.length} log lines, ${n} bodies`);
