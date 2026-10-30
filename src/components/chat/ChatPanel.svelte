<script lang="ts">
  // WhatsApp-style chat. Lives in its own tab/pane (see SessionShell), not inside the
  // Offer/Answer steps or the file lists. Colours come from daisyUI CSS variables, so it
  // follows whatever light/dark theme is active.
  import { tick } from 'svelte';
  import { Phone, Video, Send, Paperclip, Check, CheckCheck, Clock, Trash2 } from '@lucide/svelte';
  import { session, MAX_CHAT_LEN } from '../session.svelte';
  import type { CallManager } from '../../utils/mediaCall.svelte';

  type Props = {
    call: CallManager | undefined;
    onAttach: () => void;
    peerName?: string;
  };
  const { call, onAttach, peerName = 'Peer' }: Props = $props();

  let draft = $state('');
  let scroller: HTMLDivElement | undefined = $state();
  let input: HTMLTextAreaElement | undefined = $state();
  let stickToBottom = true;

  const canCall = $derived(!!call && call.phase === 'idle' && session.connected);
  const enterSends = typeof matchMedia !== 'undefined' && matchMedia('(pointer: fine)').matches; // phones: Enter = newline

  function onScroll() {
    if (!scroller) return;
    stickToBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
  }

  $effect(() => {
    session.messages.length; // track
    session.peerTyping;
    if (stickToBottom) tick().then(() => scroller?.scrollTo({ top: scroller.scrollHeight }));
  });

  function resize() {
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 128) + 'px';
  }

  function send() {
    if (!draft.trim()) return;
    session.sendChat(draft);
    draft = '';
    stickToBottom = true;
    tick().then(() => {
      resize();
      input?.focus();
    });
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey && enterSends && !e.isComposing) {
      e.preventDefault();
      send();
    }
  }

  function onInput() {
    resize();
    session.setTyping(draft.length > 0);
  }

  const time = (ts: number) =>
    new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

  function dayLabel(ts: number) {
    const d = new Date(ts);
    const today = new Date();
    const y = new Date();
    y.setDate(today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return 'Today';
    if (d.toDateString() === y.toDateString()) return 'Yesterday';
    return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  }

  const rows = $derived(
    session.messages.map((m, i, a) => ({
      m,
      newDay: i === 0 || new Date(a[i - 1].ts).toDateString() !== new Date(m.ts).toDateString(),
      tail: i === a.length - 1 || a[i + 1].from !== m.from
    }))
  );
</script>

<section class="chat-root">
  <header class="chat-head">
    <div class="avatar-dot" aria-hidden="true">{peerName.slice(0, 1).toUpperCase()}</div>
    <div class="min-w-0 flex-1">
      <p class="truncate font-semibold leading-tight">{peerName}</p>
      <p class="truncate text-xs opacity-70">
        {#if !session.connected}
          Disconnected
        {:else if session.peerTyping}
          <span class="text-primary">typing…</span>
        {:else}
          Connected · end-to-end peer-to-peer
        {/if}
      </p>
    </div>
    <button
      class="btn btn-ghost btn-circle"
      aria-label="Voice call"
      title="Voice call"
      disabled={!canCall}
      onclick={() => call?.start('audio')}
    >
      <Phone class="h-5 w-5" />
    </button>
    <button
      class="btn btn-ghost btn-circle"
      aria-label="Video call"
      title="Video call"
      disabled={!canCall}
      onclick={() => call?.start('video')}
    >
      <Video class="h-5 w-5" />
    </button>
    {#if session.messages.length}
      <button
        class="btn btn-ghost btn-circle"
        aria-label="Clear chat"
        title="Clear chat"
        onclick={() => session.clearChat()}
      >
        <Trash2 class="h-4 w-4" />
      </button>
    {/if}
  </header>

  <div class="chat-scroll" bind:this={scroller} onscroll={onScroll}>
    {#if rows.length === 0}
      <div
        class="mx-auto my-auto max-w-xs rounded-xl bg-base-100/80 p-4 text-center text-sm opacity-80"
      >
        Messages go straight to your peer over the encrypted WebRTC link. Nothing is stored
        anywhere, and the history is gone when you leave this page.
      </div>
    {/if}

    {#each rows as { m, newDay, tail } (m.id)}
      {#if newDay}
        <div class="day-chip"><span>{dayLabel(m.ts)}</span></div>
      {/if}
      <div class="row" class:mine={m.from === 'me'}>
        <div class="bubble" class:tail class:mine={m.from === 'me'}>
          <span class="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{m.text}</span>
          <span class="meta">
            {time(m.ts)}
            {#if m.from === 'me'}
              {#if m.state === 'sending'}
                <Clock class="h-3.5 w-3.5" />
              {:else if m.state === 'sent'}
                <Check class="h-3.5 w-3.5" />
              {:else if m.state === 'delivered'}
                <CheckCheck class="h-3.5 w-3.5" />
              {:else}
                <CheckCheck class="h-3.5 w-3.5 text-info" />
              {/if}
            {/if}
          </span>
        </div>
      </div>
    {/each}

    {#if session.peerTyping}
      <div class="row">
        <div class="bubble tail typing" aria-label="Peer is typing"><i></i><i></i><i></i></div>
      </div>
    {/if}
  </div>

  <footer class="composer">
    <button class="btn btn-ghost btn-circle shrink-0" aria-label="Send a file" onclick={onAttach}>
      <Paperclip class="h-5 w-5" />
    </button>
    <textarea
      bind:this={input}
      bind:value={draft}
      rows="1"
      maxlength={MAX_CHAT_LEN}
      placeholder="Message"
      enterkeyhint={enterSends ? 'send' : 'enter'}
      class="composer-input"
      oninput={onInput}
      onkeydown={onKey}
      onblur={() => session.setTyping(false)}
    ></textarea>
    <button
      class="btn btn-primary btn-circle shrink-0"
      aria-label="Send message"
      disabled={!draft.trim() || !session.connected}
      onclick={send}
    >
      <Send class="h-5 w-5" />
    </button>
  </footer>
</section>

<style>
  .chat-root {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    min-width: 0;
    background: var(--color-base-200, #efeae2);
    color: var(--color-base-content, inherit);
  }
  .chat-head {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.5rem 0.5rem 0.5rem 0.75rem;
    background: var(--color-base-100, #fff);
    border-bottom: 1px solid color-mix(in oklab, currentColor 12%, transparent);
    flex: none;
  }
  .avatar-dot {
    display: grid;
    place-items: center;
    flex: none;
    width: 2.5rem;
    height: 2.5rem;
    margin-right: 0.5rem;
    border-radius: 9999px;
    font-weight: 700;
    color: var(--color-primary-content, #fff);
    background: var(--color-primary, #25d366);
  }
  .chat-scroll {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 0.75rem 0.75rem 0.5rem;
    display: flex;
    flex-direction: column;
    gap: 2px;
    -webkit-overflow-scrolling: touch;
  }
  .day-chip {
    display: flex;
    justify-content: center;
    margin: 0.6rem 0 0.4rem;
  }
  .day-chip span {
    font-size: 0.72rem;
    padding: 0.2rem 0.65rem;
    border-radius: 0.5rem;
    background: var(--color-base-100, #fff);
    opacity: 0.9;
    box-shadow: 0 1px 1px rgb(0 0 0 / 0.08);
  }
  .row {
    display: flex;
    justify-content: flex-start;
  }
  .row.mine {
    justify-content: flex-end;
  }
  .bubble {
    position: relative;
    max-width: min(82%, 34rem);
    padding: 0.35rem 0.55rem 0.3rem;
    border-radius: 0.6rem;
    font-size: 0.95rem;
    line-height: 1.3;
    background: var(--color-base-100, #fff);
    box-shadow: 0 1px 1px rgb(0 0 0 / 0.12);
  }
  .bubble.mine {
    background: color-mix(in oklab, var(--color-primary, #25d366) 24%, var(--color-base-100, #fff));
  }
  .bubble.tail {
    margin-bottom: 0.4rem;
  }
  .bubble.tail:not(.mine) {
    border-top-left-radius: 0;
  }
  .bubble.tail.mine {
    border-top-right-radius: 0;
  }
  .meta {
    float: right;
    margin: 0.55rem 0 -0.15rem 0.6rem;
    display: inline-flex;
    align-items: center;
    gap: 0.2rem;
    font-size: 0.68rem;
    opacity: 0.65;
    user-select: none;
  }
  .typing {
    display: inline-flex;
    gap: 4px;
    padding: 0.6rem 0.75rem;
  }
  .typing i {
    width: 6px;
    height: 6px;
    border-radius: 9999px;
    background: currentColor;
    opacity: 0.4;
    animation: blink 1.2s infinite;
  }
  .typing i:nth-child(2) {
    animation-delay: 0.2s;
  }
  .typing i:nth-child(3) {
    animation-delay: 0.4s;
  }
  @keyframes blink {
    0%,
    60%,
    100% {
      opacity: 0.25;
    }
    30% {
      opacity: 0.9;
    }
  }
  .composer {
    flex: none;
    display: flex;
    align-items: flex-end;
    gap: 0.35rem;
    padding: 0.5rem;
    background: var(--color-base-200, #efeae2);
  }
  .composer-input {
    flex: 1 1 auto;
    min-width: 0;
    resize: none;
    max-height: 8rem;
    padding: 0.65rem 1rem;
    border-radius: 1.4rem;
    border: none;
    outline: none;
    font: inherit;
    line-height: 1.3;
    color: var(--color-base-content, inherit);
    background: var(--color-base-100, #fff);
  }
  .composer-input:focus-visible {
    box-shadow: 0 0 0 2px color-mix(in oklab, var(--color-primary, #25d366) 60%, transparent);
  }
  @media (prefers-reduced-motion: reduce) {
    .typing i {
      animation: none;
    }
  }
</style>
