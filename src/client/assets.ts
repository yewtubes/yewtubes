// Serves the archived client under the instance origin.
//
//   /s/...                    www.youtube.com/s/... (desktop, player, app bundle)
//   /_up/<host>/<path>        fonts.googleapis.com, fonts.gstatic.com, www.gstatic.com
//
// JS from the app bundle and the player passes through patches.ts; the
// fonts stylesheet has its font URLs pointed at /_up/. Nothing else is
// changed.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { UPSTREAM_ASSET_FETCH } from "../config";
import { recordMiss } from "../diagnostics";
import { type PatchResult, applyPatches, patchSetHash, patchesFor } from "./patches";
import { CLIENT_DIR, PATCHED_DIR, type Pin, archivePath, closure, loadPin, loadStudioPin, modulePath, parseGraph, sha256, studioModulePath, writeArchived } from "./store";

export const UPSTREAM_HOSTS = new Set(["fonts.googleapis.com", "fonts.gstatic.com", "www.gstatic.com"]);

const MIME: Record<string, string> = {
	js: "text/javascript; charset=utf-8",
	css: "text/css; charset=utf-8",
	json: "application/json",
	svg: "image/svg+xml",
	png: "image/png",
	jpg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	ico: "image/x-icon",
	woff: "font/woff",
	woff2: "font/woff2",
	ttf: "font/ttf",
	mp3: "audio/mpeg",
	wasm: "application/wasm",
};

export const patchFailures = new Map<string, PatchResult & { asset: string }>();
const memo = new Map<string, Buffer>();

export function typeFor(url: string): string {
	const u = new URL(url);
	if (u.pathname.includes("/_/js/")) return MIME.js;
	if (u.pathname.includes("/_/ss/")) return MIME.css;
	if (u.host === "fonts.googleapis.com") return MIME.css;
	const ext = u.pathname.split(".").pop()?.toLowerCase() ?? "";
	return MIME[ext] ?? "application/octet-stream";
}

export async function original(url: string): Promise<Buffer | undefined> {
	const p = archivePath(url);
	if (existsSync(p)) return readFileSync(p);
	recordMiss(`asset ${new URL(url).host}${new URL(url).pathname.replace(/\/[0-9a-f]{8}\//, "/*/")}`, url);
	if (!UPSTREAM_ASSET_FETCH) return undefined;
	const r = await fetch(url).catch(() => undefined);
	if (!r?.ok) return undefined;
	const data = Buffer.from(await r.arrayBuffer());
	writeArchived(p, data);
	mkdirSync(CLIENT_DIR, { recursive: true });
	appendFileSync(join(CLIENT_DIR, "observed.txt"), `${url}\n`);
	return data;
}

export function patched(key: string, raw: Buffer, kind: "app" | "player" | "studio" | "other", url: string): Buffer {
	const patches = patchesFor(kind, url);
	if (!patches.length) return raw;
	const cacheKey = `${sha256(raw)}-${patchSetHash()}`;
	const hit = memo.get(cacheKey);
	if (hit) return hit;
	const file = join(PATCHED_DIR, `${cacheKey}`);
	if (existsSync(file)) {
		const b = readFileSync(file);
		memo.set(cacheKey, b);
		return b;
	}
	const { text, results } = applyPatches(raw.toString("utf8"), patches);
	for (const r of results) {
		// app patches may match in any piece; only whole-asset checks count here
		if (kind === "app" || kind === "studio") continue;
		if (r.matches !== r.expect) patchFailures.set(`${r.id}@${key}`, { ...r, asset: key });
	}
	const out = Buffer.from(text);
	mkdirSync(PATCHED_DIR, { recursive: true });
	writeFileSync(file, out);
	memo.set(cacheKey, out);
	return out;
}

const WRAP_HEAD = '"use strict";this.default_kevlar_base=this.default_kevlar_base||{};(function(_){var window=this;\n';
const WRAP_TAIL = "}).call(this,this.default_kevlar_base);\n// Google Inc.\n";

function moduleBody(name: string): string {
	const p = modulePath(name);
	if (!existsSync(p)) {
		recordMiss(`app module ${name}`, name);
		return "";
	}
	const t = readFileSync(p, "utf8");
	const start = t.indexOf(WRAP_HEAD);
	const end = t.lastIndexOf("}).call(this,this.default_kevlar_base);");
	return start === 0 && end > 0 ? t.slice(WRAP_HEAD.length, end) : "";
}

// /s/_/ytmainappweb/_/js/k=<key>/am=../d=1/exm=a,b/ed=1/br=1/rs=../m=x,y
function appJs(pin: Pin, path: string): Buffer | undefined {
	const seg = Object.fromEntries(path.split("/").filter((s) => s.includes("=")).map((s) => [s.slice(0, s.indexOf("=")), s.slice(s.indexOf("=") + 1)]));
	if (seg.k !== pin.app.key) {
		recordMiss("app bundle with another build key", path);
		return undefined;
	}
	const wanted = (seg.m ?? "").split(",").filter(Boolean);
	if (wanted.includes("kevlar_base_module")) return undefined; // the main bundle, served as a file
	const graph = parseGraph(pin.app.graph);
	const have = closure(graph, [...pin.app.initial, ...(seg.exm ?? "").split(",").filter(Boolean)]);
	const need = closure(graph, wanted);
	const order = graph.names.filter((n) => need.has(n) && !have.has(n));
	const key = `app:${order.join(",")}`;
	const hit = memo.get(key);
	if (hit) return hit;
	const raw = Buffer.from(WRAP_HEAD + order.map(moduleBody).join("") + WRAP_TAIL);
	const out = patched(key, raw, "app", path);
	memo.set(key, out);
	return out;
}

// same-origin path, so the stylesheet works on the Studio origin too
function fontCss(text: string): string {
	return text.replace(/url\(https:\/\/fonts\.gstatic\.com\//g, "url(/_up/fonts.gstatic.com/");
}

export async function serveUpstream(req: Request, url: URL): Promise<Response | undefined> {
	const host = url.pathname.split("/")[2];
	if (!UPSTREAM_HOSTS.has(host)) return new Response("not found", { status: 404 });
	const upstream = `https://${host}${url.pathname.slice(`/_up/${host}`.length)}${url.search}`;
	let body = await original(upstream);
	if (body && host === "fonts.googleapis.com") body = Buffer.from(fontCss(body.toString()));
	return assetResponse(req, body, typeFor(upstream), !url.pathname.startsWith("/_up/fonts.googleapis.com"));
}

export function assetResponse(req: Request, body: Buffer | undefined, type: string, immutable: boolean): Response {
	if (!body) return new Response("not found", { status: 404 });
	const etag = `"${Bun.hash(body).toString(36)}"`;
	const headers: Record<string, string> = { "content-type": type, etag, "cache-control": immutable ? "public, max-age=604800" : "no-cache" };
	if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
	return new Response(new Uint8Array(body), { headers });
}

export async function serveClientAsset(req: Request, url: URL): Promise<Response | undefined> {
	if (url.pathname.startsWith("/_up/")) return serveUpstream(req, url);
	if (!url.pathname.startsWith("/s/")) return undefined;
	const pin = loadPin();
	if (!pin) return new Response("client not acquired; run bun scripts/fetch-client.ts", { status: 503 });
	const upstream = `https://www.youtube.com${url.pathname}${url.search}`;
	let kind: "app" | "player" | "other" = "other";
	let body: Buffer | undefined;
	if (url.pathname.startsWith("/s/_/ytmainappweb/_/js/")) {
		kind = "app";
		body = appJs(pin, url.pathname);
		// the main bundle: whichever activation mask the page asked for, the pinned one
		if (!body && url.pathname.includes("m=kevlar_base_module")) {
			const raw = await original(pin.app.jsUrl);
			if (raw) body = patched("app:main", raw, "app", pin.app.jsUrl);
		}
	} else if (url.pathname.startsWith("/s/_/ytmainappweb/_/ss/")) {
		// ?dark: the dark compile, linked by pages rendered dark (page.ts)
		const darkPath = `${archivePath(pin.app.cssUrl)}.dark`;
		const dark = url.searchParams.has("dark") && pin.app.darkCss && existsSync(darkPath) ? readFileSync(darkPath) : undefined;
		body = dark ?? (await original(pin.app.cssUrl));
	} else {
		const raw = await original(upstream);
		if (raw && url.pathname.startsWith(`/s/player/${pin.player.id}/`) && url.pathname.endsWith(".js")) {
			kind = "player";
			body = patched(url.pathname, raw, "player", upstream);
		} else body = raw;
	}
	// upstream names are versioned, but patched output changes with the patch set
	return assetResponse(req, body, typeFor(upstream), kind === "other");
}

// verification for scripts/check-patches.ts: apply every patch to its asset
// and report counts (app patches are summed over main bundle and all modules)
export async function checkPatches(): Promise<{ id: string; matches: number; expect: number; ok: boolean }[]> {
	const pin = loadPin();
	if (!pin) throw new Error("no pin");
	type Totals = Map<string, { matches: number; expect: number }>;
	const sum = (into: Totals, rs: PatchResult[]) => {
		for (const r of rs) {
			const t = into.get(r.id) ?? { matches: 0, expect: r.expect };
			t.matches += r.matches;
			into.set(r.id, t);
		}
	};
	const totals: Totals = new Map();
	const add = (rs: PatchResult[]) => sum(totals, rs);
	const main = readFileSync(archivePath(pin.app.jsUrl), "utf8");
	add(applyPatches(main, patchesFor("app", pin.app.jsUrl)).results);
	for (const name of Object.keys(pin.app.modules)) add(applyPatches(moduleBody(name), patchesFor("app", name)).results);
	const player = readFileSync(archivePath(pin.player.jsUrl), "utf8");
	add(applyPatches(player, patchesFor("player", pin.player.jsUrl)).results);
	// YouTube Studio, when acquired: its bundle, every module, its stylesheet
	const studio = loadStudioPin();
	if (studio) {
		add(applyPatches(readFileSync(archivePath(studio.app.jsUrl), "utf8"), patchesFor("studio", studio.app.jsUrl)).results);
		for (const name of Object.keys(studio.app.modules)) add(applyPatches(readFileSync(studioModulePath(name), "utf8"), patchesFor("studio", name)).results);
		add(applyPatches(readFileSync(archivePath(studio.app.cssUrl), "utf8"), patchesFor("other", studio.app.cssUrl)).results);
	}
	const results = [...totals].map(([id, t]) => ({ id, ...t, ok: t.matches === t.expect }));
	// the dark build replaces the bundle, the stylesheet and some modules, so
	// its patches are counted on their own
	if (studio?.dark) {
		const dark: Totals = new Map();
		sum(dark, applyPatches(readFileSync(archivePath(studio.dark.jsUrl), "utf8"), patchesFor("studio", studio.dark.jsUrl)).results);
		for (const name of Object.keys(studio.app.modules))
			sum(dark, applyPatches(readFileSync(studioModulePath(name, !!studio.dark.modules[name]), "utf8"), patchesFor("studio", name)).results);
		sum(dark, applyPatches(readFileSync(archivePath(studio.dark.cssUrl), "utf8"), patchesFor("other", studio.dark.cssUrl)).results);
		for (const [id, t] of dark) results.push({ id: `${id} (dark)`, ...t, ok: t.matches === t.expect });
	}
	return results;
}
