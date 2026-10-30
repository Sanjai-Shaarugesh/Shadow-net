<script lang="ts">
  // The connected "messenger" view. Chat is its own pane (WhatsApp-style); Send and Receive
  // are separate panes; calls float above everything. Mobile: full-screen app with a bottom
  // tab bar. Desktop (>=1024px): chat on the left, files on the right.
  import type { Snippet } from 'svelte';
  import { onMount } from 'svelte';
  import { MessageCircle, Upload, Download, ArrowLeft } from '@lucide/svelte';
  import ChatPanel from '../chat/ChatPanel.svelte';
  import CallOverlay from '../call/CallOverlay.svelte';
  import { session } from '../session.svelte';
  import type { CallManager } from '../../utils/mediaCall.svelte';

  type Tab = 'chat' | 'send' | 'receive';
  type Props = {
    call: CallManager | undefined;
    tab?: Tab;
    newFiles?: boolean;
    sendPane: Snippet;
    receivePane: Snippet;
    onLeave: () => void;
    peerName?: string;
  };

  let {
    call,
    tab = $bindable('chat'),
    newFiles = $bindable(false),
    sendPane,
    receivePane,
    onLeave,
    peerName = 'Peer'
  }: Props = $props();

  let isDesktop = $state(false);
  let appH = $state('100dvh');
  let appTop = $state('0px');

  onMount(() => {
    const mq = matchMedia('(min-width: 1024px)');
    const onMq = () => (isDesktop = mq.matches);
    onMq();
    mq.addEventListener('change', onMq);

    // Keep the composer above the on-screen keyboard (iOS/Android) via the visual viewport.
    const vv = window.visualViewport;
    const onVv = () => {
      if (!vv) return;
      appH = `${vv.height}px`;
      appTop = `${vv.offsetTop}px`;
    };
    onVv();
    vv?.addEventListener('resize', onVv);
    vv?.addEventListener('scroll', onVv);

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      mq.removeEventListener('change', onMq);
      vv?.removeEventListener('resize', onVv);
      vv?.removeEventListener('scroll', onVv);
      document.body.style.overflow = prevOverflow;
      session.chatVisible = false;
    };
  });

  const chatShown = $derived(tab === 'chat' || isDesktop);

  $effect(() => {
    session.chatVisible = chatShown;
    if (chatShown) session.markRead();
  });
  $effect(() => {
    if (tab === 'receive') newFiles = false;
  });
  // on desktop the chat is always open, so "files" means send or receive
  const filesTab = $derived<'send' | 'receive'>(tab === 'receive' ? 'receive' : 'send');
</script>

<div class="shell" style:height={appH} style:top={appTop}>
  <header class="shell-head">
    <button class="btn btn-ghost btn-sm btn-circle" aria-label="Leave session" onclick={onLeave}>
      <ArrowLeft class="h-5 w-5" />
    </button>
    <div class="min-w-0 flex-1">
      <p class="truncate text-sm font-semibold leading-tight">ShadowNet</p>
      <p class="truncate text-xs opacity-70">
        {session.connected ? 'Connected peer-to-peer' : 'Disconnected'}
      </p>
    </div>
    <!-- desktop segmented control for the files side -->
    <div class="join hidden lg:inline-flex">
      <button
        class="btn btn-sm join-item"
        class:btn-primary={filesTab === 'send'}
        onclick={() => (tab = 'send')}
      >
        <Upload class="h-4 w-4" /> Send
      </button>
      <button
        class="btn btn-sm join-item relative"
        class:btn-primary={filesTab === 'receive'}
        onclick={() => (tab = 'receive')}
      >
        <Download class="h-4 w-4" /> Receive
        {#if newFiles}<span class="badge badge-success badge-xs absolute -right-1 -top-1">new</span
          >{/if}
      </button>
    </div>
  </header>

  <main class="panes">
    <div class="pane chat" class:show={tab === 'chat'}>
      <ChatPanel {call} {peerName} onAttach={() => (tab = 'send')} />
    </div>
    <!-- Sender and Receiver stay mounted so transfers keep running while you chat -->
    <div
      class="pane files"
      class:show={tab === 'send'}
      class:fallback={tab === 'chat' && isDesktop}
    >
      <div class="pane-scroll">{@render sendPane()}</div>
    </div>
    <div class="pane files" class:show={tab === 'receive'}>
      <div class="pane-scroll">{@render receivePane()}</div>
    </div>
  </main>

  <nav class="tabbar" aria-label="Sections">
    <button class:active={tab === 'chat'} onclick={() => (tab = 'chat')}>
      <span class="relative">
        <MessageCircle class="h-6 w-6" />
        {#if session.unread > 0 && tab !== 'chat'}
          <span class="badge badge-success badge-xs absolute -right-3 -top-2"
            >{session.unread > 99 ? '99+' : session.unread}</span
          >
        {/if}
      </span>
      <span>Chat</span>
    </button>
    <button class:active={tab === 'send'} onclick={() => (tab = 'send')}>
      <Upload class="h-6 w-6" /><span>Send</span>
    </button>
    <button class:active={tab === 'receive'} onclick={() => (tab = 'receive')}>
      <span class="relative">
        <Download class="h-6 w-6" />
        {#if newFiles && tab !== 'receive'}<span
            class="badge badge-success badge-xs absolute -right-3 -top-2">new</span
          >{/if}
      </span>
      <span>Receive</span>
    </button>
  </nav>
</div>

{#if call}<CallOverlay {call} {peerName} />{/if}

<style>
  .shell {
    position: fixed;
    left: 0;
    right: 0;
    z-index: 40;
    display: flex;
    flex-direction: column;
    background: var(--color-base-200, #f3f3f3);
    color: var(--color-base-content, inherit);
    padding-left: env(safe-area-inset-left);
    padding-right: env(safe-area-inset-right);
  }
  .shell-head {
    flex: none;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: calc(0.5rem + env(safe-area-inset-top)) 0.75rem 0.5rem;
    background: var(--color-base-100, #fff);
    border-bottom: 1px solid color-mix(in oklab, currentColor 12%, transparent);
  }
  .panes {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
  }
  .pane {
    display: none;
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
    flex-direction: column;
  }
  .pane.show {
    display: flex;
  }
  .pane-scroll {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 0.75rem;
    -webkit-overflow-scrolling: touch;
  }
  .tabbar {
    flex: none;
    display: flex;
    background: var(--color-base-100, #fff);
    border-top: 1px solid color-mix(in oklab, currentColor 12%, transparent);
    padding-bottom: env(safe-area-inset-bottom);
  }
  .tabbar button {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.15rem;
    padding: 0.5rem 0 0.4rem;
    font-size: 0.7rem;
    opacity: 0.6;
    background: none;
    border: none;
    color: inherit;
    touch-action: manipulation;
  }
  .tabbar button.active {
    opacity: 1;
    color: var(--color-primary, #25d366);
  }

  @media (min-width: 1024px) {
    .tabbar {
      display: none;
    }
    .pane.chat {
      display: flex;
      flex: 0 0 26rem;
      border-right: 1px solid color-mix(in oklab, currentColor 12%, transparent);
    }
    .pane.files.show,
    .pane.files.fallback {
      display: flex;
    }
    .pane.files {
      max-width: 52rem;
    }
  }
</style>
