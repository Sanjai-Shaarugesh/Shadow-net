<script lang="ts">
  import { addToastMessage } from '../stores/toastStore';
  import { defaultSendOptions, waitIceCandidatesTimeout } from '../configs';
  import { Message } from '../proto/message';
  import Collapse from '../components/layout/Collapse.svelte';
  import OfferOptions from '../components/OfferOptions.svelte';
  import { Cog, ChevronsLeftRightEllipsis, Clipboard, Send, Key } from '@lucide/svelte';
  import { onMount, onDestroy } from 'svelte';
  import {
    encodeSignal,
    decodeSignal,
    buildShareLink,
    type SignalPayload
  } from '../utils/manualSignaling';
  import { hostSession, buildCodeLink, waitForIceFast, type HostSession } from '../utils/shortCode';
  import {
    exportRsaPublicKeyToBase64,
    generateRsaKeyPair,
    importRsaPublicKeyFromBase64
  } from '../utils/crypto';
  import type { SendOptions } from '../type';
  import Sender from '../components/sender/Sender.svelte';
  import Receiver from '../components/receiver/Receiver.svelte';
  import Toast from '../components/Toast.svelte';
  import QrModal from '../components/qr/QrModal.svelte';
  import ScanQrModal from '../components/qr/ScanQrModal.svelte';
  import { identity } from './Peeridentity.svelte';
  import SessionShell from '../components/layout/SessionShell.svelte';
  import { ControlChannel } from '../utils/controlChannel';
  import { CallManager, tuneSdp } from '../utils/mediaCall.svelte';
  import { session } from './session.svelte';

  let sendOptions = $state(defaultSendOptions);
  let rsa: CryptoKeyPair | undefined = $state(undefined);
  let rsaPub: CryptoKey | undefined = $state(undefined);

  // Serverless signaling state
  let offerCode = $state('');
  let offerLink = $state('');
  let nameInput = $state('');
  // QR holds the share link: a phone camera opens the answer page with the code pre-filled
  const qrValue = $derived(
    !offerLink
      ? ''
      : /^https?:/i.test(offerLink)
        ? offerLink
        : new URL(offerLink, location.origin).href
  );
  let answerInput = $state('');
  let applyingAnswer = $state(false);
  // true only when the public relay is unreachable and we fall back to the long offline code
  let manualMode = $state(false);
  let hostSess: HostSession | undefined;

  let connection: RTCPeerConnection | undefined = $state(undefined);
  let dataChannel: RTCDataChannel | undefined = $state(undefined);
  let isConnecting = $state(false);
  let generating = $state(false);

  let receiver: Receiver | undefined = $state(undefined);
  let sender: Sender | undefined = $state(undefined);
  let showNewFile = $state(false);
  let showOfferOptions = $state(false);
  let tab: 'chat' | 'send' | 'receive' = $state('chat');

  let ctrl: ControlChannel | undefined = $state(undefined);
  let call: CallManager | undefined = $state(undefined);

  async function createPeerAndDataChannel() {
    const config: RTCConfiguration = {
      iceServers: [
        { urls: sendOptions.iceServer },
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ],
      bundlePolicy: 'balanced',
      iceCandidatePoolSize: 4
    };

    connection = new RTCPeerConnection(config);
    identity.attach(connection, 'offer'); // I'm "Peer 1" unless renamed; syncs name to the receiver

    connection.onicecandidateerror = (err) => {
      console.error('❌ ICE Candidate error:', err);
      addToastMessage('ICE Candidate error', 'error');
    };

    // Chat / call-invites / previews travel on their own pre-negotiated channel.
    call?.destroy();
    session.reset();
    ctrl = new ControlChannel(connection);
    session.bind(ctrl);
    call = new CallManager(connection, ctrl, addToastMessage);
    // audio+video transceivers go into the offer now; camera/mic stay OFF until a call is accepted
    call.prepareOffer();

    dataChannel = connection.createDataChannel('data', {
      ordered: false
    });

    dataChannel.onopen = () => {
      addToastMessage('Connected successfully!', 'success');
      isConnecting = true;
      generating = false;
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

    dataChannel.onerror = (err) => {
      console.error('❌ Data channel error:', err);
      addToastMessage('Connection error', 'error');
      isConnecting = false;
      offerCode = '';
    };

    dataChannel.onclose = () => {
      addToastMessage('Disconnected', 'error');
      isConnecting = false;
      offerCode = '';
      call?.end();
    };
  }

  async function generateOffer() {
    generating = true;
    offerCode = '';
    offerLink = '';
    answerInput = '';
    try {
      if (connection) {
        connection.close();
        connection = undefined;
      }
      await createPeerAndDataChannel();

      if (!connection) {
        throw new Error('Failed to create connection');
      }

      let publicKeyBase64 = '';
      if (sendOptions.isEncrypt) {
        rsa = await generateRsaKeyPair();
        publicKeyBase64 = await exportRsaPublicKeyToBase64(rsa.publicKey);
      }

      const offer = await connection.createOffer();
      // Opus: in-band FEC + DTX + 32 kbps cap => clear voice on weak links
      await connection.setLocalDescription({ type: 'offer', sdp: tuneSdp(offer.sdp ?? '') });

      // No signaling server => candidates can't be trickled, so wait until
      // they are all inside the SDP before packing it into a code.
      await waitForIceFast(connection, Math.min(waitIceCandidatesTimeout, 4000));

      const sdp = connection.localDescription?.sdp;
      if (!sdp) throw new Error('No local description');

      const payload: SignalPayload = {
        t: 'offer',
        sdp,
        pk: publicKeyBase64 || undefined,
        ice:
          sendOptions.iceServer !== defaultSendOptions.iceServer
            ? sendOptions.iceServer
            : undefined,
        cs:
          sendOptions.chunkSize !== defaultSendOptions.chunkSize ? sendOptions.chunkSize : undefined
      };

      hostSess?.cancel();
      hostSess = undefined;
      manualMode = false;

      try {
        // Short code: the SDP goes (encrypted) through a public relay, not through the code
        const session = await hostSession(payload);
        hostSess = session;
        offerCode = session.display;
        offerLink = buildCodeLink(session.code, '/answer.html');
        session.answer.then(applyAnswerPayload).catch((e) => {
          if (e?.message !== 'Cancelled') {
            addToastMessage(e?.message || 'Connection failed', 'error');
          }
        });
        addToastMessage('Code ready! Share it with the receiver', 'success');
      } catch (relayError) {
        // Relay blocked/offline -> old fully-offline flow (long offer + answer codes)
        console.warn('Relay unavailable, using manual codes:', relayError);
        manualMode = true;
        offerCode = await encodeSignal(payload);
        offerLink = buildShareLink(offerCode, 'offer', '/answer.html');
        addToastMessage('Relay unreachable - using long offline codes instead', 'warning');
      }

      generating = false;
    } catch (error) {
      console.error('Error generating offer:', error);
      addToastMessage('Failed to generate offer', 'error');
      generating = false;
    }
  }

  async function applyAnswerPayload(answer: SignalPayload) {
    if (!connection || connection.signalingState !== 'have-local-offer') return;
    if (sendOptions.isEncrypt && answer.pk) {
      rsaPub = await importRsaPublicKeyFromBase64(answer.pk);
    }
    await connection.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
    addToastMessage('Receiver joined, connecting...', 'success');
  }

  async function applyAnswer() {
    if (!connection || !answerInput.trim()) return;
    if (connection.signalingState !== 'have-local-offer') {
      addToastMessage('Answer already applied. Generate a new offer to retry.', 'warning');
      return;
    }

    applyingAnswer = true;
    try {
      const answer = await decodeSignal(answerInput, 'answer');

      await applyAnswerPayload(answer);
    } catch (error) {
      console.error('Error processing answer:', error);
      addToastMessage(error instanceof Error ? error.message : 'Invalid answer code', 'error');
    } finally {
      applyingAnswer = false;
    }
  }

  async function pasteAnswer() {
    try {
      answerInput = await navigator.clipboard.readText();
    } catch {
      addToastMessage('Clipboard blocked - paste manually into the box', 'warning');
    }
  }

  async function copyText(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      addToastMessage(`${label} copied!`, 'info');
    } catch (error) {
      console.error('Failed to copy:', error);
      addToastMessage(`Failed to copy ${label.toLowerCase()}`, 'error');
    }
  }

  const copyOfferCode = () => copyText(offerCode, 'Offer code');
  const copyOfferLink = () => copyText(offerLink, 'Link');

  function onOptionsUpdate(options: SendOptions) {
    sendOptions = options;
  }

  function navigateToAnswerPage() {
    window.location.href = `${window.location.origin}/answer.html`;
  }

  onMount(() => {
    // console.log('📄 Offer page mounted');

    const handleShortcut = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key.toLowerCase() == 'o') {
        event.preventDefault();
        generateOffer();
      } else if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() == 'c') {
        event.preventDefault();
        copyOfferCode();
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
    identity.detach();
    window.location.reload();
  }

  onDestroy(() => {
    hostSess?.cancel();
    call?.destroy();
    ctrl?.close();
    connection?.close();
    session.reset();
    identity.detach();
  });
</script>

<div class="container mx-auto max-w-3xl p-2 sm:p-4">
  <h1 class="mb-3 text-xl font-bold sm:text-2xl">File Transfer - Offer Page</h1>

  <Collapse title="1. Create Offer Code" isOpen={!offerCode}>
    {#if generating}
      <div class="flex flex-col items-center justify-center gap-2">
        <span class="loading loading-spinner loading-lg"></span>
        <div>Gathering network info...</div>
      </div>
    {:else}
      <p class="mb-4">
        Create a short code and share it with your peer (chat, call, QR, link). They enter it and
        you connect automatically. Files go directly peer-to-peer; the code is only used once.
      </p>
      <label class="mb-3 flex items-center gap-2 text-sm">
        <span class="shrink-0 font-semibold">Your name</span>
        <input
          class="input input-bordered input-sm min-w-0 flex-1"
          maxlength="24"
          placeholder={identity.me}
          bind:value={nameInput}
          onchange={() => identity.rename(nameInput)}
        />
      </label>
      <div class="mt-4">
        {#if showOfferOptions}
          <OfferOptions onUpdate={onOptionsUpdate} />
        {/if}
        <div class="flex gap-2 flex-wrap">
          <button class="btn btn-soft btn-secondary" onclick={generateOffer}>
            Create Code <Key />
          </button>

          {#if !showOfferOptions}
            <button
              class="btn btn-secondary"
              onclick={() => {
                showOfferOptions = true;
              }}
            >
              Settings <Cog />
            </button>
          {/if}
          <button class="btn btn-dash btn-warning" onclick={navigateToAnswerPage}>
            Go to Answer Page <ChevronsLeftRightEllipsis />
          </button>
        </div>
      </div>
    {/if}
  </Collapse>

  <Collapse title="2. Exchange Codes" isOpen={offerCode !== '' && !isConnecting}>
    {#if offerCode}
      <p class="mb-2 font-semibold">A. Send this to your peer</p>
      {#if manualMode}
        <textarea
          class="textarea textarea-bordered w-full font-mono text-xs h-20 sm:h-28"
          readonly
          value={offerCode}
          onfocus={(e) => (e.currentTarget as HTMLTextAreaElement).select()}
        ></textarea>
      {:else}
        <div class="my-2 text-center font-mono text-2xl tracking-widest select-all sm:text-4xl">
          {offerCode}
        </div>
      {/if}

      <!-- QR of the share link, shown right away -->
      {#if qrValue}
        <div class="my-2">
          <QrModal inline title="Offer code" qrData={qrValue} />
        </div>
      {/if}

      <div class="mt-2 flex flex-wrap gap-2">
        <button class="btn btn-soft btn-success btn-sm sm:btn-md" onclick={copyOfferCode}>
          Copy Code <Clipboard class="h-4 w-4" />
        </button>
        <button class="btn btn-soft btn-info btn-sm sm:btn-md" onclick={copyOfferLink}>
          Copy Link <Clipboard class="h-4 w-4" />
        </button>
      </div>
      <p class="text-xs opacity-70 mt-1">
        The link opens the answer page with the code pre-filled. The code lives after the
        <code>#</code>, so it's never sent to the web host. Share it only over a channel you trust.
      </p>

      {#if manualMode}
        <div class="divider"></div>

        <p class="mb-2 font-semibold">B. Paste the answer code they send back</p>
        <textarea
          class="textarea textarea-bordered w-full font-mono text-xs h-20 sm:h-28"
          placeholder="Paste answer code here..."
          bind:value={answerInput}
          disabled={applyingAnswer}
        ></textarea>
        <div class="mt-2 flex flex-wrap items-center gap-2">
          <button class="btn btn-ghost btn-sm sm:btn-md" onclick={pasteAnswer}>
            Paste <Clipboard class="h-4 w-4" />
          </button>
          <ScanQrModal
            buttonText="Scan answer"
            modalTitle="Scan the receiver's QR"
            onScanSuccess={(d) => {
              answerInput = d.trim();
              applyAnswer();
            }}
          />
          <button
            class="btn btn-primary btn-sm sm:btn-md"
            onclick={applyAnswer}
            disabled={applyingAnswer || !answerInput.trim()}
          >
            {#if applyingAnswer}
              <span class="loading loading-spinner"></span>
            {/if}
            Connect <Send />
          </button>
        </div>
      {/if}

      <div class="alert alert-info mt-4">
        <span>
          {manualMode
            ? "Waiting for the receiver's answer code..."
            : 'Waiting for the receiver to enter this code...'}
        </span>
      </div>
    {/if}
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
        isEncrypt={sendOptions.isEncrypt}
        chunkSize={sendOptions.chunkSize}
      />
    {/snippet}
    {#snippet receivePane()}
      <Receiver bind:this={receiver} dataChannel={dc} isEncrypt={sendOptions.isEncrypt} {rsa} />
    {/snippet}
  </SessionShell>
{/if}
