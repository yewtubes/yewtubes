// /myaccount: the local account's own page, where the account menu's
// "<instance> account" and "Your data in YouTube" entries and the settings
// pages' account rows lead (in place of Google Account). It is this
// instance's page, not YouTube's, so it says plainly that the account is
// local: your info, password, the sessions signed in to the account, what
// the instance stores for it, and deleting it.
//
// Changes are same-origin POSTs carrying the session's API secret as a form
// token; each ends in a redirect back to the page with a `done` code.

import { timingSafeEqual } from "node:crypto";
import { activityAction, activityPage } from "./activity";
import { savedAppearance } from "./appearance";
import { endSession, forgetSession, parseCookies, signedOutCookies, switchSession } from "./auth";
import type { Viewer } from "./client/page";
import { INSTANCE_NAME, PUBLIC_ORIGIN, STUDIO_ORIGIN } from "./config";
import { sql } from "./db";
import { avatarUrl } from "./innertube/r";
import { deleteMedia } from "./media/process";
import { rateLimit } from "./ratelimit";

export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const DONE: Record<string, [string, boolean?]> = {
	password: ["Password changed. Your other sessions were signed out."],
	"signed-out": ["That session was signed out."],
	"signed-out-others": ["Your other sessions were signed out."],
	"wrong-password": ["Wrong password.", true],
	"short-password": ["Use 8 characters or more for your new password.", true],
	mismatch: ["Those passwords didn't match.", true],
	"last-operator": ["You're this instance's only operator. Make another account an operator in the admin panel first.", true],
	"confirm-delete": ["Tick the box to confirm that you want to delete your account.", true],
	"too-many": ["Too many attempts. Try again in a few minutes.", true],
};

const CSS = `
@font-face{font-family:Roboto;font-weight:400;font-display:swap;src:url(/_ot/fonts/roboto-latin-400-normal.woff2) format("woff2")}
@font-face{font-family:Roboto;font-weight:500;font-display:swap;src:url(/_ot/fonts/roboto-latin-500-normal.woff2) format("woff2")}
:root{color-scheme:light;--bg:#fff;--fg:#0f0f0f;--muted:#606060;--line:#e5e5e5;--card:#fff;--accent:#065fd4;--btn:#0f0f0f;--on-btn:#fff;--soft:#f2f2f2;--err:#cc0000;--ok:#2ba640}
:root[data-theme=dark]{color-scheme:dark;--bg:#0f0f0f;--fg:#f1f1f1;--muted:#aaa;--line:#3f3f3f;--card:#212121;--accent:#3ea6ff;--btn:#f1f1f1;--on-btn:#0f0f0f;--soft:#272727;--err:#ff4e45;--ok:#41b65a}
@media (prefers-color-scheme:dark){:root[data-theme=device]{color-scheme:dark;--bg:#0f0f0f;--fg:#f1f1f1;--muted:#aaa;--line:#3f3f3f;--card:#212121;--accent:#3ea6ff;--btn:#f1f1f1;--on-btn:#0f0f0f;--soft:#272727;--err:#ff4e45;--ok:#41b65a}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/20px Roboto,Arial,sans-serif}
header{display:flex;align-items:center;gap:12px;height:56px;padding:0 16px;border-bottom:1px solid var(--line)}
header img{width:32px;height:32px;border-radius:6px}
header a{color:inherit;text-decoration:none;font-size:18px;font-weight:500}
header .back{margin-left:auto;font-size:14px;color:var(--accent)}
main{max-width:720px;margin:0 auto;padding:24px 16px 64px}
.hero{text-align:center;margin:8px 0 24px}
.hero img{width:88px;height:88px;border-radius:50%}
h1{font-size:28px;line-height:36px;font-weight:400;margin:12px 0 4px}
.hero p{margin:0;color:var(--muted)}
section{border:1px solid var(--line);border-radius:12px;padding:20px 24px;margin:16px 0;background:var(--card)}
h2{font-size:20px;line-height:28px;font-weight:400;margin:0 0 4px}
.sub{color:var(--muted);margin:0 0 16px}
dl{display:grid;grid-template-columns:160px 1fr;gap:12px 16px;margin:0}
dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere}
a{color:var(--accent)}
label{display:block;font-weight:500;margin:12px 0 4px}
textarea{width:100%;min-height:160px;padding:8px 12px;border:1px solid var(--line);border-radius:8px;background:transparent;color:inherit;font:inherit;resize:vertical}
input[type=password]{width:100%;max-width:360px;height:40px;padding:8px 12px;border:1px solid var(--line);border-radius:8px;background:transparent;color:inherit;font:inherit}
input[type=password]:focus{outline:2px solid var(--accent);outline-offset:-1px}
.check{display:flex;gap:8px;align-items:flex-start;font-weight:400}
button{white-space:nowrap;height:36px;padding:0 16px;margin-top:16px;border:0;border-radius:18px;background:var(--btn);color:var(--on-btn);font:500 14px Roboto,Arial,sans-serif;cursor:pointer}
button.quiet{background:var(--soft);color:var(--fg);margin:0}
button.danger{background:var(--err);color:#fff}
.table{overflow-x:auto}
table{border-collapse:collapse;width:100%;min-width:520px}
th,td{text-align:left;padding:10px 8px;border-bottom:1px solid var(--line);vertical-align:middle}
th{font-weight:500;color:var(--muted)}
.tag{display:inline-block;padding:0 8px;border-radius:10px;background:var(--soft);font-size:12px}
.counts{display:grid;grid-template-columns:repeat(3,1fr);gap:24px}
.counts a{display:block;padding:12px;border-radius:8px;background:var(--soft);color:inherit;text-decoration:none}
.counts b{display:block;font-size:22px;line-height:28px;font-weight:500}
.notice{padding:12px 16px;border-radius:8px;margin:0 0 16px;background:var(--soft)}
.notice.bad{color:var(--err)}
.tabs{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 8px}
.tabs a,.tabs b{padding:6px 12px;border-radius:8px;background:var(--soft);color:inherit;text-decoration:none;font-weight:500}
.tabs b{background:var(--btn);color:var(--on-btn)}
@media (max-width:600px){dl{grid-template-columns:1fr;gap:2px}dd{margin-bottom:12px}.counts{grid-template-columns:repeat(2,1fr);gap:12px}section{padding:16px}}
`;

// the instance's own pages outside the client (this one, /feedback), in
// the viewer's saved Appearance
export function localPage(req: Request, title: string, body: string, status = 200) {
	const theme = savedAppearance(req);
	return new Response(
		`<!doctype html><html lang="en" data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style></head><body>${body}</body></html>`,
		{
			status,
			headers: {
				"content-type": "text/html; charset=utf-8",
				"cache-control": "no-store",
				"content-security-policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'none'; img-src 'self' data:; font-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
				"x-frame-options": "DENY",
				"referrer-policy": "same-origin",
				vary: "Cookie",
			},
		},
	);
}

// a short device name from a user agent
function device(ua: string | null): string {
	if (!ua) return "Unknown device";
	const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
	const os = /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Mac OS X/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "";
	return os ? `${browser} on ${os}` : browser;
}
export const when = (d: Date | null) => (d ? new Date(d).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) + " UTC" : "");

export const header = (title: string, href: string) => `<header><img src="/_ot/yewtube-logo-96.png" alt=""><a href="${esc(href)}">${esc(title)}</a><a class="back" href="/">Back to ${esc(INSTANCE_NAME)}</a></header>`;

export const form = (viewer: NonNullable<Viewer>, action: string, inner: string, attrs = "") =>
	`<form method="post" action="${action}"${attrs}><input type="hidden" name="token" value="${esc(viewer.apiSecret)}">${inner}</form>`;

async function accountPage(req: Request, url: URL, viewer: NonNullable<Viewer>) {
	const [u] = await sql`select login, created_at, is_admin from users where id = ${viewer.userId}`;
	const sessions = await sql`select id, user_agent, created_at, last_seen_at from sessions where user_id = ${viewer.userId} and expires_at > now() order by last_seen_at desc nulls last`;
	const [n] = await sql`select
		(select count(*)::int from videos where channel_id = ${viewer.channelId} and deleted_at is null) as videos,
		(select count(*)::int from playlists where user_id = ${viewer.userId} and kind = 'user') as playlists,
		(select count(*)::int from comments where author_channel_id = ${viewer.channelId}) as comments,
		(select count(*)::int from subscriptions where user_id = ${viewer.userId}) as subscriptions,
		(select count(*)::int from watch_history where user_id = ${viewer.userId}) as history,
		(select count(*)::int from video_reactions where user_id = ${viewer.userId} and kind = 'like') as likes`;
	const done = DONE[url.searchParams.get("done") ?? ""];
	const current = parseCookies(req).OT_SID;
	const rows = sessions
		.map((s: any) => {
			const here = s.id === current;
			return `<tr><td>${esc(device(s.user_agent))}${here ? ` <span class="tag">This browser</span>` : ""}</td><td>${esc(when(s.created_at))}</td><td>${esc(when(s.last_seen_at))}</td><td>${here ? "" : form(viewer, "/myaccount/sessions/end", `<input type="hidden" name="session" value="${esc(s.id)}"><button class="quiet">Sign out</button>`)}</td></tr>`;
		})
		.join("");
	const count = (v: number, label: string, href: string) => `<a href="${esc(href)}"><b>${v.toLocaleString("en-US")}</b>${esc(label)}</a>`;
	const body = `${header(`${INSTANCE_NAME} account`, "/myaccount")}
<main>
<div class="hero"><img src="${esc(avatarUrl(viewer.channelId, 176))}" alt=""><h1>${esc(viewer.title)}</h1><p>A local account on ${esc(INSTANCE_NAME)}, not a Google Account</p></div>
${done ? `<p class="notice${done[1] ? " bad" : ""}" role="status">${esc(done[0])}</p>` : ""}
<section><h2>Your info</h2><p class="sub">Your name and handle are your channel's; change them in YouTube Studio.</p>
<dl><dt>Name</dt><dd>${esc(viewer.title)} · <a href="${esc(`${STUDIO_ORIGIN}/channel/${viewer.channelId}/editing/profile`)}">Edit in Studio</a></dd>
<dt>Handle</dt><dd><a href="/@${esc(viewer.handle)}">@${esc(viewer.handle)}</a></dd>
<dt>Username</dt><dd>${esc(u.login)} (what you sign in with)</dd>
<dt>Account type</dt><dd>${u.is_admin ? "Operator of this instance" : "Member"}</dd>
<dt>Created</dt><dd>${esc(when(u.created_at))}</dd></dl></section>
<section><h2>Password</h2><p class="sub">Changing your password signs out your other sessions.</p>
${form(viewer, "/myaccount/password", `<label for="cur">Current password</label><input id="cur" name="current" type="password" autocomplete="current-password" required>
<label for="new">New password</label><input id="new" name="password" type="password" autocomplete="new-password" minlength="8" required>
<label for="conf">Confirm new password</label><input id="conf" name="confirm" type="password" autocomplete="new-password" minlength="8" required>
<button>Change password</button>`)}</section>
<section><h2>Your sessions</h2><p class="sub">Where you're signed in to this account.</p>
<div class="table"><table><thead><tr><th>Device</th><th>Signed in</th><th>Last active</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
${sessions.length > 1 ? form(viewer, "/myaccount/sessions/end-others", `<button class="quiet" style="margin-top:16px">Sign out of all other sessions</button>`) : ""}</section>
<section id="your-data"><h2>Your data on ${esc(INSTANCE_NAME)}</h2><p class="sub">What this instance keeps for your account. Each opens where you can review or remove it.</p>
<div class="counts">${count(n.videos, "Videos", `${STUDIO_ORIGIN}/channel/${viewer.channelId}/videos`)}${count(n.playlists, "Playlists", "/feed/playlists")}${count(n.comments, "Comments", "/myaccount/activity/comments")}${count(n.subscriptions, "Subscriptions", "/feed/channels")}${count(n.history, "Watch history", "/feed/history")}${count(n.likes, "Liked videos", "/playlist?list=LL")}</div></section>
<section id="delete"><h2>Delete your account</h2><p class="sub">Deletes your account and channel from ${esc(INSTANCE_NAME)}: your videos, playlists, comments, subscriptions and history. This can't be undone.</p>
${form(viewer, "/myaccount/delete", `<label for="delpw">Password</label><input id="delpw" name="password" type="password" autocomplete="current-password" required>
<label class="check"><input type="checkbox" name="confirm" value="yes" required> I understand that my account and everything in it will be deleted</label>
<button class="danger">Delete account</button>`)}</section>
</main>`;
	return localPage(req, `${INSTANCE_NAME} account`, body);
}

function sameToken(a: string, b: string) {
	const x = Buffer.from(a);
	const y = Buffer.from(b);
	return x.length === y.length && timingSafeEqual(x, y);
}

const back = (done: string, hash = "") => new Response(null, { status: 303, headers: { location: `/myaccount?done=${done}${hash}` } });

async function checkPassword(userId: string, password: string): Promise<boolean> {
	const [u] = await sql`select password_hash from users where id = ${userId}`;
	return !!u && (await Bun.password.verify(password, u.password_hash).catch(() => false));
}

export async function myAccountRoutes(req: Request, url: URL, viewer: Viewer): Promise<Response | undefined> {
	const path = url.pathname;
	if (path !== "/myaccount" && !path.startsWith("/myaccount/")) return undefined;
	if (!viewer) return req.method === "GET" ? Response.redirect(`/signin?next=${encodeURIComponent(path + url.search)}`, 302) : new Response("forbidden", { status: 403 });
	if (req.method === "GET") {
		if (path === "/myaccount") return accountPage(req, url, viewer);
		if (path === "/myaccount/activity" || path.startsWith("/myaccount/activity/")) return activityPage(req, url, viewer, path.slice("/myaccount/activity".length));
		return new Response("not found", { status: 404 });
	}
	if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
	// forms from this origin's own page only
	const origin = req.headers.get("origin");
	if (origin && origin !== url.origin && origin !== PUBLIC_ORIGIN) return new Response("forbidden", { status: 403 });
	const site = req.headers.get("sec-fetch-site");
	if (site && site !== "same-origin") return new Response("forbidden", { status: 403 });
	const f = await req.formData().catch(() => undefined);
	const get = (k: string) => String(f?.get(k) ?? "");
	if (!sameToken(get("token"), viewer.apiSecret)) return new Response("forbidden", { status: 403 });

	const activity = await activityAction(path, get, viewer);
	if (activity) return activity;
	if (path === "/myaccount/sessions/end") {
		const sid = get("session");
		const [s] = await sql`select id from sessions where id = ${sid} and user_id = ${viewer.userId}`;
		if (s && sid !== viewer.sessionId) await endSession(sid);
		return back("signed-out");
	}
	if (path === "/myaccount/sessions/end-others") {
		const gone = await sql`delete from sessions where user_id = ${viewer.userId} and id <> ${viewer.sessionId} returning id`;
		for (const { id } of gone) forgetSession(id);
		return back("signed-out-others");
	}
	const limited = !(await rateLimit(`auth:account:${viewer.userId}`, 10, 600));
	if (path === "/myaccount/password") {
		if (limited) return back("too-many");
		if (!(await checkPassword(viewer.userId, get("current")))) return back("wrong-password");
		const pw = get("password");
		if (pw.length < 8 || pw.length > 200) return back("short-password");
		if (pw !== get("confirm")) return back("mismatch");
		await sql`update users set password_hash = ${await Bun.password.hash(pw, { algorithm: "argon2id" })} where id = ${viewer.userId}`;
		const gone = await sql`delete from sessions where user_id = ${viewer.userId} and id <> ${viewer.sessionId} returning id`;
		for (const { id } of gone) forgetSession(id);
		return back("password");
	}
	if (path === "/myaccount/delete") {
		if (limited) return back("too-many", "#delete");
		if (get("confirm") !== "yes") return back("confirm-delete", "#delete");
		if (!(await checkPassword(viewer.userId, get("password")))) return back("wrong-password", "#delete");
		const [{ others }] = await sql`select count(*)::int as others from users where is_admin and disabled_at is null and id <> ${viewer.userId}`;
		const [me] = await sql`select is_admin from users where id = ${viewer.userId}`;
		if (me?.is_admin && !others) return back("last-operator", "#delete");
		const videos = await sql`select id from videos where channel_id = ${viewer.channelId}`;
		await sql`delete from users where id = ${viewer.userId}`;
		forgetSession(viewer.sessionId);
		for (const { id } of videos) deleteMedia(id);
		// another account signed in on this browser becomes the active one
		const cookies = (await switchSession(req, 0)) ?? signedOutCookies();
		const headers = new Headers({ location: "/" });
		for (const c of cookies) headers.append("set-cookie", c);
		return new Response(null, { status: 303, headers });
	}
	return new Response("not found", { status: 404 });
}
