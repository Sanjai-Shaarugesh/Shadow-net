// fileCompress.ts
// Real, streaming compression for transfers (native CompressionStream, deflate-raw).
// Already-compressed formats are detected by magic bytes + extension and sent as-is.
//
// NOTE: utils/zpaqCompression.ts is NOT used here. Its BWT step builds one full
// rotation array per byte (O(n^2) memory: a 900 KB block needs ~800 GB) and its
// LZ77 is O(n * 32768), so it hangs/crashes on anything beyond a few KB.

export type Codec = 'none' | 'deflate-raw';

export interface Prepared {
  payload: Blob; // what actually goes over the wire
  codec: Codec;
  originalSize: number;
  payloadSize: number;
}

const MAX_COMPRESS_BYTES = 1.5 * 1024 * 1024 * 1024; // keep Blob/stream memory sane
const MIN_COMPRESS_BYTES = 4 * 1024;
const MIN_SAVING = 0.03; // keep compressed only if >=3% smaller

const SKIP_EXT =
  /\.(zip|rar|7z|gz|tgz|bz2|xz|zst|jar|apk|docx|xlsx|pptx|odt|ods|epub|jpe?g|png|gif|webp|avif|heic|heif|mp3|aac|m4a|ogg|opus|flac|mp4|m4v|mov|mkv|webm|avi|pdf)$/i;

export function isAlreadyCompressed(name: string, head: Uint8Array): boolean {
  if (SKIP_EXT.test(name)) return true;
  const h = (...b: number[]) => b.every((v, i) => head[i] === v);
  return (
    h(0x50, 0x4b, 0x03, 0x04) || // zip
    h(0x1f, 0x8b) || // gzip
    h(0x52, 0x61, 0x72, 0x21) || // rar
    h(0x37, 0x7a, 0xbc, 0xaf) || // 7z
    h(0xfd, 0x37, 0x7a, 0x58, 0x5a) || // xz
    h(0x28, 0xb5, 0x2f, 0xfd) || // zstd
    h(0x89, 0x50, 0x4e, 0x47) || // png
    h(0xff, 0xd8, 0xff) || // jpeg
    h(0x47, 0x49, 0x46, 0x38) || // gif
    h(0x1a, 0x45, 0xdf, 0xa3) || // matroska/webm
    h(0x4f, 0x67, 0x67, 0x53) || // ogg
    h(0x25, 0x50, 0x44, 0x46) || // pdf
    (head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70) // mp4/mov ftyp
  );
}

export const supportsCompression = () =>
  typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';

export async function prepareForTransfer(file: File): Promise<Prepared> {
  const none: Prepared = {
    payload: file,
    codec: 'none',
    originalSize: file.size,
    payloadSize: file.size
  };
  if (!supportsCompression() || file.size < MIN_COMPRESS_BYTES || file.size > MAX_COMPRESS_BYTES) {
    return none;
  }
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  if (isAlreadyCompressed(file.name, head)) return none;

  try {
    const out = await new Response(
      file.stream().pipeThrough(new CompressionStream('deflate-raw'))
    ).blob();
    if (out.size > file.size * (1 - MIN_SAVING)) return none;
    return { payload: out, codec: 'deflate-raw', originalSize: file.size, payloadSize: out.size };
  } catch (e) {
    console.warn('compression failed, sending raw', e);
    return none;
  }
}

/** Receiver side. Returns a Blob (browser may keep it on disk, no big ArrayBuffer copy). */
export async function inflate(parts: BlobPart[], codec: Codec, type: string): Promise<Blob> {
  const raw = new Blob(parts);
  if (codec === 'none') return new Blob([raw], { type });
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This browser cannot decompress the incoming file');
  }
  const out = await new Response(raw.stream().pipeThrough(new DecompressionStream(codec))).blob();
  return new Blob([out], { type });
}
