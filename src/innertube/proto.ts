// Minimal protobuf wire format: enough to read the client's tab params and
// to mint entity keys the way YouTube writes them. Only varint (0) and
// length-delimited (2) fields occur in these messages.

export type ProtoField = number | string | Uint8Array | ProtoMessage;
export type ProtoMessage = { [field: number]: ProtoField };

function varint(n: number): number[] {
	const out: number[] = [];
	let v = BigInt(n);
	do {
		let b = Number(v & 0x7fn);
		v >>= 7n;
		if (v) b |= 0x80;
		out.push(b);
	} while (v);
	return out;
}

export function encode(msg: ProtoMessage): Uint8Array {
	const out: number[] = [];
	for (const [k, v] of Object.entries(msg)) {
		const field = Number(k);
		if (typeof v === "number") out.push(...varint(field << 3), ...varint(v));
		else {
			const bytes = typeof v === "string" ? new TextEncoder().encode(v) : v instanceof Uint8Array ? v : encode(v);
			out.push(...varint((field << 3) | 2), ...varint(bytes.length), ...bytes);
		}
	}
	return Uint8Array.from(out);
}

// fields as raw values: varints as numbers, length-delimited as bytes
export function decode(buf: Uint8Array): Map<number, (number | Uint8Array)[]> {
	const fields = new Map<number, (number | Uint8Array)[]>();
	let i = 0;
	const readVarint = () => {
		let shift = 0n;
		let v = 0n;
		while (i < buf.length) {
			const b = buf[i++];
			v |= BigInt(b & 0x7f) << shift;
			if (!(b & 0x80)) break;
			shift += 7n;
		}
		return Number(v);
	};
	while (i < buf.length) {
		const tag = readVarint();
		const field = tag >> 3;
		let value: number | Uint8Array;
		switch (tag & 7) {
			case 0:
				value = readVarint();
				break;
			case 2: {
				const n = readVarint();
				value = buf.subarray(i, i + n);
				i += n;
				break;
			}
			case 1:
				value = buf.subarray(i, (i += 8));
				break;
			case 5:
				value = buf.subarray(i, (i += 4));
				break;
			default:
				return fields;
		}
		fields.set(field, [...(fields.get(field) ?? []), value]);
	}
	return fields;
}

export function fromBase64(s: string): Uint8Array {
	const t = decodeURIComponent(s).replace(/-/g, "+").replace(/_/g, "/");
	return Uint8Array.from(Buffer.from(t, "base64"));
}

export const str = (v: number | Uint8Array | undefined) => (v instanceof Uint8Array ? new TextDecoder().decode(v) : undefined);

// entity keys: base64 of {2: id, 4: entity type, 5: 1} as YouTube writes
// them, in the web-safe alphabet with '=' written as %3D (the client keys its
// entity store by the exact string)
export function entityKey(id: string, type: number): string {
	return Buffer.from(encode({ 2: id, 4: type, 5: 1 })).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "%3D");
}

// whether a channel browse params blob asks to open the post composer (the
// Create menu's "Create post": {2: "posts", 73: {1: {1: 1}}, ...})
export function createDialogFromParams(params: string | undefined): boolean {
	if (!params) return false;
	try {
		return decode(fromBase64(params)).has(73);
	} catch {
		return false;
	}
}

// the Posts tab's Scheduled section (posts.ts): the tab's params with a
// field of this instance's own appended, which YouTube's params don't use
const SCHEDULED_POSTS_FIELD = 500;
export function withScheduledPosts(params: string): string {
	const bytes = Uint8Array.from([...fromBase64(params), ...encode({ [SCHEDULED_POSTS_FIELD]: 1 })]);
	return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "%3D");
}
export function scheduledPostsFromParams(params: string | undefined): boolean {
	if (!params) return false;
	try {
		return decode(fromBase64(params)).has(SCHEDULED_POSTS_FIELD);
	} catch {
		return false;
	}
}

// the tab name in a channel browse params blob ({2: "videos", ...})
export function channelTabFromParams(params: string | undefined): string | undefined {
	if (!params) return undefined;
	try {
		return str(decode(fromBase64(params)).get(2)?.[0]);
	} catch {
		return undefined;
	}
}
