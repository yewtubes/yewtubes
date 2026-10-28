// /youtubei/v1/search, the /results page and search suggestions. Built from
// YouTube's search responses (templates search/*, item/*_search): the chip
// bar, the Filters dialog, video, channel and playlist results, the Shorts
// grid shelf and the continuation that loads more.

import type { PageData, Viewer } from "../client/page";
import { isSubscribed, markWatched, searchChannels, searchVideos, type VideoSearch } from "../data";
import { sql } from "../db";
import { decodeToken, encodeToken } from "../ids";
import { topbar } from "./chrome";
import { shortVars } from "./feeds";
import { playlistSearchItem, searchPlaylists } from "./playlists";
import { decode, encode, fromBase64 } from "./proto";
import { PUBLIC_ORIGIN } from "../config";
import { type Channel, type Video, ago, compact, compactViews, countLabel, responseContext, shortAgo } from "./r";
import { ApiError, route } from "./router";
import { channelRowButton, subscribeEntities } from "./subscribe";
import { make, type Vars } from "./tpl";
import { avatarSources, baseVars, channelVars, videoVars } from "./vars";

const PAGE = 20;

// The sp= parameter, as YouTube encodes it: field 1 the sort (3 popularity,
// 2 upload date), field 2 the filters (1 upload date, 2 type, 3 duration,
// and one field set to 1 for each feature)
type Search = { sort?: number; date?: number; type?: number; duration?: number; features?: number[] };

// the Features group's fields: Live 8, 4K 14, HD 4, Subtitles/CC 5,
// Creative Commons 6, 360° 15, VR180 26, 3D 7, HDR 25, Location 23,
// Purchased 9
const FEATURES: Record<string, number> = { LIVE: 8, "4K": 14, HD: 4, SUBTITLES: 5, CC: 6, "360": 15, VR180: 26, "3D": 7, HDR: 25, LOCATION: 23, PURCHASED: 9 };
const FEATURE_FIELDS = Object.values(FEATURES);

export function decodeParams(sp: string | null | undefined): Search {
	if (!sp) return {};
	try {
		const f = decode(fromBase64(decodeURIComponent(sp)));
		const out: Search = {};
		const sort = f.get(1)?.[0];
		if (sort === 2 || sort === 3) out.sort = sort;
		const sub = f.get(2)?.[0];
		if (sub instanceof Uint8Array) {
			const g = decode(sub);
			const num = (k: number, ok: number[]) => {
				const v = g.get(k)?.[0];
				return typeof v === "number" && ok.includes(v) ? v : undefined;
			};
			out.date = num(1, [2, 3, 4, 5]);
			out.type = num(2, [1, 2, 3, 4, 9]);
			out.duration = num(3, [2, 4, 5]);
			const features = FEATURE_FIELDS.filter((k) => num(k, [1]));
			if (features.length) out.features = features;
		}
		return out;
	} catch {
		return {};
	}
}

export function encodeParams(s: Search): string {
	const filters: Record<number, number> = {};
	if (s.date) filters[1] = s.date;
	if (s.type) filters[2] = s.type;
	if (s.duration) filters[3] = s.duration;
	for (const k of s.features ?? []) filters[k] = 1;
	const msg: Record<number, number | Record<number, number>> = {};
	if (s.sort) msg[1] = s.sort;
	if (Object.keys(filters).length) msg[2] = filters;
	if (!Object.keys(msg).length) return "";
	return Buffer.from(encode(msg)).toString("base64").replace(/=/g, "%3D");
}

// Filters dialog entries: the template's F_<KEY> tokens
type Field = "sort" | "date" | "type" | "duration" | "feature";
const FILTERS: [string, Field, number | undefined][] = [
	["TYPE_VIDEO", "type", 1],
	["TYPE_SHORTS", "type", 9],
	["TYPE_CHANNEL", "type", 2],
	["TYPE_PLAYLIST", "type", 3],
	["TYPE_MOVIE", "type", 4],
	["DUR_SHORT", "duration", 4],
	["DUR_MEDIUM", "duration", 5],
	["DUR_LONG", "duration", 2],
	["DATE_TODAY", "date", 2],
	["DATE_WEEK", "date", 3],
	["DATE_MONTH", "date", 4],
	["DATE_YEAR", "date", 5],
	...Object.entries(FEATURES).map(([k, f]): [string, Field, number] => [`FEAT_${k}`, "feature", f]),
	["SORT_RELEVANCE", "sort", undefined],
	["SORT_POPULARITY", "sort", 3],
];

const DAY = 86400000;
const SINCE: Record<number, number> = { 2: DAY, 3: 7 * DAY, 4: 31 * DAY, 5: 366 * DAY };
const DURATION: Record<number, [number?, number?]> = { 4: [undefined, 180000], 5: [180000, 1200000], 2: [1200000, undefined] };

const queryUrl = (q: string) => encodeURIComponent(q).replace(/%20/g, "+");

// the chips: All, Shorts, Unwatched, Videos, Recently uploaded and Live.
// The one tapped stays selected; on a page opened from a link the filters
// decide (Videos for the video type, Recently uploaded for newest first)
type Chip = "ALL" | "SHORTS" | "UNWATCHED" | "VIDEOS" | "RECENT" | "LIVE";
const CHIPS: Chip[] = ["ALL", "SHORTS", "UNWATCHED", "VIDEOS", "RECENT", "LIVE"];

function headerVars(query: string, s: Search, chip?: Chip): Vars {
	const vars: Vars = { QUERY: query, QUERY_URL: queryUrl(query) };
	const features = s.features ?? [];
	for (const [key, field, value] of FILTERS) {
		let selected: boolean;
		let next: Search;
		if (field === "feature") {
			// features combine: each toggles on its own
			selected = features.includes(value!);
			const rest = selected ? features.filter((f) => f !== value) : [...features, value!].sort((a, b) => a - b);
			next = { ...s, features: rest.length ? rest : undefined };
		} else {
			selected = field === "sort" ? (s.sort ?? undefined) === value || (value === undefined && s.sort === 2) : s[field] === value;
			// a selected filter's entry clears it
			next = { ...s, [field]: selected ? undefined : value };
		}
		vars[`F_${key}`] = encodeParams(next);
		const notVideos = s.type === 2 || s.type === 3;
		const disabled = ((field === "duration" || field === "feature") && notVideos) || ((key === "TYPE_CHANNEL" || key === "TYPE_PLAYLIST") && (s.duration !== undefined || features.length > 0));
		vars[`F_${key}_STATUS`] = selected ? "FILTER_STATUS_SELECTED" : disabled ? "FILTER_STATUS_DISABLED" : undefined;
	}
	const recent = s.sort === 2;
	const kept = features.filter((f) => f !== FEATURES.LIVE);
	const plain: Search = { ...s, type: undefined, sort: recent ? undefined : s.sort, features: kept.length ? kept : undefined };
	const next: Record<Chip, Search> = {
		ALL: plain,
		SHORTS: { ...plain, type: 9 },
		UNWATCHED: plain,
		VIDEOS: { ...plain, type: 1 },
		RECENT: { ...plain, type: 1, sort: 2 },
		LIVE: { ...plain, features: [...(plain.features ?? []), FEATURES.LIVE].sort((a, b) => a - b) },
	};
	const current: Chip = chip ?? (recent ? "RECENT" : s.type === 1 ? "VIDEOS" : "ALL");
	for (const c of CHIPS) {
		vars[`CHIP_${c}`] = encodeToken({ k: "search", q: query, sp: encodeParams(next[c]), o: 0, reload: true, c });
		vars[`CHIP_${c}_SELECTED`] = c === current;
	}
	return vars;
}

const searchThumbs = (id: string) => [[360, 202], [720, 404]].map(([width, height]) => ({ url: `${PUBLIC_ORIGIN}/vi/${id}/hq720.jpg`, width, height }));

// a videoRenderer's values (search results, a post's video)
export function videoRendererVars(v: Video, viewer: Viewer): Vars {
	const snippet = (v.description ?? "").replace(/\s+/g, " ").trim();
	return {
		...baseVars(viewer),
		...videoVars(v),
		...(v.view_count ? {} : { VIEWS_FULL: "No views" }),
		VIEWS_SHORT: compactViews(v.view_count),
		VIEWS_SHORT_LABEL: countLabel(v.view_count, "view"),
		PUBLISHED_FULL: ago(v.published_at ?? v.created_at),
		SEARCH_THUMBS: searchThumbs(v.id),
		AVATAR_68: avatarSources(v.channel_id, [68]),
		SNIPPET: snippet.length > 160 ? `${snippet.slice(0, 157)}...` : snippet,
	};
}

function videoItem(v: Video, viewer: Viewer) {
	const vars = videoRendererVars(v, viewer);
	const item = make(`item/video_search_${viewer ? "in" : "out"}`, vars);
	if (!vars.SNIPPET) delete item.videoRenderer.detailedMetadataSnippets;
	return item;
}

// a channel's Search tab: its videos and playlists matching the query, each
// in a section of its own as YouTube sends them, 30 videos at a time; a
// video carries the start of its description (descriptionSnippet) in place
// of the search page's snippet
const CHANNEL_SEARCH_PAGE = 30;
function channelSearchVideo(v: Video, viewer: Viewer) {
	// the short forms: "4.8M", "12y ago"
	const vars = { ...videoRendererVars(v, viewer), VIEWS_SHORT: v.view_count ? compact(v.view_count) : "No views", PUBLISHED_FULL: shortAgo(v.published_at ?? v.created_at) };
	const { detailedMetadataSnippets: _, ...rest } = make(`item/video_search_${viewer ? "in" : "out"}`, vars).videoRenderer;
	const text = (v.description ?? "").trim();
	const { videoId, thumbnail, title, ...more } = rest;
	return { videoRenderer: { videoId, thumbnail, title, ...(text ? { descriptionSnippet: { runs: [{ text: text.length > 200 ? `${text.slice(0, 200).trimEnd()}...` : text }] } } : {}), ...more } };
}
export async function channelSearchSections(c: Channel, viewer: Viewer, query: string, offset: number): Promise<unknown[]> {
	const videos = await searchVideos(query, CHANNEL_SEARCH_PAGE + 1, offset, { channelId: c.id });
	const items: unknown[] = videos.slice(0, CHANNEL_SEARCH_PAGE).map((v) => channelSearchVideo(v, viewer));
	// the channel's matching playlists among the first page's videos
	if (!offset) items.splice(Math.min(items.length, 14), 0, ...(await Promise.all((await searchPlaylists(query, 10, 0, viewer, c.user_id)).map((p) => playlistSearchItem(p, viewer)))));
	const sections: unknown[] = items.map((item) => ({ itemSectionRenderer: { contents: [item] } }));
	if (videos.length > CHANNEL_SEARCH_PAGE) sections.push(make("item/continuation", { CONTINUATION: encodeToken({ k: "chsearch", c: c.id, q: query, o: offset + CHANNEL_SEARCH_PAGE }) }));
	return sections;
}

async function channelItem(c: Channel, viewer: Viewer, query: string, mutations: unknown[]) {
	const vars: Vars = {
		...baseVars(viewer, `/results?search_query=${queryUrl(query)}`),
		...channelVars(c),
		CHANNEL_URL: `/@${c.handle}`,
		AVATAR_88_176: avatarSources(c.id, [88, 176]),
		QUERY: query,
		QUERY_URL: queryUrl(query),
	};
	const item = make("item/channel_search", vars);
	const cr = item.channelRenderer;
	if (!c.description) delete cr.descriptionSnippet;
	if (!viewer) return item;
	if (viewer.channelId === c.id) {
		delete cr.subscribeButton;
		return item;
	}
	const subscribed = await isSubscribed(viewer, c.id);
	cr.subscriptionButton = { subscribed };
	cr.subscribeButton = await channelRowButton(c, vars, subscribed);
	mutations.push(...(await subscribeEntities(c, viewer, vars, subscribed)));
	return item;
}

// what the instance has nothing of: movies, live streams, purchases, and
// videos with captions, a Creative Commons licence, 360°/VR180/3D/HDR
// picture or a location
const NOTHING = [FEATURES.LIVE, FEATURES.SUBTITLES, FEATURES.CC, FEATURES["360"], FEATURES.VR180, FEATURES["3D"], FEATURES.HDR, FEATURES.LOCATION, FEATURES.PURCHASED];

// a Short in the grid shelf
const shortItem = (v: Video, viewer: Viewer) => make("item/shorts_lockup_search", shortVars(v, viewer));
const shortsShelf = (shorts: Video[], viewer: Viewer) => make("search/shorts_shelf", { ITEMS: shorts.map((v) => shortItem(v, viewer)) });

// one page of results; channels and playlists lead the first page of an
// unfiltered search, and its Shorts sit in a grid shelf after the first
// video, as YouTube lays them out. The Shorts type (and chip) is the grid
// alone, a page at a time.
async function results(query: string, s: Search, offset: number, viewer: Viewer, chip?: Chip) {
	const q = query.trim().slice(0, 200);
	const items: unknown[] = [];
	const mutations: unknown[] = [];
	if (!q) return { items, mutations, more: false };
	if (s.type === 2) {
		const chans = await searchChannels(q, PAGE, offset);
		for (const c of chans) items.push(await channelItem(c, viewer, q, mutations));
		return { items, mutations, more: chans.length === PAGE };
	}
	if (s.type === 3) {
		const lists = await searchPlaylists(q, PAGE, offset, viewer);
		for (const p of lists) items.push(await playlistSearchItem(p, viewer));
		return { items, mutations, more: lists.length === PAGE };
	}
	const features = s.features ?? [];
	if (s.type === 4 || features.some((f) => NOTHING.includes(f))) return { items, mutations, more: false };
	const unfiltered = !s.type && !s.date && !s.duration && !s.sort && !features.length;
	const opts: VideoSearch = {
		sort: s.sort === 2 ? "date" : s.sort === 3 ? "views" : "relevance",
		since: s.date ? new Date(Date.now() - SINCE[s.date]) : undefined,
		minMs: s.duration ? DURATION[s.duration][0] : undefined,
		maxMs: s.duration ? DURATION[s.duration][1] : undefined,
		minSide: features.includes(FEATURES["4K"]) ? 2160 : features.includes(FEATURES.HD) ? 720 : undefined,
		unwatchedBy: chip === "UNWATCHED" ? viewer?.userId : undefined,
		shorts: s.type === 9 ? "only" : s.type === 1 || unfiltered ? "exclude" : undefined,
	};
	const vids = await markWatched(viewer, await searchVideos(q, PAGE, offset, opts));
	if (s.type === 9) {
		// the chip shows a plain grid; the Filters dialog's Shorts, the shelf
		const grid = chip === "SHORTS" ? make("search/shorts_grid", { ITEMS: vids.map((v) => shortItem(v, viewer)) }) : shortsShelf(vids, viewer);
		return { items: vids.length ? [grid] : [], mutations, more: vids.length === PAGE };
	}
	if (offset === 0 && unfiltered) for (const c of await searchChannels(q, 2)) items.push(await channelItem(c, viewer, q, mutations));
	items.push(...vids.map((v) => videoItem(v, viewer)));
	if (offset === 0 && unfiltered) {
		const lists = await searchPlaylists(q, 2, 0, viewer);
		items.splice(Math.min(items.length, 4), 0, ...(await Promise.all(lists.map((p) => playlistSearchItem(p, viewer)))));
		const shorts = await searchVideos(q, PAGE, 0, { ...opts, shorts: "only" });
		const first = items.findIndex((it) => (it as { videoRenderer?: unknown }).videoRenderer);
		if (shorts.length) items.splice(first < 0 ? items.length : first + 1, 0, shortsShelf(shorts, viewer));
	}
	return { items, mutations, more: vids.length === PAGE };
}

const continuationItem = (query: string, s: Search, offset: number, chip?: Chip) => make("item/continuation_search", { CONTINUATION: encodeToken({ k: "search", q: query, sp: encodeParams(s), o: offset + PAGE, c: chip }) });

const withMutations = (mutations: unknown[]) => (mutations.length ? { frameworkUpdates: { entityBatchUpdate: { mutations, timestamp: { seconds: String(Math.floor(Date.now() / 1000)), nanos: 0 } } } } : {});

async function searchResponse(query: string, s: Search, viewer: Viewer, chip?: Chip) {
	const r = await results(query, s, 0, viewer, chip);
	const page = make(`search/page_${viewer ? "in" : "out"}`, {
		...headerVars(query, s, chip),
		ESTIMATED: String(r.items.length),
		ITEMS: r.items.length ? r.items : [make("item/no_results", {})],
		CONTINUATION_ITEM: r.more ? continuationItem(query, s, 0, chip) : null,
	});
	const sl = page.contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer;
	sl.contents = sl.contents.filter(Boolean);
	return { page, mutations: r.mutations };
}

route("search", async ({ body, viewer }) => {
	if (body.continuation) {
		const t = decodeToken<{ k: string; q: string; sp: string; o: number; reload?: boolean; c?: string }>(body.continuation);
		if (!t || t.k !== "search") throw new ApiError(400, "Invalid continuation");
		const s = decodeParams(t.sp);
		const chip = CHIPS.find((c) => c === t.c);
		if (t.reload) {
			// a chip: new results and a new header in place
			const { page, mutations } = await searchResponse(t.q, s, viewer, chip);
			return { responseContext: responseContext(viewer), ...make<object>("search/reload", { ESTIMATED: page.estimatedResults, BODY: page.contents, HEADER: page.header }), ...withMutations(mutations) };
		}
		const r = await results(t.q, s, t.o, viewer, chip);
		const items: unknown[] = [{ itemSectionRenderer: { contents: r.items } }];
		if (r.more) items.push(continuationItem(t.q, s, t.o, chip));
		return { responseContext: responseContext(viewer), onResponseReceivedCommands: [{ appendContinuationItemsAction: { continuationItems: items, targetId: "search-feed" } }], ...withMutations(r.mutations) };
	}
	const query = String(body.query ?? "");
	const { page, mutations } = await searchResponse(query, decodeParams(body.params), viewer);
	return { responseContext: responseContext(viewer), ...page, ...withMutations(mutations), topbar: topbar(viewer, `/results?search_query=${queryUrl(query)}`) };
});

export async function searchPage(url: URL, viewer: Viewer): Promise<PageData | Response> {
	const query = url.searchParams.get("search_query") ?? url.searchParams.get("q") ?? "";
	if (!query.trim()) return Response.redirect("/", 302);
	const s = decodeParams(url.searchParams.get("sp"));
	const sp = encodeParams(s);
	const path = `/results?search_query=${queryUrl(query)}${sp ? `&sp=${sp}` : ""}`;
	const { page, mutations } = await searchResponse(query, s, viewer);
	return {
		kind: "results",
		url: url.pathname + url.search,
		title: query,
		initialData: { responseContext: responseContext(viewer), ...page, ...withMutations(mutations), topbar: topbar(viewer, path) },
		command: { commandMetadata: { webCommandMetadata: { url: path, webPageType: "WEB_PAGE_TYPE_SEARCH", rootVe: 4724 } }, searchEndpoint: { query, ...(sp ? { params: sp } : {}) } },
	};
}

// /complete/search?client=youtube&q=...: the search box's suggestions, as
// JSONP for the callback it names (or JSON). Titles and channel names that
// contain the text typed so far, those starting with it first.
export async function suggest(url: URL): Promise<Response> {
	const q = (url.searchParams.get("q") ?? "").trim().slice(0, 100);
	const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
	const rows = q
		? await sql`select lower(title) as s from videos where playable and visibility = 'public' and deleted_at is null and title ilike ${like}
			union select lower(title) from channels where title ilike ${like}
			order by 1 limit 20`
		: [];
	const list = rows.map((r: { s: string }) => r.s).sort((a: string, b: string) => Number(!a.startsWith(q.toLowerCase())) - Number(!b.startsWith(q.toLowerCase()))).slice(0, 10);
	const payload = [q, list.map((s: string) => [s, 0, [512, 433]]), { k: 1, q: "" }];
	const cb = url.searchParams.get("callback");
	if (cb && /^[\w.$]{1,64}$/.test(cb)) return new Response(`${cb}(${JSON.stringify(payload)})`, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" } });
	return new Response(JSON.stringify(payload), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}
