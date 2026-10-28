// Serve-time edits to the pinned client. Every patch names the asset it
// applies to, the exact upstream text it expects and how many times. A count
// other than `expect` is an error: the patch is not applied, the asset is
// served unpatched, the failure is recorded for /admin/diagnostics, and
// `bun run check-patches` exits non-zero. docs/client-patches.md is the
// inventory; keep it in sync with this list.

import { PUBLIC_ORIGIN, STUDIO_ORIGIN } from "../config";

export type PatchContext = { origin: string; localOrigin: boolean; studioOrigin: string };
export type Patch = {
	id: string;
	// which archived asset: "app" (main bundle and lazy modules), "player"
	// (base.js), "studio" (YouTube Studio's bundle and modules), or a regex
	// on the upstream URL
	asset: "app" | "player" | "studio" | RegExp;
	find: string | RegExp;
	replace: (ctx: PatchContext, ...groups: string[]) => string;
	expect: number;
	when?: (ctx: PatchContext) => boolean;
	why: string;
};

const quote = (s: string) => JSON.stringify(s);
// the instance hostname as it must appear inside a RegExp("...") string literal
const regexHost = (c: PatchContext) => new URL(c.origin).hostname.replace(/\./g, "\\\\.");

export const PATCHES: Patch[] = [
	{
		id: "icons-material-host",
		asset: "app",
		find: '"https://fonts.gstatic.com/s/i/"',
		replace: (c) => quote(`${c.origin}/_up/fonts.gstatic.com/s/i/`),
		expect: 2,
		why: "The icon manager builds SVG icon URLs from this literal prefix (functions MM9/A_9 in this build). Points them at the instance's archived copies instead of fonts.gstatic.com.",
	},
	{
		id: "gstatic-youtube-img-host",
		asset: "app",
		find: '"https://www.gstatic.com/youtube/img/',
		replace: (c) => `"${c.origin}/_up/www.gstatic.com/youtube/img/`,
		expect: 60,
		why: "Every www.gstatic.com/youtube/img/ URL the app names, across the main bundle and lazy modules: the second icon family (icons/web/, function euN), Lottie animations (like, subscribe, loading), and illustrations. Points them at the archived copies under /_up/.",
	},
	{
		id: "icons-allowed-hosts",
		asset: "app",
		find: '["https://fonts.gstatic.com","https://tv.youtube.com","https://www.gstatic.com","https://www.youtube.com"]',
		replace: (c) => `["https://fonts.gstatic.com","https://tv.youtube.com","https://www.gstatic.com","https://www.youtube.com",${quote(c.origin)}]`,
		expect: 1,
		why: "The icon manager only fetches and inlines .svg icons whose URL starts with one of these origins (pUs). Adds the instance origin so the relocated icons above are inlined like upstream ones.",
	},
	{
		id: "player-trusted-stream-host",
		asset: "player",
		// the Trusted Stream URL allowlist (uva): ^https?://(sub.)*(host|host|...)(:port)?/
		find: String.raw`googlevideo\\.com|prod\\.google\\.com`,
		replace: (c) => String.raw`googlevideo\\.com|` + regexHost(c) + String.raw`|prod\\.google\\.com`,
		expect: 1,
		when: (c) => !c.localOrigin,
		why: "The player refuses media URLs ('Untrusted URL') unless they match its stream allowlist or start with http://local / https://local. A localhost instance needs nothing; any other host is added to the allowlist's host alternation.",
	},
	{
		id: "player-trusted-image-host",
		asset: "player",
		// the Trusted Image URL allowlist (wva); the ad-domain list (yva) also
		// names ytimg.com but not chat.google.com right after it
		find: String.raw`|ytimg\\.com|ytimg\\.sandbox\\.google\\.com|chat\\.google\\.com)`,
		replace: (c) => String.raw`|ytimg\\.com|` + regexHost(c) + String.raw`|ytimg\\.sandbox\\.google\\.com|chat\\.google\\.com)`,
		expect: 1,
		why: "The player keeps only thumbnail URLs on its trusted image hosts (videoDetails.thumbnail -> poster, miniplayer, end screen); for anything else it builds http(s)://i1.ytimg.com/vi/<id>/... itself. Adds the instance host so it uses this instance's thumbnails.",
	},
	{
		id: "player-first-party-host",
		asset: "player",
		// the allowlist (Ffb) of hosts whose pages may tell the player what
		// kind of page it is on (youtube.com and Google's own sites)
		find: 'Ffb=RegExp("',
		replace: (c) => 'Ffb=RegExp("^https?://' + regexHost(c) + String.raw`(:[0-9]+)?/|`,
		expect: 1,
		why: "A page may set the player's event label (el=detailpage on the watch page) only if its URL is on this allowlist; on any other host the player takes itself for an embed, and an embed doesn't autoplay. That shows when the player script loads after a watch page has started (a result clicked quickly after the page renders): the video is cued instead of played. Adds the instance host.",
	},
	{
		id: "player-base-host",
		asset: "player",
		// the allowlist (sva) for the player's own base URL: corp proxies and
		// youtube.com hosts; anything else falls back to www.youtube.com
		find: 'sva=RegExp("',
		replace: (c) => 'sva=RegExp("^https?://' + regexHost(c) + String.raw`(:[0-9]+)?/|`,
		expect: 1,
		why: "The player derives its base URL from the page location only if the host is on this allowlist, else uses www.youtube.com. That base URL hosts the QoE stats (/api/stats/qoe) and ptracking beacons. Adds the instance host so those go to this instance.",
	},
	{
		id: "fonts-stylesheet-host",
		asset: "app",
		find: '"https://fonts.googleapis.com/css',
		replace: (c) => `"${c.origin}/_up/fonts.googleapis.com/css`,
		expect: 5,
		why: "The app inserts five font stylesheets (italic Roboto, Roboto Mono, a games font) at run time from fonts.googleapis.com. Points them at the archived copies; the page's own stylesheet link is rewritten by the page renderer.",
	},
	{
		id: "no-redirect-prefetch",
		asset: "app",
		find: 'this.redirectsToPreload=["https://youtube.com"]',
		replace: () => "this.redirectsToPreload=[]",
		expect: 1,
		why: "On every load the app fetches https://youtube.com once to warm the youtube.com -> www redirect. Nothing to warm here; the list is emptied.",
	},
	{
		id: "app-help-service",
		asset: "app",
		find: '"https://www.gstatic.com/feedback/js/help/prod/service/lazy.min.js"',
		replace: (c) => quote(`${c.origin}/_ot/help.js`),
		expect: 1,
		why: "Google's in-product help and feedback service, loaded by URL when the client opens help or feedback. Points it at this instance's stand-in (assets/help.js): feedback opens /feedback, help opens YouTube's help center.",
	},
	{
		id: "picker-rpc-script",
		asset: "app",
		find: '_.WZ(["//apis.google.com/js/rpc.js"])',
		replace: () => '_.WZ(["/picker/rpc.js"])',
		expect: 1,
		why: "The post composer's Video button opens a picker dialog (Bj) that talks to its frame over gadgets.rpc, which it loads from apis.google.com. Loads the instance's gadgets.rpc instead (src/picker.ts), which carries the same calls by postMessage.",
	},
	{
		id: "picker-plain-frame",
		asset: "app",
		find: "this.useGapi_=!N&&!iFr()",
		replace: () => "this.useGapi_=!1",
		expect: 1,
		why: "The picker dialog otherwise opens its frame through gapi.iframes (Google's API loader) and speaks Google Picker's protobuf commands to it. With this off it uses its plain-iframe path, which only needs gadgets.rpc (picker-rpc-script), as it does inside Google's own frames.",
	},
	{
		id: "picker-frame-scheme",
		asset: "app",
		find: '_.xH(F,\n"https");this.JSC$12116_url_=F.toString()',
		replace: () => '_.xH(F,\n"http");this.JSC$12116_url_=F.toString()',
		expect: 1,
		when: (c) => c.origin.startsWith("http:"),
		why: "The picker dialog forces its frame URL (ONE_PICK_URL, the instance's /picker) to https. An instance served over plain http keeps http.",
	},
	// ---- YouTube Studio ----
	{
		id: "studio-gstatic-youtube-img-host",
		asset: "studio",
		find: "https://www.gstatic.com/youtube/img/",
		replace: (c) => `${c.studioOrigin}/_up/www.gstatic.com/youtube/img/`,
		expect: 1004,
		why: "Studio's illustrations, icons and animations, named in string literals and in its Polymer templates' attribute bindings. Points them at the archived copies under the Studio origin's /_up/.",
	},
	{
		id: "studio-css-gstatic-host",
		asset: /\/s\/_\/creatorstudio\/_\/ss\//,
		find: "https://www.gstatic.com/youtube/img/",
		replace: (c) => `${c.studioOrigin}/_up/www.gstatic.com/youtube/img/`,
		expect: 10,
		why: "Background images in Studio's stylesheet (onboarding and partner-program artwork).",
	},
	{
		id: "studio-icons-material-host",
		asset: "studio",
		find: '"https://fonts.gstatic.com/s/i/"',
		replace: (c) => quote(`${c.studioOrigin}/_up/fonts.gstatic.com/s/i/`),
		expect: 2,
		why: "The prefix Studio's icon manager builds SVG icon URLs from, as in the main app.",
	},
	{
		id: "studio-icons-allowed-hosts",
		asset: "studio",
		find: '["https://fonts.gstatic.com","https://tv.youtube.com","https://www.gstatic.com","https://www.youtube.com"]',
		replace: (c) => `["https://fonts.gstatic.com","https://tv.youtube.com","https://www.gstatic.com","https://www.youtube.com",${quote(c.studioOrigin)}]`,
		expect: 1,
		why: "Studio's icon manager has the same origin allowlist as the main app's; adds the Studio origin so the relocated icons are fetched and inlined.",
	},
	{
		id: "studio-fonts-stylesheet-host",
		asset: "studio",
		find: '"https://fonts.googleapis.com/css',
		replace: (c) => `"${c.studioOrigin}/_up/fonts.googleapis.com/css`,
		expect: 4,
		why: "Font stylesheets Studio inserts at run time.",
	},
	{
		id: "studio-help-service",
		asset: "studio",
		find: /"https:\/\/www\.gstatic\.com\/feedback\/js\/help\/prod\/service\/lazy\.min\.js"|"https:\/\/www\.google\.com\/tools\/feedback\/(?:help_api|open_to_help_guide_lazy)\.js"/,
		replace: (c) => quote(`${c.studioOrigin}/_ot/help.js`),
		expect: 3,
		why: "Studio preloads Google's help and feedback service on every page (the CSP refuses it) and loads Google's help API for the Help button. All three point at the instance's stand-in (assets/help.js): Send feedback opens the main origin's /feedback, help opens YouTube's help center.",
	},
	{
		id: "studio-help-button",
		asset: "studio",
		find: /openHelp=function\(\)\{_\.\w+\("client",this\.configureAndStartHelp\)\}/,
		replace: () => "openHelp=function(){this.configureAndStartHelp()}",
		expect: 1,
		why: "The Help button first loads Google's API loader (apis.google.com, gapi \"client\"), which isn't served, and only then starts the help service. It now starts the help service directly, which is the instance's stand-in (studio-help-service): help opens YouTube's help center.",
	},
	{
		id: "studio-feedback-direct",
		asset: "studio",
		find: /else (\w+)\(a,b,c,e\)\.catch\(function\(k\)\{!k\|\|k instanceof \w+\|\|(\w+)\(a,b,c,e\)\}\)/,
		replace: (_c, _uservoice, loader) => `else ${loader}(a,b,c,e)`,
		expect: 1,
		why: "Send feedback (userfeedback.api.startFeedback) first tries Google's uservoice form (a request to google.com and a gstatic script, both refused by the CSP) and then falls back to Google's feedback loader, which calls window.GOOGLE_FEEDBACK_START when the page defines it. Goes to the loader directly; the instance's stand-in (assets/help.js) defines it to open /feedback.",
	},
];

export const patchContext = (): PatchContext => ({ origin: PUBLIC_ORIGIN, localOrigin: /^https?:\/\/local/.test(PUBLIC_ORIGIN), studioOrigin: STUDIO_ORIGIN });

export type PatchResult = { id: string; matches: number; expect: number; applied: boolean };

function count(text: string, find: string | RegExp): number {
	if (typeof find === "string") {
		let n = 0;
		for (let i = text.indexOf(find); i >= 0; i = text.indexOf(find, i + find.length)) n++;
		return n;
	}
	return [...text.matchAll(new RegExp(find.source, find.flags.includes("g") ? find.flags : `${find.flags}g`))].length;
}

export function patchesFor(kind: "app" | "player" | "studio" | "other", url: string): Patch[] {
	const ctx = patchContext();
	return PATCHES.filter((p) => (p.when ? p.when(ctx) : true) && (p.asset === kind || (p.asset instanceof RegExp && p.asset.test(url))));
}

// applies to one asset; a patch for the app may match in any one of its
// pieces, so per-piece results are summed by the caller
export function applyPatches(text: string, patches: Patch[]): { text: string; results: PatchResult[] } {
	const ctx = patchContext();
	const results: PatchResult[] = [];
	for (const p of patches) {
		const n = count(text, p.find);
		const applied = n > 0;
		if (applied) {
			if (typeof p.find === "string") text = text.split(p.find).join(p.replace(ctx));
			else text = text.replace(new RegExp(p.find.source, p.find.flags.includes("g") ? p.find.flags : `${p.find.flags}g`), (...m) => p.replace(ctx, ...m.slice(1, -2)));
		}
		results.push({ id: p.id, matches: n, expect: p.expect, applied });
	}
	return { text, results };
}

export const patchSetHash = () => Bun.hash(JSON.stringify(PATCHES.map((p) => [p.id, String(p.find), p.replace(patchContext()), p.expect])) + PUBLIC_ORIGIN + STUDIO_ORIGIN).toString(36);
