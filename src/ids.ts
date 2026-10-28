// Identifiers in the formats the client expects: 11-character video ids,
// UC-prefixed 24-character channel ids, PL-prefixed playlist ids.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function randomId(len: number): string {
	const bytes = randomBytes(len);
	let s = "";
	for (let i = 0; i < len; i++) s += ALPHABET[bytes[i] & 63];
	return s;
}

export const newVideoId = () => randomId(11);
export const newChannelId = () => `UC${randomId(22)}`;
export const newPlaylistId = () => `PL${randomId(32)}`;
export const newCommentId = () => `Ug${randomId(24)}`;
// posts have YouTube's post id shape, so they fit its protobuf blobs
export const newPostId = () => `Ugkx${randomId(32)}`;
export const newToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

export const isVideoId = (s: unknown): s is string => typeof s === "string" && /^[A-Za-z0-9_-]{11}$/.test(s);
export const isChannelId = (s: unknown): s is string => typeof s === "string" && /^UC[A-Za-z0-9_-]{22}$/.test(s);
export const isPostId = (s: unknown): s is string => typeof s === "string" && /^Ugkx[A-Za-z0-9_-]{32}$/.test(s);
export const isPlaylistId = (s: unknown): s is string => typeof s === "string" && (/^PL[A-Za-z0-9_-]{32}$/.test(s) || s === "WL" || s === "LL");

// instance secret for signing media URLs and opaque tokens; generated on
// first start unless INSTANCE_SECRET is set
let secret: Buffer | undefined;
export function instanceSecret(): Buffer {
	if (secret) return secret;
	if (process.env.INSTANCE_SECRET) secret = Buffer.from(process.env.INSTANCE_SECRET);
	else {
		const file = "data/instance-secret";
		if (!existsSync(file)) {
			mkdirSync("data", { recursive: true });
			writeFileSync(file, randomBytes(32).toString("hex"), { mode: 0o600 });
		}
		secret = Buffer.from(readFileSync(file, "utf8").trim());
	}
	return secret;
}

export function sign(payload: string): string {
	return createHmac("sha256", instanceSecret()).update(payload).digest("base64url").slice(0, 32);
}

export function verify(payload: string, sig: string): boolean {
	const want = Buffer.from(sign(payload));
	const got = Buffer.from(sig);
	return want.length === got.length && timingSafeEqual(want, got);
}

// opaque continuation tokens / params: signed JSON, base64url
export function encodeToken(data: unknown): string {
	const body = Buffer.from(JSON.stringify(data)).toString("base64url");
	return `${body}.${sign(`tok.${body}`).slice(0, 16)}`;
}

export function decodeToken<T>(token: unknown): T | undefined {
	if (typeof token !== "string") return undefined;
	const clean = decodeURIComponent(token);
	const dot = clean.lastIndexOf(".");
	if (dot < 0) return undefined;
	const body = clean.slice(0, dot);
	if (sign(`tok.${body}`).slice(0, 16) !== clean.slice(dot + 1)) return undefined;
	try {
		return JSON.parse(Buffer.from(body, "base64url").toString());
	} catch {
		return undefined;
	}
}
