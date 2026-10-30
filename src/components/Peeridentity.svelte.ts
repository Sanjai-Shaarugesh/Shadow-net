// Peer names ("Peer 1" / "Peer 2" by default, editable, synced to the other side).
// Uses its own tiny pre-negotiated data channel, so it does not touch your
// Message protobuf, ControlChannel or the SDP exchange.
//
// attach(connection, 'offer')  -> OfferPage  (defaults: me = Peer 1, peer = Peer 2)
// attach(connection, 'answer') -> ReceivePage (defaults: me = Peer 2, peer = Peer 1)
// Call attach() right after `new RTCPeerConnection(...)` on BOTH sides.

const CHANNEL_ID = 42; // must not collide with other negotiated channels (ControlChannel etc.)
const MAX_LEN = 24;

export type Role = 'offer' | 'answer';

const fallback = (r: Role) => (r === 'offer' ? 'Peer 1' : 'Peer 2');

const clean = (s: unknown): string =>
  typeof s === 'string'
    ? s
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, MAX_LEN)
    : '';

class PeerIdentity {
  role = $state<Role>('offer');
  custom = $state(''); // my chosen name ('' = default)
  peerCustom = $state(''); // peer's chosen name ('' = default)

  me = $derived(this.custom || fallback(this.role));
  peer = $derived(this.peerCustom || fallback(this.role === 'offer' ? 'answer' : 'offer'));

  #ch?: RTCDataChannel;

  attach(conn: RTCPeerConnection, role: Role) {
    this.detach();
    this.role = role;
    const ch = conn.createDataChannel('identity', { negotiated: true, id: CHANNEL_ID });
    ch.onopen = () => {
      this.#send({ t: 'name', n: this.custom });
      this.#send({ t: 'ask' }); // whoever opens second still gets the other's name
    };
    ch.onmessage = (e) => {
      try {
        const m = JSON.parse(String(e.data));
        if (m.t === 'name') this.peerCustom = clean(m.n);
        else if (m.t === 'ask') this.#send({ t: 'name', n: this.custom });
      } catch {
        /* ignore junk */
      }
    };
    this.#ch = ch;
  }

  /** Change my name; the peer sees it immediately. Empty string = back to default. */
  rename(name: string) {
    this.custom = clean(name);
    this.#send({ t: 'name', n: this.custom });
  }

  detach() {
    try {
      this.#ch?.close();
    } catch {
      /* already closed */
    }
    this.#ch = undefined;
    this.peerCustom = '';
  }

  #send(m: object) {
    if (this.#ch?.readyState === 'open') this.#ch.send(JSON.stringify(m));
  }
}

export const identity = new PeerIdentity();
