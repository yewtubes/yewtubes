// /myaccount/activity: the instance's own "My Activity", where the History
// page's "Manage all history", Comments, Posts and Live chat links lead (on
// YouTube they open Google's My Activity). Like /myaccount it is this
// instance's page, not YouTube's: watch history on or paused, clearing it,
// the comments you've posted (each can be deleted), and your posts and live
// chat messages. Changes are same-origin POSTs checked by myAccountRoutes.

import type { Viewer } from "./client/page";
import { INSTANCE_NAME } from "./config";
import { sql } from "./db";
import { deleteOwnComment } from "./innertube/comments";
import { setHistoryPaused } from "./innertube/history";
import { esc, form, header, localPage, when } from "./myaccount";

const PAGE = 50;
const DONE: Record<string, string> = {
	paused: "Watch history is paused.",
	resumed: "Watch history is on.",
	cleared: "Watch history cleared.",
	deleted: "Comment deleted.",
};
const SECTIONS = [
	["", "YouTube History"],
	["/comments", "Comments"],
	["/posts", "Posts"],
	["/live-chat", "Live chat"],
] as const;

const nav = (current: string) =>
	`<nav class="tabs">${SECTIONS.map(([p, label]) => (p === current ? `<b>${label}</b>` : `<a href="/myaccount/activity${p}">${label}</a>`)).join("")}</nav>`;

async function historySection(viewer: NonNullable<Viewer>) {
	const [u] = await sql`select history_paused, (select count(*)::int from watch_history where user_id = ${viewer.userId}) as n from users where id = ${viewer.userId}`;
	return `<section><h2>Watch history</h2><p class="sub">${u.history_paused ? "Paused: videos you watch aren't added to your history." : "On: videos you watch are added to your history, and the History page lists them."}</p>
<dl><dt>Status</dt><dd>${u.history_paused ? "Paused" : "On"}</dd><dt>Entries</dt><dd><a href="/feed/history">${u.n.toLocaleString("en-US")} in your history</a></dd></dl>
${form(viewer, "/myaccount/activity/history", `<input type="hidden" name="op" value="${u.history_paused ? "resume" : "pause"}"><button class="quiet" style="margin-top:16px">${u.history_paused ? "Turn on watch history" : "Pause watch history"}</button>`)}
${u.n ? form(viewer, "/myaccount/activity/history", `<input type="hidden" name="op" value="clear"><button class="danger">Clear all watch history</button>`) : ""}</section>`;
}

async function commentsSection(viewer: NonNullable<Viewer>, page: number) {
	const rows = await sql`select c.id, c.text, c.gif, c.created_at, c.parent_id, v.id as video_id, v.title from comments c join videos v on v.id = c.video_id
		where c.author_channel_id = ${viewer.channelId} and c.deleted_at is null and v.deleted_at is null
		order by c.created_at desc limit ${PAGE + 1} offset ${page * PAGE}`;
	const more = rows.length > PAGE;
	const items = rows
		.slice(0, PAGE)
		.map(
			(c: any) =>
				`<tr><td>${esc(when(c.created_at))}</td><td><a href="/watch?v=${esc(c.video_id)}&amp;lc=${esc(c.id)}">${esc(c.title)}</a>${c.parent_id ? ` <span class="tag">Reply</span>` : ""}</td><td>${esc(c.text)}${c.gif ? ` <span class="tag">GIF</span>` : ""}</td><td>${form(viewer, "/myaccount/activity/comments/delete", `<input type="hidden" name="comment" value="${esc(c.id)}"><button class="quiet">Delete</button>`)}</td></tr>`,
		)
		.join("");
	const pager = [page > 0 ? `<a href="/myaccount/activity/comments?page=${page - 1}">Newer</a>` : "", more ? `<a href="/myaccount/activity/comments?page=${page + 1}">Older</a>` : ""].filter(Boolean).join(" · ");
	return `<section><h2>Comments</h2><p class="sub">Comments and replies you've posted on videos on ${esc(INSTANCE_NAME)}, newest first.</p>
${items ? `<div class="table"><table><thead><tr><th>Posted</th><th>On</th><th>Comment</th><th></th></tr></thead><tbody>${items}</tbody></table></div>${pager ? `<p>${pager}</p>` : ""}` : `<p>You haven't posted any comments.</p>`}</section>`;
}

export async function activityPage(req: Request, url: URL, viewer: NonNullable<Viewer>, sub: string) {
	const section = SECTIONS.find(([p]) => p === sub);
	if (!section) return new Response("not found", { status: 404 });
	const done = DONE[url.searchParams.get("done") ?? ""];
	const page = Math.max(0, Math.min(1000, Number(url.searchParams.get("page")) || 0));
	const content =
		sub === "" ? await historySection(viewer)
		: sub === "/comments" ? await commentsSection(viewer, page)
		: sub === "/posts" ? `<section><h2>Posts</h2><p class="sub">Posts you make on your channel and comments you leave on posts.</p><p>No post activity on your account.</p></section>`
		: `<section><h2>Live chat</h2><p class="sub">Messages you send in live chat.</p><p>${esc(INSTANCE_NAME)} doesn't host live streams, so there's no live chat activity.</p></section>`;
	const body = `${header("My Activity", "/myaccount/activity")}
<main>
<div class="hero"><h1>${section[1]}</h1><p>Your activity on ${esc(INSTANCE_NAME)}, kept by this instance (not Google)</p></div>
${nav(sub)}
${done ? `<p class="notice" role="status">${esc(done)}</p>` : ""}
${content}
</main>`;
	return localPage(req, `${section[1]} - My Activity`, body);
}

const back = (path: string, done: string) => new Response(null, { status: 303, headers: { location: `${path}?done=${done}` } });

// the page's forms (origin and token already checked)
export async function activityAction(path: string, get: (k: string) => string, viewer: NonNullable<Viewer>): Promise<Response | undefined> {
	if (path === "/myaccount/activity/history") {
		const op = get("op");
		if (op === "clear") {
			await sql`delete from watch_history where user_id = ${viewer.userId}`;
			return back("/myaccount/activity", "cleared");
		}
		if (op !== "pause" && op !== "resume") return new Response("bad request", { status: 400 });
		await setHistoryPaused(viewer.userId, op === "pause");
		return back("/myaccount/activity", op === "pause" ? "paused" : "resumed");
	}
	if (path === "/myaccount/activity/comments/delete") {
		await deleteOwnComment(viewer.channelId, get("comment"));
		return back("/myaccount/activity/comments", "deleted");
	}
	return undefined;
}
