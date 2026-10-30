// session.svelte.ts
// In-memory state for one peer session: chat history, typing, and the raw file previews
// (outgoing + incoming). Lives only as long as the page; nothing is persisted.

import type { ControlChannel } from '../utils/controlChannel';
import type { PreviewInfo } from '../utils/filePreview';

export interface ChatMsg {
  id: string;
  from: 'me' | 'peer';
  text: string;
  ts: number;
  state: 'sending' | 'sent' | 'delivered' | 'read';
}

export interface PreviewEntry {
  phase: 'preparing' | 'ready';
  info?: PreviewInfo;
  bytes?: Uint8Array; // raw thumbnail bytes / first bytes (hex)
  url?: string; // object URL for image/video thumbnails
}

export const MAX_CHAT_LEN = 4000;

class Session {
  messages = $state<ChatMsg[]>([]);
  unread = $state(0);
  peerTyping = $state(false);
  connected = $state(false);
  out = $state<Record<string, PreviewEntry>>({});
  inc = $state<Record<string, PreviewEntry>>({});

  /** set by the shell: true while the Chat tab is on screen */
  chatVisible = false;

  private ctrl?: ControlChannel;
  private offs: Array<() => void> = [];
  private typingTimer?: ReturnType<typeof setTimeout>;
  private typingSentAt = 0;

  bind(ctrl: ControlChannel) {
    this.unbind();
    this.ctrl = ctrl;
    this.offs.push(
      ctrl.onOpenChange((o) => (this.connected = o)),
      ctrl.on('chat', (m) => {
        if (this.messages.some((x) => x.id === m.id)) return;
        this.messages.push({
          id: m.id,
          from: 'peer',
          text: String(m.text).slice(0, MAX_CHAT_LEN),
          ts: m.ts || Date.now(),
          state: 'delivered'
        });
        this.peerTyping = false;
        const seen = this.chatVisible && document.visibilityState === 'visible';
        ctrl.send({ t: 'ack', id: m.id, s: seen ? 'read' : 'delivered' });
        if (!seen) this.unread++;
        else this.peerMsg(m.id).state = 'read';
      }),
      ctrl.on('ack', (m) => {
        const msg = this.messages.find((x) => x.id === m.id && x.from === 'me');
        if (!msg) return;
        if (m.s === 'read' || msg.state !== 'read') msg.state = m.s;
      }),
      ctrl.on('typing', (m) => {
        this.peerTyping = m.on;
        clearTimeout(this.typingTimer);
        if (m.on) this.typingTimer = setTimeout(() => (this.peerTyping = false), 5000);
      }),
      ctrl.on('preview', (m, bytes) => {
        const prev = this.inc[m.id];
        if (prev?.url) URL.revokeObjectURL(prev.url);
        const url =
          bytes?.length && m.info.thumbMime
            ? URL.createObjectURL(new Blob([bytes as BlobPart], { type: m.info.thumbMime }))
            : undefined;
        this.inc[m.id] = { phase: 'ready', info: m.info, bytes, url };
      })
    );
  }

  private peerMsg(id: string) {
    return this.messages.find((x) => x.id === id)!;
  }

  sendChat(text: string): boolean {
    const t = text.trim().slice(0, MAX_CHAT_LEN);
    if (!t || !this.ctrl) return false;
    const msg: ChatMsg = {
      id: crypto.randomUUID(),
      from: 'me',
      text: t,
      ts: Date.now(),
      state: 'sending'
    };
    this.messages.push(msg);
    const ok = this.ctrl.send({ t: 'chat', id: msg.id, text: t, ts: msg.ts });
    msg.state = ok ? 'sent' : 'sending';
    this.setTyping(false);
    return ok;
  }

  setTyping(on: boolean) {
    if (!this.ctrl) return;
    const now = Date.now();
    if (on && now - this.typingSentAt < 2500) return; // throttle
    this.typingSentAt = on ? now : 0;
    this.ctrl.send({ t: 'typing', on });
  }

  /** Chat tab opened: clear badge and tell the peer we read everything. */
  markRead() {
    this.unread = 0;
    for (const m of this.messages) {
      if (m.from === 'peer' && m.state !== 'read') {
        m.state = 'read';
        this.ctrl?.send({ t: 'ack', id: m.id, s: 'read' });
      }
    }
  }

  clearChat() {
    this.messages = [];
    this.unread = 0;
  }

  setOutgoing(key: string, entry: PreviewEntry) {
    const prev = this.out[key];
    if (prev?.url && prev.url !== entry.url) URL.revokeObjectURL(prev.url);
    this.out[key] = entry;
  }

  dropOutgoing(key: string) {
    const e = this.out[key];
    if (e?.url) URL.revokeObjectURL(e.url);
    delete this.out[key];
  }

  dropIncoming(key: string) {
    const e = this.inc[key];
    if (e?.url) URL.revokeObjectURL(e.url);
    delete this.inc[key];
  }

  /** Resolves with the incoming preview (codec info), waiting briefly if it is still in flight. */
  async waitIncoming(key: string, ms = 5000): Promise<PreviewEntry | undefined> {
    const t0 = Date.now();
    while (!this.inc[key]?.info && Date.now() - t0 < ms)
      await new Promise((r) => setTimeout(r, 100));
    return this.inc[key];
  }

  unbind() {
    this.offs.forEach((f) => f());
    this.offs = [];
  }

  reset() {
    this.unbind();
    Object.keys(this.out).forEach((k) => this.dropOutgoing(k));
    Object.keys(this.inc).forEach((k) => this.dropIncoming(k));
    this.messages = [];
    this.unread = 0;
    this.peerTyping = false;
    this.connected = false;
    this.ctrl = undefined;
  }
}

export const session = new Session();
