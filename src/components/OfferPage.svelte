<script lang="ts">
  import { addToastMessage } from '../stores/toastStore';
  import { defaultSendOptions, githubLink, waitIceCandidatesTimeout } from '../configs';
  import Eye from '../components/icons/Eye.svelte';
  import { Message } from '../proto/message';
  import Collapse from '../components/layout/Collapse.svelte';
  import OfferOptions from '../components/OfferOptions.svelte';
  import {
    Asterisk,
    Cog,
    ChevronsLeftRightEllipsis,
    Clipboard,
    LandPlot,
    Send,
    HeartHandshake,
    FilePlus
  } from '@lucide/svelte';
  import { onMount, onDestroy } from 'svelte';
  import { Capacitor } from '@capacitor/core';

  import {
    exportRsaPublicKeyToBase64,
    generateRsaKeyPair,
    importRsaPublicKeyFromBase64
  } from '../utils/crypto';
  import { sdpDecode, sdpEncode } from '../utils/sdpEncode';
  import { generateUniqueCode, parseUniqueCode } from '../utils/uniqueCode';
  import type { SendOptions } from '../type';
  import Sender from '../components/sender/Sender.svelte';
  import Receiver from '../components/receiver/Receiver.svelte';
  import QrModal from '../components/qr/QrModal.svelte';
  import ScanQrModal from '../components/qr/ScanQrModal.svelte';
  import Toast from '../components/Toast.svelte';
  import { navigate } from '../stores/navigationStore';

  // options
  let sendOptions = $state(defaultSendOptions);
  let rsa: CryptoKeyPair | undefined = $state(undefined); // private key
  let rsaPub: CryptoKey | undefined = $state(undefined); // public key from other peer

  let showPassword = $state(false); // State to control password visibility
  // Value to bind with the input

  // webRTC
  let connection: RTCPeerConnection | undefined = $state(undefined);
  let dataChannel: RTCDataChannel | undefined = $state(undefined);
  let isConnecting = $state(false);
  let generating = $state(false);
  let offerCode = $state('');
  let showOfferCode = $state(false);
  let answerCode = $state('');

  // components
  let receiver: Receiver | undefined = $state(undefined);
  let sender: Sender | undefined = $state(undefined);
  let sendMode = $state(true);
  let showNewFile = $state(false);
  let showOfferOptions = $state(false);
  let qrModal: QrModal | undefined = $state(undefined);

  // Debug logging functions
  function logWebRTCState() {
    if (!connection) {
      console.error('WebRTC Connection: Not initialized');
      return;
    }

    // console.log('WebRTC Connection Details:', {
    //   signalingState: connection.signalingState,
    //   iceConnectionState: connection.iceConnectionState,
    //   connectionState: connection.connectionState,
    //   hasLocalDescription: !!connection.localDescription,
    //   hasRemoteDescription: !!connection.remoteDescription
    // });
  }

  function debugAcceptAnswer() {
    // console.log('Debug Accept Answer:', {
    //   answerCode,
    //   sendOptions,
    //   isEncrypting: sendOptions.isEncrypt,
    //   connectionExists: !!connection
    // });

    logWebRTCState();
  }

  async function createOfferCode(offer: RTCSessionDescription) {
    let publicKeyBase64 = '';
    if (sendOptions.isEncrypt) {
      rsa = await generateRsaKeyPair();
      publicKeyBase64 = await exportRsaPublicKeyToBase64(rsa.publicKey);
    }

    const sdp = sdpEncode(offer.sdp);
    offerCode = generateUniqueCode(sdp, {
      iceServer:
        defaultSendOptions.iceServer === sendOptions.iceServer ? undefined : sendOptions.iceServer,
      chunkSize:
        defaultSendOptions.chunkSize === sendOptions.chunkSize ? undefined : sendOptions.chunkSize,
      publicKey: publicKeyBase64
    });
  }

  async function createPeerAndDataCannel() {
    connection = new RTCPeerConnection({
      iceServers: [{ urls: sendOptions.iceServer }],
      bundlePolicy: 'balanced',
      iceCandidatePoolSize: 4
    });

    connection.onicecandidateerror = () => {
      addToastMessage('ICE Candidate error', 'error');
    };

    dataChannel = connection.createDataChannel('data', {
      ordered: false // we handle the order by response status
    });
    dataChannel.onopen = () => {
      addToastMessage('Connected', 'success');
      isConnecting = true;
      qrModal?.close();
    };
    dataChannel.onmessage = (event) => {
      const message = Message.decode(new Uint8Array(event.data));

      if (message.metaData !== undefined && receiver) {
        receiver.onMetaData(message.id, message.metaData);
        showNewFile = true;
      } else if (message.chunk !== undefined && receiver) {
        receiver.onChunkData(message.id, message.chunk);
      } else if (message.receiveEvent !== undefined && sender) {
        sender.onReceiveEvent(message.id, message.receiveEvent);
      }
    };
    dataChannel.onerror = () => {
      addToastMessage('WebRTC error', 'error');
      isConnecting = false;
      offerCode = '';
    };
    dataChannel.onclose = () => {
      addToastMessage('Disconnected', 'error');
      isConnecting = false;
      offerCode = '';
    };
  }

  async function generateOfferCode() {
    generating = true;
    await createPeerAndDataCannel();

    if (!connection) {
      addToastMessage('Failed to create WebRTC connection', 'error');
      generating = false;
      return;
    }

    connection.onicecandidate = async (event) => {
      if (!event.candidate && connection!.localDescription) {
        await createOfferCode(connection!.localDescription);
        generating = false;
      }
    };

    try {
      const offer = await connection.createOffer({
        offerToReceiveVideo: false,
        offerToReceiveAudio: false
      });
      await connection.setLocalDescription(offer);

      // stop waiting for ice candidates if longer than timeout
      setTimeout(async () => {
        if (!connection?.localDescription || !generating) return;
        addToastMessage('timeout waiting ICE candidates');
        await createOfferCode(connection.localDescription);
        generating = false;
      }, waitIceCandidatesTimeout);
    } catch (error) {
      console.error('Error generating offer:', error);
      addToastMessage('Failed to generate offer', 'error');
      generating = false;
    }
  }

  async function copyOfferCode() {
    try {
      await navigator.clipboard.writeText(offerCode);
      addToastMessage('Copied to clipboard', 'info');
    } catch (error) {
      console.error('Failed to copy offer code:', error);
      addToastMessage('Failed to copy offer code', 'error');
    }
  }

  async function acceptAnswer() {
    // Debugging log
    debugAcceptAnswer();

    if (!answerCode.trim()) {
      addToastMessage('Please enter an answer code', 'error');
      return;
    }

    try {
      // Validate the answer code structure first
      let parsedCode;
      try {
        parsedCode = parseUniqueCode(answerCode);
      } catch (parseError) {
        addToastMessage('Invalid answer code format', 'error');
        console.error('Parse error:', parseError);
        return;
      }

      const { sdp, publicKey } = parsedCode;

      // Ensure we have a valid connection before setting remote description
      if (!connection) {
        addToastMessage('WebRTC connection not established', 'error');
        return;
      }

      // Handle encryption key if needed
      if (sendOptions.isEncrypt && publicKey) {
        try {
          rsaPub = await importRsaPublicKeyFromBase64(publicKey);
        } catch (cryptoError) {
          addToastMessage('Failed to import public key', 'error');
          console.error('Crypto import error:', cryptoError);
          return;
        }
      }

      // Decode and set remote description
      const remoteDesc: RTCSessionDescriptionInit = {
        type: 'answer',
        sdp: sdpDecode(sdp, false)
      };

      // Add error handling for setRemoteDescription
      try {
        await connection.setRemoteDescription(remoteDesc);
        addToastMessage('Answer code accepted', 'success');
      } catch (setDescError) {
        addToastMessage('Failed to set remote description', 'error');
        console.error('Set remote description error:', setDescError);
      }
    } catch (error) {
      addToastMessage('Unexpected error processing answer code', 'error');
      console.error('Unexpected error:', error);
    }
  }

  function onOptionsUpdate(options: SendOptions) {
    sendOptions = options;
  }

  function navigateToAnswerPage() {
    window.location.href = `${window.location.origin}/answer.html`;
  }

  const isMobile = Capacitor.isNativePlatform();
  let gPressed = false;

  onMount(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key.toLowerCase() == 'o') {
        event.preventDefault();
        generateOfferCode();
      } else if (isMobile) {
        if (event.key == 'Enter') {
          event.preventDefault();
          acceptAnswer();
        }
      } else if (event.ctrlKey && event.key.toLowerCase() == 'a') {
        event.preventDefault();
        acceptAnswer();
      } else if (event.key.toLowerCase() == 'g') {
        gPressed = true;
      } else if (gPressed && event.key.toLowerCase() == 'a') {
        event.preventDefault();
        window.location.href = '/answer.html';
        //gPressed = false ;
      } else if (event.altKey && event.key == 's') {
        event.preventDefault();
        showOfferOptions = true;
        // showOfferOptions.update(v => !v);
      } else if (event.ctrlKey && event.key.toLowerCase() == 'c') {
        event.preventDefault();
        copyOfferCode();
      } else if (event.ctrlKey && event.key.toLowerCase() === 'v') {
        event.preventDefault();
        navigator.clipboard
          .readText()
          .then((text) => {
            answerCode = text;
          })
          .catch((error) => {
            console.error('Failed to read clipboard contents: ', error);
          });
      } else {
        gPressed = false;
      }
    };

    window.addEventListener('keydown', handleShortcut);

    onDestroy(() => {
      window.removeEventListener('keydown', handleShortcut);
    });
  });
</script>

<div class="container mx-auto p-4 max-w-3xl">
  <h1 class="text-2xl font-bold mb-4">File Transfer - Offer Page</h1>

  <Collapse title="1. Generate Offer" isOpen={!offerCode}>
    {#if generating}
      <div class="flex flex-col items-center justify-center gap-2">
        <span class="loading loading-spinner loading-lg"></span>
        <div>Generating Offer</div>
      </div>
    {:else}
      <p>
        Generate a unique offer code to establish a connection. See
        <a
          class="link"
          href={'https://speed-share-web.vercel.app/' + '#how-does-it-work'}
          target="_blank"
          rel="noopener noreferrer">How does it work?</a
        >
      </p>
      <div class="mt-4">
        {#if showOfferOptions}
          <OfferOptions onUpdate={onOptionsUpdate} />
        {/if}
        <div class="">
          <button class="btn btn-soft btn-secondary" onclick={generateOfferCode}
            >Generate Offer Code <Asterisk /></button
          >

          {#if !showOfferOptions}
            <button
              class="btn btn-secondary"
              onclick={() => {
                showOfferOptions = true;
              }}>Settings <Cog /></button
            >
          {/if}
          <button class="btn btn-dash btn-warning" onclick={navigateToAnswerPage}>
            Go to Answer Page <ChevronsLeftRightEllipsis />
          </button>
        </div>
      </div>
    {/if}
  </Collapse>

  <Collapse title="2. Accept Answer" isOpen={offerCode !== '' && !isConnecting}>
    {#if offerCode}
      <p class="">
        Share this unique offer code with your peer. They will need to enter it on the Answer page.
      </p>
      <div class="mt-2 relative">
        <input
          type={showOfferCode ? 'text' : 'password'}
          class="input input-bordered w-full pr-12"
          value={offerCode}
          readonly
        />

        <!-- Eye icon -->
        <div class="absolute top-1/2 transform -translate-y-1/2 right-2 p-1">
          <Eye
            onChange={(show) => {
              showOfferCode = show;
            }}
          />
        </div>
      </div>

      <div class="mt-4 flex gap-2">
        <button class="btn btn-dash btn-success" onclick={copyOfferCode}
          >Copy Code <Clipboard /> </button
        >



        <QrModal bind:this={qrModal} qrData={offerCode} title="Offer QR Code" />
      </div>
      <p class="mt-4">Enter the Answer Code from your peer to establish connection.</p>
      <div class="relative mt-4">
        <!-- Toggle the input type based on the showPassword state -->
        <input
          class="input input-bordered w-full"
          type={showPassword ? 'text' : 'password'}
          bind:value={answerCode}
        />

        <!-- Inline SVG for the eye icon to toggle visibility -->
        {#if showPassword}
          <button
            type="button"
            class="absolute top-1/2 transform -translate-y-1/2 right-2 p-1"
            onclick={() => (showPassword = !showPassword)}
            aria-label="Toggle password visibility"
            onkeydown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                showPassword = !showPassword;
              }
            }}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              class="h-6 w-6 cursor-pointer"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M15 12c0 1.657-1.343 3-3 3s-3-1.343-3-3 1.343-3 3-3 3 1.343 3 3z"
              />
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M2.458 12C3.732 7.724 7.732 5 12 5c4.268 0 8.268 2.724 9.542 7-1.274 4.276-5.274 7-9.542 7-4.268 0-8.268-2.724-9.542-7z"
              />
            </svg>
          </button>
        {:else}
          <button
            type="button"
            class="absolute top-1/2 transform -translate-y-1/2 right-2 p-1"
            onclick={() => (showPassword = !showPassword)}
            aria-label="Toggle password visibility"
            onkeydown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                showPassword = !showPassword;
              }
            }}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              class="lucide lucide-eye-off-icon lucide-eye-off"
              ><path
                d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"
              /><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242" /><path
                d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"
              /><path d="m2 2 20 20" /></svg
            >
          </button>
        {/if}
      </div>
      <div class="mt-4 flex gap-2">
        <button class="btn btn-soft btn-warning" onclick={acceptAnswer}
          >Accept Answer <LandPlot /></button
        >
        <ScanQrModal
          onScanSuccess={(data) => {
            answerCode = data;
            acceptAnswer();
          }}
        />
      </div>
    {/if}
  </Collapse>

  <Collapse title="3. Transfer Files" isOpen={isConnecting}>
    {#if dataChannel}
      <div class="flex w-full mb-4 mt-2 justify-center">
        <div class="join w-full">
          <!-- Send Button -->
          <button
            class="btn btn-dash btn-secondary join-item w-1/2 text-xl py-4 min-h-[3.5rem] inline-flex items-center justify-center gap-x-2"
            onclick={() => {
              sendMode = true;
            }}
          >
            <Send />
            <span class="btm-nav-label">Send</span>
          </button>

          <!-- Receive Button with Badge -->
          <div class="relative w-1/2">
            <span
              class="indicator-item badge badge-success text-xs animate-bounce absolute"
              class:hidden={!showNewFile}
              style="top: -8px; right: 12px; z-index: 10;"
            >
              New files
            </span>
            <button
              class="btn btn-dash btn-warning join-item w-full text-xl py-4 min-h-[3.5rem] inline-flex items-center justify-center gap-x-2"
              class:btn-ghost={sendMode}
              class:btn-primary={!sendMode}
              onclick={() => {
                showNewFile = false;
                sendMode = false;
              }}
            >
              <HeartHandshake />
              <span class="btm-nav-label">Receive</span>
            </button>
          </div>
        </div>
      </div>

      <div hidden={!sendMode}>
        <Sender
          bind:this={sender}
          {dataChannel}
          {rsaPub}
          isEncrypt={sendOptions.isEncrypt}
          chunkSize={sendOptions.chunkSize}
        />
      </div>

      <div hidden={sendMode}>
        <Receiver bind:this={receiver} {dataChannel} isEncrypt={sendOptions.isEncrypt} {rsa} />
      </div>
    {/if}
  </Collapse>

  <Toast />
</div>