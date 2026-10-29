// shortCode.ts
// One short code instead of two giant SDP blobs.
//
//   sender  -> makes a code like  K7QXM-29PD9   (50 bits, ~11 chars)
//   receiver-> types it (or opens the link / scans the QR)
//   both    -> connect automatically, no copy-paste of an answer code
//
// How it works (no server of yours, nothing to host):
//   * The code is run through PBKDF2 -> (topic name, AES-256-GCM key).
//   * The SDP offer/answer is deflated, AES-GCM encrypted with that key and
//     dropped on a free public pub/sub relay (ntfy.sh) under that topic.
//   * The relay only ever sees an unguessable topic + ciphertext.
//   * The DTLS fingerprint lives inside the encrypted SDP, so only someone
//     who knows the code can take part => a man-in-the-middle on the relay
//     can't swap fingerprints. Data then flows peer-to-peer over WebRTC.
//
// Works on any static host (GitHub Pages, Netlify, Cloudflare Pages, ...)
// because the browser talks to the relay directly (fetch + EventSource).

import { base64url } from './base64';
import type { SignalPayload } from './manualSignaling';

/** ntfy-compatible relays. Add your own self-hosted ntfy here for more privacy/reliability. */
export const RELAYS: string[] = ['https://ntfy.sh'];

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32 (no I L O U)
const CODE_LEN = 10; // 10 * 5 bits = 50 bits of entropy
const PBKDF2_ITERS = 200_000; // slows offline guessing; ~100-300 ms in a browser
const SALT = new TextEncoder().encode('speed-share/short-code/v1');
const MAX_AGE_MS = 15 * 60 * 1000; // reject stale offers/answers
const MAX_WIRE_CHARS = 3900; // ntfy message limit is 4096 bytes
const enc = new TextEncoder();

/* ------------------------------------------------------------------ */
/* code helpers                                                         */
/* ------------------------------------------------------------------ */

export function generateCode(): string {
  const r = crypto.getRandomValues(new Uint8Array(CODE_LEN));
  return Array.from(r, (b) => ALPHABET[b & 31]).join(''); // 256 % 32 == 0 -> unbiased
}

/** K7QXM29PD9 -> K7QXM-29PD9 */
export function formatCode(code: string): string {
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

/** Accepts "k7qxm 29pd9", "K7QXM-29PD9" or a full share link. Returns null if it isn't a short code. */
export function normalizeCode(input: string): string | null {
  let s = (input || '').trim();
  const m = s.match(/#c=([^&\s]+)/);
  if (m) s = m[1];
  s = s.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  return new RegExp(`^[${ALPHABET}]{${CODE_LEN}}$`).test(s) ? s : null;
}

export function looksLikeShortCode(input: string): boolean {
  return normalizeCode(input) !== null;
}

export function buildCodeLink(code: string, page: string): string {
  return `${window.location.origin}${page}#c=${code}`;
}

/** Read (and clear) a short code from the URL fragment, if present. */
export function takeShortCodeFromHash(): string | null {
  const m = window.location.hash.match(/[#&]c=([^&]+)/);
  if (!m) return null;
  history.replaceState(null, '', window.location.pathname + window.location.search);
  return m[1];
}

/* ------------------------------------------------------------------ */
/* crypto                                                               */
/* ------------------------------------------------------------------ */

function bytesToB64u(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as unknown as number[]);
  }
  return base64url.encode(bin);
}

function b64uToBytes(s: string): Uint8Array {
  const bin = base64url.decode(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pipe(bytes: Uint8Array, t: CompressionStream | DecompressionStream) {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(t);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function derive(code: string): Promise<{ topic: string; key: CryptoKey }> {
  const base = await crypto.subtle.importKey('raw', enc.encode(code), 'PBKDF2', false, [
    'deriveBits'
  ]);
  const bits = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: SALT, iterations: PBKDF2_ITERS },
      base,
      384
    )
  );
  // bytes 0-15 -> topic id, bytes 16-47 -> AES key. Topic derivation is as slow
  // as key derivation, so the relay can't cheaply brute-force codes from topics.
  const topic = 'ss-' + bytesToB64u(bits.slice(0, 16));
  const key = await crypto.subtle.importKey('raw', bits.slice(16, 48), 'AES-GCM', false, [
    'encrypt',
    'decrypt'
  ]);
  return { topic, key };
}

type Role = 'offer' | 'answer';

async function seal(role: Role, key: CryptoKey, payload: SignalPayload): Promise<string> {
  let data: Uint8Array = enc.encode(JSON.stringify({ ts: Date.now(), p: payload }));
  let flag = 0;
  if (typeof CompressionStream !== 'undefined') {
    data = await pipe(data, new CompressionStream('deflate-raw'));
    flag = 1;
  }
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: enc.encode(role) }, // role bound => no reflection
      key,
      data as BufferSource
    )
  );
  const out = new Uint8Array(1 + 12 + ct.length);
  out[0] = flag;
  out.set(iv, 1);
  out.set(ct, 13);
  return bytesToB64u(out);
}

/** Returns null for anything that isn't a fresh, valid message for this role. */
async function open(role: Role, key: CryptoKey, wire: string): Promise<SignalPayload | null> {
  try {
    const raw = b64uToBytes(wire.trim());
    const flag = raw[0];
    const iv = raw.slice(1, 13);
    const ct = raw.slice(13);
    let data = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv, additionalData: enc.encode(role) },
        key,
        ct as BufferSource
      )
    );
    if (flag === 1) data = await pipe(data, new DecompressionStream('deflate-raw'));
    const { ts, p } = JSON.parse(new TextDecoder().decode(data)) as {
      ts: number;
      p: SignalPayload;
    };
    if (Math.abs(Date.now() - ts) > MAX_AGE_MS) return null; // stale
    if (!p || p.t !== role || typeof p.sdp !== 'string') return null;
    return p;
  } catch {
    return null; // wrong key / tampered / not ours
  }
}

/* ------------------------------------------------------------------ */
/* relay (ntfy: plain HTTP POST to publish, SSE to subscribe)           */
/* ------------------------------------------------------------------ */

async function publish(topic: string, message: string): Promise<void> {
  if (message.length > MAX_WIRE_CHARS) throw new Error('Signal too large for relay');
  try {
    await Promise.any(
      RELAYS.map(async (r) => {
        const res = await fetch(`${r}/${topic}`, { method: 'POST', body: message });
        if (!res.ok) throw new Error(`relay ${res.status}`);
      })
    );
  } catch {
    throw new Error('Relay unreachable');
  }
}

/** since=all => a peer that joins late still gets messages posted earlier (cached ~12h). */
function subscribe(topic: string, onMessage: (msg: string) => void): () => void {
  const seen = new Set<string>();
  const sources = RELAYS.map((r) => {
    const es = new EventSource(`${r}/${topic}/sse?since=all`);
    es.onmessage = (e) => {
      try {
        const d = JSON.parse(e.data);
        if (d.event !== 'message' || typeof d.message !== 'string' || seen.has(d.id)) return;
        seen.add(d.id);
        onMessage(d.message);
      } catch {
        /* ignore */
      }
    };
    return es;
  });
  return () => sources.forEach((s) => s.close());
}

/* ------------------------------------------------------------------ */
/* public API                                                           */
/* ------------------------------------------------------------------ */

export interface HostSession {
  /** 10 chars, e.g. "K7QXM29PD9" */
  code: string;
  /** "K7QXM-29PD9" */
  display: string;
  /** Resolves with the receiver's answer once they join. */
  answer: Promise<SignalPayload>;
  cancel(): void;
}

/** Sender side: publish the offer under a fresh code and wait for the answer. */
export async function hostSession(
  offer: SignalPayload,
  timeoutMs = 10 * 60 * 1000
): Promise<HostSession> {
  const code = generateCode();
  const { topic, key } = await derive(code);

  let resolveFn!: (p: SignalPayload) => void;
  let rejectFn!: (e: Error) => void;
  const answer = new Promise<SignalPayload>((res, rej) => {
    resolveFn = res;
    rejectFn = rej;
  });
  answer.catch(() => {}); // avoid unhandled-rejection noise on cancel

  const timer = setTimeout(() => {
    unsub();
    rejectFn(new Error('Code expired - create a new one'));
  }, timeoutMs);

  const unsub = subscribe(topic, async (msg) => {
    const p = await open('answer', key, msg);
    if (p) {
      clearTimeout(timer);
      unsub();
      resolveFn(p);
    }
  });

  try {
    await publish(topic, await seal('offer', key, offer));
  } catch (e) {
    clearTimeout(timer);
    unsub();
    throw e;
  }

  return {
    code,
    display: formatCode(code),
    answer,
    cancel() {
      clearTimeout(timer);
      unsub();
      rejectFn(new Error('Cancelled'));
    }
  };
}

export interface JoinSession {
  offer: SignalPayload;
  sendAnswer(answer: SignalPayload): Promise<void>;
}

/** Receiver side: look the code up, return the offer, and later post the answer. */
export async function joinSession(input: string, timeoutMs = 15000): Promise<JoinSession> {
  const code = normalizeCode(input);
  if (!code) throw new Error('That does not look like a valid code');
  const { topic, key } = await derive(code);

  const offer = await new Promise<SignalPayload>((resolve, reject) => {
    const timer = setTimeout(() => {
      unsub();
      reject(new Error('Code not found or expired'));
    }, timeoutMs);
    const unsub = subscribe(topic, async (msg) => {
      const p = await open('offer', key, msg);
      if (p) {
        clearTimeout(timer);
        unsub();
        resolve(p);
      }
    });
  });

  return {
    offer,
    sendAnswer: async (answer) => publish(topic, await seal('answer', key, answer))
  };
}

/**
 * Faster ICE gathering than waiting for "complete": resolve ~1.2 s after the
 * first public (srflx/relay) candidate shows up, when gathering completes, or
 * after `maxMs` - whichever is first.
 */
export function waitForIceFast(pc: RTCPeerConnection, maxMs = 4000, graceMs = 1200): Promise<void> {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    let grace: ReturnType<typeof setTimeout> | undefined;
    const done = () => {
      clearTimeout(hard);
      if (grace) clearTimeout(grace);
      pc.removeEventListener('icecandidate', onCand);
      pc.removeEventListener('icegatheringstatechange', onState);
      resolve();
    };
    const onCand = (e: RTCPeerConnectionIceEvent) => {
      if (!e.candidate) return done();
      const t = e.candidate.type;
      if ((t === 'srflx' || t === 'relay') && !grace) grace = setTimeout(done, graceMs);
    };
    const onState = () => {
      if (pc.iceGatheringState === 'complete') done();
    };
    const hard = setTimeout(done, maxMs);
    pc.addEventListener('icecandidate', onCand);
    pc.addEventListener('icegatheringstatechange', onState);
  });
}
