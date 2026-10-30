// mediaCall.svelte.ts
// Audio/video calls on top of the existing RTCPeerConnection.
//
//  * Nothing touches the camera/mic until a call is actually started (caller) or
//    accepted (callee). The caller sends an invite over the control channel; the
//    callee gets Accept / Deny.
//  * Audio + video transceivers are added to the very first offer (sendrecv, no track),
//    so starting a call is just replaceTrack() - no SDP renegotiation needed.
//  * Quality is adaptive: capture/encode tier is picked from the measured outgoing
//    bandwidth, from 4K down to 240p, and finally audio-only. Audio always wins.
//    Codec preference is VP9 > AV1 > H264 > VP8 (best quality per bit that browsers
//    actually ship); Opus gets FEC + DTX + 32 kbps cap via tuneSdp().
//
// Physical limit, stated plainly: 4K needs several Mbit/s even with the best codecs.
// On a weak link the ladder steps down on its own and climbs back when bandwidth returns.

import type { ControlChannel } from './controlChannel';

export type CallPhase = 'idle' | 'outgoing' | 'incoming' | 'active';
export type CallKind = 'audio' | 'video';

interface Tier {
  label: string;
  w: number;
  h: number;
  fps: number;
  kbps: number; // budget for an efficient codec (VP9/AV1)
}

const TIERS: Tier[] = [
  { label: '4K', w: 3840, h: 2160, fps: 30, kbps: 8000 },
  { label: '1440p', w: 2560, h: 1440, fps: 30, kbps: 4500 },
  { label: '1080p', w: 1920, h: 1080, fps: 30, kbps: 2500 },
  { label: '720p', w: 1280, h: 720, fps: 30, kbps: 1200 },
  { label: '480p', w: 854, h: 480, fps: 24, kbps: 600 },
  { label: '360p', w: 640, h: 360, fps: 15, kbps: 300 },
  { label: '240p', w: 426, h: 240, fps: 15, kbps: 150 }
];
const AUDIO_ONLY = TIERS.length; // tier index meaning "video paused for bandwidth"
const AUDIO_KBPS = 40;
const RING_TIMEOUT_MS = 45_000;
const SAMPLE_MS = 2000;

/** Opus: in-band FEC, DTX, mono, 32 kbps cap -> intelligible voice on bad links. */
export function tuneSdp(sdp: string): string {
  const m = sdp.match(/a=rtpmap:(\d+) opus\/48000\/2/);
  if (!m) return sdp;
  const pt = m[1];
  const want: Record<string, string> = {
    useinbandfec: '1',
    usedtx: '1',
    stereo: '0',
    'sprop-stereo': '0',
    maxaveragebitrate: '32000',
    cbr: '0'
  };
  const re = new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`);
  const found = sdp.match(re);
  if (found) {
    const map = new Map(found[1].split(';').map((kv) => kv.trim().split('=') as [string, string]));
    for (const [k, v] of Object.entries(want)) map.set(k, v);
    const line = `a=fmtp:${pt} ${[...map].map(([k, v]) => (v === undefined ? k : `${k}=${v}`)).join(';')}`;
    return sdp.replace(re, line);
  }
  const line = `a=fmtp:${pt} ${Object.entries(want).map(([k, v]) => `${k}=${v}`).join(';')}`;
  return sdp.replace(m[0], `${m[0]}\r\n${line}`);
}

/* ---------------------------------------------------------------- ringtone */
class Ringer {
  private ctx?: AudioContext;
  private timer?: number;

  start(dir: 'in' | 'out') {
    this.stop();
    try {
      this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    } catch {
      return;
    }
    const beep = (freq: number, at: number, dur: number) => {
      const c = this.ctx!;
      const o = c.createOscillator();
      const g = c.createGain();
      o.frequency.value = freq;
      g.gain.setValueAtTime(0, c.currentTime + at);
      g.gain.linearRampToValueAtTime(0.15, c.currentTime + at + 0.03);
      g.gain.linearRampToValueAtTime(0, c.currentTime + at + dur);
      o.connect(g).connect(c.destination);
      o.start(c.currentTime + at);
      o.stop(c.currentTime + at + dur + 0.05);
    };
    const cycle = () => {
      if (!this.ctx) return;
      if (dir === 'in') {
        beep(440, 0, 0.4);
        beep(480, 0, 0.4);
        beep(440, 0.6, 0.4);
        beep(480, 0.6, 0.4);
        navigator.vibrate?.([400, 200, 400]);
      } else {
        beep(425, 0, 1);
      }
    };
    cycle();
    this.timer = window.setInterval(cycle, dir === 'in' ? 2600 : 3200);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    navigator.vibrate?.(0);
    this.ctx?.close().catch(() => {});
    this.ctx = undefined;
  }
}

/* -------------------------------------------------------------- the manager */
export class CallManager {
  phase = $state<CallPhase>('idle');
  kind = $state<CallKind>('video');
  localStream = $state<MediaStream | undefined>(undefined);
  remoteStream = $state<MediaStream | undefined>(undefined);
  micOn = $state(true);
  camOn = $state(true);
  peerMic = $state(true);
  peerCam = $state(true);
  remoteLive = $state(false);
  speaking = $state(false);
  facing = $state<'user' | 'environment'>('user');
  seconds = $state(0);
  stats = $state({
    label: '—',
    kbps: 0,
    fps: 0,
    w: 0,
    h: 0,
    codec: '',
    rtt: 0,
    loss: 0,
    paused: false
  });

  private callId = '';
  private starting = false;
  private audioTx?: RTCRtpTransceiver;
  private videoTx?: RTCRtpTransceiver;
  private ringer = new Ringer();
  private ringTimer?: number;
  private statsTimer?: number;
  private clockTimer?: number;
  private speakTimer?: number;
  private audioCtx?: AudioContext;
  private wakeLock?: { release(): Promise<void> };
  private offs: Array<() => void> = [];

  private tier = 2; // start at 1080p, let the estimator move it
  private estKbps = 0;
  private lastSample?: { t: number; bytes: number };
  private downStreak = 0;
  private upStreak = 0;
  private bwPaused = false;

  constructor(
    private pc: RTCPeerConnection,
    private ctrl: ControlChannel,
    private toast: (msg: string, kind?: 'info' | 'success' | 'warning' | 'error') => void
  ) {}

  /* ------------------------------------------------ SDP wiring (call once) */
  /** Offerer: call BEFORE createOffer(). */
  prepareOffer() {
    this.audioTx = this.pc.addTransceiver('audio', { direction: 'sendrecv' });
    this.videoTx = this.pc.addTransceiver('video', { direction: 'sendrecv' });
    this.setup();
  }

  /** Answerer: call AFTER setRemoteDescription(offer), BEFORE createAnswer(). */
  prepareAnswer() {
    for (const tx of this.pc.getTransceivers()) {
      const k = tx.receiver.track?.kind;
      if (k === 'audio' && !this.audioTx) this.audioTx = tx;
      if (k === 'video' && !this.videoTx) this.videoTx = tx;
      if (k === 'audio' || k === 'video') tx.direction = 'sendrecv';
    }
    this.setup();
  }

  private setup() {
    this.preferCodecs();
    const tracks = [this.audioTx?.receiver.track, this.videoTx?.receiver.track].filter(
      Boolean
    ) as MediaStreamTrack[];
    this.remoteStream = new MediaStream(tracks);
    tracks.forEach((t) => (t.onunmute = () => (this.remoteLive = true)));

    const c = this.ctrl;
    this.offs.push(
      c.on('call-invite', (m) => this.onInvite(m.callId, m.kind)),
      c.on('call-accept', (m) => this.onAccepted(m.callId)),
      c.on('call-deny', (m) => this.onDenied(m.callId, m.reason)),
      c.on('call-cancel', (m) => {
        if (m.callId === this.callId && this.phase === 'incoming') {
          this.toast('Missed call', 'warning');
          this.teardown();
        }
      }),
      c.on('call-end', (m) => {
        if (m.callId === this.callId && this.phase !== 'idle') {
          this.toast('Call ended', 'info');
          this.teardown();
        }
      }),
      c.on('call-media', (m) => {
        if (m.callId !== this.callId) return;
        this.peerMic = m.mic;
        this.peerCam = m.cam;
      })
    );
  }

  private preferCodecs() {
    try {
      const caps = RTCRtpReceiver.getCapabilities('video')?.codecs;
      if (!caps || !this.videoTx?.setCodecPreferences) return;
      const rank = (c: RTCRtpCodec) => {
        const m = c.mimeType.toLowerCase();
        return m.includes('vp9') ? 0 : m.includes('av1') ? 1 : m.includes('h264') ? 2 : m.includes('vp8') ? 3 : 4;
      };
      this.videoTx.setCodecPreferences([...caps].sort((a, b) => rank(a) - rank(b)));
    } catch {
      /* browser refuses -> default order */
    }
  }

  /* ------------------------------------------------------------ call flow */
  async start(kind: CallKind) {
    if (this.phase !== 'idle') return;
    if (!this.ctrl.isOpen || !this.audioTx) {
      this.toast('Not connected yet', 'warning');
      return;
    }
    this.kind = kind;
    this.callId = crypto.randomUUID();
    this.starting = true; // an invite arriving while the permission prompt is open gets "busy"
    try {
      await this.acquire(kind); // permission prompt happens HERE, when the call is made
    } catch (e) {
      this.starting = false;
      this.toast(this.mediaError(e), 'error');
      this.teardown();
      return;
    }
    this.starting = false;
    this.phase = 'outgoing';
    this.ringer.start('out');
    this.ringTimer = window.setTimeout(() => {
      this.ctrl.send({ t: 'call-cancel', callId: this.callId });
      this.toast('No answer', 'warning');
      this.teardown();
    }, RING_TIMEOUT_MS);
    this.ctrl.send({ t: 'call-invite', callId: this.callId, kind });
  }

  private onInvite(callId: string, kind: CallKind) {
    // Both sides pressed "call" at the same moment: lowest callId wins, the other yields.
    if (this.phase === 'outgoing' && callId < this.callId) {
      this.ctrl.send({ t: 'call-cancel', callId: this.callId });
      this.teardown();
    }
    if (this.phase !== 'idle' || this.starting) {
      this.ctrl.send({ t: 'call-deny', callId, reason: 'busy' });
      return;
    }
    this.callId = callId;
    this.kind = kind;
    this.phase = 'incoming';
    this.ringer.start('in');
    this.ringTimer = window.setTimeout(() => {
      this.ctrl.send({ t: 'call-deny', callId, reason: 'timeout' });
      this.teardown();
    }, RING_TIMEOUT_MS);
  }

  /** Callee taps Accept (user gesture -> permission prompt allowed). */
  async accept() {
    if (this.phase !== 'incoming') return;
    this.ringer.stop();
    clearTimeout(this.ringTimer);
    try {
      await this.acquire(this.kind);
    } catch (e) {
      this.toast(this.mediaError(e), 'error');
      this.ctrl.send({ t: 'call-deny', callId: this.callId, reason: 'permission' });
      this.teardown();
      return;
    }
    this.ctrl.send({ t: 'call-accept', callId: this.callId });
    await this.begin();
  }

  deny() {
    if (this.phase !== 'incoming') return;
    this.ctrl.send({ t: 'call-deny', callId: this.callId, reason: 'denied' });
    this.teardown();
  }

  cancel() {
    if (this.phase !== 'outgoing') return;
    this.ctrl.send({ t: 'call-cancel', callId: this.callId });
    this.teardown();
  }

  end() {
    if (this.phase === 'idle') return;
    this.ctrl.send({ t: 'call-end', callId: this.callId });
    this.teardown();
  }

  private async onAccepted(callId: string) {
    if (callId !== this.callId || this.phase !== 'outgoing') return;
    this.ringer.stop();
    clearTimeout(this.ringTimer);
    await this.begin();
  }

  private onDenied(callId: string, reason: string) {
    if (callId !== this.callId || this.phase !== 'outgoing') return;
    const msg =
      reason === 'busy'
        ? 'Peer is already in a call'
        : reason === 'permission'
          ? 'Peer could not access camera/mic'
          : reason === 'timeout'
            ? 'No answer'
            : 'Call declined';
    this.toast(msg, 'warning');
    this.teardown();
  }

  /* ------------------------------------------------------- media handling */
  private async acquire(kind: CallKind) {
    const audio: MediaTrackConstraints = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
      sampleRate: 48000
    };
    const video: MediaTrackConstraints = {
      facingMode: this.facing,
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 30, max: 30 }
    };
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio,
        video: kind === 'video' ? video : false
      });
    } catch (e) {
      if (kind !== 'video') throw e;
      // camera refused/missing -> still join with voice only
      stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
      this.kind = 'audio';
      this.toast('Camera unavailable - joining with audio only', 'warning');
    }
    stream.getVideoTracks().forEach((t) => ((t as any).contentHint = 'motion'));
    this.localStream = stream;
    this.micOn = true;
    this.camOn = stream.getVideoTracks().length > 0;
  }

  private mediaError(e: unknown): string {
    const n = (e as DOMException)?.name;
    if (n === 'NotAllowedError' || n === 'SecurityError')
      return 'Camera/microphone permission denied. Allow access in the browser or app settings.';
    if (n === 'NotFoundError') return 'No microphone/camera found';
    if (n === 'NotReadableError') return 'Camera/mic is in use by another app';
    return 'Could not start camera/microphone';
  }

  private async begin() {
    const s = this.localStream;
    if (!s) return this.teardown();
    this.phase = 'active';
    this.seconds = 0;
    this.remoteLive = this.remoteStream?.getTracks().some((t) => !t.muted) ?? false;
    this.clockTimer = window.setInterval(() => this.seconds++, 1000);

    const a = s.getAudioTracks()[0];
    const v = s.getVideoTracks()[0];
    if (a) await this.audioTx?.sender.replaceTrack(a);
    if (v) await this.videoTx?.sender.replaceTrack(v);
    await this.tuneAudioSender();

    this.tier = 2;
    this.estKbps = 0;
    this.lastSample = undefined;
    this.bwPaused = false;
    await this.applyTier(this.tier);
    this.sendMedia();

    this.statsTimer = window.setInterval(() => this.adapt().catch(() => {}), SAMPLE_MS);
    this.watchSpeaking();
    try {
      this.wakeLock = await (navigator as any).wakeLock?.request('screen');
    } catch {}
  }

  private async tuneAudioSender() {
    try {
      const sender = this.audioTx!.sender;
      const p = sender.getParameters();
      if (!p.encodings?.length) p.encodings = [{}];
      p.encodings[0].maxBitrate = 40_000;
      (p.encodings[0] as any).priority = 'high';
      (p.encodings[0] as any).networkPriority = 'high';
      await sender.setParameters(p);
    } catch {}
  }

  private sendMedia() {
    this.ctrl.send({
      t: 'call-media',
      callId: this.callId,
      mic: this.micOn,
      cam: this.camOn && !this.bwPaused
    });
  }

  toggleMic() {
    const t = this.localStream?.getAudioTracks()[0];
    if (!t) return;
    t.enabled = !t.enabled;
    this.micOn = t.enabled;
    this.sendMedia();
  }

  async toggleCam() {
    const t = this.localStream?.getVideoTracks()[0];
    if (!t) {
      // audio call -> user turns the camera on: ask for it now
      try {
        const cam = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: this.facing, width: { ideal: 1920 }, height: { ideal: 1080 } }
        });
        const nt = cam.getVideoTracks()[0];
        (nt as any).contentHint = 'motion';
        this.localStream?.addTrack(nt);
        this.localStream = this.localStream; // notify
        await this.videoTx?.sender.replaceTrack(nt);
        this.kind = 'video';
        this.camOn = true;
        await this.applyTier(this.tier);
        this.sendMedia();
      } catch (e) {
        this.toast(this.mediaError(e), 'error');
      }
      return;
    }
    t.enabled = !t.enabled;
    this.camOn = t.enabled;
    await this.applyTier(this.tier); // pauses/resumes the encoder
    this.sendMedia();
  }

  async switchCamera() {
    const old = this.localStream?.getVideoTracks()[0];
    if (!old) return;
    const next = this.facing === 'user' ? 'environment' : 'user';
    try {
      const cam = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: next, width: { ideal: 1920 }, height: { ideal: 1080 } }
      });
      const nt = cam.getVideoTracks()[0];
      (nt as any).contentHint = 'motion';
      nt.enabled = this.camOn;
      this.localStream?.removeTrack(old);
      old.stop();
      this.localStream?.addTrack(nt);
      this.localStream = this.localStream;
      this.facing = next;
      await this.videoTx?.sender.replaceTrack(nt);
      await this.applyTier(this.tier);
    } catch (e) {
      this.toast(this.mediaError(e), 'error');
    }
  }

  /* ------------------------------------------------- adaptive quality loop */
  private async applyTier(idx: number) {
    const sender = this.videoTx?.sender;
    const track = this.localStream?.getVideoTracks()[0];
    if (!sender) return;
    const paused = idx >= AUDIO_ONLY;
    const tier = TIERS[Math.min(idx, TIERS.length - 1)];

    if (track && !paused) {
      try {
        await track.applyConstraints({
          width: { ideal: tier.w },
          height: { ideal: tier.h },
          frameRate: { ideal: tier.fps, max: tier.fps }
        });
      } catch {}
    }

    try {
      const p = sender.getParameters();
      if (!p.encodings?.length) p.encodings = [{}];
      const enc: any = p.encodings[0];
      enc.active = !!track && this.camOn && !paused;
      enc.maxBitrate = Math.round(tier.kbps * this.efficiency() * 1000);
      enc.maxFramerate = tier.fps;
      enc.networkPriority = 'low';
      const actualH = track?.getSettings().height ?? tier.h;
      enc.scaleResolutionDownBy = actualH > tier.h * 1.05 ? actualH / tier.h : 1;
      (p as any).degradationPreference = 'balanced';
      await sender.setParameters(p);
    } catch {}

    const wasPaused = this.bwPaused;
    this.bwPaused = paused;
    this.stats.label = paused ? 'Audio only' : tier.label;
    this.stats.paused = paused;
    if (wasPaused !== paused) this.sendMedia();
  }

  private codecName = '';
  private efficiency() {
    return /vp9|av1/i.test(this.codecName) ? 1 : 1.6; // VP8/H264 need ~60% more bits
  }

  private async adapt() {
    if (this.phase !== 'active') return;
    const stats = await this.pc.getStats();
    let out: any, pair: any, remoteIn: any;
    const codecs = new Map<string, any>();
    stats.forEach((r: any) => {
      if (r.type === 'outbound-rtp' && r.kind === 'video') out = r;
      else if (r.type === 'candidate-pair' && (r.nominated || r.selected) && r.state === 'succeeded')
        pair = r;
      else if (r.type === 'remote-inbound-rtp' && r.kind === 'video') remoteIn = r;
      else if (r.type === 'codec') codecs.set(r.id, r);
    });
    if (out?.codecId) this.codecName = codecs.get(out.codecId)?.mimeType ?? this.codecName;

    const now = performance.now();
    let measured = 0;
    if (out) {
      if (this.lastSample) {
        const dt = (now - this.lastSample.t) / 1000;
        if (dt > 0) measured = ((out.bytesSent - this.lastSample.bytes) * 8) / dt / 1000;
      }
      this.lastSample = { t: now, bytes: out.bytesSent };
    }

    // Prefer the browser's own congestion estimate; fall back to measured throughput.
    let est: number;
    if (pair?.availableOutgoingBitrate) est = pair.availableOutgoingBitrate / 1000;
    else if (out?.qualityLimitationReason === 'bandwidth') est = measured * 0.9;
    else est = Math.max(this.estKbps, measured * 1.25, 300);

    const loss = Number(remoteIn?.fractionLost ?? 0);
    if (loss > 0.08) est *= 1 - Math.min(0.5, loss);
    this.estKbps = this.estKbps ? this.estKbps * 0.6 + est * 0.4 : est;

    const budget = Math.max(0, this.estKbps - AUDIO_KBPS);
    const eff = this.efficiency();
    let target = AUDIO_ONLY;
    for (let i = 0; i < TIERS.length; i++) {
      if (TIERS[i].kbps * eff <= budget) {
        target = i;
        break;
      }
    }

    // hysteresis: drop fast (2 samples), climb slowly (4 samples with 25% headroom)
    if (target > this.tier) {
      this.upStreak = 0;
      if (++this.downStreak >= 2) {
        this.downStreak = 0;
        this.tier = Math.min(target, this.tier + 2);
        await this.applyTier(this.tier);
      }
    } else if (target < this.tier) {
      this.downStreak = 0;
      const need = TIERS[target].kbps * eff * 1.25;
      if (budget >= need && ++this.upStreak >= 4) {
        this.upStreak = 0;
        this.tier = Math.max(target, this.tier - 1);
        await this.applyTier(this.tier);
      }
    } else {
      this.downStreak = this.upStreak = 0;
    }

    this.stats.kbps = Math.round(measured);
    this.stats.fps = Math.round(out?.framesPerSecond ?? 0);
    this.stats.w = out?.frameWidth ?? 0;
    this.stats.h = out?.frameHeight ?? 0;
    this.stats.codec = this.codecName.replace('video/', '');
    this.stats.rtt = Math.round((pair?.currentRoundTripTime ?? 0) * 1000);
    this.stats.loss = Math.round(loss * 100);
  }

  /* ------------------------------------------------------------- misc */
  private watchSpeaking() {
    const track = this.audioTx?.receiver.track;
    if (!track) return;
    try {
      this.audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const an = this.audioCtx.createAnalyser();
      an.fftSize = 256;
      this.audioCtx.createMediaStreamSource(new MediaStream([track])).connect(an);
      const buf = new Uint8Array(an.frequencyBinCount);
      this.speakTimer = window.setInterval(() => {
        an.getByteFrequencyData(buf);
        this.speaking = buf.reduce((a, b) => a + b, 0) / buf.length > 6;
      }, 250);
    } catch {}
  }

  private teardown() {
    this.ringer.stop();
    clearTimeout(this.ringTimer);
    clearInterval(this.statsTimer);
    clearInterval(this.clockTimer);
    clearInterval(this.speakTimer);
    this.audioCtx?.close().catch(() => {});
    this.audioCtx = undefined;
    this.wakeLock?.release().catch(() => {});
    this.wakeLock = undefined;
    this.audioTx?.sender.replaceTrack(null).catch(() => {});
    this.videoTx?.sender.replaceTrack(null).catch(() => {});
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.localStream = undefined;
    this.callId = '';
    this.phase = 'idle';
    this.remoteLive = false;
    this.speaking = false;
    this.peerMic = this.peerCam = true;
    this.seconds = 0;
    this.stats.label = '—';
    this.stats.kbps = this.stats.fps = this.stats.w = this.stats.h = 0;
    this.stats.paused = false;
  }

  /** Page teardown: hang up + detach listeners. */
  destroy() {
    if (this.phase !== 'idle') this.end();
    this.offs.forEach((f) => f());
    this.offs = [];
  }
}
