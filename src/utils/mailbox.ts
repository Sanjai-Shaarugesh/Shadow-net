// mailbox.ts - the relay (ntfy) is only a dumb encrypted mailbox.
// One SSE stream carries ALL group topics (ntfy accepts "topicA,topicB").
// On every (re)connect we ask for everything since the last message we saw,
// so messages sent while the app was closed are delivered when it opens.

import { RELAYS } from './shortCode';

export const MAX_WIRE_CHARS = 3900; // ntfy limit is 4096 bytes

export async function publish(topic: string, message: string): Promise<void> {
  if (message.length > MAX_WIRE_CHARS) throw new Error('Message too long');
  try {
    await Promise.any(
      RELAYS.map(async (r) => {
        const res = await fetch(`${r}/${topic}`, { method: 'POST', body: message });
        if (!res.ok) throw new Error(`relay ${res.status}`);
      })
    );
  } catch (e) {
    const first = (e as AggregateError).errors?.[0] as Error | undefined;
    const m = first?.message?.match(/^relay (\d+)/);
    if (m?.[1] === '429') throw new Error('Relay says too many messages - slow down, retrying');
    throw new Error(m ? `Relay error ${m[1]}` : 'Relay unreachable');
  }
}

export type WireHandler = (topic: string, wire: string, time: number) => void;

export class Mailbox {
  private sources: EventSource[] = [];
  private topics: string[] = [];
  private seen = new Set<string>();
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  /** true while the SSE stream is open */
  onStatus: (online: boolean) => void = () => {};

  /** getSince returns "all" or a unix timestamp (seconds). */
  constructor(
    private onWire: WireHandler,
    private getSince: () => string
  ) {
    window.addEventListener('online', () => this.reconnect());
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) this.reconnect();
    });
  }

  start() {
    this.running = true;
    this.reconnect();
  }

  stop() {
    this.running = false;
    this.close();
  }

  setTopics(topics: string[]) {
    const same =
      topics.length === this.topics.length && topics.every((t) => this.topics.includes(t));
    this.topics = [...topics];
    if (!same) this.reconnect();
  }

  private close() {
    clearTimeout(this.timer);
    this.sources.forEach((s) => s.close());
    this.sources = [];
  }

  reconnect() {
    this.close();
    if (!this.running || !this.topics.length) return;
    const path = this.topics.join(',');
    this.sources = RELAYS.map((r) => {
      const es = new EventSource(`${r}/${path}/sse?since=${this.getSince()}`);
      es.onopen = () => {
        this.retry = 0;
        this.onStatus(true);
      };
      es.onmessage = (e) => {
        try {
          const d = JSON.parse(e.data);
          if (d.event !== 'message' || typeof d.message !== 'string') return;
          if (this.seen.has(d.id)) return;
          this.seen.add(d.id);
          if (this.seen.size > 5000) this.seen.clear();
          this.onWire(d.topic, d.message, d.time ?? 0);
        } catch {
          /* ignore */
        }
      };
      es.onerror = () => {
        this.onStatus(false);
        es.close();
        clearTimeout(this.timer);
        const delay = Math.min(1000 * 2 ** this.retry++, 30000);
        this.timer = setTimeout(() => this.reconnect(), delay);
      };
      return es;
    });
  }

  /** One-shot catch-up without a long-lived stream (usable from a Service Worker). */
  static async poll(
    topics: string[],
    since: string
  ): Promise<{ topic: string; message: string; time: number }[]> {
    const out: { topic: string; message: string; time: number }[] = [];
    if (!topics.length) return out;
    for (const r of RELAYS) {
      try {
        const res = await fetch(`${r}/${topics.join(',')}/json?poll=1&since=${since}`);
        const text = await res.text();
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          const d = JSON.parse(line);
          if (d.event === 'message')
            out.push({ topic: d.topic, message: d.message, time: d.time ?? 0 });
        }
        break;
      } catch {
        /* try next relay */
      }
    }
    return out;
  }
}
