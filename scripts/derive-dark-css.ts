// The main client's dark stylesheet. YouTube compiles kevlar_base's CSS
// twice per build, and its server links the dark compile when the viewer's
// Appearance is dark: the same rules, with the dark palette in the theme
// token blocks (:root:root, :root) and in a few gradients. The pinned build
// is no longer served under another activation mask (the rs= checksum is
// checked), so its dark compile is made from a current build's pair: every
// rule the two compiles differ in is looked up in the pinned light sheet and,
// where it is the same rule there, swapped for the dark compile's; theme
// token blocks are taken over token by token (the names are stable hashes),
// and rules the pinned build words differently declaration by declaration.
//   bun scripts/derive-dark-css.ts <live light kevlar_base css url> <live dark css url>
// Get the pair from youtube.com's <link rel=stylesheet> for kevlar_base with
// the PREF cookie f6=80000 (light) and f6=400 (dark), from the same build.

import { readFileSync } from "node:fs";
import { archivePath, loadPin, savePin, sha256, writeArchived } from "../src/client/store";

const [lightUrl, darkUrl] = process.argv.slice(2);
if (!lightUrl || !darkUrl) throw new Error("usage: derive-dark-css.ts <light css url> <dark css url>");
const pin = loadPin();
if (!pin) throw new Error("no pinned client");
const key = (u: string) => /k=ytmainappweb\.kevlar_base\.([^./]+)/.exec(u)?.[1];
if (!key(lightUrl) || key(lightUrl) !== key(darkUrl)) throw new Error("the two stylesheets must be kevlar_base of the same build");

const get = async (u: string) => {
	const r = await fetch(u);
	if (!r.ok) throw new Error(`${u}: ${r.status}`);
	return r.text();
};
const [liveLight, liveDark] = [await get(lightUrl), await get(darkUrl)];
const pinned = readFileSync(archivePath(pin.app.cssUrl), "utf8");

// top-level units: rules and whole at-rule blocks
function units(css: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < css.length; i++) {
		const c = css[i];
		if (c === "{") depth++;
		else if (c === "}" && --depth === 0) {
			out.push(css.slice(start, i + 1));
			start = i + 1;
		}
	}
	return out;
}
const prelude = (u: string) => u.slice(0, u.indexOf("{"));
const list = (u: string) => u.slice(u.indexOf("{") + 1, -1).split(";").filter(Boolean);
const decls = (u: string) => new Map(u.slice(u.indexOf("{") + 1, -1).split(";").filter(Boolean).map((d) => [d.slice(0, d.indexOf(":")), d.slice(d.indexOf(":") + 1)] as [string, string]));

const L = units(liveLight);
const D = units(liveDark);
if (L.length !== D.length) throw new Error(`the compiles differ in rule count (${L.length} vs ${D.length})`);
const P = units(pinned);
let swapped = 0;
let tokens = 0;
let declarations = 0;
const unresolved: string[] = [];
for (let i = 0; i < L.length; i++) {
	if (L[i] === D[i]) continue;
	// the same rule in the pinned sheet: take the dark compile's
	const at = P.indexOf(L[i]);
	if (at >= 0) {
		P[at] = D[i];
		swapped++;
		continue;
	}
	// a theme token block: the tokens whose value the dark compile changes,
	// in the pinned block with the same selector
	const sel = prelude(L[i]);
	if (/^(:root)+$/.test(sel)) {
		const [l, d] = [decls(L[i]), decls(D[i])];
		const changed = [...new Set([...l.keys(), ...d.keys()])].filter((t) => l.get(t) !== d.get(t));
		const targets = P.map((u, j) => [u, j] as const).filter(([u]) => prelude(u) === sel);
		for (const [u, j] of targets) {
			const p = decls(u);
			let hit = false;
			for (const t of changed) {
				// set where the pinned block has the token (or the dark compile adds it to this block)
				if (p.has(t) || (!l.has(t) && d.has(t) && sel === ":root:root")) {
					if (d.has(t)) p.set(t, d.get(t)!);
					else p.delete(t);
					hit = true;
					tokens++;
				}
			}
			if (hit) P[j] = `${sel}{${[...p].map(([k, v]) => `${k}:${v}`).join(";")}}`;
		}
		continue;
	}
	// a rule the pinned build words differently: its declarations the dark
	// compile changes, where the pinned rule has the light one verbatim
	const [ld, dd] = [list(L[i]), list(D[i])];
	let merged = 0;
	if (ld.length === dd.length)
		for (let j = 0; j < P.length; j++) {
			if (prelude(P[j]) !== sel) continue;
			const pd = list(P[j]);
			for (let k = 0; k < ld.length; k++) {
				if (ld[k] === dd[k]) continue;
				const at = pd.indexOf(ld[k]);
				if (at >= 0) {
					pd[at] = dd[k];
					merged++;
				}
			}
			if (merged) P[j] = `${sel}{${pd.join(";")}}`;
		}
	if (merged) declarations += merged;
	else unresolved.push(sel.slice(0, 100));
}
const dark = P.join("");
const out = `${archivePath(pin.app.cssUrl)}.dark`;
writeArchived(out, Buffer.from(dark));
pin.app.darkCss = { from: [lightUrl, darkUrl], sha256: sha256(dark), size: dark.length };
savePin(pin);
console.log(`dark stylesheet: ${swapped} rules, ${declarations} declarations and ${tokens} theme tokens from the dark compile; ${unresolved.length} rules not in the pinned build${unresolved.length ? `: ${unresolved.join(" | ")}` : ""}`);
console.log(`wrote ${out}`);
