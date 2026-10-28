// A channel's posts, built from YouTube's own responses (templates
// item/post_*, channel/posts_sections, post/page): the Posts tab of post
// threads, a post's page (/post/<id>, browse FEpost_detail) with its comments
// section, the Home tab's Posts shelf, likes and dislikes and poll votes
// (comment/perform_comment_action, as YouTube's post buttons send them) and
// the author deleting a post from its menu.

import type { Viewer } from "../client/page";
import { getChannel, getVideo } from "../data";
import { sql } from "../db";
import { encodeToken, isPostId } from "../ids";
import { PUBLIC_ORIGIN } from "../config";
import { type Channel, type Video, ago, avatarThumbnails, compact, grouped, responseContext, runs, serviceEndpoint } from "./r";
import { ApiError } from "./router";
import { make, type Vars } from "./tpl";
import { baseVars, channelVars } from "./vars";
import { descriptionRuns, tabParams } from "./channel";
import { videoRendererVars } from "./search";
import { encode } from "./proto";

export const POSTS_PAGE = 10;

export type Attachment =
	| { video: string }
	| { images: { file: string; width: number; height: number }[] }
	| { poll: { choices: string[] } }
	| { imagePoll: { choices: { text: string; file: string; width: number; height: number }[] } }
	| { quiz: { choices: { text: string; correct: boolean; explanation?: string }[] } };

export type Post = {
	id: string;
	channel_id: string;
	text: string;
	attachment: Attachment | null;
	like_count: number;
	comment_count: number;
	created_at: Date;
	edited_at: Date | null;
	// the viewer's reaction
	reaction: "like" | "dislike" | null;
};

const io = (viewer: Viewer) => (viewer ? "in" : "out");

async function loadPosts(where: { channel?: string; id?: string }, viewer: Viewer, offset = 0, limit = POSTS_PAGE): Promise<Post[]> {
	return (await sql`select p.id, p.channel_id, p.text, p.attachment, p.like_count, p.comment_count, p.created_at, p.edited_at,
		(select kind from post_reactions r where r.post_id = p.id and r.user_id = ${viewer?.userId ?? "0"}) as reaction
		from posts p where p.deleted_at is null and ${where.id ? sql`p.id = ${where.id}` : sql`p.channel_id = ${where.channel ?? ""}`}
		order by p.created_at desc, p.id limit ${limit} offset ${offset}`) as Post[];
}

export async function getPost(id: string, viewer: Viewer): Promise<Post | undefined> {
	if (!isPostId(id)) return undefined;
	return (await loadPosts({ id }, viewer))[0];
}

export const hasPosts = async (channelId: string) => (await sql`select 1 from posts where channel_id = ${channelId} and deleted_at is null limit 1`).length > 0;

// a post's images, served by this instance (media/post-images.ts)
export const postImageUrl = (postId: string, file: string, size = 640) => `${PUBLIC_ORIGIN}/ggpht/post/${postId}/${file}=s${size}`;

// how the post shows its like count, before and after the viewer's vote
function voteCount(n: number) {
	return { accessibility: { accessibilityData: { label: n === 1 ? "1 like" : `${compact(n)} likes` } }, simpleText: n ? compact(n) : "" };
}

type PostActionKind = "plike" | "pdislike" | "pclear" | "pdelete" | "pvote" | "punvote";
function actionToken(a: PostActionKind, postId: string, userId: string, choice?: number) {
	return encodeToken({ a, po: postId, u: userId, ...(choice === undefined ? {} : { ch: choice }) });
}
const actionEndpoint = (action: string, clientActions?: unknown[]) => serviceEndpoint("/youtubei/v1/comment/perform_comment_action", { performCommentActionEndpoint: { action, ...(clientActions ? { clientActions } : {}) } });
const votesText = (n: number) => ({ simpleText: n === 1 ? "1 vote" : `${compact(n)} votes` });
// the poll's total once the vote is sent (the poll reads it from the endpoint)
const pollTotal = (n: number) => [{ updateBackstagePollAction: { totalVotes: votesText(n) } }];

// a poll (item/post_poll): signed out each choice asks to sign in; signed
// in each has the select/deselect endpoints and the vote shares the client
// shows once a choice is picked; the author (no endpoints) sees the results
async function poll(p: Post, c: Channel, viewer: Viewer, vars: Vars, choices: { text: string; image?: unknown }[], type: string) {
	const rows = (await sql`select choice, count(*)::int as n from post_votes where post_id = ${p.id} group by choice`) as { choice: number; n: number }[];
	const counts = choices.map((_, i) => rows.find((r) => r.choice === i)?.n ?? 0);
	const total = counts.reduce((a, b) => a + b, 0);
	const [mine] = viewer ? await sql`select choice from post_votes where post_id = ${p.id} and user_id = ${viewer.userId}` : [];
	const voted: number = mine ? mine.choice : -1;
	const share = (n: number, of: number) => ({ ratio: of ? n / of : 0, percent: { simpleText: `${of ? Math.round((n / of) * 100) : 0}%` } });
	// the shares if the viewer's vote went to choice `pick`
	const ifVote = (i: number, pick: number) => share(counts[i] - (voted === i ? 1 : 0) + (pick === i ? 1 : 0), total - (voted >= 0 ? 1 : 0) + 1);
	const next = { commandMetadata: { webCommandMetadata: { url: `/@${c.handle}/posts`, webPageType: "WEB_PAGE_TYPE_CHANNEL", rootVe: 3611, apiUrl: "/youtubei/v1/browse" } }, browseEndpoint: { browseId: c.id, params: tabParams("posts"), canonicalBaseUrl: `/@${c.handle}` } };
	const owner = viewer?.channelId === c.id;
	const items = choices.map((ch, i) => {
		const base = { text: runs(ch.text), ...(ch.image ? { image: ch.image } : {}) };
		if (!viewer) return { ...make("item/post_poll_choice_out", { ...vars, TEXT: ch.text, NEXT_ENDPOINT: next }), ...(ch.image ? { image: ch.image } : {}) };
		const now = share(counts[i], total);
		const shown = voted >= 0 || owner ? { voteRatio: now.ratio, votePercentage: now.percent } : {};
		if (owner) return { ...base, ...shown };
		const sel = ifVote(i, i);
		const other = ifVote(i, -2);
		return {
			...base,
			selected: voted === i,
			...shown,
			selectServiceEndpoint: actionEndpoint(actionToken("pvote", p.id, viewer.userId, i), pollTotal(total + (voted >= 0 ? 0 : 1))),
			deselectServiceEndpoint: actionEndpoint(actionToken("punvote", p.id, viewer.userId, i), pollTotal(Math.max(0, total - 1))),
			voteRatioIfSelected: sel.ratio,
			votePercentageIfSelected: sel.percent,
			voteRatioIfNotSelected: other.ratio,
			votePercentageIfNotSelected: other.percent,
		};
	});
	return make("item/post_poll", { CHOICES: items, TOTAL_VOTES: votesText(total).simpleText, POLL_TYPE: type });
}

async function attachment(p: Post, c: Channel, viewer: Viewer, vars: Vars): Promise<unknown> {
	const a = p.attachment;
	if (!a) return undefined;
	if ("video" in a) {
		const v = await getVideo(a.video, viewer);
		if (!v || !v.playable || v.visibility === "private") return undefined;
		return make("item/post_video", videoRendererVars(v as Video, viewer));
	}
	if ("images" in a) {
		const image = (f: { file: string }) => ({ ...vars, IMAGE_THUMBS: [{ url: postImageUrl(p.id, f.file), width: 640, height: 640 }] });
		if (a.images.length === 1) return make("item/post_image", image(a.images[0]));
		return make("item/post_multi_image", { IMAGES: a.images.map((f) => make("item/post_multi_image_item", image(f))) });
	}
	if ("poll" in a) return poll(p, c, viewer, vars, a.poll.choices.map((text) => ({ text })), "POLL_TYPE_TEXT");
	if ("imagePoll" in a) return poll(p, c, viewer, vars, a.imagePoll.choices.map((ch) => ({ text: ch.text, image: { thumbnails: [{ url: postImageUrl(p.id, ch.file), width: 640, height: 640 }] } })), "POLL_TYPE_IMAGE");
	return undefined;
}

// a post's values, as item/post_thread_* and item/post_home_* take them
async function postVars(p: Post, c: Channel, viewer: Viewer): Promise<Vars> {
	const others = p.like_count - (p.reaction === "like" ? 1 : 0);
	const vars: Vars = {
		...baseVars(viewer, `/post/${p.id}`),
		...channelVars(c),
		POST_ID: p.id,
		CONTENT: runs(...descriptionRuns(p.text)),
		AUTHOR_THUMBS: avatarThumbnails(c.id, [32, 48, 76]).thumbnails,
		PUBLISHED: `${ago(p.created_at)}${p.edited_at ? " (edited)" : ""}`,
		VOTE: voteCount(p.like_count),
		VOTE_STATUS: p.reaction === "like" ? "LIKE" : p.reaction === "dislike" ? "DISLIKE" : "INDIFFERENT",
		LIKE_A11Y: `Like this post along with ${grouped(others)} other ${others === 1 ? "person" : "people"}`,
		COMMENT_COUNT: p.comment_count ? compact(p.comment_count) : "",
		COMMENT_COUNT_A11Y: p.comment_count === 1 ? "1 comment" : `${grouped(p.comment_count)} comments`,
		MENU_ITEMS: [],
	};
	if (viewer) {
		Object.assign(vars, {
			LIKED: p.reaction === "like",
			DISLIKED: p.reaction === "dislike",
			LIKE_ACTION: actionToken("plike", p.id, viewer.userId),
			UNLIKE_ACTION: actionToken("pclear", p.id, viewer.userId),
			DISLIKE_ACTION: actionToken("pdislike", p.id, viewer.userId),
			UNDISLIKE_ACTION: actionToken("pclear", p.id, viewer.userId),
			VOTE_LIKE: voteCount(others + 1),
			VOTE_UNLIKE: voteCount(others),
			VOTE_DISLIKE: voteCount(others),
			VOTE_UNDISLIKE: voteCount(others),
			// the author's own post: Delete (Report is not offered on this instance)
			MENU_ITEMS:
				viewer.channelId === c.id
					? [{ menuServiceItemRenderer: { text: runs("Delete"), icon: { iconType: "DELETE" }, serviceEndpoint: serviceEndpoint("/youtubei/v1/comment/perform_comment_action", { performCommentActionEndpoint: { action: actionToken("pdelete", p.id, viewer.userId) } }) } }]
					: [],
		});
	}
	vars.ATTACHMENT = await attachment(p, c, viewer, vars);
	return vars;
}

// what a post leaves out: no text, no menu (only the author has one here),
// no comment count yet, and no comment button on the post's own page
function trim(post: any, p: Post, vars: Vars, onPage: boolean) {
	if (!p.text) delete post.contentText;
	if (!(vars.MENU_ITEMS as unknown[]).length) delete post.actionMenu;
	const bar = post.actionButtons.commentActionButtonsRenderer;
	if (onPage) delete bar.replyButton;
	else if (!p.comment_count) delete bar.replyButton.buttonRenderer.text;
}

// a post thread (item/post_thread_*), on the Posts tab and the post's page
export async function postThread(p: Post, c: Channel, viewer: Viewer, onPage = false) {
	const vars = await postVars(p, c, viewer);
	const item = make(`item/post_thread_${io(viewer)}`, vars);
	trim(item.backstagePostThreadRenderer.post.backstagePostRenderer, p, vars, onPage);
	return item;
}

// the Home tab's Posts shelf (channel/posts_shelf of item/post_home_*)
const HOME_POSTS = 12;
export async function postsShelf(c: Channel, viewer: Viewer, vars: Vars) {
	const posts = await loadPosts({ channel: c.id }, viewer, 0, HOME_POSTS);
	if (!posts.length) return undefined;
	const items: unknown[] = [];
	for (const p of posts) {
		const pv = await postVars(p, c, viewer);
		const item = make(`item/post_home_${io(viewer)}`, pv);
		trim(item.postRenderer, p, pv, false);
		items.push(item);
	}
	return make("channel/posts_shelf", { ...vars, POSTS_PARAMS: tabParams("posts"), ITEMS: items });
}

// the Posts tab's threads, with a continuation while there are more
export async function postItems(c: Channel, viewer: Viewer, offset = 0) {
	const posts = await loadPosts({ channel: c.id }, viewer, offset);
	const items: unknown[] = [];
	for (const p of posts) items.push(await postThread(p, c, viewer));
	if (posts.length === POSTS_PAGE) items.push(make("item/continuation", { CONTINUATION: encodeToken({ k: "posts", c: c.id, o: offset + POSTS_PAGE }) }));
	return items;
}

export async function postsTab(c: Channel, viewer: Viewer) {
	return { sectionListRenderer: make("channel/posts_sections", { ITEMS: await postItems(c, viewer) }) };
}

export async function postsContinuation(channelId: string, offset: number, viewer: Viewer) {
	const c = await getChannel({ id: channelId });
	if (!c) throw new ApiError(404, "Not found");
	return { responseContext: responseContext(viewer), onResponseReceivedEndpoints: [{ appendContinuationItemsAction: { continuationItems: await postItems(c, viewer, offset), targetId: "backstage-item-section" } }] };
}

// FEpost_detail params as YouTube's post links carry them: {56: {2: channel,
// 3: post, 11: channel}}
export const postParams = (postId: string, channelId: string) => Buffer.from(encode({ 56: { 2: channelId, 3: postId, 11: channelId } })).toString("base64url");
export const postCommand = (postId: string, channelId: string) => ({
	commandMetadata: { webCommandMetadata: { url: `/post/${postId}`, webPageType: "WEB_PAGE_TYPE_BROWSE", rootVe: 247244, apiUrl: "/youtubei/v1/browse" } },
	browseEndpoint: { browseId: "FEpost_detail", params: postParams(postId, channelId), canonicalBaseUrl: `/post/${postId}` },
});

// the post id inside FEpost_detail params (the protobuf holds it as text)
export function postIdFromParams(params: string | undefined): string | undefined {
	if (!params) return undefined;
	try {
		const latin = Buffer.from(decodeURIComponent(params), "base64").toString("latin1");
		return /Ugkx[A-Za-z0-9_-]{32}/.exec(latin)?.[0];
	} catch {
		return undefined;
	}
}

// /post/<id>: the post, then its comments section (comments.ts, by browse continuation)
export async function postPage(id: string, viewer: Viewer) {
	const p = await getPost(id, viewer);
	if (!p) return undefined;
	const c = await getChannel({ id: p.channel_id });
	if (!c) return undefined;
	const short = p.text.length > 100 ? `${p.text.slice(0, 97)}...` : p.text;
	const page = make("post/page", {
		...baseVars(viewer, `/post/${p.id}`),
		...channelVars(c),
		POST_ID: p.id,
		POST: await postThread(p, c, viewer, true),
		COMMENTS_TOKEN: encodeToken({ k: "comments", po: p.id, s: "top" }),
		TEXT: p.text,
		TEXT_SHORT: short || `Post by ${c.title}`,
		PUBLISH_DATE: new Date(p.created_at).toISOString(),
		LIKE_COUNT: String(p.like_count),
	});
	return { channel: c, post: p, response: { contents: { twoColumnBrowseResultsRenderer: { tabs: page.tabs } }, metadata: page.metadata, microformat: page.microformat } };
}

// likes, dislikes, poll votes and deletes from the post's buttons and menu
// (comment/perform_comment_action tokens a: plike, pdislike, pclear, pvote,
// punvote, pdelete); a vote answers with the feedback the poll waits for, a
// delete with the action that takes the post off the page
export async function postAction(t: { a: string; po: string; ch?: number }, viewer: NonNullable<Viewer>): Promise<{ feedback?: string; actions?: unknown[] }> {
	if (t.a === "pdelete") {
		const done = await sql`update posts set deleted_at = now() where id = ${t.po} and channel_id = ${viewer.channelId} and deleted_at is null returning id`;
		if (!done.length) throw new ApiError(404, "This post isn't available anymore.");
		return { actions: [{ removeCommentAction: { commentId: t.po } }] };
	}
	if (t.a === "pvote" || t.a === "punvote") {
		const [post] = await sql`select attachment, channel_id from posts where id = ${t.po} and deleted_at is null`;
		const choices = post?.attachment?.poll?.choices ?? post?.attachment?.imagePoll?.choices ?? post?.attachment?.quiz?.choices;
		if (!post || !Array.isArray(choices) || !Number.isInteger(t.ch) || t.ch! < 0 || t.ch! >= choices.length) throw new ApiError(404, "This poll isn't available anymore.");
		if (post.channel_id === viewer.channelId) throw new ApiError(400, "You can't vote in your own poll.");
		if (t.a === "punvote") await sql`delete from post_votes where post_id = ${t.po} and user_id = ${viewer.userId} and choice = ${t.ch!}`;
		else await sql`insert into post_votes (user_id, post_id, choice) values (${viewer.userId}, ${t.po}, ${t.ch!}) on conflict (user_id, post_id) do update set choice = excluded.choice, created_at = now()`;
		return { feedback: t.a === "pvote" ? "FEEDBACK_SELECT" : "FEEDBACK_DESELECT" };
	}
	const want = t.a === "plike" ? "like" : t.a === "pdislike" ? "dislike" : null;
	await sql.begin(async (tx) => {
		const [post] = await tx`select id from posts where id = ${t.po} and deleted_at is null for update`;
		if (!post) throw new ApiError(404, "This post isn't available anymore.");
		const [prev] = await tx`select kind from post_reactions where user_id = ${viewer.userId} and post_id = ${t.po}`;
		if (prev?.kind === want) return;
		if (prev) await tx`delete from post_reactions where user_id = ${viewer.userId} and post_id = ${t.po}`;
		if (prev?.kind === "like") await tx`update posts set like_count = greatest(0, like_count - 1) where id = ${t.po}`;
		if (want) await tx`insert into post_reactions (user_id, post_id, kind) values (${viewer.userId}, ${t.po}, ${want})`;
		if (want === "like") await tx`update posts set like_count = like_count + 1 where id = ${t.po}`;
	});
	return {};
}

export const isPostAction = (t: { a?: string }) => typeof t.a === "string" && ["plike", "pdislike", "pclear", "pdelete", "pvote", "punvote"].includes(t.a);
