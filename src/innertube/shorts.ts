// The Shorts player: /shorts/<id> pages, reel/reel_item_watch (one Short's
// overlay, description and comments panels; templates shorts/item_*) and
// reel/reel_watch_sequence (the Shorts that follow, templates shorts/entry
// and shorts/continuation). A Short is a public, ready video that is
// vertical or square and up to three minutes long (data.ts isShort).

import type { PageData, Viewer } from "../client/page";
import { getVideo, isShort, isSubscribed, reactionOf, shortVideos } from "../data";
import { decodeToken, encodeToken, isVideoId } from "../ids";
import { topbar } from "./chrome";
import { recordWatch } from "./history";
import { playerResponse } from "./player";
import { type Video, avatarUrl, compact, countLabel, dateText, grouped, responseContext } from "./r";
import { ApiError, route } from "./router";
import { make, tpl } from "./tpl";
import { baseVars, videoVars } from "./vars";
import { likeStatusMutation, subscriptionKey } from "./watch";

const SEQUENCE_PAGE = 10;

export const shortsUrl = (id: string) => `/shorts/${id}`;

// the command that opens a Short (as the client's own links carry it)
export function reelWatchEndpoint(v: Video) {
	return {
		commandMetadata: { webCommandMetadata: { url: shortsUrl(v.id), webPageType: "WEB_PAGE_TYPE_SHORTS", rootVe: 37414 } },
		reelWatchEndpoint: {
			videoId: v.id,
			thumbnail: { thumbnails: frame0(v), isOriginalAspectRatio: true },
			overlay: { reelPlayerOverlayRenderer: { style: "REEL_PLAYER_OVERLAY_STYLE_SHORTS", reelPlayerNavigationModel: "REEL_PLAYER_NAVIGATION_MODEL_UNSPECIFIED" } },
			// the Shorts that follow come from reel_watch_sequence
			sequenceProvider: "REEL_WATCH_SEQUENCE_PROVIDER_RPC",
			sequenceParams: sequenceToken(v.id),
		},
	};
}

// the full frame at the video's own aspect (media/process.ts writes frame0)
function frame0(v: Video) {
	const scale = Math.min(1, 1920 / (v.height || 1920));
	return [{ url: `/vi/${v.id}/frame0.jpg`, width: Math.round((v.width || 1080) * scale), height: Math.round((v.height || 1920) * scale) }];
}

// "22h" "Ago" within a day; otherwise the date, as the description panel shows it
function uploadFactoid(when: Date) {
	const minutes = Math.max(0, Math.floor((Date.now() - new Date(when).getTime()) / 60000));
	if (minutes < 60) return { UPLOAD_VALUE: `${minutes}m`, UPLOAD_LABEL: "Ago" };
	if (minutes < 24 * 60) return { UPLOAD_VALUE: `${Math.floor(minutes / 60)}h`, UPLOAD_LABEL: "Ago" };
	const d = new Date(when);
	return { UPLOAD_VALUE: d.toLocaleDateString("en-US", { month: "short", day: "numeric" }), UPLOAD_LABEL: String(d.getFullYear()) };
}

export async function shortsItem(v: Video, viewer: Viewer) {
	const [subscribed, reaction] = await Promise.all([isSubscribed(viewer, v.channel_id), reactionOf(viewer, v.id)]);
	const when = v.published_at ?? v.created_at;
	const others = v.like_count - (reaction === "like" ? 1 : 0);
	const comments = v.comment_count === 1 ? "1 comment" : `${grouped(v.comment_count)} comments`;
	const item = make(`shorts/item_${viewer ? "in" : "out"}`, {
		...baseVars(viewer, shortsUrl(v.id)),
		...videoVars(v),
		...uploadFactoid(when),
		AT_HANDLE: `@${v.channel_handle}`,
		DESCRIPTION: v.description || "No description has been added to this video.",
		VIEWS_COMPACT: compact(v.view_count),
		DATE: dateText(when),
		UPLOAD_A11Y: videoVars(v).PUBLISHED_LABEL,
		LIKES: others ? compact(others) : "Like",
		LIKES_IF_LIKED: compact(others + 1),
		LIKES_COMPACT: compact(v.like_count),
		LIKES_LABEL: countLabel(v.like_count, "like"),
		LIKE_A11Y: others ? `like this video along with ${countLabel(others, "other person", "other people")}` : "like this video",
		LIKED_A11Y: `${grouped(others + 1)} ${others + 1 === 1 ? "like" : "likes"}`,
		LIKED: reaction === "like",
		LIKE_STATUS: reaction === "like" ? "LIKE" : reaction === "dislike" ? "DISLIKE" : "INDIFFERENT",
		COMMENT_COUNT: v.comment_count ? compact(v.comment_count) : "0",
		COMMENT_A11Y: `View ${comments}`,
		COMMENTS_TOP: encodeToken({ k: "comments", v: v.id, s: "top", t: "s" }),
		COMMENTS_NEWEST: encodeToken({ k: "comments", v: v.id, s: "new", t: "s" }),
		AVATAR_48: [{ url: avatarUrl(v.channel_id, 48) }],
		AVATAR_88: [{ url: avatarUrl(v.channel_id, 88) }],
		FRAMEWORK_UPDATES: {
			entityBatchUpdate: {
				mutations: [
					likeStatusMutation(v.id, reaction),
					{ entityKey: subscriptionKey(v.channel_id), type: "ENTITY_MUTATION_TYPE_REPLACE", payload: { subscriptionStateEntity: { key: subscriptionKey(v.channel_id), subscribed } } },
				],
				timestamp: { seconds: String(Math.floor(Date.now() / 1000)), nanos: 0 },
			},
			elementUpdate: tpl("shorts/elements"),
		},
	});
	// a channel's owner gets no subscribe button on their own Shorts
	if (viewer?.channelId === v.channel_id) {
		const bar = item.overlay.reelPlayerOverlayRenderer.playerOverlay.reelPlayerOverlayViewModel.metapanel.reelMetapanelViewModel.metadataItems.find((m: any) => m.reelChannelBarViewModel)?.reelChannelBarViewModel;
		if (bar) delete bar.subscribeButtonViewModel;
	}
	return item;
}

// the Shorts after `current`, newest first
async function sequence(current: string, offset: number, viewer: Viewer) {
	const videos = await shortVideos(SEQUENCE_PAGE + 1, offset, current);
	const entries = videos.slice(0, SEQUENCE_PAGE).map((v) => make("shorts/entry", { ...baseVars(viewer, shortsUrl(v.id)), VIDEO_ID: v.id, FRAME0: frame0(v) }));
	return {
		responseContext: responseContext(viewer),
		entries,
		...(videos.length > SEQUENCE_PAGE ? { continuationEndpoint: make("shorts/continuation", { CONTINUATION: sequenceToken(current, offset + SEQUENCE_PAGE) }) } : {}),
	};
}
const sequenceToken = (current: string, offset = 0) => encodeToken({ k: "shorts", v: current, o: offset });

async function shortOrThrow(id: unknown, viewer: Viewer) {
	if (!isVideoId(id)) throw new ApiError(400, "Invalid video id");
	const v = await getVideo(id, viewer);
	if (!v?.playable) throw new ApiError(404, "Not found");
	return v;
}

route("reel/reel_item_watch", async ({ body, viewer }) => {
	const id = body.playerRequest?.videoId ?? body.videoId;
	// seedless (the guide's Shorts entry): the newest Short, which the client
	// then navigates to (replacementEndpoint) with its sequence
	if (!id) {
		const [v] = await shortVideos(1);
		if (!v) return { responseContext: responseContext(viewer), status: "REEL_ITEM_WATCH_STATUS_EMPTY" };
		return { responseContext: responseContext(viewer), ...(await shortsItem(v, viewer)), replacementEndpoint: reelWatchEndpoint(v), sequenceContinuation: sequenceToken(v.id), topbar: topbar(viewer, shortsUrl(v.id)) };
	}
	const v = await shortOrThrow(id, viewer);
	if (viewer) void recordWatch(viewer, v.id);
	return { responseContext: responseContext(viewer), ...(await shortsItem(v, viewer)), topbar: topbar(viewer, shortsUrl(v.id)) };
});

route("reel/reel_watch_sequence", async ({ body, viewer }) => {
	const t = decodeToken<{ k: string; v: string; o?: number }>(String(body.sequenceParams ?? body.continuation ?? ""));
	return sequence(t?.k === "shorts" ? t.v : "", t?.o ?? 0, viewer);
});

// /shorts/<id>, and /shorts or /shorts/ (the newest Short, as YouTube opens a feed of them)
export async function shortsPage(url: URL, viewer: Viewer): Promise<PageData | Response | undefined> {
	const id = url.pathname.slice("/shorts/".length);
	let v: Video | undefined;
	if (id) {
		v = isVideoId(id) ? await getVideo(id, viewer) : undefined;
		if (!v) return undefined;
		if (!isShort(v) || !v.playable) return Response.redirect(`/watch?v=${id}`, 302);
	} else {
		[v] = await shortVideos(1);
		if (!v) return Response.redirect("/", 302);
	}
	if (viewer) void recordWatch(viewer, v.id);
	const command = reelWatchEndpoint(v);
	return {
		kind: "shorts",
		url: shortsUrl(v.id),
		title: v.title,
		description: v.description.slice(0, 160),
		initialData: {
			responseContext: responseContext(viewer),
			...(await shortsItem(v, viewer)),
			...(id ? {} : { replacementEndpoint: command }),
			sequenceContinuation: sequenceToken(v.id),
			topbar: topbar(viewer, shortsUrl(v.id)),
		},
		playerResponse: await playerResponse(v, viewer, v.id),
		// a Short's own page carries the Shorts that follow; /shorts/ has the
		// client ask for them (sequenceContinuation)
		...(id ? { reelSequence: await sequence(v.id, 0, viewer) } : {}),
		command,
		thumbnail: `/vi/${v.id}/frame0.jpg`,
	};
}
