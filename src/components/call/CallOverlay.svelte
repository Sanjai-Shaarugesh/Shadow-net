<script lang="ts">
  // Incoming-call sheet (Accept / Deny), ringing screen, in-call screen and a draggable
  // minimised window so chat / files stay usable during a call. Always safe-area aware.
  import {
    Phone,
    PhoneOff,
    Video,
    VideoOff,
    Mic,
    MicOff,
    SwitchCamera,
    Minimize2,
    Maximize2
  } from '@lucide/svelte';
  import type { CallManager } from '../../utils/mediaCall.svelte';
  import { identity } from '../Peeridentity.svelte';

  type Props = { call: CallManager; peerName?: string };
  const { call }: Props = $props();
  const peerName = $derived(identity.peer);

  let minimized = $state(false);
  let showStats = $state(false);
  let localEl: HTMLVideoElement | undefined = $state();
  let remoteEl: HTMLVideoElement | undefined = $state();

  $effect(() => {
    if (localEl) localEl.srcObject = call.localStream ?? null;
  });
  $effect(() => {
    if (remoteEl) {
      remoteEl.srcObject = call.remoteStream ?? null;
      remoteEl.play().catch(() => {});
    }
  });
  $effect(() => {
    if (call.phase === 'idle') minimized = false;
  });

  // ---------- camera switch (front <-> back) ----------
  // The old switch re-opened the camera (and the mic) while the current camera was still running,
  // which phones refuse ("camera/mic is used by another app"). Here: video only, release the old
  // camera FIRST, open the new one, then swap the track on the live connection (no renegotiation).
  let switching = $state(false);
  let notice = $state('');
  let facing: 'user' | 'environment' | null = $state(null); // set after our own switch
  const mirrored = $derived((facing ?? call.facing) === 'user');

  function findPc(): RTCPeerConnection | undefined {
    const c = call as any;
    for (const k of ['pc', 'connection', 'peerConnection', 'peer', '_pc', 'conn']) {
      if (c[k] instanceof RTCPeerConnection) return c[k];
    }
    return Object.values(c).find((v) => v instanceof RTCPeerConnection) as
      | RTCPeerConnection
      | undefined;
  }

  function say(msg: string) {
    notice = msg;
    setTimeout(() => (notice = ''), 2500);
  }

  async function open(c: MediaTrackConstraints): Promise<MediaStreamTrack | undefined> {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: c, audio: false });
      return s.getVideoTracks()[0];
    } catch (e) {
      console.warn('camera open failed', c, e);
      return undefined;
    }
  }

  async function switchCam() {
    if (switching) return;
    const pc = findPc();
    const stream = call.localStream as MediaStream | undefined;
    const old = stream?.getVideoTracks()[0];
    const sender = pc?.getSenders().find((x) => x.track === old || x.track?.kind === 'video');
    if (!pc || !stream || !old || !sender) {
      console.warn('switchCam: connection/stream not reachable, using call.switchCamera()');
      call.switchCamera();
      return;
    }

    switching = true;
    try {
      const st = old.getSettings();
      const current = ((st.facingMode as string | undefined) ?? facing ?? call.facing ?? 'user') as
        | 'user'
        | 'environment';
      const target = current === 'user' ? 'environment' : 'user';
      const oldId = st.deviceId;
      const size: MediaTrackConstraints = {};
      if (st.width) size.width = { ideal: st.width };
      if (st.height) size.height = { ideal: st.height };
      if (st.frameRate) size.frameRate = { ideal: st.frameRate };
      const wasEnabled = old.enabled;

      old.stop(); // free the camera first: phones can't open two cameras at once
      await new Promise((r) => setTimeout(r, 200));

      let next = await open({ ...size, facingMode: { exact: target } });
      if (!next) {
        // no facingMode support (some browsers/desktops): step to the next camera by id
        const cams = (await navigator.mediaDevices.enumerateDevices()).filter(
          (d) => d.kind === 'videoinput' && d.deviceId
        );
        const i = cams.findIndex((d) => d.deviceId === oldId);
        const other = cams.length > 1 ? cams[(i + 1) % cams.length] : undefined;
        if (other) next = await open({ ...size, deviceId: { exact: other.deviceId } });
      }
      let restored = false;
      if (!next) {
        // could not switch: get the previous camera back so the call keeps its video
        next = await open({ ...size, ...(oldId ? { deviceId: { exact: oldId } } : {}) });
        restored = true;
      }
      if (!next) {
        say('Camera unavailable. Tap the camera button to turn it back on.');
        return;
      }

      next.enabled = wasEnabled;
      await sender.replaceTrack(next);
      stream.removeTrack(old);
      stream.addTrack(next);
      setTimeout(matchCaptureToOrientation, 300);

      const f = next.getSettings().facingMode as 'user' | 'environment' | undefined;
      facing = restored ? current : (f ?? target);
      try {
        (call as any).facing = facing;
      } catch {
        /* read-only in CallManager: the overlay keeps its own copy */
      }
      if (restored) say("Couldn't switch camera");
    } catch (e) {
      console.error('switchCam failed', e);
      say("Couldn't switch camera");
    } finally {
      switching = false;
    }
  }
  $effect(() => {
    if (call.phase === 'idle') facing = null;
  });

  // Follow the phone's rotation: landscape gets a side control rail + wider self-view.
  let landscape = $state(false);
  $effect(() => {
    const mq = matchMedia('(orientation: landscape)');
    landscape = mq.matches;
    const on = (e: MediaQueryListEvent) => (landscape = e.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  });
  // Phones keep capturing in the orientation the camera was opened in, so after rotating the
  // other side (PC) still got a portrait picture. Re-shape the capture to match the screen.
  async function matchCaptureToOrientation() {
    if (!matchMedia('(pointer: coarse)').matches) return; // phones/tablets only, never a PC webcam
    const t = (call.localStream as MediaStream | undefined)?.getVideoTracks()[0];
    if (!t || t.readyState !== 'live') return;
    const { width, height } = t.getSettings();
    if (!width || !height) return;
    if (landscape === width > height) return; // already the right shape
    const long = Math.max(width, height);
    const short = Math.min(width, height);
    try {
      await t.applyConstraints({
        width: { ideal: landscape ? long : short },
        height: { ideal: landscape ? short : long },
        aspectRatio: { ideal: landscape ? long / short : short / long }
      });
    } catch (e) {
      console.warn('could not re-shape capture after rotation', e);
    }
  }
  let rotTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    landscape; // re-run on every rotation
    call.localStream; // ...and when the camera (re)starts
    if (call.phase !== 'active' || call.kind !== 'video') return;
    clearTimeout(rotTimer);
    rotTimer = setTimeout(matchCaptureToOrientation, 400); // let the camera settle first
    return () => clearTimeout(rotTimer);
  });

  // Make sure nothing keeps the screen locked to portrait while a call is up.
  $effect(() => {
    if (call.phase === 'active' || call.phase === 'outgoing') {
      try {
        (screen.orientation as any)?.unlock?.();
      } catch {
        /* not supported / not locked */
      }
    }
  });

  const clock = $derived(
    `${Math.floor(call.seconds / 60)}:${String(call.seconds % 60).padStart(2, '0')}`
  );
  const isVideo = $derived(call.kind === 'video');
  const peerShowsVideo = $derived(isVideo && call.peerCam && call.remoteLive && !call.stats.paused);
  const statLine = $derived(
    [
      call.stats.paused ? 'Audio only (weak link)' : call.stats.label,
      call.stats.fps ? `${call.stats.fps}fps` : '',
      call.stats.kbps
        ? `${(call.stats.kbps / 1000).toFixed(call.stats.kbps > 999 ? 1 : 2)} Mbps`
        : ''
    ]
      .filter(Boolean)
      .join(' · ')
  );

  /** Pointer-drag that keeps the element inside the viewport. Pass false to disable. */
  function drag(node: HTMLElement, enabled: boolean = true) {
    let sx = 0,
      sy = 0,
      ox = 0,
      oy = 0,
      down = false,
      captured = false;
    const onDown = (e: PointerEvent) => {
      if (!enabled || (e.target as HTMLElement).closest('.mini-btn')) return;
      down = true;
      captured = false;
      node.dataset.moved = '';
      sx = e.clientX;
      sy = e.clientY;
    };
    const onMove = (e: PointerEvent) => {
      if (!down) return;
      const dx = e.clientX - sx;
      const dy = e.clientY - sy;
      if (!captured && Math.abs(dx) + Math.abs(dy) > 6) {
        captured = true; // capture only once it is really a drag, so taps still reach buttons
        node.dataset.moved = '1';
        node.setPointerCapture(e.pointerId);
      }
      if (captured) node.style.transform = `translate(${ox + dx}px, ${oy + dy}px)`;
    };
    const onUp = (e: PointerEvent) => {
      if (!down) return;
      down = false;
      if (!captured) return;
      ox += e.clientX - sx;
      oy += e.clientY - sy;
      const r = node.getBoundingClientRect();
      const pad = 8;
      if (r.left < pad) ox += pad - r.left;
      if (r.right > innerWidth - pad) ox -= r.right - (innerWidth - pad);
      if (r.top < pad) oy += pad - r.top;
      if (r.bottom > innerHeight - pad) oy -= r.bottom - (innerHeight - pad);
      node.style.transform = `translate(${ox}px, ${oy}px)`;
    };
    node.addEventListener('pointerdown', onDown);
    node.addEventListener('pointermove', onMove);
    node.addEventListener('pointerup', onUp);
    node.addEventListener('pointercancel', onUp);
    return {
      update(v: boolean = true) {
        enabled = v;
        if (!v) {
          node.style.transform = '';
          ox = oy = 0;
        }
      },
      destroy() {
        node.removeEventListener('pointerdown', onDown);
        node.removeEventListener('pointermove', onMove);
        node.removeEventListener('pointerup', onUp);
        node.removeEventListener('pointercancel', onUp);
      }
    };
  }

  function expand(e: MouseEvent) {
    if ((e.currentTarget as HTMLElement).dataset.moved === '1') return;
    minimized = false;
  }
</script>

{#if call.phase === 'incoming'}
  <div class="incoming" role="alertdialog" aria-label="Incoming call">
    <div class="incoming-card">
      <div class="ring-wrap">
        <span class="ring"></span>
        <div class="avatar-xl">{peerName.slice(0, 1).toUpperCase()}</div>
      </div>
      <p class="text-lg font-semibold">{peerName}</p>
      <p class="text-sm opacity-70">
        Incoming {call.kind === 'video' ? 'video' : 'voice'} call…
      </p>
      <p class="mt-1 text-xs opacity-60">
        Your {call.kind === 'video' ? 'camera and microphone are' : 'microphone is'} only used if you
        accept.
      </p>
      <div class="mt-6 flex items-center justify-center gap-10">
        <div class="flex flex-col items-center gap-2">
          <button
            class="round bg-error text-error-content"
            aria-label="Deny call"
            onclick={() => call.deny()}
          >
            <PhoneOff class="h-7 w-7" />
          </button>
          <span class="text-xs">Deny</span>
        </div>
        <div class="flex flex-col items-center gap-2">
          <button
            class="round bg-success text-success-content"
            aria-label="Accept call"
            onclick={() => call.accept()}
          >
            {#if call.kind === 'video'}<Video class="h-7 w-7" />{:else}<Phone
                class="h-7 w-7"
              />{/if}
          </button>
          <span class="text-xs">Accept</span>
        </div>
      </div>
    </div>
  </div>
{/if}

{#if call.phase === 'outgoing' || call.phase === 'active'}
  <div
    class="call"
    class:mini={minimized && call.phase === 'active'}
    class:landscape
    use:drag={minimized && call.phase === 'active'}
    role="dialog"
    aria-label="Call"
  >
    <!-- main picture: remote while active, self-preview while ringing -->
    <div class="stage">
      {#if call.phase === 'active'}
        <video bind:this={remoteEl} autoplay playsinline class="fill" class:vh={!peerShowsVideo}
        ></video>
        {#if !peerShowsVideo}
          <div class="center-note">
            <div class="avatar-xl" class:speaking={call.speaking}>
              {peerName.slice(0, 1).toUpperCase()}
            </div>
            {#if !minimized}
              <p class="mt-3 font-semibold">{peerName}</p>
              <p class="text-sm opacity-70">
                {#if !call.remoteLive}Connecting…{:else if call.stats.paused}Video paused – weak
                  connection{:else if isVideo && !call.peerCam}Camera off{:else}{call.peerMic
                    ? call.speaking
                      ? 'Speaking'
                      : 'Voice call'
                    : 'Muted'}{/if}
              </p>
            {/if}
          </div>
        {/if}
      {:else}
        <video
          bind:this={localEl}
          autoplay
          playsinline
          muted
          class="fill"
          class:vh={!isVideo}
          style:transform={mirrored ? 'scaleX(-1)' : 'none'}
        ></video>
        <div class="center-note" class:bg-scrim={isVideo}>
          {#if !isVideo}<div class="avatar-xl">{peerName.slice(0, 1).toUpperCase()}</div>{/if}
          <p class="mt-3 font-semibold">{peerName}</p>
          <p class="text-sm opacity-80">Calling…</p>
        </div>
      {/if}
    </div>

    {#if call.phase === 'active' && minimized}
      <!-- tiny window: tap to expand, quick mute / hang up -->
      <button class="mini-hit" aria-label="Expand call" onclick={expand}></button>
      <div class="mini-bar">
        <span class="text-[11px] tabular-nums">{clock}</span>
        <button
          class="mini-btn"
          aria-label={call.micOn ? 'Mute' : 'Unmute'}
          onclick={() => call.toggleMic()}
        >
          {#if call.micOn}<Mic class="h-4 w-4" />{:else}<MicOff class="h-4 w-4" />{/if}
        </button>
        <button class="mini-btn bg-error" aria-label="End call" onclick={() => call.end()}>
          <PhoneOff class="h-4 w-4" />
        </button>
      </div>
    {:else}
      <div class="topbar">
        <div class="min-w-0">
          <p class="truncate text-sm font-semibold">{peerName}</p>
          <p class="text-xs opacity-80 tabular-nums">
            {call.phase === 'active' ? clock : 'Calling…'}
          </p>
        </div>
        <div class="flex items-center gap-1">
          {#if call.phase === 'active' && isVideo}
            <button
              class="chip"
              onclick={() => (showStats = !showStats)}
              aria-label="Connection quality"
            >
              {statLine || '…'}
            </button>
          {/if}
          {#if call.phase === 'active'}
            <button class="icon-btn" aria-label="Minimise" onclick={() => (minimized = true)}>
              <Minimize2 class="h-5 w-5" />
            </button>
          {/if}
        </div>
      </div>

      {#if showStats && call.phase === 'active'}
        <div class="stats">
          {call.stats.w ? `${call.stats.w}×${call.stats.h}` : '—'} · {call.stats.codec || 'codec ?'}
          · RTT {call.stats.rtt} ms · loss {call.stats.loss}%
        </div>
      {/if}

      {#if call.phase === 'active' && isVideo}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="pip" use:drag>
          <video
            bind:this={localEl}
            autoplay
            playsinline
            muted
            class="fill"
            style:transform={mirrored ? 'scaleX(-1)' : 'none'}
          ></video>
          {#if !call.camOn}<div class="pip-off"><VideoOff class="h-6 w-6" /></div>{/if}
        </div>
      {/if}

      {#if notice}<div class="notice" role="status">{notice}</div>{/if}

      <div class="controls">
        {#if call.phase === 'active'}
          <button
            class="round-sm"
            class:off={!call.micOn}
            aria-label={call.micOn ? 'Mute' : 'Unmute'}
            onclick={() => call.toggleMic()}
          >
            {#if call.micOn}<Mic class="h-6 w-6" />{:else}<MicOff class="h-6 w-6" />{/if}
          </button>
          <button
            class="round-sm"
            class:off={!call.camOn}
            aria-label={call.camOn ? 'Camera off' : 'Camera on'}
            onclick={() => call.toggleCam()}
          >
            {#if call.camOn}<Video class="h-6 w-6" />{:else}<VideoOff class="h-6 w-6" />{/if}
          </button>
          {#if isVideo}
            <button
              class="round-sm"
              aria-label="Switch camera"
              disabled={switching}
              onclick={switchCam}
            >
              <SwitchCamera class="h-6 w-6" />
            </button>
          {/if}
          <button class="round-sm end" aria-label="End call" onclick={() => call.end()}>
            <PhoneOff class="h-6 w-6" />
          </button>
        {:else}
          <button class="round-sm end" aria-label="Cancel call" onclick={() => call.cancel()}>
            <PhoneOff class="h-6 w-6" />
          </button>
        {/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  /* ---------- incoming sheet (follows the app theme) ---------- */
  .incoming {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: flex;
    align-items: flex-end;
    justify-content: center;
    background: rgb(0 0 0 / 0.55);
    backdrop-filter: blur(4px);
    padding: env(safe-area-inset-top) env(safe-area-inset-right) 0 env(safe-area-inset-left);
  }
  .incoming-card {
    width: 100%;
    max-width: 26rem;
    text-align: center;
    padding: 1.5rem 1.25rem calc(1.5rem + env(safe-area-inset-bottom));
    border-radius: 1.5rem 1.5rem 0 0;
    background: var(--color-base-100, #fff);
    color: var(--color-base-content, #111);
    box-shadow: 0 -10px 40px rgb(0 0 0 / 0.3);
    animation: up 0.25s ease-out;
  }
  @media (min-width: 640px) {
    .incoming {
      align-items: center;
    }
    .incoming-card {
      border-radius: 1.5rem;
      padding-bottom: 1.5rem;
    }
  }
  @keyframes up {
    from {
      transform: translateY(40px);
      opacity: 0;
    }
  }
  .ring-wrap {
    position: relative;
    width: 6rem;
    height: 6rem;
    margin: 0 auto 0.75rem;
  }
  .ring {
    position: absolute;
    inset: 0;
    border-radius: 9999px;
    border: 2px solid var(--color-success, #25d366);
    animation: ping 1.6s ease-out infinite;
  }
  @keyframes ping {
    to {
      transform: scale(1.7);
      opacity: 0;
    }
  }
  .avatar-xl {
    display: grid;
    place-items: center;
    width: 6rem;
    height: 6rem;
    border-radius: 9999px;
    font-size: 2.4rem;
    font-weight: 700;
    color: var(--color-primary-content, #fff);
    background: var(--color-primary, #25d366);
  }
  .avatar-xl.speaking {
    box-shadow: 0 0 0 6px color-mix(in oklab, var(--color-success, #25d366) 55%, transparent);
  }
  .round {
    display: grid;
    place-items: center;
    width: 4.25rem;
    height: 4.25rem;
    border-radius: 9999px;
    border: none;
    cursor: pointer;
    touch-action: manipulation;
    transition: transform 0.1s;
  }
  .round:active {
    transform: scale(0.94);
  }

  /* ---------- in-call (always dark, like every call app) ---------- */
  .call {
    position: fixed;
    inset: 0;
    z-index: 95;
    display: flex;
    flex-direction: column;
    color: #fff;
    background: #0b141a;
    overflow: hidden;
    touch-action: manipulation;
  }
  .call.mini {
    inset: auto;
    right: calc(0.75rem + env(safe-area-inset-right));
    bottom: calc(5rem + env(safe-area-inset-bottom));
    width: 8.5rem;
    height: 11.5rem;
    border-radius: 0.9rem;
    box-shadow: 0 8px 30px rgb(0 0 0 / 0.45);
    touch-action: none;
    cursor: grab;
  }
  .stage {
    position: absolute;
    inset: 0;
  }
  .fill {
    width: 100%;
    height: 100%;
    object-fit: contain; /* never crop the 4K frame */
    background: #000;
  }
  .call.mini .fill {
    object-fit: cover;
  }
  .vh {
    position: absolute;
    width: 1px;
    height: 1px;
    opacity: 0;
    pointer-events: none;
  }
  .center-note {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    padding: 1rem;
  }
  .center-note.bg-scrim {
    background: linear-gradient(transparent 30%, rgb(0 0 0 / 0.55));
    justify-content: flex-end;
    padding-bottom: 9rem;
  }
  .call.mini .avatar-xl {
    width: 3.5rem;
    height: 3.5rem;
    font-size: 1.4rem;
  }
  .topbar {
    position: relative;
    z-index: 2;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: calc(0.75rem + env(safe-area-inset-top)) calc(0.75rem + env(safe-area-inset-right))
      0.75rem calc(0.75rem + env(safe-area-inset-left));
    background: linear-gradient(rgb(0 0 0 / 0.6), transparent);
  }
  .chip {
    font-size: 0.7rem;
    padding: 0.3rem 0.6rem;
    border-radius: 9999px;
    background: rgb(255 255 255 / 0.16);
    color: #fff;
    border: none;
    white-space: nowrap;
  }
  .icon-btn {
    display: grid;
    place-items: center;
    width: 2.5rem;
    height: 2.5rem;
    border-radius: 9999px;
    border: none;
    background: rgb(255 255 255 / 0.16);
    color: #fff;
  }
  .stats {
    position: relative;
    z-index: 2;
    margin: 0 0.75rem;
    padding: 0.35rem 0.6rem;
    font-size: 0.7rem;
    border-radius: 0.5rem;
    background: rgb(0 0 0 / 0.55);
    width: fit-content;
    max-width: calc(100% - 1.5rem);
  }
  .pip {
    position: absolute;
    z-index: 3;
    right: calc(0.75rem + env(safe-area-inset-right));
    top: calc(4.5rem + env(safe-area-inset-top));
    width: 6.5rem;
    aspect-ratio: 3 / 4;
    border-radius: 0.8rem;
    overflow: hidden;
    border: 2px solid rgb(255 255 255 / 0.35);
    box-shadow: 0 4px 18px rgb(0 0 0 / 0.5);
    touch-action: none;
    cursor: grab;
  }
  .pip .fill {
    object-fit: cover;
  }
  @media (min-width: 640px) {
    .pip {
      width: 10rem;
    }
  }
  /* ---------- landscape (phone rotated) ---------- */
  .call.landscape:not(.mini) .topbar {
    padding-top: calc(0.4rem + env(safe-area-inset-top));
    padding-bottom: 0.4rem;
  }
  .call.landscape:not(.mini) .controls {
    left: auto;
    top: 0;
    right: 0;
    bottom: 0;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.6rem;
    padding: 0.5rem calc(0.6rem + env(safe-area-inset-right)) 0.5rem 0.6rem;
    background: linear-gradient(to left, rgb(0 0 0 / 0.55), transparent);
  }
  .call.landscape:not(.mini) .round-sm {
    width: 3rem;
    height: 3rem;
  }
  .call.landscape:not(.mini) .pip {
    aspect-ratio: 4 / 3;
    width: 9rem;
    top: calc(3.25rem + env(safe-area-inset-top));
    right: calc(4.75rem + env(safe-area-inset-right));
  }
  .call.landscape:not(.mini) .center-note.bg-scrim {
    padding-bottom: 1rem;
  }
  .notice {
    position: absolute;
    z-index: 4;
    left: 50%;
    bottom: calc(6.5rem + env(safe-area-inset-bottom));
    transform: translateX(-50%);
    max-width: 80%;
    padding: 0.4rem 0.8rem;
    font-size: 0.8rem;
    text-align: center;
    border-radius: 9999px;
    background: rgb(0 0 0 / 0.7);
  }
  .pip-off {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    background: #1f2c34;
  }
  .controls {
    position: absolute;
    z-index: 3;
    left: 0;
    right: 0;
    bottom: 0;
    display: flex;
    justify-content: center;
    gap: 0.9rem;
    padding: 1rem 1rem calc(1.25rem + env(safe-area-inset-bottom));
    background: linear-gradient(transparent, rgb(0 0 0 / 0.65));
  }
  .round-sm {
    display: grid;
    place-items: center;
    width: 3.5rem;
    height: 3.5rem;
    border-radius: 9999px;
    border: none;
    color: #fff;
    background: rgb(255 255 255 / 0.2);
    backdrop-filter: blur(6px);
    cursor: pointer;
    touch-action: manipulation;
  }
  .round-sm.off {
    background: #fff;
    color: #111;
  }
  .round-sm.end {
    background: #e5484d;
  }
  .round-sm:disabled {
    opacity: 0.4;
  }
  .mini-hit {
    position: absolute;
    inset: 0;
    z-index: 1;
    background: transparent;
    border: none;
  }
  .mini-bar {
    position: absolute;
    z-index: 2;
    left: 0;
    right: 0;
    bottom: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.25rem;
    padding: 0.3rem 0.4rem;
    background: rgb(0 0 0 / 0.55);
  }
  .mini-btn {
    display: grid;
    place-items: center;
    width: 1.9rem;
    height: 1.9rem;
    border-radius: 9999px;
    border: none;
    color: #fff;
    background: rgb(255 255 255 / 0.2);
  }
  .mini-btn.bg-error {
    background: #e5484d;
  }
  @media (prefers-reduced-motion: reduce) {
    .ring,
    .incoming-card {
      animation: none;
    }
  }
</style>
