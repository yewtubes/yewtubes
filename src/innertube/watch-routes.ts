// player, next and get_watch.

import { getVideo } from "../data";
import { decodeToken, isVideoId } from "../ids";
import { commentsContinuation } from "./comments";
import { playerResponse } from "./player";
import { responseContext } from "./r";
import { RELATED_FILTERS, relatedItems, watchNext } from "./watch";
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
		const tok = decodeToken<{ k: string; v: string; o?: number; s?: string; c?: string; f?: string }>(body.continuation);
		if (!tok) throw new ApiError(400, "Invalid continuation");
		if (tok.k === "related" || tok.k === "relchip") {
			const v = await getVideo(tok.v, viewer);
			if (!v) throw new ApiError(404, "Not found");
			const filter = RELATED_FILTERS.find((f) => f === tok.f) ?? "all";
			const { items } = await relatedItems(v, viewer, tok.o ?? 0, filter);
			// a chip: the list replaced; scrolling: more of it
			const action = tok.k === "relchip" ? { reloadContinuationItemsCommand: { targetId: "watch-next-feed", continuationItems: items, slot: "RELOAD_CONTINUATION_SLOT_BODY" } } : { appendContinuationItemsAction: { continuationItems: items, targetId: "watch-next-feed" } };
			return { responseContext: responseContext(viewer), onResponseReceivedEndpoints: [action] };
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
