// The video picker behind the post composer's Video button. YouTube opens
// Google's picker (docs.google.com/picker, a Google Account service) in a
// dialog the client builds itself (Bj in the main bundle, styled by
// www-onepick.css) and talks to over gadgets.rpc (apis.google.com/js/rpc.js).
// Neither can be served here, so ytcfg ONE_PICK_URL points that dialog at
// /picker, a picker of this instance's videos with the views the client asks
// for (Video search, URL, Your YouTube videos), and the client loads
// /picker/rpc.js (patch "picker-rpc-script"), a gadgets.rpc with just the
// calls the dialog makes, carried by postMessage within this origin.
//
// The dialog's protocol: the picker calls the service named by its
// rpcService parameter with {action: "loaded"}, then {action: "picked",
// docs: [{id}]} or {action: "cancel"}; the client then asks
// backstage/get_post_video_preview for the chosen video.

import type { Viewer } from "./client/page";
import { PUBLIC_ORIGIN } from "./config";
import { channelVideos, getVideo, longVideos, searchVideos } from "./data";
import { isVideoId } from "./ids";
import { savedAppearance } from "./appearance";
import { type Video, ago, compact, duration } from "./innertube/r";

export const PICKER_PATH = "/picker";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// gadgets.rpc for the page that opens the picker: register, call, and the
// setup calls the dialog makes. A message counts only from the frame the
// service is registered for (the dialog names its iframe after it), from this
// origin, with the token the dialog put in that frame's URL.
const RPC = `(function(){
if (window.gadgets && window.gadgets.rpc) return;
var services = {}, tokens = {};
function frame(id) { var f = document.getElementById(id); return f && f.tagName === "IFRAME" ? f : null; }
function tokenOf(id) {
  var f = frame(id);
  if (!f) return null;
  try { return tokens[id] || new URL(f.src).searchParams.get("rpctoken"); } catch (e) { return null; }
}
window.addEventListener("message", function (e) {
  var m = e.data;
  if (e.origin !== location.origin || !m || m.yewtubeRpc !== 1 || typeof m.s !== "string" || !services[m.s]) return;
  var f = frame(m.s);
  if (!f || e.source !== f.contentWindow || !m.t || m.t !== tokenOf(m.s)) return;
  services[m.s].apply({ f: m.s }, Array.isArray(m.a) ? m.a : []);
});
window.gadgets = window.gadgets || {};
window.gadgets.rpc = {
  register: function (s, h) { services[s] = h; },
  unregister: function (s) { delete services[s]; },
  setAuthToken: function (id, t) { tokens[id] = t; },
  setRelayUrl: function () {},
  config: function () {},
  call: function (id, service) {
    var f = frame(id);
    if (f && f.contentWindow) f.contentWindow.postMessage({ yewtubeRpc: 1, s: service, a: [].slice.call(arguments, 3), t: tokenOf(id) }, location.origin);
  }
};
})();`;

// the picker page's own script: the views, the requests for videos, and the
// messages to the dialog
const SCRIPT = `(function(){
var q = new URLSearchParams(location.search);
var service = q.get("rpcService") || "", token = q.get("rpctoken") || "";
function send(m) { if (parent !== window) parent.postMessage({ yewtubeRpc: 1, s: service, a: [m], t: token }, location.origin); }
var selected = null, view = "search", seq = 0;
var $ = function (s) { return document.querySelector(s); };
var select = $("#select"), list = $("#list"), status = $("#status");
function setSelected(id, el) {
  selected = id;
  document.querySelectorAll(".video[aria-selected=true]").forEach(function (v) { v.setAttribute("aria-selected", "false"); });
  if (el) el.setAttribute("aria-selected", "true");
  select.disabled = !id;
}
function card(v) {
  var b = document.createElement("button");
  b.type = "button"; b.className = "video"; b.setAttribute("role", "option"); b.setAttribute("aria-selected", "false");
  var img = document.createElement("span"); img.className = "thumb";
  var i = document.createElement("img"); i.src = "/vi/" + v.id + "/mqdefault.jpg"; i.alt = ""; i.loading = "lazy"; img.appendChild(i);
  if (v.duration) { var d = document.createElement("span"); d.className = "dur"; d.textContent = v.duration; img.appendChild(d); }
  var t = document.createElement("span"); t.className = "title"; t.textContent = v.title;
  var m = document.createElement("span"); m.className = "meta"; m.textContent = v.meta;
  b.append(img, t, m);
  b.addEventListener("click", function () { setSelected(v.id, b); });
  b.addEventListener("dblclick", function () { setSelected(v.id, b); pick(); });
  return b;
}
function load(params) {
  var n = ++seq;
  setSelected(null);
  list.replaceChildren();
  status.textContent = "Loading...";
  fetch("${PICKER_PATH}/videos?" + new URLSearchParams(params), { credentials: "same-origin" }).then(function (r) { return r.json(); }).then(function (d) {
    if (n !== seq) return;
    status.textContent = d.message || "";
    d.videos.forEach(function (v) { list.appendChild(card(v)); });
    if (params.view === "url" && d.videos.length === 1) setSelected(d.videos[0].id, list.firstChild);
  }).catch(function () { if (n === seq) status.textContent = "Videos couldn't be loaded. Try again."; });
}
function show(name) {
  view = name;
  document.querySelectorAll("[role=tab]").forEach(function (t) { t.setAttribute("aria-selected", String(t.dataset.view === name)); });
  $("#search-form").hidden = name !== "search";
  $("#url-form").hidden = name !== "url";
  if (name === "search") { load({ view: "search", q: $("#q").value }); $("#q").focus(); }
  else if (name === "url") { list.replaceChildren(); status.textContent = ""; setSelected(null); $("#url").focus(); }
  else load({ view: "own" });
}
function pick() { if (selected) send({ action: "picked", docs: [{ id: selected, serviceId: "youtube" }] }); }
function cancel() { send({ action: "cancel" }); }
document.querySelectorAll("[role=tab]").forEach(function (t) { t.addEventListener("click", function () { show(t.dataset.view); }); });
$("#search-form").addEventListener("submit", function (e) { e.preventDefault(); load({ view: "search", q: $("#q").value }); });
$("#url-form").addEventListener("submit", function (e) { e.preventDefault(); load({ view: "url", q: $("#url").value }); });
select.addEventListener("click", pick);
$("#cancel").addEventListener("click", cancel);
$("#close").addEventListener("click", cancel);
document.addEventListener("keydown", function (e) { if (e.key === "Escape") cancel(); });
show("search");
send({ action: "loaded" });
})();`;

const CSS = `
@font-face{font-family:Roboto;font-weight:400;font-display:swap;src:url(/_ot/fonts/roboto-latin-400-normal.woff2) format("woff2")}
@font-face{font-family:Roboto;font-weight:500;font-display:swap;src:url(/_ot/fonts/roboto-latin-500-normal.woff2) format("woff2")}
:root{color-scheme:light;--bg:#fff;--fg:#0f0f0f;--muted:#606060;--line:#e5e5e5;--soft:#f2f2f2;--hover:#e5e5e5;--accent:#065fd4;--sel:#def1ff;--btn:#065fd4;--on-btn:#fff}
:root[data-theme=dark]{color-scheme:dark;--bg:#212121;--fg:#f1f1f1;--muted:#aaa;--line:#3f3f3f;--soft:#272727;--hover:#3f3f3f;--accent:#3ea6ff;--sel:#263850;--btn:#3ea6ff;--on-btn:#0f0f0f}
@media (prefers-color-scheme:dark){:root[data-theme=device]{color-scheme:dark;--bg:#212121;--fg:#f1f1f1;--muted:#aaa;--line:#3f3f3f;--soft:#272727;--hover:#3f3f3f;--accent:#3ea6ff;--sel:#263850;--btn:#3ea6ff;--on-btn:#0f0f0f}}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;display:flex;flex-direction:column;background:var(--bg);color:var(--fg);font:14px/20px Roboto,Arial,sans-serif}
header{display:flex;align-items:center;gap:8px;padding:16px 16px 0 24px}
h1{flex:1;margin:0;font-size:20px;line-height:28px;font-weight:400}
.icon{width:40px;height:40px;padding:8px;border:0;border-radius:50%;background:none;color:inherit;cursor:pointer}
.icon:hover{background:var(--hover)}
.icon svg{display:block;width:24px;height:24px;fill:currentColor}
nav{display:flex;gap:4px;padding:8px 16px 0;border-bottom:1px solid var(--line);overflow-x:auto}
[role=tab]{flex:none;height:40px;padding:0 16px;border:0;border-bottom:2px solid transparent;background:none;color:var(--muted);font:500 14px Roboto,Arial,sans-serif;cursor:pointer}
[role=tab][aria-selected=true]{color:var(--fg);border-bottom-color:var(--fg)}
form{display:flex;gap:8px;padding:16px 24px 0}
form[hidden]{display:none}
input{flex:1;min-width:0;height:40px;padding:0 16px;border:1px solid var(--line);border-radius:20px;background:transparent;color:inherit;font:inherit}
input:focus{outline:2px solid var(--accent);outline-offset:-1px}
form button,footer button{flex:none;height:36px;padding:0 16px;border:0;border-radius:18px;background:var(--soft);color:var(--fg);font:500 14px Roboto,Arial,sans-serif;cursor:pointer;align-self:center}
footer button.primary{background:var(--btn);color:var(--on-btn)}
footer button:disabled{opacity:.4;cursor:default}
main{flex:1;overflow:auto;padding:8px 16px 16px}
#status{margin:8px 8px 0;color:var(--muted)}
#status:empty{display:none}
#list{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px}
.video{display:flex;flex-direction:column;gap:4px;padding:8px;border:0;border-radius:12px;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}
.video:hover{background:var(--soft)}
.video[aria-selected=true]{background:var(--sel);outline:2px solid var(--accent);outline-offset:-2px}
.thumb{position:relative;display:block;aspect-ratio:16/9;border-radius:8px;overflow:hidden;background:var(--soft)}
.thumb img{width:100%;height:100%;object-fit:cover;display:block}
.dur{position:absolute;right:4px;bottom:4px;padding:1px 4px;border-radius:4px;background:rgba(0,0,0,.8);color:#fff;font-size:12px;line-height:18px;font-weight:500}
.title{font-weight:500;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.meta{color:var(--muted);font-size:12px;line-height:18px}
footer{display:flex;justify-content:flex-end;gap:8px;padding:12px 24px;border-top:1px solid var(--line)}
@media (max-width:480px){header{padding-left:16px}form{padding:12px 16px 0}#list{grid-template-columns:1fr 1fr}footer{padding:12px 16px}}
`;

const CLOSE = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12.71 12 8.15 8.15-.71.71L12 12.71l-8.15 8.15-.71-.71L11.29 12 3.15 3.85l.71-.71L12 11.29l8.15-8.15.71.71L12.71 12z"/></svg>`;

function pickerPage(req: Request, url: URL, viewer: Viewer): Response {
	const title = url.searchParams.get("title") || "Select a video";
	// the views the client asked for (the composer's hideYourYoutubeVideos leaves out "youtube")
	const nav = url.searchParams.get("nav") ?? "";
	const own = !!viewer && /\(\s*"youtube"/.test(nav);
	const tab = (view: string, label: string) => `<button type="button" role="tab" data-view="${view}" aria-selected="false">${label}</button>`;
	const body = `<header><h1>${esc(title)}</h1><button type="button" class="icon" id="close" aria-label="Close">${CLOSE}</button></header>
<nav role="tablist">${tab("search", "Video search")}${tab("url", "URL")}${own ? tab("own", "Your YouTube videos") : ""}</nav>
<form id="search-form" role="search"><input id="q" type="search" placeholder="Search videos" aria-label="Search videos" autocomplete="off"><button>Search</button></form>
<form id="url-form" hidden><input id="url" type="url" placeholder="Paste a video URL" aria-label="Video URL" autocomplete="off"><button>Add</button></form>
<main><p id="status" role="status"></p><div id="list" role="listbox" aria-label="Videos"></div></main>
<footer><button type="button" class="primary" id="select" disabled>Select</button><button type="button" id="cancel">Cancel</button></footer>`;
	return new Response(
		`<!doctype html><html lang="en" data-theme="${savedAppearance(req)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style></head><body>${body}<script src="${PICKER_PATH}/picker.js"></script></body></html>`,
		{
			headers: {
				"content-type": "text/html; charset=utf-8",
				"cache-control": "no-store",
				"content-security-policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
				"referrer-policy": "same-origin",
				vary: "Cookie",
			},
		},
	);
}

// a video id from what was pasted: a watch, Shorts, live or youtu.be-style URL, or the id itself
export function videoIdFrom(text: string): string | undefined {
	const s = text.trim();
	if (isVideoId(s)) return s;
	let u: URL;
	try {
		u = new URL(s, PUBLIC_ORIGIN);
	} catch {
		return undefined;
	}
	const v = u.searchParams.get("v");
	if (u.pathname === "/watch" && isVideoId(v)) return v;
	const m = /^\/(?:shorts\/|live\/|embed\/|v\/)?([A-Za-z0-9_-]{11})\/?$/.exec(u.pathname);
	return m?.[1];
}

const attachable = (v: Video) => v.playable && v.visibility !== "private";
const item = (v: Video) => ({ id: v.id, title: v.title, duration: v.duration_ms ? duration(v.duration_ms) : "", meta: `${v.channel_title} · ${compact(v.view_count)} ${v.view_count === 1 ? "view" : "views"} · ${ago(v.published_at ?? v.created_at)}` });

async function pickerVideos(url: URL, viewer: Viewer): Promise<Response> {
	const view = url.searchParams.get("view");
	const q = (url.searchParams.get("q") ?? "").slice(0, 500);
	const reply = (videos: Video[], message = "") => Response.json({ videos: videos.filter(attachable).map(item), message }, { headers: { "cache-control": "no-store" } });
	if (view === "own") {
		if (!viewer) return reply([], "Sign in to see your videos.");
		const videos = await channelVideos(viewer.channelId, viewer, 60, 0);
		return reply(videos, videos.some(attachable) ? "" : "You haven't uploaded any videos yet.");
	}
	if (view === "url") {
		const id = videoIdFrom(q);
		const v = id ? await getVideo(id, viewer) : undefined;
		return v && attachable(v) ? reply([v]) : reply([], "That video isn't available. Check the URL.");
	}
	const videos = q.trim() ? await searchVideos(q.trim(), 48, 0) : await longVideos(48, 0, "recent", viewer);
	return reply(videos, videos.some(attachable) ? "" : "No results found. Try different keywords.");
}

export async function pickerRoutes(req: Request, url: URL, viewer: Viewer): Promise<Response | undefined> {
	const path = url.pathname;
	if (path !== PICKER_PATH && !path.startsWith(`${PICKER_PATH}/`)) return undefined;
	if (req.method !== "GET" && req.method !== "HEAD") return new Response("method not allowed", { status: 405 });
	const script = (js: string) => new Response(js, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache", "x-content-type-options": "nosniff" } });
	if (path === PICKER_PATH) return pickerPage(req, url, viewer);
	if (path === `${PICKER_PATH}/rpc.js`) return script(RPC);
	if (path === `${PICKER_PATH}/picker.js`) return script(SCRIPT);
	if (path === `${PICKER_PATH}/videos`) return pickerVideos(url, viewer);
	return new Response("not found", { status: 404 });
}
