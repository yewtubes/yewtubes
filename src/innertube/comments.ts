// Comments on the watch page. The section loads through a /next
// continuation: a header (count, sort menu, composer) and threads, where
// each comment is a commentViewModel holding entity keys and the content
// arrives as frameworkUpdates entity payloads (commentEntityPayload,
// commentSurfaceEntityPayload, engagementToolbar*EntityPayload), all built
// from YouTube's own responses (templates comments/*, item/comment_*,
// signed in and signed out). Composer and reply dialog submit to comment/create_comment
// and comment/create_comment_reply; likes go through
// comment/perform_comment_action with tokens this instance signs.

import type { Viewer } from "../client/page";
import { getVideo } from "../data";
import { sql } from "../db";
import { decodeToken, encodeToken, newCommentId } from "../ids";
import { continuationItem } from "./items";
import { viewerVars } from "./chrome";
import { ago, avatarThumbnails, avatarUrl, compact, grouped, responseContext, runs, serviceEndpoint } from "./r";
import { ApiError, route } from "./router";
import { type Gif, gifFromToken, GIFS_ENABLED, imageAttachment } from "../gifs";
import { rateLimit } from "../ratelimit";
import { make, type Vars } from "./tpl";
import { baseVars } from "./vars";

const PAGE = 20;
const REPLY_PAGE = 10;

type Row = { id: string; video_id: string; parent_id: string | null; text: string; gif: Gif | null; like_count: number; reply_count: number; created_at: Date; hearted_at: Date | null; author_channel_id: string; author_handle: string; author_title: string; video_channel_id: string; video_channel_handle: string; liked: boolean };

const key = (kind: string, id: string) => Buffer.from(`${kind}:${id}`).toString("base64url");
const SHARED_KEY = key("shared", "comments");
const now = () => ({ seconds: String(Math.floor(Date.now() / 1000)), nanos: 0 });
// templates come signed in and signed out
const io = (viewer: Viewer) => (viewer ? "in" : "out");
const entityUpdate = (mutations: unknown[]) => ({ frameworkUpdates: { entityBatchUpdate: { mutations, timestamp: now() } } });
const sharedPayload = (viewer: Viewer) => make(`comments/shared_${io(viewer)}`, { SHARED_KEY });
const viewerThumbs = (viewer: Viewer) => avatarThumbnails(viewer?.channelId ?? "UC0000000000000000000000").thumbnails;

function actionToken(action: "like" | "unlike" | "delete", commentId: string, userId: string) {
	return encodeToken({ a: action, c: commentId, u: userId });
}

const likes = (n: number) => (n === 1 ? "1 like" : `${grouped(n)} likes`);

function commentVars(c: Row, viewer: Viewer): Vars {
	const others = c.like_count - (c.liked ? 1 : 0);
	const avatar = avatarUrl(c.author_channel_id, 88);
	const vars: Vars = {
		...baseVars(viewer, `/watch?v=${c.video_id}`),
		COMMENT_ID: c.id,
		VIDEO_ID: c.video_id,
		COMMENT_KEY: key("comment", c.id),
		TOOLBAR_STATE_KEY: key("toolbarstate", c.id),
		TOOLBAR_SURFACE_KEY: key("toolbarsurface", c.id),
		SURFACE_KEY: key("surface", c.id),
		SHARED_KEY,
		AUTHOR_CHANNEL_ID: c.author_channel_id,
		AUTHOR_URL: `/@${c.author_handle}`,
		AUTHOR_AT_HANDLE: `@${c.author_handle}`,
		AUTHOR_AVATAR_URL: avatar,
		AUTHOR_AVATAR: [{ url: avatar, width: 88, height: 88 }],
		IS_CURRENT_USER: viewer?.channelId === c.author_channel_id,
		IS_CREATOR: c.author_channel_id === c.video_channel_id,
		TEXT: c.text,
		PUBLISHED: ago(c.created_at),
		LIKES: others ? compact(others) : "",
		LIKES_LIKED: compact(others + 1),
		LIKES_A11Y: likes(others),
		LIKES_LIKED_A11Y: likes(others + 1),
		LIKE_BUTTON_A11Y: `Like this comment along with ${grouped(others)} other ${others === 1 ? "person" : "people"}`,
		REPLY_COUNT: !c.parent_id && c.reply_count ? String(c.reply_count) : "",
		REPLY_COUNT_A11Y: `${c.reply_count} ${c.reply_count === 1 ? "reply" : "replies"}`,
	};
	if (viewer) {
		Object.assign(vars, {
			...viewerVars(viewer),
			VIEWER_THUMBS: viewerThumbs(viewer),
			LIKE_ACTION: actionToken("like", c.id, viewer.userId),
			UNLIKE_ACTION: actionToken("unlike", c.id, viewer.userId),
			// dislikes are not kept; both clear the viewer's like
			DISLIKE_ACTION: actionToken("unlike", c.id, viewer.userId),
			UNDISLIKE_ACTION: actionToken("unlike", c.id, viewer.userId),
			REPLY_PARAMS: encodeToken({ v: c.video_id, p: c.parent_id ?? c.id }),
			// the action menu: Delete on the viewer's own comments (Report is not offered)
			MENU_ITEMS:
				viewer.channelId === c.author_channel_id
					? [{ menuServiceItemRenderer: { text: runs("Delete"), icon: { iconType: "DELETE" }, serviceEndpoint: serviceEndpoint("/youtubei/v1/comment/perform_comment_action", { performCommentActionEndpoint: { action: actionToken("delete", c.id, viewer.userId) } }) } }]
					: [],
		});
	}
	return vars;
}

// a comment's entity payloads (templates comments/entities*), and its like state
function entities(c: Row, viewer: Viewer, vars: Vars) {
	const mutations = make<any[]>(`comments/entities${c.parent_id ? "_reply" : ""}_${io(viewer)}`, vars);
	for (const m of mutations) {
		const p = m.payload;
		if (p.engagementToolbarStateEntityPayload) {
			p.engagementToolbarStateEntityPayload.likeState = c.liked ? "TOOLBAR_LIKE_STATE_LIKED" : "TOOLBAR_LIKE_STATE_INDIFFERENT";
			if (c.hearted_at) p.engagementToolbarStateEntityPayload.heartState = "TOOLBAR_HEART_STATE_HEARTED";
		}
		// the video's channel hearted it (in Studio): its avatar on the heart
		if (p.commentEntityPayload && c.hearted_at) Object.assign(p.commentEntityPayload.toolbar, { creatorThumbnailUrl: avatarUrl(c.video_channel_id, 88), heartActiveTooltip: `❤ by @${c.video_channel_handle}` });
		if (p.engagementToolbarSurfaceEntityPayload && !(vars.MENU_ITEMS as unknown[] | undefined)?.length) delete p.engagementToolbarSurfaceEntityPayload.menuCommand;
		// a GIF (gifs.ts), shown by the client under the text
		if (p.commentSurfaceEntityPayload && c.gif) p.commentSurfaceEntityPayload.imageAttachmentViewModel = imageAttachment(c.gif);
	}
	return mutations;
}

// a top-level comment (item/comment_thread_*) with its "N replies" opener
function thread(c: Row, viewer: Viewer) {
	const vars = commentVars(c, viewer);
	const item = make(`item/comment_thread_${io(viewer)}`, {
		...vars,
		REPLIES_TEXT: c.reply_count === 1 ? "1 reply" : `${grouped(c.reply_count)} replies`,
		REPLIES_TOKEN: encodeToken({ k: "replies", v: c.video_id, c: c.id, o: 0 }),
	});
	if (!c.reply_count) delete item.commentThreadRenderer.replies;
	return { item, mutations: entities(c, viewer, vars) };
}

// a reply (item/comment_reply_*)
function replyItem(c: Row, viewer: Viewer) {
	const vars = commentVars(c, viewer);
	return { item: make(`item/comment_reply_${io(viewer)}`, vars), mutations: entities(c, viewer, vars) };
}

async function load(videoId: string, viewer: Viewer, opts: { parent?: string; sort?: string; offset: number; limit: number }): Promise<Row[]> {
	const order = opts.parent ? sql`c.created_at asc` : opts.sort === "new" ? sql`c.created_at desc` : sql`c.like_count desc, c.reply_count desc, c.created_at desc`;
	return (await sql`select c.id, c.video_id, c.parent_id, c.text, c.gif, c.like_count, c.reply_count, c.created_at, c.hearted_at, c.author_channel_id, ch.handle as author_handle, ch.title as author_title,
		v.channel_id as video_channel_id, vc.handle as video_channel_handle, exists(select 1 from comment_reactions r where r.comment_id = c.id and r.user_id = ${viewer?.userId ?? "0"} and r.kind = 'like') as liked
		from comments c join channels ch on ch.id = c.author_channel_id join videos v on v.id = c.video_id join channels vc on vc.id = v.channel_id
		where c.video_id = ${videoId} and c.deleted_at is null and c.spam_at is null and ${opts.parent ? sql`c.parent_id = ${opts.parent}` : sql`c.parent_id is null`}
		order by ${order}, c.id limit ${opts.limit} offset ${opts.offset}`) as Row[];
}

// The Shorts player's comments panel (tokens with t: "s") loads through
// browse into its own section; the watch page's through next.
const SHORTS_SECTION = "shorts-engagement-panel-comments-section";
const retarget = (o: any): any =>
	o === "comments-section" ? SHORTS_SECTION : Array.isArray(o) ? o.map(retarget) : o && typeof o === "object" ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, retarget(v)])) : o;

// count, sort menu and composer (comments/header_*)
function header(videoId: string, count: number, sort: string, viewer: Viewer, shorts = false) {
	const h = make(`comments/header_${io(viewer)}`, {
		...baseVars(viewer, `/watch?v=${videoId}`),
		...(viewer ? viewerVars(viewer) : {}),
		COUNT: grouped(count),
		COMMENTS_WORD: count === 1 ? " Comment" : " Comments",
		COUNT_SHORT: compact(count),
		SORT_TOP: encodeToken({ k: "comments", v: videoId, s: "top", ...(shorts ? { t: "s" } : {}) }),
		SORT_NEW: encodeToken({ k: "comments", v: videoId, s: "new", ...(shorts ? { t: "s" } : {}) }),
		SORT_TOP_SELECTED: sort === "top",
		SORT_NEW_SELECTED: sort === "new",
		CREATE_PARAMS: encodeToken({ v: videoId }),
		VIEWER_THUMBS: viewerThumbs(viewer),
	});
	if (!shorts) return h;
	// the Shorts panel has its own title and sort menu: only the composer
	const r = h.commentsHeaderRenderer;
	return { commentsHeaderRenderer: { createRenderer: retarget(r.createRenderer) } };
}

export async function commentsContinuation(tok: { v: string; s?: string; c?: string; o?: number; k?: string; t?: string }, viewer: Viewer) {
	const video = await getVideo(tok.v, viewer);
	if (!video) throw new ApiError(404, "Video not found");
	const offset = tok.o ?? 0;
	if (tok.k === "replies" && tok.c) {
		const rows = await load(tok.v, viewer, { parent: tok.c, offset, limit: REPLY_PAGE });
		const parts = rows.map((r) => replyItem(r, viewer));
		const items: unknown[] = parts.map((p) => p.item);
		if (rows.length === REPLY_PAGE) items.push(make("item/continuation_replies", { CONTINUATION: encodeToken({ k: "replies", v: tok.v, c: tok.c, o: offset + REPLY_PAGE }) }));
		return {
			responseContext: responseContext(viewer),
			onResponseReceivedEndpoints: [{ appendContinuationItemsAction: { continuationItems: items, targetId: `comment-replies-item-${tok.c}` } }],
			...entityUpdate(parts.flatMap((p) => p.mutations)),
		};
	}
	const sort = tok.s === "new" ? "new" : "top";
	const rows = await load(tok.v, viewer, { sort, offset, limit: PAGE });
	const threads = rows.map((r) => thread(r, viewer));
	const items: unknown[] = threads.map((t) => t.item);
	const shorts = tok.t === "s";
	const section = shorts ? SHORTS_SECTION : "comments-section";
	if (rows.length === PAGE) items.push(continuationItem(encodeToken({ k: "comments", v: tok.v, s: sort, o: offset + PAGE, ...(shorts ? { t: "s" } : {}) }), shorts ? "/youtubei/v1/browse" : "/youtubei/v1/next"));
	const update = entityUpdate([sharedPayload(viewer), ...threads.flatMap((t) => t.mutations)]);
	if (offset > 0) return { responseContext: responseContext(viewer), onResponseReceivedEndpoints: [{ appendContinuationItemsAction: { continuationItems: items, targetId: section } }], ...update };
	const [{ n }] = await sql`select count(*)::int as n from comments where video_id = ${tok.v} and deleted_at is null and spam_at is null`;
	return {
		responseContext: responseContext(viewer),
		onResponseReceivedEndpoints: [
			{ reloadContinuationItemsCommand: { targetId: section, continuationItems: [header(tok.v, n, sort, viewer, shorts)], slot: "RELOAD_CONTINUATION_SLOT_HEADER" } },
			{ reloadContinuationItemsCommand: { targetId: section, continuationItems: items, slot: "RELOAD_CONTINUATION_SLOT_BODY" } },
		],
		...update,
	};
}

// the text and GIF of a new comment; with a GIF the text may be empty (the
// picker types a zero-width space so the client lets an empty box submit)
function content(body: any): { text: string; gif: Gif | null } {
	const gif = body.yewtubeGif !== undefined && GIFS_ENABLED ? gifFromToken(body.yewtubeGif) : null;
	if (body.yewtubeGif !== undefined && !gif) throw new ApiError(400, "That GIF can't be attached. Pick it again.");
	let text = String(body.commentText ?? "").replace(/\r\n?/g, "\n");
	if (gif) text = text.replace(/\u200b/g, "");
	text = text.trim();
	if (!text && !gif) throw new ApiError(400, "Comments can't be empty.");
	if (text.length > 10000) throw new ApiError(400, "Comments are limited to 10,000 characters.");
	return { text, gif: gif ?? null };
}

async function insertComment(videoId: string, viewer: NonNullable<Viewer>, { text, gif }: { text: string; gif: Gif | null }, parent: string | null) {
	if (!(await rateLimit(`comment:${viewer.userId}`, 30, 600))) throw new ApiError(429, "You're commenting too fast. Try again in a few minutes.", "rateLimitExceeded");
	const video = await getVideo(videoId, viewer);
	if (!video?.playable) throw new ApiError(404, "Video not found");
	const id = newCommentId();
	await sql.begin(async (tx) => {
		if (parent) {
			const [p] = await tx`select id from comments where id = ${parent} and video_id = ${videoId} and parent_id is null and deleted_at is null and spam_at is null`;
			if (!p) throw new ApiError(404, "The comment you're replying to was removed.");
			await tx`update comments set reply_count = reply_count + 1 where id = ${parent}`;
		}
		await tx`insert into comments (id, video_id, author_channel_id, parent_id, text, gif) values (${id}, ${videoId}, ${viewer.channelId}, ${parent}, ${text}, ${gif ? JSON.stringify(gif) : null}::text::jsonb)`;
		await tx`update videos set comment_count = comment_count + 1 where id = ${videoId}`;
	});
	const [row] = await load(videoId, viewer, { parent: parent ?? undefined, offset: 0, limit: 1000 }).then((rs) => rs.filter((r) => r.id === id));
	return row;
}

route(
	"comment/create_comment",
	async ({ body, viewer }) => {
		const params = decodeToken<{ v: string }>(body.createCommentParams);
		if (!params) throw new ApiError(400, "Invalid comment parameters");
		const row = await insertComment(params.v, viewer!, content(body), null);
		const t = thread(row, viewer);
		return { responseContext: responseContext(viewer), actions: [{ createCommentAction: { contents: t.item } }], ...entityUpdate([sharedPayload(viewer), ...t.mutations]) };
	},
	{ mutation: true },
);

route(
	"comment/create_comment_reply",
	async ({ body, viewer }) => {
		const params = decodeToken<{ v: string; p: string }>(body.createReplyParams);
		if (!params) throw new ApiError(400, "Invalid reply parameters");
		const row = await insertComment(params.v, viewer!, content(body), params.p);
		const r = replyItem(row, viewer);
		return { responseContext: responseContext(viewer), actions: [{ createCommentReplyAction: { contents: r.item } }], ...entityUpdate([sharedPayload(viewer), ...r.mutations]) };
	},
	{ mutation: true },
);

route(
	"comment/perform_comment_action",
	async ({ body, viewer }) => {
		const tokens: unknown[] = Array.isArray(body.actions) ? body.actions : [body.action];
		const mutations: unknown[] = [];
		for (const raw of tokens.slice(0, 10)) {
			const t = decodeToken<{ a: string; c: string; u: string }>(raw);
			if (!t || t.u !== viewer!.userId) throw new ApiError(400, "Invalid comment action");
			if (t.a === "like" || t.a === "unlike") {
				await sql.begin(async (tx) => {
					const [prev] = await tx`select kind from comment_reactions where user_id = ${viewer!.userId} and comment_id = ${t.c} for update`;
					if (t.a === "like" && !prev) {
						await tx`insert into comment_reactions (user_id, comment_id, kind) values (${viewer!.userId}, ${t.c}, 'like')`;
						await tx`update comments set like_count = like_count + 1 where id = ${t.c}`;
					} else if (t.a === "unlike" && prev) {
						await tx`delete from comment_reactions where user_id = ${viewer!.userId} and comment_id = ${t.c}`;
						if (prev.kind === "like") await tx`update comments set like_count = greatest(0, like_count - 1) where id = ${t.c}`;
					}
				});
				const k = key("toolbarstate", t.c);
				const [{ hearted_at }] = await sql`select hearted_at from comments where id = ${t.c}`;
				mutations.push({ entityKey: k, type: "ENTITY_MUTATION_TYPE_REPLACE", payload: { engagementToolbarStateEntityPayload: { key: k, likeState: t.a === "like" ? "TOOLBAR_LIKE_STATE_LIKED" : "TOOLBAR_LIKE_STATE_INDIFFERENT", heartState: hearted_at ? "TOOLBAR_HEART_STATE_HEARTED" : "TOOLBAR_HEART_STATE_UNHEARTED" } } });
			} else if (t.a === "delete") await deleteOwnComment(viewer!.channelId, t.c);
		}
		return { responseContext: responseContext(viewer), actionResults: [{ status: "STATUS_SUCCEEDED" }], ...entityUpdate(mutations) };
	},
	{ mutation: true },
);

// the author deleting their comment (the comment's menu, My Activity)
export async function deleteOwnComment(channelId: string, id: string): Promise<boolean> {
	const [c] = await sql`update comments set deleted_at = now() where id = ${id} and author_channel_id = ${channelId} and deleted_at is null returning video_id, parent_id`;
	if (!c) return false;
	await sql`update videos set comment_count = greatest(0, comment_count - 1) where id = ${c.video_id}`;
	if (c.parent_id) await sql`update comments set reply_count = greatest(0, reply_count - 1) where id = ${c.parent_id}`;
	return true;
}
