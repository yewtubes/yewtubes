// Watch history: recording what a signed-in viewer watches, and the History
// page built from YouTube's (templates history/*, item/video_lockup_history,
// item/shorts_lockup_history): entries grouped by day, each day's Shorts in a
// reel shelf, the All/Videos/Shorts/Music chips, searching the history,
// removing an entry, clearing it all and pausing it. Removing, clearing,
// pausing and turning it back on are YouTube's feedback calls, with tokens
// minted here. The My Activity links lead to the instance's own pages
// (activity.ts).

import type { Viewer } from "../client/page";
import { verifyApiSignature } from "../auth";
import { MUSIC_CATEGORY } from "../categories";
import { PUBLIC_ORIGIN } from "../config";
import { SHORT, isShort } from "../data";
import { sql, textArray } from "../db";
import { decodeToken, encodeToken } from "../ids";
import { viewerVars } from "./chrome";
import { shortVars } from "./feeds";
import { encode } from "./proto";
import { type Video, browseEndpoint, responseContext } from "./r";
import { ApiError, route } from "./router";
import { find, make } from "./tpl";
import { baseVars, videoVars } from "./vars";

const PAGE = 30;

export async function recordWatch(viewer: Viewer, videoId: string, positionMs = 0) {
	if (!viewer) return;
	// nothing is recorded while the viewer has paused their history
	await sql`insert into watch_history (user_id, video_id, position_ms)
		select ${viewer.userId}, ${videoId}, ${positionMs} where not (select history_paused from users where id = ${viewer.userId})
		on conflict (user_id, video_id) do update set watched_at = now(), position_ms = greatest(watch_history.position_ms, excluded.position_ms)`;
}

export type Entry = Video & { watched_at: Date; position_ms: number };

// the chips: All, Videos (no Shorts), Shorts, Music (the Music category)
export type HistoryFilter = "all" | "videos" | "shorts" | "music";
const CHIP_PARAMS: Record<string, HistoryFilter> = { oggECgIwAQ: "all", oggECgIgAQ: "videos", oggECgIQAQ: "shorts", oggECgIIAQ: "music" };
const historyFilter = (params?: string): HistoryFilter => CHIP_PARAMS[decodeURIComponent(params ?? "").replace(/=+$/, "")] ?? "all";

export async function entries(viewer: NonNullable<Viewer>, offset: number, query: string, limit = PAGE, filter: HistoryFilter = "all"): Promise<Entry[]> {
	const q = query.trim().slice(0, 100);
	const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
	const match = q ? sql`and (v.title ilike ${like} or c.title ilike ${like})` : sql``;
	const kind =
		filter === "videos" ? sql`and not coalesce(${SHORT}, false)`
		: filter === "shorts" ? sql`and coalesce(${SHORT}, false)`
		: filter === "music" ? sql`and v.category_id = ${MUSIC_CATEGORY}`
		: sql``;
	return (await sql`select v.id, v.title, v.description, v.channel_id, c.title as channel_title, c.handle as channel_handle, c.avatar_path as channel_avatar,
		v.duration_ms, v.view_count::int as view_count, v.like_count, v.comment_count, v.published_at, v.created_at, v.visibility, v.status, v.width, v.height, v.category_id,
		h.watched_at, h.position_ms
		from watch_history h join videos v on v.id = h.video_id join channels c on c.id = v.channel_id
		where h.user_id = ${viewer.userId} and v.deleted_at is null and (v.visibility <> 'private' or v.channel_id = ${viewer.channelId}) ${match} ${kind}
		order by h.watched_at desc limit ${limit} offset ${offset}`) as Entry[];
}

// the day headings YouTube uses: Today, Yesterday, a weekday this week, then dates
export function dayLabel(d: Date, now = new Date()): string {
	const day = (x: Date) => Math.floor((x.getTime() - x.getTimezoneOffset() * 60000) / 86400000);
	const diff = day(now) - day(d);
	if (diff <= 0) return "Today";
	if (diff === 1) return "Yesterday";
	if (diff < 7) return d.toLocaleDateString("en-US", { weekday: "long" });
	return d.toLocaleDateString("en-US", d.getFullYear() === now.getFullYear() ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
}

export const watchedPercent = (v: { duration_ms: number | null }, positionMs: number) => (v.duration_ms ? Math.min(100, Math.round((positionMs / v.duration_ms) * 100)) : 0);

// a lockup with YouTube's red progress bar, when some of it was watched
export function progressItem(name: string, v: Video, percent: number, vars: Record<string, unknown>) {
	const item = make(name, { ...vars, ...videoVars(v), WATCHED_PERCENT: percent });
	if (!percent) {
		const bottom = find(item, "thumbnailBottomOverlayViewModel");
		if (bottom) delete bottom.progressBar;
	}
	return item;
}

// a history entry; template item/video_lockup_history (History page) or
// item/video_lockup_you_history (the You page's History shelf)
export function entryItem(v: Entry, viewer: Viewer, name = "item/video_lockup_history") {
	const percent = watchedPercent(v, v.position_ms);
	return progressItem(name, v, percent, { ...baseVars(viewer, "/feed/history"), ...resumeVars(v.position_ms, percent), REMOVE_TOKEN: encodeToken({ k: "hremove", v: v.id }) });
}

// a partly watched video opens where the viewer stopped, as on YouTube: &t=
// in the URL, and the watch endpoint's startTimeSeconds with params field 39
// carrying the same seconds; a finished one starts over
function resumeVars(positionMs: number, percent: number) {
	const seconds = Math.floor(positionMs / 1000);
	if (!seconds || percent >= 95) return { RESUME_T: "", RESUME_SECONDS: undefined, RESUME_PARAMS: undefined };
	return { RESUME_T: `&t=${seconds}s`, RESUME_SECONDS: seconds, RESUME_PARAMS: encodeURIComponent(Buffer.from(encode({ 39: seconds })).toString("base64")) };
}

// how far the viewer got into each video
export async function watchedPercents(viewer: NonNullable<Viewer>, videos: Video[]): Promise<Map<string, number>> {
	if (!videos.length) return new Map();
	const rows = await sql`select video_id, position_ms from watch_history where user_id = ${viewer.userId} and video_id = any(${textArray(videos.map((v) => v.id))}::text[])`;
	const pos = new Map(rows.map((r: { video_id: string; position_ms: number }) => [r.video_id, r.position_ms]));
	return new Map(videos.map((v) => [v.id, watchedPercent(v, Number(pos.get(v.id) ?? 0))]));
}

// a Short in a day's reel shelf
const shortItem = (v: Entry, viewer: Viewer) => make("item/shorts_lockup_history", { ...shortVars(v, viewer), REMOVE_TOKEN: encodeToken({ k: "hremove", v: v.id }) });

// day sections for one page, then the continuation when there is more. A
// day's Shorts share one reel shelf, where the first of them falls.
async function sections(viewer: NonNullable<Viewer>, offset: number, query: string, filter: HistoryFilter) {
	const rows = await entries(viewer, offset, query, PAGE, filter);
	const days: { label: string; items: unknown[]; shorts?: unknown[] }[] = [];
	for (const v of rows) {
		const label = dayLabel(new Date(v.watched_at));
		let day = days.at(-1);
		if (day?.label !== label) days.push((day = { label, items: [] }));
		if (!isShort(v)) day.items.push(entryItem(v, viewer));
		else if (day.shorts) day.shorts.push(shortItem(v, viewer));
		else {
			day.shorts = [shortItem(v, viewer)];
			day.items.push(make("history/shorts_shelf", { ITEMS: day.shorts }));
		}
	}
	const contents: unknown[] = days.map((d) => make("history/section", { DAY: d.label, ITEMS: d.items }));
	if (rows.length === PAGE) contents.push(make("item/continuation", { CONTINUATION: encodeToken({ k: "history", o: offset + PAGE, q: query, f: filter }) }));
	return contents;
}

const ACTIVITY = `${PUBLIC_ORIGIN}/myaccount/activity`;

export async function historyPage(viewer: Viewer, params?: string, query = "") {
	if (!viewer) return make("history/signed_out", baseVars(viewer, "/feed/history"));
	const filter = historyFilter(params);
	const contents = await sections(viewer, 0, query, filter);
	const [{ history_paused: paused }] = await sql`select history_paused from users where id = ${viewer.userId}`;
	const vars = { ...baseVars(viewer, "/feed/history"), ...viewerVars(viewer), ACTIVITY_URL: ACTIVITY, };
	return make("history/page", {
		...vars,
		QUERY: query,
		CLEAR_TOKEN: encodeToken({ k: "hclear" }),
		PAUSE_TOGGLE: paused ? make("history/resume_button", { ...vars, RESUME_TOKEN: encodeToken({ k: "hresume" }) }) : make("history/pause_button", { ...vars, PAUSE_TOKEN: encodeToken({ k: "hpause" }) }),
		ACTIVITY_COMMENTS_URL: `${ACTIVITY}/comments`,
		ACTIVITY_POSTS_URL: `${ACTIVITY}/posts`,
		ACTIVITY_LIVE_CHAT_URL: `${ACTIVITY}/live-chat`,
		CHIP_ALL_SELECTED: filter === "all",
		CHIP_VIDEOS_SELECTED: filter === "videos",
		CHIP_SHORTS_SELECTED: filter === "shorts",
		CHIP_MUSIC_SELECTED: filter === "music",
		CONTENTS: contents.length ? contents : [{ itemSectionRenderer: { contents: [{ messageRenderer: { text: { runs: [{ text: query ? "No results found" : "This list has no videos." }] } } }] } }],
	});
}

export async function historyContinuation(viewer: Viewer, offset: number, query = "", f?: string) {
	if (!viewer) throw new ApiError(401, "Sign in to do this.", "authError");
	const filter = Object.values(CHIP_PARAMS).find((x) => x === f) ?? "all";
	return { responseContext: responseContext(viewer), onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: await sections(viewer, offset, query, filter), targetId: "browse-feedFEhistory" } }] };
}

export async function setHistoryPaused(userId: string, paused: boolean) {
	await sql`update users set history_paused = ${paused} where id = ${userId}`;
}

// /youtubei/v1/feedback: the History page's remove, clear, pause and turn on. Other feedback
// (the client's own reports) is accepted and dropped.
route("feedback", async ({ req, body, viewer }) => {
	const tokens = (Array.isArray(body.feedbackTokens) ? body.feedbackTokens : []).slice(0, 20).map((t: unknown) => decodeToken<{ k: string; v?: string }>(String(t))).filter(Boolean);
	const ours = tokens.filter((t: { k: string }) => ["hremove", "hclear", "hpause", "hresume"].includes(t.k));
	if (!ours.length) return { responseContext: responseContext(viewer) };
	if (!viewer) throw new ApiError(401, "Sign in to do this.", "authError");
	if (!verifyApiSignature(req, viewer)) throw new ApiError(403, "The request is missing a valid API signature.", "forbidden");
	for (const t of ours as { k: string; v?: string }[]) {
		if (t.k === "hclear") await sql`delete from watch_history where user_id = ${viewer.userId}`;
		else if (t.k === "hpause" || t.k === "hresume") await setHistoryPaused(viewer.userId, t.k === "hpause");
		else await sql`delete from watch_history where user_id = ${viewer.userId} and video_id = ${String(t.v)}`;
	}
	// pausing or turning it back on changes the page's toggle: the client
	// runs the response's actions, here the page loaded again in place (as
	// the chips load it)
	const toggled = ours.some((t: { k: string }) => t.k === "hpause" || t.k === "hresume");
	const actions = toggled ? [browseEndpoint("FEhistory", "/feed/history", "WEB_PAGE_TYPE_BROWSE", 6827, { navigationType: "BROWSE_NAVIGATION_TYPE_LOAD_IN_PLACE" })] : undefined;
	return { responseContext: responseContext(viewer), feedbackResponses: ours.map(() => ({ isProcessed: true })), ...(actions ? { actions } : {}) };
});
