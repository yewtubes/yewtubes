// player, next and get_watch.

import { getVideo } from "../data";
import { decodeToken, isVideoId } from "../ids";
import { commentsContinuation } from "./comments";
import { playerResponse } from "./player";
import { responseContext } from "./r";
import { relatedItems, watchNext } from "./watch";
import { ApiError, route } from "./router";
import { playlistPanel } from "./playlists";
import { recordWatch } from "./history";

route("player", async ({ body, viewer }) => {
	const id = body.videoId;
	if (!isVideoId(id)) throw new ApiError(400, "Invalid video id");
	return playerResponse(await getVideo(id, viewer), viewer, id, Number(body.startTimeSecs) || undefined);
});

async function next(body: any, viewer: any) {
	if (body.continuation) {
		const tok = decodeToken<{ k: string; v: string; o?: number; s?: string; c?: string }>(body.continuation);
		if (!tok) throw new ApiError(400, "Invalid continuation");
		if (tok.k === "related") {
			const v = await getVideo(tok.v, viewer);
			if (!v) throw new ApiError(404, "Not found");
			return { responseContext: responseContext(viewer), onResponseReceivedEndpoints: [{ appendContinuationItemsAction: { continuationItems: (await relatedItems(v, viewer, tok.o ?? 0)).items, targetId: "watch-next-feed" } }] };
		}
		if (tok.k === "comments" || tok.k === "replies") return commentsContinuation(tok, viewer);
		throw new ApiError(400, "Unknown continuation");
	}
	const id = body.videoId;
	if (!isVideoId(id)) throw new ApiError(400, "Invalid video id");
	const playlist = body.playlistId ? await playlistPanel(body.playlistId, id, viewer, body.playlistIndex) : undefined;
	const out = await watchNext(id, viewer, { playlist });
	if (!out) return { responseContext: responseContext(viewer), contents: { twoColumnWatchNextResults: { results: { results: { contents: [] } } } } };
	return out.response;
}

route("next", ({ body, viewer }) => next(body, viewer));

// the in-app navigation fetches both halves of a watch page in one call
route("get_watch", async ({ body, viewer }) => {
	const p = body.playerRequest ?? {};
	const n = body.watchNextRequest ?? {};
	const id = p.videoId ?? n.videoId;
	if (!isVideoId(id)) throw new ApiError(400, "Invalid video id");
	const video = await getVideo(id, viewer);
	if (video && viewer) void recordWatch(viewer, video.id);
	return [
		{ responseContext: responseContext(viewer), playerResponse: await playerResponse(video, viewer, id, Number(p.startTimeSecs) || undefined), responseType: "RESPONSE_TYPE_PLAYER", subStreamResponseCompleted: true },
		{ responseContext: responseContext(viewer), watchNextResponse: await next({ ...n, videoId: id }, viewer), responseType: "RESPONSE_TYPE_WATCH_NEXT", subStreamResponseCompleted: true },
	];
});
