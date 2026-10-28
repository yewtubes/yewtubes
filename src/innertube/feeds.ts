// Feed pages built from YouTube's responses: home and subscriptions
// (templates home/*, subscriptions/*, item/video_lockup_rich*,
// item/shorts_lockup_rich, home/chip_bar, item/home_chip*). Home is
// YouTube's: the chip bar, videos in the grid, Shorts on a shelf of their own
// a few rows down.

import type { Viewer } from "../client/page";
import { PUBLIC_ORIGIN } from "../config";
import { type HomeFilter, longVideos, markWatched, shortVideos, subscriptionFeed } from "../data";
import { encodeToken } from "../ids";
import { type Video, compactViews, countLabel } from "./r";
import { make } from "./tpl";
import { baseVars, videoVars } from "./vars";

export const FEED_PAGE = 24;
const SHELF_SHORTS = 10;

// a video in a rich grid; signed-out viewers get YouTube's signed-out menu
export const richLockup = (v: Video, viewer: Viewer) => make(viewer ? "item/video_lockup_rich" : "item/video_lockup_rich_out", { ...baseVars(viewer, `/watch?v=${v.id}`), ...videoVars(v) });

async function page(videos: Video[], viewer: Viewer, next: Record<string, unknown>) {
	const items: unknown[] = (await markWatched(viewer, videos)).map((v) => richLockup(v, viewer));
	if (videos.length === FEED_PAGE) items.push(make("item/continuation_rich", { CONTINUATION: encodeToken(next) }));
	return items;
}

// a Short on home's shelf, with its whole first frame (process.ts frame0)
export function shortVars(v: Video, viewer: Viewer) {
	const scale = Math.min(1, 720 / (v.height || 720));
	const frame = [{ url: `${PUBLIC_ORIGIN}/vi/${v.id}/frame0.jpg`, width: Math.round((v.width || 405) * scale), height: Math.round((v.height || 720) * scale) }];
	return {
		...baseVars(viewer, `/shorts/${v.id}`),
		VIDEO_ID: v.id,
		TITLE: v.title,
		VIEWS_SHORT: compactViews(v.view_count),
		A11Y: `${v.title}, ${countLabel(v.view_count, "view")} - play Short`,
		THUMBS: frame,
		REEL_THUMBS: frame,
	};
}
export const shortLockup = (v: Video, viewer: Viewer) => make("item/shorts_lockup_rich", shortVars(v, viewer));

// the chips YouTube shows on every home feed (topic chips need topics, which
// videos here don't have); Watched and New to you need a signed-in viewer
const CHIPS: [HomeFilter, string][] = [["all", "All"], ["recent", "Recently uploaded"], ["watched", "Watched"], ["new", "New to you"]];
const chipBar = (viewer: Viewer, selected: HomeFilter) =>
	make("home/chip_bar", {
		CHIPS: CHIPS.filter(([f]) => viewer || f === "all" || f === "recent").map(([f, text]) =>
			f === selected ? make("item/home_chip_selected", { TEXT: text }) : make("item/home_chip", { TEXT: text, TOKEN: encodeToken({ k: "homechip", f }) }),
		),
	});

// Shorts' shelf sits where YouTube's response puts it, after the seventh
// video; the client moves it on to the end of that row (reflowOptions)
const SHELF_AT = 7;

export async function homeItems(viewer: Viewer, offset: number, filter: HomeFilter = "all") {
	const items = await page(await longVideos(FEED_PAGE, offset, filter, viewer), viewer, { k: "home", o: offset + FEED_PAGE, f: filter });
	if (offset || filter !== "all") return items;
	const shorts = await shortVideos(SHELF_SHORTS);
	if (shorts.length) items.splice(Math.min(SHELF_AT, items.length), 0, make("home/shorts_shelf", { ITEMS: shorts.map((v) => shortLockup(v, viewer)) }));
	return items;
}

// a chip's continuation: the grid reloaded with that feed
export async function homeChipReload(viewer: Viewer, filter: HomeFilter) {
	return { reloadContinuationItemsCommand: { targetId: "browse-feedFEwhat_to_watch", continuationItems: await homeItems(viewer, 0, filter), slot: "RELOAD_CONTINUATION_SLOT_BODY" } };
}
export const subscriptionsItems = async (viewer: Viewer, offset: number) => await page(await subscriptionFeed(viewer, FEED_PAGE, offset), viewer, { k: "subs", o: offset + FEED_PAGE });

export async function homePage(viewer: Viewer) {
	const items = await homeItems(viewer, 0);
	// nothing uploaded yet: YouTube's own empty feed
	return items.length ? make("home/page", { ITEMS: items, HEADER: chipBar(viewer, "all") }) : make("home/empty", baseVars(viewer));
}

// Subscriptions: the "Latest" heading, the videos, and the subscriptions'
// Shorts on a shelf two rows down (as YouTube's response places it), whose
// "View all" opens the Shorts page
const SUBS_SHELF_AT = 8;
export async function subscriptionsPage(viewer: Viewer) {
	if (!viewer) return make("subscriptions/signed_out", baseVars(viewer, "/feed/subscriptions"));
	const items = await subscriptionsItems(viewer, 0);
	const shorts = await subscriptionFeed(viewer, SHELF_SHORTS, 0, "shorts");
	if (shorts.length) items.splice(Math.min(SUBS_SHELF_AT, items.length), 0, make("subscriptions/shorts_shelf", { ITEMS: shorts.map((v) => shortLockup(v, viewer)) }));
	return make("subscriptions/page", { ITEMS: [make("subscriptions/latest", {}), ...items] });
}

// /feed/subscriptions/shorts
export const subscriptionShortsItems = async (viewer: Viewer, offset: number) => {
	const shorts = await subscriptionFeed(viewer, FEED_PAGE, offset, "shorts");
	const items: unknown[] = shorts.map((v) => make("item/shorts_lockup_grid", shortVars(v, viewer)));
	if (shorts.length === FEED_PAGE) items.push(make("item/continuation_rich", { CONTINUATION: encodeToken({ k: "subshorts", o: offset + FEED_PAGE }) }));
	return items;
};
export async function subscriptionShortsPage(viewer: Viewer) {
	if (!viewer) return make("subscriptions/signed_out", baseVars(viewer, "/feed/subscriptions"));
	return make("subscriptions/shorts_page", { ITEMS: await subscriptionShortsItems(viewer, 0) });
}
