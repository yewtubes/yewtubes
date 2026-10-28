// /youtubei/v1/next for a video (and the watch page's ytInitialData), built
// from YouTube's watch page (templates watch/page_*): title and counts,
// like/dislike/share/save, owner and subscribe button, description and
// comments panels (comments load through a continuation, see comments.ts),
// related videos, autoplay and the end screen.

import type { Viewer } from "../client/page";
import { getVideo, isSubscribed, markWatched, reactionOf, relatedVideos } from "../data";
import { encodeToken } from "../ids";
import { topbar } from "./chrome";
import { entityKey as protoKey } from "./proto";
import { type Video, avatarUrl, compact, countLabel, dateText, grouped, responseContext } from "./r";
import { make } from "./tpl";
import { baseVars, videoVars } from "./vars";

export const RELATED_PAGE = 20;
const END_SCREEN = 12;

// entity keys the watch page's buttons read their state from
export const likeKey = (videoId: string) => protoKey(videoId, 62);
export const subscriptionKey = (channelId: string) => protoKey(channelId, 51);
export const likeStatusMutation = (videoId: string, reaction: string | null | undefined) => {
	const likeStatus = reaction === "like" ? "LIKE" : reaction === "dislike" ? "DISLIKE" : "INDIFFERENT";
	return { entityKey: likeKey(videoId), type: "ENTITY_MUTATION_TYPE_REPLACE", payload: { likeStatusEntity: { key: likeKey(videoId), likeStatus } } };
};

const relatedLockup = (v: Video, viewer: Viewer) => make(viewer ? "item/video_lockup_compact" : "item/video_lockup_compact_out", { ...baseVars(viewer, `/watch?v=${v.id}`), ...videoVars(v) });

export async function relatedItems(v: Video, viewer: Viewer, offset: number) {
	const related = await markWatched(viewer, await relatedVideos(v, RELATED_PAGE, offset));
	const items: unknown[] = related.map((r) => relatedLockup(r, viewer));
	if (related.length === RELATED_PAGE) items.push(make("item/continuation_related", { CONTINUATION: encodeToken({ k: "related", v: v.id, o: offset + RELATED_PAGE }) }));
	return { items, videos: related };
}

// the values of the watch page's own video
function pageVars(v: Video, viewer: Viewer, reaction: "like" | "dislike" | null, subscribed: boolean) {
	const when = v.published_at ?? v.created_at;
	const d = new Date(when);
	const others = v.like_count - (reaction === "like" ? 1 : 0);
	const subs = v.subscriber_count ?? 0;
	return {
		...baseVars(viewer, `/watch?v=${v.id}`),
		...videoVars(v),
		AT_HANDLE: `@${v.channel_handle}`,
		DESCRIPTION: v.description,
		VIEWS_FULL: v.view_count === 1 ? "1 view" : `${grouped(v.view_count)} views`,
		VIEWS_SHORT: v.view_count === 1 ? "1 view" : `${compact(v.view_count)} views`,
		VIEWS_COMPACT: compact(v.view_count),
		VIEW_COUNT: String(v.view_count),
		VIEW_COUNT_GROUPED: grouped(v.view_count),
		DATE: dateText(when),
		YEAR: String(d.getFullYear()),
		MONTH_DAY: d.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
		LIKES: others ? compact(others) : "",
		LIKES_IF_LIKED: compact(others + 1),
		LIKES_LABEL: countLabel(v.like_count, "like"),
		LIKES_GROUPED: grouped(others),
		LIKES_GROUPED_IF_LIKED: grouped(others + 1),
		LIKE_STATUS: reaction === "like" ? "LIKE" : reaction === "dislike" ? "DISLIKE" : "INDIFFERENT",
		SUBSCRIBERS: subs === 1 ? "1 subscriber" : `${compact(subs)} subscribers`,
		SUBSCRIBERS_LABEL: countLabel(subs, "subscriber"),
		SUBSCRIBE_LABEL: `Subscribe to ${v.channel_title}.`,
		UNSUBSCRIBE_LABEL: `Unsubscribe from ${v.channel_title}.`,
		BELL_LABEL_SUFFIX: `notification setting for ${v.channel_title}`,
		SUBSCRIBED: subscribed,
		OWNER_AVATAR: [48, 88, 176].map((s) => ({ url: avatarUrl(v.channel_id, s), width: s, height: s })),
		AVATAR_88: [{ url: avatarUrl(v.channel_id, 88) }],
		COMMENT_COUNT: compact(v.comment_count),
		COMMENTS_CONTINUATION: encodeToken({ k: "comments", v: v.id, s: "top" }),
		COMMENTS_TOP: encodeToken({ k: "comments", v: v.id, s: "top" }),
		COMMENTS_NEWEST: encodeToken({ k: "comments", v: v.id, s: "new" }),
	};
}

export async function watchNext(videoId: string, viewer: Viewer, opts: { playlist?: unknown } = {}) {
	const v = await getVideo(videoId, viewer);
	if (!v) return undefined;
	const [subscribed, reaction] = await Promise.all([isSubscribed(viewer, v.channel_id), reactionOf(viewer, v.id)]);
	const related = await relatedItems(v, viewer, 0);
	const io = viewer ? "in" : "out";
	const next = related.videos[0];
	const nextVars = next && { ...baseVars(viewer, `/watch?v=${next.id}`), ...videoVars(next) };
	const page = make(`watch/page_${io}`, {
		...pageVars(v, viewer, reaction, subscribed),
		RELATED: related.items,
		END_SCREEN: related.videos.slice(0, END_SCREEN).map((r) => make("item/end_screen_video", { ...baseVars(viewer), ...videoVars(r) })),
		AUTOPLAY: nextVars && make(`watch/autoplay_${io}`, nextVars),
		AUTOPLAY_OVERLAY: nextVars && make(`watch/autoplay_overlay_${io}`, nextVars),
	});
	const results = page.contents.twoColumnWatchNextResults;
	// a channel's owner gets no subscribe button on their own videos
	if (viewer?.channelId === v.channel_id) delete results.results.results.contents[1].videoSecondaryInfoRenderer.subscribeButton;
	if (opts.playlist) results.playlist = opts.playlist;
	const { mutations, ...rest } = page;
	const response = {
		responseContext: responseContext(viewer),
		...rest,
		topbar: topbar(viewer, `/watch?v=${v.id}`),
		// the like button shows the like status from the client's entity store
		// (not the likeStatusEntity it carries), so the status goes in as a mutation
		frameworkUpdates: { entityBatchUpdate: { mutations: [...(mutations ?? []), likeStatusMutation(v.id, reaction)], timestamp: { seconds: String(Math.floor(Date.now() / 1000)), nanos: 0 } } },
	};
	return { video: v, response };
}
