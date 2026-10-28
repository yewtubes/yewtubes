// Studio's Customization pages (/editing/profile, /editing/sections):
// channel_edit/get_channel_page_settings, validate_channel_handle and
// update_channel_page_settings, and the picture and banner uploads Studio
// sends first (a resumable upload to /channel_image_upload/profile|banner,
// scotty.ts, answered with the blob id the update then names).
//
// Stored: name, handle, description, picture, banner, links, contact email,
// and the Home tab: shown or not, its sections (home-layout.ts), the trailer
// and the featured video. The video watermark, pronouns and collaborations
// aren't stored yet: an update that
// changes them gets an error for those fields (or, for the two Studio reads
// no per-field result for, for the whole update), so Studio reports them
// unsaved.

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Viewer } from "../client/page";
import { MEDIA_DIR, PUBLIC_ORIGIN } from "../config";
import { sql } from "../db";
import { decodeToken, encodeToken, randomId } from "../ids";
import { responseContext } from "../innertube/r";
import { ApiError, type Ctx, route } from "../innertube/router";
import { make } from "../innertube/tpl";
import { creatorChannel } from "./channel";
import { imageTransfer } from "./scotty";
import { cleanShelves, savedShelves, shelfInfo } from "../home-layout";

const DAY = 86_400_000;
const CHANGES_PER_14_DAYS = 2;
const MAX_TITLE = 100;
const MAX_DESCRIPTION = 1000;
const MAX_LINKS = 14;
const IMAGE_LIMIT = { profile: 4 * 1024 ** 2, banner: 6 * 1024 ** 2 } as const;
type Kind = keyof typeof IMAGE_LIMIT;
type Link = { title: string; url: string };
type Row = { id: string; handle: string; title: string; description: string; avatar_path: string | null; banner_path: string | null; links: Link[]; business_email: string | null; trailer_video_id: string | null; featured_video_id: string | null; featured_video_title: string | null; home_tab_enabled: boolean; home_shelves: unknown };

async function channelRow(id: string) {
	const [c] = (await sql`select id, handle, title, description, avatar_path, banner_path, links, business_email, trailer_video_id, featured_video_id, featured_video_title, home_tab_enabled, home_shelves from channels where id = ${id}`) as Row[];
	return c;
}

const text = (s: string) => ({ original: s, originalLanguage: "", messages: [] });

export async function pageSettings(channelId: string) {
	const c = await channelRow(channelId);
	if (!c) return undefined;
	return {
		...make<Record<string, unknown>>("studio/channel_page_settings", {}),
		externalChannelId: c.id,
		brandTitle: { original: c.title, originalLanguage: "" },
		handle: { handle: c.handle, isRateLimited: (await recentChanges(c.id, "handle")) >= CHANGES_PER_14_DAYS },
		vanityUrl: `${PUBLIC_ORIGIN}/@${c.handle}`,
		description: c.description ? text(c.description) : {},
		banner: c.banner_path ? { fifeUrl: `${PUBLIC_ORIGIN}/ggpht/${c.id}/banner` } : {},
		animatedBanner: {},
		userSetProfilePicture: c.avatar_path ? { fifeUrl: `${PUBLIC_ORIGIN}/ggpht/${c.id}/avatar` } : {},
		defaultProfilePicture: { fifeUrl: `${PUBLIC_ORIGIN}/ggpht/${c.id}/avatar-default` },
		channelLinksInfo: c.links.length ? { channelLinks: c.links.map((l) => ({ ...l, status: "CHANNEL_LINK_STATUS_OK" })) } : {},
		businessEmail: c.business_email ?? "",
		homeTab: { enabled: c.home_tab_enabled },
		shelfInfo: await shelfInfo(c.id, savedShelves(c.home_shelves)),
		isFakeShelfInfo: !savedShelves(c.home_shelves),
		trailerVideoInfo: c.trailer_video_id ? { videoId: c.trailer_video_id } : {},
		featuredVideoInfo: c.featured_video_id ? { videoId: c.featured_video_id, ...(c.featured_video_title ? { title: c.featured_video_title } : {}) } : {},
	};
}

// a spotlight video must be one of the channel's public videos
async function spotlightVideo(channelId: string, id: unknown) {
	const [v] = await sql`select id from videos where id = ${String(id ?? "")} and channel_id = ${channelId} and visibility = 'public' and deleted_at is null`;
	return v?.id as string | undefined;
}

async function recentChanges(channelId: string, kind: "title" | "handle") {
	const [{ n }] = await sql`select count(*)::int as n from channel_identity_changes where channel_id = ${channelId} and kind = ${kind} and changed_at > ${new Date(Date.now() - 14 * DAY)}`;
	return n as number;
}

// why a handle can't be the channel's, as validate_channel_handle names it
type HandleCheck = { result: string; conformanceError?: string; availableVariations?: string[] };
async function checkHandle(raw: string, channelId: string): Promise<HandleCheck> {
	const handle = raw.replace(/^@/, "");
	const bad = (conformanceError: string) => ({ result: "CHANNEL_HANDLE_VALIDATION_RESULT_CONFORMANCE_ERROR", conformanceError });
	if (handle.length < 3) return bad("CHANNEL_HANDLE_CONFORMANCE_ERROR_TOO_SHORT");
	if (handle.length > 30) return bad("CHANNEL_HANDLE_CONFORMANCE_ERROR_TOO_LONG");
	if (!/^[A-Za-z0-9._-]+$/.test(handle)) return bad("CHANNEL_HANDLE_CONFORMANCE_ERROR_INVALID_CHARACTERS");
	if (/^[._-]/.test(handle)) return bad("CHANNEL_HANDLE_CONFORMANCE_ERROR_DISALLOWED_LEADING_CHARACTER");
	if (/[._-]$/.test(handle)) return bad("CHANNEL_HANDLE_CONFORMANCE_ERROR_DISALLOWED_TRAILING_CHARACTER");
	if (/[._-]{2}/.test(handle)) return bad("CHANNEL_HANDLE_CONFORMANCE_ERROR_TOO_MANY_PUNCTUATION");
	if (/(.)\1{3}/i.test(handle)) return bad("CHANNEL_HANDLE_CONFORMANCE_ERROR_TOO_MANY_SAME_LETTERS_IN_A_ROW");
	if (!(await takenBy(handle, channelId))) return { result: "CHANNEL_HANDLE_VALIDATION_RESULT_OK" };
	for (let i = 0; i < 20; i++) {
		const v = `${handle.slice(0, 26)}${Math.floor(1000 + Math.random() * 9000)}`;
		if (!(await takenBy(v, channelId))) return { result: "CHANNEL_HANDLE_VALIDATION_RESULT_UNAVAILABLE", availableVariations: [v] };
	}
	return { result: "CHANNEL_HANDLE_VALIDATION_RESULT_UNAVAILABLE" };
}

// another channel's handle or sign-in name, or one another channel gave up
// in the last 14 days
async function takenBy(handle: string, channelId: string) {
	const h = handle.toLowerCase();
	const [row] = await sql`select 1 from channels where lower(handle) = ${h} and id <> ${channelId}
		union all select 1 from users u where lower(u.login) = ${h} and not exists(select 1 from channels c where c.user_id = u.id and c.id = ${channelId})
		union all select 1 from channel_identity_changes where kind = 'handle' and lower(old_value) = ${h} and channel_id <> ${channelId} and changed_at > ${new Date(Date.now() - 14 * DAY)}
		limit 1`;
	return !!row;
}

function cleanLinks(update: any): Link[] | string {
	if (update?.delete) return [];
	const links: any[] = update?.updateInfo?.channelLinks ?? [];
	if (!Array.isArray(links) || links.length > MAX_LINKS) return `Add up to ${MAX_LINKS} links.`;
	const out: Link[] = [];
	for (const l of links) {
		const title = String(l?.title ?? "").trim().slice(0, 100);
		let raw = String(l?.url ?? "").trim();
		if (!raw) continue;
		if (!/^[a-z][a-z0-9+.-]*:/i.test(raw)) raw = `https://${raw}`;
		let u: URL;
		try {
			u = new URL(raw);
		} catch {
			return `${raw} isn't a valid link.`;
		}
		if (u.protocol !== "https:" && u.protocol !== "http:") return "Links must start with http:// or https://.";
		out.push({ title: title || u.hostname, url: u.href.slice(0, 2048) });
	}
	return out;
}

// ---- picture and banner uploads ----

const PENDING = join(MEDIA_DIR, "channels", "pending");

export async function imageUploadRoute(req: Request, url: URL, viewer: Viewer): Promise<Response | undefined> {
	const m = /^\/channel_image_upload\/(profile|banner)$/.exec(url.pathname);
	if (!m) return undefined;
	const kind = m[1] as Kind;
	return imageTransfer(req, url, viewer, {
		purpose: "channel",
		limit: IMAGE_LIMIT[kind],
		finish: async (bytes, ext) => {
			if (!viewer) return "Sign in to upload.";
			mkdirSync(PENDING, { recursive: true });
			// uploads the channel never saved are dropped after a day
			for (const f of readdirSync(PENDING)) if (Date.now() - statSync(join(PENDING, f)).mtimeMs > DAY) rmSync(join(PENDING, f), { force: true });
			const file = `${randomId(16)}.${ext}`;
			await Bun.write(join(PENDING, file), bytes);
			return { encryptedBlobId: encodeToken({ s: 4, u: viewer.userId, k: kind, f: file }) };
		},
	});
}

// moves an uploaded image into place as the channel's picture or banner;
// undefined when the blob isn't this user's upload of that kind
function claimImage(blobId: unknown, kind: Kind, viewer: NonNullable<Viewer>) {
	const t = decodeToken<{ s?: number; u?: string; k?: string; f?: string }>(blobId);
	if (t?.s !== 4 || t.u !== viewer.userId || t.k !== kind || !/^[\w-]+\.(jpg|png|gif|bmp|webp)$/.test(String(t.f))) return undefined;
	const from = join(PENDING, String(t.f));
	if (!existsSync(from)) return undefined;
	const rel = join("channels", viewer.channelId, `${kind === "profile" ? "avatar" : "banner"}-${Date.now()}.${String(t.f).split(".").pop()}`);
	mkdirSync(join(MEDIA_DIR, "channels", viewer.channelId), { recursive: true });
	renameSync(from, join(MEDIA_DIR, rel));
	return rel;
}
const dropFile = (rel: string | null) => rel && rmSync(join(MEDIA_DIR, rel), { force: true });

// ---- routes ----

function owner(ctx: Ctx, channelId?: unknown) {
	if (!ctx.viewer) throw new ApiError(401, "Sign in to use Studio.", "authError");
	if (channelId && channelId !== ctx.viewer.channelId) throw new ApiError(403, "You can only customize your own channel.", "forbidden");
	return ctx.viewer;
}

route(
	"channel_edit/get_channel_page_settings",
	async (ctx) => {
		const viewer = owner(ctx, ctx.body.externalChannelId);
		return { responseContext: responseContext(viewer), channelPageSettingsData: await pageSettings(viewer.channelId) };
	},
	{ studio: true },
);

route(
	"channel_edit/validate_channel_handle",
	async (ctx) => {
		const viewer = owner(ctx, ctx.body.externalChannelId);
		const check = await checkHandle(String(ctx.body.handle ?? ""), viewer.channelId);
		return { responseContext: responseContext(viewer), result: { channelHandleValidationResultRenderer: check } };
	},
	{ studio: true },
);

// fields Studio can send that this instance doesn't store
const UNSTORED: [string, string][] = [
	["watermarkImageUpdate", "watermarkImageUpdateStatus"],
	["vanityUrlClaim", "vanityUrlClaimStatus"],
	["collaborationsConfigUpdate", "collaborationsConfigUpdateStatus"],
];

route(
	"channel_edit/update_channel_page_settings",
	async (ctx) => {
		const viewer = owner(ctx, ctx.body.externalChannelId);
		const b = ctx.body;
		if (b.pronounsUpdate?.pronouns?.pronounsOptions?.length) throw new ApiError(400, "This instance doesn't save pronouns yet.", "badRequest");
		const c = await channelRow(viewer.channelId);
		const status: Record<string, unknown> = {};
		const failed = (key: string, errorMessage: string, error?: string) => (status[key] = { errorCode: "INVALID_ARGUMENT", ...(error ? { error } : {}), errorMessage });

		const title = b.titleUpdate?.brandTitle?.original;
		if (typeof title === "string" && title.trim() !== c.title) {
			const t = title.trim().replace(/\s+/g, " ");
			if (!t || t.length > MAX_TITLE) failed("titleUpdateStatus", `Use a name of 1 to ${MAX_TITLE} characters.`, "TITLE_UPDATE_ERROR_REJECTED_BY_TNS");
			else if ((await recentChanges(c.id, "title")) >= CHANGES_PER_14_DAYS) failed("titleUpdateStatus", "You can change your name twice in 14 days. Try again later.", "TITLE_UPDATE_ERROR_NAME_CHANGE_QUOTA_EXCEEDED");
			else {
				await sql`insert into channel_identity_changes (channel_id, kind, old_value, new_value) values (${c.id}, 'title', ${c.title}, ${t})`;
				await sql`update channels set title = ${t} where id = ${c.id}`;
			}
		}

		const handle = typeof b.handleUpdate?.handle === "string" ? b.handleUpdate.handle.replace(/^@/, "") : undefined;
		if (handle && handle !== c.handle) {
			const check = await checkHandle(handle, c.id);
			if ((await recentChanges(c.id, "handle")) >= CHANGES_PER_14_DAYS) failed("newHandleUpdateStatus", "You can change your handle twice in 14 days. Try again later.", "HANDLE_UPDATE_ERROR_HANDLE_CHANGE_QUOTA_EXCEEDED");
			else if (check.result !== "CHANNEL_HANDLE_VALIDATION_RESULT_OK") failed("newHandleUpdateStatus", "This handle isn't available. Try a different one.", "HANDLE_UPDATE_ERROR_UNKNOWN");
			else {
				await sql`insert into channel_identity_changes (channel_id, kind, old_value, new_value) values (${c.id}, 'handle', ${c.handle}, ${handle})`;
				await sql`update channels set handle = ${handle} where id = ${c.id}`;
			}
		}

		if (b.descriptionUpdate) {
			const d = String(b.descriptionUpdate.description?.original ?? "").replace(/\r\n/g, "\n");
			if (d.length > MAX_DESCRIPTION) failed("descriptionUpdateStatus", `Descriptions are limited to ${MAX_DESCRIPTION} characters.`);
			else await sql`update channels set description = ${d.trim()} where id = ${c.id}`;
		}

		if (b.channelLinksUpdate) {
			const links = cleanLinks(b.channelLinksUpdate);
			if (typeof links === "string") failed("channelLinksUpdateStatus", links);
			else await sql`update channels set links = ${JSON.stringify(links)}::text::jsonb where id = ${c.id}`;
		}

		if (b.businessEmailUpdate) {
			const email = b.businessEmailUpdate.delete ? null : String(b.businessEmailUpdate.businessEmail ?? "").trim();
			if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) failed("businessEmailUpdateStatus", "Enter a valid email address.");
			else await sql`update channels set business_email = ${email || null} where id = ${c.id}`;
		}

		for (const kind of ["profile", "banner"] as const) {
			const field = kind === "profile" ? "avatarImageUpdate" : "bannerImageUpdate";
			const u = b[field];
			if (!u) continue;
			const old = kind === "profile" ? c.avatar_path : c.banner_path;
			const rel = u.delete ? null : claimImage(u.encryptedBlobId, kind, viewer);
			if (!u.delete && !rel) {
				failed(`${field}Status`, "Upload the image again.");
				continue;
			}
			if (kind === "profile") await sql`update channels set avatar_path = ${rel} where id = ${c.id}`;
			else await sql`update channels set banner_path = ${rel} where id = ${c.id}`;
			dropFile(old);
		}

		if (typeof b.homeTabUpdate?.enabled === "boolean") await sql`update channels set home_tab_enabled = ${b.homeTabUpdate.enabled} where id = ${c.id}`;
		if (b.shelfListUpdate) {
			const shelves = await cleanShelves(b.shelfListUpdate, c.id);
			if (typeof shelves === "string") failed("shelfListUpdateStatus", shelves);
			else await sql`update channels set home_shelves = ${JSON.stringify(shelves)}::text::jsonb where id = ${c.id}`;
		}

		// the spotlight: { videoId } or { delete } for the trailer, { updateInfo:
		// { videoId, title } } or { delete } for the featured video
		if (b.trailerVideoUpdate) {
			const id = b.trailerVideoUpdate.delete ? null : await spotlightVideo(c.id, b.trailerVideoUpdate.videoId);
			if (id === undefined) failed("trailerVideoUpdateStatus", "Choose one of your public videos.");
			else await sql`update channels set trailer_video_id = ${id} where id = ${c.id}`;
		}
		if (b.featuredVideoUpdate) {
			const info = b.featuredVideoUpdate.updateInfo;
			const id = b.featuredVideoUpdate.delete ? null : await spotlightVideo(c.id, info?.videoId);
			const title = String(info?.title ?? "").trim().slice(0, MAX_TITLE) || null;
			if (id === undefined) failed("featuredVideoUpdateStatus", "Choose one of your public videos.");
			else await sql`update channels set featured_video_id = ${id}, featured_video_title = ${id ? title : null} where id = ${c.id}`;
		}

		for (const [field, key] of UNSTORED) if (b[field]) failed(key, "This instance doesn't save this setting yet.");

		return {
			responseContext: responseContext(viewer),
			channelPageSettingsData: await pageSettings(c.id),
			updatedChannelEntity: await creatorChannel(viewer, null),
			...status,
		};
	},
	{ studio: true, mutation: true },
);
