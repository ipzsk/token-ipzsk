// Magic-byte sniffing and dimension parsing for PNG/JPEG/WebP/MP4, plus WAV/MP3 type sniffing (duration comes from ffprobe). No dependencies; never trusts declared types.

function png(b) {
  if (b.length < 24 || !b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return null;
  return { contentType: 'image/png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function jpeg(b) {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) return null;
  for (let o = 2; o + 9 < b.length;) {
    if (b[o] !== 0xff) return { contentType: 'image/jpeg', width: null, height: null };
    const marker = b[o + 1];
    if (marker === 0xff) { o++; continue; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { o += 2; continue; }
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { contentType: 'image/jpeg', width: b.readUInt16BE(o + 7), height: b.readUInt16BE(o + 5) };
    }
    o += 2 + b.readUInt16BE(o + 2);
  }
  return { contentType: 'image/jpeg', width: null, height: null }; // SOF beyond the bytes we have
}

function webp(b) {
  if (b.length < 30 || b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WEBP') return null;
  const chunk = b.toString('latin1', 12, 16);
  if (chunk === 'VP8 ') return { contentType: 'image/webp', width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  if (chunk === 'VP8L') return { contentType: 'image/webp', width: 1 + (((b[22] & 0x3f) << 8) | b[21]),
    height: 1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6)) };
  if (chunk === 'VP8X') return { contentType: 'image/webp', width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
  return null;
}

// Iterate ISO-BMFF boxes inside buffer b[start,end).
function* boxes(b, start = 0, end = b.length) {
  for (let o = start; o + 8 <= end;) {
    let size = b.readUInt32BE(o), header = 8;
    if (size === 1) { if (o + 16 > end) return; size = Number(b.readBigUInt64BE(o + 8)); header = 16; }
    else if (size === 0) size = end - o;
    if (size < header) return;
    yield { type: b.toString('latin1', o + 4, o + 8), start: o, body: o + header, end: Math.min(o + size, end) };
    o += size;
  }
}

export function parseMoov(b) {
  let duration_ms = null, width = null, height = null;
  const walk = (start, end) => {
    for (const box of boxes(b, start, end)) {
      if (box.type === 'trak') walk(box.body, box.end);
      const v = b[box.body], c = box.body + 4;
      if (box.type === 'mvhd' && box.end - c >= 20) {
        const scale = b.readUInt32BE(c + (v === 1 ? 16 : 8));
        const d = v === 1 ? Number(b.readBigUInt64BE(c + 20)) : b.readUInt32BE(c + 12);
        if (scale) duration_ms = Math.round(d * 1000 / scale);
      }
      if (box.type === 'tkhd' && width === null) {
        const o = c + (v === 1 ? 32 : 20) + 52; // durations, reserved, layer/group/volume, matrix
        if (o + 8 <= box.end) {
          const w = b.readUInt32BE(o) >>> 16, h = b.readUInt32BE(o + 4) >>> 16;
          if (w && h) { width = w; height = h; }
        }
      }
    }
  };
  walk(0, b.length);
  return { contentType: 'video/mp4', width, height, duration_ms };
}

const MAX_MOOV = 32 * 1024 * 1024;
async function mp4(head, size, readRange) {
  if (head.length < 12 || head.toString('latin1', 4, 8) !== 'ftyp') return null;
  // Walk top-level boxes; headers outside the head buffer are fetched by Range (moov is often after mdat).
  for (let o = 0, n = 0; o + 8 <= size && n < 64; n++) {
    const hdr = o + 16 <= head.length ? head.subarray(o, o + 16) : await readRange(o, Math.min(o + 16, size) - 1);
    let boxSize = hdr.readUInt32BE(0);
    if (boxSize === 1 && hdr.length >= 16) boxSize = Number(hdr.readBigUInt64BE(8));
    else if (boxSize === 0) boxSize = size - o;
    if (boxSize < 8) return null;
    if (hdr.toString('latin1', 4, 8) === 'moov') {
      if (boxSize > MAX_MOOV || o + boxSize > size) return null;
      const moov = o + boxSize <= head.length ? head.subarray(o, o + boxSize) : await readRange(o, o + boxSize - 1);
      const [box] = boxes(moov);
      return parseMoov(moov.subarray(box.body, box.end));
    }
    o += boxSize;
  }
  return null;
}

// WAV: RIFF....WAVE. MP3: ID3v2 tag, or an MPEG-1/2 Layer III frame sync (0xFFE, layer bits 01, bitrate/rate not reserved).
export function sniffAudio(b) {
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WAVE') return 'audio/wav';
  if (b.length >= 10 && b.toString('latin1', 0, 3) === 'ID3') return 'audio/mpeg';
  if (b.length >= 4 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0 && (b[1] & 0x06) === 0x02 && (b[1] & 0x18) !== 0x08
    && (b[2] >> 4) !== 0x0f && (b[2] >> 4) !== 0 && ((b[2] >> 2) & 3) !== 3) return 'audio/mpeg';
  return null;
}

// head: first bytes of the object; size: real object size; readRange(start, endInclusive) → Buffer.
export async function probeMedia(head, size, readRange) {
  const image = png(head) ?? webp(head) ?? jpeg(head);
  if (image) {
    if (image.width === null && head.length < size) {
      const more = jpeg(await readRange(0, Math.min(size, 4 * 1024 * 1024) - 1));
      if (more) return { ...more, duration_ms: null };
    }
    return { ...image, duration_ms: null };
  }
  const audio = sniffAudio(head);
  if (audio) return { contentType: audio, width: null, height: null, duration_ms: null };
  return mp4(head, size, readRange);
}
