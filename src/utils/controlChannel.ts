// controlChannel.ts
// Second, pre-negotiated RTCDataChannel (id 100, ordered, reliable) that carries
// everything that is NOT file bytes: chat, call invites, previews, acks.
// "negotiated: true" means both peers create it themselves with the same id, so it
// needs no SDP change and works with the existing offer/answer + short-code flow.
// id 100 is even and far from the auto-allocated id of the in-band 'data' channel.

import type { PreviewInfo } from './filePreview';

export type CtrlMsg =
  | { t: 'chat'; id: string; text: string; ts: number }
  | { t: 'ack'; id: string; s: 'delivered' | 'read' }
  | { t: 'typing'; on: boolean }
  | { t: 'call-invite'; callId: string; kind: 'audio' | 'video' }
  | { t: 'call-accept'; callId: string }
  | { t: 'call-deny'; callId: string; reason: 'denied' | 'busy' | 'permission' | 'timeout' }
  | { t: 'call-cancel'; callId: string }
  | { t: 'call-end'; callId: string }
  | { t: 'call-media'; callId: string; mic: boolean; cam: boolean }
  | { t: 'preview'; id: string; info: PreviewInfo; hasBytes: boolean };

export type CtrlHandler<T extends CtrlMsg['t']> = (
  msg: Extract<CtrlMsg, { t: T }>,
  bytes?: Uint8Array
) => void;

export const CTRL_CHANNEL_ID = 100;

export class ControlChannel {
  readonly channel: RTCDataChannel;
  private handlers = new Map<string, Set<(m: any, b?: Uint8Array) => void>>();
  private openListeners = new Set<(open: boolean) => void>();
  private heldPreview: Extract<CtrlMsg, { t: 'preview' }> | null = null;

  constructor(pc: RTCPeerConnection) {
    this.channel = pc.createDataChannel('ctrl', {
      negotiated: true,
      id: CTRL_CHANNEL_ID,
      ordered: true
    });
    this.channel.binaryType = 'arraybuffer';
    this.channel.onopen = () => this.openListeners.forEach((f) => f(true));
    this.channel.onclose = () => this.openListeners.forEach((f) => f(false));
    this.channel.onmessage = (e) => this.onMessage(e.data);
  }

  get isOpen() {
    return this.channel.readyState === 'open';
  }

  onOpenChange(fn: (open: boolean) => void) {
    this.openListeners.add(fn);
    if (this.isOpen) fn(true);
    return () => this.openListeners.delete(fn);
  }

  on<T extends CtrlMsg['t']>(type: T, fn: CtrlHandler<T>) {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    set.add(fn as any);
    return () => set!.delete(fn as any);
  }

  send(msg: CtrlMsg): boolean {
    if (!this.isOpen) return false;
    try {
      this.channel.send(JSON.stringify(msg));
      return true;
    } catch (e) {
      console.error('ctrl send failed', e);
      return false;
    }
  }

  /** Preview header + (optional) raw bytes. Ordered channel => bytes follow the header. */
  sendPreview(id: string, info: PreviewInfo, bytes?: Uint8Array) {
    const ok = this.send({ t: 'preview', id, info, hasBytes: !!bytes?.length });
    if (ok && bytes?.length) this.channel.send(bytes as unknown as ArrayBuffer);
  }

  private emit(type: string, msg: any, bytes?: Uint8Array) {
    this.handlers.get(type)?.forEach((f) => f(msg, bytes));
  }

  private onMessage(data: unknown) {
    if (typeof data === 'string') {
      let msg: CtrlMsg;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }
      if (msg.t === 'preview' && msg.hasBytes) {
        this.heldPreview = msg; // wait for the binary frame that follows
        return;
      }
      this.emit(msg.t, msg);
    } else if (data instanceof ArrayBuffer && this.heldPreview) {
      const msg = this.heldPreview;
      this.heldPreview = null;
      this.emit('preview', msg, new Uint8Array(data));
    }
  }

  close() {
    try {
      this.channel.close();
    } catch {}
    this.handlers.clear();
    this.openListeners.clear();
  }
}
