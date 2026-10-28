// Template variables for the entities this instance stores. Every template
// that shows a video, channel or playlist is filled from these, so the same
// value reads the same everywhere.

import { MUSIC_CATEGORY } from "../categories";
import { INSTANCE_NAME, PUBLIC_ORIGIN, STUDIO_ORIGIN } from "../config";
import type { Viewer } from "../client/page";
import { type Channel, type Video, avatarUrl, compact, countLabel, duration, durationLabel, grouped, lockupSources, shortAgo, ago, videoThumbnails } from "./r";
import type { Vars } from "./tpl";

export const signInUrl = (next = "/") => `/signin?next=${encodeURIComponent(next)}`;

export function baseVars(viewer: Viewer, next = "/"): Vars {
	return { ORIGIN: PUBLIC_ORIGIN, STUDIO_ORIGIN, INSTANCE_NAME, SIGNIN_URL: signInUrl(next), VIEWER_CHANNEL_ID: viewer?.channelId ?? "" };
}

export const avatarSources = (channelId: string, sizes: number[]) => sizes.map((s) => ({ url: avatarUrl(channelId, s), width: s, height: s }));

export function videoVars(v: Video): Vars {
	return {
		VIDEO_ID: v.id,
		TITLE: v.title,
		DURATION: duration(v.duration_ms),
		DURATION_LABEL: durationLabel(v.duration_ms),
		// YouTube's music note before a Music video's duration
		DURATION_ICON: v.category_id === MUSIC_CATEGORY ? { sources: [{ clientResource: { imageName: "MUSIC" } }] } : undefined,
		// the red bar on a video the viewer has watched some of
		PROGRESS_BAR: v.watched_ms && v.duration_ms ? { thumbnailOverlayProgressBarViewModel: { startPercent: Math.max(1, Math.min(100, Math.round((v.watched_ms / v.duration_ms) * 100))) } } : undefined,
		VIEWS: v.view_count ? compact(v.view_count) : "No views",
		VIEWS_LABEL: countLabel(v.view_count, "view"),
		VIEWS_FULL: v.view_count === 1 ? "1 view" : `${grouped(v.view_count)} views`,
		PUBLISHED: shortAgo(v.published_at ?? v.created_at),
		PUBLISHED_LABEL: ago(v.published_at ?? v.created_at),
		THUMBS: lockupSources(v.id),
		VIDEO_THUMBNAILS: videoThumbnails(v.id).thumbnails,
		CHANNEL_ID: v.channel_id,
		CHANNEL_NAME: v.channel_title,
		CHANNEL_URL: `/@${v.channel_handle}`,
		AVATAR: avatarSources(v.channel_id, [68]),
	};
}

export function channelVars(c: Channel): Vars {
	const desc = c.description ?? "";
	return {
		CHANNEL_ID: c.id,
		CHANNEL_NAME: c.title,
		HANDLE: c.handle,
		AT_HANDLE: `@${c.handle}`,
		DESCRIPTION: desc,
		DESCRIPTION_SHORT: desc.length > 160 ? `${desc.slice(0, 157)}...` : desc,
		DESCRIPTION_LABEL: `Description. ${desc.length > 60 ? `${desc.slice(0, 60)}...` : desc}tap for more.`,
		SUBSCRIBERS: c.subscriber_count === 1 ? "1 subscriber" : `${compact(c.subscriber_count)} subscribers`,
		SUBSCRIBERS_LABEL: countLabel(c.subscriber_count, "subscriber"),
		VIDEO_COUNT: c.video_count === 1 ? "1 video" : `${grouped(c.video_count)} videos`,
		AVATAR: avatarSources(c.id, [72, 120, 160]),
		AVATAR_900: avatarSources(c.id, [900]),
		AVATAR_200: avatarSources(c.id, [200]),
		AVATAR_URL: avatarUrl(c.id, 200),
		KEYWORDS: "",
	};
}
