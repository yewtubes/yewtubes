// Studio's image uploads (a video's custom thumbnail at
// UPLOAD_CONFIG.thumbnailsScottyUrl, the channel's picture and banner at
// /channel_image_upload/...) use the same resumable Scotty protocol as video
// uploads (upload.ts): a start request with "{}" as the metadata, then the
// bytes, then a final response whose JSON names the upload for the save
// that follows. A plain POST of the image is taken in one go too.
//
// Transfers are files under MEDIA_DIR/uploads, named by the signed upload id;
// what the finished transfer answered is kept beside it for a repeated query.

import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Viewer } from "../client/page";
import { MEDIA_DIR, STUDIO_ORIGIN } from "../config";
import { decodeToken, encodeToken, randomId } from "../ids";
import { rateLimit } from "../ratelimit";

const DIR = join(MEDIA_DIR, "uploads");
const GRANULARITY = 256 * 1024;
const DAY = 86_400_000;

export type ImageType = "jpg" | "png" | "gif" | "bmp" | "webp";
export function imageType(b: Uint8Array): ImageType | undefined {
	const hex = Buffer.from(b.subarray(0, 12)).toString("hex");
	if (hex.startsWith("ffd8ff")) return "jpg";
	if (hex.startsWith("89504e470d0a1a0a")) return "png";
	if (hex.startsWith("47494638")) return "gif";
	if (hex.startsWith("424d")) return "bmp";
	if (hex.startsWith("52494646") && hex.slice(16, 24) === "57454250") return "webp";
	return undefined;
}

function reply(status: number, state: string, extra: Record<string, string> = {}, body?: unknown): Response {
	return new Response(body === undefined ? null : JSON.stringify(body), {
		status,
		headers: { "x-goog-upload-status": state, "cache-control": "no-store", ...(body === undefined ? {} : { "content-type": "application/json; charset=utf-8" }), ...extra },
	});
}

const failed = (status: number, message: string) => reply(status, "final", {}, { status: "STATUS_FAILURE", errorMessage: message, error: { code: status, message } });

export type ImageUpload = {
	// what the upload is for, part of its rate limit key
	purpose: string;
	limit: number;
	// the page origin allowed to send it (Studio's unless given)
	origin?: string;
	// takes the image, returns the final response's JSON (or an error message)
	finish: (bytes: Uint8Array, type: ImageType) => Promise<Record<string, unknown> | string>;
};

// a transfer's id names its user, path and file
type Id = { s: 7; u: string; p: string; f: string };

export async function imageTransfer(req: Request, url: URL, viewer: Viewer, opts: ImageUpload): Promise<Response> {
	if (req.method !== "POST" && req.method !== "PUT") return failed(405, "method not allowed");
	if (!viewer) return failed(401, "Sign in to upload.");
	// cookies authenticate the uploader, so only the uploading pages' own origin may use it
	const allowed = opts.origin ?? STUDIO_ORIGIN;
	const origin = req.headers.get("origin");
	if (origin && origin !== allowed) return failed(403, "Uploads come from this site's own pages.");
	const channel = req.headers.get("x-youtube-channelid");
	if (channel && channel !== viewer.channelId) return failed(403, "You can only change your own channel.");
	const command = (req.headers.get("x-goog-upload-command") ?? "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
	const uploadId = url.searchParams.get("upload_id");
	const tooLarge = () => failed(413, `Images are limited to ${Math.round(opts.limit / 1024 ** 2)} MB.`);
	// a file that isn't a usable image is a finished transfer that failed: a
	// 200 without an id, which the uploader reports rather than retries
	const finish = async (bytes: Uint8Array) => {
		const type = imageType(bytes);
		if (!type) return { status: 200, body: { status: "STATUS_FAILURE", errorMessage: "Use a JPG, PNG, GIF, BMP or WebP image." } };
		const out = await opts.finish(bytes, type).catch((e) => (e instanceof Error ? e.message : String(e)));
		if (typeof out === "string") return { status: 200, body: { status: "STATUS_FAILURE", errorMessage: out } };
		return { status: 200, body: { status: "STATUS_SUCCESS", ...out } };
	};

	mkdirSync(DIR, { recursive: true });
	if (!uploadId) {
		if (!(await rateLimit(`image-upload:${opts.purpose}:${viewer.userId}`, 60, 3600))) return failed(429, "Too many uploads. Try again later.");
		// transfers never finished are dropped after a day
		for (const f of readdirSync(DIR)) if (Date.now() - statSync(join(DIR, f)).mtimeMs > DAY) rmSync(join(DIR, f), { force: true });
		if (!command.length) {
			// the whole image in one request
			if (Number(req.headers.get("content-length") ?? 0) > opts.limit) return tooLarge();
			const bytes = new Uint8Array(await req.arrayBuffer());
			if (bytes.length > opts.limit) return tooLarge();
			const r = await finish(bytes);
			return Response.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });
		}
		if (!command.includes("start")) return failed(400, "Start a resumable upload first.");
		const declared = Number(req.headers.get("x-goog-upload-header-content-length") ?? req.headers.get("x-goog-upload-content-length") ?? Number.NaN);
		if (Number.isFinite(declared) && declared > opts.limit) return tooLarge();
		const id = encodeToken({ s: 7, u: viewer.userId, p: url.pathname, f: randomId(16) } satisfies Id);
		await Bun.write(join(DIR, `${(decodeToken<Id>(id) as Id).f}.part`), "");
		const at = `${allowed}${url.pathname}?upload_id=${encodeURIComponent(id)}&upload_protocol=resumable`;
		return reply(200, "active", { "x-goog-upload-url": at, "x-goog-upload-control-url": at, "x-goog-upload-chunk-granularity": String(GRANULARITY), "x-guploader-uploadid": id });
	}

	const t = decodeToken<Id>(uploadId);
	if (t?.s !== 7 || t.u !== viewer.userId || t.p !== url.pathname || !/^[\w-]{16}$/.test(String(t.f))) return failed(404, "No such upload.");
	const part = join(DIR, `${t.f}.part`);
	const result = join(DIR, `${t.f}.json`);
	if (existsSync(result)) {
		const r = await Bun.file(result).json();
		return reply(r.status, "final", {}, r.body);
	}
	if (!existsSync(part)) return failed(404, "No such upload.");
	const received = statSync(part).size;
	if (command.includes("query")) return reply(200, "active", { "x-goog-upload-size-received": String(received) });
	if (command.includes("cancel")) {
		rmSync(part, { force: true });
		return reply(200, "cancelled");
	}
	if (!command.includes("upload")) return failed(400, "Unknown upload command.");
	// anything but the next byte: the uploader asks where to go on
	if (Number(req.headers.get("x-goog-upload-offset")) !== received) return reply(400, "active");
	const chunk = new Uint8Array(await req.arrayBuffer());
	const done = command.includes("finalize");
	if (!done && chunk.byteLength % GRANULARITY) return reply(400, "active");
	if (received + chunk.byteLength > opts.limit) {
		rmSync(part, { force: true });
		return tooLarge();
	}
	appendFileSync(part, chunk);
	if (!done) return reply(200, "active");
	const r = await finish(new Uint8Array(await Bun.file(part).arrayBuffer()));
	rmSync(part, { force: true });
	await Bun.write(result, JSON.stringify(r));
	return reply(r.status, "final", {}, r.body);
}
