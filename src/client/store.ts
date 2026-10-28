// Local archive of the pinned official web client.
//
// client/original/  bytes exactly as upstream served them (never modified)
// client/patched/   serve-time patch output, invalidated by patch/config hash
// pin/client.json   committed metadata: build identifiers, URLs, sha256 digests
//
// Upstream URLs map to archive paths as <host>/<path>, with a digest suffix for
// a query string, so the same URL always lands in the same file.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

export const CLIENT_DIR = process.env.CLIENT_DIR ?? "client";
export const ORIGINAL_DIR = join(CLIENT_DIR, "original");
export const PATCHED_DIR = join(CLIENT_DIR, "patched");
export const PIN_FILE = process.env.PIN_FILE ?? "pin/client.json";

export type PinnedAsset = { url: string; sha256: string; size: number; kind: string };
export type Pin = {
	fetchedAt: string;
	pageBuildLabel: string;
	clientVersion: string;
	desktopVersion: string;
	player: { id: string; jsUrl: string; cssUrl: string; version: string; modules: string[] };
	app: {
		key: string;
		jsUrl: string;
		cssUrl: string;
		// module graph string from _ModuleManager_initialize, and the modules
		// the main bundle already contains
		graph: string;
		initial: string[];
		// per-module code pieces, fetched one module at a time
		modules: Record<string, { sha256: string; size: number }>;
		// the stylesheet's dark compile (scripts/derive-dark-css.ts), archived
		// beside the light one as <cssUrl archive path>.dark, and the current
		// build's light/dark pair it was made from
		darkCss?: { from: [string, string]; sha256: string; size: number };
	};
	pages: Record<string, { url: string; sha256: string; size: number }>;
	assets: PinnedAsset[];
};

export const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

export function archivePath(url: string): string {
	const u = new URL(url);
	let p = normalize(decodeURIComponent(u.pathname)).replace(/^([/\\])+/, "");
	if (p.startsWith("..")) throw new Error(`refusing path ${url}`);
	if (p === "" || p.endsWith("/")) p += "index";
	if (u.search) p += `__q${sha256(u.search).slice(0, 16)}`;
	return join(ORIGINAL_DIR, u.host, p);
}

export function modulePath(name: string): string {
	if (!/^[\w-]+$/.test(name)) throw new Error(`bad module name ${name}`);
	return join(ORIGINAL_DIR, "modules", `${name}.js`);
}

export function pagePath(kind: string): string {
	return join(ORIGINAL_DIR, "pages", `${kind}.html`);
}

export function readArchived(url: string): Buffer | undefined {
	const p = archivePath(url);
	return existsSync(p) && statSync(p).isFile() ? readFileSync(p) : undefined;
}

export function writeArchived(path: string, data: Uint8Array) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, data);
}

let pinCache: Pin | undefined;
export function loadPin(): Pin | undefined {
	if (pinCache) return pinCache;
	if (!existsSync(PIN_FILE)) return undefined;
	pinCache = JSON.parse(readFileSync(PIN_FILE, "utf8"));
	return pinCache;
}
export function savePin(pin: Pin) {
	mkdirSync(dirname(PIN_FILE), { recursive: true });
	writeFileSync(PIN_FILE, `${JSON.stringify(pin, null, "\t")}\n`);
	pinCache = pin;
}

// _ModuleManager_initialize('name:deps/name/...') where deps are base-36
// indexes into the same list
export type ModuleGraph = { names: string[]; deps: Map<string, string[]> };
export function parseGraph(graph: string): ModuleGraph {
	const entries = graph.split("/");
	const names = entries.map((e) => e.split(":")[0]);
	const deps = new Map<string, string[]>();
	entries.forEach((e, i) => {
		const d = e.split(":")[1];
		deps.set(names[i], d ? d.split(",").map((x) => names[Number.parseInt(x, 36)]) : []);
	});
	return { names, deps };
}

export function closure(g: ModuleGraph, roots: Iterable<string>): Set<string> {
	const out = new Set<string>();
	const stack = [...roots];
	while (stack.length) {
		const m = stack.pop()!;
		if (out.has(m) || !g.deps.has(m)) continue;
		out.add(m);
		stack.push(...g.deps.get(m)!);
	}
	return out;
}

// ---- YouTube Studio (studio.youtube.com), pinned separately ----
// client/original/studio/page.html  the Studio page shell, sanitized at pin
//                                   time (no account values; see fetch-studio)
// client/original/studio-modules/   per-module pieces of the Studio app bundle
// client/original/studio/page-dark.html, studio-modules-dark/
//                                   the same for the dark theme's build

export const STUDIO_PIN_FILE = process.env.STUDIO_PIN_FILE ?? "pin/studio.json";

export type StudioPin = {
	fetchedAt: string;
	pageBuildLabel: string;
	clientVersion: string;
	// the /s/<version>/ directory of Studio's static scripts
	staticVersion: string;
	app: {
		key: string; // k= of the JS bundle
		cssKey: string; // ck= / the _/ss/ k=
		am: string;
		// the page's _F_combinedSignature, which the module server requires (rs=)
		signature: string;
		jsUrl: string;
		cssUrl: string;
		graph: string;
		initial: string[];
		modules: Record<string, { sha256: string; size: number }>;
	};
	page: { sha256: string; size: number };
	// The build YouTube serves when the account's Appearance is dark: the
	// same app compiled with another activation mask (dark palette in the
	// stylesheet and bundle), with its own page shell (<html server-dark>)
	// and signature. Modules are listed only where they differ.
	dark?: {
		am: string;
		signature: string;
		jsUrl: string;
		cssUrl: string;
		page: { sha256: string; size: number };
		modules: Record<string, { sha256: string; size: number }>;
	};
	assets: PinnedAsset[];
};

export function studioModulePath(name: string, dark = false): string {
	if (!/^[\w-]+$/.test(name)) throw new Error(`bad module name ${name}`);
	return join(ORIGINAL_DIR, dark ? "studio-modules-dark" : "studio-modules", `${name}.js`);
}

export const studioPagePath = (dark = false) => join(ORIGINAL_DIR, "studio", dark ? "page-dark.html" : "page.html");

let studioPinCache: StudioPin | undefined;
export function loadStudioPin(): StudioPin | undefined {
	if (studioPinCache) return studioPinCache;
	if (!existsSync(STUDIO_PIN_FILE)) return undefined;
	studioPinCache = JSON.parse(readFileSync(STUDIO_PIN_FILE, "utf8"));
	return studioPinCache;
}
export function saveStudioPin(pin: StudioPin) {
	mkdirSync(dirname(STUDIO_PIN_FILE), { recursive: true });
	writeFileSync(STUDIO_PIN_FILE, `${JSON.stringify(pin, null, "\t")}\n`);
	studioPinCache = pin;
}
