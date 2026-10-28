// /youtubei/v1/player and the watch page's ytInitialPlayerResponse.
//
// streamingData lists this instance's encodings with direct URLs (no
// signatureCipher, no serverAbrStreamingUrl), which makes the pinned player
// take its classic DASH path: it reads initRange/indexRange, parses the sidx
// and fetches segments with &range=a-b. formats[] carries the progressive
// itag 18 fallback. playbackTracking points the player's stats pings at
// /api/stats/*, which counts views.

import { categoryName } from "../categories";
import { PUBLIC_ORIGIN } from "../config";
import { sql } from "../db";
import type { Viewer } from "../client/page";
import { streamUrl } from "../media/serve";
import { trackingParamFor } from "../client/integrity";
import { type Video, channelUrl, responseContext, text, videoThumbnails } from "./r";

type FormatRow = {
	itag: number;
	kind: "muxed" | "video" | "audio";
	mime_type: string;
	size: string;
	bitrate: number;
	average_bitrate: number;
	width: number | null;
	height: number | null;
	fps: number | null;
	quality: string;
	quality_label: string | null;
	init_start: number | null;
	init_end: number | null;
	index_start: number | null;
	index_end: number | null;
	audio_sample_rate: number | null;
	audio_channels: number | null;
	duration_ms: number;
};

function formatJson(videoId: string, f: FormatRow, viewerKey: string, lastModified: string) {
	const size = Number(f.size);
	const out: Record<string, unknown> = {
		itag: f.itag,
		url: streamUrl(videoId, f.itag, f.mime_type.split(";")[0], size, viewerKey),
		mimeType: f.mime_type,
		bitrate: f.bitrate,
	};
	if (f.kind !== "audio") Object.assign(out, { width: f.width, height: f.height });
	if (f.kind !== "muxed") {
		out.initRange = { start: String(f.init_start), end: String(f.init_end) };
		out.indexRange = { start: String(f.index_start), end: String(f.index_end) };
	}
	Object.assign(out, { lastModified, contentLength: String(size), quality: f.quality });
	if (f.kind !== "audio") Object.assign(out, { fps: f.fps, qualityLabel: f.quality_label, projectionType: "RECTANGULAR" });
	out.averageBitrate = f.average_bitrate;
	if (f.kind !== "video") Object.assign(out, { audioQuality: f.kind === "muxed" ? "AUDIO_QUALITY_LOW" : "AUDIO_QUALITY_MEDIUM" });
	out.approxDurationMs = String(f.duration_ms);
	if (f.kind !== "video") Object.assign(out, { audioSampleRate: String(f.audio_sample_rate), audioChannels: f.audio_channels });
	if (f.kind === "audio") Object.assign(out, { loudnessDb: 0 });
	return out;
}

export async function streamingData(video: Video, viewer: Viewer) {
	const rows = (await sql`select * from video_formats where video_id = ${video.id} order by kind, height nulls first, itag`) as FormatRow[];
	const viewerKey = video.visibility === "private" && viewer ? viewer.userId : "0";
	const lastModified = String((video.published_at ?? video.created_at).getTime() * 1000);
	return {
		expiresInSeconds: "21540",
		formats: rows.filter((f) => f.kind === "muxed").map((f) => formatJson(video.id, f, viewerKey, lastModified)),
		adaptiveFormats: rows.filter((f) => f.kind !== "muxed").map((f) => formatJson(video.id, f, viewerKey, lastModified)),
	};
}

function stats(path: string, video: Video, viewer: Viewer) {
	const q = new URLSearchParams({ docid: video.id, ns: "yt", el: "detailpage", len: String(Math.round((video.duration_ms ?? 0) / 1000)), of: "yewtube", vm: viewer ? viewer.userId : "0" });
	return { baseUrl: `${PUBLIC_ORIGIN}/api/stats/${path}?${q}` };
}

export function unplayable(status: "ERROR" | "UNPLAYABLE" | "LOGIN_REQUIRED", reason: string, subreason?: string) {
	return {
		status,
		reason,
		errorScreen: {
			playerErrorMessageRenderer: {
				reason: text(reason),
				...(subreason ? { subreason: text(subreason) } : {}),
				thumbnail: { thumbnails: [{ url: `${PUBLIC_ORIGIN}/_up/www.gstatic.com/youtube/img/icons/web/youtube_fill/offline_no_content/v1/192px.svg`, width: 140, height: 100 }] },
				icon: { iconType: "ERROR_OUTLINE" },
			},
		},
		contextParams: "Q0FBU0FnZ0E=",
	};
}

// a watch URL's t= (11, 11s, 1m5s, 1h2m3s) in seconds
export function startSeconds(t: string | null | undefined): number | undefined {
	const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/.exec(t ?? "");
	if (!m || !t) return undefined;
	const s = Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
	return s > 0 ? s : undefined;
}

// start: where playback begins (the URL's t=, the player request's
// startTimeSecs), which the player takes from playerConfig.playbackStartConfig
export async function playerResponse(video: Video | undefined, viewer: Viewer, requestedId?: string, start?: number): Promise<Record<string, unknown>> {
	if (!video) {
		return { responseContext: responseContext(viewer), playabilityStatus: unplayable("ERROR", "This video isn't available anymore"), trackingParams: "" };
	}
	// watchable from the first format, while the rest is still being made
	const ready = video.playable;
	const lengthSeconds = String(Math.round((video.duration_ms ?? 0) / 1000));
	const playability = ready
		? { status: "OK", playableInEmbed: true, miniplayer: { miniplayerRenderer: { playbackMode: "PLAYBACK_MODE_ALLOW" } }, contextParams: "Q0FBU0FnZ0E=" }
		: video.status === "failed"
			? unplayable("ERROR", "Processing failed", "This video could not be processed.")
			: unplayable("UNPLAYABLE", "This video is still being processed", "Check back in a few minutes.");
	const published = (video.published_at ?? video.created_at).toISOString();
	return {
		// the app's response check (client/integrity.ts) needs this to show the player
		responseContext: responseContext(viewer, {}, trackingParamFor(video.id)),
		playabilityStatus: playability,
		...(ready ? { streamingData: await streamingData(video, viewer) } : {}),
		playbackTracking: ready
			? {
					videostatsPlaybackUrl: stats("playback", video, viewer),
					videostatsDelayplayUrl: stats("delayplay", video, viewer),
					videostatsWatchtimeUrl: stats("watchtime", video, viewer),
					ptrackingUrl: stats("ptracking", video, viewer),
					qoeUrl: stats("qoe", video, viewer),
					atrUrl: { ...stats("atr", video, viewer), elapsedMediaTimeSeconds: 5 },
					videostatsScheduledFlushWalltimeSeconds: [10, 20, 30],
					videostatsDefaultFlushIntervalSeconds: 40,
				}
			: undefined,
		videoDetails: {
			videoId: video.id,
			title: video.title,
			lengthSeconds,
			channelId: video.channel_id,
			isOwnerViewing: !!viewer && viewer.channelId === video.channel_id,
			shortDescription: video.description,
			isCrawlable: video.visibility === "public",
			thumbnail: videoThumbnails(video.id),
			allowRatings: true,
			viewCount: String(video.view_count),
			author: video.channel_title,
			isPrivate: video.visibility === "private",
			isUnpluggedCorpus: false,
			isLiveContent: false,
		},
		playerConfig: {
			audioConfig: { loudnessDb: 0, perceptualLoudnessDb: -14, enablePerFormatLoudness: false },
			streamSelectionConfig: { maxBitrate: "8000000" },
			mediaCommonConfig: { dynamicReadaheadConfig: { maxReadAheadMediaTimeMs: 120000, minReadAheadMediaTimeMs: 15000, readAheadGrowthRateMs: 1000 } },
			webPlayerConfig: { useCobaltTvosDash: true },
			...(start && start > 0 && start * 1000 < (video.duration_ms ?? 0) ? { playbackStartConfig: { startSeconds: start } } : {}),
		},
		microformat: {
			playerMicroformatRenderer: {
				thumbnail: { thumbnails: [{ url: `${PUBLIC_ORIGIN}/vi/${video.id}/maxresdefault.jpg`, width: 1280, height: 720 }] },
				embed: { iframeUrl: `${PUBLIC_ORIGIN}/embed/${video.id}`, width: 1280, height: 720 },
				title: text(video.title),
				description: text(video.description),
				lengthSeconds,
				ownerProfileUrl: PUBLIC_ORIGIN + channelUrl(video.channel_handle),
				externalChannelId: video.channel_id,
				isFamilySafe: true,
				availableCountries: [],
				isUnlisted: video.visibility === "unlisted",
				hasYpcMetadata: false,
				viewCount: String(video.view_count),
				category: categoryName(video.category_id),
				publishDate: published,
				ownerChannelName: video.channel_title,
				uploadDate: published,
				isShortsEligible: false,
				externalVideoId: video.id,
				likeCount: String(video.like_count),
				canonicalUrl: `${PUBLIC_ORIGIN}/watch?v=${video.id}`,
			},
		},
		trackingParams: "",
	};
}
