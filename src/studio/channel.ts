// The channel as Studio sees it (CreatorChannelData): the page prefetches it
// and creator/get_creator_channels returns it, both through a field mask.

import type { Viewer } from "../client/page";
import { sql, textArray } from "../db";
import { make } from "../innertube/tpl";
import { avatarThumbnails } from "../innertube/r";
import { viewerPostSettings } from "../innertube/community-settings";

export type Mask = Record<string, unknown> | null;

// keeps the fields a creator API mask asks for: `x: true` or `x: {all: true}`
// the whole field, `x: {...}` the masked subfields
export function applyMask(o: any, mask: Mask): any {
	if (!mask || mask.all === true || !o || typeof o !== "object" || Array.isArray(o)) return o;
	const out: Record<string, unknown> = {};
	for (const [k, m] of Object.entries(mask)) {
		if (!(k in o)) continue;
		out[k] = m === true ? o[k] : m && typeof m === "object" ? applyMask(o[k], m as Mask) : o[k];
	}
	return out;
}

export async function creatorChannel(viewer: NonNullable<Viewer>, mask: Mask, channelId = viewer.channelId) {
	const [c] = await sql`select c.id, c.title, c.created_at, c.viewer_posts,
			(select count(*)::int from videos v where v.channel_id = c.id and v.deleted_at is null) as videos,
			(select coalesce(sum(view_count), 0)::bigint from videos v where v.channel_id = c.id and v.deleted_at is null) as views,
			(select count(*)::int from subscriptions s where s.channel_id = c.id) as subs
		from channels c where c.id = ${channelId}`;
	if (!c) return null;
	const ch = make<Record<string, unknown>>("studio/channel", {
		CHANNEL_ID: c.id,
		TITLE: c.title,
		AVATARS: avatarThumbnails(c.id),
		METRIC: { subscriberCount: String(c.subs), videoCount: String(c.videos), totalVideoViewCount: String(c.views) },
		TIME_CREATED: String(Math.floor(new Date(c.created_at).getTime() / 1000)),
	});
	// only the owner sees the owner's permissions
	if (c.id !== viewer.channelId) return null;
	// Settings > Community: Viewer posts, which opens the channel's Community
	(ch.commentsSettings as { viewerPostSettings: unknown }).viewerPostSettings = viewerPostSettings(c.viewer_posts);
	return applyMask(ch, mask);
}

// another channel as Studio shows it beside the owner's data (a commenter, a
// subscriber): its public fields only
export async function publicChannels(ids: string[]) {
	if (!ids.length) return [];
	const rows = (await sql`select c.id, c.title, c.handle, c.verification,
			(select count(*)::int from subscriptions s where s.channel_id = c.id) as subs
		from channels c where c.id = any(${textArray(ids)}::text[])`) as { id: string; title: string; handle: string; verification: string; subs: number }[];
	return rows.map((r) => ({
		channelId: r.id,
		title: r.title,
		channelHandle: `@${r.handle}`,
		thumbnailDetails: avatarThumbnails(r.id),
		isNameVerified: r.verification !== "none",
		metric: { subscriberCount: String(r.subs) },
	}));
}
