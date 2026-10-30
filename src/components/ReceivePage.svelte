<script lang="ts">
  import { defaultSendOptions, waitIceCandidatesTimeout } from '../configs';
  import { addToastMessage } from '../stores/toastStore';
  import { Message } from '../proto/message';
  import ScanQrModal from '../components/qr/ScanQrModal.svelte';
  import Collapse from '../components/layout/Collapse.svelte';
  import { Copy, Key, CircleArrowOutUpLeft } from '@lucide/svelte';
  import { onMount, onDestroy } from 'svelte';
  import {
    encodeSignal,
    decodeSignal,
    takeCodeFromHash,
    type SignalPayload
  } from '../utils/manualSignaling';
  import {
    joinSession,
    looksLikeShortCode,
    takeShortCodeFromHash,
    waitForIceFast,
    type JoinSession
  } from '../utils/shortCode';
  import {
    exportRsaPublicKeyToBase64,
    generateRsaKeyPair,
    importRsaPublicKeyFromBase64
  } from '../utils/crypto';
  import Receiver from '../components/receiver/Receiver.svelte';
  import Sender from '../components/sender/Sender.svelte';
  import Toast from '../components/Toast.svelte';
  import SessionShell from '../components/layout/SessionShell.svelte';
  import { ControlChannel } from '../utils/controlChannel';
  import { CallManager, tuneSdp } from '../utils/mediaCall.svelte';
  import { session } from './session.svelte';

  // Serverless signaling state
  let offerInput = $state('');
  let answerCode = $state('');
  let isProcessing = $state(false);
  let isConnecting = $state(false);
  let dataChannel: RTCDataChannel | undefined = $state(undefined);
  let rsa: CryptoKeyPair | undefined = $state(undefined);
  let rsaPub: CryptoKey | undefined = $state(undefined);

  let receiver: Receiver | undefined = $state(undefined);
  let sender: Sender | undefined = $state(undefined);
  let showNewFile = $state(false);
  let tab: 'chat' | 'send' | 'receive' = $state('chat');

  let connection: RTCPeerConnection | undefined = $state(undefined);
  let ctrl: ControlChannel | undefined = $state(undefined);
  let call: CallManager | undefined = $state(undefined);

  async function createAnswer() {
    if (!offerInput.trim()) {
      addToastMessage("Paste the sender's offer code first", 'error');
      return;
    }

    isProcessing = true;
    answerCode = '';
    try {
      // Short code -> look the offer up on the relay; long code -> old offline flow
      let join: JoinSession | undefined;
      let offer: SignalPayload;
      if (looksLikeShortCode(offerInput)) {
        join = await joinSession(offerInput);
        offer = join.offer;
      } else {
        offer = await decodeSignal(offerInput, 'offer');
      }

      if (connection) {
        connection.close();
        connection = undefined;
      }

      const iceServer = offer.ice || defaultSendOptions.iceServer;
      const config: RTCConfiguration = {
        iceServers: [
          { urls: iceServer },
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' }
        ],
        bundlePolicy: 'balanced',
        iceCandidatePoolSize: 4
      };

      connection = new RTCPeerConnection(config);

      // Chat / call-invites / previews travel on their own pre-negotiated channel.
      call?.destroy();
      session.reset();
      ctrl = new ControlChannel(connection);
      session.bind(ctrl);
      call = new CallManager(connection, ctrl, addToastMessage);

      if (offer.pk) {
        rsaPub = await importRsaPublicKeyFromBase64(offer.pk);
        rsa = await generateRsaKeyPair();
      } else {
        rsa = undefined;
        rsaPub = undefined;
      }

      if (connection) {
        connection.ondatachannel = (event) => {
          dataChannel = event.channel;
          dataChannel.onopen = () => {
            addToastMessage('Connected!', 'success');
            isConnecting = true;
            isProcessing = false;
            tab = 'chat';
          };

          dataChannel.onmessage = (event) => {
            const message = Message.decode(new Uint8Array(event.data));
            if (message.metaData !== undefined && receiver) {
              receiver.onMetaData(message.id, message.metaData);
              if (tab !== 'receive') showNewFile = true;
            } else if (message.chunk !== undefined && receiver) {
              receiver.onChunkData(message.id, message.chunk);
            } else if (message.receiveEvent !== undefined && sender) {
              sender.onReceiveEvent(message.id, message.receiveEvent);
            }
          };

          dataChannel.onerror = () => {
            addToastMessage('WebRTC error', 'error');
            isConnecting = false;
          };

          dataChannel.onclose = () => {
            addToastMessage('Disconnected', 'error');
            isConnecting = false;
            call?.end();
          };
        };
      }

      if (!connection) return;
      await connection.setRemoteDescription({ type: 'offer', sdp: offer.sdp });
      call?.prepareAnswer(); // reuse the offer's audio/video transceivers (no mic/cam yet)

      let publicKeyBase64 = '';
      if (rsa) {
        publicKeyBase64 = await exportRsaPublicKeyToBase64(rsa.publicKey);
      }

      const answer = await connection.createAnswer();
      await connection.setLocalDescription({ type: 'answer', sdp: tuneSdp(answer.sdp ?? '') });

      // No signaling server => wait until all ICE candidates are in the SDP
      await waitForIceFast(connection, Math.min(waitIceCandidatesTimeout, 4000));

      const sdp = connection.localDescription?.sdp;
      if (!sdp) throw new Error('No local description');

      const answerPayload: SignalPayload = {
        t: 'answer',
        sdp,
        pk: publicKeyBase64 || undefined
      };
      if (join) {
        await join.sendAnswer(answerPayload);
        addToastMessage('Connecting to the sender...', 'success');
      } else {
        answerCode = await encodeSignal(answerPayload);
        addToastMessage('Answer code ready! Send it back to the sender', 'success');
      }
    } catch (error) {
      console.error('Error processing offer:', error);
      addToastMessage(error instanceof Error ? error.message : 'Failed to process offer', 'error');
      isProcessing = false;
    }
  }

  async function copyText(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      addToastMessage(`${label} copied!`, 'info');
    } catch (error) {
      addToastMessage(`Failed to copy ${label.toLowerCase()}`, 'error');
    }
  }

  async function pasteOffer() {
    try {
      offerInput = await navigator.clipboard.readText();
    } catch {
      addToastMessage('Clipboard blocked - paste manually into the box', 'warning');
    }
  }

  function handleQRScan(data: string) {
    if (data && (data.length > 20 || looksLikeShortCode(data))) {
      offerInput = data;
      addToastMessage('Code scanned successfully!', 'success');
      createAnswer();
    } else {
      addToastMessage('Invalid QR code. Expected an offer code.', 'error');
    }
  }

  function navigateToOfferPage() {
    window.location.href = `${window.location.origin}/`;
  }

  onMount(() => {
    // console.log('📄 Answer page mounted');

    // Opened from a share link? Pre-fill the offer code (user still clicks the button)
    const linkedOffer = takeShortCodeFromHash() ?? takeCodeFromHash('offer');
    if (linkedOffer) {
      offerInput = linkedOffer;
      addToastMessage('Offer code loaded from link', 'success');
    }

    let gPressed = false;

    const handleShortcut = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'g') {
        gPressed = true;
      } else if (gPressed && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        window.location.href = '/';
        gPressed = false;
      } else {
        gPressed = false;
      }

      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        createAnswer();
      } else if (e.altKey && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        createAnswer();
      }
    };

    window.addEventListener('keydown', handleShortcut);

    return () => {
      window.removeEventListener('keydown', handleShortcut);
    };
  });

  function leaveSession() {
    call?.destroy();
    ctrl?.close();
    connection?.close();
    session.reset();
    window.location.reload();
  }

  onDestroy(() => {
    call?.destroy();
    ctrl?.close();
    connection?.close();
    session.reset();
  });
</script>

<div class="container mx-auto max-w-3xl p-4">
  <h1 class="mb-4 text-2xl font-bold">File Transfer - Answer Page</h1>

  <Collapse title="1. Connect" isOpen={!isConnecting}>
    <p class="mb-2 font-semibold">A. Enter the sender's code</p>
    <textarea
      id="offer-input"
      class="textarea textarea-bordered w-full font-mono text-xs h-28"
      placeholder="Enter code, e.g. K7QXM-29PD9 (or paste a link / long offline code)"
      bind:value={offerInput}
      disabled={isProcessing || isConnecting}
    ></textarea>

    <div class="mt-2 flex gap-2 flex-wrap">
      <button class="btn btn-ghost" onclick={pasteOffer} disabled={isProcessing || isConnecting}>
        Paste <Copy />
      </button>
      <button
        class="btn btn-outline btn-accent flex-1"
        onclick={createAnswer}
        disabled={isProcessing || isConnecting || !offerInput.trim()}
      >
        {#if isProcessing && !answerCode}
          <span class="loading loading-spinner"></span>
          Connecting...
        {:else}
          {looksLikeShortCode(offerInput) ? 'Connect' : 'Create Answer Code'} <Key />
        {/if}
      </button>
    </div>

    {#if answerCode}
      <div class="divider"></div>
      <p class="mb-2 font-semibold">B. Send this answer code back to the sender</p>
      <textarea
        class="textarea textarea-bordered w-full font-mono text-xs h-28"
        readonly
        value={answerCode}
        onfocus={(e) => (e.currentTarget as HTMLTextAreaElement).select()}
      ></textarea>
      <div class="flex gap-2 flex-wrap mt-2">
        <button
          class="btn btn-soft btn-success"
          onclick={() => copyText(answerCode, 'Answer code')}
        >
          Copy Code <Copy />
        </button>
      </div>
      <div class="alert alert-info mt-4">
        <span>Waiting for the sender to paste your answer code...</span>
      </div>
    {/if}

    <div class="mt-4 flex gap-2">
      <a href="/" data-navigo>
        <button class="btn btn-dash btn-warning" onclick={navigateToOfferPage}>
          Go to Offer Page <CircleArrowOutUpLeft />
        </button>
      </a>
    </div>
  </Collapse>

  <Toast />
</div>

{#if isConnecting && dataChannel}
  {@const dc = dataChannel}
  <SessionShell {call} bind:tab bind:newFiles={showNewFile} onLeave={leaveSession}>
    {#snippet sendPane()}
      <Sender
        bind:this={sender}
        dataChannel={dc}
        {ctrl}
        {rsaPub}
        isEncrypt={!!rsa}
        chunkSize={defaultSendOptions.chunkSize}
      />
    {/snippet}
    {#snippet receivePane()}
      <Receiver bind:this={receiver} dataChannel={dc} isEncrypt={!!rsa} {rsa} />
    {/snippet}
  </SessionShell>
{/if}
