import { APPEARANCE_HEADERS, isDark } from "./appearance";
import { getViewer } from "./auth";
import { serveClientAsset } from "./client/assets";
import { renderPage } from "./client/page";
import { loadPin } from "./client/store";
import { PORT, PUBLIC_ORIGIN, STUDIO_HOST, STUDIO_ORIGIN, STUDIO_PORT } from "./config";
import { migrate } from "./db";
import { recordMiss, startDiagnostics } from "./diagnostics";
import { addBadges } from "./innertube/badges";
import { innertube } from "./innertube/router";
import "./innertube/watch-routes";
import "./innertube/browse";
import "./innertube/search";
import "./innertube/guide";
import "./innertube/actions";
import "./innertube/playlists";
import "./innertube/comments";
import "./innertube/shorts";
import "./innertube/post-composer";
import { startProcessing } from "./media/process";
import { pruneTransfers, recoverTransfers } from "./studio/upload";
import { thumbnail, videoplayback } from "./media/serve";
import { pageFor } from "./pages";
import { instanceRoutes } from "./instance";
import { studioRoutes } from "./studio";

// Pages may only talk to this origin; anything else is blocked by the
// browser and reported to /_csp, which feeds the diagnostics view.
const CSP = [
	"default-src 'self'",
	"script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' data: blob:",
	"media-src 'self' blob: data:",
	"font-src 'self' data:",
	"connect-src 'self' blob: data:",
	"worker-src 'self' blob:",
	"frame-src 'self'",
	"report-uri /_csp",
].join("; ");

const SECURITY_HEADERS = { "x-content-type-options": "nosniff", "referrer-policy": "strict-origin-when-cross-origin" };

function nonce() {
	return Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");
}

async function handle(req: Request): Promise<Response> {
	const url = new URL(req.url);
	const path = url.pathname;
	if (url.host === STUDIO_HOST) return studioRoutes(req, url, await getViewer(req));
	if (path.startsWith("/s/") || path.startsWith("/_up/")) return (await serveClientAsset(req, url)) ?? new Response("not found", { status: 404 });
	if (path === "/videoplayback") return videoplayback(req, url);
	if (path.startsWith("/vi/") || path.startsWith("/vi_webp/")) return thumbnail(req, url, await getViewer(req));
	// beacons the client sends; nothing to record
	if (/^\/(generate_204|csi_204|ptracking|pagead\/.*|api\/stats\/(qoe|atr|delayplay))$/.test(path)) return new Response(null, { status: 204 });
	if (path === "/error_204") {
		recordMiss(`client error ${url.searchParams.get("msg")?.slice(0, 120) ?? ""}`, url.search.slice(0, 400));
		return new Response(null, { status: 204 });
	}
	if (path === "/_csp") {
		const report = ((await req.json().catch(() => ({}))) as { "csp-report"?: Record<string, unknown> })["csp-report"] ?? {};
		const blocked = String(report["blocked-uri"] ?? "?");
		const where = `${String(report["source-file"] ?? "").replace(/^https?:\/\/[^/]+/, "").slice(0, 120)}:${report["line-number"] ?? ""}:${report["column-number"] ?? ""}`;
		recordMiss(`csp blocked ${blocked.replace(/^(https?:\/\/[^/]+).*/, "$1")}`, `${blocked.split("?")[0].slice(0, 200)} (${report["effective-directive"] ?? report["violated-directive"]}) from ${where}`);
		return new Response(null, { status: 204 });
	}
	const viewer = await getViewer(req);
	if (path.startsWith("/youtubei/v1/")) return innertube(req, url, viewer);
	// the signed-in accounts' datasync ids, which the client keys its local storage by (as DATASYNC_ID)
	if (path === "/getDatasyncIdsEndpoint") return Response.json({ datasyncIds: viewer ? [`${viewer.channelId}||`] : [] }, { headers: { "cache-control": "no-store" } });
	const own = await instanceRoutes(req, url, viewer);
	if (own) return own;
	if (req.method !== "GET" && req.method !== "HEAD") return new Response("method not allowed", { status: 405 });
	const page = await pageFor(url, viewer);
	if (page instanceof Response) return page;
	if (!page) {
		recordMiss(`page ${path.replace(/\/[A-Za-z0-9_-]{11,}/g, "/*")}`, path);
		return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
	}
	await addBadges(page.initialData);
	const n = nonce();
	return new Response(renderPage(page, viewer, n, isDark(req)), {
		headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": CSP, ...SECURITY_HEADERS, ...APPEARANCE_HEADERS },
	});
}

if (!loadPin()) console.warn("no client pinned yet: run `bun scripts/fetch-client.ts` before opening the site");
await migrate();
startDiagnostics();
if (process.env.NO_WORKER !== "1") {
	await startProcessing();
	void pruneTransfers();
	setInterval(() => void pruneTransfers(), 3600_000);
	// uploads whose file never reached their video
	void recoverTransfers();
	setInterval(() => void recoverTransfers(), 60_000);
}

const serveOptions = {
	idleTimeout: 120,
	maxRequestBodySize: Number(process.env.MAX_UPLOAD_BYTES ?? 2 * 1024 ** 3),
	async fetch(req: Request) {
		const started = performance.now();
		try {
			const res = await handle(req);
			if (process.env.LOG_REQUESTS) {
				const u = new URL(req.url);
				console.log(`${res.status} ${req.method} ${u.host === STUDIO_HOST ? "studio " : ""}${u.pathname}${u.pathname === "/videoplayback" ? u.search.replace(/&sig=[^&]*/, "") : ""} ${(performance.now() - started).toFixed(0)}ms`);
			}
			return res;
		} catch (e) {
			console.error(`${req.method} ${req.url} failed`, e);
			return new Response("internal error", { status: 500 });
		}
	},
};

Bun.serve({ port: PORT, ...serveOptions });
// YouTube Studio's origin; requests are told apart by Host, so a reverse
// proxy may send both hostnames to either port
if (STUDIO_PORT !== PORT) Bun.serve({ port: STUDIO_PORT, ...serveOptions });
console.log(`YewTube listening on ${PUBLIC_ORIGIN} (port ${PORT}); Studio on ${STUDIO_ORIGIN} (port ${STUDIO_PORT})`);
