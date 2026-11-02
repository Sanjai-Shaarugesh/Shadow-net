// groupCrypto.ts
// Group secret -> (relay topic, AES-256-GCM key) via HKDF.
// Per-device ECDH keypair is used only to hand a NEW group secret to specific
// members when someone is removed (key rotation).

import { base64url } from './base64';

const enc = new TextEncoder();
const dec = new TextDecoder();

export const b64u = {
  from(bytes: Uint8Array): string {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as unknown as number[]);
    }
    return base64url.encode(bin);
  },
  to(s: string): Uint8Array {
    const bin = base64url.decode(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
};

export const randomId = (bytes = 12) => b64u.from(crypto.getRandomValues(new Uint8Array(bytes)));
export const newSecret = () => randomId(16); // 128 bits

export interface GroupKeys {
  topic: string;
  key: CryptoKey;
}

/** secret + epoch -> topic name + AES key. A new epoch (after a removal) gives a new topic. */
export async function deriveGroupKeys(secret: string, epoch: number): Promise<GroupKeys> {
  const base = await crypto.subtle.importKey(
    'raw',
    b64u.to(secret) as BufferSource,
    'HKDF',
    false,
    ['deriveBits']
  );
  const bits = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: enc.encode('speed-share/group/v1'),
        info: enc.encode('e' + epoch)
      },
      base,
      384
    )
  );
  const topic = 'sg-' + b64u.from(bits.slice(0, 16));
  const key = await crypto.subtle.importKey(
    'raw',
    bits.slice(16, 48) as BufferSource,
    'AES-GCM',
    false,
    ['encrypt', 'decrypt']
  );
  return { topic, key };
}

/** Encrypt any JSON value. Topic is bound as AAD so a message can't be replayed into another group. */
export async function seal(key: CryptoKey, aad: string, obj: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: enc.encode(aad) },
      key,
      enc.encode(JSON.stringify(obj))
    )
  );
  const out = new Uint8Array(12 + ct.length);
  out.set(iv, 0);
  out.set(ct, 12);
  return b64u.from(out);
}

/** Returns null for anything that is not a valid message for this key/topic. */
export async function open<T>(key: CryptoKey, aad: string, wire: string): Promise<T | null> {
  try {
    const raw = b64u.to(wire.trim());
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: raw.slice(0, 12) as BufferSource, additionalData: enc.encode(aad) },
      key,
      raw.slice(12) as BufferSource
    );
    return JSON.parse(dec.decode(pt)) as T;
  } catch {
    return null;
  }
}

/* ---------------- device identity (ECDH P-256) ---------------- */

export async function newDeviceKeys(): Promise<CryptoKeyPair> {
  // private key is non-extractable but can still be stored in IndexedDB
  return crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, [
    'deriveKey'
  ]) as Promise<CryptoKeyPair>;
}

export async function exportPub(pub: CryptoKey): Promise<string> {
  const { kty, crv, x, y } = await crypto.subtle.exportKey('jwk', pub);
  return JSON.stringify({ kty, crv, x, y });
}

async function sharedKey(priv: CryptoKey, theirPub: string): Promise<CryptoKey> {
  const pub = await crypto.subtle.importKey(
    'jwk',
    JSON.parse(theirPub),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );
  return crypto.subtle.deriveKey(
    { name: 'ECDH', public: pub },
    priv,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function wrapSecretFor(
  priv: CryptoKey,
  theirPub: string,
  secret: string,
  aad: string
): Promise<string> {
  const key = await sharedKey(priv, theirPub);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: enc.encode(aad) },
      key,
      enc.encode(secret)
    )
  );
  const out = new Uint8Array(12 + ct.length);
  out.set(iv, 0);
  out.set(ct, 12);
  return b64u.from(out);
}

export async function unwrapSecretFrom(
  priv: CryptoKey,
  theirPub: string,
  wire: string,
  aad: string
): Promise<string | null> {
  try {
    const key = await sharedKey(priv, theirPub);
    const raw = b64u.to(wire);
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: raw.slice(0, 12) as BufferSource, additionalData: enc.encode(aad) },
      key,
      raw.slice(12) as BufferSource
    );
    return dec.decode(pt);
  } catch {
    return null;
  }
}
