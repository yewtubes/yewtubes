// /youtubei/v1/browse: home, subscriptions, history, You, channels, playlist
// pages, and the same responses as ytInitialData for direct page loads.
//
// Continuations are signed tokens (ids.ts encodeToken); the client sends
// them back verbatim, so their contents are ours to choose.

import type { PageData, PageKind, Viewer } from "../client/page";
import { type HomeFilter, getChannel } from "../data";
import { decodeToken, encodeToken, isChannelId } from "../ids";
import { topbar } from "./chrome";
import { homeChipReload, homeItems, homePage, subscriptionShortsItems, subscriptionShortsPage, subscriptionsItems, subscriptionsPage } from "./feeds";
import { notificationsInbox } from "./guide";
import { historyContinuation, historyPage } from "./history";
import { channelsPage, channelsReload, playlistsPage, playlistsReload, youPage } from "./library";
import { playlistBrowse } from "./playlists";
import { type Channel, browseEndpoint, responseContext, runs } from "./r";
import { ApiError, route } from "./router";
import { recordMiss } from "../diagnostics";
import { aboutPanel, type ChannelSort, type ChannelTab, channelPage, channelsPanel, channelTab, tabParams, videoGridItems, videoGridReload } from "./channel";
import { SETTINGS_PAGES, SETTINGS_PATHS, settingsPage } from "./settings";
import { signInUrl } from "./vars";
import { CREATE_POST_PARAMS } from "./post-composer";
import { createDialogFromParams, scheduledPostsFromParams, withScheduledPosts } from "./proto";
import { postCommand, postIdFromParams, postPage, postParams, postsContinuation } from "./posts";
import { sql } from "../db";

// the browse command for a channel tab, as the tab strip's endpoints have it
function channelCommand(c: Channel, tab: ChannelTab) {
	return { commandMetadata: { webCommandMetadata: { url: `/@${c.handle}${tab === "featured" ? "" : `/${tab}`}`, webPageType: "WEB_PAGE_TYPE_CHANNEL", rootVe: 3611, apiUrl: "/youtubei/v1/browse" } }, browseEndpoint: { browseId: c.id, ...(tab === "featured" ? {} : { params: tabParams(tab) }), canonicalBaseUrl: `/@${c.handle}` } };
}

export const PAGE = 24;

export type BrowseResult = { response: Record<string, unknown>; kind: PageKind; title: string; url: string; command: unknown };

const appendAction = (items: unknown[], targetId: string) => ({ appendContinuationItemsAction: { continuationItems: items, targetId } });

// ---- feeds ----

async function home(viewer: Viewer): Promise<BrowseResult> {
	return { kind: "home", title: "", url: "/", command: browseEndpoint("FEwhat_to_watch", "/"), response: await homePage(viewer) };
}

async function subscriptions(viewer: Viewer): Promise<BrowseResult> {
	return { kind: "home", title: "Subscriptions", url: "/feed/subscriptions", command: browseEndpoint("FEsubscriptions", "/feed/subscriptions", "WEB_PAGE_TYPE_BROWSE", 96368), response: await subscriptionsPage(viewer) };
}

async function subscriptionShorts(viewer: Viewer): Promise<BrowseResult> {
	return { kind: "home", title: "Shorts", url: "/feed/subscriptions/shorts", command: browseEndpoint("FEsubscriptions_shorts", "/feed/subscriptions/shorts", "WEB_PAGE_TYPE_BROWSE", 6827), response: await subscriptionShortsPage(viewer) };
}

async function history(viewer: Viewer, params?: string, query?: string): Promise<BrowseResult> {
	return { kind: "home", title: "History", url: "/feed/history", command: browseEndpoint("FEhistory", "/feed/history", "WEB_PAGE_TYPE_BROWSE", 6827), response: await historyPage(viewer, params, query) };
}

async function library(viewer: Viewer): Promise<BrowseResult> {
	return { kind: "home", title: "You", url: "/feed/you", command: browseEndpoint("FElibrary", "/feed/you", "WEB_PAGE_TYPE_BROWSE", 6827), response: await youPage(viewer) };
}

// signed out, YouTube sends these two to sign in (direct loads redirect;
// in-app navigation gets the You page's sign-in prompt)
async function playlistsFeed(viewer: Viewer, params?: string): Promise<BrowseResult> {
	const base = { kind: "home" as const, title: "Playlists", url: "/feed/playlists", command: browseEndpoint("FEplaylist_aggregation", "/feed/playlists", "WEB_PAGE_TYPE_BROWSE", 6827) };
	return { ...base, response: viewer ? await playlistsPage(viewer, params) : await youPage(null) };
}

async function channelsFeed(viewer: Viewer): Promise<BrowseResult> {
	const base = { kind: "home" as const, title: "All subscriptions", url: "/feed/channels", command: browseEndpoint("FEchannels", "/feed/channels", "WEB_PAGE_TYPE_BROWSE", 6827) };
	return { ...base, response: viewer ? await channelsPage(viewer) : await youPage(null) };
}

// ---- dispatch ----

export async function buildBrowse(browseId: string, params: string | undefined, viewer: Viewer, query?: string): Promise<BrowseResult | undefined> {
	if (browseId === "FEwhat_to_watch") return home(viewer);
	if (browseId === "FEsubscriptions") return subscriptions(viewer);
	if (browseId === "FEsubscriptions_shorts") return subscriptionShorts(viewer);
	if (browseId === "FEhistory") return history(viewer, params, query);
	if (browseId === "FElibrary" || browseId === "FEyou") return library(viewer);
	if (browseId === "FEplaylist_aggregation") return playlistsFeed(viewer, params);
	if (browseId === "FEchannels") return channelsFeed(viewer);
	if (browseId.startsWith("VL")) return playlistBrowse(browseId.slice(2), viewer);
	if (browseId === "FEpost_detail") {
		const id = postIdFromParams(params);
		const r = id ? await postPage(id, viewer) : undefined;
		if (!r) return undefined;
		return { kind: "channel", title: r.channel.title, url: `/post/${r.post.id}`, command: postCommand(r.post.id, r.post.channel_id), response: r.response };
	}
	// settings pages (the signed-in client prefetches SPaccount_downloads);
	// signed out, YouTube answers 401 and direct loads go to sign-in
	if (browseId in SETTINGS_PAGES) {
		if (!viewer) throw new ApiError(401, "You must be signed in to perform this operation.", "unauthorized");
		return { kind: "settings", title: "Settings", ...(await settingsPage(browseId, viewer)) };
	}
	if (isChannelId(browseId)) {
		const c = await getChannel({ id: browseId });
		if (!c) return undefined;
		const tab = channelTab(params);
		const r = await channelPage(c, tab, viewer, tab === "posts" ? { openComposer: createDialogFromParams(params), scheduledPosts: scheduledPostsFromParams(params) } : {});
		return { kind: "channel", title: c.title, url: r.path, command: channelCommand(c, tab), response: r.response };
	}
	return undefined;
}

const homeFilter = (f: unknown): HomeFilter => (f === "recent" || f === "watched" || f === "new" ? f : "all");

async function continuation(token: string, viewer: Viewer) {
	const t = decodeToken<{ k: string; o: number; c?: string; s?: ChannelSort; reload?: boolean; p?: string; q?: string; f?: string; v?: string; i?: number; t?: string }>(token);
	if (!t) throw new ApiError(400, "Invalid continuation");
	let items: unknown[] = [];
	let target = "";
	if (t.k === "home") [items, target] = [await homeItems(viewer, t.o, homeFilter(t.f)), "browse-feedFEwhat_to_watch"];
	else if (t.k === "homechip") return { responseContext: responseContext(viewer), onResponseReceivedActions: [await homeChipReload(viewer, homeFilter(t.f))] };
	else if (t.k === "subs") [items, target] = [await subscriptionsItems(viewer, t.o), "browse-feedFEsubscriptions"];
	else if (t.k === "subshorts") [items, target] = [await subscriptionShortsItems(viewer, t.o), "browse-feedFEsubscriptions_shorts"];
	else if (t.k === "history") return historyContinuation(viewer, t.o, t.q, t.f);
	else if (t.k === "plfeed" || t.k === "chfeed") {
		if (!viewer) throw new ApiError(401, "Sign in to do this.", "authError");
		return t.k === "plfeed" ? playlistsReload(viewer, { k: "plfeed", s: Number(t.s) || 0, f: t.f }) : channelsReload(viewer, Number(t.s) || 0);
	}
	else if ((t.k === "chvideos" || t.k === "about" || t.k === "chchannels") && t.c) {
		const c = await getChannel({ id: t.c });
		if (!c) throw new ApiError(404, "Not found");
		if (t.k === "about") return { responseContext: responseContext(viewer), ...(await aboutPanel(c, viewer)) };
		if (t.k === "chchannels") return { responseContext: responseContext(viewer), ...(await channelsPanel(c, viewer, Number(t.i) || 0, String(t.t ?? ""))) };
		const kind = t.f === "shorts" ? "shorts" : "videos";
		if (t.reload) return { responseContext: responseContext(viewer), ...(await videoGridReload(c, viewer, t.s ?? "newest", kind)) };
		items = await videoGridItems(c, viewer, t.o, t.s ?? "newest", kind);
		target = `browse-feed${c.id}${kind}`;
	} else if (t.k === "posts" && t.c) return postsContinuation(t.c, t.o, viewer, t.v === "scheduled" ? "scheduled" : "published");
	else if (t.k === "comments" || t.k === "replies") {
		// the Shorts player's comments panel and a post's comments
		const { commentsContinuation } = await import("./comments");
		return commentsContinuation(t as unknown as { v: string; s?: string; o?: number; k: string; t?: string }, viewer);
	} else if (t.k === "playlist" && t.p) {
		const { playlistItemsContinuation } = await import("./playlists");
		return playlistItemsContinuation(t.p, t.o, viewer);
	} else throw new ApiError(400, "Unknown continuation");
	return { responseContext: responseContext(viewer), onResponseReceivedActions: [appendAction(items, target)] };
}

route("browse", async ({ body, viewer }) => {
	if (body.continuation) return continuation(body.continuation, viewer);
	const id = String(body.browseId ?? "");
	if (id === "FEnotifications_inbox") return notificationsInbox(viewer);
	const r = await buildBrowse(id, body.params, viewer, typeof body.query === "string" ? body.query : undefined);
	if (!r) {
		recordMiss(`youtubei browse:${id.replace(/^(UC|VLPL|PL)[\w-]+$/, "$1*")}`, JSON.stringify({ browseId: id, params: body.params }));
		throw new ApiError(404, "Requested entity was not found.", "notFound");
	}
	return { responseContext: responseContext(viewer), ...r.response, topbar: topbar(viewer, r.url) };
});

// ---- direct page loads ----

export async function resolvePath(url: URL): Promise<{ browseId: string; params?: string } | undefined> {
	const p = url.pathname.replace(/\/$/, "") || "/";
	const feeds: Record<string, string> = { "/": "FEwhat_to_watch", "/feed/subscriptions": "FEsubscriptions", "/feed/subscriptions/shorts": "FEsubscriptions_shorts", "/feed/history": "FEhistory", "/feed/you": "FElibrary", "/feed/library": "FElibrary", "/feed/playlists": "FEplaylist_aggregation", "/feed/channels": "FEchannels" };
	if (feeds[p]) return { browseId: feeds[p] };
	if (SETTINGS_PATHS[p]) return { browseId: SETTINGS_PATHS[p] };
	if (p === "/playlist") {
		const list = url.searchParams.get("list");
		return list ? { browseId: `VL${list}` } : undefined;
	}
	const post = /^\/post\/(Ugkx[A-Za-z0-9_-]{32})$/.exec(p);
	if (post) {
		const [found] = await sql`select id, channel_id from posts where id = ${post[1]} and deleted_at is null`;
		return found ? { browseId: "FEpost_detail", params: postParams(found.id, found.channel_id) } : undefined;
	}
	const m = /^\/(?:@([A-Za-z0-9._-]{3,30})|channel\/(UC[A-Za-z0-9_-]{22}))(?:\/(featured|videos|shorts|playlists|posts|community))?$/.exec(decodeURIComponent(p));
	if (m) {
		const c = await getChannel(m[1] ? { handle: m[1] } : { id: m[2] });
		if (!c) return undefined;
		const tab = m[3] === "community" ? "posts" : m[3];
		// the Create menu's "Create post" opens the composer (the params YouTube's own link carries)
		if (tab === "posts" && url.searchParams.get("show_create_dialog") === "1") return { browseId: c.id, params: CREATE_POST_PARAMS };
		if (tab === "posts" && url.searchParams.get("view") === "scheduled") return { browseId: c.id, params: withScheduledPosts(tabParams("posts")) };
		return { browseId: c.id, params: tab ? tabParams(tab as ChannelTab) : undefined };
	}
	return undefined;
}

export async function browsePage(url: URL, viewer: Viewer): Promise<PageData | Response | undefined> {
	const target = await resolvePath(url);
	if (!target) return undefined;
	if (!viewer && (target.browseId === "FEplaylist_aggregation" || target.browseId === "FEchannels" || target.browseId in SETTINGS_PAGES)) return Response.redirect(signInUrl(url.pathname), 302);
	const r = await buildBrowse(target.browseId, target.params, viewer);
	if (!r) return undefined;
	return {
		kind: r.kind,
		url: url.pathname + url.search,
		title: r.title,
		initialData: { responseContext: responseContext(viewer), ...r.response, topbar: topbar(viewer, url.pathname + url.search) },
		command: r.command,
	};
}

// in-app navigation to a URL the client can't map itself (typed /@handle links)
route("navigation/resolve_url", async ({ body }) => {
	const raw = String(body.url ?? "");
	let u: URL;
	try {
		u = new URL(raw, "http://x");
	} catch {
		throw new ApiError(400, "Bad URL");
	}
	const target = await resolvePath(u);
	if (target) {
		const r = await buildBrowse(target.browseId, target.params, null);
		if (r) return { endpoint: r.command };
	}
	if (u.pathname === "/watch" && u.searchParams.get("v")) return { endpoint: { commandMetadata: { webCommandMetadata: { url: u.pathname + u.search, webPageType: "WEB_PAGE_TYPE_WATCH", rootVe: 3832 } }, watchEndpoint: { videoId: u.searchParams.get("v") } } };
	throw new ApiError(404, "Not found", "notFound");
});

