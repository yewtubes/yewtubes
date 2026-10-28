// Renders the official app page for a route, from the pinned page HTML of
// the matching kind. The markup, inline bootstrap scripts and skeletons stay
// as upstream served them; these parts are replaced, each by a rule that must
// match exactly once (or `optional`):
//   - the ytcfg.set({...}) bootstrap configuration      -> buildYtcfg()
//   - var ytInitialData / ytInitialPlayerResponse        -> this instance's data
//   - var ytInitialReelWatchSequenceResponse (Shorts)    -> this instance's sequence
//   - window.ytAtN({...}) BotGuard attestation challenge -> removed
//   - serverContract() ytPageType/ytCommand/ytUrl        -> this route
//   - the passive Google sign-in iframe                  -> removed
//   - preload/preconnect hints to googlevideo/i.ytimg    -> removed
//   - absolute www.youtube.com/s/ and fonts.googleapis.com URLs -> this origin
// ytcfg comes from the pinned watch page for every kind, so all pages run
// the same experiment set and the same player.

import { existsSync, readFileSync } from "node:fs";
import { prefCookieDomain } from "../appearance";
import { INSTANCE_NAME, PUBLIC_ORIGIN } from "../config";
import { recordMiss } from "../diagnostics";
import { GIFS_ENABLED } from "../gifs";
import { jsonEnd } from "./json";
import { loadPin, pagePath } from "./store";

export type PageKind = "watch" | "home" | "results" | "channel" | "playlist" | "shorts" | "settings";

export const ROOT_VE: Record<PageKind, number> = { watch: 3832, home: 3854, results: 4724, channel: 3611, playlist: 5754, shorts: 37414, settings: 23462 };
const PAGE_TYPE: Record<PageKind, string> = { watch: "watch", home: "browse", results: "search", channel: "channel", playlist: "playlist", shorts: "shorts", settings: "settings" };
const COLD_FLAG: Partial<Record<PageKind, string>> = { watch: "IS_WATCH_PAGE_COLD", home: "IS_HOMEPAGE_COLD", results: "IS_RESULTS_PAGE_COLD", shorts: "IS_SHORTS_PAGE_COLD" };

export type Viewer = {
	userId: string;
	channelId: string;
	handle: string;
	title: string;
	apiSecret: string;
	sessionId: string;
	isAdmin: boolean;
	premium: boolean; // shows the YouTube Premium logo (an operator's mark, see migrations/006_marks.sql)
} | null;

export type PageData = {
	kind: PageKind;
	url: string; // path + query of this page, e.g. /watch?v=x
	title: string;
	description?: string;
	initialData: unknown;
	playerResponse?: unknown;
	command: unknown; // the navigation endpoint that leads here
	thumbnail?: string;
	reelSequence?: unknown; // a Short's page: the Shorts that follow (ytInitialReelWatchSequenceResponse)
};

// experiment flags this instance sets over the pinned build's values
export const FLAG_OVERRIDES: Record<string, unknown> = {
	// The page installs a service worker for offline app-shell caching and
	// push. A worker that outlives a client upgrade would keep serving old
	// bundles; this instance serves none, see docs/architecture.md.
	service_worker_enabled: false,
	kevlar_appshell_service_worker: false,
	service_worker_push_enabled: false,
	service_worker_push_home_page_prompt: false,
	service_worker_push_watch_page_prompt: false,
	// no ads are served; keep the ad modules from waiting on ad responses
	web_player_ads_control_config: false,
	// the advertising id (googleads.g.doubleclick.net/pagead/id)
	disable_biscotti_fetch_entirely_for_all_web_clients: true,
	// Chromecast: the cast_sender.js bootstrap from www.gstatic.com
	mdx_load_cast_api_bootstrap_script: false,
	// search suggestions from this origin's /complete/search
	use_url_origin_for_desktop_web_suggest_requests: true,
};

// flags in the player's own serialized flag string
export const PLAYER_FLAG_OVERRIDES: Record<string, string> = {
	// With UMP on, the player asks googlevideo for range responses wrapped in
	// UMP parts (ump=1). Off, it takes the plain bytes of the range, which is
	// what /videoplayback serves.
	html5_use_ump: "false",
	// Proof-of-origin tokens come from BotGuard, which this instance doesn't
	// load; without these the player stops minting placeholder tokens (pot=).
	html5_generate_content_po_token: "false",
	html5_generate_session_po_token: "false",
	html5_non_onesie_attach_po_token: "false",
	html5_bandaid_attach_content_po_token: "false",
	html5_attach_po_token_to_bandaid: "false",
};

let base: { cfg: Record<string, any>; ytcfgJson: string } | undefined;
function baseConfig() {
	if (base) return base;
	const html = readFileSync(pagePath("watch"), "utf8");
	const start = html.indexOf("ytcfg.set({") + "ytcfg.set(".length;
	const json = html.slice(start, jsonEnd(html, start));
	base = { cfg: JSON.parse(json), ytcfgJson: json };
	return base;
}

// string values in config that address youtube.com; they become this origin
function rehost(v: unknown): unknown {
	if (typeof v === "string") {
		if (v.startsWith("https://www.youtube.com/")) return PUBLIC_ORIGIN + v.slice("https://www.youtube.com".length);
		return v;
	}
	if (Array.isArray(v)) return v.map(rehost);
	if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, rehost(x)]));
	return v;
}

function serializedFlags(s: string, overrides: Record<string, unknown>): string {
	const params = new URLSearchParams(s);
	for (const [k, v] of Object.entries(overrides)) params.set(k, String(v));
	return params.toString();
}

export function visitorData(): string {
	return "Cgt" + Buffer.from(INSTANCE_NAME).toString("base64url");
}

export function buildYtcfg(kind: PageKind, viewer: Viewer, pageUrl: string, nonce: string, dark = false): Record<string, any> {
	const pin = loadPin()!;
	const cfg = structuredClone(baseConfig().cfg);
	for (const k of ["IS_WATCH_PAGE_COLD", "IS_HOMEPAGE_COLD", "IS_RESULTS_PAGE_COLD", "IS_SHORTS_PAGE_COLD"]) delete cfg[k];
	const cold = COLD_FLAG[kind];
	if (cold) cfg[cold] = true;
	cfg.ROOT_VE_TYPE = ROOT_VE[kind];
	// account and request specifics: ours, never the capture's
	const visitor = visitorData();
	cfg.VISITOR_DATA = visitor;
	cfg.EVENT_ID = Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString("base64url");
	cfg.TIME_CREATED_MS = Date.now();
	cfg.XSRF_TOKEN = viewer ? viewer.apiSecret : "";
	cfg.LOGGED_IN = !!viewer;
	cfg.DATASYNC_ID = viewer ? `${viewer.channelId}||` : `${visitor}||`;
	if (viewer) {
		cfg.DELEGATED_SESSION_ID = undefined;
		cfg.SESSION_INDEX = "0";
		cfg.ID_TOKEN = undefined;
	}
	cfg.SIGNIN_URL = `${PUBLIC_ORIGIN}/signin?next=${encodeURIComponent(pageUrl)}`;
	cfg.INNERTUBE_API_KEY = "AIzaSyYewTubeLocalInstanceKeyNotGoogle01";
	for (const k of ["LINK_API_KEY", "LINK_API_KEY_REDIRECT", "VOZ_API_KEY", "RECAPTCHA_V3_SITEKEY", "GAPI_HINT_PARAMS", "GAPI_HOST", "YPC_MB_URL", "LINK_GAL_DOMAIN", "LINK_OIS_DOMAIN", "PERSIST_IDENTITY_IFRAME_URL", "YTR_FAMILY_CREATION_URL", "LIVE_CHAT_BASE_TANGO_CONFIG"]) delete cfg[k];
	const client = cfg.INNERTUBE_CONTEXT.client;
	delete client.remoteHost;
	delete client.configInfo;
	delete client.deviceExperimentId;
	delete client.rolloutToken;
	client.visitorData = visitor;
	client.userInterfaceTheme = dark ? "USER_INTERFACE_THEME_DARK" : "USER_INTERFACE_THEME_LIGHT";
	client.originalUrl = PUBLIC_ORIGIN + pageUrl;
	cfg.INNERTUBE_CONTEXT.clickTracking = { clickTrackingParams: "" };
	cfg.SBOX_SETTINGS.VISITOR_DATA = visitor;
	cfg.SBOX_SETTINGS.SEARCHBOX_HOST_OVERRIDE = new URL(PUBLIC_ORIGIN).host;
	cfg.EMERGENCY_BASE_URL = "/error_204?t=jserror&level=ERROR";
	cfg.VALID_SESSION_TEMPDATA_DOMAINS = [new URL(PUBLIC_ORIGIN).hostname];
	// the client keeps preferences such as Appearance in PREF, for this domain
	// (it defaults to youtube.com, which the browser would refuse here)
	cfg.ALT_PREF_COOKIE_DOMAIN = prefCookieDomain();
	// IS_DBSC only gates the signed-in RotateCookiesPage iframe on accounts.youtube.com
	cfg.IS_DBSC = true;
	// no Chromecast/DIAL discovery (would load cast_sender.js from gstatic)
	cfg.MDX_CONFIG = { disableCastApi: true, disableDial: true };
	// privembed=1 turns off the ad-blocker probe (static.doubleclick.net/instream/ad_status.js)
	// and the advertising id fetch; nothing else in this build reads it
	cfg.PLAYER_VARS = { privembed: "1" };
	Object.assign(cfg.EXPERIMENT_FLAGS, FLAG_OVERRIDES);
	// the player: always the pinned one
	const playerPath = new URL(pin.player.jsUrl).pathname;
	const playerCss = new URL(pin.player.cssUrl).pathname;
	cfg.PLAYER_JS_URL = playerPath;
	cfg.PLAYER_CSS_URL = playerCss;
	cfg.PLAYER_CLIENT_VERSION = pin.player.version;
	for (const ctx of Object.values(cfg.WEB_PLAYER_CONTEXT_CONFIGS) as any[]) {
		ctx.jsUrl = playerPath;
		ctx.cssUrl = playerCss;
		ctx.trustedJsUrl = { privateDoNotAccessOrElseTrustedResourceUrlWrappedValue: playerPath };
		ctx.trustedCssUrl = { privateDoNotAccessOrElseTrustedResourceUrlWrappedValue: playerCss };
		ctx.innertubeApiKey = cfg.INNERTUBE_API_KEY;
		ctx.cspNonce = nonce;
		ctx.datasyncId = cfg.DATASYNC_ID;
		ctx.serializedExperimentFlags = serializedFlags(ctx.serializedExperimentFlags, PLAYER_FLAG_OVERRIDES);
	}
	return rehost(cfg) as Record<string, any>;
}


type Rule = { name: string; find: RegExp; replace: (m: RegExpExecArray) => string; optional?: boolean };

const json = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// replaces the JSON value that starts right after `marker`
function replaceJsonAfter(html: string, marker: string, value: string, name: string): string {
	// the marker must be followed by the value's first character
	const i = html.indexOf(marker);
	if (i < 0) throw new PageRuleError(name);
	const start = i + marker.length - 1;
	return html.slice(0, start) + value + html.slice(jsonEnd(html, start));
}

class PageRuleError extends Error {
	constructor(rule: string) {
		super(`page rule did not match: ${rule}`);
	}
}

function socialMeta(data: PageData): string {
	const tags: [string, string | undefined][] = [
		["og:site_name", INSTANCE_NAME],
		["og:title", data.title || INSTANCE_NAME],
		["og:url", PUBLIC_ORIGIN + data.url],
		["og:description", data.description],
		["og:image", data.thumbnail],
		["twitter:card", data.thumbnail ? "summary_large_image" : "summary"],
	];
	return tags.filter(([, v]) => v).map(([k, v]) => `<meta property="${k}" content="${escapeHtml(v!)}">`).join("");
}

// settings pages are only served signed in, so no public copy can be pinned;
// they are the same app shell as home (ytPageType and ytcfg are set per page)
const SHELL: Partial<Record<PageKind, PageKind>> = { settings: "home" };
const templates = new Map<PageKind, string>();
function template(kind: PageKind): string {
	let t = templates.get(kind);
	if (!t) {
		const p = pagePath(SHELL[kind] ?? kind);
		if (!existsSync(p)) throw new Error(`no pinned page for ${kind}; run bun scripts/fetch-client.ts`);
		t = readFileSync(p, "utf8");
		templates.set(kind, t);
	}
	return t;
}

// dark: the resolved Appearance (appearance.ts), applied before first paint
export function renderPage(data: PageData, viewer: Viewer, nonce: string, dark = false): string {
	const pin = loadPin()!;
	let html = template(data.kind);
	const cfg = buildYtcfg(data.kind, viewer, data.url, nonce, dark);
	html = replaceJsonAfter(html, "ytcfg.set({", json(cfg), "ytcfg");
	if (html.includes("var ytInitialPlayerResponse = ")) {
		html = data.playerResponse
			? replaceJsonAfter(html, "var ytInitialPlayerResponse = {", json(data.playerResponse), "ytInitialPlayerResponse")
			: replaceJsonAfter(html, "var ytInitialPlayerResponse = {", "null", "ytInitialPlayerResponse");
	}
	html = replaceJsonAfter(html, "var ytInitialData = {", json(data.initialData), "ytInitialData");
	// a string the page JSON.parses; '{}' (empty) makes the client request the sequence
	if (data.reelSequence)
		html = html.replace(/var ytInitialReelWatchSequenceResponse = '(?:[^'\\]|\\.)*';/, () => `var ytInitialReelWatchSequenceResponse = ${json(JSON.stringify(data.reelSequence))};`);
	const thumb = data.thumbnail ?? "";
	let socialDone = false;
	const rules: Rule[] = [
		{ name: "nonce", find: /nonce="[^"]*"/g, replace: () => `nonce="${nonce}"` },
		// the dark theme is the dark attribute on <html>, as YouTube's server renders it
		{ name: "theme", find: /<html (?=[^>]*\bdarker-dark-theme\b)/g, replace: () => (dark ? "<html dark " : "<html ") },
		// and its stylesheet is the dark compile, as YouTube's server links it
		{ name: "theme-stylesheet", find: /(<link rel="stylesheet" href="https:\/\/www\.youtube\.com\/s\/_\/ytmainappweb\/_\/ss\/[^"?]*)"/g, replace: (m) => (dark && pin.app.darkCss ? `${m[1]}?dark"` : `${m[1]}"`) },
		{ name: "attestation", find: /\(function\(\) \{if \(window\.ytAtN\) \{window\.ytAtN\(\{[\s\S]*?\}\);\}\}\)\(\);/g, replace: () => "", optional: true },
		{
			name: "server-contract",
			find: /window\['ytPageType'\] = "[^"]*";window\['ytCommand'\] = (\{[\s\S]*?\});window\['ytUrl'\] = '[^']*';/g,
			replace: () => `window['ytPageType'] = ${json(PAGE_TYPE[data.kind])};window['ytCommand'] = ${json(data.command)};window['ytUrl'] = ${json(data.url)};`,
		},
		{ name: "passive-signin-iframe", find: /<iframe name="passive_signin"[^>]*><\/iframe>/g, replace: () => "", optional: true },
		{ name: "media-host-hints", find: /<link rel="(?:preload|preconnect|dns-prefetch)" href="https:\/\/[^"]*(?:googlevideo\.com|c\.youtube\.com|i\.ytimg\.com)[^"]*"[^>]*>/g, replace: () => "", optional: true },
		{ name: "thumbnail-preload", find: /<link as="image" rel="preload" href="https:\/\/i\.ytimg\.com\/[^"]*"[^>]*>/g, replace: () => (thumb ? `<link as="image" rel="preload" href="${escapeHtml(thumb)}">` : ""), optional: true },
		{ name: "player-placeholder", find: /background-image: url\('https:\/\/i\.ytimg\.com\/[^']*'\);/g, replace: () => `background-image: url('${escapeHtml(thumb)}');`, optional: true },
		{ name: "player-urls", find: /\/s\/player\/[0-9a-f]{8}\//g, replace: () => `/s/player/${pin.player.id}/`, optional: true },
		{ name: "static-host", find: /https:\/\/www\.youtube\.com\/s\//g, replace: () => "/s/" },
		{ name: "fonts-host", find: /(?:https:)?\/\/fonts\.googleapis\.com\//g, replace: () => "/_up/fonts.googleapis.com/" },
		// the results page ships without <title> (the app sets it); give it one
		{ name: "title", find: /<title>[^<]*<\/title>|(?<=<head>)(?![\s\S]*<title>)/g, replace: () => `<title>${escapeHtml(data.title ? `${data.title} - ${INSTANCE_NAME}` : INSTANCE_NAME)}</title>` },
		{ name: "meta-title", find: /<meta name="title" content="[^"]*">/g, replace: () => `<meta name="title" content="${escapeHtml(data.title)}">`, optional: true },
		{ name: "meta-description", find: /<meta name="description" content="[^"]*">/g, replace: () => `<meta name="description" content="${escapeHtml(data.description ?? "")}">`, optional: true },
		{ name: "image-src", find: /<link rel="image_src"[^>]*>/g, replace: () => "", optional: true },
		// link previews: the pinned pages carry the captured page's own (its
		// title, image and youtube.com URLs, app links); this page's in their place
		{ name: "social-meta", find: /(?:<meta (?:property|name)="(?:og|al|twitter|fb):[^"]*" content="[^"]*">)+/g, replace: () => (socialDone ? "" : ((socialDone = true), socialMeta(data))), optional: true },
		{ name: "page-keywords", find: /<meta name="keywords" content="[^"]*">/g, replace: () => "", optional: true },
		{ name: "structured-data", find: /<script type="application\/ld\+json"[^>]*>[\s\S]*?<\/script>/g, replace: () => "", optional: true },
		// schema.org microdata of the captured channel (name, id, regions)
		{ name: "microdata", find: /<link itemprop="url"[^>]*>(?:<(?:link|meta) itemprop="[^"]*"[^>]*>|<span itemprop[^>]*>|<span itemscope[^>]*>|<\/span>)+/g, replace: () => "", optional: true },
		// the guide's footer links are YouTube's own pages (About, Press, Terms, ...),
		// which say nothing about this instance: removed, the instance name stays
		{ name: "guide-footer-links", find: /(?:<a slot="guide-links-(?:primary|secondary)"[^>]*>[^<]*<\/a>)+/g, replace: () => "" },
		{ name: "copyright", find: /<div id="copyright" slot="copyright"[^>]*>[\s\S]*?<\/div><\/div>/g, replace: () => `<div id="copyright" slot="copyright" style="display: none;"><div dir="ltr" style="display:inline">${escapeHtml(INSTANCE_NAME)}</div></div>`, optional: true },
		{ name: "app-links", find: /<link rel="(?:alternate|canonical|search)"[^>]*>|<meta name="apple-itunes-app"[^>]*>|<meta http-equiv="origin-trial"[^>]*\/>/g, replace: () => "", optional: true },
		// the GIF picker for comment boxes (src/gifs.ts), first in <head> so its
		// request hook is in place before the app's scripts run
		...(GIFS_ENABLED && viewer ? [{ name: "gif-picker", find: /<head>/g, replace: () => `<head><script nonce="${nonce}" src="/_ot/gifs.js"></script>` }] : []),
	];
	for (const r of rules) {
		let n = 0;
		html = html.replace(r.find, (...m) => {
			n++;
			return r.replace(m as unknown as RegExpExecArray);
		});
		if (!n && !r.optional) recordMiss(`page rule ${r.name} on ${data.kind}`, "");
	}
	return html;
}
