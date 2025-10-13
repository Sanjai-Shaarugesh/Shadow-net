<script lang="ts">
  import { defaultSendOptions, waitIceCandidatesTimeout } from '../configs';
  import { addToastMessage } from '../stores/toastStore';
  import { Message } from '../proto/message';
  import Collapse from '../components/layout/Collapse.svelte';
  import { Cpu, CircleArrowOutUpLeft, Send, Antenna, Key } from '@lucide/svelte';
  import { onMount, onDestroy } from 'svelte';
  import SignalingService from '../utils/signaling';
  import type { SignalingMessage } from '../utils/signaling';

  import {
    exportRsaPublicKeyToBase64,
    generateRsaKeyPair,
    importRsaPublicKeyFromBase64
  } from '../utils/crypto';
  import Receiver from '../components/receiver/Receiver.svelte';
  import Sender from '../components/sender/Sender.svelte';
  import Toast from '../components/Toast.svelte';

  // Signaling service
  let signalingService = $state(SignalingService.getInstance());

  // state
  let connectionPIN = $state('');
  let isProcessing = $state(false);
  let isConnecting = $state(false);
  let dataChannel: RTCDataChannel | undefined = $state(undefined);
  let rsa: CryptoKeyPair | undefined = $state(undefined);
  let rsaPub: CryptoKey | undefined = $state(undefined);

  // components
  let receiver: Receiver | undefined = $state(undefined);
  let sender: Sender | undefined = $state(undefined);
  let sendMode = $state(false);
  let showNewFile = $state(false);

  // connection object
  let connection: RTCPeerConnection;

  // Cleanup function for signaling listener
  let cleanupListener: (() => void) | undefined = $state(undefined);

  async function processConnectionPIN() {
    if (!connectionPIN || connectionPIN.length !== 6) {
      addToastMessage('Please enter a valid 6-digit PIN', 'error');
      return;
    }

    isProcessing = true;

    try {
      // Listen for offer with this PIN
      cleanupListener = signalingService.listenForOffer(connectionPIN, async (offer: SignalingMessage) => {
        try {
          // Create peer connection
          const iceServer = offer.iceServer || defaultSendOptions.iceServer;
          connection = new RTCPeerConnection({
            iceServers: [{ urls: iceServer }],
            bundlePolicy: 'balanced',
            iceCandidatePoolSize: 4
          });

          // Store offer public key if encryption is enabled
          if (offer.publicKey) {
            rsaPub = await importRsaPublicKeyFromBase64(offer.publicKey);
            rsa = await generateRsaKeyPair();
          }

          // Set up data channel handler
          connection.ondatachannel = (event) => {
            dataChannel = event.channel;

            dataChannel.onopen = () => {
              addToastMessage('Connected', 'success');
              isConnecting = true;
              isProcessing = false;
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
            };

            dataChannel.onclose = () => {
              addToastMessage('Disconnected', 'error');
              isConnecting = false;
            };
          };

          // Set remote description (offer)
          await connection.setRemoteDescription({
            type: 'offer',
            sdp: offer.sdp
          });

          // Generate answer with public key
          let publicKeyBase64 = '';
          if (rsa) {
            publicKeyBase64 = await exportRsaPublicKeyToBase64(rsa.publicKey);
          }

          connection.onicecandidate = async (event) => {
            if (!event.candidate && connection.localDescription) {
              // Send answer through signaling service
              await signalingService.sendAnswer(
                connectionPIN,
                connection.localDescription.sdp,
                publicKeyBase64
              );

              addToastMessage('Answer sent, waiting for connection...', 'success');
            }
          };

          const answer = await connection.createAnswer();
          await connection.setLocalDescription(answer);

          // Timeout for ICE candidates
          setTimeout(async () => {
            if (!connection.localDescription) return;

            await signalingService.sendAnswer(
              connectionPIN,
              connection.localDescription.sdp,
              publicKeyBase64
            );

            addToastMessage('Answer sent (timeout), waiting for connection...', 'info');
          }, waitIceCandidatesTimeout);

        } catch (error) {
          console.error('Error processing offer:', error);
          addToastMessage('Failed to process offer', 'error');
          isProcessing = false;
        }
      });

      addToastMessage('Listening for connection with PIN...', 'info');

    } catch (error) {
      console.error('Error setting up listener:', error);
      addToastMessage('Failed to set up connection', 'error');
      isProcessing = false;
    }
  }

  function navigateToOfferPage() {
    window.location.href = `${window.location.origin}/`;
  }

  onMount(() => {
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

      if (e.key === 'Enter') {
        e.preventDefault();
        processConnectionPIN();
      } else if (e.altKey && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        processConnectionPIN();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
        const inputElement = document.querySelector('input[type="text"]') as HTMLInputElement;
        if (inputElement) {
          inputElement.focus();
        }
      }
    };

    window.addEventListener('keydown', handleShortcut);
    
    return () => {
      window.removeEventListener('keydown', handleShortcut);
      if (cleanupListener) {
        cleanupListener();
      }
    };
  });

  onDestroy(() => {
    if (cleanupListener) {
      cleanupListener();
    }
  });
</script>

<div class="container mx-auto p-4 max-w-3xl">
  <h1 class="text-2xl font-bold mb-4">File Transfer - Answer Page</h1>

  <Collapse title="1. Enter Connection PIN" isOpen={!isConnecting}>
    <p class="mb-4">
      Enter the 6-digit PIN provided by the sender to establish a connection.
    </p>
    <div class="mt-4">
      <div class="form-control">
        <label class="label">
          <span class="label-text">Connection PIN</span>
        </label>
        <input
          type="text"
          class="input input-bordered w-full text-center text-2xl font-mono tracking-wider"
          placeholder="000000"
          maxlength="6"
          bind:value={connectionPIN}
          disabled={isProcessing || isConnecting}
          oninput={(e) => {
            // Only allow numbers
            const target = e.target as HTMLInputElement;
            target.value = target.value.replace(/[^0-9]/g, '');
            connectionPIN = target.value;
          }}
        />
      </div>
      
      <div class="mt-4 flex gap-2 flex-wrap">
        <button
          class="btn btn-outline btn-accent flex-1"
          onclick={processConnectionPIN}
          disabled={isProcessing || isConnecting || connectionPIN.length !== 6}
        >
          {#if isProcessing}
            <span class="loading loading-spinner"></span>
            Connecting...
          {:else}
            Connect <Key />
          {/if}
        </button>
      </div>

      <div class="mt-4 flex gap-2">
        <a href="/" data-navigo>
          <button class="btn btn-dash btn-warning" onclick={navigateToOfferPage}>
            Go to Offer Page <CircleArrowOutUpLeft />
          </button>
        </a>
      </div>

      {#if isProcessing}
        <div class="alert alert-info mt-4">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="stroke-current shrink-0 w-6 h-6">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
          </svg>
          <span>Waiting for sender to generate offer with this PIN...</span>
        </div>
      {/if}
    </div>
  </Collapse>

  <Collapse title="2. Transfer Files" isOpen={isConnecting}>
    {#if dataChannel}
      <div class="flex w-full mb-4 mt-2 justify-center">
        <div class="join w-full">
          <button
            class="btn btn-dash btn-warning join-item w-1/2 text-xl py-4 min-h-[3.5rem] inline-flex items-center justify-center gap-x-2"
            onclick={() => {
              sendMode = true;
            }}
          >
            <Send />
            <span class="btm-nav-label">Send</span>
          </button>

          <div class="indicator w-1/2 join-item relative">
            <span
              class="indicator-item badge badge-success text-xs animate-bounce"
              class:hidden={!showNewFile}
              style="top: 0; right: 10%; left: 70%; z-index: 10;"
            >
              New files
            </span>
            <button
              class="btn btn-dash btn-secondary join-item w-full text-xl py-4 min-h-[3.5rem] inline-flex items-center justify-center gap-x-2"
              onclick={() => {
                showNewFile = false;
                sendMode = false;
              }}
            >
              <Antenna />
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
          isEncrypt={!!rsa}
          chunkSize={defaultSendOptions.chunkSize}
        />
      </div>

      <div hidden={sendMode}>
        <Receiver bind:this={receiver} {dataChannel} isEncrypt={!!rsa} {rsa} />
      </div>
    {/if}
  </Collapse>

  <Toast />
</div>