// Builds src/innertube/templates/*.json from private captures of youtube.com
// (captures/, gitignored; see scripts/research/capture.ts).
//
// Each template is a real response, or part of one, reduced to what the
// builders need: tracking fields dropped, lists cut to one sample per kind,
// and the sample's own values (ids, names, counts, images, links) replaced by
// {{TOKENS}} that src/innertube/tpl.ts fills. The run fails if a sample value,
// a Google media/image/account URL, or a personal value from a signed-in
// capture survives, so templates are safe to commit.
//
//   bun scripts/make-templates.ts

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decode, fromBase64, str } from "../src/innertube/proto";

const CAP = "captures";
const OUT = "src/innertube/templates";
mkdirSync(OUT, { recursive: true });

// ---------- loading ----------
function body(dir: string, match: RegExp): string {
	const d = join(CAP, dir, "bodies");
	const f = readdirSync(d)
		.filter((n) => n.endsWith(".resp") && match.test(n))
		.sort()[0];
	if (!f) throw new Error(`no ${match} in ${d}`);
	return readFileSync(join(d, f), "utf8");
}
// every response in a capture whose request matches; [request, response]
function bodies(dir: string, match: RegExp): [any, any][] {
	const d = join(CAP, dir, "bodies");
	return readdirSync(d)
		.filter((n) => n.endsWith(".resp") && match.test(n))
		.sort()
		.map((n) => [JSON.parse(readFileSync(join(d, n.replace(/\.resp$/, ".req.json")), "utf8")), JSON.parse(readFileSync(join(d, n), "utf8"))]);
}
function pageVar(html: string, name = "ytInitialData"): any {
	// newer builds carry ytInitialData as a JSON script element
	if (name === "ytInitialData") {
		const m = /<script id="yt-initial-data" type="application\/json"[^>]*>/.exec(html);
		if (m) return JSON.parse(html.slice(m.index + m[0].length, html.indexOf("</script>", m.index)));
	}
	const at = html.indexOf(`var ${name} = `);
	if (at < 0) throw new Error(`no ${name}`);
	const start = at + `var ${name} = `.length;
	// the JSON ends where the statement does
	let depth = 0;
	let inStr = false;
	for (let i = start; i < html.length; i++) {
		const c = html[i];
		if (inStr) {
			if (c === "\\") i++;
			else if (c === '"') inStr = false;
		} else if (c === '"') inStr = true;
		else if (c === "{" || c === "[") depth++;
		else if (c === "}" || c === "]") {
			if (--depth === 0) return JSON.parse(html.slice(start, i + 1));
		}
	}
	throw new Error("unterminated");
}

// ---------- reduction ----------
const DROP = new Set(["trackingParams", "clickTrackingParams", "loggingDirectives", "visitorData", "watchEndpointSupportedOnesieConfig", "serviceTrackingParams", "adSignalsInfo", "responseContext"]);
export function clean(o: any): any {
	if (Array.isArray(o)) return o.map(clean);
	if (o && typeof o === "object") return Object.fromEntries(Object.entries(o).filter(([k]) => !DROP.has(k)).map(([k, v]) => [k, clean(v)]));
	return o;
}
export function strings(o: any, fn: (s: string) => string): any {
	if (typeof o === "string") return fn(o);
	if (Array.isArray(o)) return o.map((x) => strings(x, fn));
	if (o && typeof o === "object") return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, strings(v, fn)]));
	return o;
}
export function holder(o: any, key: string, pred: (v: any) => boolean = () => true): any {
	if (!o || typeof o !== "object") return undefined;
	if (!Array.isArray(o) && key in o && pred(o[key])) return o;
	for (const v of Array.isArray(o) ? o : Object.values(o)) {
		const h = holder(v, key, pred);
		if (h) return h;
	}
	return undefined;
}
export const find = (o: any, key: string, pred?: (v: any) => boolean) => holder(o, key, pred)?.[key];
export function findAll(o: any, key: string, out: any[] = []): any[] {
	if (!o || typeof o !== "object") return out;
	if (!Array.isArray(o) && key in o) out.push(o[key]);
	for (const v of Array.isArray(o) ? o : Object.values(o)) findAll(v, key, out);
	return out;
}
// removes every object property `key` (deep)
export function dropKey(o: any, key: string): any {
	if (Array.isArray(o)) return o.map((x) => dropKey(x, key));
	if (o && typeof o === "object") return Object.fromEntries(Object.entries(o).filter(([k]) => k !== key).map(([k, v]) => [k, dropKey(v, key)]));
	return o;
}
// removes array elements matching pred (deep)
export function dropItems(o: any, pred: (x: any) => boolean): any {
	if (Array.isArray(o)) return o.filter((x) => !pred(x)).map((x) => dropItems(x, pred));
	if (o && typeof o === "object") return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, dropItems(v, pred)]));
	return o;
}

// values every template gets rid of
const GLOBAL: [RegExp, string][] = [
	[/https:\/\/accounts\.google\.com\/ServiceLogin\?[^"\s]*/g, "{{SIGNIN_URL}}"],
	[/https?:\/\/www\.gstatic\.com\//g, "{{ORIGIN}}/_up/www.gstatic.com/"],
	[/https:\/\/studio\.youtube\.com/g, "{{STUDIO_ORIGIN}}"],
	[/https?:\/\/www\.youtube\.com(?=[/"?]|$)/g, "{{ORIGIN}}"],
];
const assets = new Set<string>();
// blank characters for ids inside base64 blobs (as tpl.ts refills them)
const BLANKS = ["~", "^", "`"];

// Replace sample values by tokens. `ids` are ids whose entity keys may appear
// (base64 protobuf with the id in field 2) -> {{ek:TOKEN:type}}.
// `exact` values are replaced only where a whole string equals them (short
// values such as "2014" or "23M" that also occur inside other strings)
export function tokenize(o: any, pairs: [string, string][], ids: [string, string][] = [], exact: [string, string][] = []): any {
	const sorted = pairs.filter(([from]) => from).sort((a, b) => b[0].length - a[0].length);
	return strings(o, (s) => {
		const whole = exact.find(([from]) => from && s === from);
		if (whole) return `{{${whole[1]}}}`;
		for (const m of s.matchAll(/https:\/\/www\.gstatic\.com\/[^"\s]+/g)) assets.add(m[0]);
		if (ids.length && /^[A-Za-z0-9+/_-]{12,}(%3D|=){0,2}$/.test(s)) {
			try {
				const f = decode(fromBase64(s));
				const id = str(f.get(2)?.[0]);
				const type = f.get(4)?.[0];
				const hit = ids.find(([v]) => v === id);
				if (hit && typeof type === "number" && f.get(5)?.[0] === 1 && f.size === 3) return `{{ek:${hit[1]}:${type}}}`;
			} catch {}
		}
		// ids inside other base64 protobuf blobs (panel params, share entities,
		// notification preferences): blank the id with '~' and let fill() put
		// ours back (ids have fixed lengths)
		if (ids.length && /^[A-Za-z0-9+/_-]{12,}(%3D|=){0,2}$/.test(s)) {
			const b = b64bytes(s);
			if (b) {
				let latin = Buffer.from(b).toString("latin1");
				const hits = ids.filter(([v]) => latin.includes(v));
				if (hits.length && hits.length <= BLANKS.length) {
					// each id blanked with its own character, in the order of the names
					hits.forEach(([v], i) => (latin = latin.split(v).join(BLANKS[i].repeat(v.length))));
					return `{{b64:${hits.map(([, n]) => n).join("+")}:${b64style(s, Buffer.from(latin, "latin1"))}}}`;
				}
			}
		}
		if (sorted.some(([from]) => s === from)) return `{{${sorted.find(([from]) => s === from)![1]}}}`;
		for (const [from, to] of sorted) s = s.split(from).join(`{{${to}}}`);
		for (const [re, to] of GLOBAL) s = s.replace(re, to);
		return s;
	});
}
function b64bytes(s: string): Uint8Array | undefined {
	try {
		const b = fromBase64(s);
		return b.length >= 8 ? b : undefined;
	} catch {
		return undefined;
	}
}
// re-encode in the same style as the original string (url-safe or not, %3D or = padding)
export function b64style(orig: string, bytes: Uint8Array): string {
	let out = Buffer.from(bytes).toString("base64");
	if (/[-_]/.test(orig)) out = out.replace(/\+/g, "-").replace(/\//g, "_");
	if (/%3D/.test(orig)) out = out.replace(/=/g, "%3D");
	else if (!/=$/.test(orig)) out = out.replace(/=+$/, "");
	return out;
}
// sets a whole-value token at every `key` (e.g. image "sources") under node
export function wholeToken(node: any, key: string, token: string, pred: (holderObj: any) => boolean = () => true) {
	const walk = (o: any) => {
		if (!o || typeof o !== "object") return;
		if (!Array.isArray(o) && key in o && pred(o)) o[key] = `{{${token}}}`;
		for (const v of Array.isArray(o) ? o : Object.values(o)) walk(v);
	};
	walk(node);
	return node;
}

// ---------- safety ----------
const FORBIDDEN_HOSTS = /googlevideo\.com|ytimg\.com|ggpht\.com|googleusercontent\.com|encrypted-tbn\d?\.gstatic\.com|accounts\.google\.com|doubleclick\.net|\/\/www\.youtube\.com|\/\/youtube\.com|studio\.youtube\.com/;
const personal: string[] = [];
const written: string[] = [];
// a run from the start of a text that is a single token covered the whole
// sample text; it covers the whole of ours ({{len:NAME}}, filled by tpl.ts)
function tokenRunLengths(o: any) {
	if (!o || typeof o !== "object") return;
	const token = typeof o.content === "string" ? /^\{\{([A-Z0-9_]+)\}\}$/.exec(o.content)?.[1] : undefined;
	if (token)
		for (const k of ["commandRuns", "styleRuns"])
			for (const r of Array.isArray(o[k]) ? o[k] : []) if (!r.startIndex && typeof r.length === "number") r.length = `{{len:${token}}}`;
	for (const v of Object.values(o)) tokenRunLengths(v);
}

function save(name: string, data: unknown, samples: string[] = []) {
	tokenRunLengths(data);
	// a duration badge carries YouTube's music note for Music videos
	// (DURATION_ICON, left out of the response when unset)
	for (const b of findAll(data, "thumbnailBadgeViewModel")) if (b.text === "{{DURATION}}" && !b.icon) Object.assign(b, { icon: "{{DURATION_ICON}}", ...b });
	const text = JSON.stringify(data);
	const bad: string[] = [];
	const host = FORBIDDEN_HOSTS.exec(text);
	if (host) bad.push(`host ${host[0]} near ${text.slice(Math.max(0, host.index - 120), host.index + 80)}`);
	const decoded = [...text.matchAll(/"([A-Za-z0-9+/_-]{12,}(?:%3D|=){0,2})"/g)].map((m) => {
		const b = b64bytes(m[1]);
		return b ? Buffer.from(b).toString("latin1") : "";
	}).join("\n");
	for (const s of samples) if (s && s.length >= 8 && decoded.includes(s)) bad.push(`value ${JSON.stringify(s)} inside a base64 blob`);
	// personal values are reported by position only
	// short values (a first name) count as whole words only: "Haryanvi" is a language
	const hit = (s: string) => (s.length >= 8 ? text.includes(s) || decoded.includes(s) : new RegExp(`(?<![A-Za-z0-9])${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9])`).test(text));
	for (const s of personal) if (s && hit(s)) bad.push(`a personal value from the signed-in capture at offset ${text.indexOf(s)}`);
	const email = /[\w.+-]+@[\w-]+(\.[\w-]+)*\.[a-z]{2,}/i.exec(text);
	if (email) bad.push(`an email address at offset ${email.index}`);
	for (const s of samples) if (s && text.includes(s)) bad.push(`value ${JSON.stringify(s)} near ${text.slice(Math.max(0, text.indexOf(s) - 120), text.indexOf(s) + 60)}`);
	if (bad.length) throw new Error(`template ${name} not clean:\n  ${bad.join("\n  ")}`);
	const file = join(OUT, `${name}.json`);
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, JSON.stringify(data, null, "\t") + "\n");
	written.push(`${name} (${(text.length / 1024).toFixed(1)} KB)`);
}

// ---------- shared item tokenizers ----------
const contentOf = (t: any): string => t?.content ?? t?.simpleText ?? (t?.runs ?? []).map((r: any) => r.text).join("") ?? "";

// a video lockupViewModel (grid, shelf, related, home); returns the template
// and the sample values it replaced
export function videoLockup(sample: any) {
	const lv = find(sample, "lockupViewModel");
	const id: string = lv.contentId;
	const meta = lv.metadata.lockupMetadataViewModel;
	const title = contentOf(meta.title);
	const badge = find(lv.contentImage, "thumbnailBadgeViewModel");
	const parts: any[] = findAll(meta.metadata, "metadataParts").flat();
	const pairs: [string, string][] = [
		[id, "VIDEO_ID"],
		[title, "TITLE"],
		[badge?.text, "DURATION"],
		[badge?.rendererContext?.accessibilityContext?.label, "DURATION_LABEL"],
	];
	const samples = [id, title];
	let item = clean(sample);
	// channel row (absent on a channel's own grid)
	const chanEndpoint = find(lv, "browseEndpoint", (b) => /^UC/.test(b.browseId ?? ""));
	if (chanEndpoint) {
		pairs.push([chanEndpoint.browseId, "CHANNEL_ID"], [chanEndpoint.canonicalBaseUrl, "CHANNEL_URL"]);
		samples.push(chanEndpoint.browseId);
	}
	const goTo = /^Go to channel (.+)$/.exec(find(lv, "a11yLabel", (v) => /^Go to channel /.test(v)) ?? "");
	if (goTo) {
		pairs.push([goTo[1], "CHANNEL_NAME"]);
		samples.push(goTo[1]);
	}
	for (const p of parts) {
		const t = contentOf(p.text);
		const l: string = p.accessibilityLabel ?? "";
		if (/ views?$/.test(l) || / views?$/.test(t) || p.leadingIcon?.name === "PLAY_ARROW_OUTLINED") pairs.push([t, "VIEWS"], [l, "VIEWS_LABEL"]);
		else if (/ ago$/.test(t)) pairs.push([t, "PUBLISHED"], [l, "PUBLISHED_LABEL"]);
		else if (t && !pairs.some(([, k]) => k === "CHANNEL_NAME")) {
			pairs.push([t, "CHANNEL_NAME"]);
			samples.push(t);
		}
	}
	// no animated previews here; verified marks belong to YouTube's channels
	item = dropKey(item, "animatedThumbnailOverlayViewModel");
	item = dropItems(item, (x) => x && typeof x === "object" && "animatedThumbnailOverlayViewModel" in x);
	item = strings(item, (s) => s);
	const fixParts = (o: any) => {
		for (const ps of findAll(o, "metadataParts")) for (const p of ps) if (p.icon?.name === "CHECK_CIRCLE_FILLED") delete p.icon;
	};
	fixParts(item);
	// badges (CC, New, 4K) describe the sample video, not ours
	for (const rows of findAll(item, "metadataRows")) for (let i = rows.length - 1; i >= 0; i--) if (rows[i].badges) rows.splice(i, 1);
	const thumb = find(item, "contentImage");
	wholeToken(thumb, "sources", "THUMBS", (h) => Array.isArray(h.sources) && h.sources.some((s: any) => /ytimg/.test(s.url ?? "")));
	wholeToken(find(item, "decoratedAvatarViewModel") ?? {}, "sources", "AVATAR");
	const idList: [string, string][] = [[id, "VIDEO_ID"]];
	if (chanEndpoint) idList.push([chanEndpoint.browseId, "CHANNEL_ID"]);
	// player params YouTube attached for its recommendation context
	item = dropKey(item, "playerParams");
	let out = tokenize(item, pairs, idList);
	out = strings(out, (x) =>
		x
			.replace(/&pp=[^&"]*/, "")
			// the lockup's label: title and duration (YouTube drops seconds past an hour)
			.replace(/^\{\{TITLE\}\} \d+ (hours?|minutes?|seconds?)\b.*$/, "{{TITLE}} {{DURATION_LABEL}}"),
	);
	return { item: out, samples };
}

// the first array element under `listKey` that contains `key`
const sampleOf = (o: any, key: string, pred: (x: any) => boolean = () => true) => holder(o, key, pred);

// home's chip bar: YouTube's feedFilterChipBarRenderer, its chips (the
// selected one and one that reloads the grid by continuation) filled in by
// feeds.ts
function homeChips() {
	const bar = clean(structuredClone(gridOf(pageVar(body("in-home", /^001-/))).header));
	const chips: any[] = bar.feedFilterChipBarRenderer.contents;
	const chip = (name: string) => chips.find((c) => c.chipCloudChipRenderer.text.runs[0].text === name);
	const selected = chip("All");
	save("item/home_chip_selected", tokenize(selected, [["All", "TEXT"]]));
	const other = chip("Recently uploaded");
	find(other, "continuationCommand").token = "{{TOKEN}}";
	save("item/home_chip", tokenize(other, [["Recently uploaded", "TEXT"]]));
	bar.feedFilterChipBarRenderer.contents = "{{CHIPS}}";
	save("home/chip_bar", tokenize(bar, []));
}

// a channel's Shorts tab: YouTube's Shorts grid with its Latest/Popular/Oldest
// chips (the items are item/shorts_lockup_rich, filled in by channel.ts)
function channelShorts() {
	const page = pageVar(body("site-in", /^116-/));
	const tab = page.contents.twoColumnBrowseResultsRenderer.tabs.find((t: any) => t.tabRenderer?.selected).tabRenderer;
	const grid = clean(tab.content.richGridRenderer);
	for (const c of find(grid.header, "chipBarViewModel").chips) {
		const label = c.chipViewModel.text.toUpperCase();
		find(c, "continuationCommand").token = `{{SORT_${label}}}`;
		find(c, "showReloadUiCommand").targetId = "{{TARGET_ID}}";
		c.chipViewModel.selected = `{{SELECTED_${label}}}`;
	}
	grid.contents = "{{ITEMS}}";
	grid.targetId = "{{TARGET_ID}}";
	save("channel/shorts_grid", tokenize(grid, []));

	// Home's Shorts shelf (its feedback menu left out); its items are the
	// lockups of item/shorts_lockup_rich without the grid item around them
	const home = pageVar(body("channel-about", /^001-/));
	const sections = home.contents.twoColumnBrowseResultsRenderer.tabs.find((t: any) => t.tabRenderer?.selected).tabRenderer.content.sectionListRenderer.contents;
	const shelf = clean(structuredClone(sections.find((x: any) => find(x, "reelShelfRenderer"))));
	const reel = find(shelf, "reelShelfRenderer");
	delete reel.button;
	reel.items = "{{ITEMS}}";
	save("channel/shorts_shelf", tokenize(shelf, []));
}

// ======================================================================
// channel
// ======================================================================
function channel() {
	const page = pageVar(body("channel2", /^001-/));
	const header = page.header.pageHeaderRenderer;
	const ph = header.content.pageHeaderViewModel;
	const id: string = page.metadata.channelMetadataRenderer.externalId;
	const name: string = page.metadata.channelMetadataRenderer.title;
	const handle: string = page.metadata.channelMetadataRenderer.vanityChannelUrl.split("/@")[1];
	const desc: string = page.metadata.channelMetadataRenderer.description;
	const rows = ph.metadata.contentMetadataViewModel.metadataRows;
	const subs = rows[1].metadataParts[0];
	const vids = rows[1].metadataParts[1];
	const samples = [id, name, handle, "Blender", desc.slice(0, 40)];
	const ids: [string, string][] = [[id, "CHANNEL_ID"]];
	const channelPairs = (): [string, string][] => [
		[id, "CHANNEL_ID"],
		[`@${handle}`, "AT_HANDLE"],
		[handle, "HANDLE"],
		[name, "CHANNEL_NAME"],
		[desc, "DESCRIPTION"],
		[desc.trim(), "DESCRIPTION"],
		[contentOf(subs.text), "SUBSCRIBERS"],
		[subs.accessibilityLabel, "SUBSCRIBERS_LABEL"],
		[contentOf(vids.text), "VIDEO_COUNT"],
	];

	// --- header (signed out) ---
	let h = clean(header);
	const t = h.content.pageHeaderViewModel.title.dynamicTextViewModel;
	delete t.text.styleRuns;
	delete t.text.attachmentRuns; // the verified mark
	t.rendererContext.accessibilityContext.label = name;
	const d = h.content.pageHeaderViewModel.description.descriptionPreviewViewModel;
	d.rendererContext.accessibilityContext.label = "{{DESCRIPTION_LABEL}}";
	h.content.pageHeaderViewModel.metadata.contentMetadataViewModel.metadataRows[1].metadataParts[1].text.styleRuns[0].length = "{{VIDEO_COUNT_LENGTH}}";
	// the About panel loads through a continuation
	const aboutCont = find(d, "continuationCommand");
	aboutCont.token = "{{ABOUT_CONTINUATION}}";
	// the About content is appended to the panel's item section by its id
	const aboutSection = find(d, "itemSectionRenderer");
	aboutSection.sectionIdentifier = aboutSection.targetId = "{{ABOUT_TARGET}}";
	// header link: first custom link of the channel
	const attr = h.content.pageHeaderViewModel.attribution.attributionViewModel;
	attr.text.content = " {{LINK_TEXT}}";
	attr.text.commandRuns[0].length = "{{LINK_TEXT_LENGTH}}";
	const linkCmd = attr.text.commandRuns[0].onTap.innertubeCommand;
	linkCmd.commandMetadata.webCommandMetadata.url = "{{LINK_URL}}";
	linkCmd.urlEndpoint.url = "{{LINK_URL}}";
	// subscribe (signed out): sign-in modal
	const signIn = find(h, "signInEndpoint");
	delete signIn.continueAction;
	delete signIn.idamTag;
	wholeToken(h.content.pageHeaderViewModel.image, "sources", "AVATAR");
	wholeToken(h.content.pageHeaderViewModel.banner, "sources", "BANNER");
	save("channel/header", tokenize(h, channelPairs(), ids), samples);

	// --- page skeleton: tabs, metadata, microformat ---
	const tabs = page.contents.twoColumnBrowseResultsRenderer.tabs;
	const tabTpl: Record<string, any> = {};
	for (const tab of tabs) {
		const k = Object.keys(tab)[0];
		const r = clean(tab[k]);
		delete r.content;
		delete r.selected;
		const tabName = r.endpoint.commandMetadata.webCommandMetadata.url.split("/").pop();
		tabTpl[tabName] = tokenize({ [k]: r }, channelPairs(), ids);
	}
	const metadata = clean(page.metadata);
	const md = metadata.channelMetadataRenderer;
	md.keywords = "{{KEYWORDS}}";
	md.avatar.thumbnails = "{{AVATAR_900}}";
	md.availableCountryCodes = [];
	delete md.androidDeepLink;
	delete md.androidAppindexingLink;
	delete md.iosAppindexingLink;
	md.ownerUrls = ["{{ORIGIN}}/@{{HANDLE}}"];
	const micro = clean(page.microformat);
	const mf = micro.microformatDataRenderer;
	mf.thumbnail.thumbnails = "{{AVATAR_200}}";
	delete mf.appName;
	delete mf.androidPackage;
	delete mf.iosAppStoreId;
	delete mf.iosAppArguments;
	delete mf.ogType;
	for (const k of Object.keys(mf)) if (/^(urlApplinks|urlTwitter|twitter|linkAlternates|unlisted)/.test(k)) delete mf[k];
	mf.tags = [];
	mf.availableCountries = [];
	if (mf.linkAlternates) delete mf.linkAlternates;
	const microT = strings(micro, (s) => (/googleusercontent\.com|ggpht\.com/.test(s) ? "{{AVATAR_URL}}" : s));
	save("channel/page", tokenize({ tabs: tabTpl, metadata, microformat: microT }, [...channelPairs(), [mf.description, "DESCRIPTION_SHORT"]], ids), samples);

	// --- videos tab: grid with Latest/Popular/Oldest chips ---
	const videosTab = tabs.find((x: any) => x.tabRenderer?.selected).tabRenderer;
	const grid = clean(videosTab.content.richGridRenderer);
	const chips = find(grid.header, "chipBarViewModel").chips;
	for (const c of chips) {
		const label = c.chipViewModel.text.toUpperCase();
		find(c, "continuationCommand").token = `{{SORT_${label}}}`;
		c.chipViewModel.selected = `{{SELECTED_${label}}}`;
	}
	const firstItem = grid.contents.find((x: any) => x.richItemRenderer && findAll(x, "metadataParts").flat().length <= 2);
	const lockup = videoLockup(firstItem);
	save("item/video_lockup_channel", lockup.item, [...lockup.samples, ...samples]);
	const contItem = grid.contents.find((x: any) => x.continuationItemRenderer);
	find(contItem, "continuationCommand").token = "{{CONTINUATION}}";
	save("item/continuation", tokenize(contItem, []), samples);
	grid.contents = "{{ITEMS}}";
	grid.targetId = "{{TARGET_ID}}";
	save("channel/videos_grid", tokenize(grid, channelPairs(), ids), samples);

	// --- continuation envelopes for the grid ---
	const [[, reload]] = bodies("channel2", /browse/).filter(([req, res]) => req.post?.continuation && res.onResponseReceivedActions?.[0]?.reloadContinuationItemsCommand);
	const env = clean(reload);
	const header0 = env.onResponseReceivedActions[0].reloadContinuationItemsCommand;
	const chipsR = find(header0, "chipBarViewModel").chips;
	for (const c of chipsR) {
		const label = c.chipViewModel.text.toUpperCase();
		find(c, "continuationCommand").token = `{{SORT_${label}}}`;
		c.chipViewModel.selected = `{{SELECTED_${label}}}`;
	}
	header0.targetId = "{{TARGET_ID}}";
	env.onResponseReceivedActions[1].reloadContinuationItemsCommand.continuationItems = "{{ITEMS}}";
	env.onResponseReceivedActions[1].reloadContinuationItemsCommand.targetId = "{{TARGET_ID}}";
	save("channel/videos_reload", tokenize(env, channelPairs(), ids), samples);

	// --- home tab: shelves ---
	const [[, home]] = bodies("channel2", /browse/).filter(([req]) => req.post?.params?.startsWith("EghmZWF0dXJlZ"));
	const homeTab = home.contents.twoColumnBrowseResultsRenderer.tabs.find((x: any) => x.tabRenderer?.selected).tabRenderer;
	const sections = clean(homeTab.content.sectionListRenderer);
	const shelfSection = sections.contents.find((s: any) => find(s, "shelfRenderer") && find(s, "lockupViewModel") && !find(s, "shortsLockupViewModel"));
	const shelf = find(shelfSection, "shelfRenderer");
	const shelfItems = find(shelf, "horizontalListRenderer").items;
	const shelfLockup = videoLockup(shelfItems[0]);
	save("item/video_lockup_shelf", shelfLockup.item, [...shelfLockup.samples, ...samples]);
	find(shelf, "horizontalListRenderer").items = "{{ITEMS}}";
	const shelfTitle = contentOf(shelf.title);
	const shelfPairs: [string, string][] = [[shelfTitle, "SHELF_TITLE"]];
	// shelf title links to the tab it summarises
	const shelfEp = find(shelf.title, "browseEndpoint");
	if (shelfEp) shelfEp.params = "{{SHELF_PARAMS}}";
	delete shelf.playAllButton;
	save("channel/home_shelf", tokenize(shelfSection, [...shelfPairs, ...channelPairs()], ids), samples);
	sections.contents = "{{SECTIONS}}";
	sections.targetId = "{{TARGET_ID}}";
	save("channel/home_sections", tokenize(sections, channelPairs(), ids), samples);

	// --- playlists tab ---
	const [[, pls]] = bodies("channel2", /browse/).filter(([req]) => req.post?.params?.startsWith("EglwbGF5bGlzdHP"));
	const plTab = pls.contents.twoColumnBrowseResultsRenderer.tabs.find((x: any) => x.tabRenderer?.selected).tabRenderer;
	const plSections = clean(plTab.content.sectionListRenderer);
	const gridR = find(plSections, "gridRenderer");
	const plSample = gridR.items.find((x: any) => x.lockupViewModel);
	save("item/playlist_lockup", playlistLockup(plSample, channelPairs(), ids), samples);
	gridR.items = "{{ITEMS}}";
	delete plSections.subMenu;
	const subMenu = find(plSections, "channelSubMenuRenderer");
	if (subMenu) {
		const holderSub = holder(plSections, "channelSubMenuRenderer");
		delete holderSub.channelSubMenuRenderer;
	}
	plSections.targetId = "{{TARGET_ID}}";
	save("channel/playlists_sections", tokenize(dropItems(plSections, (x) => x && typeof x === "object" && Object.keys(x).length === 0), channelPairs(), ids), samples);

	// --- About panel ---
	const about = clean(JSON.parse(body("channel-about", /007-.*browse/)));
	const avm = find(about, "aboutChannelViewModel");
	find(about, "appendContinuationItemsAction").targetId = "{{ABOUT_TARGET}}";
	const aboutPairs: [string, string][] = [
		...channelPairs(),
		[avm.country, "COUNTRY"],
		[avm.viewCountText, "VIEW_COUNT"],
		[contentOf(avm.joinedDateText), "JOINED"],
		[avm.subscriberCountText, "SUBSCRIBERS"],
		[avm.videoCountText, "VIDEO_COUNT"],
	];
	avm.description = "{{DESCRIPTION}}";
	avm.joinedDateText.styleRuns[0].length = "{{JOINED_LENGTH}}";
	const link = avm.links[0];
	const lvm = link.channelExternalLinkViewModel;
	lvm.title.content = "{{LINK_TITLE}}";
	lvm.link.content = "{{LINK_TEXT}}";
	lvm.link.commandRuns[0].length = "{{LINK_TEXT_LENGTH}}";
	const lc = lvm.link.commandRuns[0].onTap.innertubeCommand;
	lc.commandMetadata.webCommandMetadata.url = "{{LINK_URL}}";
	lc.urlEndpoint.url = "{{LINK_URL}}";
	delete lvm.favicon;
	save("item/channel_link", tokenize(link, aboutPairs, ids), samples);
	avm.links = "{{LINKS}}";
	if (avm.signInForBusinessEmail) delete avm.signInForBusinessEmail;
	delete avm.country;
	avm.country = "{{COUNTRY}}";
	save("channel/about", tokenize(about, aboutPairs, ids), samples);
}

// collection lockup (playlist) on a channel's Playlists tab
function playlistLockup(sample: any, extra: [string, string][] = [], extraIds: [string, string][] = []) {
	const lv = find(sample, "lockupViewModel");
	const pid: string = lv.contentId;
	const title = contentOf(lv.metadata.lockupMetadataViewModel.title);
	const badge = find(lv, "thumbnailBadgeViewModel");
	const firstVideo = find(lv, "watchEndpoint")?.videoId;
	let item = clean(sample);
	wholeToken(item, "sources", "THUMBS", (h) => Array.isArray(h.sources) && h.sources.some((s: any) => /ytimg/.test(s.url ?? "")));
	const pairs: [string, string][] = [
		[pid, "PLAYLIST_ID"],
		[title, "TITLE"],
		[badge?.text, "VIDEO_COUNT"],
		[firstVideo?.startsWith("{{") ? "" : firstVideo, "FIRST_VIDEO_ID"],
	];
	for (const p of findAll(lv.metadata, "metadataParts").flat()) {
		const t = contentOf(p.text);
		if (/^Updated /.test(t)) pairs.push([t, "UPDATED"]);
	}
	return tokenize(item, [...pairs, ...extra], [[pid, "PLAYLIST_ID"], ...extraIds]);
}

// ======================================================================
// signed-in captures: what belongs to the account that made them must not
// end up in a template
function personalValues() {
	const own = readdirSync(join(CAP, "in-own-channel", "bodies")).find((n) => n.startsWith("001-") && n.endsWith(".resp"));
	if (!own) return;
	const p = pageVar(readFileSync(join(CAP, "in-own-channel", "bodies", own), "utf8"));
	const m = p.metadata.channelMetadataRenderer;
	personal.push(m.externalId, m.title, m.vanityChannelUrl.split("/@")[1] ?? "");
	const html = readFileSync(join(CAP, "in-home", "bodies", readdirSync(join(CAP, "in-home", "bodies")).find((n) => n.startsWith("001-") && n.endsWith(".resp"))!), "utf8");
	for (const k of ["DATASYNC_ID", "DELEGATED_SESSION_ID", "SESSION_INDEX", "ID_TOKEN"]) {
		const v = new RegExp(`"${k}":"([^"]+)"`).exec(html)?.[1];
		if (v && v.length > 6) personal.push(v.split("||")[0]);
	}
}

function channelSignedIn() {
	const html = body("in-channel", /^001-/);
	const page = pageVar(html);
	const md = page.metadata.channelMetadataRenderer;
	const id: string = md.externalId;
	const name: string = md.title;
	const samples = [id, name];
	const ph = page.header.pageHeaderRenderer.content.pageHeaderViewModel;
	const sub = clean(ph.actions.flexibleActionsViewModel.actionsRows[0].actions[0]);
	const sbvm = sub.subscribeButtonViewModel;
	sbvm.subscribeButtonContent.subscribeState.subscribed = false;
	sbvm.unsubscribeButtonContent.subscribeState.subscribed = true;
	// notification bell choices: "Personalized" is selected for a new subscription
	const pairs: [string, string][] = [[id, "CHANNEL_ID"], [name, "CHANNEL_NAME"]];
	save("channel/subscribe_button", tokenize(sub, pairs, [[id, "CHANNEL_ID"]]), samples);
	const muts = clean(page.frameworkUpdates.entityBatchUpdate.mutations);
	const subState = muts.find((m: any) => m.payload.subscriptionStateEntity);
	subState.payload.subscriptionStateEntity.subscribed = "{{SUBSCRIBED}}";
	const bell = muts.find((m: any) => m.payload.subscriptionNotificationStateEntity);
	bell.payload.subscriptionNotificationStateEntity.state = "{{BELL_STATE}}";
	save("channel/subscribe_entities", tokenize([subState, bell], pairs, [[id, "CHANNEL_ID"]]), samples);

	const own = pageVar(body("in-own-channel", /^001-/));
	const ownActions = clean(own.header.pageHeaderRenderer.content.pageHeaderViewModel.actions.flexibleActionsViewModel.actionsRows[0].actions);
	const om = own.metadata.channelMetadataRenderer;
	save("channel/owner_actions", tokenize(ownActions, [[om.externalId, "CHANNEL_ID"]], [[om.externalId, "CHANNEL_ID"]]), [om.externalId]);
}

// ======================================================================
// guide (left navigation)
// entries for products this instance doesn't have are left out
const guideTitle = (x: any) => contentOf(x?.formattedTitle ?? x?.title);
function guide() {
	// every section and entry as YouTube sends them; the instance serves each
	// destination (docs/compat/parity.md tracks them)
	const out = clean(JSON.parse(body("channel2", /guide/)));
	save("guide/signed_out", tokenize(out, []));

	const raw = JSON.parse(body("in-home", /guide/));
	const g = clean(raw);
	delete g.userProfile;
	const subsSection = g.items.find((s: any) => s.guideSubscriptionsSectionRenderer).guideSubscriptionsSectionRenderer;
	const more = subsSection.items.find((it: any) => it.guideCollapsibleEntryRenderer);
	const entries = [...subsSection.items.filter((it: any) => it.guideEntryRenderer), ...(more?.guideCollapsibleEntryRenderer.expandableItems ?? [])];
	const names = entries.map((e: any) => guideTitle(e.guideEntryRenderer));
	// a channel without new content (no dot, no "New content available.")
	const sample = entries.find((e: any) => e.guideEntryRenderer.presentationStyle === "GUIDE_ENTRY_PRESENTATION_STYLE_NONE");
	const ge = sample.guideEntryRenderer;
	const sid = ge.entryData.guideEntryData.guideEntryId;
	const sname = guideTitle(ge);
	const surl = ge.navigationEndpoint.browseEndpoint.canonicalBaseUrl;
	ge.thumbnail.thumbnails = "{{AVATAR}}";
	save("guide/subscription_entry", tokenize(sample, [[sid, "CHANNEL_ID"], [sname, "CHANNEL_NAME"], [surl, "CHANNEL_URL"]], [[sid, "CHANNEL_ID"]]), [sid, sname]);
	if (more) {
		more.guideCollapsibleEntryRenderer.expandableItems = "{{MORE}}";
		save("guide/subscriptions_more", tokenize(more, []), names);
	}
	// the "Subscriptions >" header stays; the builder appends the channels
	subsSection.items = subsSection.items.filter((it: any) => it.guideCollapsibleSectionEntryRenderer);
	// "Your channel" / "Your videos" belong to the viewer
	const you = g.items.map((s: any) => find(s, "guideCollapsibleSectionEntryRenderer")).find((c: any) => c?.sectionItems);
	const yourChannel = you.sectionItems.find((it: any) => it.guideEntryRenderer?.icon?.iconType === "ACCOUNT_BOX_CAIRO");
	const vid = yourChannel.guideEntryRenderer.navigationEndpoint.browseEndpoint.browseId;
	const vurl = yourChannel.guideEntryRenderer.navigationEndpoint.browseEndpoint.canonicalBaseUrl;
	const pairs: [string, string][] = [[vid, "VIEWER_CHANNEL_ID"]];
	if (vurl) pairs.push([vurl, "VIEWER_CHANNEL_URL"]);
	save("guide/signed_in", tokenize(g, pairs, [[vid, "VIEWER_CHANNEL_ID"]]), names);
}

// ======================================================================
// app chrome: top bar, account menu (⋮ when signed out), notifications
// account menu entries that lead to Google's services point at the
// instance's own counterparts: the local account page for Google Account and
// "Your data in YouTube", the local feedback form for Send feedback, and
// YouTube's public Help Center (in a new window) for Help, whose in-page
// panel is Google's
const menuTitle = (e: any) => contentOf(e?.title).trim();
const urlCommand = (url: string, newWindow = false) => ({ commandMetadata: { webCommandMetadata: { url, webPageType: "WEB_PAGE_TYPE_UNKNOWN", rootVe: 83769 } }, urlEndpoint: { url, ...(newWindow ? { target: "TARGET_NEW_WINDOW" } : {}) } });
// "Purchases and memberships" stays out until /paid_memberships is served: the
// only capture is of an account with purchases, and this instance sells nothing
function localMenu(m: any) {
	for (const sec of m.sections) {
		const s = sec.multiPageMenuSectionRenderer;
		if (s) s.items = s.items.filter((it: any) => menuTitle(Object.values(it)[0]) !== "Purchases and memberships");
	}
	for (const sec of m.sections) {
		for (const it of sec.multiPageMenuSectionRenderer?.items ?? []) {
			const c = it.compactLinkRenderer;
			if (!c) continue;
			const title = menuTitle(c);
			const set = (url: string, newWindow = false) => {
				delete c.serviceEndpoint;
				c.navigationEndpoint = urlCommand(url, newWindow);
			};
			if (title === "Google Account") {
				c.title = { runs: [{ text: "{{INSTANCE_NAME}} account" }] };
				c.icon.iconType = "ACCOUNT_BOX";
				set("/myaccount");
			} else if (title === "Your data in YouTube") set("/myaccount#your-data");
			else if (title === "Help") set("https://support.google.com/youtube/", true);
			else if (title === "Send feedback") set("/feedback");
		}
	}
	return m;
}

function chrome() {
	const out = clean(pageVar(body("menus-out", /^001-/)).topbar);
	delete out.desktopTopbarRenderer.voiceSearchButton; // needs Google's speech service
	save("topbar/signed_out", tokenize(out, []));

	const own = pageVar(body("in-own-channel", /^001-/)).metadata.channelMetadataRenderer;
	const vid: string = own.externalId;
	const vurl = `/@${own.vanityChannelUrl.split("/@")[1]}`;
	const pairs: [string, string][] = [[vid, "VIEWER_CHANNEL_ID"], [vurl, "VIEWER_CHANNEL_URL"]];
	const ids: [string, string][] = [[vid, "VIEWER_CHANNEL_ID"]];
	const inn = clean(pageVar(body("in-menus", /^001-/)).topbar);
	delete inn.desktopTopbarRenderer.voiceSearchButton;
	wholeToken(inn, "thumbnails", "VIEWER_AVATAR", (o) => o.thumbnails?.[0]?.url?.includes("ggpht"));
	// Create menu: uploading is supported; live streams and posts are not
	const create = find(inn, "multiPageMenuRenderer", (m) => m.style === "MULTI_PAGE_MENU_STYLE_TYPE_CREATION");
	for (const sec of create.sections) {
		const s = sec.multiPageMenuSectionRenderer;
		if (s) s.items = s.items.filter((it: any) => menuTitle(Object.values(it)[0]) === "Upload video");
	}
	save("topbar/signed_in", tokenize(inn, pairs, ids));

	const sysMenu = clean(JSON.parse(body("menus-out", /account_menu/)));
	localMenu(sysMenu.actions[0].openPopupAction.popup.multiPageMenuRenderer);
	save("account/menu_signed_out", tokenize(sysMenu, []));

	const accMenu = clean(JSON.parse(body("in-home", /account_menu/)));
	const m = localMenu(accMenu.actions[0].openPopupAction.popup.multiPageMenuRenderer);
	const h = m.header.activeAccountHeaderRenderer;
	delete h.settingsEndpoint; // the site picker (/select_site)
	h.accountName = { simpleText: "{{VIEWER_NAME}}" };
	h.channelHandle = { simpleText: "{{VIEWER_AT_HANDLE}}" };
	h.accountPhoto.thumbnails = "{{VIEWER_PHOTO}}";
	save("account/menu_signed_in", tokenize(accMenu, pairs, ids));

	const inbox = clean(JSON.parse(body("in-menus", /^005-.*browse/)));
	save("notification/inbox_empty", tokenize(inbox, []));
}

// ======================================================================
// feeds: home and subscriptions
// lockup menus keep what this instance supports (queue, Watch later,
// playlists, share); recommendation feedback and reporting are left out
const LOCKUP_MENU = new Set(["Add to queue", "Save to Watch later", "Save to playlist", "Share"]);
const itemTitle = (x: any) => contentOf(Object.values(x)[0] && (Object.values(x)[0] as any).title);
function pruneLockupMenu(item: any) {
	for (const list of findAll(item, "listItems")) for (let i = list.length - 1; i >= 0; i--) if (!LOCKUP_MENU.has(itemTitle(list[i]))) list.splice(i, 1);
	return item;
}
const gridOf = (page: any) => page.contents.twoColumnBrowseResultsRenderer.tabs[0].tabRenderer.content.richGridRenderer;
// a page response without the parts every page gets from elsewhere
function pageOnly(page: any) {
	const p = clean(page);
	delete p.topbar;
	delete p.frameworkUpdates;
	return p;
}

function feeds() {
	// lockups: the signed-in sample, and the same with the signed-out menu
	const home = pageVar(body("in-menus", /^001-/));
	const g = gridOf(home);
	const sample = g.contents.find((it: any) => it.richItemRenderer?.content?.lockupViewModel?.contentType === "LOCKUP_CONTENT_TYPE_VIDEO");
	const { item, samples } = videoLockup(pruneLockupMenu(structuredClone(sample)));
	save("item/video_lockup_rich", item, samples);
	const out = structuredClone(item);
	const outMenu = find(JSON.parse(readFileSync(join(OUT, "item/video_lockup_channel.json"), "utf8")), "listItems");
	holder(out, "listItems").listItems = outMenu;
	save("item/video_lockup_rich_out", out, samples);
	const cont = clean(g.contents.find((it: any) => it.continuationItemRenderer));
	find(cont, "continuationCommand").token = "{{CONTINUATION}}";
	save("item/continuation_rich", cont);

	// home: the grid (its chip bar filled in by feeds.ts, home-chips), and
	// YouTube's empty-feed nudge
	const hp = pageOnly(home);
	const hg = gridOf(hp);
	hg.header = "{{HEADER}}";
	hg.contents = "{{ITEMS}}";
	save("home/page", tokenize(hp, []));
	const empty = pageOnly(pageVar(body("menus-out", /^001-/)));
	save("home/empty", tokenize(empty, []));

	// subscriptions: "Latest" shelf heading, then the videos
	const subs = pageOnly(pageVar(body("in-subscriptions", /^001-/)));
	const sg = gridOf(subs);
	const latest = sg.contents.find((it: any) => find(it, "shelfRenderer"));
	save("subscriptions/latest", tokenize(latest, []));
	sg.contents = "{{ITEMS}}";
	save("subscriptions/page", tokenize(subs, []));
	save("subscriptions/signed_out", tokenize(pageOnly(pageVar(body("feed-subscriptions", /^001-/))), []));
}

// home's Shorts shelf: YouTube's richShelfRenderer of shortsLockupViewModels
// (the "Show fewer Shorts" feedback menu and inline previews left out)
function homeShorts() {
	const home = pageVar(body("in-home", /^001-/));
	const section = gridOf(home).contents.find((it: any) => find(it, "shortsLockupViewModel"));
	const sample = structuredClone(find(section, "richShelfRenderer").contents[0]);
	const lv = find(sample, "shortsLockupViewModel");
	const id: string = lv.onTap.innertubeCommand.reelWatchEndpoint.videoId;
	const title: string = lv.overlayMetadata.primaryText.content;
	const views: string = lv.overlayMetadata.secondaryText.content;
	let item = pruneLockupMenu(clean(sample));
	const v = find(item, "shortsLockupViewModel");
	for (const k of ["badge", "inlinePlayerData", "inlinePopStateEntityKey", "indexInCollection"]) delete v[k];
	const reel = v.onTap.innertubeCommand.reelWatchEndpoint;
	for (const k of ["playerParams", "params", "sequenceParams", "loggingContext", "ustreamerConfig"]) delete reel[k];
	reel.thumbnail.thumbnails = "{{REEL_THUMBS}}";
	v.thumbnailViewModel.thumbnailViewModel.image.sources = "{{THUMBS}}";
	v.accessibilityText = "{{A11Y}}";
	item = dropKey(item, "playerParams");
	item = tokenize(item, [[id, "VIDEO_ID"], [title, "TITLE"], [views, "VIEWS_SHORT"]], [[id, "VIDEO_ID"]]);
	save("item/shorts_lockup_rich", item, [id, title]);
	const shelf = clean(structuredClone(section));
	const r = find(shelf, "richShelfRenderer");
	delete r.menu;
	r.contents = "{{ITEMS}}";
	save("home/shorts_shelf", tokenize(shelf, []));
}

// ======================================================================
// watch page
// kept: title, counts, like/dislike/share/save, owner and subscribe, the
// description and comments panels, related videos, autoplay and end screen.
// left out: ads, premium upsells, download/clip/report, heatmap markers,
// metadata rows (license, music) and the channel's external links
const WATCH_PANELS = new Set(["engagement-panel-comments-section", "engagement-panel-structured-description"]);
const plainDescription = (o: any) => {
	for (const k of ["attributedDescription", "attributedDescriptionBodyText", "colorSampledDescriptionBodyText"]) for (const h of findAllHolders(o, k)) h[k] = { content: "{{DESCRIPTION}}" };
	for (const h of findAllHolders(o, "headerRuns")) delete h.headerRuns;
};
function findAllHolders(o: any, key: string, out: any[] = []): any[] {
	if (!o || typeof o !== "object") return out;
	if (!Array.isArray(o) && key in o) out.push(o);
	for (const v of Array.isArray(o) ? o : Object.values(o)) findAllHolders(v, key, out);
	return out;
}

// another video referred to by a watch page (autoplay, end screen); its
// values become the usual video tokens
function otherVideo(node: any, v: { id: string; title: string; channelId: string; channelName: string; channelUrl: string; duration: string; durationLabel: string; views: string; viewsLabel: string; published: string }) {
	let n = dropKey(clean(node), "playerParams");
	wholeToken(n, "thumbnails", "VIDEO_THUMBNAILS", (h) => /ytimg/.test(JSON.stringify(h.thumbnails)));
	n = tokenize(
		n,
		[[v.id, "VIDEO_ID"], [v.title, "TITLE"], [v.channelId, "CHANNEL_ID"], [v.channelUrl, "CHANNEL_URL"], [v.durationLabel, "DURATION_LABEL"]],
		[[v.id, "VIDEO_ID"], [v.channelId, "CHANNEL_ID"]],
		[[v.channelName, "CHANNEL_NAME"], [v.duration, "DURATION"], [v.views, "VIEWS"], [v.viewsLabel, "VIEWS_LABEL"], [v.published, "PUBLISHED"]],
	);
	return strings(n, (x) => x.replace(/&pp=[^&"]*/, ""));
}

function watchPage(dir: string, signedIn: boolean) {
	const p = pageOnly(pageVar(body(dir, /^001-/)));
	delete p.onResponseReceivedEndpoints; // heatmap markers, browser notification prompt
	const r = p.contents.twoColumnWatchNextResults;
	const [pri0, sec0] = r.results.results.contents;
	const pri = pri0.videoPrimaryInfoRenderer;
	const sec = sec0.videoSecondaryInfoRenderer;
	const id: string = p.currentVideoEndpoint.watchEndpoint.videoId;
	const title = contentOf(pri.title);
	const owner = sec.owner.videoOwnerRenderer;
	const chId: string = owner.navigationEndpoint.browseEndpoint.browseId;
	const chUrl: string = owner.navigationEndpoint.browseEndpoint.canonicalBaseUrl;
	const chName = contentOf(owner.title);
	const vc = pri.viewCount.videoViewCountRenderer;
	const likeVm = find(pri, "likeButtonViewModel").likeButtonViewModel.toggleButtonViewModel.toggleButtonViewModel;
	const likes: string = likeVm.defaultButtonViewModel.buttonViewModel.title;
	const likesGrouped = /along with ([\d,]+) other/.exec(likeVm.defaultButtonViewModel.buttonViewModel.accessibilityText)![1];
	const header = find(p, "videoDescriptionHeaderRenderer");
	const [likeF, , dateF] = header.factoid;
	const listLike = find(p, "listItemLikeCountViewModel");
	const commentsPanel = p.engagementPanels.find((e: any) => e.engagementPanelSectionListRenderer.targetId === "engagement-panel-comments-section");
	const commentCount = contentOf(find(commentsPanel, "contextualInfo"));
	const subs = owner.subscriberCountText;

	// ---- what this instance doesn't offer ----
	const menu = pri.videoActions.menuRenderer;
	menu.items = [];
	menu.flexibleItems = menu.flexibleItems.filter((it: any) => contentOf(find(it, "menuServiceItemRenderer")?.text) === "Save");
	delete owner.badges;
	sec.metadataRowContainer.metadataRowContainerRenderer.rows = [];
	plainDescription(p);
	p.engagementPanels = p.engagementPanels.filter((e: any) => WATCH_PANELS.has(e.engagementPanelSectionListRenderer.targetId));
	for (const h of findAllHolders(p, "creatorCustomUrlButtons")) delete h.creatorCustomUrlButtons;
	// YouTube's AI chat ("Ask") in the description panel
	for (const h of findAllHolders(p, "structuredDescriptionContentRenderer")) {
		const sd = h.structuredDescriptionContentRenderer;
		sd.items = sd.items.filter((it: any) => !it.videoDescriptionYouchatSectionViewModel);
	}
	// description quick actions: no AI "Ask" panel, no reporting
	for (const h of findAllHolders(p, "quickActionButtons")) {
		h.quickActionButtons = h.quickActionButtons.filter((b: any) => b.buttonViewModel?.iconName !== "SPARK");
		for (const list of findAll(h.quickActionButtons, "listItems")) for (let i = list.length - 1; i >= 0; i--) if (itemTitle(list[i]) === "Report") list.splice(i, 1);
		for (const list of findAll(h.quickActionButtons, "items")) if (Array.isArray(list)) for (let i = list.length - 1; i >= 0; i--) if (/^Report$/.test(contentOf(find(list[i], "text")))) list.splice(i, 1);
	}
	const overlay = p.playerOverlays.playerOverlayRenderer;
	delete overlay.showPlaybackRateUpsellPanelCommand;
	const muts = p.frameworkUpdates?.entityBatchUpdate?.mutations;
	delete p.frameworkUpdates;

	// ---- per-viewer state ----
	for (const h of findAllHolders(p, "likeStatus")) h.likeStatus = "{{LIKE_STATUS}}";
	const subBtn = find(sec, "subscribeButtonRenderer");
	if (subBtn && "subscribed" in subBtn) subBtn.subscribed = "{{SUBSCRIBED}}";
	const keep = (muts ?? []).filter((m: any) => m.payload && (m.payload.likeStatusEntity || m.payload.subscriptionStateEntity || m.payload.likeButtonAnimationEntity));
	for (const m of keep) {
		if (m.payload.likeStatusEntity) m.payload.likeStatusEntity.likeStatus = "{{LIKE_STATUS}}";
		if (m.payload.subscriptionStateEntity) m.payload.subscriptionStateEntity.subscribed = "{{SUBSCRIBED}}";
	}

	// ---- lists filled per video ----
	const comments = r.results.results.contents.find((c: any) => c.itemSectionRenderer?.sectionIdentifier === "comment-item-section");
	find(comments, "continuationCommand").token = "{{COMMENTS_CONTINUATION}}";
	const sorts = find(commentsPanel, "subMenuItems");
	sorts[0].serviceEndpoint.continuationCommand.token = "{{COMMENTS_TOP}}";
	sorts[1].serviceEndpoint.continuationCommand.token = "{{COMMENTS_NEWEST}}";
	for (const h of findAllHolders(commentsPanel, "continuationCommand")) if (!/^\{\{/.test(h.continuationCommand.token)) h.continuationCommand.token = "{{COMMENTS_CONTINUATION}}";
	const related = r.secondaryResults.secondaryResults.results[0].itemSectionRenderer;
	const relatedSample = related.contents.find((c: any) => c.lockupViewModel?.contentType === "LOCKUP_CONTENT_TYPE_VIDEO");
	const relatedCont = related.contents.find((c: any) => c.continuationItemRenderer);
	related.contents = "{{RELATED}}";
	delete related.header; // "All / From <channel> / Related" filter chips (signed in): not supported yet
	const auto = overlay.autoplay.playerOverlayAutoplayRenderer;
	const next = {
		id: auto.videoId,
		title: contentOf(auto.videoTitle),
		channelId: auto.byline.runs[0].navigationEndpoint.browseEndpoint.browseId,
		channelName: auto.byline.runs[0].text,
		channelUrl: auto.byline.runs[0].navigationEndpoint.browseEndpoint.canonicalBaseUrl,
		duration: contentOf(auto.thumbnailOverlays[0].thumbnailOverlayTimeStatusRenderer.text),
		durationLabel: auto.thumbnailOverlays[0].thumbnailOverlayTimeStatusRenderer.text.accessibility.accessibilityData.label,
		views: contentOf(auto.shortViewCountText),
		viewsLabel: auto.shortViewCountText.accessibility.accessibilityData.label,
		published: contentOf(auto.publishedTimeText),
	};
	const nextSamples = [next.id, next.title, next.channelId];
	const suffix = signedIn ? "in" : "out";
	save(`watch/autoplay_${suffix}`, otherVideo(r.autoplay, next), nextSamples);
	save(`watch/autoplay_overlay_${suffix}`, otherVideo(overlay.autoplay, next), nextSamples);
	r.autoplay = "{{AUTOPLAY}}";
	overlay.autoplay = "{{AUTOPLAY_OVERLAY}}";
	const end = overlay.endScreen.watchNextEndScreenRenderer;
	const e0 = end.results[0].endScreenVideoRenderer;
	if (!signedIn) {
		const ev = {
			id: e0.videoId,
			title: contentOf(e0.title),
			channelId: e0.shortBylineText.runs[0].navigationEndpoint.browseEndpoint.browseId,
			channelName: e0.shortBylineText.runs[0].text,
			channelUrl: e0.shortBylineText.runs[0].navigationEndpoint.browseEndpoint.canonicalBaseUrl,
			duration: contentOf(e0.lengthText),
			durationLabel: e0.lengthText.accessibility.accessibilityData.label,
			views: contentOf(e0.shortViewCountText),
			viewsLabel: e0.shortViewCountText.accessibility.accessibilityData.label,
			published: contentOf(e0.publishedTimeText),
		};
		save("item/end_screen_video", otherVideo(end.results[0], ev), [ev.id, ev.title, ev.channelId]);
		const { item, samples } = videoLockup(pruneLockupMenu(structuredClone(relatedSample)));
		save("item/video_lockup_compact_out", item, samples);
		const c = clean(relatedCont);
		for (const h of findAllHolders(c, "continuationCommand")) h.continuationCommand.token = "{{CONTINUATION}}";
		save("item/continuation_related", c);
	} else {
		const { item, samples } = videoLockup(pruneLockupMenu(structuredClone(relatedSample)));
		save("item/video_lockup_compact", item, samples);
	}
	end.results = "{{END_SCREEN}}";

	// ---- the video's own values ----
	wholeToken(p, "thumbnails", "OWNER_AVATAR", (h) => h.thumbnails?.length === 3 && /ggpht/.test(h.thumbnails[0].url));
	wholeToken(p, "thumbnails", "AVATAR_88", (h) => h.thumbnails?.length === 1 && /ggpht/.test(h.thumbnails[0].url));
	if (keep.length) p.mutations = keep;
	const pairs: [string, string][] = [
		[id, "VIDEO_ID"],
		[title, "TITLE"],
		[chId, "CHANNEL_ID"],
		[chUrl, "CHANNEL_URL"],
		[chUrl.slice(1), "AT_HANDLE"],
		[contentOf(vc.viewCount), "VIEWS_FULL"],
		[contentOf(vc.shortViewCount), "VIEWS_SHORT"],
		[contentOf(pri.dateText), "DATE"],
		[likesGrouped, "LIKES_GROUPED"],
		[listLike.valueIfLiked, "LIKES_GROUPED_IF_LIKED"],
		[contentOf(subs), "SUBSCRIBERS"],
		[subs.accessibility.accessibilityData.label, "SUBSCRIBERS_LABEL"],
		[`Subscribe to ${chName}.`, "SUBSCRIBE_LABEL"],
		[`Unsubscribe from ${chName}.`, "UNSUBSCRIBE_LABEL"],
		[`notification setting for ${chName}`, "BELL_LABEL_SUFFIX"],
	];
	const exact: [string, string][] = [
		[chName, "CHANNEL_NAME"],
		[vc.originalViewCount, "VIEW_COUNT"],
		[contentOf(pri.relativeDateText), "PUBLISHED_LABEL"],
		[likes, "LIKES"],
		[likeF.factoidRenderer.accessibilityText, "LIKES_LABEL"],
		[contentOf(dateF.factoidRenderer.value), "YEAR"],
		[contentOf(dateF.factoidRenderer.label), "MONTH_DAY"],
		[contentOf(find(header, "viewCountFactoidRenderer").factoid.factoidRenderer.value), "VIEWS_COMPACT"],
		[find(p, "listItemViewCountViewModel").viewCount, "VIEW_COUNT_GROUPED"],
		[commentCount, "COMMENT_COUNT"],
	];
	let out = tokenize(p, pairs, [[id, "VIDEO_ID"], [chId, "CHANNEL_ID"]], exact);
	// the like count a viewer's own like adds is computed per video
	const lv = find(out, "likeButtonViewModel").likeButtonViewModel.toggleButtonViewModel.toggleButtonViewModel;
	lv.toggledButtonViewModel.buttonViewModel.title = "{{LIKES_IF_LIKED}}";
	out = strings(out, (x) => x.replace(/^\{\{VIEWS_FULL\}\}$/, "{{VIEWS_FULL}}"));
	save(`watch/page_${suffix}`, out, [id, title, chId, chName, next.id]);
}

function watch() {
	watchPage("watch2", false);
	watchPage("in-watch", true);
}

// ======================================================================
// search
// chips and filters this instance can apply are kept (All, Videos, Recently
// uploaded; type, duration, upload date, prioritize); Shorts, Live,
// Unwatched and the Features group are left out, as are Shorts shelves
const SEARCH_CHIPS: Record<string, string> = { All: "ALL", Videos: "VIDEOS", "Recently uploaded": "RECENT" };
const SEARCH_FILTERS: Record<string, string> = {
	Videos: "TYPE_VIDEO",
	Channels: "TYPE_CHANNEL",
	Playlists: "TYPE_PLAYLIST",
	"Under 3 minutes": "DUR_SHORT",
	"3 - 20 minutes": "DUR_MEDIUM",
	"Over 20 minutes": "DUR_LONG",
	Today: "DATE_TODAY",
	"This week": "DATE_WEEK",
	"This month": "DATE_MONTH",
	"This year": "DATE_YEAR",
	Relevance: "SORT_RELEVANCE",
	Popularity: "SORT_POPULARITY",
};

// a classic videoRenderer (search results)
function videoRendererTpl(sample: any) {
	const v = clean(sample).videoRenderer;
	const id: string = v.videoId;
	const title = contentOf(v.title);
	const by = v.longBylineText.runs[0];
	for (const k of ["badges", "ownerBadges", "richThumbnail", "inlinePlaybackEndpoint", "expandableMetadata", "searchVideoResultEntityKey"]) delete v[k];
	// the watch params carry the search context; no download here
	delete v.navigationEndpoint.watchEndpoint.params;
	v.menu.menuRenderer.items = v.menu.menuRenderer.items.filter((it: any) => !it.menuServiceItemDownloadRenderer);
	v.detailedMetadataSnippets = [{ snippetText: { runs: [{ text: "{{SNIPPET}}" }] }, snippetHoverText: { runs: [{ text: "From the video description" }] }, maxOneLine: false }];
	wholeToken(v.thumbnail, "thumbnails", "SEARCH_THUMBS");
	wholeToken(v, "thumbnails", "AVATAR_68", (h) => /ggpht/.test(JSON.stringify(h.thumbnails)));
	wholeToken(v, "sources", "AVATAR_68", (h) => /ggpht/.test(JSON.stringify(h.sources)));
	let item = strings(dropKey({ videoRenderer: v }, "playerParams"), (x) => (x === `Go to channel ${by.text}` ? "Go to channel {{CHANNEL_NAME}}" : x));
	item = tokenize(
		item,
		[[id, "VIDEO_ID"], [title, "TITLE"], [by.navigationEndpoint.browseEndpoint.browseId, "CHANNEL_ID"], [by.navigationEndpoint.browseEndpoint.canonicalBaseUrl, "CHANNEL_URL"], [v.lengthText.accessibility.accessibilityData.label, "DURATION_LABEL"], [contentOf(v.viewCountText), "VIEWS_FULL"]],
		[[id, "VIDEO_ID"], [by.navigationEndpoint.browseEndpoint.browseId, "CHANNEL_ID"]],
		[[by.text, "CHANNEL_NAME"], [contentOf(v.publishedTimeText), "PUBLISHED_FULL"], [contentOf(v.lengthText), "DURATION"], [contentOf(v.shortViewCountText), "VIEWS_SHORT"], [v.shortViewCountText?.accessibility?.accessibilityData?.label, "VIEWS_SHORT_LABEL"]],
	);
	return { item: strings(item, (x) => x.replace(/&pp=[^&"]*/, "")), samples: [id, title, by.text] };
}

function searchPage(dir: string, signedIn: boolean) {
	const p = pageOnly(pageVar(body(dir, /results\.resp$/)));
	const sl = p.contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer;
	const all = sl.contents.flatMap((c: any) => c.itemSectionRenderer?.contents ?? []);
	const query: string = find(p, "searchFilterRenderer").navigationEndpoint.searchEndpoint.query;
	const io = signedIn ? "in" : "out";
	const video = videoRendererTpl(all.find((it: any) => it.videoRenderer));
	save(`item/video_search_${io}`, video.item, video.samples);
	if (!signedIn) {
		const pl = all.find((it: any) => it.lockupViewModel?.contentType === "LOCKUP_CONTENT_TYPE_PLAYLIST");
		const plId: string = pl.lockupViewModel.contentId;
		const pt = playlistSearchTpl(pl);
		save("item/playlist_search", pt.out, [plId, ...pt.samples]);
		const cont = clean(sl.contents.find((c: any) => c.continuationItemRenderer));
		find(cont, "continuationCommand").token = "{{CONTINUATION}}";
		save("item/continuation_search", cont);
	}
	sl.contents = [{ itemSectionRenderer: { contents: "{{ITEMS}}" } }, "{{CONTINUATION_ITEM}}"];
	p.estimatedResults = "{{ESTIMATED}}";
	const h = p.header.searchHeaderRenderer;
	const chips = h.chipBar.chipCloudRenderer;
	chips.chips = chips.chips.filter((c: any) => SEARCH_CHIPS[contentOf(c.chipCloudChipRenderer.text)]);
	for (const c of chips.chips) {
		const r = c.chipCloudChipRenderer;
		const k = SEARCH_CHIPS[contentOf(r.text)];
		r.isSelected = `{{CHIP_${k}_SELECTED}}`;
		r.navigationEndpoint = { commandMetadata: { webCommandMetadata: { sendPost: true, apiUrl: "/youtubei/v1/search" } }, continuationCommand: { token: `{{CHIP_${k}}}`, request: "CONTINUATION_REQUEST_TYPE_SEARCH", command: { showReloadUiCommand: { targetId: "search-feed" } } } };
	}
	const groups = find(h, "searchFilterOptionsDialogRenderer").groups;
	const kept = groups.filter((g: any) => contentOf(g.searchFilterGroupRenderer.title) !== "Features");
	for (const g of kept) {
		const gr = g.searchFilterGroupRenderer;
		gr.filters = gr.filters.filter((f: any) => SEARCH_FILTERS[contentOf(f.searchFilterRenderer.label)]);
		for (const f of gr.filters) {
			const r = f.searchFilterRenderer;
			const k = SEARCH_FILTERS[contentOf(r.label)];
			r.status = `{{F_${k}_STATUS}}`;
			r.navigationEndpoint = { commandMetadata: { webCommandMetadata: { url: `/results?search_query={{QUERY_URL}}&sp={{F_${k}}}`, webPageType: "WEB_PAGE_TYPE_SEARCH", rootVe: 4724 } }, searchEndpoint: { query: "{{QUERY}}", params: `{{F_${k}}}` } };
		}
	}
	find(h, "searchFilterOptionsDialogRenderer").groups = kept;
	save(`search/page_${io}`, tokenize(p, [[query, "QUERY"]]), [query]);
	if (!signedIn) {
		// a chip tap reloads the results and the header
		const reload = clean(JSON.parse(body("search-chips", /^005-.*search\.resp$/)));
		const cmds = reload.onResponseReceivedCommands;
		for (const c of cmds) c.reloadContinuationItemsCommand.continuationItems = c.reloadContinuationItemsCommand.slot === "RELOAD_CONTINUATION_SLOT_HEADER" ? ["{{HEADER}}"] : ["{{BODY}}"];
		save("search/reload", { estimatedResults: "{{ESTIMATED}}", onResponseReceivedCommands: cmds });
		// channel results (signed out; signed in, the subscribe button is swapped)
		const ep = pageVar(body("results-empty", /^001-/));
		const ch = clean(ep.contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents[0].itemSectionRenderer.contents.find((i: any) => i.channelRenderer));
		const cr = ch.channelRenderer;
		const handle = contentOf(cr.subscriberCountText);
		wholeToken(cr, "thumbnails", "AVATAR_88_176");
		cr.descriptionSnippet = { runs: [{ text: "{{DESCRIPTION_SHORT}}" }] };
		const chSignIn = find(cr, "signInEndpoint");
		delete chSignIn.continueAction;
		delete chSignIn.idamTag;
		chSignIn.nextEndpoint.commandMetadata.webCommandMetadata.url = "/results?search_query={{QUERY_URL}}";
		chSignIn.nextEndpoint.searchEndpoint.query = "{{QUERY}}";
		const chPairs: [string, string][] = [[cr.channelId, "CHANNEL_ID"], [cr.navigationEndpoint.browseEndpoint.canonicalBaseUrl, "CHANNEL_URL"]];
		const chExact: [string, string][] = [[contentOf(cr.title), "CHANNEL_NAME"], [handle, "AT_HANDLE"], [contentOf(cr.videoCountText), "SUBSCRIBERS"], [cr.videoCountText.accessibility.accessibilityData.label, "SUBSCRIBERS_LABEL"]];
		save("item/channel_search", tokenize(ch, chPairs, [[cr.channelId, "CHANNEL_ID"]], chExact), [cr.channelId, contentOf(cr.title)]);
	}
}

// a playlist search result: byline, the first videos, "View full playlist"
// and the description. The first video row is the sample for every row
// (builders repeat it); the others are dropped
function playlistSearchTpl(sample: any) {
	const item = clean(sample);
	const lv = item.lockupViewModel;
	const rows = lv.metadata.lockupMetadataViewModel.metadata.contentMetadataViewModel.metadataRows;
	const by = rows[0].metadataParts[0];
	const chCmd = by.text.commandRuns[0].onTap.innertubeCommand;
	const pairs: [string, string][] = [[chCmd.browseEndpoint.browseId, "CHANNEL_ID"], [chCmd.browseEndpoint.canonicalBaseUrl, "CHANNEL_URL"]];
	const samples = [by.text.content, chCmd.browseEndpoint.browseId];
	by.text.content = "{{CHANNEL_NAME}}";
	by.text.commandRuns[0].length = by.text.styleRuns[0].length = "{{CHANNEL_NAME_LENGTH}}";
	delete by.icon; // verification badge
	const videoRows = rows.filter((r: any) => find(r, "watchEndpoint"));
	const vr = videoRows[0].metadataParts[0];
	const vCmd = vr.text.commandRuns[0].onTap.innertubeCommand;
	samples.push(vr.text.content, ...videoRows.slice(1).map((r: any) => r.metadataParts[0].text.content));
	vr.text.content = "{{ROW_TEXT}}";
	vr.text.commandRuns[0].length = "{{ROW_TEXT_LENGTH}}";
	if (vr.text.styleRuns) vr.text.styleRuns[0].length = "{{ROW_TEXT_LENGTH}}";
	vCmd.commandMetadata.webCommandMetadata.url = "/watch?v={{ROW_VIDEO_ID}}&list={{PLAYLIST_ID}}";
	vCmd.watchEndpoint.videoId = "{{ROW_VIDEO_ID}}";
	delete vCmd.watchEndpoint.playerParams;
	const desc = rows.find((r: any) => r.lockupContentMetadataRowExtension?.contentType === "METADATA_ROW_CONTENT_TYPE_DESCRIPTION");
	if (desc) {
		samples.push(desc.metadataParts[0].text.content);
		desc.metadataParts[0].text.content = "{{DESCRIPTION_SHORT}}";
	}
	lv.metadata.lockupMetadataViewModel.metadata.contentMetadataViewModel.metadataRows = rows.filter((r: any) => !videoRows.slice(1).includes(r));
	// thumbnail and title play the playlist from its first video
	const first: string = lv.rendererContext.commandContext.onTap.innertubeCommand.watchEndpoint.videoId;
	samples.push(first);
	const prepared = strings(dropKey(dropKey(item, "playerParams"), "loggingContext"), (x) => x.split(first).join("{{FIRST_VIDEO_ID}}").replace(/&pp=[^&"]*/, ""));
	const out = playlistLockup(prepared, pairs, [[chCmd.browseEndpoint.browseId, "CHANNEL_ID"]]);
	return { out, samples };
}

// the signed-in subscribe button (subscribeButtonRenderer), as channel
// results and the watch page use it
function subscribeRenderer() {
	const p = clean(pageVar(body("in-watch", /^001-/)));
	const sec = p.contents.twoColumnWatchNextResults.results.results.contents[1].videoSecondaryInfoRenderer;
	const owner = sec.owner.videoOwnerRenderer;
	const chId: string = owner.navigationEndpoint.browseEndpoint.browseId;
	const chName = contentOf(owner.title);
	const vid: string = p.currentVideoEndpoint.watchEndpoint.videoId;
	const b = sec.subscribeButton;
	b.subscribeButtonRenderer.subscribed = "{{SUBSCRIBED}}";
	const out = tokenize(
		b,
		[[chId, "CHANNEL_ID"], [`Subscribe to ${chName}.`, "SUBSCRIBE_LABEL"], [`Unsubscribe from ${chName}.`, "UNSUBSCRIBE_LABEL"], [`notification setting for ${chName}`, "BELL_LABEL_SUFFIX"]],
		[[chId, "CHANNEL_ID"], [vid, "VIDEO_ID"]],
		[[chName, "CHANNEL_NAME"]],
	);
	save("item/subscribe_button_renderer", out, [chId, chName, vid]);
}

function search() {
	searchPage("results", false);
	searchPage("in-results", true);
	subscribeRenderer();
	// a search nothing matches (a filtered one: plain gibberish still gets fuzzy matches)
	const none = pageVar(body("results-none", /results\.resp$/));
	save("item/no_results", { backgroundPromoRenderer: clean(find(none, "backgroundPromoRenderer")) });
}

// ======================================================================
// playlist page (a public playlist, signed out): header with Play all,
// Save (sign-in), Share and Shuffle, then the videos as lockups.
// left out: the playlist's view count (not counted here) and the legacy
// sidebar the header replaces
function playlistPage() {
	const p = pageOnly(pageVar(body("playlist", /^001-/)));
	const plId: string = p.metadata.playlistMetadataRenderer.title && find(p.header, "watchEndpoint").playlistId;
	const title: string = p.metadata.playlistMetadataRenderer.title;
	const description: string = p.metadata.playlistMetadataRenderer.description;
	const ph = p.header.pageHeaderRenderer.content.pageHeaderViewModel;
	const by = ph.metadata.contentMetadataViewModel.metadataRows[0].metadataParts[0].avatarStack.avatarStackViewModel;
	const chId: string = find(by, "browseEndpoint").browseId;
	const chUrl: string = find(by, "browseEndpoint").canonicalBaseUrl;
	const chName = by.text.content.replace(/^by /, "");
	const first: string = find(ph.actions, "watchEndpoint").videoId;
	const shuffle = find(ph.actions, "listItemViewModel");
	const shuffleId: string = find(shuffle, "watchEndpoint").videoId;
	delete p.sidebar;
	// rows: one sample lockup (single-channel byline), without download
	const sl = p.contents.twoColumnBrowseResultsRenderer.tabs[0].tabRenderer.content.sectionListRenderer;
	const rows = sl.contents[0].itemSectionRenderer.contents;
	const sample = rows.find((it: any) => it.lockupViewModel.metadata.lockupMetadataViewModel.metadata.contentMetadataViewModel.metadataRows[0].metadataParts.length === 1);
	const row = videoLockup(pruneLockupMenu(dropKey(structuredClone(sample), "loggingContext")));
	const rowOut = tokenize(row.item, [[plId, "PLAYLIST_ID"]], [[plId, "PLAYLIST_ID"]]);
	save("item/playlist_row_out", rowOut, [...row.samples, plId]);
	// signed in: the same row with the signed-in lockup menu
	const rowIn = structuredClone(rowOut);
	holder(rowIn, "listItems").listItems = find(JSON.parse(readFileSync(join(OUT, "item/video_lockup_rich.json"), "utf8")), "listItems");
	save("item/playlist_row_in", rowIn, [...row.samples, plId]);
	const cont = clean(sl.contents.find((c: any) => c.continuationItemViewModel));
	find(cont, "continuationCommand").token = "{{CONTINUATION}}";
	save("item/continuation_playlist", cont);
	sl.contents = [{ itemSectionRenderer: { contents: "{{ITEMS}}" } }, "{{CONTINUATION_ITEM}}"];
	// header
	by.text.content = "by {{CHANNEL_NAME}}";
	by.text.commandRuns[0].length = by.text.styleRuns[0].length = "{{BY_LENGTH}}";
	by.rendererContext.accessibilityContext.label = "by {{CHANNEL_NAME}}";
	wholeToken(by, "sources", "AVATAR_48");
	const counts = ph.metadata.contentMetadataViewModel.metadataRows[1].metadataParts;
	const videoCount = contentOf(counts[1].text);
	ph.metadata.contentMetadataViewModel.metadataRows[1].metadataParts = counts.filter((x: any) => !/ views?$/.test(contentOf(x.text)));
	const dp = ph.description.descriptionPreviewViewModel;
	dp.rendererContext.accessibilityContext.label = "{{DESCRIPTION_LABEL}}";
	wholeToken(ph.heroImage, "sources", "HERO");
	wholeToken(ph.background, "sources", "HERO");
	const mf = p.microformat.microformatDataRenderer;
	wholeToken(mf, "thumbnails", "MICROFORMAT_THUMBS");
	stripAppLinks(p);
	let out = dropKey(dropKey(p, "playerParams"), "loggingContext");
	out = strings(out, (x) => x.replace(/^https?:\/\/www\.youtube\.com\/playlist/, "{{ORIGIN}}/playlist"));
	out = tokenize(
		out,
		[[plId, "PLAYLIST_ID"], [title, "TITLE"], [description, "DESCRIPTION"], [chId, "CHANNEL_ID"], [chUrl, "CHANNEL_URL"]],
		[[plId, "PLAYLIST_ID"], [chId, "CHANNEL_ID"]],
		[[first, "FIRST_VIDEO_ID"], [shuffleId, "SHUFFLE_VIDEO_ID"], [videoCount, "VIDEO_COUNT"], [chName, "CHANNEL_NAME"]],
	);
	out = strings(out, (x) => x.split(first).join("{{FIRST_VIDEO_ID}}").split(shuffleId).join("{{SHUFFLE_VIDEO_ID}}").replace(/&pp=[^&"]*/, ""));
	save("playlist/page_out", out, [plId, title, chId, chName, first, shuffleId, description]);

	// signed in, Save adds the playlist to the library (like/like with the playlist as target)
	const inPage = pageOnly(pageVar(body("in-playlist-other", /^001-/)));
	const toggle = clean(find(inPage.header, "toggleButtonViewModel"));
	toggle.isToggled = "{{SAVED}}";
	const inId: string = find(toggle, "likeEndpoint").target.playlistId;
	save("playlist/save_toggle_in", tokenize({ toggleButtonViewModel: toggle }, [[inId, "PLAYLIST_ID"]], [[inId, "PLAYLIST_ID"]]), [inId]);
}

// "Learn more" runs that link to Google's help centre
function dropGoogleHelp(o: any) {
	for (const h of findAllHolders(o, "runs")) {
		if (!Array.isArray(h.runs)) continue;
		const i = h.runs.findIndex((r: any) => /support\.google\.com/.test(JSON.stringify(r.navigationEndpoint ?? "")));
		if (i < 0) continue;
		h.runs.splice(i, 1);
		const prev = h.runs[i - 1];
		if (prev?.text) prev.text = prev.text.replace(/\s+$/, "");
	}
}

// app-store and app-indexing links of a page's metadata
function stripAppLinks(p: any) {
	for (const k of ["androidAppindexingLink", "iosAppindexingLink"]) delete p.metadata.playlistMetadataRenderer[k];
	const mf = p.microformat.microformatDataRenderer;
	for (const k of Object.keys(mf)) if (/^(ios|android|twitter|app|og|urlApplinks|urlTwitter)/i.test(k) || k === "linkAlternates") delete mf[k];
}

// the viewer's own list (Watch later; the classic editable header and
// reorderable rows). Left out: "Add videos" (YouTube's video picker),
// "Add all to...", downloads, and the watched/resume overlays
const OWN_LIST_MENU = new Set(["Remove watched videos"]);
function ownListPage() {
	const p = pageOnly(pageVar(body("in-wl", /^001-/)));
	delete p.sidebar;
	const h = p.header.playlistHeaderRenderer;
	const count = h.numVideosText.runs[0].text;
	const first: string = h.playButton.buttonRenderer.navigationEndpoint.watchEndpoint.videoId;
	const shuffleId: string = h.shufflePlayButton.buttonRenderer.navigationEndpoint.watchEndpoint.videoId;
	const updated = h.byline[2].playlistBylineRenderer.text.runs[1].text;
	h.moreActionsMenu.menuRenderer.items = h.moreActionsMenu.menuRenderer.items.filter((it: any) => OWN_LIST_MENU.has(menuTitle(Object.values(it)[0])));
	h.title.simpleText = "{{TITLE}}";
	// "2" + " videos" in four places
	for (const t of [h.numVideosText, h.briefStats[0], h.stats[0], h.byline[0].playlistBylineRenderer.text]) {
		t.runs[0].text = "{{VIDEO_COUNT_NUM}}";
		t.runs[1].text = "{{VIDEOS_WORD}}";
	}
	h.byline[2].playlistBylineRenderer.text.runs[1].text = "{{UPDATED}}";
	h.ownerText.runs[0].text = "{{VIEWER_NAME}}";
	for (const e of [h.ownerText.runs[0].navigationEndpoint, h.ownerEndpoint]) {
		e.browseEndpoint.browseId = "{{VIEWER_CHANNEL_ID}}";
		e.browseEndpoint.canonicalBaseUrl = "{{VIEWER_CHANNEL_URL}}";
		if (e.commandMetadata) e.commandMetadata.webCommandMetadata.url = "{{VIEWER_CHANNEL_URL}}";
	}
	wholeToken(h.playlistHeaderBanner, "thumbnails", "HERO");
	wholeToken(h.cinematicContainer, "thumbnails", "HERO");
	wholeToken(p.microformat, "thumbnails", "MICROFORMAT_THUMBS");
	const sl = p.contents.twoColumnBrowseResultsRenderer.tabs[0].tabRenderer.content.sectionListRenderer;
	const isr = sl.contents[0].itemSectionRenderer;
	const pvl = isr.contents[0].playlistVideoListRenderer;
	// one row
	const r0 = pvl.contents[0].playlistVideoRenderer;
	const v = { id: r0.videoId, title: contentOf(r0.title), ch: r0.shortBylineText.runs[0], set: r0.setVideoId };
	const row = clean(pvl.contents[0]);
	const pr = row.playlistVideoRenderer;
	pr.menu.menuRenderer.items = pr.menu.menuRenderer.items.filter((it: any) => !it.menuServiceItemDownloadRenderer);
	pr.thumbnailOverlays = pr.thumbnailOverlays.filter((o: any) => !o.thumbnailOverlayPlaybackStatusRenderer && !o.thumbnailOverlayResumePlaybackRenderer);
	const we = pr.navigationEndpoint.watchEndpoint;
	delete we.startTimeSeconds;
	delete we.params;
	we.index = "{{INDEX}}";
	pr.index.simpleText = "{{POSITION}}";
	pr.lengthSeconds = "{{LENGTH_SECONDS}}";
	wholeToken(pr, "thumbnails", "ROW_THUMBS", (x) => /ytimg/.test(JSON.stringify(x.thumbnails)));
	pr.videoInfo.runs[0].text = "{{VIEWS}}";
	pr.videoInfo.runs[2].text = "{{PUBLISHED}}";
	const remove = pr.menu.menuRenderer.items.find((it: any) => it.menuServiceItemRenderer?.icon?.iconType === "DELETE").menuServiceItemRenderer;
	remove.text.runs[1].text = "{{TITLE}}";
	let rowOut = dropKey(dropKey(row, "playerParams"), "loggingContext");
	rowOut = tokenize(
		rowOut,
		[[v.id, "VIDEO_ID"], [v.title, "VIDEO_TITLE"], [v.ch.navigationEndpoint.browseEndpoint.browseId, "CHANNEL_ID"], [v.ch.navigationEndpoint.browseEndpoint.canonicalBaseUrl, "CHANNEL_URL"], [r0.lengthText.accessibility.accessibilityData.label, "DURATION_LABEL"], [v.set, "SET_VIDEO_ID"]],
		[[v.id, "VIDEO_ID"]],
		[[v.ch.text, "CHANNEL_NAME"], [contentOf(r0.lengthText), "DURATION"], ["WL", "PLAYLIST_ID"]],
	);
	rowOut = strings(rowOut, (x) =>
		x
			.replace(/([?&]list=)WL\b/, "$1{{PLAYLIST_ID}}")
			.replace(/&pp=[^&"]*/, "")
			.replace(/&index=\d+(&t=\d+s)?/, "&index={{POSITION}}")
			.replace(/^\{\{VIDEO_TITLE\}\} .+$/, "{{VIDEO_TITLE}} {{LENGTH_WORDS}}"),
	);
	save("item/playlist_row_own", rowOut, [v.id, v.title, v.ch.text, v.set]);
	pvl.contents = "{{ITEMS}}";
	const order = pvl.sortFilterMenu.sortFilterSubMenuRenderer.subMenuItems;
	order.forEach((it: any, i: number) => (it.selected = `{{ORDER_${i}_SELECTED}}`));
	// the sort dropdown above the list: the current order's name, the choices
	const chip = isr.header.chipBarViewModel.chips[0].chipViewModel;
	chip.text = "{{ORDER_LABEL}}";
	find(chip, "listItems").forEach((it: any, i: number) => (it.listItemViewModel.isSelected = `{{ORDER_${i}_SELECTED}}`));
	let out = dropKey(dropKey(p, "playerParams"), "loggingContext");
	stripAppLinks(out);
	out = strings(out, (x) =>
		x.split(first).join("{{FIRST_VIDEO_ID}}").split(shuffleId).join("{{SHUFFLE_VIDEO_ID}}").replace(/([?&]list=)WL\b/, "$1{{PLAYLIST_ID}}").replace(/&pp=[^&"]*/, "").replace("from Watch later.", "from {{TITLE}}."),
	);
	out = strings(out, (x) => x.replace(/^WL:/, "{{PLAYLIST_ID}}:"));
	out = tokenize(out, [], [["WL", "PLAYLIST_ID"]], [["WL", "PLAYLIST_ID"], ["Watch later", "TITLE"], [count, "VIDEO_COUNT_NUM"]]);
	save("playlist/page_own", out, [first, shuffleId, updated]);
}

// ======================================================================
// watch history: the day sections (videos, and each day's Shorts in a reel
// shelf), the All/Videos/Shorts/Music chips, searching the history, removing
// an entry, clearing it all, pausing it, and the My Activity links (which
// lead to the instance's own activity pages)
const HISTORY_CHIPS: Record<string, string> = { All: "ALL", Videos: "VIDEOS", Shorts: "SHORTS", Music: "MUSIC" };
const ACTIVITY_LINKS: Record<string, string> = { "Manage all history": "ACTIVITY_URL", Comments: "ACTIVITY_COMMENTS_URL", Posts: "ACTIVITY_POSTS_URL", "Live chat": "ACTIVITY_LIVE_CHAT_URL" };
function history() {
	const p = pageOnly(pageVar(body("in-history2", /^001-/)));
	const t = p.contents.twoColumnBrowseResultsRenderer;
	const acts = t.secondaryContents.browseFeedActionsRenderer;
	const box = acts.contents.find((c: any) => c.searchBoxRenderer).searchBoxRenderer;
	box.endpoint.browseEndpoint.query = "{{QUERY}}";
	const button = (text: string) => acts.contents.find((c: any) => contentOf(c.buttonRenderer?.text) === text);
	// the account line of a dialog, and its link to Google's My Activity
	const dialog = (b: any, token: string) => {
		const dlg = find(b, "confirmDialogRenderer");
		const runs = dlg.dialogMessages[0].runs;
		runs[0].text = "{{VIEWER_NAME}} ({{VIEWER_AT_HANDLE}})";
		for (const r of runs) if (r.navigationEndpoint?.urlEndpoint) r.navigationEndpoint = { commandMetadata: { webCommandMetadata: { url: "{{ACTIVITY_URL}}", webPageType: "WEB_PAGE_TYPE_UNKNOWN", rootVe: 83769 } }, urlEndpoint: { url: "{{ACTIVITY_URL}}", target: "TARGET_NEW_WINDOW" } };
		for (const fe of findAll(b, "feedbackEndpoint")) fe.feedbackToken = `{{${token}}}`;
	};
	dialog(button("Clear all watch history"), "CLEAR_TOKEN");
	// Pause: its own template, in the slot the page keeps for the toggle
	const pause = clean(button("Pause watch history"));
	dialog(pause, "PAUSE_TOKEN");
	save("history/pause_button", tokenize(pause, []));
	// paused, the toggle turns it back on: "Turn on watch history" (YouTube's
	// wording; no capture of the paused page, so it acts without a dialog)
	const resume = structuredClone(pause);
	const rb = resume.buttonRenderer;
	rb.text.runs[0].text = "Turn on watch history";
	rb.icon.iconType = "PLAY_OUTLINED";
	const fe = find(rb.navigationEndpoint, "confirmEndpoint");
	fe.feedbackEndpoint.feedbackToken = "{{RESUME_TOKEN}}";
	fe.feedbackEndpoint.actions = [{ localWatchHistoryCommand: { localWatchHistoryCommandType: "LOCAL_WATCH_HISTORY_COMMAND_TYPE_RESUME" } }];
	delete rb.navigationEndpoint;
	rb.serviceEndpoint = fe;
	save("history/resume_button", tokenize(resume, []));
	acts.contents[acts.contents.indexOf(button("Pause watch history"))] = "{{PAUSE_TOGGLE}}";
	for (const c of acts.contents) {
		const r = c.buttonRenderer ?? c.compactLinkRenderer;
		const tok = r && ACTIVITY_LINKS[contentOf(r.text ?? r.title)];
		if (!tok) continue;
		r.navigationEndpoint.commandMetadata.webCommandMetadata.url = `{{${tok}}}`;
		r.navigationEndpoint.urlEndpoint.url = `{{${tok}}}`;
	}
	const sl = t.tabs[0].tabRenderer.content.sectionListRenderer;
	for (const c of sl.header.chipBarViewModel.chips) c.chipViewModel.selected = `{{CHIP_${HISTORY_CHIPS[c.chipViewModel.text]}_SELECTED}}`;
	// one day: its heading and entries
	const sec = clean(sl.contents.find((c: any) => c.itemSectionRenderer?.contents?.some((x: any) => x.lockupViewModel)));
	const sample = sec.itemSectionRenderer.contents.find((x: any) => x.lockupViewModel);
	sec.itemSectionRenderer.contents = "{{ITEMS}}";
	sec.itemSectionRenderer.header.itemSectionHeaderRenderer.title.simpleText = "{{DAY}}";
	save("history/section", sec);
	const keep = new Set([...LOCKUP_MENU, "Remove from watch history"]);
	const item = structuredClone(sample);
	for (const list of findAll(item, "listItems")) for (let i = list.length - 1; i >= 0; i--) if (!keep.has(itemTitle(list[i]))) list.splice(i, 1);
	delete item.lockupViewModel.themedPalette; // colours taken from the sample's thumbnail
	const remove = findAll(item, "feedbackEndpoint")[0];
	remove.feedbackToken = "{{REMOVE_TOKEN}}";
	const bar = find(item, "thumbnailOverlayProgressBarViewModel");
	if (bar) bar.startPercent = "{{WATCHED_PERCENT}}";
	// a partly watched entry resumes where the viewer stopped: &t=, and the
	// watch endpoint's startTimeSeconds and params (field 39, the seconds)
	const resumeAt = find(item, "startTimeSeconds");
	if (!resumeAt) throw new Error("the history sample has no resume position");
	for (const h of findAllHolders(item, "startTimeSeconds")) Object.assign(h, { params: "{{RESUME_PARAMS}}", startTimeSeconds: "{{RESUME_SECONDS}}" });
	const { item: tokenized, samples } = videoLockup(strings(item, (x) => x.replace(`&t=${resumeAt}s`, "{{RESUME_T}}")));
	save("item/video_lockup_history", tokenized, samples);
	sl.contents = "{{CONTENTS}}";
	save("history/page", tokenize(p, [], [], [["", "QUERY"]]));

	// a day's Shorts: YouTube's reel shelf (with its Send feedback menu) of
	// shorts lockups that can be removed from the history
	const shorts = JSON.parse(body("in-history-chips", /^007-/));
	const ssec = shorts.contents.twoColumnBrowseResultsRenderer.tabs[0].tabRenderer.content.sectionListRenderer.contents.find((c: any) => find(c, "reelShelfRenderer"));
	const shelf = clean(structuredClone(find(ssec, "reelShelfRenderer")));
	const sitem = shelf.items[0];
	shelf.items = "{{ITEMS}}";
	save("history/shorts_shelf", { reelShelfRenderer: tokenize(shelf, []) });
	const lv = sitem.shortsLockupViewModel;
	const id: string = lv.onTap.innertubeCommand.reelWatchEndpoint.videoId;
	const title: string = lv.overlayMetadata.primaryText.content;
	const views: string = lv.overlayMetadata.secondaryText.content;
	for (const list of findAll(sitem, "listItems")) for (let i = list.length - 1; i >= 0; i--) if (!new Set([...keep, "Send feedback"]).has(itemTitle(list[i]))) list.splice(i, 1);
	for (const k of ["inlinePopStateEntityKey", "indexInCollection", "stackedFrameData"]) delete lv[k];
	const reel = lv.onTap.innertubeCommand.reelWatchEndpoint;
	for (const k of ["playerParams", "params", "sequenceParams", "loggingContext", "ustreamerConfig"]) delete reel[k];
	reel.thumbnail.thumbnails = "{{REEL_THUMBS}}";
	lv.thumbnailViewModel.thumbnailViewModel.image.sources = "{{THUMBS}}";
	lv.accessibilityText = "{{A11Y}}";
	for (const fe of findAll(sitem, "feedbackEndpoint")) fe.feedbackToken = "{{REMOVE_TOKEN}}";
	let si = dropKey(sitem, "playerParams");
	si = strings(si, (x) => x.replace(/&pp=[^&"]*/, ""));
	si = tokenize(si, [[id, "VIDEO_ID"], [title, "TITLE"], [views, "VIEWS_SHORT"]], [[id, "VIDEO_ID"]]);
	save("item/shorts_lockup_history", si, [id, title]);

	// signed out: the sign-in prompt (the device-history buttons are left out)
	const out = pageOnly(pageVar(body("feed-history", /^001-/)));
	delete out.contents.twoColumnBrowseResultsRenderer.secondaryContents;
	dropGoogleHelp(out);
	save("history/signed_out", tokenize(out, []));
}

// ======================================================================
// the You page and the library feeds it links to (Playlists, All
// subscriptions). Left out: "Switch account" and "Google Account" (one
// local account per sign-in), the Music filter chip, the playlist editor
// panel (playlists are edited on their own page) and resume positions
const resumeFree = (o: any) => strings(dropKey(o, "startTimeSeconds"), (x) => x.replace(/&t=\d+s/, "").replace(/&pp=[^&"]*/, ""));
// "Private" / "Unlisted" / "Public" before "Playlist"
const visibilityToken = (item: any) => (find(item, "metadataRows")[0].metadataParts[0].text.content = "{{VISIBILITY}}");
const shelfOf = (c: any) => c.richSectionRenderer.content.richShelfRenderer;
// a sort dropdown chip: its label and each choice's token and selection
function sortChip(chip: any, targetId: string) {
	const cv = chip.chipViewModel;
	cv.text = cv.accessibilityLabel = "{{SORT_LABEL}}";
	find(cv, "listItems").forEach((it: any, i: number) => {
		const li = it.listItemViewModel;
		li.isSelected = `{{SORT_${i}_SELECTED}}`;
		delete li.entityKey;
		const cc = find(li, "continuationCommand");
		cc.token = `{{SORT_${i}}}`;
		cc.command.showReloadUiCommand.targetId = targetId;
	});
}
// New playlist dialogs: collaborative playlists are not offered
function noCollaboration(o: any) {
	const form = find(o, "createPlaylistDialogFormViewModel");
	if (!form) return;
	delete form.playlistCollaborate;
	delete form.createPlaylistParamsCollaborationEnabled;
	form.disablePlaylistCollaborate = true;
	delete form.createPlaylistDialogFormSchema.fieldSchemas.visibility; // its only rule concerns collaboration
}
function library() {
	const own = pageVar(body("in-own-channel", /^001-/)).metadata.channelMetadataRenderer;
	const vid: string = own.externalId;
	const viewerPairs: [string, string][] = [[`/channel/${vid}`, "VIEWER_CHANNEL_URL"], [vid, "VIEWER_CHANNEL_ID"]];
	const viewerExact: [string, string][] = [[own.title, "VIEWER_NAME"], [`@${own.vanityChannelUrl.split("/@")[1]}`, "VIEWER_AT_HANDLE"]];

	// --- You ---
	const you = pageOnly(pageVar(body("in-feed-you", /^002-/)));
	const ph = you.header.pageHeaderRenderer.content.pageHeaderViewModel;
	delete ph.actions; // Switch account, Google Account
	wholeToken(ph.image, "sources", "VIEWER_AVATAR_XL");
	const g = gridOf(you);
	const shelves: Record<string, any> = {};
	for (const c of g.contents) shelves[contentOf(shelfOf(c).title)] = c;
	const lockupFrom = (shelf: any, keep: Set<string>) => {
		const sample = structuredClone(shelfOf(shelf).contents.find((x: any) => x.richItemRenderer?.content?.lockupViewModel));
		for (const list of findAll(sample, "listItems")) for (let i = list.length - 1; i >= 0; i--) if (!keep.has(itemTitle(list[i]))) list.splice(i, 1);
		delete find(sample, "lockupViewModel").themedPalette;
		const bar = find(sample, "thumbnailOverlayProgressBarViewModel");
		if (bar) bar.startPercent = "{{WATCHED_PERCENT}}";
		return sample;
	};
	// History: lockups that can be removed from the history
	const hs = lockupFrom(shelves.History, new Set([...LOCKUP_MENU, "Remove from watch history"]));
	findAll(hs, "feedbackEndpoint")[0].feedbackToken = "{{REMOVE_TOKEN}}";
	const hl = videoLockup(hs);
	save("item/video_lockup_you_history", resumeFree(hl.item), hl.samples);
	// Watch later: removing from the list instead of saving to it
	const wl = lockupFrom(shelves["Watch later"], new Set([...LOCKUP_MENU, "Remove from Watch later"]));
	const wll = videoLockup(wl);
	save("item/video_lockup_you_wl", resumeFree(wll.item), wll.samples);
	const ll = lockupFrom(shelves["Liked videos"], LOCKUP_MENU);
	const lll = videoLockup(ll);
	save("item/video_lockup_you", resumeFree(lll.item), lll.samples);
	noCollaboration(shelves.Playlists);
	for (const [title, name] of [["History", "history"], ["Playlists", "playlists"], ["Watch later", "wl"], ["Liked videos", "ll"]] as const) {
		const s = clean(shelves[title]);
		const sh = shelfOf(s);
		sh.contents = "{{ITEMS}}";
		if (sh.subtitle) sh.subtitle.runs = [{ text: "{{VIDEO_COUNT_NUM}}" }, { text: "{{VIDEOS_WORD}}" }];
		save(`you/shelf_${name}`, tokenize(s, []));
	}
	g.contents = "{{SHELVES}}";
	save("you/page", tokenize(you, viewerPairs, [[vid, "VIEWER_CHANNEL_ID"]], viewerExact));
	save("you/signed_out", tokenize(pageOnly(pageVar(body("feed-you", /^001-/))), []));

	// --- Playlists ---
	const pl = pageOnly(pageVar(body("in-playlists", /^001-/)));
	const pg = gridOf(pl);
	const target = "browse-feedFEplaylist_aggregation";
	const [sort, ...filters] = pg.header.chipBarViewModel.chips;
	sortChip(sort, target);
	pg.header.chipBarViewModel.chips = [sort, ...filters.filter((c: any) => c.chipViewModel.text !== "Music")];
	for (const c of pg.header.chipBarViewModel.chips.slice(1)) {
		const cv = c.chipViewModel;
		const k = cv.text.toUpperCase();
		cv.selected = `{{CHIP_${k}_SELECTED}}`;
		const be = find(cv, "browseEndpoint");
		be.params = `{{CHIP_${k}}}`;
		delete be.nofollow;
	}
	pg.targetId = target;
	// the viewer's own playlist (Delete; Edit opens YouTube's editor panel);
	// the You page's Playlists shelf uses the same card
	const mine = clean(pg.contents.find((x: any) => find(x, "deletePlaylistEndpoint")));
	for (const list of findAll(mine, "listItems")) for (let i = list.length - 1; i >= 0; i--) if (itemTitle(list[i]) !== "Delete") list.splice(i, 1);
	visibilityToken(mine);
	save("item/playlist_lockup_feed", resumeFree(dropKey(dropKey(playlistLockup(mine), "playerParams"), "loggingContext")));
	pg.contents = "{{ITEMS}}";
	save("playlists/page", tokenize(pl, []));

	// --- All subscriptions ---
	const ch = pageOnly(pageVar(body("in-channels", /^001-/)));
	const sl = ch.contents.twoColumnBrowseResultsRenderer.tabs[0].tabRenderer.content.sectionListRenderer;
	sortChip(sl.header.chipBarViewModel.chips[0], "browse-feedFEchannels");
	const shelf = find(sl, "expandedShelfContentsRenderer");
	const cr = clean(shelf.items[0]).channelRenderer;
	wholeToken(cr, "thumbnails", "AVATAR_88_176");
	cr.descriptionSnippet = { runs: [{ text: "{{DESCRIPTION_SHORT}}" }] };
	cr.subscribeButton = "{{SUBSCRIBE_BUTTON}}";
	delete cr.ownerBadges; // verification belongs to YouTube's channels
	const handle = contentOf(cr.subscriberCountText);
	const chItem = tokenize(
		{ channelRenderer: cr },
		[[cr.channelId, "CHANNEL_ID"], [cr.navigationEndpoint.browseEndpoint.canonicalBaseUrl, "CHANNEL_URL"]],
		[[cr.channelId, "CHANNEL_ID"]],
		[[contentOf(cr.title), "CHANNEL_NAME"], [handle, "AT_HANDLE"], [contentOf(cr.videoCountText), "SUBSCRIBERS"], [cr.videoCountText.accessibility.accessibilityData.label, "SUBSCRIBERS_LABEL"]],
	);
	save("item/channel_subscribed", chItem, [cr.channelId, contentOf(cr.title)]);
	shelf.items = "{{ITEMS}}";
	save("subscriptions/channels", tokenize(ch, []));
}

// ======================================================================
// the Save sheet (get_panel PAadd_to_playlist): one toggle row per playlist
// and New playlist in the footer
function saveSheet() {
	const [[req, resp]] = bodies("in-save", /get_panel\.resp$/);
	const params: string = req.params;
	const sheet = clean(resp);
	const sv = sheet.content.sheetViewModel;
	const rows = sv.content.listViewModel.listItems;
	const vid: string = find(rows, "addedVideoId");
	noCollaboration(sv.footer);
	sv.content.listViewModel.listItems = "{{ITEMS}}";
	delete sv.content.listViewModel.visibleElementCount;
	sheet.frameworkUpdates.entityBatchUpdate.timestamp = "{{TIMESTAMP}}";
	save("playlist/save_sheet", tokenize(sheet, [[params, "PARAMS"]], [[vid, "VIDEO_ID"]], [[vid, "VIDEO_ID"]]), [vid]);

	// a user playlist's row (Watch later's differs only in its values)
	const row = rows.find((r: any) => find(r, "playlistId") !== "WL").toggleableListItemViewModel;
	const pid: string = find(row, "playlistId");
	const title = contentOf(row.defaultListItem.listItemViewModel.title);
	delete row.rendererContext;
	row.initialState.isToggled = "{{TOGGLED}}";
	for (const li of [row.defaultListItem, row.toggledListItem]) {
		const lv = li.listItemViewModel;
		const a = lv.rendererContext.accessibilityContext;
		a.label = a.label.replace(`${title}, ${contentOf(lv.subtitle)}`, "{{TITLE}}, {{VISIBILITY}}");
		lv.title.content = "{{TITLE}}";
		lv.subtitle.content = "{{VISIBILITY}}";
		wholeToken(lv.leadingAccessory, "sources", "THUMBS");
		const snack = find(lv, "snackbarViewModel");
		snack.text.content = snack.text.content.replace(title, "{{TITLE}}");
		if (snack.image) wholeToken(snack.image, "sources", "VIDEO_THUMBS");
	}
	save("item/save_row", tokenize({ toggleableListItemViewModel: row }, [[pid, "PLAYLIST_ID"]], [[vid, "VIDEO_ID"]], [[vid, "VIDEO_ID"], [params, "PARAMS"]]), [vid, pid, title]);
}

// ======================================================================
// the playlist beside a watch page (&list=): its rows, loop and shuffle,
// and Save playlist to Library. Left out: verification badges, Download,
// the rows' sampled colour palettes and collaborator dialogs (one channel
// per video here)
function playlistPanelTpl() {
	const [[, resp]] = bodies("playlist-watch", /get_watch\.resp$/);
	const pl = clean(find(resp, "playlist")).playlist;
	const pid: string = pl.playlistId;
	const total = String(pl.totalVideos);
	const owner = contentOf(pl.ownerName);
	const ownerEp = find(pl.shortBylineText, "browseEndpoint");
	const sample = pl.contents.find((c: any) => !find(c, "showDialogCommand") && !c.playlistPanelVideoRenderer.selected);
	const r = sample.playlistPanelVideoRenderer;
	const vid: string = r.videoId;
	const ep = find(r.longBylineText, "browseEndpoint");
	const title = contentOf(r.title);
	const index: number = r.navigationEndpoint.watchEndpoint.index;
	for (const k of ["lightColorPalette", "darkColorPalette"]) delete r[k];
	const menu = r.menu.menuRenderer;
	menu.items = menu.items.filter((i: any) => !i.menuServiceItemDownloadRenderer);
	r.indexText.simpleText = "{{INDEX_TEXT}}";
	r.selected = "{{SELECTED}}";
	r.navigationEndpoint.watchEndpoint.index = "{{INDEX}}";
	delete r.navigationEndpoint.watchEndpoint.loggingContext;
	delete r.navigationEndpoint.watchEndpoint.playerParams;
	r.navigationEndpoint.commandMetadata.webCommandMetadata.url = `/watch?v={{VIDEO_ID}}&list={{PLAYLIST_ID}}&index={{INDEX_1}}`;
	r.playlistSetVideoId = "{{SET_VIDEO_ID}}";
	wholeToken(r.thumbnail, "thumbnails", "THUMBS");
	const row = tokenize(
		sample,
		[[pid, "PLAYLIST_ID"], [vid, "VIDEO_ID"], [ep.canonicalBaseUrl, "CHANNEL_URL"], [ep.browseId, "CHANNEL_ID"]],
		[[vid, "VIDEO_ID"], [pid, "PLAYLIST_ID"]],
		[[title, "TITLE"], [contentOf(r.lengthText), "DURATION"], [r.lengthText.accessibility.accessibilityData.label, "DURATION_LABEL"], [contentOf(r.longBylineText), "CHANNEL_NAME"], [`${title} ${r.lengthText.accessibility.accessibilityData.label}`, "TITLE_LABEL"]],
	);
	save("item/playlist_panel_video", row, [vid, pid, title, ep.browseId]);

	delete pl.ownerBadges;
	pl.contents = "{{ITEMS}}";
	pl.currentIndex = pl.localCurrentIndex = "{{CURRENT_INDEX}}";
	pl.totalVideos = "{{TOTAL_VIDEOS}}";
	pl.playlistShareUrl = "{{SHARE_URL}}";
	pl.videoCountText.runs = [{ text: "{{CURRENT_1}}" }, { text: " / " }, { text: total }];
	find(pl.menu, "toggleMenuServiceItemRenderer").isToggled = "{{SAVED}}";
	const panel = tokenize(
		{ playlist: pl },
		[[pid, "PLAYLIST_ID"], [ownerEp.canonicalBaseUrl, "CHANNEL_URL"], [ownerEp.browseId, "CHANNEL_ID"]],
		[[pid, "PLAYLIST_ID"]],
		[[contentOf(pl.titleText), "TITLE"], [owner, "OWNER_NAME"], [total, "TOTAL_TEXT"]],
	);
	save("watch/playlist_panel", panel, [pid, owner, ownerEp.browseId]);
}

// ======================================================================
// the Share dialog (share/get_share_panel): the link, Start at, and the
// share targets, which open the link on other sites. Left out: Embed (no
// embed player here) and the attribution id YouTube adds to shared links
function sharePanel() {
	const [[req, resp]] = bodies("share-out", /get_share_panel\.resp$/);
	const id = decodeURIComponent(req.post.serializedSharedEntity);
	const vid = /\x0a\x0b([A-Za-z0-9_-]{11})/.exec(Buffer.from(id, "base64").toString("latin1"))![1];
	const r = clean(resp);
	const u = r.actions[0].openPopupAction.popup.unifiedSharePanelRenderer;
	const tp = u.contents[0].thirdPartyNetworkSection;
	const targets = tp.shareTargetContainer.thirdPartyShareTargetSectionRenderer;
	targets.shareTargets = targets.shareTargets.filter((t: any) => t.shareTargetRenderer.serviceName !== "EMBED");
	const short: string = tp.copyLinkContainer.copyLinkRenderer.shortUrl;
	const si = /[?&]si=([\w-]+)/.exec(short)![1];
	const title = find(targets, "url", (x) => /twitter/.test(x)).match(/&text=([^&]*)/)[1];
	tp.copyLinkContainer.copyLinkRenderer.shortUrl = "{{SHARE_URL}}";
	const out = strings(r, (s) =>
		s
			.replace(new RegExp(`https%3A//youtu\\.be/${vid}%3Fsi%3D${si}`, "g"), "{{SHARE_URL_ENC}}")
			.replace(new RegExp(`https%3A//youtube\\.com/watch%3Fv%3D${vid}%26si%3D${si}`, "g"), "{{SHARE_URL_ENC}}")
			.replace(`https%3A//i.ytimg.com/vi/${vid}/maxresdefault.jpg`, "{{THUMB_ENC}}")
			.replace(/&summary=[^&]*/, "&summary={{SUMMARY_ENC}}")
			.split(title)
			.join("{{SHARE_TITLE_ENC}}"),
	);
	save("share/panel", out, [vid, si, title]);
}

// ======================================================================
// comments: the section header (count, sort, composer), threads, replies,
// and the entity payloads each comment's view model points to.
// Left out: translation, creator hearts, profile cards (the author links
// to the channel instead), custom emoji and the emoji picker, and nested
// reply threads (replies are one level deep here)
const COMMENT_MUTATIONS = ["commentEntityPayload", "commentSurfaceEntityPayload", "engagementToolbarSurfaceEntityPayload", "engagementToolbarStateEntityPayload"];
const payloadKind = (m: any) => Object.keys(m.payload ?? {})[0];

// one comment: its renderer and its entity mutations, with the sample's values as tokens
function commentTpl(item: any, all: any[], signedIn: boolean) {
	const vm = find(item, "commentViewModel").commentViewModel ?? find(item, "commentViewModel");
	const keys: Record<string, string> = { [vm.commentKey]: "COMMENT_KEY", [vm.toolbarStateKey]: "TOOLBAR_STATE_KEY", [vm.toolbarSurfaceKey]: "TOOLBAR_SURFACE_KEY", [vm.commentSurfaceKey]: "SURFACE_KEY", [vm.sharedKey]: "SHARED_KEY" };
	const muts = clean(all.filter((m: any) => m.entityKey in keys && COMMENT_MUTATIONS.includes(payloadKind(m))));
	muts.sort((a: any, b: any) => COMMENT_MUTATIONS.indexOf(payloadKind(a)) - COMMENT_MUTATIONS.indexOf(payloadKind(b)));
	const entity = muts[0].payload.commentEntityPayload;
	const p = entity.properties;
	const a = entity.author;
	const t = entity.toolbar;
	const handle: string = a.displayName;
	// signed in, channelCommand opens a profile card and channelPageEndpoint the channel
	const channelCmd = a.channelPageEndpoint ?? a.channelCommand;
	const channelUrl: string = channelCmd.innertubeCommand.browseEndpoint.canonicalBaseUrl;
	const videoId: string = find(muts, "watchEndpoint").videoId;
	const samples = [p.commentId, a.channelId, handle, p.content.content];
	// no translation, hearts or profile cards
	delete p.translateButtonEntityKey;
	delete t.heartActiveTooltip;
	delete entity.readMoreLogging;
	a.channelCommand = channelCmd;
	delete a.profileCardEndpoint;
	a.avatarThumbnailUrl = "{{AUTHOR_AVATAR_URL}}";
	a.isCurrentUser = "{{IS_CURRENT_USER}}";
	a.isCreator = "{{IS_CREATOR}}";
	a.isVerified = false;
	a.isArtist = false;
	p.content = { content: "{{TEXT}}" };
	const surface = muts[1].payload.commentSurfaceEntityPayload;
	surface.avatar.avatarViewModel.endpoint = channelCmd;
	surface.avatar.avatarViewModel.image.sources = "{{AUTHOR_AVATAR}}";
	const pt = surface.publishedTimeCommand.innertubeCommand;
	pt.commandMetadata.webCommandMetadata.url = "/watch?v={{VIDEO_ID}}&lc={{COMMENT_ID}}";
	pt.watchEndpoint = { videoId: "{{VIDEO_ID}}" };
	const bar = muts[2].payload.engagementToolbarSurfaceEntityPayload;
	if (signedIn) {
		for (const [cmd, tok] of [["likeCommand", "LIKE"], ["unlikeCommand", "UNLIKE"], ["dislikeCommand", "DISLIKE"], ["undislikeCommand", "UNDISLIKE"]]) {
			const ep = bar[cmd].innertubeCommand.performCommentActionEndpoint;
			ep.action = `{{${tok}_ACTION}}`;
			const vote = ep.clientActions[0].updateCommentVoteAction.voteCount;
			const liked = tok === "LIKE";
			vote.simpleText = liked ? "{{LIKES_LIKED}}" : "{{LIKES}}";
			vote.accessibility.accessibilityData.label = liked ? "{{LIKES_LIKED_A11Y}}" : "{{LIKES_A11Y}}";
		}
		// the action menu (Report on others' comments): MENU_ITEMS, or none
		if (bar.menuCommand) find(bar.menuCommand, "menuRenderer").items = "{{MENU_ITEMS}}";
		const dlg = find(bar, "commentReplyDialogRenderer");
		if (dlg) {
			delete dlg.emojiButton;
			delete dlg.emojiPicker;
			delete dlg.aadcGuidelinesStateEntityKey;
			// replying to a reply starts with a mention of its author
			if (dlg.editableText) {
				const run = dlg.editableText.runs[0];
				run.text = "\u00a0{{AUTHOR_AT_HANDLE}}\u00a0";
				run.navigationEndpoint = { commandMetadata: { webCommandMetadata: { url: "{{AUTHOR_URL}}", webPageType: "WEB_PAGE_TYPE_CHANNEL", rootVe: 3611, apiUrl: "/youtubei/v1/browse" } }, browseEndpoint: { browseId: "{{AUTHOR_CHANNEL_ID}}" } };
			}
			dlg.authorThumbnail.thumbnails = "{{VIEWER_THUMBS}}";
			dlg.authorThumbnail.accessibility.accessibilityData.label = "{{VIEWER_NAME}}";
			find(dlg, "createCommentReplyEndpoint").createReplyParams = "{{REPLY_PARAMS}}";
		}
	}
	t.likeCountLiked = "{{LIKES_LIKED}}";
	t.likeCountNotliked = "{{LIKES}}";
	t.likeButtonA11y = "{{LIKE_BUTTON_A11Y}}";
	t.likeCountA11y = "{{LIKES_A11Y}}";
	if ("replyCount" in t) t.replyCount = "{{REPLY_COUNT}}";
	if ("replyCountA11y" in t) t.replyCountA11y = "{{REPLY_COUNT_A11Y}}";
	p.publishedTime = "{{PUBLISHED}}";
	// the renderer: our keys; no translation or profile cards
	const r = clean(item);
	const rvm = find(r, "commentViewModel").commentViewModel ?? find(r, "commentViewModel");
	rvm.allowProfileCard = false;
	let out: any = { item: r, mutations: muts };
	out = strings(out, (s) => (s in keys ? `{{${keys[s]}}}` : s));
	out = tokenize(out, [[p.commentId, "COMMENT_ID"], [videoId, "VIDEO_ID"], [channelUrl, "AUTHOR_URL"], [a.channelId, "AUTHOR_CHANNEL_ID"]], [[a.channelId, "AUTHOR_CHANNEL_ID"]], [[handle, "AUTHOR_AT_HANDLE"]]);
	return { ...out, samples };
}

function commentsStep(dir: string, reloadRe: RegExp, repliesRe: RegExp, signedIn: boolean) {
	const io = signedIn ? "in" : "out";
	const [[, reload]] = bodies(dir, reloadRe).filter(([, res]) => res.onResponseReceivedEndpoints?.[0]?.reloadContinuationItemsCommand?.targetId === "comments-section");
	const all = reload.frameworkUpdates.entityBatchUpdate.mutations;
	const [headerCmd, bodyCmd] = reload.onResponseReceivedEndpoints.map((e: any) => e.reloadContinuationItemsCommand);
	// header
	const header = clean(headerCmd.continuationItems[0]);
	const hr = header.commentsHeaderRenderer;
	delete hr.customEmojis;
	delete hr.unicodeEmojisUrl;
	const box = hr.createRenderer.commentSimpleboxRenderer;
	delete box.emojiButton;
	delete box.emojiPicker;
	delete box.aadcGuidelinesStateEntityKey;
	delete box.disabledTextUrl; // Google's help page
	box.authorThumbnail.thumbnails = "{{VIEWER_THUMBS}}";
	box.authorThumbnail.accessibility.accessibilityData.label = signedIn ? "{{VIEWER_NAME}}" : box.authorThumbnail.accessibility.accessibilityData.label;
	if (signedIn) find(box, "createCommentEndpoint").createCommentParams = "{{CREATE_PARAMS}}";
	hr.countText.runs = [{ text: "{{COUNT}}" }, { text: "{{COMMENTS_WORD}}" }];
	hr.commentsCount.runs = [{ text: "{{COUNT_SHORT}}" }];
	for (const it of hr.sortMenu.sortFilterSubMenuRenderer.subMenuItems) {
		const k = it.title === "Top" ? "TOP" : "NEW";
		it.selected = `{{SORT_${k}_SELECTED}}`;
		it.serviceEndpoint.continuationCommand.token = `{{SORT_${k}}}`;
	}
	save(`comments/header_${io}`, tokenize(header, []));
	// a thread with replies
	const threadSample = bodyCmd.continuationItems.find((x: any) => x.commentThreadRenderer?.replies);
	const th = commentTpl(threadSample, all, signedIn);
	const rr = find(th.item, "commentRepliesRenderer");
	rr.viewReplies.buttonRenderer.text.runs = [{ text: "{{REPLIES_TEXT}}" }];
	find(rr, "continuationCommand").token = "{{REPLIES_TOKEN}}";
	save(`item/comment_thread_${io}`, th.item, th.samples);
	save(`comments/entities_${io}`, th.mutations, th.samples);
	// the shared strings every response carries
	const shared = clean(all.find((m: any) => payloadKind(m) === "commentSharedEntityPayload"));
	const ts = shared.payload.commentSharedEntityPayload.toolbarShared;
	for (const k of Object.keys(ts)) if (/heart/i.test(k)) delete ts[k];
	save(`comments/shared_${io}`, strings(shared, (s) => (s === shared.entityKey ? "{{SHARED_KEY}}" : s)));
	// a reply (one without replies of its own), its entities and "Show more replies"
	const [[, replies]] = bodies(dir, repliesRe).filter(([, res]) => res.onResponseReceivedEndpoints?.[0]?.appendContinuationItemsAction?.targetId?.startsWith("comment-replies-item-"));
	const items = replies.onResponseReceivedEndpoints[0].appendContinuationItemsAction.continuationItems;
	const reply = commentTpl(items.find((x: any) => x.commentThreadRenderer && !x.commentThreadRenderer.replies), replies.frameworkUpdates.entityBatchUpdate.mutations, signedIn);
	save(`item/comment_reply_${io}`, reply.item, reply.samples);
	save(`comments/entities_reply_${io}`, reply.mutations, reply.samples);
	const more = clean(items.find((x: any) => x.continuationItemRenderer));
	if (more) {
		find(more, "continuationCommand").token = "{{CONTINUATION}}";
		save("item/continuation_replies", more);
	}
}

function comments() {
	commentsStep("comments-out", /next\.resp$/, /next\.resp$/, false);
	commentsStep("in-comments2", /next\.resp$/, /next\.resp$/, true);
}


// YouTube Studio: the channel object (CreatorChannelData) the page prefetches
// and creator/get_creator_channels returns, merged from both, every field
// either answer had
// Verification badges, which the item templates leave out (they belonged to
// the captured channels): the owner badge of the older renderers, the image
// attached after a name in text view models (24 px in channel headers, 14 px
// elsewhere), and the icon on a lockup's channel-name part. src/innertube/
// badges.ts adds them for channels an operator has verified.
function badges() {
	const strip = (o: any) => clean(o);
	const watchHtml = pageVar(body("watch", /_watch\.resp$/));
	const owner = find(watchHtml, "videoOwnerRenderer");
	const verified = owner.badges.find((b: any) => b.metadataBadgeRenderer?.style === "BADGE_STYLE_TYPE_VERIFIED");
	save("badge/verified_owner", strip(verified));
	// a name's text with the badge attached at its end: the run that colours
	// the badge and the attachment, both starting at the name's length
	const run = (text: any, image: string) => {
		const attachment = text.attachmentRuns.find((r: any) => JSON.stringify(r).includes(`"${image}"`));
		const style = text.styleRuns.find((r: any) => r.startIndex === attachment.startIndex && r.styleRunExtensions);
		return { styleRun: { ...style, startIndex: "{{len:NAME}}" }, attachmentRun: { ...attachment, startIndex: "{{len:NAME}}" } };
	};
	const header = find(pageVar(body("channel", /_videos\.resp$/)), "pageHeaderViewModel");
	save("badge/verified_run_24", run(header.title.dynamicTextViewModel.text, "CHECK_CIRCLE_FILLED"));
	const about = pageVar(body("channel-about", /\.resp$/));
	const part = (name: string) => find(about, "icon", (i) => i?.name === name);
	save("badge/verified_part", part("CHECK_CIRCLE_FILLED"));
	save("badge/artist_part", part("AUDIO_BADGE"));
}

function studio() {
	const page = body("in-studio-upload", /_content\.resp$/);
	const prefetch = JSON.parse(/chunkedPrefetchResolvers\['id-0'\]\.resolve\((\{[\s\S]*?\})\);<\/script>/.exec(page)![1]);
	const merge = (a: any, b: any): any => {
		if (!a || typeof a !== "object" || Array.isArray(a) || !b || typeof b !== "object" || Array.isArray(b)) return b ?? a;
		const out = { ...a };
		for (const [k, v] of Object.entries(b)) out[k] = merge(a[k], v);
		return out;
	};
	let ch = prefetch;
	for (const [, r] of bodies("in-studio-upload", /get_creator_channels/)) ch = merge(ch, r.channels[0]);
	const id: string = ch.channelId;
	const title: string = ch.title;
	ch = clean(ch);
	ch.channelId = "{{CHANNEL_ID}}";
	ch.title = "{{TITLE}}";
	ch.thumbnailDetails = "{{AVATARS}}";
	ch.metric = "{{METRIC}}";
	ch.timeCreatedSeconds = "{{TIME_CREATED}}";
	save("studio/channel", tokenize(ch, []), [id, title]);
}

// YouTube's own cards on Studio's dashboard, as the capture has them: the
// Creator Insider carousel and "What's new in Studio" (help center articles).
// Their impression/click tokens are the signed-in account's and are dropped;
// the videos and articles they link to stay on YouTube and its help center.
function studioDashboard() {
	const [, r] = bodies("studio-all", /creator_get_channel_dashboard\.resp$/)[0];
	const card = (id: string) => {
		const c = r.cards.find((c: any) => c.id === id);
		if (!c) throw new Error(`no ${id} card`);
		return c;
	};
	const insider = dropKey(clean(card("creator_insider")), "feedbackTokens");
	// tokenize sends www.youtube.com links to this instance; these are YouTube's videos
	const youtube = strings(insider, (s) => s.replace(/^https:\/\/www\.youtube\.com\/watch\?/, "{{YOUTUBE}}/watch?"));
	save("studio/dashboard_creator_insider", tokenize(youtube, []));
	save("studio/dashboard_product_updates", tokenize(clean(card("product_updates")), []));
}

// Studio's analytics (yta_web/get_screen and get_cards), from a channel
// without views: the screen layout (its tabs and the card configs in each),
// the cards each tab's screen request answers with, and every card's body as
// YouTube sends it when there is nothing to show. src/studio/screens.ts fills
// the cards this instance has figures for and sends these bodies for the rest
// (traffic sources, demographics, impressions, ...), moved to the current day.
function studioAnalytics() {
	const screens = bodies("studio-all", /yta_web_get_screen\.resp$/);
	const all = [...screens, ...bodies("studio-all", /yta_web_get_cards\.resp$/)];
	const channelId: string = screens[0][0].post.screenConfig.entity.channelId;
	const layout = clean(screens[0][1].layout);
	const now: string = layout.desktopLayout.selectedTimePeriod.nowSeconds;
	// the capture's day: the day after the last of the 28 daily points (which
	// start at the account's local midnight)
	const series = find(screens[0][1].cards, "datums");
	const dayStart = series[series.length - 1].x + 86_400_000;
	const tokens = (o: any) => {
		const t = wholeToken(wholeToken(wholeToken(clean(o), "nowSeconds", "NOW_SECONDS"), "channelId", "CHANNEL_ID"), "externalChannelId", "CHANNEL_ID");
		return tokenize(t, []);
	};
	save("studio/analytics_layout", tokens(layout), [channelId, now]);
	const tabs: Record<string, unknown[]> = {};
	for (const [req, res] of screens) tabs[req.post.desktopState.tabId] = res.cards.map((c: any) => tokens(c.config));
	save("studio/analytics_screens", tabs, [channelId, now]);
	// one body per distinct config
	const seen = new Set<string>();
	const cards: unknown[] = [];
	for (const [, res] of all)
		for (const c of res.cards) {
			const t = tokens(c);
			const key = JSON.stringify(t.config);
			if (seen.has(key)) continue;
			seen.add(key);
			// the inspiration feed's token is the request's
			if (t.contentInspirationFeedCardData) delete t.contentInspirationFeedCardData.serverToken;
			cards.push(t);
		}
	const day = new Date(dayStart);
	save("studio/analytics_cards", { dayStart, dateId: Number(`${day.getUTCFullYear()}${String(day.getUTCMonth() + 1).padStart(2, "0")}${String(day.getUTCDate()).padStart(2, "0")}`), cards }, [channelId, now]);
}

// Studio's Comments page: the section YouTube answers get_comments with (its
// header and batch action bar, and the message for an empty list); the
// comment threads themselves follow the client's contract (studio/comments.ts)
function studioComments() {
	const [[, res]] = bodies("studio-all", /comment_get_comments\.resp$/);
	const section = clean(res.contents.itemSectionRenderer);
	save("studio/comments_section", section);
}

// Customization (channel_edit/get_channel_page_settings): what every channel
// shares (the Home tab's default shelves, the pronoun and language lists,
// the flags); the channel's own name, handle, pictures, description and
// links are filled per request
function studioChannelEditing() {
	const [[req, res]] = bodies("studio-editing", /channel_edit_get_channel_page_settings\.resp$/);
	const data = clean(res.channelPageSettingsData);
	personal.push(req.post.externalChannelId, data.handle?.handle, data.brandTitle?.original);
	for (const k of ["externalChannelId", "brandTitle", "personalTitle", "handle", "vanityUrl", "vanityId", "description", "banner", "animatedBanner", "userSetProfilePicture", "defaultProfilePicture", "channelLinksInfo", "businessEmail"]) delete data[k];
	save("studio/channel_page_settings", data);
}

// ======================================================================

// ======================================================================
// settings (/account*): the sidebar and each page's sections. Options that
// belong to Google's services, or to features with no counterpart here, are
// left out (docs/compat/parity.md lists each with its reason); Google
// Account rows become the instance's own account page.
const SETTINGS_PAGES: [string, string, RegExp][] = [
	["SPaccount_overview", "site-in", /^\d+-_account\.resp$/],
	["SPaccount_time_management", "account-in", /-_account_time_management\.resp$/],
	["SPaccount_notifications", "site-in", /-_account_notifications\.resp$/],
	["SPaccount_playback", "site-in", /-_account_playback\.resp$/],
	["SPaccount_privacy", "site-in", /-_account_privacy\.resp$/],
	["SPaccount_sharing", "site-in", /-_account_sharing\.resp$/],
	["SPaccount_billing", "site-in", /-_account_billing\.resp$/],
	["SPaccount_advanced", "site-in", /-_account_advanced\.resp$/],
	["SPaccount_downloads", "site-in", /-_account_downloads\.resp$/],
];
const optionTitle = (o: any) => contentOf(o?.settingsOptionsRenderer?.title);
const sectionsOf = (page: any) => page.contents.twoColumnBrowseResultsRenderer.tabs[0].tabRenderer.content.sectionListRenderer.contents;
const textRun = (text: string, url?: string) => ({ text, ...(url ? { bold: true, navigationEndpoint: { commandMetadata: { webCommandMetadata: { url, webPageType: "WEB_PAGE_TYPE_UNKNOWN", rootVe: 83769 } }, urlEndpoint: { url } } } : {}) });
function settingsPages() {
	const pages = SETTINGS_PAGES.map(([id, dir, re]) => [id, pageVar(body(dir, re))] as const);
	const overview = pages[0][1];
	const email = /Signed in as (\S+@\S+)/.exec(contentOf(find(overview, "pageIntroductionRenderer").bodyText))?.[1];
	if (email) personal.push(email);
	const own = find(overview, "channelOptionsRenderer");
	const cid: string = own.avatarEndpoint.urlEndpoint.url.split("/channel/")[1];
	const pairs: [string, string][] = [[cid, "VIEWER_CHANNEL_ID"], [cid.slice(2), "VIEWER_USER_ID"]];
	save("settings/sidebar", tokenize(clean(overview.sidebar), pairs, [[cid, "VIEWER_CHANNEL_ID"]]));

	for (const [id, raw] of pages) {
		const page = clean({ contents: raw.contents });
		const sections = sectionsOf(page);
		const keep = (sec: any, pred: (o: any) => boolean) => {
			const s = sec.itemSectionRenderer;
			s.contents = s.contents.filter(pred);
		};
		const intro = find(page, "pageIntroductionRenderer");
		if (id === "SPaccount_overview") {
			intro.bodyText = { runs: [{ text: "Signed in as {{VIEWER_LOGIN}}" }] };
			const ch = find(page, "channelOptionsRenderer");
			ch.avatar.thumbnails = "{{VIEWER_AVATAR}}";
			ch.avatarEndpoint = { commandMetadata: { webCommandMetadata: { url: "{{VIEWER_CHANNEL_URL}}", webPageType: "WEB_PAGE_TYPE_CHANNEL", rootVe: 3611, apiUrl: "/youtubei/v1/browse" } }, browseEndpoint: { browseId: "{{VIEWER_CHANNEL_ID}}", canonicalBaseUrl: "{{VIEWER_CHANNEL_URL}}" } };
			ch.name = "{{VIEWER_NAME}}";
			// one channel per local account: no channel creation
			ch.links = ch.links.filter((l: any) => !find(l, "channelCreationFormEndpoint"));
			// Studio's channel features page
			const features = ch.links.find((l: any) => find(l, "signalNavigationEndpoint"));
			if (features) features.runs[0].navigationEndpoint = textRun("", "{{STUDIO_ORIGIN}}/channel/{{VIEWER_CHANNEL_ID}}/editing/details").navigationEndpoint;
			// "Your account": the local account page instead of Google Account,
			// Family Center and Premium membership (Google services)
			const acct = sections.find((s: any) => sectionTitle(s) === "Your account");
			keep(acct, (o) => optionTitle(o) === "Google Account");
			const row = acct.itemSectionRenderer.contents[0].settingsOptionsRenderer;
			row.title = { runs: [{ text: "{{INSTANCE_NAME}} account" }] };
			row.text = { runs: [textRun("View or change your account settings", "/myaccount"), { text: "\nYour username, password and sessions on {{INSTANCE_NAME}}" }] };
			acct.itemSectionRenderer.header.itemSectionHeaderRenderer.subtitle = { runs: [{ text: "You sign in to {{INSTANCE_NAME}} with a local account, not a Google Account" }] };
		}
		if (id === "SPaccount_notifications") {
			intro.bodyText = { runs: [{ text: "Select the notifications you'd like to receive" }] };
			// browser push goes through Google's push service; the instance sends no email
			const general = sections.find((s: any) => sectionTitle(s) === "General");
			keep(general, (o) => optionTitle(o) !== "Desktop notifications");
			for (let i = sections.length - 1; i >= 0; i--) if (sectionTitle(sections[i]) === "Email notifications") sections.splice(i, 1);
		}
		if (id === "SPaccount_privacy") {
			intro.bodyText = { runs: [intro.bodyText.runs[0]] };
			if (intro.bodyText.runs[0].text.includes("\n")) intro.bodyText.runs[0].text = intro.bodyText.runs[0].text.split("\n")[0];
			// mentions, live chat and ads have no counterpart here
			keep(sections[1], (o) => optionTitle(o) === "Subscriptions");
		}
		if (id === "SPaccount_sharing") {
			// linking partner accounts (games, services) is arranged between Google and each partner
			intro.bodyText = { runs: [{ text: contentOf(intro.bodyText).split("\n")[0] }] };
			sections.splice(1);
		}
		if (id === "SPaccount_billing") sections.splice(1); // no purchases on this instance
		if (id === "SPaccount_advanced") {
			keep(sections[1], (o) => ["User ID", "Channel ID", "Delete channel"].includes(optionTitle(o)));
			const del = sections[1].itemSectionRenderer.contents.find((o: any) => optionTitle(o) === "Delete channel").settingsOptionsRenderer;
			const dialog = find(del, "dialogViewModel");
			const primary = dialog.footer.panelFooterViewModel.primaryButton.buttonViewModel;
			primary.title = "Review in your account";
			primary.onTap.innertubeCommand = textRun("", "/myaccount").navigationEndpoint;
			dialog.content.basicContentViewModel.paragraphs = [{ text: { content: "Deleting your channel deletes your {{INSTANCE_NAME}} account, with its videos, comments and playlists." } }];
			del.text.runs = [del.text.runs[0], { text: "\nThis instance has one channel per account" }];
		}
		const ids: [string, string][] = [[cid, "VIEWER_CHANNEL_ID"]];
		save(`settings/${id}`, tokenize(page, pairs, ids, [[cid.slice(2), "VIEWER_USER_ID"]]));
	}
	// Playback and performance > Preferred languages (get_panel PApreferred_language_settings)
	const langs = clean(JSON.parse(body("languages-in", /get_panel\.resp$/)));
	save("settings/preferred_languages", tokenize(langs, []));
}
const sectionTitle = (s: any) => contentOf(s?.itemSectionRenderer?.header?.itemSectionHeaderRenderer?.title);


// ======================================================================
// account menu > Switch account (GET /getAccountSwitcherEndpoint): the
// accounts signed in on this browser. Every account value is rebuilt here
// from tokens; local accounts have one channel each, so "View all channels"
// is left out, and the account headers name the local account rather than
// a Google Account.
function accountSwitcher() {
	const raw = JSON.parse(body("switcher-in", /getAccountSwitcherEndpoint\.resp$/).replace(/^\)\]\}'\n/, ""));
	const r = clean(raw);
	const m = r.data.actions[0].getMultiPageMenuAction.menu.multiPageMenuRenderer;
	const lists = m.sections.filter((x: any) => x.accountSectionListRenderer);
	const active = lists[0].accountSectionListRenderer;
	const other = lists[1].accountSectionListRenderer;
	const sample = active.contents[0].accountItemSectionRenderer.contents[0].accountItem;
	const item = {
		...sample,
		accountName: { simpleText: "{{NAME}}" },
		accountPhoto: { thumbnails: "{{PHOTO}}" },
		isSelected: "{{SELECTED}}",
		hasChannel: true,
		serviceEndpoint: {
			selectActiveIdentityEndpoint: {
				supportedTokens: [
					{ accountStateToken: { hasChannel: true, isMerged: true, obfuscatedGaiaId: "{{ACCOUNT_ID}}" } },
					{ offlineCacheKeyToken: { clientCacheKey: "{{CACHE_KEY}}" } },
					{ accountSigninToken: { signinUrl: "{{SWITCH_URL}}" } },
					{ datasyncIdToken: { datasyncIdToken: "{{DATASYNC_ID}}" } },
				],
				nextNavigationEndpoint: { commandMetadata: { webCommandMetadata: { url: "{{NEXT}}", webPageType: "WEB_PAGE_TYPE_UNKNOWN", rootVe: 83769 } }, urlEndpoint: { url: "{{NEXT}}" } },
			},
		},
		accountByline: { simpleText: "{{BYLINE}}" },
		channelHandle: { simpleText: "{{HANDLE}}" },
	};
	save("account/switcher_item", { accountItem: item });
	active.contents = [{ accountItemSectionRenderer: { contents: ["{{ITEM}}"] } }];
	active.header.googleAccountHeaderRenderer = { name: { simpleText: "{{ACCOUNT_NAME}}" }, email: { simpleText: "{{ACCOUNT_LINE}}" } };
	save("account/switcher_active", lists[0]);
	const otherHeader = other.contents[0].accountItemSectionRenderer.header;
	otherHeader.accountItemSectionHeaderRenderer.title = { runs: [{ text: "{{ACCOUNT_NAME}}" }] };
	other.contents = [{ accountItemSectionRenderer: { contents: ["{{ITEM}}"], header: otherHeader } }];
	save("account/switcher_other", lists[1]);
	for (const l of findAll(m.footer, "compactLinkRenderer")) {
		const u = l.navigationEndpoint?.urlEndpoint;
		if (u) {
			u.url = "{{ADD_ACCOUNT_URL}}";
			l.navigationEndpoint.commandMetadata.webCommandMetadata.url = "{{ADD_ACCOUNT_URL}}";
		}
	}
	m.sections = "{{SECTIONS}}";
	save("account/switcher", r);
}

// Studio's account menu (account/account_menu from studio.youtube.com): Your
// channel, YouTube, Switch account and Sign out, then Appearance and Send
// feedback. Its links lead to this instance's main origin; Studio's feedback
// is Google's in-page form, so it opens /feedback instead.
function studioMenu() {
	const r = clean(JSON.parse(body("private/studio-switcher", /account_account_menu\.resp$/)));
	const m = r.actions[0].openPopupAction.popup.multiPageMenuRenderer;
	const h = m.header.activeAccountHeaderRenderer;
	delete h.settingsEndpoint; // the site picker (/select_site)
	h.accountName = { simpleText: "{{VIEWER_NAME}}" };
	h.channelHandle = { simpleText: "{{VIEWER_AT_HANDLE}}" };
	h.accountPhoto.thumbnails = "{{VIEWER_PHOTO}}";
	h.channelEndpoint = urlCommand("{{ORIGIN}}{{VIEWER_CHANNEL_URL}}");
	for (const sec of m.sections)
		for (const it of sec.multiPageMenuSectionRenderer?.items ?? []) {
			const c = it.compactLinkRenderer;
			if (!c) continue;
			const set = (url: string, newWindow = false) => {
				delete c.serviceEndpoint;
				c.navigationEndpoint = urlCommand(url, newWindow);
			};
			const icon = c.icon?.iconType;
			if (icon === "ACCOUNT_BOX") set("{{ORIGIN}}{{VIEWER_CHANNEL_URL}}");
			else if (icon === "VIDEO_YOUTUBE") set("{{ORIGIN}}/");
			else if (icon === "EXIT_TO_APP") set("{{ORIGIN}}/logout");
			else if (icon === "FEEDBACK") set("{{ORIGIN}}/feedback", true);
		}
	save("account/studio_menu", r);
}

// ======================================================================
// shorts
// The Shorts player's item (reel/reel_item_watch, also the /shorts/ page's
// ytInitialData) and a sequence entry (reel/reel_watch_sequence). Signed in,
// the item comes from the sequence's prefetched first entry (a channel the
// account isn't subscribed to, so it has the subscribe button); signed out,
// from reel_item_watch.
// ======================================================================
const SHORTS_MENU = new Set(["Description", "Save to playlist", "Full screen", "Playback speed", "Send feedback"]);
const SHORTS_PANELS = new Set(["engagement-panel-comments-section", "engagement-panel-structured-description"]);
const SHORTS_ACTIONS = new Set(["id.reel_comment_button", "id.reel_share_button"]);
function shortsItem(raw: any, id: string, signedIn: boolean) {
	const r = clean(raw);
	for (const k of ["topbar", "desktopTopbar", "tooltip"]) delete r[k];
	const elements = r.frameworkUpdates?.elementUpdate;
	delete r.frameworkUpdates;
	const ov = r.overlay.reelPlayerOverlayRenderer;
	const vm = ov.playerOverlay.reelPlayerOverlayViewModel;
	const meta = vm.metapanel.reelMetapanelViewModel;
	const bar = meta.metadataItems.find((m: any) => m.reelChannelBarViewModel).reelChannelBarViewModel;
	const titleVm = meta.metadataItems.find((m: any) => m.shortsVideoTitleViewModel).shortsVideoTitleViewModel;
	const like = find(vm.actionBar, "likeButtonViewModel");
	const title: string = titleVm.text.content.trim();
	const atHandle: string = bar.channelName.content;
	const chEndpoint = find(bar.channelName, "browseEndpoint");
	const chId: string = chEndpoint.browseId;
	const chUrl = `/${atHandle}`;
	const sd = r.engagementPanels.find((e: any) => e.engagementPanelSectionListRenderer.targetId === "engagement-panel-structured-description");
	const dh = find(sd, "videoDescriptionHeaderRenderer");
	const chName: string = contentOf(dh.channel);

	// ---- what this instance doesn't offer ----
	ov.menu.menuRenderer.items = ov.menu.menuRenderer.items.filter((it: any) => SHORTS_MENU.has(contentOf(it.listItemViewModel?.title)));
	// comment teaser, links to other Shorts: picked by YouTube's recommendations
	meta.metadataItems = meta.metadataItems.filter((m: any) => m.reelChannelBarViewModel || m.shortsVideoTitleViewModel);
	// hashtags link to hashtag pages, which aren't served
	titleVm.text = { content: "{{TITLE}}" };
	// like, comments, share (no Remix, no sound page)
	vm.actionBar.reelActionBarViewModel.buttonViewModels = vm.actionBar.reelActionBarViewModel.buttonViewModels.filter((b: any) => b.likeButtonViewModel || SHORTS_ACTIONS.has(b.buttonViewModel?.accessibilityId));
	r.engagementPanels = r.engagementPanels.filter((e: any) => SHORTS_PANELS.has(e.engagementPanelSectionListRenderer.targetId));
	const sdItems = find(sd, "structuredDescriptionContentRenderer").items;
	find(sd, "structuredDescriptionContentRenderer").items = sdItems.filter((it: any) => it.videoTitleHeaderViewModel || it.videoDescriptionHeaderRenderer || it.expandableVideoDescriptionBodyRenderer);
	// the channel's Shorts tab isn't served: channel links open the channel
	for (const h of findAllHolders(r, "browseEndpoint")) {
		const b = h.browseEndpoint;
		if (b.browseId === chId && /\/shorts$/.test(b.canonicalBaseUrl ?? "")) {
			b.canonicalBaseUrl = chUrl;
			delete b.params;
			if (h.commandMetadata?.webCommandMetadata) h.commandMetadata.webCommandMetadata.url = chUrl;
		}
	}
	// a signed-out subscribe opens the sign-in prompt; its continue action is Google's
	for (const h of findAllHolders(r, "signInEndpoint")) {
		delete h.signInEndpoint.continueAction;
		delete h.signInEndpoint.idamTag;
	}

	// ---- the video's own values ----
	const header = ov.reelPlayerHeaderSupportedRenderers.reelPlayerHeaderRenderer;
	header.timestampText = { simpleText: "{{PUBLISHED_LABEL}}" };
	header.accessibility.accessibilityData.label = "{{TITLE}} {{AT_HANDLE}} {{PUBLISHED_LABEL}}";
	const tb = like.toggleButtonViewModel.toggleButtonViewModel;
	const [def, tog] = [tb.defaultButtonViewModel.buttonViewModel, tb.toggledButtonViewModel.buttonViewModel];
	def.title = "{{LIKES}}";
	def.accessibilityText = "{{LIKE_A11Y}}";
	tog.title = "{{LIKES_IF_LIKED}}";
	tog.accessibilityText = "{{LIKED_A11Y}}";
	tb.isToggled = "{{LIKED}}";
	like.likeStatusEntity.likeStatus = "{{LIKE_STATUS}}";
	const comment = vm.actionBar.reelActionBarViewModel.buttonViewModels.find((b: any) => b.buttonViewModel?.accessibilityId === "id.reel_comment_button").buttonViewModel;
	comment.title = "{{COMMENT_COUNT}}";
	comment.accessibilityText = "{{COMMENT_A11Y}}";
	const subBtn = find(bar, "subscribeButtonViewModel");
	if (subBtn?.subscribeButtonContent) {
		for (const s of findAll(subBtn, "subscribeState")) s.subscribed = s.subscribed ? true : false;
	}
	wholeToken(bar, "sources", "AVATAR_48", (h) => /ggpht/.test(JSON.stringify(h.sources)));
	wholeToken(dh, "thumbnails", "AVATAR_88", (h) => /ggpht/.test(JSON.stringify(h.thumbnails)));
	dh.channel = { simpleText: "{{CHANNEL_NAME}}" };
	dh.views = { simpleText: "{{VIEWS_FULL}}" };
	dh.publishDate = { simpleText: "{{DATE}}" };
	const [lf, vf, uf] = dh.factoid;
	lf.factoidRenderer.value = { simpleText: "{{LIKES_COMPACT}}" };
	lf.factoidRenderer.accessibilityText = "{{LIKES_LABEL}}";
	vf.viewCountFactoidRenderer.factoid.factoidRenderer.value = { simpleText: "{{VIEWS_COMPACT}}" };
	vf.viewCountFactoidRenderer.factoid.factoidRenderer.accessibilityText = "{{VIEWS_FULL}}";
	uf.uploadTimeFactoidRenderer.factoid.factoidRenderer.value = { simpleText: "{{UPLOAD_VALUE}}" };
	uf.uploadTimeFactoidRenderer.factoid.factoidRenderer.label = { simpleText: "{{UPLOAD_LABEL}}" };
	uf.uploadTimeFactoidRenderer.factoid.factoidRenderer.accessibilityText = "{{UPLOAD_A11Y}}";
	find(sd, "videoTitleHeaderViewModel").videoTitle = { content: "{{TITLE}}" };
	find(sd, "expandableVideoDescriptionBodyRenderer").descriptionBodyText = { runs: [{ text: "{{DESCRIPTION}}" }] };
	// comments load through this instance's continuations
	const cp = r.engagementPanels.find((e: any) => e.engagementPanelSectionListRenderer.targetId === "engagement-panel-comments-section");
	const ch = find(cp, "engagementPanelTitleHeaderRenderer");
	ch.contextualInfo = { runs: [{ text: "{{COMMENT_COUNT}}" }] };
	const sorts = find(cp, "subMenuItems");
	sorts[0].serviceEndpoint.continuationCommand.token = "{{COMMENTS_TOP}}";
	sorts[1].serviceEndpoint.continuationCommand.token = "{{COMMENTS_NEWEST}}";
	find(find(cp, "continuationItemRenderer"), "continuationCommand").token = "{{COMMENTS_TOP}}";
	r.frameworkUpdates = "{{FRAMEWORK_UPDATES}}";
	const out = tokenize(r, [[id, "VIDEO_ID"], [chId, "CHANNEL_ID"], [chUrl, "CHANNEL_URL"], [atHandle, "AT_HANDLE"]], [[id, "VIDEO_ID"], [chId, "CHANNEL_ID"]], [[chName, "CHANNEL_NAME"]]);
	save(`shorts/item_${signedIn ? "in" : "out"}`, out, [id, title, chId, chName]);
	return elements;
}
function shorts() {
	const seqIn = JSON.parse(body("site-in", /reel_reel_watch_sequence\.resp$/));
	const first = seqIn.entries[0].command.reelWatchEndpoint;
	shortsItem(first.unserializedPrefetchData.reelItemWatchResponse, first.videoId, true);
	const outId = pageVar(body("shorts", /^001-/)).replacementEndpoint.reelWatchEndpoint.videoId;
	const elements = shortsItem(JSON.parse(body("shorts", /reel_reel_item_watch\.resp$/)), outId, false);
	// the Shorts player's element templates for the parts kept (panels, like
	// and action buttons), as YouTube sends them with every item
	const used = /^(engagement_panel_overlay|reel_action_button|reel_like_button|button|button_inner|animated_asset_no_ts)\.eml\|/;
	const el = clean(elements);
	el.updates = el.updates.filter((u: any) => !u.templateUpdate || used.test(u.templateUpdate.identifier));
	for (const u of el.updates) if (u.resourceStatusInResponseCheck) u.resourceStatusInResponseCheck.resourceStatuses = u.resourceStatusInResponseCheck.resourceStatuses.filter((s: any) => used.test(s.identifier));
	save("shorts/elements", el);
	// a sequence entry, without YouTube's recommendation params
	const seq = JSON.parse(body("shorts", /reel_reel_watch_sequence\.resp$/));
	const e = clean(seq.entries[1]);
	const rw = e.command.reelWatchEndpoint;
	const id: string = rw.videoId;
	for (const k of ["playerParams", "params", "softRefreshContinuation", "unserializedPrefetchData"]) delete rw[k];
	rw.thumbnail.thumbnails = "{{FRAME0}}";
	save("shorts/entry", tokenize(e, [[id, "VIDEO_ID"]], [[id, "VIDEO_ID"]]), [id]);
	const c = clean(seq.continuationEndpoint);
	c.continuationCommand.token = "{{CONTINUATION}}";
	save("shorts/continuation", c);
}

const only = process.argv.slice(2);
personalValues();
const steps: [string, () => void][] = [
	["channel", channel],
	["channel-in", channelSignedIn],
	["guide", guide],
	["chrome", chrome],
	["feeds", feeds],
	["home-shorts", homeShorts],
	["home-chips", homeChips],
	["channel-shorts", channelShorts],
	["watch", watch],
	["search", search],
	["playlist", playlistPage],
	["playlist-own", ownListPage],
	["history", history],
	["library", library],
	["comments", comments],
	["save", saveSheet],
	["share", sharePanel],
	["playlist-panel", playlistPanelTpl],
	["studio", studio],
	["studio-dashboard", studioDashboard],
	["studio-analytics", studioAnalytics],
	["studio-comments", studioComments],
	["studio-editing", studioChannelEditing],
	["badges", badges],
	["settings", settingsPages],
	["switcher", accountSwitcher],
	["studio-menu", studioMenu],
	["shorts", shorts],
];
for (const [name, fn] of steps) {
	if (only.length && !only.includes(name)) continue;
	try {
		fn();
	} catch (e) {
		console.error(`${name}: ${(e as Error).message}`);
		process.exitCode = 1;
	}
}
// the asset list covers every template, so only a full run rewrites it
if (!only.length) writeFileSync(join(OUT, "_assets.txt"), [...assets].sort().join("\n") + "\n");
console.log(`templates: ${written.join(", ")}`);
console.log(`gstatic assets referenced: ${assets.size}; personal values guarded: ${personal.filter(Boolean).length}`);
