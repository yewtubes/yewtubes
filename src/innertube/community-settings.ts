// A channel's Community (YouTube's Communities, browse FEcommunity_page) is
// opened from Studio's Viewer posts setting: commentsSettings.viewerPostSettings,
// as Studio reads it and sends it back in update_creator_channel's
// communitySettingsRequest. Who may post there: subscribers of at least the
// minimum subscription time (the only poster type Studio offers), and the
// channel itself.

import type { Viewer } from "../client/page";
import { sql } from "../db";

export type ViewerPostSettings = {
	enablementType: "VIEWER_POST_ENABLEMENT_TYPE_ON" | "VIEWER_POST_ENABLEMENT_TYPE_OFF";
	moderationType: string;
	allowedPosterType: "VIEWER_POST_ALLOWED_POSTER_TYPE_SUBSCRIBERS_ONLY";
	minimumSubscriberDuration: { seconds: string };
};

// Studio's defaults for a channel that never changed them
const DEFAULT: ViewerPostSettings = {
	enablementType: "VIEWER_POST_ENABLEMENT_TYPE_OFF",
	moderationType: "VIEWER_POST_MODERATION_TYPE_BASIC_AUTOMOD",
	allowedPosterType: "VIEWER_POST_ALLOWED_POSTER_TYPE_SUBSCRIBERS_ONLY",
	minimumSubscriberDuration: { seconds: "86400" },
};
const MODERATION = ["VIEWER_POST_MODERATION_TYPE_BASIC_AUTOMOD", "VIEWER_POST_MODERATION_TYPE_STRICT_AUTOMOD", "VIEWER_POST_MODERATION_TYPE_HOLD_ALL"];
// Studio's Minimum subscription time choices top out at a year
const MAX_DURATION = 366 * 86400;

export function viewerPostSettings(stored: unknown): ViewerPostSettings {
	const s = (stored ?? {}) as Partial<ViewerPostSettings>;
	return { ...DEFAULT, ...s, minimumSubscriberDuration: { seconds: String(s.minimumSubscriberDuration?.seconds ?? DEFAULT.minimumSubscriberDuration.seconds) } };
}

// what Studio sent, kept to the values it offers; undefined when unusable
export function cleanViewerPostSettings(v: any): ViewerPostSettings | undefined {
	if (!v || typeof v !== "object") return undefined;
	const on = v.enablementType === "VIEWER_POST_ENABLEMENT_TYPE_ON";
	if (!on && v.enablementType !== "VIEWER_POST_ENABLEMENT_TYPE_OFF") return undefined;
	const seconds = Math.min(MAX_DURATION, Math.max(0, Math.floor(Number(v.minimumSubscriberDuration?.seconds ?? DEFAULT.minimumSubscriberDuration.seconds)) || 0));
	return {
		enablementType: on ? "VIEWER_POST_ENABLEMENT_TYPE_ON" : "VIEWER_POST_ENABLEMENT_TYPE_OFF",
		moderationType: MODERATION.includes(v.moderationType) ? v.moderationType : DEFAULT.moderationType,
		allowedPosterType: "VIEWER_POST_ALLOWED_POSTER_TYPE_SUBSCRIBERS_ONLY",
		minimumSubscriberDuration: { seconds: String(seconds) },
	};
}

export const communityOpen = (c: { viewer_posts?: unknown }) => viewerPostSettings(c.viewer_posts).enablementType === "VIEWER_POST_ENABLEMENT_TYPE_ON";

// whether the viewer may post in the channel's Community: the channel
// itself, or a subscriber of at least the minimum subscription time
export async function mayPostInCommunity(c: { id: string; viewer_posts?: unknown }, viewer: Viewer): Promise<boolean> {
	if (!viewer || !communityOpen(c)) return false;
	if (viewer.channelId === c.id) return true;
	const seconds = Number(viewerPostSettings(c.viewer_posts).minimumSubscriberDuration.seconds);
	const [s] = await sql`select 1 from subscriptions where user_id = ${viewer.userId} and channel_id = ${c.id} and created_at <= now() - make_interval(secs => ${seconds})`;
	return !!s;
}

// the minimum subscription time in words ("1 day", "2 weeks")
export function durationText(seconds: number): string {
	const units: [number, string][] = [[365 * 86400, "year"], [30 * 86400, "month"], [7 * 86400, "week"], [86400, "day"], [3600, "hour"], [60, "minute"]];
	for (const [n, name] of units) if (seconds >= n && seconds % n === 0) return `${seconds / n} ${name}${seconds / n === 1 ? "" : "s"}`;
	return seconds ? `${seconds} seconds` : "";
}
