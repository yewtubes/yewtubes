// Channel pages, built from YouTube's channel responses (templates channel/*):
// the page header, the tab strip, the Home shelves, the Videos and Shorts
// grids with their Latest/Popular/Oldest chips, the Playlists grid and the
// About panel.

import type { Viewer } from "../client/page";
import { PUBLIC_ORIGIN } from "../config";
import { channelVideos, getVideo, isSubscribed, markWatched } from "../data";
import { encodeToken } from "../ids";
import { channelPlaylistLockups, getPlaylist, playlistVideos } from "./playlists";
import { type ShelfDefinition, savedShelves } from "../home-layout";
import { type Channel, type Video, dateText, grouped, urlEndpoint } from "./r";
import { channelTabFromParams } from "./proto";
import { make, tpl, fill, type Vars } from "./tpl";
import { baseVars, channelVars, videoVars } from "./vars";
import { subscribeAction } from "./subscribe";
import { shortLockup } from "./feeds";
import { hasPosts, postsShelf, postsTab } from "./posts";

export const CHANNEL_PAGE = 30;
export type ChannelTab = "featured" | "videos" | "shorts" | "playlists" | "posts";
export type GridKind = "videos" | "shorts";
export type ChannelSort = "newest" | "popular" | "oldest";

// tab from the client's params blob ({2: "videos", ...}); none means Home
export function channelTab(params: string | undefined): ChannelTab {
	const t = channelTabFromParams(params);
	return t === "videos" || t === "shorts" || t === "playlists" || t === "posts" ? t : "featured";
}

// the params YouTube uses for each tab (constant across channels)
export function tabParams(tab: ChannelTab): string {
	const page = tpl("channel/page");
	return page.tabs[tab].tabRenderer.endpoint.browseEndpoint.params;
}

const gridTarget = (c: Channel, kind: GridKind) => `browse-feed${c.id}${kind}`;

export async function videoGridItems(c: Channel, viewer: Viewer, offset: number, sort: ChannelSort, kind: GridKind = "videos"): Promise<unknown[]> {
	const videos = await markWatched(viewer, await channelVideos(c.id, viewer, CHANNEL_PAGE, offset, sort, kind));
	const items: unknown[] = videos.map((v) => (kind === "shorts" ? shortLockup(v, viewer) : make("item/video_lockup_channel", { ...baseVars(viewer, `/@${c.handle}/videos`), ...videoVars(v) })));
	if (videos.length === CHANNEL_PAGE) items.push(make("item/continuation", { CONTINUATION: encodeToken({ k: "chvideos", c: c.id, o: offset + CHANNEL_PAGE, s: sort, f: kind }) }));
	return items;
}

function sortVars(c: Channel, sort: ChannelSort, kind: GridKind): Vars {
	const token = (s: ChannelSort) => encodeToken({ k: "chvideos", c: c.id, o: 0, s, f: kind, reload: true });
	return {
		SORT_LATEST: token("newest"),
		SORT_POPULAR: token("popular"),
		SORT_OLDEST: token("oldest"),
		SELECTED_LATEST: sort === "newest",
		SELECTED_POPULAR: sort === "popular",
		SELECTED_OLDEST: sort === "oldest",
		TARGET_ID: gridTarget(c, kind),
	};
}

// a chip tap: new chip bar (header slot) and the re-sorted grid (body slot)
export async function videoGridReload(c: Channel, viewer: Viewer, sort: ChannelSort, kind: GridKind = "videos") {
	return make("channel/videos_reload", { ...channelVars(c), ...sortVars(c, sort, kind), ITEMS: await videoGridItems(c, viewer, 0, sort, kind) });
}

// a description as runs, its web links made links
export function descriptionRuns(text: string) {
	return text.split(/(https?:\/\/[^\s]+)/).filter(Boolean).map((t) => (/^https?:\/\//.test(t) ? { text: t, navigationEndpoint: urlEndpoint(t, true) } : { text: t }));
}

// the Home tab's spotlight, as Studio's Layout sets it: the featured video
// for returning subscribers, the trailer for everyone else
async function spotlight(c: Channel, viewer: Viewer, vars: Vars) {
	const subscribed = viewer && viewer.channelId !== c.id ? await isSubscribed(viewer, c.id) : false;
	const id = subscribed ? c.featured_video_id : c.trailer_video_id;
	const v = id ? await getVideo(id, viewer) : undefined;
	if (!v || v.visibility !== "public") return undefined;
	const title = (subscribed && c.featured_video_title) || v.title;
	const vv = videoVars(v as Video);
	return make("channel/video_player", { ...vars, ...vv, TITLE: title, TITLE_DURATION_LABEL: `${title} ${vv.DURATION_LABEL}`, DESCRIPTION_RUNS: v.description ? { runs: descriptionRuns(v.description) } : undefined });
}

// a shelf of the channel's videos, titled and linked to its Videos tab
async function videoShelf(c: Channel, viewer: Viewer, vars: Vars, title: string, sort: ChannelSort) {
	const videos = await markWatched(viewer, await channelVideos(c.id, viewer, 12, 0, sort));
	if (!videos.length) return undefined;
	return make("channel/home_shelf", { ...vars, SHELF_TITLE: title, SHELF_PARAMS: tabParams("videos"), ITEMS: videos.map((v) => make("item/video_lockup_shelf", { ...vars, ...videoVars(v) })) });
}

async function shortsShelf(c: Channel, viewer: Viewer) {
	const shorts = await channelVideos(c.id, viewer, 12, 0, "newest", "shorts");
	return shorts.length ? make("channel/shorts_shelf", { ITEMS: shorts.map((v) => (shortLockup(v, viewer) as { richItemRenderer: { content: unknown } }).richItemRenderer.content) }) : undefined;
}

// For You: the channel's videos the viewer hasn't watched, YouTube's home
// ranking (views, then how recent), Shorts and long videos as the section
// asks
async function forYouShelf(c: Channel, viewer: Viewer, vars: Vars, f: { includeLongFormVideos?: boolean; includeShorts?: boolean; contentRecency?: string }) {
	const recent = f.contentRecency === "FOR_YOU_CONTENT_RECENCY_RECENT_ONLY";
	const pick = async (kind: GridKind) => (await channelVideos(c.id, viewer, 24, 0, recent ? "newest" : "popular", kind)).slice(0, 12);
	const videos = await markWatched(viewer, [...(f.includeLongFormVideos !== false ? await pick("videos") : []), ...(f.includeShorts !== false && f.includeLongFormVideos === false ? await pick("shorts") : [])]);
	const fresh = videos.filter((v) => !v.watched_ms);
	const list = (fresh.length ? fresh : videos).slice(0, 12);
	if (!list.length) return undefined;
	return make("channel/home_shelf", { ...vars, SHELF_TITLE: "For You", SHELF_PARAMS: tabParams("videos"), ITEMS: list.map((v) => make("item/video_lockup_shelf", { ...vars, ...videoVars(v) })) });
}

// playlists as a shelf of playlist lockups, linked to the Playlists tab
async function playlistsShelf(c: Channel, viewer: Viewer, vars: Vars, title: string, ids?: string[]) {
	let lockups = await channelPlaylistLockups(c, viewer);
	if (ids) {
		const byId = new Map(lockups.map((l) => [String(JSON.stringify(l).match(/"contentId":"([^"]+)"/)?.[1]), l]));
		lockups = ids.map((id) => byId.get(id)).filter(Boolean) as typeof lockups;
	}
	if (!lockups.length) return undefined;
	return make("channel/home_shelf", { ...vars, SHELF_TITLE: title || "Created playlists", SHELF_PARAMS: tabParams("playlists"), ITEMS: lockups });
}

// one playlist's videos, titled with the playlist and its Play all
async function playlistShelf(viewer: Viewer, vars: Vars, id: string) {
	const p = await getPlaylist(id, viewer);
	if (!p || p.visibility === "private") return undefined;
	const videos = await markWatched(viewer, await playlistVideos(p, viewer, 12, 0));
	if (!videos.length) return undefined;
	return make("channel/playlist_shelf", { ...vars, PLAYLIST_ID: p.id, SHELF_TITLE: p.title, FIRST_VIDEO_ID: videos[0].id, ITEMS: videos.map((v) => make("item/video_lockup_shelf", { ...vars, ...videoVars(v) })) });
}

async function section(c: Channel, viewer: Viewer, vars: Vars, d: ShelfDefinition) {
	if ("playlistShelfDefinition" in d) return playlistShelf(viewer, vars, d.playlistShelfDefinition.playlistId);
	if ("playlistCollectionShelfDefinition" in d) return playlistsShelf(c, viewer, vars, d.playlistCollectionShelfDefinition.title, d.playlistCollectionShelfDefinition.playlistIds);
	if (!("predefinedShelfDefinition" in d)) return undefined;
	const { type, forYouShelfInfo } = d.predefinedShelfDefinition;
	if (type === "SHELF_TYPE_FOR_YOU") return forYouShelf(c, viewer, vars, forYouShelfInfo ?? {});
	if (type === "SHELF_TYPE_RECENT_UPLOADS") return videoShelf(c, viewer, vars, "Videos", "newest");
	if (type === "SHELF_TYPE_POPULAR_UPLOADS") return videoShelf(c, viewer, vars, "Popular videos", "popular");
	if (type === "SHELF_TYPE_SHORT_MOBILE_VIDEOS_UPLOADS") return shortsShelf(c, viewer);
	if (type === "SHELF_TYPE_CREATED_PLAYLISTS") return playlistsShelf(c, viewer, vars, "Created playlists");
	if (type === "SHELF_TYPE_RECENT_POSTS") return postsShelf(c, viewer, vars);
	// live streams, collaborations, clips: the instance has none yet
	return undefined;
}

async function homeTab(c: Channel, viewer: Viewer, vars: Vars) {
	const saved = savedShelves(c.home_shelves);
	const sections = [await spotlight(c, viewer, vars)];
	if (saved) for (const d of saved) sections.push(await section(c, viewer, vars, d));
	// the default layout: newest videos, popular ones once there are a few,
	// then YouTube's Shorts shelf
	else sections.push(await videoShelf(c, viewer, vars, "Videos", "newest"), c.video_count > 4 ? await videoShelf(c, viewer, vars, "Popular videos", "popular") : undefined, await shortsShelf(c, viewer), await postsShelf(c, viewer, vars));
	return { sectionListRenderer: make("channel/home_sections", { ...vars, SECTIONS: sections.filter(Boolean), TARGET_ID: `browse-feed${c.id}featured` }) };
}

async function playlistsTab(c: Channel, viewer: Viewer, vars: Vars) {
	return { sectionListRenderer: make("channel/playlists_sections", { ...vars, ITEMS: await channelPlaylistLockups(c, viewer), TARGET_ID: `browse-feed${c.id}playlists` }) };
}

// a link as YouTube writes it beside a channel: no scheme, no trailing slash
const linkText = (url: string) => url.replace(/^https?:\/\//, "").replace(/\/$/, "");
const linkCommand = (url: string) => ({
	innertubeCommand: { commandMetadata: { webCommandMetadata: { url, webPageType: "WEB_PAGE_TYPE_UNKNOWN", rootVe: 83769 } }, urlEndpoint: { url, target: "TARGET_NEW_WINDOW", nofollow: true } },
});

export async function channelHeader(c: Channel, viewer: Viewer, vars: Vars) {
	// the header names the first link (the About panel lists them all)
	const first = c.links[0];
	const shown = first ? linkText(first.url) : "";
	const more = c.links.length > 1 ? ` and ${c.links.length - 1} more link${c.links.length > 2 ? "s" : ""}` : "";
	// link and banner parts are removed below when the channel has none
	const header = make("channel/header", { ...vars, VIDEO_COUNT_LENGTH: String(vars.VIDEO_COUNT).length, ABOUT_CONTINUATION: encodeToken({ k: "about", c: c.id }), ABOUT_TARGET: aboutTarget(c), LINK_TEXT: `${shown}${more}`, LINK_TEXT_LENGTH: shown.length + 1, LINK_URL: first?.url ?? "", BANNER: [] });
	const ph = header.content.pageHeaderViewModel;
	if (!c.banner_path) delete ph.banner;
	else ph.banner.imageBannerViewModel.image.sources = [1060, 1138, 1707, 2120, 2276, 2560].map((w) => ({ url: `${PUBLIC_ORIGIN}/ggpht/${c.id}/banner=w${w}-fcrop64=1,00005a57ffffa5a8-k-c0xffffffff-no-nd-rj`, width: w, height: Math.round((w * 424) / 2560) }));
	if (!first) delete ph.attribution;
	if (!c.description) delete ph.description;
	// signed in: the real subscribe button (or the owner's buttons) in place of the sign-in modal
	const action = await subscribeAction(c, viewer, vars);
	if (action) {
		ph.actions.flexibleActionsViewModel.actionsRows[0].actions = action.actions;
		return { header: { pageHeaderRenderer: header }, mutations: action.mutations };
	}
	return { header: { pageHeaderRenderer: header }, mutations: [] as unknown[] };
}

export async function channelPage(c: Channel, tab: ChannelTab, viewer: Viewer) {
	// with the Home tab turned off in Studio, the channel opens on its first other tab
	const hasPlaylists = (await channelPlaylistLockups(c, viewer)).length > 0;
	const has = async (kind: GridKind) => (await channelVideos(c.id, viewer, 1, 0, "newest", kind)).length > 0;
	// the owner always has Posts (its composer); others once there is a post
	const posts = viewer?.channelId === c.id || (await hasPosts(c.id));
	const available: ChannelTab[] = [...(c.home_tab_enabled === false ? [] : ["featured" as const]), ...((await has("videos")) ? ["videos" as const] : []), ...((await has("shorts")) ? ["shorts" as const] : []), ...(hasPlaylists ? ["playlists" as const] : []), ...(posts ? ["posts" as const] : [])];
	if (tab === "featured" && !available.includes("featured")) tab = available[0] ?? "featured";
	const path = `/@${c.handle}${tab === "featured" ? "" : `/${tab}`}`;
	const vars = { ...baseVars(viewer, path), ...channelVars(c) };
	const page = make("channel/page", vars);
	let content: unknown;
	if (tab === "videos") content = { richGridRenderer: make("channel/videos_grid", { ...vars, ...sortVars(c, "newest", "videos"), ITEMS: await videoGridItems(c, viewer, 0, "newest") }) };
	else if (tab === "shorts") content = { richGridRenderer: make("channel/shorts_grid", { ...sortVars(c, "newest", "shorts"), ITEMS: await videoGridItems(c, viewer, 0, "newest", "shorts") }) };
	else if (tab === "playlists") content = await playlistsTab(c, viewer, vars);
	else if (tab === "posts") content = await postsTab(c, viewer);
	else content = await homeTab(c, viewer, vars);
	// YouTube lists only the tabs a channel has content for
	const show: string[] = [...(available.includes(tab) ? available : [tab, ...available]), "search"];
	const tabs = show.map((name) => {
		const t = page.tabs[name];
		if (name === tab) Object.assign(t.tabRenderer, { selected: true, content });
		return t;
	});
	const { header, mutations } = await channelHeader(c, viewer, vars);
	return {
		path,
		response: {
			contents: { twoColumnBrowseResultsRenderer: { tabs } },
			header,
			metadata: page.metadata,
			microformat: page.microformat,
			...(mutations.length ? { frameworkUpdates: { entityBatchUpdate: { mutations, timestamp: { seconds: String(Math.floor(Date.now() / 1000)), nanos: 0 } } } } : {}),
		},
	};
}

// the About dialog's content, appended to the dialog's section by this id
const aboutTarget = (c: Channel) => `about-${c.id}`;
export async function aboutPanel(c: Channel, viewer: Viewer) {
	const [{ views }] = await (await import("../db")).sql`select coalesce(sum(view_count), 0)::bigint as views from videos where channel_id = ${c.id} and deleted_at is null and visibility = 'public' and playable`;
	const joined = `Joined ${dateText(c.created_at)}`;
	const r = make("channel/about", {
		...baseVars(viewer, `/@${c.handle}`),
		...channelVars(c),
		VIEW_COUNT: `${grouped(Number(views))} views`,
		JOINED: joined,
		JOINED_LENGTH: joined.length,
		ABOUT_TARGET: aboutTarget(c),
		COUNTRY: "",
		LINKS: c.links.map((l) => {
			const shown = linkText(l.url);
			return { channelExternalLinkViewModel: { title: { content: l.title }, link: { content: shown, commandRuns: [{ startIndex: 0, length: shown.length, onTap: linkCommand(l.url) }] } } };
		}),
	});
	const avm = fill(r, {}).onResponseReceivedEndpoints[0].appendContinuationItemsAction.continuationItems[0].aboutChannelRenderer.metadata.aboutChannelViewModel;
	delete avm.country;
	// the channel's address on this site, as YouTube shows its own (no scheme)
	avm.displayCanonicalChannelUrl = `${new URL(PUBLIC_ORIGIN).host}/@${c.handle}`;
	if (!c.links.length) {
		delete avm.links;
		delete avm.customLinksLabel;
	}
	return r;
}

export { isSubscribed };
