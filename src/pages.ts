// Direct page loads: map a URL to the page kind and the initial data the
// app would otherwise fetch from /youtubei/v1 after navigating in-app.

import type { PageData, Viewer } from "./client/page";
import { getVideo } from "./data";
import { isVideoId } from "./ids";
import { playerResponse, startSeconds } from "./innertube/player";
import { watchEndpoint } from "./innertube/r";
import { watchNext } from "./innertube/watch";
import { playlistPanel } from "./innertube/playlists";
import { browsePage } from "./innertube/browse";
import { searchPage } from "./innertube/search";
import { recordWatch } from "./innertube/history";
import { shortsPage } from "./innertube/shorts";

export async function pageFor(url: URL, viewer: Viewer): Promise<PageData | Response | undefined> {
	const path = url.pathname;
	const pageUrl = path + url.search;
	if (path === "/watch") {
		const id = url.searchParams.get("v") ?? "";
		if (!isVideoId(id)) return Response.redirect("/", 302);
		const list = url.searchParams.get("list") ?? undefined;
		const index = url.searchParams.get("index") ? Number(url.searchParams.get("index")) - 1 : undefined;
		const playlist = list ? await playlistPanel(list, id, viewer, index) : undefined;
		const next = await watchNext(id, viewer, { playlist });
		const video = next?.video ?? (await getVideo(id, viewer));
		if (video && viewer) void recordWatch(viewer, video.id);
		const t = startSeconds(url.searchParams.get("t"));
		return {
			kind: "watch",
			url: pageUrl,
			title: video?.title ?? "",
			description: video?.description.slice(0, 160),
			initialData: next?.response ?? { contents: {} },
			playerResponse: await playerResponse(video, viewer, id, t),
			command: watchEndpoint(id, { playlistId: list, index, startTimeSeconds: t }),
			thumbnail: video ? `/vi/${id}/hqdefault.jpg` : undefined,
		};
	}
	if (path === "/results") return searchPage(url, viewer);
	if (/^\/shorts(?:\/(?:[A-Za-z0-9_-]{11})?)?$/.test(path)) return shortsPage(url, viewer);
	return browsePage(url, viewer);
}
