// manualSignaling.ts
// Serverless WebRTC signaling: the offer / answer SDP is packed into a short
// text "code" (or a share link) that the two peers exchange themselves
// (chat, email, QR, read aloud, ...). No WebSocket / signaling server needed,
// so the app works on any static host.

import { base64url } from './base64';

export interface SignalPayload {
  /** 'offer' or 'answer' */
  t: 'offer' | 'answer';
  /** raw SDP (with all ICE candidates already gathered) */
  sdp: string;
  /** RSA public key (base64) when encryption is enabled */
  pk?: string;
  /** custom ICE/STUN server chosen by the sender */
  ice?: string;
  /** custom chunk size chosen by the sender */
  cs?: number;
}

// Code format:  "<version>.<base64url payload>"
//   z1 = deflate-raw compressed JSON
//   p1 = plain JSON (fallback for browsers without CompressionStream)
const COMPRESSED = 'z1';
const PLAIN = 'p1';

function bytesToBinary(bytes: Uint8Array): string {
  let out = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + step) as unknown as number[]);
  }
  return out;
}

function binaryToBytes(bin: string): Uint8Array {
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function pipeThrough(bytes: Uint8Array, transform: CompressionStream | DecompressionStream) {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Pack an offer/answer into a compact, copy-paste friendly code. */
export async function encodeSignal(payload: SignalPayload): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(payload));

  if (typeof CompressionStream !== 'undefined') {
    const packed = await pipeThrough(json, new CompressionStream('deflate-raw'));
    return `${COMPRESSED}.${base64url.encode(bytesToBinary(packed))}`;
  }
  return `${PLAIN}.${base64url.encode(bytesToBinary(json))}`;
}

/** Accepts a bare code OR a full share link (…#o=CODE / …#a=CODE). */
export function extractCode(input: string): string {
  let s = (input || '').trim();
  const m = s.match(/#(?:o|a)=([^&\s]+)/);
  if (m) s = m[1];
  return s.replace(/\s+/g, '');
}

/** Unpack a code produced by encodeSignal. Throws on bad input. */
export async function decodeSignal(
  input: string,
  expected?: 'offer' | 'answer'
): Promise<SignalPayload> {
  const code = extractCode(input);
  const dot = code.indexOf('.');
  if (dot < 1) throw new Error('Invalid code format');

  const version = code.slice(0, dot);
  const body = code.slice(dot + 1);

  let jsonBytes: Uint8Array;
  try {
    const raw = binaryToBytes(base64url.decode(body));
    if (version === COMPRESSED) {
      if (typeof DecompressionStream === 'undefined') {
        throw new Error('This browser cannot read compressed codes');
      }
      jsonBytes = await pipeThrough(raw, new DecompressionStream('deflate-raw'));
    } else if (version === PLAIN) {
      jsonBytes = raw;
    } else {
      throw new Error('Unsupported code version');
    }
  } catch (e) {
    if (e instanceof Error && /browser|version/i.test(e.message)) throw e;
    throw new Error('Invalid or corrupted code');
  }

  const payload = JSON.parse(new TextDecoder().decode(jsonBytes)) as SignalPayload;
  if (!payload || typeof payload.sdp !== 'string' || (payload.t !== 'offer' && payload.t !== 'answer')) {
    throw new Error('Invalid code contents');
  }
  if (expected && payload.t !== expected) {
    throw new Error(
      expected === 'offer'
        ? 'This is an answer code – paste the sender\'s offer code here'
        : 'This is an offer code – paste the receiver\'s answer code here'
    );
  }
  return payload;
}

/**
 * Share link that carries the code in the URL *fragment*.
 * Fragments are never sent to the web server, so even on public hosting the
 * host never sees the SDP.
 */
export function buildShareLink(code: string, kind: 'offer' | 'answer', page: string): string {
  const key = kind === 'offer' ? 'o' : 'a';
  return `${window.location.origin}${page}#${key}=${code}`;
}

/** Read (and clear) a code from the current URL fragment, if present. */
export function takeCodeFromHash(kind: 'offer' | 'answer'): string | null {
  const key = kind === 'offer' ? 'o' : 'a';
  const m = window.location.hash.match(new RegExp(`[#&]${key}=([^&]+)`));
  if (!m) return null;
  history.replaceState(null, '', window.location.pathname + window.location.search);
  return m[1];
}

/**
 * Resolve when ICE gathering is finished (all candidates are inside the local
 * SDP – required because there is no channel to trickle candidates over),
 * or after `timeoutMs`, whichever comes first.
 */
export function waitForIceGathering(pc: RTCPeerConnection, timeoutMs = 4000): Promise<void> {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();

    const done = () => {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', onChange);
      resolve();
    };
    const onChange = () => {
      if (pc.iceGatheringState === 'complete') done();
    };
    const timer = setTimeout(done, timeoutMs);
    pc.addEventListener('icegatheringstatechange', onChange);
  });
}