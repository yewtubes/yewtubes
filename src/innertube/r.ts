// Building blocks of InnerTube responses: text, endpoints, images and the
// formatting the client shows verbatim (it does not format counts or dates
// itself). Structures follow captures of the pinned build; see
// docs/compat/endpoints.md for where each one is used.

import { INSTANCE_NAME, PUBLIC_ORIGIN } from "../config";
import type { Viewer } from "../client/page";

export type Video = {
	id: string;
	title: string;
	description: string;
	channel_id: string;
	channel_title: string;
	channel_handle: string;
	channel_avatar: string | null;
	duration_ms: number | null;
	view_count: number;
	like_count: number;
	comment_count: number;
	published_at: Date | null;
	created_at: Date;
	visibility: "public" | "unlisted" | "private";
	status: string;
	// has a format to play, while the rest is still processing too
	playable: boolean;
	width: number | null;
	height: number | null;
	category_id?: number;
	subscriber_count?: number;
};

export type Channel = {
	id: string;
	handle: string;
	title: string;
	description: string;
	avatar_path: string | null;
	banner_path: string | null;
	links: { title: string; url: string }[];
	created_at: Date;
	subscriber_count: number;
	video_count: number;
	user_id: string;
};

export const text = (s: string) => ({ simpleText: s });
export const runs = (...parts: (string | { text: string; navigationEndpoint?: unknown; bold?: boolean })[]) => ({ runs: parts.map((p) => (typeof p === "string" ? { text: p } : p)) });
export const label = (s: string) => ({ accessibilityData: { label: s } });
export const content = (s: string) => ({ content: s });

// ---- formatting ----
export function compact(n: number): string {
	if (n < 1000) return String(n);
	const units: [number, string][] = [[1e9, "B"], [1e6, "M"], [1e3, "K"]];
	for (const [v, u] of units)
		if (n >= v) {
			const x = n / v;
			return `${x < 10 ? Math.floor(x * 10) / 10 : Math.floor(x)}${u}`;
		}
	return String(n);
}
export const grouped = (n: number) => n.toLocaleString("en-US");
export const plural = (n: number, one: string, many = `${one}s`) => `${grouped(n)} ${n === 1 ? one : many}`;
export const viewsText = (n: number) => (n === 1 ? "1 view" : `${grouped(n)} views`);
export const shortViews = (n: number) => (n === 1 ? "1 view" : `${compact(n)} views`);
export const subscribersText = (n: number) => (n === 1 ? "1 subscriber" : `${compact(n)} subscribers`);

export function ago(d: Date | null | undefined, now = Date.now()): string {
	if (!d) return "";
	const s = Math.max(1, Math.floor((now - new Date(d).getTime()) / 1000));
	const steps: [number, string][] = [[31536000, "year"], [2592000, "month"], [604800, "week"], [86400, "day"], [3600, "hour"], [60, "minute"], [1, "second"]];
	for (const [v, u] of steps)
		if (s >= v) {
			const n = Math.floor(s / v);
			return `${n} ${u}${n === 1 ? "" : "s"} ago`;
		}
	return "just now";
}

// lockup metadata: "3d ago" / "5 min ago", read out as "3 days ago"
export function shortAgo(d: Date | null | undefined, now = Date.now()): string {
	if (!d) return "";
	const s = Math.max(1, Math.floor((now - new Date(d).getTime()) / 1000));
	const steps: [number, string][] = [[31536000, "y"], [2592000, "mo"], [604800, "w"], [86400, "d"], [3600, "h"], [60, " min"], [1, " sec"]];
	for (const [v, u] of steps) if (s >= v) return `${Math.floor(s / v)}${u} ago`;
	return "";
}

// "61K" read out as "61 thousand views"; "1.2M" as "1.2 million views"
export function countLabel(n: number, one: string, many = `${one}s`): string {
	if (n === 0) return `No ${many}`;
	if (n < 1000) return `${n} ${n === 1 ? one : many}`;
	const units: [number, string][] = [[1e9, "billion"], [1e6, "million"], [1e3, "thousand"]];
	for (const [v, u] of units)
		if (n >= v) {
			const x = n / v;
			return `${x < 10 ? Math.floor(x * 10) / 10 : Math.floor(x)} ${u} ${many}`;
		}
	return `${n} ${many}`;
}
export const compactViews = (n: number) => (n === 0 ? "No views" : n === 1 ? "1 view" : `${compact(n)} views`);

export function duration(ms: number | null | undefined): string {
	const t = Math.round((ms ?? 0) / 1000);
	const h = Math.floor(t / 3600);
	const m = Math.floor((t % 3600) / 60);
	const s = t % 60;
	return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

export function durationLabel(ms: number | null | undefined): string {
	const t = Math.round((ms ?? 0) / 1000);
	const h = Math.floor(t / 3600);
	const m = Math.floor((t % 3600) / 60);
	const s = t % 60;
	const parts = [];
	if (h) parts.push(`${h} hour${h === 1 ? "" : "s"}`);
	if (m) parts.push(`${m} minute${m === 1 ? "" : "s"}`);
	if (s || !parts.length) parts.push(`${s} second${s === 1 ? "" : "s"}`);
	return parts.join(", ");
}

export const dateText = (d: Date | null | undefined) => (d ? new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "");

// ---- endpoints ----
export function watchEndpoint(videoId: string, extra: { playlistId?: string; index?: number; startTimeSeconds?: number; params?: string } = {}) {
	const q = new URLSearchParams({ v: videoId });
	if (extra.playlistId) q.set("list", extra.playlistId);
	if (extra.index !== undefined) q.set("index", String(extra.index + 1));
	if (extra.startTimeSeconds) q.set("t", `${extra.startTimeSeconds}s`);
	return {
		commandMetadata: { webCommandMetadata: { url: `/watch?${q}`, webPageType: "WEB_PAGE_TYPE_WATCH", rootVe: 3832 } },
		watchEndpoint: {
			videoId,
			...(extra.playlistId ? { playlistId: extra.playlistId } : {}),
			...(extra.index !== undefined ? { index: extra.index } : {}),
			...(extra.startTimeSeconds ? { startTimeSeconds: extra.startTimeSeconds } : {}),
			...(extra.params ? { params: extra.params } : {}),
		},
	};
}

export function browseEndpoint(browseId: string, url: string, pageType = "WEB_PAGE_TYPE_BROWSE", rootVe = 3854, extra: Record<string, unknown> = {}) {
	return {
		commandMetadata: { webCommandMetadata: { url, webPageType: pageType, rootVe, apiUrl: "/youtubei/v1/browse" } },
		browseEndpoint: { browseId, ...extra },
	};
}

export const channelUrl = (handle: string) => `/@${handle}`;
export function channelEndpoint(c: { id: string; handle: string }, tab?: { params: string; path: string }) {
	return browseEndpoint(c.id, channelUrl(c.handle) + (tab ? `/${tab.path}` : ""), "WEB_PAGE_TYPE_CHANNEL", 3611, { canonicalBaseUrl: channelUrl(c.handle), ...(tab ? { params: tab.params } : {}) });
}

export function playlistEndpoint(playlistId: string) {
	return browseEndpoint(`VL${playlistId}`, `/playlist?list=${playlistId}`, "WEB_PAGE_TYPE_PLAYLIST", 5754);
}

export function searchEndpoint(query: string, params?: string) {
	const q = new URLSearchParams({ search_query: query });
	if (params) q.set("sp", params);
	return {
		commandMetadata: { webCommandMetadata: { url: `/results?${q}`, webPageType: "WEB_PAGE_TYPE_SEARCH", rootVe: 4724 } },
		searchEndpoint: { query, ...(params ? { params } : {}) },
	};
}

export function urlEndpoint(url: string, external = false) {
	return {
		commandMetadata: { webCommandMetadata: { url, webPageType: "WEB_PAGE_TYPE_UNKNOWN", rootVe: 83769 } },
		urlEndpoint: { url, ...(external ? { target: "TARGET_NEW_WINDOW", nofollow: true } : {}) },
	};
}

export function signInEndpoint(next = "/") {
	const url = `/signin?next=${encodeURIComponent(next)}`;
	return { commandMetadata: { webCommandMetadata: { url, webPageType: "WEB_PAGE_TYPE_UNKNOWN", rootVe: 83769 } }, signInEndpoint: { nextEndpoint: urlEndpoint(next) } };
}

export function serviceEndpoint(apiUrl: string, body: Record<string, unknown>) {
	return { commandMetadata: { webCommandMetadata: { sendPost: true, apiUrl } }, ...body };
}

// sign-in prompt shown in place of an action for signed-out viewers
export function signInModal(title: string, body: string, next = "/") {
	return {
		commandMetadata: { webCommandMetadata: { ignoreNavigation: true } },
		modalEndpoint: {
			modal: {
				modalWithTitleAndButtonRenderer: {
					title: text(title),
					content: text(body),
					button: { buttonRenderer: { style: "STYLE_MONO_FILLED", size: "SIZE_DEFAULT", isDisabled: false, text: text("Sign in"), navigationEndpoint: signInEndpoint(next) } },
				},
			},
		},
	};
}

// ---- images ----
export function videoThumbnails(videoId: string, version?: string) {
	const u = (n: string) => `${PUBLIC_ORIGIN}/vi/${videoId}/${n}.jpg${version ? `?v=${version}` : ""}`;
	return {
		thumbnails: [
			{ url: u("default"), width: 120, height: 90 },
			{ url: u("mqdefault"), width: 320, height: 180 },
			{ url: u("hqdefault"), width: 480, height: 360 },
			{ url: u("sddefault"), width: 640, height: 480 },
			{ url: u("maxresdefault"), width: 1280, height: 720 },
		],
	};
}

// 16:9 thumbnails for lockups, as YouTube's grids list them: hq720 at the
// two sizes a grid cell is drawn at (the client picks by cell width)
export function lockupSources(videoId: string) {
	return [
		{ url: `${PUBLIC_ORIGIN}/vi/${videoId}/hq720.jpg`, width: 360, height: 202 },
		{ url: `${PUBLIC_ORIGIN}/vi/${videoId}/hq720.jpg`, width: 720, height: 404 },
	];
}

// avatars keep the yt3.ggpht.com size suffix (=s88-...), which the client
// rewrites to ask for other sizes
export function avatarUrl(channelId: string, size = 88) {
	return `${PUBLIC_ORIGIN}/ggpht/${channelId}/avatar=s${size}-c-k-c0x00ffffff-no-rj`;
}
export function avatarThumbnails(channelId: string, sizes = [48, 88, 176]) {
	return { thumbnails: sizes.map((s) => ({ url: avatarUrl(channelId, s), width: s, height: s })) };
}
export function bannerUrl(channelId: string) {
	return `${PUBLIC_ORIGIN}/ggpht/${channelId}/banner=w2560-fcrop64=1,00005a57ffffa5a8-k-c0xffffffff-no-nd-rj`;
}

export function responseContext(viewer: Viewer, extra: Record<string, unknown> = {}, trackingParam = "") {
	return {
		serviceTrackingParams: [
			{ service: "CSI", params: [{ key: "c", value: "WEB" }, { key: "yt_li", value: viewer ? "1" : "0" }] },
			{ service: "GFEEDBACK", params: [{ key: "logged_in", value: viewer ? "1" : "0" }] },
		],
		maxAgeSeconds: 0,
		mainAppWebResponseContext: { loggedOut: !viewer, trackingParam },
		webResponseContextExtensionData: { hasDecorated: true },
		...extra,
	};
}

export const instanceName = INSTANCE_NAME;
