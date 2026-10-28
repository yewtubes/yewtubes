// A video as Studio sees it (the creator video entity of
// creator/list_creator_videos and creator/get_creator_videos).
//
// No captured response carries one (the capture account has no videos), so
// the shape follows the creator video Studio itself builds as the default
// for a new live stream (its live-creation dialog), with the fields for an
// upload instead of a stream. Studio reads it through a field mask.

import { categoryEnum } from "../categories";
import { PUBLIC_ORIGIN, STUDIO_ORIGIN } from "../config";
import { sql, textArray } from "../db";
import { isShort } from "../data";
import { videoThumbnails } from "../innertube/r";
import { ensureStills } from "../media/process";
import { type Mask, applyMask } from "./channel";
import { feedbackToken } from "./feedback";
import { thumbnailEditorState } from "./thumbnail";

export type VideoRow = {
	id: string;
	width: number | null;
	height: number | null;
	channel_id: string;
	title: string;
	description: string;
	visibility: "public" | "unlisted" | "private";
	status: "uploaded" | "queued" | "processing" | "ready" | "failed";
	playable: boolean;
	error: string | null;
	source_path: string | null;
	thumbnail_choice: string;
	// the chosen thumbnail's file, which changes with the choice
	thumb_path: string | null;
	duration_ms: number | null;
	view_count: string | number;
	like_count: number;
	comment_count: number;
	created_at: Date;
	published_at: Date | null;
	draft: boolean;
	made_for_kids: boolean | null;
	original_filename: string;
	category_id: number;
	received?: string | null;
	size?: string | null;
};

export const VIDEO_COLUMNS = sql`v.id, v.channel_id, v.title, v.description, v.visibility, v.status, v.playable, v.error, v.source_path, v.thumbnail_choice,
	(select t.path from video_thumbnails t where t.video_id = v.id and t.name = 'hqdefault') as thumb_path, v.duration_ms, v.view_count, v.like_count, v.comment_count,
	v.created_at, v.published_at, v.draft, v.made_for_kids, v.original_filename, v.width, v.height, v.category_id,
	(select t.received from upload_transfers t where t.video_id = v.id order by t.created_at desc limit 1) as received,
	(select t.size from upload_transfers t where t.video_id = v.id order by t.created_at desc limit 1) as size`;

const PRIVACY = { public: "VIDEO_PRIVACY_PUBLIC", unlisted: "VIDEO_PRIVACY_UNLISTED", private: "VIDEO_PRIVACY_PRIVATE" } as const;
const USER_SET = { public: "VIDEO_USER_SET_VISIBILITY_PUBLIC", unlisted: "VIDEO_USER_SET_VISIBILITY_UNLISTED", private: "VIDEO_USER_SET_VISIBILITY_PRIVATE" } as const;
const formatted = (s: string) => ({ runs: s ? [{ text: s }] : [] });
const seconds = (d: Date | null) => (d ? String(Math.floor(new Date(d).getTime() / 1000)) : "");

// what the owner may do here; without WATCH Studio lists a video as
// "[Private video]", someone else's
const OWNER_PERMISSIONS = ["CREATOR_VIDEO_PERMISSION_READ", "CREATOR_VIDEO_PERMISSION_WATCH", "CREATOR_VIDEO_PERMISSION_WRITE", "CREATOR_VIDEO_PERMISSION_DELETE"];

export function creatorVideo(v: VideoRow): Record<string, unknown> {
	// processing goes on after the video can be watched (the full set of
	// formats); until then it is "uploading or processing"
	const processing = v.status !== "ready" && v.status !== "failed";
	const busy = !v.playable && v.status !== "failed";
	const version = Bun.hash(v.thumb_path ?? "").toString(36);
	const mfk = v.made_for_kids === null ? "VIDEO_MADE_FOR_KIDS_UNKNOWN" : v.made_for_kids ? "VIDEO_MADE_FOR_KIDS_MFK" : "VIDEO_MADE_FOR_KIDS_NOT_MFK";
	const lengthSeconds = String(Math.round((v.duration_ms ?? 0) / 1000));
	const watchUrl = `${PUBLIC_ORIGIN}/watch?v=${v.id}`;
	const effective = v.status === "failed" && !v.playable ? "VIDEO_EFFECTIVE_VISIBILITY_UPLOAD_FAILED" : busy ? "VIDEO_EFFECTIVE_VISIBILITY_UPLOADING_OR_PROCESSING" : "VIDEO_EFFECTIVE_VISIBILITY_USER_CONFIG";
	const effectiveStatus = v.status === "failed" && !v.playable ? "VIDEO_VISIBILITY_STATUS_UPLOAD_FAILED" : busy ? "VIDEO_VISIBILITY_STATUS_UPLOADING_OR_PROCESSING" : v.draft ? "VIDEO_VISIBILITY_STATUS_DRAFT" : "VIDEO_VISIBILITY_STATUS_USER_CONFIG";
	return {
		videoId: v.id,
		channelId: v.channel_id,
		title: v.title,
		titleFormattedString: formatted(v.title),
		titleDetails: { title: v.title },
		description: v.description,
		descriptionFormattedString: formatted(v.description),
		descriptionDetails: { description: v.description },
		ageRestriction: "VIDEO_AGE_RESTRICTION_NONE",
		allowEmbed: true,
		allowRatings: true,
		audienceRestriction: {
			selfRating: "VIDEO_TARGETED_AUDIENCE_UNKNOWN",
			systemRating: "VIDEO_TARGETED_AUDIENCE_UNKNOWN",
			overrideEnabled: true,
			effectiveRating: "VIDEO_TARGETED_AUDIENCE_ALL",
			imposer: "VIDEO_TARGETED_AUDIENCE_IMPOSER_UNSPECIFIED",
		},
		category: categoryEnum(v.category_id),
		claimDetails: { isEmbedDisabled: false },
		commentFilter: "VIDEO_COMMENT_FILTER_NONE",
		commentsDisabledInternally: false,
		commentSettings: { commentsEnabledState: "VIDEO_COMMENTS_ENABLED_STATE_ON", allowedCommenterMode: "ALLOWED_COMMENTER_MODE_ANYONE", commenterMinimumSubscriptionTime: "COMMENTER_MINIMUM_SUBSCRIPTION_TIME_ONE_DAY" },
		contentType: contentType(v),
		crowdsourcingEnabled: false,
		defaultCommentSortOrder: "VIDEO_COMMENT_SORT_ORDER_TOP",
		// the value Studio gives the drafts it creates itself
		draftStatus: v.draft ? "DRAFT_STATUS_PUBLIC" : "DRAFT_STATUS_NONE",
		files: [],
		features: {},
		inlineEditProcessingStatus: "VIDEO_PROCESSING_STATUS_UNKNOWN",
		isPaygated: false,
		lengthSeconds,
		videoDurationMs: String(v.duration_ms ?? 0),
		license: "VIDEO_LICENSE_STANDARD",
		meetsCommentSettingsWritePreconditions: true,
		meetsRatingSettingsWritePreconditions: true,
		meetsEditPreconditions: true,
		mfkSettings: {
			mfkByCreator: mfk,
			mfkWithoutCreatorInput: "VIDEO_MADE_FOR_KIDS_UNKNOWN",
			overrideEnabled: true,
			effectiveMfk: mfk,
			imposer: v.made_for_kids === null ? "VIDEO_MADE_FOR_KIDS_IMPOSER_UNSPECIFIED" : "VIDEO_MADE_FOR_KIDS_IMPOSER_SELF",
		},
		monetization: { adMonetization: { effectiveStatus: "VIDEO_MONETIZING_STATUS_NOT_MONETIZING_CHANNEL_NOT_MONETIZING", userSetMonetization: "VIDEO_USER_SET_MONETIZATION_OFF" } },
		monetizedStatus: "MONETIZED_STATUS_UNSPECIFIED",
		origin: "VIDEO_ORIGIN_UPLOAD",
		originalFilename: v.original_filename,
		ownedClaimDetails: { canEditOwnedClaim: false },
		paidProductPlacement: "VIDEO_PAID_PRODUCT_PLACEMENT_NO",
		permissions: { overallPermissions: OWNER_PERMISSIONS },
		privacy: PRIVACY[v.visibility],
		publishing: { notifySubscribers: "VIDEO_SUBSCRIBER_NOTIFICATION_NONE" },
		responseStatus: { statusCode: "CREATOR_ENTITY_STATUS_OK" },
		selfCertification: { status: "VIDEO_SELF_CERTIFICATION_STATUS_NOT_CERTIFIED", isEligibleForSelfCertification: false },
		shareUrl: `${PUBLIC_ORIGIN}/watch?v=${v.id}`,
		watchUrl,
		sponsorsOnly: { isSponsorsOnly: false },
		superfansOnly: { isSuperfansOnly: false },
		status: v.status === "ready" ? "VIDEO_STATUS_PROCESSED" : v.status === "failed" ? "VIDEO_STATUS_FAILED" : "VIDEO_STATUS_UPLOADED",
		statusDetails: processing ? { feedbackServiceContinuationToken: feedbackToken(v.id) } : {},
		tags: [],
		thumbnailDetails: v.playable ? videoThumbnails(v.id, version) : { thumbnails: [] },
		thumbnailEditorState: v.playable ? thumbnailEditorState(v.id, v.thumbnail_choice, version) : { stillId: 1, stills: [] },
		thumbnailUrl: v.playable ? `${PUBLIC_ORIGIN}/vi/${v.id}/hqdefault.jpg?v=${version}` : "",
		timeCreatedSeconds: seconds(v.created_at),
		timePublishedSeconds: v.draft ? "" : seconds(v.published_at),
		uncaptionedReason: "VIDEO_UNCAPTIONED_REASON_UNNECESSARY_OR_NOT_SET",
		unlistedExpired: false,
		videoAdvertiserSpecificAgeGates: {},
		videoStreamUrl: v.playable ? watchUrl : "",
		viewCountIsHidden: false,
		publicMetrics: { viewCount: String(v.view_count), commentCount: String(v.comment_count), likeCount: String(v.like_count), dislikeCount: "0" },
		publicShorts: { isShortsRenderable: isShort(v) },
		shorts: { isShortsRenderable: isShort(v) },
		visibility: {
			effectiveStatus,
			effectiveVisibility: effective,
			userSetVisibility: v.draft ? "VIDEO_USER_SET_VISIBILITY_DRAFT" : USER_SET[v.visibility],
		},
		allRestrictions: { restrictions: [] },
		downloadUrl: "",
		studioUrl: `${STUDIO_ORIGIN}/video/${v.id}/edit`,
	};
}

export async function videosFor(channelId: string, ids?: string[]) {
	const rows = (await sql`select ${VIDEO_COLUMNS} from videos v
		where v.channel_id = ${channelId} and v.deleted_at is null ${ids ? sql`and v.id = any(${textArray(ids)}::text[])` : sql``}
		order by coalesce(v.published_at, v.created_at) desc`) as unknown as VideoRow[];
	// one video's details: its thumbnail picker needs the stills, which
	// videos processed before they were made get now
	if (ids && ids.length <= 3) await Promise.all(rows.filter((r) => r.playable).map((r) => ensureStills(r.id, r.source_path)));
	return rows;
}

// Studio's Content tabs: Shorts are vertical or square and up to three
// minutes (data.ts isShort); everything else is a video on demand
export const contentType = (v: VideoRow) => (isShort(v) ? "CREATOR_CONTENT_TYPE_SHORTS" : "CREATOR_CONTENT_TYPE_VIDEO_ON_DEMAND");

export const maskedVideo = (v: VideoRow, mask: Mask) => applyMask(creatorVideo(v), mask);
