// peerLinks.ts - one direct WebRTC data channel per group member, kept alive automatically.
//
// Signaling (offer / answer / ICE) travels through the group's encrypted mailbox, so no
// copy-paste codes are needed. The device with the smaller deviceId always makes the offer,
// which avoids both sides offering at once. When a link drops it retries with backoff and
// reconnects when the peer announces itself again (app opened, tab focused, network back).
//
// A browser cannot keep a WebRTC link alive while the page is closed or suspended. What this
// gives you is: the moment both devices are open at the same time, they link up on their own.

import { randomId } from './groupCrypto';

export type LinkState = 'connecting' | 'open' | 'down';

export interface SignalOut {
  to: string;
  sid: string;
  k: 'offer' | 'answer' | 'ice';
  d: any;
}

interface Link {
  id: string;
  gid: string;
  sid: string;
  initiator: boolean;
  pc: RTCPeerConnection;
  dc: RTCDataChannel | null;
  state: LinkState;
  remoteSet: boolean;
  queued: RTCIceCandidateInit[];
  timer?: ReturnType<typeof setTimeout>;
}

const MAX_TRIES = 5;
const CONNECT_TIMEOUT = 20_000;
const DISCONNECT_GRACE = 8_000;

export const DEFAULT_ICE: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' }
];

export class PeerLinks {
  private links = new Map<string, Link>();
  private early = new Map<string, RTCIceCandidateInit[]>(); // ICE that arrived before its offer
  private tries = new Map<string, number>();
  private retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private gids = new Map<string, string>(); // peer -> group we last saw them in

  onState: (id: string, state: LinkState | 'gone') => void = () => {};
  onChannel: (id: string, dc: RTCDataChannel) => void = () => {};

  constructor(
    private selfId: string,
    private sendSignal: (gid: string, s: SignalOut) => void,
    private askPresence: (gid: string) => void,
    public iceServers: RTCIceServer[] = DEFAULT_ICE
  ) {}

  state(id: string): LinkState | 'none' {
    return this.links.get(id)?.state ?? 'none';
  }

  channel(id: string): RTCDataChannel | null {
    const l = this.links.get(id);
    return l?.state === 'open' && l.dc?.readyState === 'open' ? l.dc : null;
  }

  send(id: string, data: string | ArrayBuffer | Blob): boolean {
    const dc = this.channel(id);
    if (!dc) return false;
    try {
      dc.send(data as any);
      return true;
    } catch {
      return false;
    }
  }

  /** A fresh presence message from `id` arrived in group `gid`. */
  peerSeen(gid: string, id: string) {
    if (id === this.selfId) return;
    this.gids.set(id, gid);
    const l = this.links.get(id);
    if (l && (l.state === 'open' || l.state === 'connecting')) return;
    this.tries.set(id, 0);
    this.clearRetry(id);
    if (this.selfId < id) void this.connect(gid, id);
    // otherwise the peer (smaller id) will offer after it sees our presence
  }

  /** App became visible / network came back: retry every known peer that is not connected. */
  kick() {
    for (const id of this.gids.keys()) {
      const l = this.links.get(id);
      if (l && l.state !== 'down') continue;
      this.tries.set(id, 0);
      this.clearRetry(id);
      this.retry(id);
    }
  }

  close(id: string) {
    this.clearRetry(id);
    this.tries.delete(id);
    this.gids.delete(id);
    if (this.links.has(id)) {
      this.closeLink(id);
      this.onState(id, 'gone');
    }
  }

  closeAll() {
    [...this.links.keys(), ...this.gids.keys()].forEach((id) => this.close(id));
  }

  /* ---------------- signaling in ---------------- */

  async onSignal(gid: string, from: string, s: SignalOut) {
    this.gids.set(from, gid);

    if (s.k === 'offer') {
      this.closeLink(from); // a new offer always replaces an old link
      const l = this.make(gid, from, s.sid, false);
      l.queued = this.early.get(`${from}:${s.sid}`) ?? [];
      this.early.delete(`${from}:${s.sid}`);
      l.pc.ondatachannel = (e) => {
        l.dc = e.channel;
        this.attach(l, e.channel);
      };
      try {
        await l.pc.setRemoteDescription(s.d);
        l.remoteSet = true;
        await this.flush(l);
        await l.pc.setLocalDescription(await l.pc.createAnswer());
        this.sendSignal(gid, {
          to: from,
          sid: s.sid,
          k: 'answer',
          d: l.pc.localDescription!.toJSON()
        });
      } catch {
        this.down(l);
      }
      return;
    }

    const cands: RTCIceCandidateInit[] = s.k === 'ice' ? (Array.isArray(s.d) ? s.d : [s.d]) : [];
    const l = this.links.get(from);
    if (!l || l.sid !== s.sid) {
      if (s.k === 'ice') {
        const key = `${from}:${s.sid}`;
        if (this.early.size > 50) this.early.clear();
        this.early.set(key, [...(this.early.get(key) ?? []), ...cands]);
      }
      return;
    }
    try {
      if (s.k === 'answer') {
        if (l.remoteSet || !l.initiator) return;
        await l.pc.setRemoteDescription(s.d);
        l.remoteSet = true;
        await this.flush(l);
      } else if (s.k === 'ice') {
        if (l.remoteSet) for (const c of cands) await l.pc.addIceCandidate(c).catch(() => {});
        else l.queued.push(...cands);
      }
    } catch {
      this.down(l);
    }
  }

  /* ---------------- internals ---------------- */

  private make(gid: string, id: string, sid: string, initiator: boolean): Link {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const l: Link = {
      id,
      gid,
      sid,
      initiator,
      pc,
      dc: null,
      state: 'connecting',
      remoteSet: false,
      queued: []
    };
    this.links.set(id, l);

    // Candidates are batched into ONE relay message: a public relay rate-limits bursts,
    // and one message per candidate (10+) would get the real messages rejected.
    const out: RTCIceCandidateInit[] = [];
    let flushT: ReturnType<typeof setTimeout> | undefined;
    const flushIce = () => {
      flushT = undefined;
      if (!out.length || this.links.get(id) !== l) return;
      this.sendSignal(gid, { to: id, sid, k: 'ice', d: out.splice(0) });
    };
    pc.onicecandidate = (e) => {
      if (this.links.get(id) !== l) return;
      if (e.candidate) {
        out.push(e.candidate.toJSON());
        flushT ??= setTimeout(flushIce, 500);
      } else {
        clearTimeout(flushT); // end of gathering
        flushIce();
      }
    };
    // STUN timeouts on one interface (often IPv6/VPN) are normal and not a failure
    pc.onicecandidateerror = () => {};
    pc.onconnectionstatechange = () => {
      if (this.links.get(id) !== l) return;
      const s = pc.connectionState;
      if (s === 'failed' || s === 'closed') this.down(l);
      else if (s === 'disconnected') {
        setTimeout(() => {
          if (this.links.get(id) === l && pc.connectionState === 'disconnected') this.down(l);
        }, DISCONNECT_GRACE);
      }
    };
    l.timer = setTimeout(() => {
      if (l.state === 'connecting') this.down(l);
    }, CONNECT_TIMEOUT);
    this.onState(id, 'connecting');
    return l;
  }

  private async connect(gid: string, id: string) {
    this.closeLink(id);
    const l = this.make(gid, id, randomId(6), true);
    l.dc = l.pc.createDataChannel('peer');
    this.attach(l, l.dc);
    try {
      await l.pc.setLocalDescription(await l.pc.createOffer());
      this.sendSignal(gid, { to: id, sid: l.sid, k: 'offer', d: l.pc.localDescription!.toJSON() });
    } catch {
      this.down(l);
    }
  }

  private attach(l: Link, dc: RTCDataChannel) {
    dc.binaryType = 'arraybuffer';
    dc.onopen = () => {
      if (this.links.get(l.id) !== l) return;
      clearTimeout(l.timer);
      l.state = 'open';
      this.tries.set(l.id, 0);
      this.onState(l.id, 'open');
      this.onChannel(l.id, dc);
    };
    dc.onclose = () => this.down(l);
  }

  private async flush(l: Link) {
    const q = l.queued;
    l.queued = [];
    for (const c of q) await l.pc.addIceCandidate(c).catch(() => {});
  }

  private down(l: Link) {
    if (this.links.get(l.id) !== l || l.state === 'down') return;
    clearTimeout(l.timer);
    try {
      l.pc.close();
    } catch {}
    l.state = 'down';
    this.onState(l.id, 'down');
    this.scheduleRetry(l.id);
  }

  private closeLink(id: string) {
    const l = this.links.get(id);
    if (!l) return;
    this.links.delete(id); // handlers check identity, so they go quiet
    clearTimeout(l.timer);
    try {
      l.pc.close();
    } catch {}
  }

  private scheduleRetry(id: string) {
    const n = this.tries.get(id) ?? 0;
    if (n >= MAX_TRIES) return; // wait for the peer's next presence / kick()
    this.tries.set(id, n + 1);
    this.clearRetry(id);
    this.retryTimers.set(
      id,
      setTimeout(() => this.retry(id), Math.min(3000 * 2 ** n, 60_000))
    );
  }

  private retry(id: string) {
    const gid = this.gids.get(id);
    const l = this.links.get(id);
    if (!gid || (l && l.state !== 'down')) return;
    if (this.selfId < id) void this.connect(gid, id);
    else this.askPresence(gid); // ask the smaller-id peer to offer again
  }

  private clearRetry(id: string) {
    const t = this.retryTimers.get(id);
    if (t) clearTimeout(t);
    this.retryTimers.delete(id);
  }
}
