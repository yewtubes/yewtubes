// An uploaded image's pixel size, read from its header (JPEG, PNG, GIF,
// BMP, WebP), so posts can give the client the dimensions it lays out by.

export function imageSize(b: Uint8Array): { width: number; height: number } | undefined {
	const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
	const at = (i: number, n: number) => i + n <= b.length;
	// PNG: IHDR is the first chunk
	if (b[0] === 0x89 && b[1] === 0x50 && at(16, 8)) return { width: v.getUint32(16), height: v.getUint32(20) };
	// GIF: logical screen size
	if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && at(6, 4)) return { width: v.getUint16(6, true), height: v.getUint16(8, true) };
	// BMP: BITMAPINFOHEADER (height is negative for top-down images)
	if (b[0] === 0x42 && b[1] === 0x4d && at(18, 8)) return { width: Math.abs(v.getInt32(18, true)), height: Math.abs(v.getInt32(22, true)) };
	// WebP: lossy, lossless or extended
	if (b[0] === 0x52 && b[8] === 0x57 && at(12, 18)) {
		const kind = String.fromCharCode(b[12], b[13], b[14], b[15]);
		if (kind === "VP8 " && at(26, 4)) return { width: v.getUint16(26, true) & 0x3fff, height: v.getUint16(28, true) & 0x3fff };
		if (kind === "VP8L" && at(21, 4)) {
			const bits = v.getUint32(21, true);
			return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
		}
		if (kind === "VP8X" && at(24, 6)) return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
		return undefined;
	}
	// JPEG: the first start-of-frame marker
	if (b[0] === 0xff && b[1] === 0xd8) {
		let i = 2;
		while (at(i, 9)) {
			if (b[i] !== 0xff) return undefined;
			const marker = b[i + 1];
			if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
				i += 2;
				continue;
			}
			const len = v.getUint16(i + 2);
			if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { width: v.getUint16(i + 7), height: v.getUint16(i + 5) };
			i += 2 + len;
		}
	}
	return undefined;
}
