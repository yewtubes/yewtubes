// Routes that belong to this instance rather than to the official client:
// the local sign-in and account pages (signin.ts; the client's "Sign in"
// goes there instead of accounts.google.com), avatars, view counting from
// the player's stats pings, and small endpoints the page fetches outside
// /youtubei.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { destroySession } from "./auth";
import type { Viewer } from "./client/page";
import { loadPin, archivePath } from "./client/store";
import { INSTANCE_NAME, MEDIA_DIR, PUBLIC_ORIGIN, STUDIO_ORIGIN } from "./config";
import { sql } from "./db";
import { isVideoId } from "./ids";
import { rateLimit } from "./ratelimit";
import { accountRoutes, instanceAsset } from "./signin";
import { myAccountRoutes } from "./myaccount";
import { feedbackRoutes } from "./feedback";
import { helpScript } from "./help";
import { adminRoutes } from "./admin";
import { gifRoutes } from "./gifs";
import { pickerRoutes } from "./picker";
import { suggest } from "./innertube/search";
import { accountSwitcher } from "./innertube/guide";
import { postImageUploadRoute, postMediaDir } from "./innertube/post-composer";
import { recordWatch } from "./innertube/history";
import { playedMs, recordView, recordWatchTime } from "./stats";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function instancePage(title: string, body: string, status = 200, headers: Record<string, string> = {}) {
	return new Response(
		`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} - ${esc(INSTANCE_NAME)}</title>
<style>
:root{color-scheme:light dark;--bg:#fff;--fg:#0f0f0f;--muted:#606060;--line:#e5e5e5;--accent:#065fd4;--err:#cc0000}
@media (prefers-color-scheme:dark){:root{--bg:#0f0f0f;--fg:#f1f1f1;--muted:#aaa;--line:#3f3f3f;--accent:#3ea6ff;--err:#ff6b6b}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 Roboto,Arial,sans-serif}
main{max-width:440px;margin:8vh auto;padding:32px 24px;border:1px solid var(--line);border-radius:12px}
main.wide{max-width:880px}
h1{font-size:22px;font-weight:500;margin:0 0 4px}p.sub{color:var(--muted);margin:0 0 24px}
label{display:block;margin:14px 0 4px;font-weight:500}input,textarea,select{box-sizing:border-box;width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:transparent;color:inherit;font:inherit}
button{margin-top:20px;padding:10px 18px;border:0;border-radius:18px;background:var(--fg);color:var(--bg);font:500 14px Roboto,Arial,sans-serif;cursor:pointer}
a{color:var(--accent)}.err{color:var(--err);margin:12px 0 0}.note{color:var(--muted);font-size:12px;margin-top:20px}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top;font-size:13px}
</style></head><body>${body}</body></html>`,
		{ status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:", ...headers } },
	);
}

// a path on this origin, or a page of the Studio origin
function safeNext(next: string | null): string {
	if (next && STUDIO_ORIGIN !== PUBLIC_ORIGIN && next.startsWith(`${STUDIO_ORIGIN}/`)) return next;
	return next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

// default avatar: the channel's initial on a colour derived from its id
function avatarSvg(seed: string, letter: string) {
	const hues = [4, 24, 200, 262, 291, 122, 340, 174];
	const h = hues[Number(BigInt(Bun.hash(seed)) % BigInt(hues.length))];
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 88 88"><rect width="88" height="88" fill="hsl(${h},55%,45%)"/><text x="44" y="58" font-family="Roboto,Arial,sans-serif" font-size="40" text-anchor="middle" fill="#fff">${esc(letter.toUpperCase())}</text></svg>`;
}

// signed-out viewers (comment box) and deleted channels
const PLACEHOLDER_AVATAR = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 88 88"><rect width="88" height="88" fill="#bdbdbd"/><circle cx="44" cy="34" r="16" fill="#fff"/><path d="M14 80c4-17 16-25 30-25s26 8 30 25z" fill="#fff"/></svg>`;

// a channel's picture or banner. The URLs don't change when the channel
// changes its picture (Studio's Customization), so browsers revalidate;
// "avatar-default" is the letter picture a channel has without one of its own
async function ggpht(req: Request, url: URL, viewer: Viewer): Promise<Response> {
	const post = /^\/ggpht\/post\/(Ugkx[A-Za-z0-9_-]{32})\/([\w-]{16}\.(?:jpg|png|gif|webp))(?:=[\w-]*)?$/.exec(url.pathname);
	if (post) return postImage(post[1], post[2], viewer);
	const m = /^\/ggpht\/(UC[A-Za-z0-9_-]{22})\/(avatar-default|avatar|banner)/.exec(url.pathname);
	if (!m) return new Response("not found", { status: 404 });
	const [c] = await sql`select title, avatar_path, banner_path from channels where id = ${m[1]}`;
	if (!c) return m[2] !== "banner" ? new Response(PLACEHOLDER_AVATAR, { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=3600" } }) : new Response("not found", { status: 404 });
	const p = m[2] === "avatar" ? c.avatar_path : m[2] === "banner" ? c.banner_path : null;
	const own = p && existsSync(join(MEDIA_DIR, p));
	if (m[2] === "banner" && !own) return new Response("not found", { status: 404 });
	const etag = `"${own ? p : `letter-${encodeURIComponent(c.title)}`}"`;
	const headers = { "cache-control": "public, no-cache", etag, "x-content-type-options": "nosniff" };
	if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
	if (own) return new Response(Bun.file(join(MEDIA_DIR, p)), { headers });
	return new Response(avatarSvg(m[1], [...c.title][0] ?? "?"), { headers: { ...headers, "content-type": "image/svg+xml" } });
}

// a post's image (post-composer.ts stores them under the post), for as long
// as the post is up; a scheduled post's only for its channel
async function postImage(postId: string, file: string, viewer: Viewer): Promise<Response> {
	const [p] = await sql`select published_at <= now() as published from posts where id = ${postId} and deleted_at is null and (published_at <= now() or channel_id = ${viewer?.channelId ?? ""})`;
	const path = join(postMediaDir(postId), file);
	if (!p || !existsSync(path)) return new Response("not found", { status: 404 });
	return new Response(Bun.file(path), { headers: { "cache-control": p.published ? "public, max-age=86400" : "private, no-cache", "x-content-type-options": "nosniff" } });
}

// /api/stats/playback is pinged once when playback starts: that is a view.
// watchtime pings carry the position, which history keeps for resuming,
// and the segments played, which count as watch time.
async function stats(url: URL, viewer: Viewer): Promise<Response> {
	const id = url.searchParams.get("docid") ?? "";
	if (!isVideoId(id)) return new Response(null, { status: 204 });
	if (url.pathname.endsWith("/playback")) {
		const key = `view:${id}:${viewer?.userId ?? url.searchParams.get("cpn") ?? "anon"}`;
		if (await rateLimit(key, 1, 3600)) {
			const [v] = await sql`update videos set view_count = view_count + 1 where id = ${id} returning id`;
			if (v) await recordView(id);
		}
		if (viewer) await recordWatch(viewer, id);
	} else if (url.pathname.endsWith("/watchtime")) {
		await recordWatchTime(id, playedMs(url.searchParams.get("st"), url.searchParams.get("et")));
		const cmt = Number((url.searchParams.get("cmt") ?? "0").split(",").pop());
		if (viewer && Number.isFinite(cmt)) await recordWatch(viewer, id, Math.round(cmt * 1000));
	}
	return new Response(null, { status: 204 });
}

export async function instanceRoutes(req: Request, url: URL, viewer: Viewer): Promise<Response | undefined> {
	const path = url.pathname;
	const account = await accountRoutes(req, url, viewer, safeNext(url.searchParams.get("next")));
	if (account) return account;
	const mine = (await myAccountRoutes(req, url, viewer)) ?? (await feedbackRoutes(req, url, viewer));
	if (mine) return mine;
	const gifs = await gifRoutes(req, url, viewer);
	if (gifs) return gifs;
	if (path === "/_ot/help.js") return helpScript();
	if (path.startsWith("/_ot/")) return instanceAsset(path) ?? new Response("not found", { status: 404 });
	if (path === "/logout") {
		if (req.method !== "POST" && req.method !== "GET") return new Response("method not allowed", { status: 405 });
		// GET only from this origin or Studio's (the account menu links); a
		// cross-site GET can't sign anyone out
		const site = req.headers.get("sec-fetch-site");
		const fromStudio = site === "same-site" && (req.headers.get("referer") ?? "").startsWith(`${STUDIO_ORIGIN}/`);
		if (req.method === "GET" && site && site !== "same-origin" && site !== "none" && !fromStudio) return new Response("forbidden", { status: 403 });
		const headers = new Headers({ location: "/" });
		for (const c of await destroySession(req)) headers.append("set-cookie", c);
		return new Response(null, { status: 303, headers });
	}
	if (path === "/getAccountSwitcherEndpoint") return accountSwitcher(req);
	if (path.startsWith("/ggpht/")) return ggpht(req, url, viewer);
	const postUpload = await postImageUploadRoute(req, url, viewer);
	if (postUpload) return postUpload;
	const picker = await pickerRoutes(req, url, viewer);
	if (picker) return picker;
	if (path.startsWith("/api/stats/")) return stats(url, viewer);
	if (path === "/complete/search") return suggest(url);
	if (path === "/favicon.ico") {
		const pin = loadPin();
		const p = pin && archivePath(`https://www.youtube.com/s/desktop/${pin.desktopVersion}/img/favicon.ico`);
		return p && existsSync(p) ? new Response(Bun.file(p), { headers: { "content-type": "image/x-icon" } }) : new Response(null, { status: 404 });
	}
	if (path === "/manifest.webmanifest")
		return Response.json({ name: INSTANCE_NAME, short_name: INSTANCE_NAME, start_url: "/", display: "standalone", background_color: "#ffffff", theme_color: "#ffffff", icons: [] });
	// the page registers no worker (FLAG_OVERRIDES); one left from an earlier
	// configuration unregisters itself and clears its caches
	if (path === "/sw.js" || path === "/sw.js_data")
		return new Response("self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(k=>Promise.all(k.map(n=>caches.delete(n)))).then(()=>self.registration.unregister())));", {
			headers: { "content-type": "text/javascript", "cache-control": "no-store" },
		});
	if (path === "/robots.txt") return new Response("User-agent: *\nDisallow: /youtubei/\nDisallow: /videoplayback\n", { headers: { "content-type": "text/plain" } });
	// as on youtube.com: uploading happens in Studio's upload dialog
	if (path === "/upload") return Response.redirect(viewer ? `${STUDIO_ORIGIN}/channel/${viewer.channelId}/videos/upload?d=ud` : `/signin?next=${encodeURIComponent("/upload")}`, 303);
	return adminRoutes(req, url, viewer);
}

export { esc, PUBLIC_ORIGIN };
