// Likes, subscriptions, sharing, history: the mutations behind the watch
// page and channel buttons. Each returns the actions and entity updates the
// client applies, and persists the change so a reload shows the same state.

import type { Viewer } from "../client/page";
import { PUBLIC_ORIGIN } from "../config";
import { isShort, getChannel, getVideo } from "../data";
import { sql } from "../db";
import { recordSubscription } from "../stats";
import { isChannelId, isVideoId } from "../ids";
import { avatarThumbnails, channelEndpoint, label, responseContext, runs, text } from "./r";
import { ApiError, route } from "./router";
import { likeStatusMutation, subscriptionKey } from "./watch";
import { getPlaylist, setSaved } from "./playlists";
import { decode, fromBase64, str } from "./proto";
import { make } from "./tpl";

const toast = (message: string) => ({ addToToastAction: { item: { notificationActionRenderer: { responseText: runs(message) } } } });
const now = () => ({ seconds: String(Math.floor(Date.now() / 1000)), nanos: 0 });

async function react(videoId: string, userId: string, kind: "like" | "dislike" | null) {
	await sql.begin(async (tx) => {
		const [prev] = await tx`select kind from video_reactions where user_id = ${userId} and video_id = ${videoId} for update`;
		if (prev?.kind === kind) return;
		if (kind) await tx`insert into video_reactions (user_id, video_id, kind) values (${userId}, ${videoId}, ${kind}) on conflict (user_id, video_id) do update set kind = ${kind}, created_at = now()`;
		else await tx`delete from video_reactions where user_id = ${userId} and video_id = ${videoId}`;
		const delta = (kind === "like" ? 1 : 0) - (prev?.kind === "like" ? 1 : 0);
		if (delta) await tx`update videos set like_count = greatest(0, like_count + ${delta}) where id = ${videoId}`;
	});
}

for (const [method, kind] of [["like/like", "like"], ["like/dislike", "dislike"], ["like/removelike", null]] as const) {
	route(
		method,
		async ({ body, viewer }) => {
			// a playlist target saves it to (or removes it from) the library
			const playlistId = body.target?.playlistId;
			if (typeof playlistId === "string" && kind !== "dislike") {
				await setSaved(playlistId, viewer!, kind === "like");
				return { responseContext: responseContext(viewer), actions: [toast(kind === "like" ? "Added to Library" : "Removed from Library")] };
			}
			const id = body.target?.videoId;
			if (!isVideoId(id)) throw new ApiError(400, "Invalid video id");
			if (!(await getVideo(id, viewer))) throw new ApiError(404, "Video not found");
			await react(id, viewer!.userId, kind);
			return {
				responseContext: responseContext(viewer),
				actions: kind === "like" ? [toast("Added to Liked videos")] : kind === null ? [] : [toast("You dislike this video")],
				frameworkUpdates: { entityBatchUpdate: { mutations: [likeStatusMutation(id, kind)], timestamp: now() } },
			};
		},
		{ mutation: true },
	);
}

function subscriptionMutation(channelId: string, subscribed: boolean) {
	const key = subscriptionKey(channelId);
	return { entityKey: key, type: "ENTITY_MUTATION_TYPE_REPLACE", payload: { subscriptionStateEntity: { key, subscribed } } };
}

route(
	"subscription/subscribe",
	async ({ body, viewer }) => {
		const ids: string[] = (Array.isArray(body.channelIds) ? body.channelIds : []).filter(isChannelId).slice(0, 10);
		if (!ids.length) throw new ApiError(400, "No channel");
		const actions: unknown[] = [];
		for (const id of ids) {
			const c = await getChannel({ id });
			if (!c) throw new ApiError(404, "Channel not found");
			if (c.id === viewer!.channelId) throw new ApiError(400, "You can't subscribe to your own channel.");
			const added = await sql`insert into subscriptions (user_id, channel_id) values (${viewer!.userId}, ${id}) on conflict do nothing returning 1`;
			if (added.length) await recordSubscription(id, true);
			actions.push({ updateSubscribeButtonAction: { subscribed: true, channelId: id } });
			actions.push({
				addToGuideSectionAction: {
					handlerData: "GUIDE_ACTION_ADD_TO_SUBSCRIPTIONS",
					items: [{ guideEntryRenderer: { navigationEndpoint: channelEndpoint(c), thumbnail: avatarThumbnails(c.id, [88]), formattedTitle: text(c.title), accessibility: label(c.title), entryData: { guideEntryData: { guideEntryId: c.id } }, presentationStyle: "GUIDE_ENTRY_PRESENTATION_STYLE_NONE" } }],
				},
			});
			actions.push(toast("Subscription added"));
		}
		return { responseContext: responseContext(viewer), actions, frameworkUpdates: { entityBatchUpdate: { mutations: ids.map((id) => subscriptionMutation(id, true)), timestamp: now() } } };
	},
	{ mutation: true },
);

route(
	"subscription/unsubscribe",
	async ({ body, viewer }) => {
		const ids: string[] = (Array.isArray(body.channelIds) ? body.channelIds : []).filter(isChannelId).slice(0, 10);
		if (!ids.length) throw new ApiError(400, "No channel");
		const actions: unknown[] = [];
		for (const id of ids) {
			const removed = await sql`delete from subscriptions where user_id = ${viewer!.userId} and channel_id = ${id} returning 1`;
			if (removed.length) await recordSubscription(id, false);
			actions.push({ updateSubscribeButtonAction: { subscribed: false, channelId: id } });
			actions.push({ removeFromGuideSectionAction: { handlerData: "GUIDE_ACTION_REMOVE_FROM_SUBSCRIPTIONS", guideEntryId: id } });
			actions.push(toast("Subscription removed"));
		}
		return { responseContext: responseContext(viewer), actions, frameworkUpdates: { entityBatchUpdate: { mutations: ids.map((id) => subscriptionMutation(id, false)), timestamp: now() } } };
	},
	{ mutation: true },
);

// notification bell preferences: accepted, nothing is sent from this instance yet
route("notification/modify_channel_preference", ({ viewer }) => ({ responseContext: responseContext(viewer), actions: [toast("Notification preferences saved")] }), { mutation: true });

// the Share dialog (template share/panel). The entity names a video (field
// 1), a playlist (2), a channel (3) or a post (6), as the client's share buttons encode it
async function shareTarget(entity: string, viewer: Viewer) {
	let f: Map<number, (number | Uint8Array)[]> = new Map();
	try {
		f = decode(fromBase64(decodeURIComponent(entity)));
	} catch {}
	const [videoId, playlistId, channelId, postId] = [1, 2, 3, 6].map((n) => str(f.get(n)?.[0]) ?? "");
	// a post (field 6, as its Share button encodes it)
	if (postId) {
		const { getPost } = await import("./posts");
		const p = await getPost(postId, viewer);
		if (p) return { url: `${PUBLIC_ORIGIN}/post/${p.id}`, title: p.text.slice(0, 100), summary: p.text.slice(0, 200), thumb: "" };
	}
	if (isVideoId(videoId)) {
		const v = await getVideo(videoId, viewer);
		if (v) return { url: isShort(v) && v.visibility === "public" ? `${PUBLIC_ORIGIN}/shorts/${v.id}` : `${PUBLIC_ORIGIN}/watch?v=${v.id}`, title: v.title, summary: v.description.slice(0, 200), thumb: `${PUBLIC_ORIGIN}/vi/${v.id}/maxresdefault.jpg` };
	}
	if (playlistId) {
		const p = await getPlaylist(playlistId, viewer);
		if (p) return { url: `${PUBLIC_ORIGIN}/playlist?list=${playlistId}`, title: p.title, summary: p.description ?? "", thumb: "" };
	}
	if (isChannelId(channelId)) {
		const c = await getChannel({ id: channelId });
		if (c) return { url: `${PUBLIC_ORIGIN}/@${c.handle}`, title: c.title, summary: c.description.slice(0, 200), thumb: "" };
	}
	return undefined;
}

route("share/get_share_panel", async ({ body, viewer }) => {
	const t = await shareTarget(String(body.serializedSharedEntity ?? body.serializedShareEntity ?? ""), viewer);
	if (!t) throw new ApiError(404, "Not found", "notFound");
	const enc = encodeURIComponent;
	return {
		responseContext: responseContext(viewer),
		...make<Record<string, unknown>>("share/panel", { SHARE_URL: t.url, SHARE_URL_ENC: enc(t.url), SHARE_TITLE_ENC: enc(t.title), SUMMARY_ENC: enc(t.summary), THUMB_ENC: enc(t.thumb) }),
	};
});

route(
	"history/clear_watch_history",
	async ({ viewer }) => {
		await sql`delete from watch_history where user_id = ${viewer!.userId}`;
		return { responseContext: responseContext(viewer), actions: [toast("Watch history cleared")] };
	},
	{ mutation: true },
);
