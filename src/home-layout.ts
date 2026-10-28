// A channel's Home tab layout, as Studio's Customization > Home tab edits it
// (channel_edit/update_channel_page_settings shelfListUpdate): the sections
// in order, each one of Studio's shelf definitions. Studio reads them back
// as shelfInfo with each section's item count; a channel that never saved a
// layout gets YouTube's default list (isFakeShelfInfo).

import { SHORT } from "./data";
import { sql, textArray } from "./db";

export type ShelfDefinition =
	| { predefinedShelfDefinition: { type: string; forYouShelfInfo?: ForYou } }
	| { playlistShelfDefinition: { playlistId: string } }
	| { playlistCollectionShelfDefinition: { playlistIds: string[]; title: string } }
	| { channelCollectionShelfDefinition: { channelIds: string[]; title: string; type: string } };
type ForYou = { includeLongFormVideos?: boolean; includeShorts?: boolean; includeLivestreams?: boolean; contentRecency?: string };

const FOR_YOU_DEFAULT: ForYou = { includeLongFormVideos: true, includeShorts: true, includeLivestreams: true, contentRecency: "FOR_YOU_CONTENT_RECENCY_NONE" };

// YouTube's predefined sections, the default layout's first (saved) and the
// ones a channel can add
const DEFAULT_SAVED = ["SHELF_TYPE_FOR_YOU", "SHELF_TYPE_RECENT_UPLOADS", "SHELF_TYPE_SHORT_MOBILE_VIDEOS_UPLOADS", "SHELF_TYPE_LIVE_EVENTS_PREVIOUS", "SHELF_TYPE_CREATED_PLAYLISTS", "SHELF_TYPE_RECENT_POSTS", "SHELF_TYPE_VIDEO_COLLABORATIONS"];
const ADDABLE = ["SHELF_TYPE_POPULAR_UPLOADS", "SHELF_TYPE_LIVE_EVENTS_CURRENT", "SHELF_TYPE_LIVE_EVENTS_UPCOMING", "SHELF_TYPE_SUBSCRIPTIONS", "SHELF_TYPE_POPULAR_CLIPS"];
export const PREDEFINED = [...DEFAULT_SAVED, ...ADDABLE];
const MAX_SHELVES = 12;

// what each predefined section has to show
async function counts(channelId: string) {
	const [r] = await sql`select
		(select count(*)::int from videos v where v.channel_id = c.id and v.visibility = 'public' and v.deleted_at is null and v.playable and not coalesce(${SHORT}, false)) as videos,
		(select count(*)::int from videos v where v.channel_id = c.id and v.visibility = 'public' and v.deleted_at is null and v.playable and coalesce(${SHORT}, false)) as shorts,
		(select count(*)::int from playlists p where p.user_id = c.user_id and p.kind = 'user' and p.visibility = 'public') as playlists,
		(select count(*)::int from subscriptions s where s.user_id = c.user_id) as subscriptions
		from channels c where c.id = ${channelId}`;
	const n = r as { videos: number; shorts: number; playlists: number; subscriptions: number };
	return (type: string) =>
		({
			SHELF_TYPE_FOR_YOU: n.videos + n.shorts,
			SHELF_TYPE_RECENT_UPLOADS: n.videos,
			SHELF_TYPE_POPULAR_UPLOADS: n.videos,
			SHELF_TYPE_SHORT_MOBILE_VIDEOS_UPLOADS: n.shorts,
			SHELF_TYPE_CREATED_PLAYLISTS: n.playlists,
			SHELF_TYPE_SUBSCRIPTIONS: n.subscriptions,
		})[type] ?? 0;
}

// the definitions a channel saved, cleaned; undefined when it never saved any
export function savedShelves(raw: unknown): ShelfDefinition[] | undefined {
	return Array.isArray(raw) ? (raw as ShelfDefinition[]) : undefined;
}

// Studio's shelfInfo: the saved sections in order with their counts, then
// the predefined ones not in use (saved: false)
export async function shelfInfo(channelId: string, saved: ShelfDefinition[] | undefined) {
	const count = await counts(channelId);
	const list = saved ?? DEFAULT_SAVED.map((type) => ({ predefinedShelfDefinition: { type, ...(type === "SHELF_TYPE_FOR_YOU" ? { forYouShelfInfo: FOR_YOU_DEFAULT } : {}) } }));
	const used = new Set<string>();
	const out: unknown[] = [];
	for (const d of list) {
		if ("predefinedShelfDefinition" in d) {
			const { type, forYouShelfInfo } = d.predefinedShelfDefinition;
			used.add(type);
			out.push({ itemsCount: count(type), predefinedShelfInfo: { type, saved: true, ...(type === "SHELF_TYPE_FOR_YOU" ? { forYouShelfInfo: { ...FOR_YOU_DEFAULT, ...forYouShelfInfo } } : {}) } });
		} else if ("playlistShelfDefinition" in d) {
			const id = d.playlistShelfDefinition.playlistId;
			const videoIds = (await sql`select i.video_id from playlist_items i join videos v on v.id = i.video_id where i.playlist_id = ${id} and v.deleted_at is null order by i.position`).map((r: { video_id: string }) => r.video_id);
			out.push({ itemsCount: videoIds.length, playlistShelfInfo: { playlistId: id, videoIds } });
		} else if ("playlistCollectionShelfDefinition" in d) {
			const { playlistIds, title } = d.playlistCollectionShelfDefinition;
			out.push({ itemsCount: playlistIds.length, playlistCollectionShelfInfo: { playlistIds, title } });
		} else if ("channelCollectionShelfDefinition" in d) {
			const { channelIds, title, type } = d.channelCollectionShelfDefinition;
			out.push({ itemsCount: channelIds.length, channelCollectionShelfInfo: { channelIds, title, type } });
		}
	}
	for (const type of PREDEFINED) if (!used.has(type)) out.push({ itemsCount: count(type), predefinedShelfInfo: { type, saved: false } });
	return out;
}

// a shelfListUpdate from Studio, checked against what the channel owns: its
// own public or unlisted playlists, existing channels; an error message when
// it can't be saved
export async function cleanShelves(update: unknown, channelId: string): Promise<ShelfDefinition[] | string> {
	const list = (update as { updateInfo?: { shelfInfo?: unknown[] } })?.updateInfo?.shelfInfo;
	if (!Array.isArray(list)) return "The layout is missing.";
	if (list.length > MAX_SHELVES) return `Add up to ${MAX_SHELVES} sections.`;
	const [{ user_id: owner }] = await sql`select user_id from channels where id = ${channelId}`;
	const ownPlaylists = async (ids: unknown[]) => {
		const want = ids.map(String).slice(0, 50);
		const rows = await sql`select id from playlists where user_id = ${owner} and kind = 'user' and visibility <> 'private' and id = any(${textArray(want)}::text[])`;
		const ok = new Set(rows.map((r: { id: string }) => r.id));
		return want.filter((id) => ok.has(id));
	};
	const out: ShelfDefinition[] = [];
	for (const d of list as Record<string, any>[]) {
		if (d?.predefinedShelfDefinition) {
			const type = String(d.predefinedShelfDefinition.type);
			if (!PREDEFINED.includes(type)) return "This section type isn't available.";
			const f = d.predefinedShelfDefinition.forYouShelfInfo;
			out.push({ predefinedShelfDefinition: { type, ...(type === "SHELF_TYPE_FOR_YOU" && f ? { forYouShelfInfo: { includeLongFormVideos: !!f.includeLongFormVideos, includeShorts: !!f.includeShorts, includeLivestreams: !!f.includeLivestreams, contentRecency: f.contentRecency === "FOR_YOU_CONTENT_RECENCY_RECENT_ONLY" ? f.contentRecency : "FOR_YOU_CONTENT_RECENCY_NONE" } } : {}) } });
		} else if (d?.playlistShelfDefinition) {
			const [id] = await ownPlaylists([d.playlistShelfDefinition.playlistId]);
			if (!id) return "Choose one of your playlists.";
			out.push({ playlistShelfDefinition: { playlistId: id } });
		} else if (d?.playlistCollectionShelfDefinition) {
			const ids = await ownPlaylists(d.playlistCollectionShelfDefinition.playlistIds ?? []);
			if (!ids.length) return "Choose at least one of your playlists.";
			out.push({ playlistCollectionShelfDefinition: { playlistIds: ids, title: String(d.playlistCollectionShelfDefinition.title ?? "").trim().slice(0, 100) } });
		} else if (d?.channelCollectionShelfDefinition) {
			const want = (d.channelCollectionShelfDefinition.channelIds ?? []).map(String).slice(0, 100);
			const rows = await sql`select id from channels where id = any(${textArray(want)}::text[])`;
			const ok = new Set(rows.map((r: { id: string }) => r.id));
			const ids = want.filter((id: string) => ok.has(id));
			if (!ids.length) return "Choose at least one channel.";
			out.push({ channelCollectionShelfDefinition: { channelIds: ids, title: String(d.channelCollectionShelfDefinition.title ?? "").trim().slice(0, 100), type: d.channelCollectionShelfDefinition.type === "SHELF_TYPE_SHOWS" ? "SHELF_TYPE_SHOWS" : "SHELF_TYPE_SELECTED_CHANNELS" } });
		} else return "This section type isn't available.";
	}
	return out;
}
