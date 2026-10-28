// A channel's Community (browse FEcommunity_page, /@handle/community), open
// while the channel has Viewer posts on in Studio (community-settings.ts):
// YouTube's page (template community/page) with the channel's posts and what
// its subscribers posted there, sorted by the Top / Newest / Creator posts
// chips (reloadContinuationItemsCommand), 16 posts a page. A viewer's post
// carries the author's profile card command and no Share button; the
// channel's own is highlighted, with its verified badge type.

import type { Viewer } from "../client/page";
import { getChannel } from "../data";
import { sql } from "../db";
import { encodeToken } from "../ids";
import { communityOpen, durationText, mayPostInCommunity, viewerPostSettings } from "./community-settings";
import { composer } from "./post-composer";
import { type Post, postThread } from "./posts";
import { encode } from "./proto";
import { type Channel, avatarThumbnails, responseContext } from "./r";
import { make, tpl } from "./tpl";
import { baseVars, channelVars } from "./vars";

export type CommunitySort = "top" | "newest" | "creator";
const PAGE = 16;
const TARGET = "community-page-posts-container";
const SECTION = "backstage-item-section";

const protoParams = (msg: Parameters<typeof encode>[0]) => encodeURIComponent(Buffer.from(encode(msg)).toString("base64"));
// FEcommunity_page params and a profile card's context, as YouTube's carry
// them: {152: {1: channel}} and {1000: {1: channel}}
export const communityParams = (channelId: string) => protoParams({ 152: { 1: channelId } });
const cardContext = (channelId: string) => protoParams({ 1000: { 1: channelId } });

export function channelFromCommunityParams(params: string | undefined): string | undefined {
	if (!params) return undefined;
	try {
		return /UC[A-Za-z0-9_-]{22}/.exec(Buffer.from(decodeURIComponent(params), "base64").toString("latin1"))?.[0];
	} catch {
		return undefined;
	}
}

export const communityPath = (c: Channel) => `/@${c.handle}/community`;
export const communityCommand = (c: Channel) => ({
	commandMetadata: { webCommandMetadata: { url: communityPath(c), webPageType: "WEB_PAGE_TYPE_BROWSE", rootVe: 6827, apiUrl: "/youtubei/v1/browse" } },
	browseEndpoint: { browseId: "FEcommunity_page", params: communityParams(c.id), canonicalBaseUrl: communityPath(c) },
});

// the channel header's Community button, after the subscribe button
export const communityButton = (c: Channel) => ({
	buttonViewModel: {
		iconName: "PEOPLE_GROUP",
		title: "Community",
		onTap: { innertubeCommand: communityCommand(c) },
		accessibilityText: "Community",
		style: "BUTTON_VIEW_MODEL_STYLE_MONO",
		isFullWidth: false,
		type: "BUTTON_VIEW_MODEL_TYPE_TONAL",
		buttonSize: "BUTTON_VIEW_MODEL_SIZE_DEFAULT",
		state: "BUTTON_VIEW_MODEL_STATE_ACTIVE",
		accessibilityId: "eml.header_community_button",
	},
});

// the Community's posts: the channel's own and its viewers', by the chip's order
async function communityPosts(c: Channel, viewer: Viewer, sort: CommunitySort, offset: number): Promise<Post[]> {
	const which = sort === "creator" ? sql`p.channel_id = ${c.id} and p.community_channel_id is null` : sql`(p.community_channel_id = ${c.id} or (p.channel_id = ${c.id} and p.community_channel_id is null))`;
	const order = sort === "top" ? sql`p.like_count + p.comment_count desc, p.published_at desc` : sql`p.published_at desc`;
	return (await sql`select p.id, p.channel_id, p.text, p.attachment, p.like_count, p.comment_count, p.created_at, p.published_at, p.edited_at,
		(select kind from post_reactions r where r.post_id = p.id and r.user_id = ${viewer?.userId ?? "0"}) as reaction
		from posts p join channels a on a.id = p.channel_id join users u on u.id = a.user_id
		where p.deleted_at is null and p.published_at <= now() and u.disabled_at is null and ${which}
		order by ${order}, p.id limit ${PAGE} offset ${offset}`) as Post[];
}

// a post as the Community shows it
export async function communityThread(p: Post, author: Channel, c: Channel, viewer: Viewer) {
	const thread = await postThread(p, author, viewer);
	const post = thread.backstagePostThreadRenderer.post.backstagePostRenderer;
	post.authorEndpoint = { profileCardCommand: { profileOwnerExternalChannelId: author.id, profileCardContext: cardContext(c.id) } };
	if (author.id === c.id) {
		post.showPostAuthorBackgroundHighlight = true;
		if ((c as Channel & { verification?: string }).verification === "verified") post.postAuthorBadgeType = "POST_AUTHOR_BADGE_TYPE_VERIFIED";
	} else delete post.actionButtons?.commentActionButtonsRenderer?.shareButton;
	return thread;
}

// the composer row over the posts: the Community's prompt for whoever may
// post (the channel and subscribers of the minimum time), the row that can't
// post otherwise (signed out, as YouTube's; signed in, why not)
async function composerHeader(c: Channel, viewer: Viewer) {
	if (viewer && (await mayPostInCommunity(c, viewer))) {
		const own = await getChannel({ id: viewer.channelId });
		if (own) return { commentsHeaderRenderer: { createRenderer: composer(own, viewer, c), isBackstageContent: true, shouldShowBackstagePostOptimistically: true } };
	}
	const header = tpl("community/composer_out");
	if (viewer) {
		const wait = durationText(Number(viewerPostSettings(c.viewer_posts).minimumSubscriberDuration.seconds));
		const popup = header.commentsHeaderRenderer.postHeaderOnTap.openPopupAction.popup.notificationActionRenderer;
		popup.responseText = { simpleText: `Posting is available to subscribers of ${c.title}${wait ? ` after ${wait}` : ""}` };
		delete popup.actionButton;
	}
	return header;
}

async function sections(c: Channel, viewer: Viewer, sort: CommunitySort, offset: number, withComposer: boolean) {
	const posts = await communityPosts(c, viewer, sort, offset);
	const authors = new Map<string, Channel | undefined>([[c.id, c]]);
	const out: unknown[] = [];
	for (const p of posts) {
		if (!authors.has(p.channel_id)) authors.set(p.channel_id, await getChannel({ id: p.channel_id }));
		const author = authors.get(p.channel_id);
		if (author) out.push({ itemSectionRenderer: { contents: [await communityThread(p, author, c, viewer)], sectionIdentifier: SECTION } });
	}
	if (withComposer) {
		const header = await composerHeader(c, viewer);
		if (out.length) Object.assign((out[0] as { itemSectionRenderer: object }).itemSectionRenderer, { header });
		else out.push({ itemSectionRenderer: { contents: [], header, sectionIdentifier: SECTION } });
	}
	if (posts.length === PAGE) out.push(make("item/continuation", { CONTINUATION: encodeToken({ k: "community", c: c.id, s: sort, o: offset + PAGE }) }));
	return out;
}

// the latest posters' avatars beside "Public"
async function posterAvatars(c: Channel) {
	const rows = await sql`select channel_id from posts where community_channel_id = ${c.id} and deleted_at is null and published_at <= now() group by channel_id order by max(published_at) desc limit 6`;
	return rows.map((r: { channel_id: string }) => make("community/stack_avatar", { AVATAR_48: avatarThumbnails(r.channel_id, [48]).thumbnails }));
}

const OPEN = "This Community is a space for you to share what you love and connect with the creator and other viewers. Your posts can appear both here and across YouTube, like the Home feed.";
const WATCH = "This Community is a space for you to explore posts and conversations from the creator and other viewers. Stay tuned as opportunities to participate become available to you.";

async function pageParts(c: Channel, viewer: Viewer, sort: CommunitySort, items: unknown[]) {
	const description = viewer && (await mayPostInCommunity(c, viewer)) ? OPEN : WATCH;
	const chip = (s: CommunitySort) => encodeToken({ k: "community", c: c.id, s, o: 0, r: 1 });
	return make("community/page", {
		...baseVars(viewer, communityPath(c)),
		...channelVars(c),
		TITLE: `‎⁨${c.title}⁩’s Community`,
		TITLE_PLAIN: `${c.title}’s Community`,
		AVATAR: avatarThumbnails(c.id, [72, 120, 160]).thumbnails,
		AVATAR_68: [{ url: avatarThumbnails(c.id, [68]).thumbnails[0].url }],
		AVATARS: await posterAvatars(c),
		DESCRIPTION: description,
		DESCRIPTION_LABEL: `Description. ${description.slice(0, 50)}...tap for more.`,
		CHIP_TOP: chip("top"),
		CHIP_NEWEST: chip("newest"),
		CHIP_CREATOR: chip("creator"),
		TOP_SELECTED: sort === "top",
		NEWEST_SELECTED: sort === "newest",
		CREATOR_SELECTED: sort === "creator",
		SECTIONS: items,
	});
}

export async function communityPage(c: Channel, viewer: Viewer) {
	if (!communityOpen(c)) return undefined;
	return pageParts(c, viewer, "top", await sections(c, viewer, "top", 0, true));
}

// a chip (reload, the composer row again) or the next page (append); both
// answer with the page's header as YouTube's do
export async function communityContinuation(t: { c?: string; s?: string; o?: number; r?: number }, viewer: Viewer) {
	const c = t.c ? await getChannel({ id: t.c }) : undefined;
	if (!c || !communityOpen(c)) return undefined;
	const sort: CommunitySort = t.s === "newest" || t.s === "creator" ? t.s : "top";
	const offset = Number(t.o) || 0;
	const items = await sections(c, viewer, sort, offset, !!t.r);
	const { header, microformat, toolbarMenu } = await pageParts(c, viewer, sort, []);
	const action = t.r ? { reloadContinuationItemsCommand: { targetId: TARGET, continuationItems: items, slot: "RELOAD_CONTINUATION_SLOT_BODY" } } : { appendContinuationItemsAction: { continuationItems: items, targetId: TARGET } };
	return { responseContext: responseContext(viewer), ...tpl("community/continuation"), header, microformat, toolbarMenu, onResponseReceivedActions: [action] };
}
