// Playlists: user playlists (PL...), Watch later (WL, a stored playlist per
// account) and Liked videos (LL, derived from likes). Pages, the watch-page
// playlist panel, the "Save to playlist" sheet and the edit endpoints.

import { fill, find, make, tpl, type Vars } from "./tpl";
import { baseVars, videoVars } from "./vars";
import { viewerVars } from "./chrome";
import type { Viewer } from "../client/page";
import { PUBLIC_ORIGIN } from "../config";
import { type Channel, type Video, avatarUrl, compact, grouped, lockupSources, shortAgo, videoThumbnails, content, duration, durationLabel, playlistEndpoint, plural, responseContext, runs, serviceEndpoint, text, watchEndpoint } from "./r";
import { sql, textArray } from "../db";
import { encodeToken, isVideoId, newPlaylistId, randomId } from "../ids";
import { continuationItem } from "./items";
import { panel } from "./panels";
import { ApiError, route } from "./router";
import type { BrowseResult } from "./browse";

const PAGE = 100;

type Playlist = { id: string; user_id: string; title: string; description: string; visibility: "public" | "unlisted" | "private"; video_order: number; kind: "user" | "watch_later" | "liked"; updated_at: Date; video_count: number; first_video: string | null; owner_channel: string; owner_title: string; owner_handle: string };

const VIDEO_COLUMNS = sql`v.id, v.title, v.description, v.channel_id, c.title as channel_title, c.handle as channel_handle, c.avatar_path as channel_avatar,
	v.duration_ms, v.view_count::int as view_count, v.like_count, v.comment_count, v.published_at, v.created_at, v.visibility, v.status, v.width, v.height, v.category_id`;
// entries a viewer may see in a playlist
const PLAYABLE = (viewer: Viewer) => sql`v.deleted_at is null and v.playable and (v.visibility <> 'private' or v.channel_id = ${viewer?.channelId ?? ""})`;

async function watchLaterId(viewer: NonNullable<Viewer>): Promise<string> {
	const [row] = await sql`select id from playlists where user_id = ${viewer.userId} and kind = 'watch_later'`;
	if (row) return row.id;
	const id = `WL${randomId(32)}`;
	await sql`insert into playlists (id, user_id, title, kind, visibility) values (${id}, ${viewer.userId}, 'Watch later', 'watch_later', 'private') on conflict do nothing`;
	const [again] = await sql`select id from playlists where user_id = ${viewer.userId} and kind = 'watch_later'`;
	return again.id;
}

// resolves the client's ids: WL and LL are the viewer's own lists
async function getPlaylist(id: string, viewer: Viewer): Promise<Playlist | undefined> {
	if (id === "LL") {
		if (!viewer) return undefined;
		const [r] = await sql`select count(*)::int as n, (select video_id from video_reactions where user_id = ${viewer.userId} and kind = 'like' order by created_at desc limit 1) as first from video_reactions where user_id = ${viewer.userId} and kind = 'like'`;
		return { id: "LL", user_id: viewer.userId, title: "Liked videos", description: "", visibility: "private", video_order: 0, kind: "liked", updated_at: new Date(), video_count: r.n, first_video: r.first, owner_channel: viewer.channelId, owner_title: viewer.title, owner_handle: viewer.handle };
	}
	const real = id === "WL" ? (viewer ? await watchLaterId(viewer) : undefined) : id;
	if (!real) return undefined;
	const [p] = await sql`select p.*, c.id as owner_channel, c.title as owner_title, c.handle as owner_handle,
		(select count(*)::int from playlist_items i join videos v on v.id = i.video_id where i.playlist_id = p.id and ${PLAYABLE(viewer)}) as video_count,
		(select i.video_id from playlist_items i join videos v on v.id = i.video_id where i.playlist_id = p.id and ${PLAYABLE(viewer)} order by i.position limit 1) as first_video
		from playlists p join channels c on c.user_id = p.user_id where p.id = ${real}`;
	if (!p) return undefined;
	if (p.visibility === "private" && p.user_id !== viewer?.userId) return undefined;
	const out = { ...p, id: p.kind === "watch_later" ? "WL" : p.id, user_id: String(p.user_id) } as Playlist;
	// "Play all" starts where the chosen order does
	if (out.video_order) out.first_video = (await playlistVideos(out, viewer, 1, 0))[0]?.id ?? null;
	return out;
}

// the sort menu's orders (playlists.video_order)
const ORDERS = [sql`i.position`, sql`i.added_at desc`, sql`i.added_at asc`, sql`v.view_count desc`, sql`v.published_at desc nulls last`, sql`v.published_at asc nulls last`];

export async function playlistVideos(p: Playlist, viewer: Viewer, limit: number, offset: number): Promise<(Video & { set_id: string })[]> {
	if (p.kind === "liked")
		return (await sql`select ${VIDEO_COLUMNS}, r.video_id as set_id from video_reactions r join videos v on v.id = r.video_id join channels c on c.id = v.channel_id
			where r.user_id = ${viewer!.userId} and r.kind = 'like' and ${PLAYABLE(viewer)} order by r.created_at desc limit ${limit} offset ${offset}`) as (Video & { set_id: string })[];
	const real = p.kind === "watch_later" ? await watchLaterId(viewer!) : p.id;
	return (await sql`select ${VIDEO_COLUMNS}, i.id as set_id from playlist_items i join videos v on v.id = i.video_id join channels c on c.id = v.channel_id
		where i.playlist_id = ${real} and ${PLAYABLE(viewer)} order by ${ORDERS[p.video_order] ?? ORDERS[0]}, i.position limit ${limit} offset ${offset}`) as (Video & { set_id: string })[];
}

const thumb = (videoId: string | null) => (videoId ? `${PUBLIC_ORIGIN}/vi/${videoId}/hqdefault.jpg` : `${PUBLIC_ORIGIN}/_up/www.gstatic.com/youtube/img/icons/web/youtube_fill/offline_no_content/v1/192px.svg`);

export async function userPlaylists(viewer: Viewer, ownerUserId?: string, includePrivate = false): Promise<Playlist[]> {
	const uid = ownerUserId ?? viewer?.userId;
	if (!uid) return [];
	const rows = await sql`select p.*, c.id as owner_channel, c.title as owner_title, c.handle as owner_handle,
		(select count(*)::int from playlist_items i join videos v on v.id = i.video_id where i.playlist_id = p.id and ${PLAYABLE(viewer)}) as video_count,
		(select i.video_id from playlist_items i join videos v on v.id = i.video_id where i.playlist_id = p.id and ${PLAYABLE(viewer)} order by i.position limit 1) as first_video
		from playlists p join channels c on c.user_id = p.user_id
		where p.user_id = ${uid} and p.kind = 'user' and (${includePrivate} or p.visibility = 'public') order by p.updated_at desc`;
	return rows.map((p: Playlist) => ({ ...p, user_id: String(p.user_id) }));
}

// the viewer's library (Playlists feed and the You page): Liked videos,
// Watch later, their own playlists and the ones they saved, most recently
// changed (or saved) first, or A-Z. "Owned" keeps only their own playlists
export async function libraryPlaylists(viewer: NonNullable<Viewer>, owned = false, az = false): Promise<Playlist[]> {
	if (!owned) await watchLaterId(viewer);
	const rows = await sql`select p.*, c.id as owner_channel, c.title as owner_title, c.handle as owner_handle,
		(select count(*)::int from playlist_items i join videos v on v.id = i.video_id where i.playlist_id = p.id and ${PLAYABLE(viewer)}) as video_count,
		(select i.video_id from playlist_items i join videos v on v.id = i.video_id where i.playlist_id = p.id and ${PLAYABLE(viewer)} order by i.position limit 1) as first_video,
		coalesce(s.saved_at, greatest(p.updated_at, (select max(i.added_at) from playlist_items i where i.playlist_id = p.id))) as activity
		from playlists p join channels c on c.user_id = p.user_id
		left join saved_playlists s on s.playlist_id = p.id and s.user_id = ${viewer.userId}
		where (p.user_id = ${viewer.userId} and p.kind = any(${textArray(owned ? ["user"] : ["user", "watch_later"])}::text[]))
			or (${!owned} and s.user_id is not null and p.visibility <> 'private')`;
	const lists = rows.map((p: Playlist & { activity: Date }) => ({ ...p, id: p.kind === "watch_later" ? "WL" : p.id, user_id: String(p.user_id) }));
	if (!owned) {
		const liked = await getPlaylist("LL", viewer);
		const [r] = await sql`select max(created_at) as t from video_reactions where user_id = ${viewer.userId} and kind = 'like'`;
		if (liked) lists.push({ ...liked, activity: r?.t ?? new Date(0) });
	}
	return lists.sort((a: Playlist & { activity: Date }, b: Playlist & { activity: Date }) => (az ? a.title.localeCompare(b.title) : new Date(b.activity).getTime() - new Date(a.activity).getTime()));
}

const VISIBILITY = { public: "Public", unlisted: "Unlisted", private: "Private" } as const;

// someone else's playlist in the viewer's library
async function isSaved(p: Playlist, viewer: Viewer) {
	if (!viewer || p.kind !== "user" || p.user_id === viewer.userId) return false;
	const [r] = await sql`select 1 from saved_playlists where user_id = ${viewer.userId} and playlist_id = ${p.id}`;
	return !!r;
}

// Save playlist / Remove from Library (like/like and like/removelike with a playlist target)
export async function setSaved(id: string, viewer: NonNullable<Viewer>, saved: boolean) {
	const p = await getPlaylist(id, viewer);
	if (!p || p.kind !== "user") throw new ApiError(404, "Playlist not found");
	if (p.user_id === viewer.userId) throw new ApiError(400, "This is your own playlist.");
	if (saved) await sql`insert into saved_playlists (user_id, playlist_id) values (${viewer.userId}, ${p.id}) on conflict do nothing`;
	else await sql`delete from saved_playlists where user_id = ${viewer.userId} and playlist_id = ${p.id}`;
}

// a playlist card as the Playlists feed and the You page show it (template
// item/playlist_lockup_feed); only the viewer's own playlists can be deleted
export function playlistCard(p: Playlist, viewer: Viewer, page = "/feed/playlists") {
	const item = make("item/playlist_lockup_feed", {
		...baseVars(viewer, page),
		PLAYLIST_ID: p.id,
		TITLE: p.title,
		VISIBILITY: VISIBILITY[p.visibility],
		VIDEO_COUNT: p.video_count ? plural(p.video_count, "video") : "No videos",
		FIRST_VIDEO_ID: p.first_video ?? "",
		THUMBS: [{ url: thumb(p.first_video), width: 480, height: 270 }],
	});
	const lv = find(item, "lockupViewModel");
	if (p.kind !== "user" || p.user_id !== viewer?.userId) delete lv.metadata.lockupMetadataViewModel.menuButton;
	if (!p.first_video) {
		// nothing to play: the card opens the playlist
		delete lv.itemPlayback;
		lv.rendererContext.commandContext.onTap.innertubeCommand = playlistEndpoint(p.id);
		const overlays = find(lv, "overlays");
		if (Array.isArray(overlays)) for (let i = overlays.length - 1; i >= 0; i--) if (overlays[i].thumbnailHoverOverlayViewModel) overlays.splice(i, 1);
	}
	return item;
}

// a channel's Playlists tab (template item/playlist_lockup); empty lists are not shown
export async function channelPlaylistLockups(c: Channel, viewer: Viewer) {
	const lists = (await userPlaylists(viewer, c.user_id, viewer?.channelId === c.id)).filter((p) => p.first_video);
	return lists.map((p) =>
		make("item/playlist_lockup", {
			...baseVars(viewer, `/@${c.handle}/playlists`),
			PLAYLIST_ID: p.id,
			TITLE: p.title,
			VIDEO_COUNT: plural(p.video_count, "video"),
			FIRST_VIDEO_ID: p.first_video,
			THUMBS: [{ url: thumb(p.first_video), width: 480, height: 270 }],
			CHANNEL_ID: c.id,
			AT_HANDLE: `@${c.handle}`,
		}),
	);
}

// public playlists whose title matches a search; empty ones are left out
export async function searchPlaylists(query: string, limit: number, offset: number, viewer: Viewer): Promise<Playlist[]> {
	const like = `%${query.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
	const rows = await sql`select * from (select p.*, c.id as owner_channel, c.title as owner_title, c.handle as owner_handle,
		(select count(*)::int from playlist_items i join videos v on v.id = i.video_id where i.playlist_id = p.id and ${PLAYABLE(viewer)}) as video_count,
		(select i.video_id from playlist_items i join videos v on v.id = i.video_id where i.playlist_id = p.id and ${PLAYABLE(viewer)} order by i.position limit 1) as first_video
		from playlists p join channels c on c.user_id = p.user_id
		where p.kind = 'user' and p.visibility = 'public' and p.title ilike ${like}) x
		where x.first_video is not null order by x.updated_at desc, x.id limit ${limit} offset ${offset}`;
	return rows.map((p: Playlist) => ({ ...p, user_id: String(p.user_id) }));
}

// a playlist search result (template item/playlist_search): the first two
// videos are listed under the title, each from the template's sample row
export async function playlistSearchItem(p: Playlist, viewer: Viewer) {
	const t = tpl("item/playlist_search");
	const rows = t.lockupViewModel.metadata.lockupMetadataViewModel.metadata.contentMetadataViewModel.metadataRows;
	const at = rows.findIndex((r: any) => JSON.stringify(r).includes("{{ROW_TEXT}}"));
	const videos = await playlistVideos(p, viewer, 2, 0);
	const listed = videos.map((v) => {
		const text = `${v.title} · ${duration(v.duration_ms)}`;
		return fill(structuredClone(rows[at]), { ROW_TEXT: text, ROW_TEXT_LENGTH: text.length, ROW_VIDEO_ID: v.id }, "item/playlist_search");
	});
	rows.splice(at, 1, ...listed);
	if (!p.description) rows.splice(rows.findIndex((r: any) => r.lockupContentMetadataRowExtension?.contentType === "METADATA_ROW_CONTENT_TYPE_DESCRIPTION"), 1);
	return fill(t, {
		...baseVars(viewer),
		PLAYLIST_ID: p.id,
		TITLE: p.title,
		VIDEO_COUNT: plural(p.video_count, "video"),
		FIRST_VIDEO_ID: p.first_video,
		THUMBS: [{ url: thumb(p.first_video), width: 480, height: 270 }],
		CHANNEL_ID: p.owner_channel,
		CHANNEL_NAME: p.owner_title,
		CHANNEL_NAME_LENGTH: p.owner_title.length,
		CHANNEL_URL: `/@${p.owner_handle}`,
		DESCRIPTION_SHORT: p.description.length > 160 ? `${p.description.slice(0, 157)}...` : p.description,
	}, "item/playlist_search");
}

// ---- the playlist page (templates playlist/*, item/playlist_row_*) ----
// Someone else's playlist (or any, signed out) has YouTube's current page
// header and lockup rows; the viewer's own lists (Watch later, Liked videos,
// their playlists) the editable header with reorderable rows.

const isOwn = (p: Playlist, viewer: Viewer) => !!viewer && p.user_id === viewer.userId;
const ownLayout = (p: Playlist, viewer: Viewer) => isOwn(p, viewer);

const heroSources = (videoId: string | null) => [[168, 94], [196, 110], [246, 138], [336, 188]].map(([width, height]) => ({ url: thumb(videoId), width, height }));

function lengthWords(ms: number | null | undefined) {
	const s = Math.round((ms ?? 0) / 1000);
	if (s >= 3600) return plural(Math.floor(s / 3600), "hour");
	if (s >= 60) return plural(Math.floor(s / 60), "minute");
	return plural(s, "second");
}

function ownRow(p: Playlist, v: Video & { set_id: string }, index: number) {
	const row = make("item/playlist_row_own", {
		...videoVars(v),
		VIDEO_TITLE: v.title,
		TITLE: p.title,
		PLAYLIST_ID: p.id,
		SET_VIDEO_ID: v.set_id,
		INDEX: index,
		POSITION: String(index + 1),
		LENGTH_SECONDS: String(Math.round((v.duration_ms ?? 0) / 1000)),
		LENGTH_WORDS: lengthWords(v.duration_ms),
		ROW_THUMBS: videoThumbnails(v.id).thumbnails,
		VIEWS: v.view_count ? compact(v.view_count) : "No views",
		PUBLISHED: shortAgo(v.published_at ?? v.created_at),
	});
	const r = row.playlistVideoRenderer;
	// Liked videos: entries leave by unliking, in YouTube's order (newest first)
	if (p.kind === "liked") r.menu.menuRenderer.items = r.menu.menuRenderer.items.filter((it: any) => !it.menuServiceItemRenderer?.serviceEndpoint?.playlistEditEndpoint);
	return row;
}

function otherRow(p: Playlist, v: Video, viewer: Viewer) {
	return make(`item/playlist_row_${viewer ? "in" : "out"}`, { ...baseVars(viewer, `/playlist?list=${p.id}`), ...videoVars(v), PLAYLIST_ID: p.id });
}

async function rows(p: Playlist, viewer: Viewer, offset: number) {
	const vids = await playlistVideos(p, viewer, PAGE, offset);
	const own = ownLayout(p, viewer);
	const items: unknown[] = vids.map((v, i) => (own ? ownRow(p, v, offset + i) : otherRow(p, v, viewer)));
	const more = vids.length === PAGE ? encodeToken({ k: "playlist", p: p.id, o: offset + PAGE }) : undefined;
	return { items, more };
}

export async function playlistItemsContinuation(id: string, offset: number, viewer: Viewer) {
	const p = await getPlaylist(id, viewer);
	if (!p) throw new ApiError(404, "Not found");
	const { items, more } = await rows(p, viewer, offset);
	if (more) items.push(ownLayout(p, viewer) ? continuationItem(more, "/youtubei/v1/browse") : make("item/continuation_playlist", { CONTINUATION: more }));
	return { responseContext: responseContext(viewer), onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: items, targetId: ownLayout(p, viewer) ? "playlist-video-list" : `VL${p.id}` } }] };
}

const shuffleVideo = async (p: Playlist, viewer: Viewer) => {
	const vids = await playlistVideos(p, viewer, 200, 0);
	return vids.length ? vids[Math.floor(Math.random() * vids.length)].id : p.first_video;
};

// "No videos in this playlist yet": YouTube's empty-playlist message
const emptyList = () => ({ messageRenderer: { text: runs("No videos in this playlist yet") } });

const ORDER_LABELS = ["Manual", "Date added (newest)", "Date added (oldest)", "Most popular", "Date published (newest)", "Date published (oldest)"];

async function ownPage(p: Playlist, viewer: Viewer) {
	const { items, more } = await rows(p, viewer, 0);
	if (more) items.push(continuationItem(more, "/youtubei/v1/browse"));
	const updated = new Date(p.updated_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
	const vars: Vars = {
		...baseVars(viewer, `/playlist?list=${p.id}`),
		...viewerVars(viewer!),
		PLAYLIST_ID: p.id,
		TITLE: p.title,
		VIDEO_COUNT_NUM: grouped(p.video_count),
		VIDEOS_WORD: p.video_count === 1 ? " video" : " videos",
		UPDATED: updated,
		FIRST_VIDEO_ID: p.first_video ?? "",
		SHUFFLE_VIDEO_ID: (await shuffleVideo(p, viewer)) ?? "",
		HERO: heroSources(p.first_video),
		MICROFORMAT_THUMBS: [{ url: thumb(p.first_video), width: 480, height: 270 }],
		ITEMS: items,
	};
	for (let i = 0; i <= 5; i++) vars[`ORDER_${i}_SELECTED`] = p.video_order === i;
	vars.ORDER_LABEL = ORDER_LABELS[p.video_order] ?? ORDER_LABELS[0];
	const page = make("playlist/page_own", vars);
	const h = page.header.playlistHeaderRenderer;
	if (p.kind === "user") {
		h.privacy = p.visibility.toUpperCase();
		h.editableDetails.canDelete = true;
		if (p.description) page.metadata.playlistMetadataRenderer.description = p.description;
	}
	const pvl = find(page, "playlistVideoListRenderer");
	pvl.targetId = "playlist-video-list";
	if (p.kind === "liked") {
		// a derived list: not reorderable, nothing to remove in bulk
		pvl.canReorder = false;
		delete pvl.onReorderEndpoint;
		delete pvl.sortFilterMenu;
		delete find(page, "itemSectionRenderer").header;
		delete h.moreActionsMenu;
	}
	if (!items.length) {
		find(page, "itemSectionRenderer").contents = [emptyList()];
		for (const k of ["playButton", "shufflePlayButton"]) delete h[k];
	}
	return page;
}

async function otherPage(p: Playlist, viewer: Viewer) {
	const { items, more } = await rows(p, viewer, 0);
	const desc = p.description;
	const page = make("playlist/page_out", {
		...baseVars(viewer, `/playlist?list=${p.id}`),
		PLAYLIST_ID: p.id,
		TITLE: p.title,
		DESCRIPTION: desc,
		DESCRIPTION_LABEL: `Description. ${desc.length > 60 ? `${desc.slice(0, 60)}...` : desc}tap for more.`,
		CHANNEL_ID: p.owner_channel,
		CHANNEL_URL: `/@${p.owner_handle}`,
		CHANNEL_NAME: p.owner_title,
		BY_LENGTH: 3 + p.owner_title.length,
		AVATAR_48: [{ url: avatarUrl(p.owner_channel, 48), width: 48, height: 48 }],
		VIDEO_COUNT: plural(p.video_count, "video"),
		FIRST_VIDEO_ID: p.first_video ?? "",
		SHUFFLE_VIDEO_ID: (await shuffleVideo(p, viewer)) ?? "",
		HERO: heroSources(p.first_video),
		MICROFORMAT_THUMBS: [{ url: thumb(p.first_video), width: 480, height: 270 }],
		ITEMS: items.length ? items : [emptyList()],
		CONTINUATION_ITEM: more ? make("item/continuation_playlist", { CONTINUATION: more }) : null,
	});
	const sl = find(page, "sectionListRenderer");
	sl.contents = sl.contents.filter(Boolean);
	const ph = page.header.pageHeaderRenderer.content.pageHeaderViewModel;
	if (!desc) delete ph.description;
	const actions = ph.actions.flexibleActionsViewModel.actionsRows[0].actions;
	// signed in, Save adds the playlist to the library
	if (viewer) {
		const i = actions.findIndex((a: any) => a.toggleButtonViewModel);
		if (i >= 0) actions[i] = make("playlist/save_toggle_in", { PLAYLIST_ID: p.id, SAVED: await isSaved(p, viewer) });
	}
	if (!items.length) ph.actions.flexibleActionsViewModel.actionsRows[0].actions = ph.actions.flexibleActionsViewModel.actionsRows[0].actions.filter((a: any) => !find(a, "watchEndpoint"));
	return page;
}

export async function playlistBrowse(id: string, viewer: Viewer): Promise<BrowseResult | undefined> {
	const p = await getPlaylist(id, viewer);
	if (!p) return undefined;
	return {
		kind: "playlist",
		title: p.title,
		url: `/playlist?list=${p.id}`,
		command: playlistEndpoint(p.id),
		response: ownLayout(p, viewer) ? await ownPage(p, viewer) : await otherPage(p, viewer),
	};
}

// the playlist beside a watch page with &list= (templates watch/playlist_panel
// and item/playlist_panel_video)
export async function playlistPanel(id: string, videoId: string, viewer: Viewer, index?: number): Promise<unknown> {
	const p = await getPlaylist(id, viewer);
	if (!p) return undefined;
	const vids = await playlistVideos(p, viewer, 200, 0);
	const current = Math.max(0, index !== undefined && vids[index]?.id === videoId ? index : vids.findIndex((v) => v.id === videoId));
	const vars = baseVars(viewer, `/watch?v=${videoId}&list=${p.id}`);
	const items = vids.map((v, i) => {
		const item = make("item/playlist_panel_video", {
			...vars,
			...videoVars(v),
			PLAYLIST_ID: p.id,
			TITLE_LABEL: `${v.title} ${durationLabel(v.duration_ms)}`,
			THUMBS: lockupSources(v.id),
			INDEX: i,
			INDEX_1: String(i + 1),
			INDEX_TEXT: i === current ? "▶" : String(i + 1),
			SELECTED: i === current,
			SET_VIDEO_ID: v.set_id,
		});
		// signed in, Save to playlist opens the sheet itself
		if (viewer) {
			const save = find(item, "menuNavigationItemRenderer");
			if (save?.navigationEndpoint?.signInEndpoint) save.navigationEndpoint = save.navigationEndpoint.signInEndpoint.nextEndpoint;
		}
		return item;
	});
	const panel = make<any>("watch/playlist_panel", {
		...vars,
		PLAYLIST_ID: p.id,
		TITLE: p.title,
		OWNER_NAME: p.owner_title,
		CHANNEL_ID: p.owner_channel,
		CHANNEL_URL: `/@${p.owner_handle}`,
		CURRENT_INDEX: current,
		CURRENT_1: String(current + 1),
		TOTAL_VIDEOS: vids.length,
		TOTAL_TEXT: String(vids.length),
		SHARE_URL: `${PUBLIC_ORIGIN}/watch?v=${videoId}&list=${p.id}`,
		SAVED: await isSaved(p, viewer),
		ITEMS: items,
	});
	// Save playlist to Library is for other people's playlists
	if (p.kind !== "user" || p.user_id === viewer?.userId) delete panel.playlist.menu;
	if (viewer && p.kind === "user" && p.user_id === viewer.userId) panel.playlist.isEditable = true;
	return panel;
}

// ---- mutations ----

async function touch(realId: string) {
	await sql`update playlists set updated_at = now() where id = ${realId}`;
}

async function ownedReal(id: string, viewer: NonNullable<Viewer>): Promise<string> {
	if (id === "WL") return watchLaterId(viewer);
	const [p] = await sql`select id from playlists where id = ${id} and user_id = ${viewer.userId} and kind = 'user'`;
	if (!p) throw new ApiError(403, "You can't edit this playlist.", "forbidden");
	return p.id;
}

async function addVideo(realId: string, videoId: string, viewer: NonNullable<Viewer>) {
	if (!isVideoId(videoId)) throw new ApiError(400, "Invalid video id");
	const [v] = await sql`select 1 from videos where id = ${videoId} and deleted_at is null and (visibility <> 'private' or channel_id = ${viewer.channelId})`;
	if (!v) throw new ApiError(404, "Video not found");
	const [{ n }] = await sql`select count(*)::int as n from playlist_items where playlist_id = ${realId}`;
	if (n >= 5000) throw new ApiError(400, "Playlists hold at most 5000 videos.");
	await sql`insert into playlist_items (id, playlist_id, video_id, position) values (${randomId(16)}, ${realId}, ${videoId}, coalesce((select max(position) from playlist_items where playlist_id = ${realId}), 0) + 1)`;
}

route(
	"playlist/create",
	async ({ body, viewer }) => {
		const title = String(body.title ?? "").trim().slice(0, 150);
		if (!title) throw new ApiError(400, "A playlist needs a title.");
		const privacy = String(body.privacyStatus ?? "PRIVATE").toUpperCase();
		const visibility = privacy === "PUBLIC" ? "public" : privacy === "UNLISTED" ? "unlisted" : "private";
		const id = newPlaylistId();
		const [{ n }] = await sql`select count(*)::int as n from playlists where user_id = ${viewer!.userId}`;
		if (n >= 500) throw new ApiError(400, "You can have at most 500 playlists.");
		await sql`insert into playlists (id, user_id, title, visibility) values (${id}, ${viewer!.userId}, ${title}, ${visibility})`;
		for (const vid of (Array.isArray(body.videoIds) ? body.videoIds : []).slice(0, 50)) await addVideo(id, String(vid), viewer!);
		return {
			responseContext: responseContext(viewer),
			playlistId: id,
			actions: [{ addToToastAction: { item: { notificationActionRenderer: { responseText: runs(`Saved to ${title}`), actionButton: { buttonRenderer: { style: "STYLE_BLUE_TEXT", text: runs("View"), navigationEndpoint: playlistEndpoint(id) } } } } } }],
		};
	},
	{ mutation: true },
);

route(
	"browse/edit_playlist",
	async ({ body, viewer }) => {
		const id = String(body.playlistId ?? "");
		const real = await ownedReal(id, viewer!);
		const toasts: string[] = [];
		for (const a of (Array.isArray(body.actions) ? body.actions : []).slice(0, 100)) {
			switch (a.action) {
				case "ACTION_ADD_VIDEO":
					await addVideo(real, String(a.addedVideoId), viewer!);
					toasts.push(id === "WL" ? "Saved to Watch later" : "Saved to playlist");
					break;
				case "ACTION_REMOVE_VIDEO":
					await sql`delete from playlist_items where playlist_id = ${real} and id = ${String(a.setVideoId)}`;
					toasts.push("Removed from playlist");
					break;
				case "ACTION_REMOVE_VIDEO_BY_VIDEO_ID":
					await sql`delete from playlist_items where playlist_id = ${real} and video_id = ${String(a.removedVideoId)}`;
					toasts.push(id === "WL" ? "Removed from Watch later" : "Removed from playlist");
					break;
				case "ACTION_SET_PLAYLIST_NAME": {
					const t = String(a.playlistName ?? "").trim().slice(0, 150);
					if (t) await sql`update playlists set title = ${t} where id = ${real} and kind = 'user'`;
					break;
				}
				case "ACTION_SET_PLAYLIST_DESCRIPTION":
					await sql`update playlists set description = ${String(a.playlistDescription ?? "").slice(0, 5000)} where id = ${real} and kind = 'user'`;
					break;
				case "ACTION_SET_PLAYLIST_PRIVACY": {
					const pv = String(a.playlistPrivacy ?? "").toUpperCase();
					const vis = pv === "PUBLIC" ? "public" : pv === "UNLISTED" ? "unlisted" : "private";
					await sql`update playlists set visibility = ${vis} where id = ${real} and kind = 'user'`;
					break;
				}
				case "ACTION_MOVE_VIDEO_AFTER": {
					const [moving] = await sql`select id from playlist_items where playlist_id = ${real} and id = ${String(a.setVideoId)}`;
					if (!moving) break;
					const [after] = a.movedSetVideoIdPredecessor ? await sql`select position from playlist_items where playlist_id = ${real} and id = ${String(a.movedSetVideoIdPredecessor)}` : [{ position: 0 }];
					const [next] = await sql`select min(position) as p from playlist_items where playlist_id = ${real} and position > ${after?.position ?? 0} and id <> ${moving.id}`;
					await sql`update playlist_items set position = ${next?.p != null ? (Number(after?.position ?? 0) + Number(next.p)) / 2 : Number(after?.position ?? 0) + 1} where id = ${moving.id}`;
					break;
				}
				case "ACTION_MOVE_VIDEO_BEFORE": {
					// before its successor; without one, to the bottom
					const [moving] = await sql`select id from playlist_items where playlist_id = ${real} and id = ${String(a.setVideoId)}`;
					if (!moving) break;
					const [before] = a.movedSetVideoIdSuccessor ? await sql`select position from playlist_items where playlist_id = ${real} and id = ${String(a.movedSetVideoIdSuccessor)}` : [];
					if (!before) {
						await sql`update playlist_items set position = coalesce((select max(position) from playlist_items where playlist_id = ${real}), 0) + 1 where id = ${moving.id}`;
						break;
					}
					const [prev] = await sql`select max(position) as p from playlist_items where playlist_id = ${real} and position < ${before.position} and id <> ${moving.id}`;
					await sql`update playlist_items set position = ${prev?.p != null ? (Number(prev.p) + Number(before.position)) / 2 : Number(before.position) - 1} where id = ${moving.id}`;
					break;
				}
				case "ACTION_SET_PLAYLIST_VIDEO_ORDER": {
					const order = Number(a.playlistVideoOrder);
					if (Number.isInteger(order) && order >= 0 && order <= 5) await sql`update playlists set video_order = ${order} where id = ${real}`;
					break;
				}
				case "ACTION_REMOVE_WATCHED_VIDEOS":
					await sql`delete from playlist_items i using watch_history h where i.playlist_id = ${real} and h.user_id = ${viewer!.userId} and h.video_id = i.video_id`;
					toasts.push("Removed watched videos");
					break;
				default:
					throw new ApiError(400, `Unsupported playlist action ${String(a.action).slice(0, 40)}`);
			}
		}
		await touch(real);
		return {
			responseContext: responseContext(viewer),
			status: "STATUS_SUCCEEDED",
			playlistEditResults: [],
			// the Save sheet's rows (params set) show their own snackbar
			actions: toasts.length && !body.params ? [{ addToToastAction: { item: { notificationActionRenderer: { responseText: runs(toasts[toasts.length - 1]) } } } }] : [],
		};
	},
	{ mutation: true },
);

route(
	"playlist/delete",
	async ({ body, viewer }) => {
		const id = String(body.playlistId ?? body.sourcePlaylistId ?? "");
		const r = await sql`delete from playlists where id = ${id} and user_id = ${viewer!.userId} and kind = 'user' returning id`;
		if (!r.length) throw new ApiError(404, "Playlist not found");
		return { responseContext: responseContext(viewer), actions: [{ addToToastAction: { item: { notificationActionRenderer: { responseText: runs("Playlist deleted") } } } }] };
	},
	{ mutation: true },
);

// the "Save to..." sheet (get_panel PAadd_to_playlist; templates
// playlist/save_sheet and item/save_row): a toggle row per playlist, Watch
// later first, and New playlist, which opens the client's create dialog
export async function addToPlaylistSheet(videoId: string, viewer: Viewer) {
	if (!viewer || !isVideoId(videoId)) return { responseContext: responseContext(viewer) };
	const wl = await watchLaterId(viewer);
	const lists = await sql`select p.id, p.title, p.visibility,
			exists(select 1 from playlist_items i where i.playlist_id = p.id and i.video_id = ${videoId}) as has,
			(select i.video_id from playlist_items i join videos v on v.id = i.video_id where i.playlist_id = p.id and ${PLAYABLE(viewer)} order by i.position limit 1) as first_video
		from playlists p where p.user_id = ${viewer.userId} and p.kind = any(${textArray(["user", "watch_later"])}::text[]) order by p.kind = 'watch_later' desc, p.updated_at desc`;
	const vars = { ...baseVars(viewer, `/watch?v=${videoId}`), VIDEO_ID: videoId, VIDEO_THUMBS: lockupSources(videoId) };
	const items = lists.map((p: { id: string; title: string; visibility: keyof typeof VISIBILITY; has: boolean; first_video: string | null }) =>
		make("item/save_row", {
			...vars,
			PLAYLIST_ID: p.id === wl ? "WL" : p.id,
			TITLE: p.id === wl ? "Watch later" : p.title,
			VISIBILITY: VISIBILITY[p.visibility],
			TOGGLED: p.has,
			THUMBS: [{ url: thumb(p.first_video), width: 480, height: 360 }],
		}),
	);
	return { responseContext: responseContext(viewer), ...make("playlist/save_sheet", { ...vars, ITEMS: items, TIMESTAMP: { seconds: String(Math.floor(Date.now() / 1000)), nanos: 0 } }) };
}

// the sheet's params: YouTube's (the video id in a nested message, as the
// templates carry them) or a bare base64url video id
export function saveSheetVideoId(params: string): string {
	try {
		const bytes = Buffer.from(decodeURIComponent(params), "base64url").toString("latin1");
		return /\x0a\x0b([A-Za-z0-9_-]{11})/.exec(bytes)?.[1] ?? bytes;
	} catch {
		return "";
	}
}

panel("PAadd_to_playlist", (body, viewer) => addToPlaylistSheet(saveSheetVideoId(String(body.params ?? "")), viewer));

export { getPlaylist };
