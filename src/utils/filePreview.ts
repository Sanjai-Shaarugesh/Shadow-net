// filePreview.ts
// Builds a small, RAW preview of a file so the receiver can look at it (and at its
// metadata) before accepting the transfer:
//   image -> downscaled thumbnail of the real pixels
//   video -> first-second poster frame + duration + resolution
//   audio -> duration
//   text  -> first ~1.2 KB of the actual content
//   other -> hex dump of the first 256 real bytes
// Everything is capped (~48 KB) so it fits in one data-channel message.

import type { Codec } from './fileCompress';

export type PreviewKind = 'image' | 'video' | 'audio' | 'text' | 'hex' | 'none';

export interface PreviewInfo {
  name: string;
  size: number; // original size in bytes
  payloadSize: number; // bytes on the wire (after compression)
  codec: Codec;
  type: string; // browser-declared MIME
  sniffed?: string; // what the magic bytes say it really is
  lastModified?: number;
  kind: PreviewKind;
  width?: number;
  height?: number;
  duration?: number; // seconds
  text?: string;
  textTruncated?: boolean;
  thumbMime?: string; // when bytes are an image thumbnail
}

export interface BuiltPreview {
  info: PreviewInfo;
  bytes?: Uint8Array; // thumbnail bytes, or first 256 raw bytes for 'hex'
}

const THUMB_MAX_DIM = 512;
const THUMB_MAX_BYTES = 48 * 1024;
const TEXT_BYTES = 1200;
const HEX_BYTES = 256;

const TEXT_EXT =
  /\.(txt|md|json|ya?ml|toml|ini|cfg|conf|log|csv|tsv|xml|html?|css|scss|js|mjs|cjs|jsx|ts|tsx|svelte|astro|vue|py|rb|go|rs|c|h|cc|cpp|hpp|java|kt|swift|sh|bash|zsh|sql|env|svg|srt|vtt)$/i;

const MAGIC: Array<[number[], string]> = [
  [[0x89, 0x50, 0x4e, 0x47], 'PNG image'],
  [[0xff, 0xd8, 0xff], 'JPEG image'],
  [[0x47, 0x49, 0x46, 0x38], 'GIF image'],
  [[0x25, 0x50, 0x44, 0x46], 'PDF document'],
  [[0x50, 0x4b, 0x03, 0x04], 'ZIP container (zip/docx/xlsx/apk…)'],
  [[0x1f, 0x8b], 'gzip archive'],
  [[0x52, 0x61, 0x72, 0x21], 'RAR archive'],
  [[0x37, 0x7a, 0xbc, 0xaf], '7-Zip archive'],
  [[0x1a, 0x45, 0xdf, 0xa3], 'Matroska/WebM video'],
  [[0x4f, 0x67, 0x67, 0x53], 'Ogg media'],
  [[0x49, 0x44, 0x33], 'MP3 audio'],
  [[0x7f, 0x45, 0x4c, 0x46], 'ELF executable'],
  [[0x4d, 0x5a], 'Windows executable (MZ)'],
  [[0x53, 0x51, 0x4c, 0x69, 0x74, 0x65], 'SQLite database']
];

export function sniff(head: Uint8Array): string | undefined {
  for (const [sig, label] of MAGIC) if (sig.every((b, i) => head[i] === b)) return label;
  if (head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70)
    return 'MP4/MOV media';
  const s = String.fromCharCode(...head.slice(0, 12));
  if (s.startsWith('RIFF') && s.slice(8, 12) === 'WEBP') return 'WebP image';
  if (s.startsWith('RIFF') && s.slice(8, 12) === 'WAVE') return 'WAV audio';
  if (s.startsWith('fLaC')) return 'FLAC audio';
  return undefined;
}

function looksBinary(b: Uint8Array): boolean {
  let bad = 0;
  for (const v of b) if (v === 0 || (v < 7 && v !== 0) || (v > 13 && v < 32 && v !== 27)) bad++;
  return bad / Math.max(1, b.length) > 0.02;
}

async function imageThumb(
  file: Blob
): Promise<{ bytes: Uint8Array; mime: string; w: number; h: number } | null> {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' } as any);
    const scale = Math.min(1, THUMB_MAX_DIM / Math.max(bmp.width, bmp.height));
    let w = Math.max(1, Math.round(bmp.width * scale));
    let h = Math.max(1, Math.round(bmp.height * scale));
    const origW = bmp.width;
    const origH = bmp.height;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    let q = 0.72;
    for (let i = 0; i < 6; i++) {
      canvas.width = w;
      canvas.height = h;
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(bmp, 0, 0, w, h);
      let blob: Blob | null = await new Promise((r) => canvas.toBlob(r, 'image/webp', q));
      if (!blob || blob.type !== 'image/webp') {
        ctx.fillStyle = '#fff'; // jpeg has no alpha
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(bmp, 0, 0, w, h);
        blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', q));
      }
      if (blob && (blob.size <= THUMB_MAX_BYTES || i === 5)) {
        bmp.close?.();
        if (blob.size > THUMB_MAX_BYTES) return null;
        return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: blob.type, w: origW, h: origH };
      }
      q = Math.max(0.3, q - 0.12);
      w = Math.round(w * 0.85);
      h = Math.round(h * 0.85);
    }
    bmp.close?.();
  } catch {
    /* undecodable (svg, heic on some browsers…) -> fall through */
  }
  return null;
}

function mediaMeta(
  file: Blob,
  tag: 'video' | 'audio'
): Promise<{ duration: number; w?: number; h?: number; poster?: Uint8Array; mime?: string }> {
  return new Promise((resolve, reject) => {
    const el = document.createElement(tag);
    const url = URL.createObjectURL(file);
    const done = (v: any) => {
      URL.revokeObjectURL(url);
      el.removeAttribute('src');
      el.load();
      resolve(v);
    };
    const fail = () => {
      URL.revokeObjectURL(url);
      reject(new Error('media metadata failed'));
    };
    const timer = setTimeout(fail, 6000);
    el.preload = 'metadata';
    el.muted = true;
    (el as HTMLVideoElement).playsInline = true;
    el.onerror = () => {
      clearTimeout(timer);
      fail();
    };
    el.onloadedmetadata = () => {
      const duration = isFinite(el.duration) ? el.duration : 0;
      if (tag === 'audio') {
        clearTimeout(timer);
        return done({ duration });
      }
      const v = el as HTMLVideoElement;
      v.onseeked = async () => {
        clearTimeout(timer);
        try {
          const s = Math.min(1, THUMB_MAX_DIM / Math.max(v.videoWidth, v.videoHeight));
          const c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(v.videoWidth * s));
          c.height = Math.max(1, Math.round(v.videoHeight * s));
          c.getContext('2d')!.drawImage(v, 0, 0, c.width, c.height);
          let q = 0.7;
          let blob: Blob | null = null;
          for (let i = 0; i < 4; i++) {
            blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', q));
            if (blob && blob.size <= THUMB_MAX_BYTES) break;
            q -= 0.15;
          }
          done({
            duration,
            w: v.videoWidth,
            h: v.videoHeight,
            poster:
              blob && blob.size <= THUMB_MAX_BYTES
                ? new Uint8Array(await blob.arrayBuffer())
                : undefined,
            mime: 'image/jpeg'
          });
        } catch {
          done({ duration, w: v.videoWidth, h: v.videoHeight });
        }
      };
      v.currentTime = Math.min(1, duration / 10 || 0);
    };
    el.src = url;
  });
}

export async function buildPreview(
  file: File,
  wire: { codec: Codec; payloadSize: number }
): Promise<BuiltPreview> {
  const head = new Uint8Array(await file.slice(0, Math.max(TEXT_BYTES, HEX_BYTES)).arrayBuffer());
  const info: PreviewInfo = {
    name: file.name,
    size: file.size,
    payloadSize: wire.payloadSize,
    codec: wire.codec,
    type: file.type,
    lastModified: file.lastModified,
    sniffed: sniff(head),
    kind: 'none'
  };

  const mime = file.type;
  try {
    if (mime.startsWith('image/') && mime !== 'image/svg+xml') {
      const t = await imageThumb(file);
      if (t) {
        info.kind = 'image';
        info.width = t.w;
        info.height = t.h;
        info.thumbMime = t.mime;
        return { info, bytes: t.bytes };
      }
    } else if (mime.startsWith('video/')) {
      const m = await mediaMeta(file, 'video');
      info.kind = 'video';
      info.duration = m.duration;
      info.width = m.w;
      info.height = m.h;
      info.thumbMime = m.mime;
      return { info, bytes: m.poster };
    } else if (mime.startsWith('audio/')) {
      const m = await mediaMeta(file, 'audio');
      info.kind = 'audio';
      info.duration = m.duration;
      return { info };
    }
  } catch {
    /* fall through to text / hex */
  }

  const isTextish =
    mime.startsWith('text/') ||
    /json|xml|javascript|svg|yaml/.test(mime) ||
    TEXT_EXT.test(file.name);
  const textHead = head.slice(0, TEXT_BYTES);
  if ((isTextish || !info.sniffed) && !looksBinary(textHead)) {
    info.kind = 'text';
    info.text = new TextDecoder('utf-8', { fatal: false }).decode(textHead);
    info.textTruncated = file.size > TEXT_BYTES;
    return { info };
  }

  info.kind = 'hex';
  return { info, bytes: head.slice(0, HEX_BYTES) };
}

/** Classic `offset  hex bytes  |ascii|` dump of the raw bytes. */
export function hexDump(bytes: Uint8Array, perLine = 16): string {
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += perLine) {
    const row = bytes.slice(i, i + perLine);
    const hex = Array.from(row, (b) => b.toString(16).padStart(2, '0')).join(' ');
    const asc = Array.from(row, (b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
    lines.push(`${i.toString(16).padStart(6, '0')}  ${hex.padEnd(perLine * 3 - 1)}  ${asc}`);
  }
  return lines.join('\n');
}

export function formatDuration(sec?: number): string {
  if (!sec || !isFinite(sec)) return '0:00';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}
