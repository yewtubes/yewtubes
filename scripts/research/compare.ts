// Opens the same page on youtube.com (read-only, live.ts) and on this
// instance, and lists the client's components each one renders: the custom
// elements visible in ytd-app, with counts. Components YouTube shows that the
// instance doesn't are the page parts still to implement. Screenshots and the
// lists go to captures/compare/<name>/ (gitignored: the live side is a real
// account's page).
//   bun scripts/research/compare.ts --cookies file.txt [--login bob:yewtube-demo] [--narrow] "name|/live/path|/our/path" ...
//   bun scripts/research/compare.ts --signed-out [--narrow] "name|/live/path|/our/path" ...
// An our-path of "-" means the same path as live.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { signIn } from "../probe";
import { liveContext } from "./live";

const ORIGIN = process.env.ORIGIN ?? "http://localhost:8080";
const args = process.argv.slice(2);
const opt = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const cookies = opt("--cookies");
const [login, password] = (opt("--login") ?? "bob:yewtube-demo").split(":");
const narrow = args.includes("--narrow");
const signedOut = args.includes("--signed-out");
const pages = args.filter((a, i) => a.includes("|") && !["--cookies", "--login"].includes(args[i - 1])).map((a) => {
	const [name, live, ours] = a.split("|");
	return { name, live, ours: !ours || ours === "-" ? live : ours };
});

const viewport = narrow ? { width: 412, height: 860 } : { width: 1400, height: 900 };
// youtube.com through the outbound proxy, the instance directly (Playwright
// sends loopback through a browser's proxy too, so two browsers)
const executablePath = process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined;
const browser = await chromium.launch({ executablePath, proxy });
const localBrowser = await chromium.launch({ executablePath });
const live = await liveContext(browser, signedOut ? undefined : cookies, { viewport });
const local = await localBrowser.newContext({ viewport, locale: "en-US" });
const ourPage = await local.newPage();
if (!signedOut) await signIn(ourPage, login, password, ORIGIN);

// visible custom elements in the app, in document order, counted
const outline = (page: Page) =>
	page.evaluate(() => {
		const counts: Record<string, number> = {};
		for (const e of Array.from(document.querySelectorAll("ytd-app *"))) {
			const tag = e.tagName.toLowerCase();
			if (!tag.includes("-") || !(e as HTMLElement).getClientRects().length) continue;
			counts[tag] = (counts[tag] ?? 0) + 1;
		}
		return counts;
	});

async function open(page: Page, url: string, shot: string) {
	await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
	await page.waitForTimeout(6000);
	// below the fold too: lazily loaded sections
	await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight / 3));
	await page.waitForTimeout(2000);
	await page.evaluate(() => window.scrollTo(0, 0));
	await page.waitForTimeout(800);
	await page.screenshot({ path: shot });
	return outline(page);
}

const livePage = await live.ctx.newPage();
const summary: string[] = [];
for (const p of pages) {
	const dir = join("captures", "compare", signedOut ? `${p.name}-out` : p.name);
	mkdirSync(dir, { recursive: true });
	const [a, b] = [await open(livePage, `https://www.youtube.com${p.live}`, join(dir, "live.png")), await open(ourPage, `${ORIGIN}${p.ours}`, join(dir, "ours.png"))];
	const missing = Object.keys(a).filter((t) => !b[t]).sort();
	const extra = Object.keys(b).filter((t) => !a[t]).sort();
	const lines = [`== ${p.name}: ${p.live} vs ${p.ours}`, `missing: ${missing.map((t) => `${t}(${a[t]})`).join(" ") || "-"}`, `only ours: ${extra.map((t) => `${t}(${b[t]})`).join(" ") || "-"}`];
	writeFileSync(join(dir, "outline.json"), JSON.stringify({ live: a, ours: b }, null, 1));
	summary.push(...lines);
	console.log(lines.join("\n"));
}
writeFileSync(join("captures", "compare", `summary${signedOut ? "-out" : ""}${narrow ? "-narrow" : ""}.txt`), summary.join("\n") + "\n");
await Promise.all([browser.close(), localBrowser.close()]);
process.exit(0);
