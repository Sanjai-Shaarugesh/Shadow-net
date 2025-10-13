<script lang="ts">
  import { defaultSendOptions, waitIceCandidatesTimeout } from '../configs';
  import { addToastMessage } from '../stores/toastStore';
  import { Message } from '../proto/message';
  import ScanQrModal from '../components/qr/ScanQrModal.svelte';
  import Collapse from '../components/layout/Collapse.svelte';
  import {
    Antenna,
    Copy,
    Send,
    HeartHandshake,
    Key,
    Video,
    Mic,
    VideoOff,
    MicOff,
    QrCode,
    ArrowRight,
    CircleArrowOutUpLeft
  } from 'lucide-svelte';
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

  let signalingService = $state(SignalingService.getInstance());

  let connectionPIN = $state('');
  let isProcessing = $state(false);
  let isConnecting = $state(false);
  let dataChannel: RTCDataChannel | undefined = $state(undefined);
  let rsa: CryptoKeyPair | undefined = $state(undefined);
  let rsaPub: CryptoKey | undefined = $state(undefined);

  let receiver: Receiver | undefined = $state(undefined);
  let sender: Sender | undefined = $state(undefined);
  let sendMode = $state(false);
  let showNewFile = $state(false);

  let connection: RTCPeerConnection | undefined = $state(undefined);
  let cleanupListener: (() => void) | undefined = $state(undefined);

  let localStream: MediaStream | undefined = $state(undefined);
  let remoteStream: MediaStream | undefined = $state(undefined);
  let isVideoOn = $state(false);
  let isAudioOn = $state(false);

  let localVideoEl: HTMLVideoElement | undefined = $state(undefined);
  let remoteVideoEl: HTMLVideoElement | undefined = $state(undefined);

  $effect(() => {
    if (localVideoEl && localStream) {
      localVideoEl.srcObject = localStream;
    }
  });

  $effect(() => {
    if (remoteVideoEl && remoteStream) {
      remoteVideoEl.srcObject = remoteStream;
    }
  });

  async function startLocalMedia() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      localStream = stream;
      isVideoOn = stream.getVideoTracks().some(t => t.enabled);
      isAudioOn = stream.getAudioTracks().some(t => t.enabled);
      addToastMessage('Local media started', 'success');
      return stream;
    } catch (error) {
      console.error('Failed to get local media:', error);
      addToastMessage('Failed to get camera/mic access', 'warning');
      return undefined;
    }
  }

  function toggleVideo() {
    if (localStream) {
      const tracks = localStream.getVideoTracks();
      if (tracks.length > 0) {
        tracks.forEach(track => track.enabled = !track.enabled);
        isVideoOn = tracks[0].enabled;
        addToastMessage(`Video ${isVideoOn ? 'on' : 'off'}`, isVideoOn ? 'info' : 'warning');
      }
    }
  }

  function toggleAudio() {
    if (localStream) {
      const tracks = localStream.getAudioTracks();
      if (tracks.length > 0) {
        tracks.forEach(track => track.enabled = !track.enabled);
        isAudioOn = tracks[0].enabled;
        addToastMessage(`Audio ${isAudioOn ? 'on' : 'off'}`, isAudioOn ? 'info' : 'warning');
      }
    }
  }

  async function processConnectionPIN() {
    if (!connectionPIN || connectionPIN.length !== 6) {
      addToastMessage('Please enter a valid 6-digit PIN', 'error');
      return;
    }

    isProcessing = true;
    addToastMessage('Listening for offer...', 'info');

    try {
      cleanupListener = signalingService.listenForOffer(connectionPIN, async (offer: SignalingMessage) => {
        try {
          const stream = await startLocalMedia();

          const iceServer = offer.iceServer || defaultSendOptions.iceServer;
          connection = new RTCPeerConnection({
            iceServers: [{ urls: iceServer }],
            bundlePolicy: 'balanced',
            iceCandidatePoolSize: 4
          });

          if (offer.publicKey) {
            rsaPub = await importRsaPublicKeyFromBase64(offer.publicKey);
            rsa = await generateRsaKeyPair();
          } else {
            rsa = undefined;
            rsaPub = undefined;
          }

          if (stream && connection) {
            stream.getTracks().forEach(track => connection.addTrack(track, stream));
            console.log('Local tracks added to peer connection');
          }

          if (connection) {
            connection.ontrack = (event) => {
              console.log('Received remote track:', event.track.kind);
              if (!remoteStream && event.streams && event.streams[0]) {
                remoteStream = event.streams[0];
              }
            };
          }

          if (connection) {
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
          }

          if (!connection) return;
          await connection.setRemoteDescription({
            type: 'offer',
            sdp: offer.sdp
          });

          let publicKeyBase64 = '';
          if (rsa) {
            publicKeyBase64 = await exportRsaPublicKeyToBase64(rsa.publicKey);
          }

          connection.onicecandidate = async (event) => {
            if (!event.candidate && connection!.localDescription) {
              await signalingService.sendAnswer(
                connectionPIN,
                connection!.localDescription.sdp,
                publicKeyBase64
              );

              addToastMessage('Answer sent, waiting for connection...', 'success');
            }
          };

          const answer = await connection.createAnswer();
          await connection.setLocalDescription(answer);

          setTimeout(() => {
            if (connection!.iceGatheringState !== 'complete') {
              console.log('ICE timeout reached, forcing answer send.');
              connection!.onicecandidate!({ candidate: null } as RTCPeerConnectionIceEvent);
            }
          }, waitIceCandidatesTimeout);

        } catch (error) {
          console.error('Error processing offer:', error);
          addToastMessage('Failed to process offer', 'error');
          isProcessing = false;
        }
      });
    } catch (error) {
      console.error('Error setting up listener:', error);
      addToastMessage('Failed to set up connection', 'error');
      isProcessing = false;
    }
  }

  function handleQRScan(data: string) {
    if (data && data.length === 6 && /^\d+$/.test(data)) {
      connectionPIN = data;
      addToastMessage('PIN scanned successfully!', 'success');
      processConnectionPIN();
    } else {
      addToastMessage('Invalid QR code. Expected 6-digit PIN.', 'error');
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
     let gPressed = false;
     
     
     
    if (cleanupListener) {
      cleanupListener();
    }
    if (localStream) {
      localStream.getTracks().forEach(track => track.stop());
    }
    if (connection) {
      connection.close();
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
  <div class="lg:col-span-2 space-y-4">

        {#if isConnecting}
          <!-- Live Media Card -->
          <div class="backdrop-blur-2xl bg-white/40 dark:bg-slate-900/40 border border-white/60 dark:border-slate-700/60 rounded-3xl shadow-xl overflow-hidden p-6">
            <h3 class="text-lg font-bold text-slate-900 dark:text-white mb-4 flex items-center gap-2">
              <Video class="w-5 h-5 text-amber-500" />
              Live Media
            </h3>

            <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
              <div class="relative aspect-video rounded-2xl bg-black overflow-hidden shadow-lg">
                <video bind:this={localVideoEl} autoplay muted class="w-full h-full object-cover" />
                {#if !localStream}
                  <div class="absolute inset-0 flex items-center justify-center bg-black/80 text-white">
                    <span class="text-sm">Waiting for local media...</span>
                  </div>
                {/if}
                <div class="absolute top-3 left-3 px-3 py-1 rounded-lg bg-blue-500/90 text-white text-xs font-semibold">
                  Local
                </div>
              </div>

              <div class="relative aspect-video rounded-2xl bg-black overflow-hidden shadow-lg">
                <video bind:this={remoteVideoEl} autoplay class="w-full h-full object-cover" />
                {#if !remoteStream}
                  <div class="absolute inset-0 flex items-center justify-center bg-black/80 text-white">
                    <span class="text-sm">Waiting for remote stream...</span>
                  </div>
                {/if}
                <div class="absolute top-3 left-3 px-3 py-1 rounded-lg bg-green-500/90 text-white text-xs font-semibold">
                  Remote
                </div>
              </div>
            </div>

            <div class="flex justify-center gap-4">
              <button
                class="p-4 rounded-full transition-all duration-200 {isAudioOn ? 'bg-gradient-to-br from-green-500 to-emerald-600 text-white shadow-lg' : 'bg-red-500/20 text-red-600 dark:text-red-400'} disabled:opacity-50"
                onclick={toggleAudio}
                disabled={!localStream}
                title="Toggle audio"
              >
                {#if isAudioOn}
                  <Mic class="w-6 h-6" />
                {:else}
                  <MicOff class="w-6 h-6" />
                {/if}
              </button>
              <button
                class="p-4 rounded-full transition-all duration-200 {isVideoOn ? 'bg-gradient-to-br from-blue-500 to-cyan-600 text-white shadow-lg' : 'bg-red-500/20 text-red-600 dark:text-red-400'} disabled:opacity-50"
                onclick={toggleVideo}
                disabled={!localStream}
                title="Toggle video"
              >
                {#if isVideoOn}
                  <Video class="w-6 h-6" />
                {:else}
                  <VideoOff class="w-6 h-6" />
                {/if}
              </button>
            </div>
          </div>
        {/if}

     
      </div>
</div>

