// Studio's InnerTube methods (creator/*, upload/*, video_manager/*), on the
// shared router. Every creator method acts for the signed-in channel only:
// requests naming another channel or another channel's videos get nothing.

import { CATEGORIES } from "../categories";
import { PUBLIC_ORIGIN } from "../config";
import type { Viewer } from "../client/page";
import { sql, textArray } from "../db";
import { deleteMedia } from "../media/process";
import { isVideoId, newVideoId } from "../ids";
import { responseContext } from "../innertube/r";
import { ApiError, type Ctx, route } from "../innertube/router";
import { creatorChannel } from "./channel";
import { setCustomThumbnail, setStill } from "./thumbnail";
import { attachSource } from "./upload";
import { type VideoRow, contentType, maskedVideo, videosFor } from "./video";

function owner(ctx: Ctx): NonNullable<Viewer> {
	if (!ctx.viewer) throw new ApiError(401, "Sign in to use Studio.", "authError");
	return ctx.viewer;
}

const ok = (viewer: Viewer, data: Record<string, unknown>) => ({ responseContext: responseContext(viewer), ...data });

route("creator/get_creator_channels", async (ctx) => {
	const viewer = owner(ctx);
	const ids: string[] = Array.isArray(ctx.body.channelIds) ? ctx.body.channelIds : [];
	const channels = [];
	for (const id of ids.slice(0, 10)) {
		const ch = id === viewer.channelId ? await creatorChannel(viewer, ctx.body.mask ?? null) : null;
		channels.push(ch ?? { channelId: id, responseStatus: { statusCode: "CREATOR_ENTITY_STATUS_PERMISSION_DENIED" } });
	}
	return ok(viewer, { channels });
});

// announcements, survey and promotion slots: none
route("creator/get_creator_communications", (ctx) => ok(ctx.viewer, {}));
route("notification/get_unseen_count", (ctx) => ok(ctx.viewer, { unseenCount: 0 }));
// Google's survey prompts (HaTS) and attestation signals: nothing to answer,
// as YouTube answers when it has no survey to show
route("creator/get_creator_google_hats_trigger_ids", (ctx) => ok(ctx.viewer, {}));
route("get_survey", (ctx) => ok(ctx.viewer, {}));
route("att/esr", (ctx) => ok(ctx.viewer, {}));
// the account's settings for promotions (ads), which this instance doesn't run
route("promotions/get_account", (ctx) => ok(ctx.viewer, { accountData: { currencyCode: "USD", timezone: "UTC", countryCode: "US" }, adstubeConfigs: {} }));
// bulk actions besides delete don't exist yet, so none is ever running
route("creator/check_creator_bulk_action", (ctx) => ok(ctx.viewer, { status: "BULK_ACTION_STATUS_DONE" }));

route("creator/list_creator_playlists", async (ctx) => {
	const viewer = owner(ctx);
	if (ctx.body.channelId && ctx.body.channelId !== viewer.channelId) return ok(viewer, { playlists: [] });
	const rows = await sql`select p.id, p.title, p.visibility,
		(select count(*)::int from playlist_items i join videos v on v.id = i.video_id where i.playlist_id = p.id and v.deleted_at is null) as count,
		(select i.video_id from playlist_items i join videos v on v.id = i.video_id where i.playlist_id = p.id and v.deleted_at is null order by i.position limit 1) as first
		from playlists p where p.user_id = ${viewer.userId} and p.kind = 'user' order by p.updated_at desc limit 500`;
	// the fields the request's mask names, as Studio's pickers and playlist
	// rows read them (playlistThumbnail is the first video's still)
	const mask = ctx.body.mask ?? { playlistId: true, title: true };
	return ok(viewer, {
		playlists: rows.map((p: any) => ({
			playlistId: p.id,
			title: p.title,
			...(mask.playlistThumbnail ? { playlistThumbnail: { thumbnails: p.first ? [{ url: `${PUBLIC_ORIGIN}/vi/${p.first}/mqdefault.jpg`, width: 320, height: 180 }] : [] } } : {}),
			...(mask.videosCount ? { videosCount: String(p.count) } : {}),
			...(mask.visibilitySetting ? { visibilitySetting: `CREATOR_PLAYLIST_VISIBILITY_${String(p.visibility).toUpperCase()}` } : {}),
			responseStatus: { statusCode: "CREATOR_ENTITY_STATUS_OK" },
		})),
	});
});

// The content page's filter is a tree of and/not/channelIdIs/contentTypeIs
// conditions. This instance has uploads only (no Shorts, streams, films):
// a filter that asks for Shorts or a stream matches nothing.
// The Content list's filter, evaluated per video. Conditions this instance
// can't evaluate (undefined) neither keep nor drop a video, negated or not.
function matchesFilter(filter: any, v: VideoRow, channelId: string): boolean {
	const walk = (f: any): boolean | undefined => {
		if (!f || typeof f !== "object") return undefined;
		if (f.not) {
			const r = walk(f.not.operand);
			return r === undefined ? undefined : !r;
		}
		if (f.and) return (f.and.operands ?? []).map(walk).every((r: boolean | undefined) => r !== false);
		if (f.or) {
			const rs = (f.or.operands ?? []).map(walk);
			return rs.every((r: boolean | undefined) => r === undefined) ? undefined : rs.some((r: boolean | undefined) => r === true);
		}
		if (f.contentTypeIs) return f.contentTypeIs.value === contentType(v);
		if (f.videoOriginIs) return f.videoOriginIs.value === "VIDEO_ORIGIN_UPLOAD";
		if (f.channelIdIs) return f.channelIdIs.value === channelId;
		if (f.tvfilmTypeIs) return false;
		return undefined;
	};
	return walk(filter) !== false;
}

route("creator/list_creator_videos", async (ctx) => {
	const viewer = owner(ctx);
	const rows = (await videosFor(viewer.channelId)).filter((v) => matchesFilter(ctx.body.filter, v, viewer.channelId));
	const size = Math.min(Math.max(Number(ctx.body.pageSize) || 30, 1), 100);
	const start = Math.max(0, Number(Buffer.from(String(ctx.body.pageToken ?? ""), "base64url").toString()) || 0);
	const page = rows.slice(start, start + size);
	return ok(viewer, {
		videos: page.map((v) => maskedVideo(v, ctx.body.mask ?? null)),
		videosTotalSize: { size: String(rows.length), accuracy: "ACCURACY_EXACT", achievedTotalSizeAccuracy: "CREATOR_ACHIEVED_TOTAL_SIZE_ACCURACY_EXACT" },
		...(start + size < rows.length ? { nextPageToken: Buffer.from(String(start + size)).toString("base64url") } : {}),
	});
});

route("creator/get_creator_videos", async (ctx) => {
	const viewer = owner(ctx);
	const ids: string[] = (Array.isArray(ctx.body.videoIds) ? ctx.body.videoIds : []).filter(isVideoId).slice(0, 50);
	const rows = ids.length ? await videosFor(viewer.channelId, ids) : [];
	const byId = new Map(rows.map((r) => [r.id, r]));
	return ok(viewer, {
		videos: ids.map((id) => {
			const v = byId.get(id);
			return v ? maskedVideo(v, ctx.body.mask ?? null) : { videoId: id, responseStatus: { statusCode: "CREATOR_ENTITY_STATUS_NOT_FOUND" } };
		}),
	});
});

const PRIVACY: Record<string, "public" | "unlisted" | "private"> = { PUBLIC: "public", UNLISTED: "unlisted", PRIVATE: "private", VIDEO_PRIVACY_PUBLIC: "public", VIDEO_PRIVACY_UNLISTED: "unlisted", VIDEO_PRIVACY_PRIVATE: "private" };

// The uploader registers the video as soon as its transfer has started;
// the file reaches processing when the transfer completes (upload.ts).
route(
	"upload/createvideo",
	async (ctx) => {
		const viewer = owner(ctx);
		const b = ctx.body;
		if (b.channelId && b.channelId !== viewer.channelId) throw new ApiError(403, "You can only upload to your own channel.", "forbidden");
		const resource = b.resourceId?.scottyResourceId?.id;
		const [t] = await sql`select id, file_name, video_id from upload_transfers where resource_id = ${String(resource ?? "")} and user_id = ${viewer.userId}`;
		if (!t) throw new ApiError(400, "No such upload.");
		if (t.video_id) {
			await attachSource(t.id);
			return ok(viewer, { videoId: t.video_id });
		}
		const meta = b.initialMetadata ?? {};
		const fileTitle = String(t.file_name || "").replace(/\.[^.]+$/, "");
		const title = String(meta.title?.newTitle ?? "").trim().slice(0, 100) || fileTitle.slice(0, 100) || "Untitled";
		const visibility = PRIVACY[meta.privacy?.newPrivacy] ?? "private";
		const draft = meta.draftState?.isDraft !== false;
		const id = newVideoId();
		await sql`insert into videos (id, channel_id, title, visibility, status, draft, original_filename)
			values (${id}, ${viewer.channelId}, ${title}, ${draft ? "private" : visibility}, 'uploaded', ${draft}, ${String(t.file_name).slice(0, 255)})`;
		await sql`update upload_transfers set video_id = ${id} where id = ${t.id}`;
		// the last chunk may have arrived since t was read
		await attachSource(t.id);
		return ok(viewer, { videoId: id });
	},
	{ mutation: true },
);

// Saves from the details editor and the upload dialog. Each changed field
// comes as its own entry (title: {newTitle}, privacy: {newPrivacy}, ...);
// the answer carries the video read back through videoReadMask.
route(
	"video_manager/metadata_update",
	async (ctx) => {
		const viewer = owner(ctx);
		const b = ctx.body;
		const id = String(b.encryptedVideoId ?? "");
		const [v] = isVideoId(id) ? await videosFor(viewer.channelId, [id]) : [];
		if (!v) throw new ApiError(404, "Video not found.", "notFound");
		const set: Record<string, unknown> = {};
		if (typeof b.title?.newTitle === "string") {
			const t = b.title.newTitle.trim().slice(0, 100);
			if (!t) return ok(viewer, { overallResult: { resultCode: "SOME_ERRORS" }, title: { success: false, errorCode: "TITLE_REQUIRED" } });
			set.title = t;
		}
		if (typeof b.description?.newDescription === "string") set.description = b.description.newDescription.slice(0, 5000);
		const publish = b.draftState?.operation === "MDE_DRAFT_STATE_UPDATE_OPERATION_REMOVE_DRAFT_STATE";
		if (publish) set.draft = false;
		// a draft stays private until it is published; the dialog publishes
		// with the chosen visibility in the same request
		const privacy = PRIVACY[b.privacy?.newPrivacy ?? b.privacyState?.newPrivacy];
		if (privacy && (!v.draft || publish)) set.visibility = privacy;
		const category = Number(b.category?.newCategoryId);
		if (CATEGORIES[category]) set.category_id = category;
		const audience = b.madeForKids?.newMfk ?? b.targetedAudience?.newTargetedAudience;
		if (audience) set.made_for_kids = /MFK$|CROSSWALK/.test(audience) && !/NOT_MFK/.test(audience);
		// the thumbnail picker: a still or a custom image uploaded first
		const still = b.videoStill;
		if (still?.operation === "SET_AUTOGEN_STILL" || still?.operation === "UPLOAD_CUSTOM_THUMBNAIL") {
			const done =
				still.operation === "SET_AUTOGEN_STILL"
					? await setStill(id, still.newStillId ?? 2)
					: await setCustomThumbnail(id, still.image?.encryptedScottyResourceId, viewer);
			if (!done) return ok(viewer, { overallResult: { resultCode: "SOME_ERRORS" }, videoStill: { success: false } });
		}
		if (Object.keys(set).length) {
			// the publish date is when the video first leaves private
				const vis = set.visibility ?? v.visibility;
				const draft = set.draft ?? v.draft;
				if (vis !== "private" && !draft && !v.published_at) set.published_at = new Date();
			await sql`update videos set ${sql(set)} where id = ${id}`;
		}
		const [after] = await videosFor(viewer.channelId, [id]);
		return ok(viewer, {
			overallResult: { resultCode: "UPDATE_SUCCESS" },
			creatorEntities: { wrappedVideoData: { video: maskedVideo(after, b.videoReadMask ?? null) } },
		});
	},
	{ mutation: true },
);

// Deleting a selection from the content page: Studio enqueues the job, then polls its status until it is done. Here the
// job runs at once; the status reports the viewer's last one.
async function deleteVideos(channelId: string, ids: string[]) {
	if (!ids.length) return 0;
	const gone = await sql`update videos set deleted_at = now() where channel_id = ${channelId} and id = any(${textArray(ids)}::text[]) and deleted_at is null returning id`;
	for (const { id } of gone) deleteMedia(id);
	return gone.length;
}

// a row's "Delete forever"
route(
	"video/delete",
	async (ctx) => {
		const viewer = owner(ctx);
		const id = String(ctx.body.videoId ?? "");
		return ok(viewer, { success: isVideoId(id) && (await deleteVideos(viewer.channelId, [id])) > 0 });
	},
	{ mutation: true },
);

const lastBulkDelete = new Map<string, { successCount: number; failedCount: number }>();

route(
	"creator/enqueue_creator_bulk_delete",
	async (ctx) => {
		const viewer = owner(ctx);
		const ids: string[] = (Array.isArray(ctx.body.videos?.videoIds) ? ctx.body.videos.videoIds : []).filter(isVideoId).slice(0, 500);
		const deleted = await deleteVideos(viewer.channelId, ids);
		lastBulkDelete.set(viewer.userId, { successCount: deleted, failedCount: ids.length - deleted });
		return ok(viewer, {});
	},
	{ mutation: true },
);

route("creator/check_creator_bulk_delete", (ctx) => {
	const viewer = owner(ctx);
	return ok(viewer, { status: "BULK_ACTION_STATUS_DONE", ...lastBulkDelete.get(viewer.userId) });
});
