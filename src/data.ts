// Queries shared by the compatibility routes. Visibility rules live here:
// private videos are visible only to their owner, unlisted ones to anyone
// with the id but never in listings, and deleted ones to nobody.

import type { Viewer } from "./client/page";
import { sql, textArray } from "./db";
import type { Channel, Video } from "./innertube/r";

const VIDEO_COLUMNS = sql`v.id, v.title, v.description, v.channel_id, c.title as channel_title, c.handle as channel_handle, c.avatar_path as channel_avatar,
	v.duration_ms, v.view_count::int as view_count, v.like_count, v.comment_count, v.published_at, v.created_at, v.visibility, v.status, v.playable, v.width, v.height, v.category_id`;

export async function getVideo(id: string, viewer: Viewer): Promise<Video | undefined> {
	const [v] = await sql`select ${VIDEO_COLUMNS}, (select count(*)::int from subscriptions s where s.channel_id = v.channel_id) as subscriber_count
		from videos v join channels c on c.id = v.channel_id where v.id = ${id} and v.deleted_at is null`;
	if (!v) return undefined;
	if (v.visibility === "private" && viewer?.channelId !== v.channel_id) return undefined;
	return v as Video;
}

// how far the viewer got into each video (watched_ms), for the red progress
// bar YouTube draws on watched videos' thumbnails; returns the same rows
export async function markWatched<T extends Video>(viewer: Viewer, videos: T[]): Promise<T[]> {
	if (!viewer || !videos.length) return videos;
	const rows = await sql`select video_id, position_ms from watch_history where user_id = ${viewer.userId} and video_id = any(${textArray(videos.map((v) => v.id))}::text[])`;
	const at = new Map<string, number>(rows.map((r: { video_id: string; position_ms: number }) => [r.video_id, Number(r.position_ms)]));
	for (const v of videos) if (at.has(v.id)) v.watched_ms = at.get(v.id);
	return videos;
}

// public, playable videos for feeds and search
const LISTED = sql`v.playable and v.visibility = 'public' and v.deleted_at is null`;

// Shorts: vertical or square, up to three minutes (YouTube's definition)
export const SHORT_MAX_MS = 180_000;
export const SHORT = sql`v.height >= v.width and v.width > 0 and v.duration_ms <= ${SHORT_MAX_MS}`;

// home's grid: everything but Shorts, which get their own shelf. The chips
// above it pick the order: All (unwatched first, then views weighed against
// age, a week of age costing a factor of e), Recently uploaded, Watched (the
// viewer's history) and New to you (channels the viewer hasn't watched or
// subscribed to)
export type HomeFilter = "all" | "recent" | "watched" | "new";
export async function longVideos(limit: number, offset = 0, filter: HomeFilter = "recent", viewer?: Viewer): Promise<Video[]> {
	const user = viewer?.userId ?? null;
	const watched = sql`exists(select 1 from watch_history w where w.user_id = ${user} and w.video_id = v.id)`;
	const where =
		filter === "watched" ? watched
		: filter === "new" ? sql`v.channel_id <> ${viewer?.channelId ?? ""} and not exists(select 1 from subscriptions s where s.user_id = ${user} and s.channel_id = v.channel_id)
			and not exists(select 1 from watch_history w join videos wv on wv.id = w.video_id where w.user_id = ${user} and wv.channel_id = v.channel_id)`
		: sql`true`;
	const order =
		filter === "watched" ? sql`(select w.watched_at from watch_history w where w.user_id = ${user} and w.video_id = v.id) desc`
		: filter === "all" ? sql`${watched} asc, ln(v.view_count + 2) - extract(epoch from now() - v.published_at) / 604800 desc`
		: sql`v.published_at desc`;
	return (await sql`select ${VIDEO_COLUMNS} from videos v join channels c on c.id = v.channel_id
		where ${LISTED} and not coalesce(${SHORT}, false) and ${where} order by ${order}, v.published_at desc, v.id limit ${limit} offset ${offset}`) as Video[];
}
export const isShort = (v: { width?: number | null; height?: number | null; duration_ms?: number | null }) => !!v.width && !!v.height && v.height >= v.width && (v.duration_ms ?? Infinity) <= SHORT_MAX_MS;

export async function shortVideos(limit: number, offset = 0, excludeId = ""): Promise<Video[]> {
	return (await sql`select ${VIDEO_COLUMNS} from videos v join channels c on c.id = v.channel_id
		where ${LISTED} and ${SHORT} and v.id <> ${excludeId} order by v.published_at desc, v.id limit ${limit} offset ${offset}`) as Video[];
}

// the watch page's list and its chips: "all" (same channel first, then
// everything else by recency), From <channel> ("channel"), Related (other
// channels' videos, popular first), For you (what the viewer hasn't
// watched, home's ranking) and Recently uploaded ("recent")
export type RelatedFilter = "all" | "channel" | "related" | "foryou" | "recent";
export async function relatedVideos(video: Video, limit: number, offset = 0, filter: RelatedFilter = "all", viewer?: Viewer): Promise<Video[]> {
	const user = viewer?.userId ?? null;
	const [where, order] =
		filter === "channel" ? [sql`v.channel_id = ${video.channel_id}`, sql`v.published_at desc`]
		: filter === "related" ? [sql`v.channel_id <> ${video.channel_id}`, sql`v.view_count desc, v.published_at desc`]
		: filter === "recent" ? [sql`true`, sql`v.published_at desc`]
		: filter === "foryou" ? [sql`not exists(select 1 from watch_history w where w.user_id = ${user} and w.video_id = v.id)`, sql`ln(v.view_count + 2) - extract(epoch from now() - v.published_at) / 604800 desc`]
		: [sql`true`, sql`(v.channel_id = ${video.channel_id}) desc, v.published_at desc`];
	return (await sql`select ${VIDEO_COLUMNS} from videos v join channels c on c.id = v.channel_id
		where ${LISTED} and not coalesce(${SHORT}, false) and v.id <> ${video.id} and ${where}
		order by ${order}, v.id limit ${limit} offset ${offset}`) as Video[];
}

// the reel shelf in the watch page's list: Shorts, the channel's own first
export async function relatedShorts(video: Video, limit: number): Promise<Video[]> {
	return (await sql`select ${VIDEO_COLUMNS} from videos v join channels c on c.id = v.channel_id
		where ${LISTED} and ${SHORT} and v.id <> ${video.id} order by (v.channel_id = ${video.channel_id}) desc, v.published_at desc, v.id limit ${limit}`) as Video[];
}

// shorts: only Shorts, or none of them; minSide: the frame's shorter side
// (HD 720, 4K 2160); unwatchedBy: leave out what this user has watched
export type VideoSearch = { sort?: "relevance" | "date" | "views"; since?: Date; minMs?: number; maxMs?: number; shorts?: "only" | "exclude"; minSide?: number; unwatchedBy?: string };

export async function searchVideos(query: string, limit: number, offset: number, opts: VideoSearch = {}): Promise<Video[]> {
	const q = query.trim();
	const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
	const order = opts.sort === "date" ? sql`v.published_at desc` : opts.sort === "views" ? sql`v.view_count desc` : sql`ts_rank(v.search, plainto_tsquery('simple', ${q})) desc, v.view_count desc`;
	const since = opts.since ? sql`and v.published_at >= ${opts.since}` : sql``;
	const min = opts.minMs !== undefined ? sql`and v.duration_ms >= ${opts.minMs}` : sql``;
	const max = opts.maxMs !== undefined ? sql`and v.duration_ms < ${opts.maxMs}` : sql``;
	const shape = opts.shorts === "only" ? sql`and coalesce(${SHORT}, false)` : opts.shorts === "exclude" ? sql`and not coalesce(${SHORT}, false)` : sql``;
	const side = opts.minSide ? sql`and least(v.width, v.height) >= ${opts.minSide}` : sql``;
	const unwatched = opts.unwatchedBy ? sql`and not exists(select 1 from watch_history w where w.user_id = ${opts.unwatchedBy} and w.video_id = v.id)` : sql``;
	return (await sql`select ${VIDEO_COLUMNS} from videos v join channels c on c.id = v.channel_id
		where ${LISTED} and (v.search @@ plainto_tsquery('simple', ${q}) or v.title ilike ${like} or c.title ilike ${like}) ${since} ${min} ${max} ${shape} ${side} ${unwatched}
		order by ${order}, v.id limit ${limit} offset ${offset}`) as Video[];
}

export async function searchChannels(query: string, limit: number, offset = 0): Promise<Channel[]> {
	const like = `%${query.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
	return (await sql`select c.*, (select count(*)::int from subscriptions s where s.channel_id = c.id) as subscriber_count,
		(select count(*)::int from videos v where v.channel_id = c.id and ${LISTED}) as video_count
		from channels c where c.title ilike ${like} or c.handle ilike ${like} order by subscriber_count desc, c.id limit ${limit} offset ${offset}`) as Channel[];
}

// a channel's videos as its tabs list them: Videos leaves out Shorts, which
// have a tab of their own
export async function channelVideos(channelId: string, viewer: Viewer, limit: number, offset: number, sort: "newest" | "popular" | "oldest" = "newest", kind: "videos" | "shorts" = "videos"): Promise<Video[]> {
	const own = viewer?.channelId === channelId;
	const order = sort === "popular" ? sql`v.view_count desc` : sort === "oldest" ? sql`coalesce(v.published_at, v.created_at) asc` : sql`coalesce(v.published_at, v.created_at) desc`;
	const shape = kind === "shorts" ? sql`coalesce(${SHORT}, false)` : sql`not coalesce(${SHORT}, false)`;
	return (await sql`select ${VIDEO_COLUMNS} from videos v join channels c on c.id = v.channel_id
		where v.channel_id = ${channelId} and v.deleted_at is null and (${own} or (v.playable and v.visibility = 'public')) and ${shape}
		order by ${order}, v.id limit ${limit} offset ${offset}`) as Video[];
}

export async function getChannel(where: { id?: string; handle?: string }): Promise<Channel | undefined> {
	const [c] = where.id
		? await sql`select c.*, (select count(*)::int from subscriptions s where s.channel_id = c.id) as subscriber_count,
			(select count(*)::int from videos v where v.channel_id = c.id and ${LISTED}) as video_count from channels c where c.id = ${where.id}`
		: await sql`select c.*, (select count(*)::int from subscriptions s where s.channel_id = c.id) as subscriber_count,
			(select count(*)::int from videos v where v.channel_id = c.id and ${LISTED}) as video_count from channels c where lower(c.handle) = lower(${where.handle ?? ""})`;
	return c as Channel | undefined;
}

export async function isSubscribed(viewer: Viewer, channelId: string): Promise<boolean> {
	if (!viewer) return false;
	const [r] = await sql`select 1 from subscriptions where user_id = ${viewer.userId} and channel_id = ${channelId}`;
	return !!r;
}

export async function reactionOf(viewer: Viewer, videoId: string): Promise<"like" | "dislike" | null> {
	if (!viewer) return null;
	const [r] = await sql`select kind from video_reactions where user_id = ${viewer.userId} and video_id = ${videoId}`;
	return (r?.kind as "like" | "dislike") ?? null;
}

// "relevant": the channels the viewer watches most; "activity": latest upload first
export type ChannelSortOrder = "relevant" | "activity" | "az";
export async function subscribedChannels(viewer: Viewer, order: ChannelSortOrder = "az"): Promise<Channel[]> {
	if (!viewer) return [];
	const by = {
		relevant: sql`(select count(*) from watch_history h join videos v on v.id = h.video_id where h.user_id = ${viewer.userId} and v.channel_id = c.id) desc, latest desc nulls last, lower(c.title)`,
		activity: sql`latest desc nulls last, lower(c.title)`,
		az: sql`lower(c.title)`,
	}[order];
	return (await sql`select * from (select c.*, (select count(*)::int from subscriptions s2 where s2.channel_id = c.id) as subscriber_count,
		(select count(*)::int from videos v where v.channel_id = c.id and ${LISTED}) as video_count,
		(select max(v.published_at) from videos v where v.channel_id = c.id and ${LISTED}) as latest
		from subscriptions s join channels c on c.id = s.channel_id where s.user_id = ${viewer.userId}) c order by ${by}`) as Channel[];
}

// the subscriptions feed: videos in the grid, Shorts on their shelf and page
export async function subscriptionFeed(viewer: Viewer, limit: number, offset: number, kind: "videos" | "shorts" = "videos"): Promise<Video[]> {
	if (!viewer) return [];
	const shape = kind === "shorts" ? sql`coalesce(${SHORT}, false)` : sql`not coalesce(${SHORT}, false)`;
	return (await sql`select ${VIDEO_COLUMNS} from videos v join channels c on c.id = v.channel_id join subscriptions s on s.channel_id = v.channel_id and s.user_id = ${viewer.userId}
		where ${LISTED} and ${shape} order by v.published_at desc, v.id limit ${limit} offset ${offset}`) as Video[];
}
