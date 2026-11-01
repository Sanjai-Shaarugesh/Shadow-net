// groups.svelte.ts - the whole groups feature as one reactive singleton: `hub`.
// Call `await hub.init()` once at app start (root layout) so messages are
// received app-wide, not only while GroupsPage is open.

import {
  b64u,
  randomId,
  newSecret,
  deriveGroupKeys,
  seal,
  open,
  newDeviceKeys,
  exportPub,
  wrapSecretFor,
  unwrapSecretFrom,
  type GroupKeys
} from './groupCrypto';
import { Mailbox, publish, MAX_WIRE_CHARS } from './mailbox';
import { kv, store, messagesFor, deleteMessagesFor, deleteOutboxFor } from './groupstore';
import { notify } from '../components/notify';
import { PeerLinks, DEFAULT_ICE, type LinkState, type SignalOut } from './peerlinks';

export interface Member {
  name: string;
  pub: string; // ECDH public JWK (empty until we have seen their hello)
}
export interface Group {
  gid: string;
  name: string;
  secret: string;
  epoch: number;
  owner: string;
  members: Record<string, Member>;
  createdAt: number;
}
export interface ChatMsg {
  id: string;
  gid: string;
  from: string;
  fromName: string;
  ts: number;
  text: string;
  sys?: boolean;
  pending?: boolean;
}

type Env = {
  id: string;
  gid: string;
  k: 'msg' | 'hello' | 'leave' | 'delete' | 'rekey' | 'presence' | 'rtc';
  from: string;
  fn: string;
  ts: number;
  text?: string;
  pub?: string;
  epoch?: number;
  to?: Record<string, string>; // deviceId -> new secret wrapped for that device
  drop?: string[];
  i?: string; // sending tab (so a tab ignores its own echo but still sees other tabs of the same device)
  re?: boolean; // presence: this is a reply, do not answer it
  rt?: SignalOut; // rtc: WebRTC signaling for one peer
};

interface OutboxItem {
  id: string;
  gid: string;
  topic: string;
  wire: string;
}

const KEEP_IN_MEMORY = 300;
const INVITE_PREFIX = 'g1.';
const enc = new TextEncoder();
const dec = new TextDecoder();

/* ---------------- invite helpers ---------------- */

export function takeInviteFromHash(): string | null {
  const m = window.location.hash.match(/[#&]g=([^&]+)/);
  if (!m) return null;
  history.replaceState(null, '', window.location.pathname + window.location.search);
  return m[1];
}

export function buildInviteLink(code: string, page: string): string {
  return `${window.location.origin}${page}#g=${code}`;
}

function parseInvite(input: string) {
  let s = (input || '').trim();
  const m = s.match(/#g=([^&\s]+)/);
  if (m) s = m[1];
  if (!s.startsWith(INVITE_PREFIX)) throw new Error('That is not a group invite');
  try {
    const j = JSON.parse(dec.decode(b64u.to(s.slice(INVITE_PREFIX.length))));
    if (!j.g || !j.s || !j.n) throw 0;
    return j as { g: string; n: string; s: string; e: number; o: string };
  } catch {
    throw new Error('Invalid or corrupted invite');
  }
}

/* ---------------- service ---------------- */

class GroupsService {
  ready = $state(false);
  deviceId = $state('');
  deviceName = $state('');
  groups = $state<Group[]>([]);
  messages = $state<Record<string, ChatMsg[]>>({});
  unread = $state<Record<string, number>>({});
  activeGid = $state<string | null>(null);
  /** Invite found in the page URL (#g=...). GroupsPanel pre-fills it into the Join box. */
  pendingInvite = $state('');
  /** false while another screen (chat/send/receive) covers the groups UI, so new messages still count as unread */
  panelVisible = $state(true);
  /** relay (ntfy) connection: 'online' once the live stream is open */
  relay = $state<'connecting' | 'online' | 'offline'>('connecting');
  /** last send/relay problem, shown in the UI instead of failing silently */
  lastError = $state('');
  initError = $state('');
  /** deviceId -> direct WebRTC link state. 'open' = connected right now. */
  peers = $state<Record<string, LinkState>>({});

  private priv!: CryptoKey;
  private pubJwk = '';
  private keys = new Map<string, GroupKeys>(); // gid -> keys
  private byTopic = new Map<string, string>(); // topic -> gid
  private lastSeen = 0; // unix seconds of the newest relay message processed
  private lastSeenSaved = 0;
  private repliedHello = new Set<string>();
  private mailbox!: Mailbox;
  private initP: Promise<void> | null = null;
  private inst = randomId(6); // this browser tab
  private isLeader = true; // only one tab per device runs the direct links
  private sync: BroadcastChannel | null = null;
  private lastAnnounce = new Map<string, number>();
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private links!: PeerLinks;
  private channelListeners = new Set<(id: string, dc: RTCDataChannel) => void>();

  init(): Promise<void> {
    return (this.initP ??= this.doInit().catch((e) => {
      this.initError = e instanceof Error ? e.message : String(e);
      console.error('groups init failed', e);
    }));
  }

  private async doInit() {
    // --- device identity (created once, persisted) ---
    let id = await kv.get<string>('deviceId');
    let name = await kv.get<string>('deviceName');
    let pair = await kv.get<CryptoKeyPair>('deviceKeys');
    if (!id || !pair) {
      id = randomId(9);
      name = name || 'Device-' + id.slice(0, 4);
      pair = await newDeviceKeys();
      await kv.set('deviceId', id);
      await kv.set('deviceName', name);
      await kv.set('deviceKeys', pair);
    }
    this.deviceId = id;
    this.deviceName = name || 'Device';
    this.priv = pair.privateKey;
    this.pubJwk = await exportPub(pair.publicKey);
    this.lastSeen = (await kv.get<number>('lastSeen')) ?? 0;
    this.lastSeenSaved = this.lastSeen;

    // --- groups + history from disk ---
    const saved = await store.all<Group>('groups');
    for (const g of saved) {
      await this.register(g);
      this.messages[g.gid] = await messagesFor<ChatMsg>(g.gid, KEEP_IN_MEMORY);
    }

    // --- live sync ---
    this.mailbox = new Mailbox(
      (topic, wire, time) => void this.onWire(topic, wire, time),
      () => (this.lastSeen > 0 ? String(Math.max(0, this.lastSeen - 30)) : 'all')
    );
    this.mailbox.setTopics([...this.byTopic.keys()]);
    this.mailbox.onStatus = (ok) => {
      this.relay = ok ? 'online' : 'offline';
      if (ok) void this.flushOutbox();
    };
    this.mailbox.start();

    // several tabs of the same browser share one device identity: keep them in step,
    // and let only one of them (the lock holder) run the direct WebRTC links
    if ('BroadcastChannel' in window) {
      this.sync = new BroadcastChannel('speed-share-groups');
      this.sync.onmessage = () => void this.reloadGroups();
    }
    if ('locks' in navigator) {
      this.isLeader = false;
      void navigator.locks.request('speed-share-links', () => {
        this.isLeader = true;
        this.announce(undefined, true);
        return new Promise<void>(() => {}); // hold until this tab closes
      });
    }

    // --- direct links to the other devices in my groups (auto connect + auto reconnect) ---
    this.links = new PeerLinks(
      this.deviceId,
      (gid, s) => {
        const g = this.find(gid);
        if (g) void this.post(g, this.env(g, 'rtc', { rt: s }), false).catch(() => {});
      },
      (gid) => this.announce(gid, true),
      DEFAULT_ICE
    );
    this.links.onState = (id, st) => {
      if (st === 'gone') delete this.peers[id];
      else this.peers[id] = st;
    };
    this.links.onChannel = (id, dc) => this.channelListeners.forEach((f) => f(id, dc));

    const wake = () => {
      void this.flushOutbox();
      this.announce();
      if (this.isLeader) this.links.kick();
    };
    window.addEventListener('online', wake);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      if (this.activeGid) this.unread[this.activeGid] = 0;
      wake();
    });
    wake();
    const inv = takeInviteFromHash();
    if (inv) this.pendingInvite = inv;
    this.ready = true;
  }

  get totalUnread(): number {
    return Object.values(this.unread).reduce((a, b) => a + b, 0);
  }

  /* ---------- helpers ---------- */

  find(gid: string): Group | undefined {
    return this.groups.find((g) => g.gid === gid);
  }

  isOwner(g: Group) {
    return g.owner === this.deviceId;
  }

  private async register(g: Group) {
    const k = await deriveGroupKeys(g.secret, g.epoch);
    this.keys.set(g.gid, k);
    this.byTopic.set(k.topic, g.gid);
    if (!this.find(g.gid)) this.groups.push(g);
    this.messages[g.gid] ??= [];
    this.unread[g.gid] ??= 0;
  }

  private async persist(g: Group) {
    await store.put('groups', $state.snapshot(g));
    this.sync?.postMessage(1);
  }

  /** Another tab of this device changed groups: pick the changes up from IndexedDB. */
  private async reloadGroups() {
    const saved = await store.all<Group>('groups');
    const ids = new Set(saved.map((g) => g.gid));
    this.deviceName = (await kv.get<string>('deviceName')) ?? this.deviceName;
    for (const g of saved) {
      const cur = this.find(g.gid);
      if (!cur) {
        await this.register(g);
        this.messages[g.gid] = await messagesFor<ChatMsg>(g.gid, KEEP_IN_MEMORY);
        continue;
      }
      if (cur.secret !== g.secret || cur.epoch !== g.epoch) {
        const old = this.keys.get(g.gid);
        if (old) this.byTopic.delete(old.topic);
        const nk = await deriveGroupKeys(g.secret, g.epoch);
        this.keys.set(g.gid, nk);
        this.byTopic.set(nk.topic, g.gid);
      }
      cur.name = g.name;
      cur.secret = g.secret;
      cur.epoch = g.epoch;
      cur.owner = g.owner;
      cur.members = g.members;
    }
    for (const g of [...this.groups]) if (!ids.has(g.gid)) this.dropState(g.gid);
    this.syncTopics();
  }

  private syncTopics() {
    this.mailbox?.setTopics([...this.byTopic.keys()]);
  }

  private addMessage(m: ChatMsg) {
    const list = this.messages[m.gid] ?? (this.messages[m.gid] = []);
    list.push(m);
    list.sort((a, b) => a.ts - b.ts);
    if (list.length > KEEP_IN_MEMORY) list.splice(0, list.length - KEEP_IN_MEMORY);
    void store.put('messages', $state.snapshot(m));
  }

  private sysMessage(gid: string, text: string) {
    this.addMessage({
      id: randomId(9),
      gid,
      from: '',
      fromName: '',
      ts: Date.now(),
      text,
      sys: true
    });
  }

  private saveLastSeen(time: number) {
    if (time > this.lastSeen) this.lastSeen = time;
    if (this.lastSeen - this.lastSeenSaved >= 1) {
      this.lastSeenSaved = this.lastSeen;
      void kv.set('lastSeen', this.lastSeen);
    }
  }

  /* ---------- sending ---------- */

  /** Encrypt + publish. If the relay is unreachable the wire is queued and retried. Returns true if sent now. */
  private async post(g: Group, env: Env, queue = true): Promise<boolean> {
    const k = this.keys.get(g.gid)!;
    const wire = await seal(k.key, k.topic, env);
    if (wire.length > MAX_WIRE_CHARS) throw new Error('Message too long');
    try {
      await publish(k.topic, wire);
      this.lastError = '';
      return true;
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : 'Relay unreachable';
      if (!queue) throw e;
      await store.put('outbox', {
        id: env.id,
        gid: g.gid,
        topic: k.topic,
        wire
      } satisfies OutboxItem);
      this.scheduleFlush();
      return false;
    }
  }

  private env(g: Group, k: Env['k'], extra: Partial<Env> = {}): Env {
    return {
      id: randomId(12),
      gid: g.gid,
      k,
      from: this.deviceId,
      i: this.inst,
      fn: this.deviceName,
      ts: Date.now(),
      ...extra
    };
  }

  async flushOutbox() {
    const items = await store.all<OutboxItem>('outbox');
    for (const it of items) {
      try {
        await publish(it.topic, it.wire);
        await store.del('outbox', it.id);
        const m = this.messages[it.gid]?.find((x) => x.id === it.id);
        if (m) {
          m.pending = false;
          void store.put('messages', $state.snapshot(m));
        }
      } catch (e) {
        this.lastError = e instanceof Error ? e.message : 'Relay unreachable';
        this.scheduleFlush();
        return; // retried automatically in a few seconds, and on 'online'
      }
      await new Promise((r) => setTimeout(r, 1200)); // stay under the relay's rate limit
    }
    if (items.length) this.lastError = '';
  }

  private scheduleFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flushOutbox();
    }, 8000);
  }

  async send(gid: string, text: string) {
    text = text.trim();
    const g = this.find(gid);
    if (!g || !text) return;
    const env = this.env(g, 'msg', { text });
    const ok = await this.post(g, env); // throws if too long, before anything is stored
    this.addMessage({
      id: env.id,
      gid,
      from: this.deviceId,
      fromName: this.deviceName,
      ts: env.ts,
      text,
      pending: !ok
    });
  }

  private async sendHello(g: Group) {
    try {
      await this.post(g, this.env(g, 'hello', { pub: this.pubJwk }));
    } catch {
      /* ignore */
    }
  }

  /* ---------- receiving ---------- */

  private async onWire(topic: string, wire: string, time: number) {
    const gid = this.byTopic.get(topic);
    const g = gid ? this.find(gid) : undefined;
    const k = gid ? this.keys.get(gid) : undefined;
    if (!g || !k) return;

    const env = await open<Env>(k.key, k.topic, wire);
    this.saveLastSeen(time);
    if (!env || env.gid !== g.gid) return;
    if (env.from === this.deviceId) {
      // my own message: this tab's echo is ignored; a message from ANOTHER tab of this
      // device (same browser) is shown here too, as mine
      if (
        env.i !== this.inst &&
        env.k === 'msg' &&
        !this.messages[g.gid]?.some((x) => x.id === env.id)
      ) {
        this.addMessage({
          id: env.id,
          gid: g.gid,
          from: this.deviceId,
          fromName: this.deviceName,
          ts: env.ts,
          text: env.text ?? ''
        });
      }
      return;
    }
    const age = time ? Date.now() / 1000 - time : (Date.now() - env.ts) / 1000;

    switch (env.k) {
      case 'presence': {
        if (age > 60 || !this.isLeader) return; // stale (replayed from the relay) / not my job
        if (!env.re)
          void this.post(g, this.env(g, 'presence', { re: true }), false).catch(() => {});
        this.links.peerSeen(g.gid, env.from);
        break;
      }
      case 'rtc': {
        if (age > 60 || !this.isLeader || env.rt?.to !== this.deviceId) return;
        void this.links.onSignal(g.gid, env.from, env.rt);
        break;
      }
      case 'msg': {
        if (this.messages[g.gid]?.some((x) => x.id === env.id)) return; // duplicate (replay on reconnect)
        const m = (g.members[env.from] ??= { name: env.fn, pub: '' });
        m.name = env.fn;
        void this.persist(g);
        this.addMessage({
          id: env.id,
          gid: g.gid,
          from: env.from,
          fromName: env.fn,
          ts: env.ts,
          text: env.text ?? ''
        });
        if (document.hidden || !this.panelVisible || this.activeGid !== g.gid) {
          this.unread[g.gid] = (this.unread[g.gid] ?? 0) + 1;
          void notify(g.name, `${env.fn}: ${env.text ?? ''}`, g.gid);
        }
        break;
      }
      case 'hello': {
        const known = !!g.members[env.from]?.pub;
        g.members[env.from] = { name: env.fn, pub: env.pub ?? '' };
        void this.persist(g);
        // teach the newcomer who we are, once per (group, peer) per session
        const key = g.gid + env.from;
        if (!known && !this.repliedHello.has(key)) {
          this.repliedHello.add(key);
          void this.sendHello(g);
          this.sysMessage(g.gid, `${env.fn} joined`);
        }
        break;
      }
      case 'leave': {
        const name = g.members[env.from]?.name ?? env.fn;
        delete g.members[env.from];
        void this.persist(g);
        this.pruneLink(env.from);
        this.sysMessage(g.gid, `${name} left`);
        break;
      }
      case 'delete': {
        if (env.from === g.owner) {
          void notify(g.name, 'This group was deleted by its owner', g.gid);
          await this.removeLocal(g.gid);
        }
        break;
      }
      case 'rekey': {
        if (env.from !== g.owner || !env.epoch || env.epoch <= g.epoch) return;
        if (env.drop?.includes(this.deviceId)) {
          void notify(g.name, 'You were removed from this group', g.gid);
          await this.removeLocal(g.gid);
          return;
        }
        const wrapped = env.to?.[this.deviceId];
        const ownerPub = g.members[g.owner]?.pub;
        if (!wrapped || !ownerPub) return;
        const secret = await unwrapSecretFrom(
          this.priv,
          ownerPub,
          wrapped,
          `${g.gid}:${env.epoch}`
        );
        if (!secret) return;
        this.byTopic.delete(k.topic);
        g.secret = secret;
        g.epoch = env.epoch;
        for (const d of env.drop ?? []) delete g.members[d];
        const nk = await deriveGroupKeys(secret, env.epoch);
        this.keys.set(g.gid, nk);
        this.byTopic.set(nk.topic, g.gid);
        await this.persist(g);
        this.syncTopics();
        this.sysMessage(g.gid, 'Group key changed');
        break;
      }
    }
  }

  /* ---------- group actions ---------- */

  async createGroup(name: string): Promise<Group> {
    name = name.trim();
    if (!name) throw new Error('Give the group a name');
    const g: Group = {
      gid: randomId(9),
      name,
      secret: newSecret(),
      epoch: 0,
      owner: this.deviceId,
      members: { [this.deviceId]: { name: this.deviceName, pub: this.pubJwk } },
      createdAt: Date.now()
    };
    await this.register(g);
    await this.persist(g);
    this.syncTopics();
    return this.find(g.gid)!;
  }

  /** Invite code for a group. Anyone who has it becomes a full member - share it only with people you trust. */
  inviteCode(gid: string): string {
    const g = this.find(gid);
    if (!g) throw new Error('Unknown group');
    const json = JSON.stringify({ g: g.gid, n: g.name, s: g.secret, e: g.epoch, o: g.owner });
    return INVITE_PREFIX + b64u.from(enc.encode(json));
  }

  async join(input: string): Promise<Group> {
    const inv = parseInvite(input);
    const existing = this.find(inv.g);
    if (existing) return existing;
    const g: Group = {
      gid: inv.g,
      name: inv.n,
      secret: inv.s,
      epoch: inv.e ?? 0,
      owner: inv.o,
      members: { [this.deviceId]: { name: this.deviceName, pub: this.pubJwk } },
      createdAt: Date.now()
    };
    await this.register(g);
    await this.persist(g);
    this.syncTopics();
    await this.sendHello(this.find(g.gid)!);
    return this.find(g.gid)!;
  }

  async leave(gid: string) {
    const g = this.find(gid);
    if (!g) return;
    try {
      await this.post(g, this.env(g, 'leave'));
    } catch {
      /* ignore */
    }
    await this.removeLocal(gid);
  }

  /** Owner only: tells every member to drop the group, then removes it here. Others just leave. */
  async deleteForEveryone(gid: string) {
    const g = this.find(gid);
    if (!g) return;
    if (!this.isOwner(g)) return this.leave(gid);
    try {
      await this.post(g, this.env(g, 'delete'));
    } catch {
      /* ignore */
    }
    await this.removeLocal(gid);
  }

  /**
   * Owner only: remove a member and rotate the group key. The new secret is sent
   * encrypted individually to each remaining member, so the removed device can't
   * read anything new. Members not seen online since the rotation (offline > relay
   * retention) must be re-invited.
   */
  async removeMember(gid: string, deviceId: string) {
    const g = this.find(gid);
    if (!g || !this.isOwner(g) || deviceId === this.deviceId) return;
    const epoch = g.epoch + 1;
    const secret = newSecret();
    const to: Record<string, string> = {};
    for (const [id, m] of Object.entries(g.members)) {
      if (id === this.deviceId || id === deviceId) continue;
      if (!m.pub)
        throw new Error(`${m.name} has not been seen yet - ask them to open the app first`);
      to[id] = await wrapSecretFor(this.priv, m.pub, secret, `${g.gid}:${epoch}`);
    }
    // announce on the OLD topic, then switch
    const ok = await this.post(g, this.env(g, 'rekey', { epoch, to, drop: [deviceId] }));
    if (!ok) throw new Error('Relay unreachable - try again');
    const old = this.keys.get(g.gid)!;
    this.byTopic.delete(old.topic);
    delete g.members[deviceId];
    this.pruneLink(deviceId);
    g.secret = secret;
    g.epoch = epoch;
    const nk = await deriveGroupKeys(secret, epoch);
    this.keys.set(g.gid, nk);
    this.byTopic.set(nk.topic, g.gid);
    await this.persist(g);
    this.syncTopics();
    this.sysMessage(g.gid, 'Member removed, group key changed');
  }

  private async removeLocal(gid: string) {
    this.dropState(gid);
    await store.del('groups', gid);
    await deleteMessagesFor(gid);
    await deleteOutboxFor(gid);
    this.sync?.postMessage(1);
  }

  /** Forget a group in memory only (the database is handled by the caller / the other tab). */
  private dropState(gid: string) {
    const k = this.keys.get(gid);
    const gone = this.find(gid);
    if (k) this.byTopic.delete(k.topic);
    this.keys.delete(gid);
    this.groups = this.groups.filter((g) => g.gid !== gid);
    if (gone) Object.keys(gone.members).forEach((id) => this.pruneLink(id));
    delete this.messages[gid];
    delete this.unread[gid];
    if (this.activeGid === gid) this.activeGid = null;
    this.syncTopics();
  }

  /** Tell the other devices in my groups that I am online (they answer, then a direct link is built). */
  announce(onlyGid?: string, force = false) {
    if (!this.isLeader) return;
    const now = Date.now();
    for (const g of this.groups) {
      if (onlyGid && g.gid !== onlyGid) continue;
      // the public relay rate-limits, so don't repeat presence more than every 10 s
      if (!force && now - (this.lastAnnounce.get(g.gid) ?? 0) < 10_000) continue;
      this.lastAnnounce.set(g.gid, now);
      void this.post(g, this.env(g, 'presence'), false).catch(() => {});
    }
  }

  /** Close the direct link to a device once no remaining group contains it. */
  private pruneLink(id: string) {
    if (id === this.deviceId) return;
    if (this.groups.some((g) => g.members[id])) return;
    this.links.close(id);
  }

  /** The open data channel to a device, or null. Use it for files, calls, anything direct. */
  peerChannel(id: string): RTCDataChannel | null {
    return this.links?.channel(id) ?? null;
  }

  /** Called every time a direct channel (re)opens - attach your file-transfer handlers here. */
  onPeerChannel(fn: (id: string, dc: RTCDataChannel) => void) {
    this.channelListeners.add(fn);
    return () => this.channelListeners.delete(fn);
  }

  /** Use your own STUN/TURN. TURN is needed when two phones are on strict mobile-carrier NATs. */
  setIceServers(servers: RTCIceServer[]) {
    this.links.iceServers = servers;
  }

  async setDeviceName(name: string) {
    name = name.trim().slice(0, 30);
    if (!name) return;
    this.deviceName = name;
    await kv.set('deviceName', name);
    for (const g of this.groups) {
      if (g.members[this.deviceId]) g.members[this.deviceId].name = name;
      void this.persist(g);
      void this.sendHello(g);
    }
  }

  open(gid: string | null) {
    this.activeGid = gid;
    if (gid) this.unread[gid] = 0;
  }
}

export const hub = new GroupsService();
