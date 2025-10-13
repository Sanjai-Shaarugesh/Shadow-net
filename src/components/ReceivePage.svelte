<script lang="ts">
  import { defaultSendOptions, waitIceCandidatesTimeout } from '../configs';
  import { addToastMessage } from '../stores/toastStore';
  import { Message } from '../proto/message';
  import Collapse from '../components/layout/Collapse.svelte';
  import {
    Cpu,
    CircleArrowOutUpLeft,
    Send,
    Antenna,
    Key,
    Video,
    Mic,
    VideoOff,
    MicOff
  } from '@lucide/svelte';
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
  let connection: RTCPeerConnection | undefined = $state(undefined);

  // Cleanup function for signaling listener
  let cleanupListener: (() => void) | undefined = $state(undefined);

  // --- START VIDEO/VOICE CALL STATE AND FUNCTIONS ---
  let localStream: MediaStream | undefined = $state(undefined);
  let remoteStream: MediaStream | undefined = $state(undefined);
  let isVideoOn = $state(false);
  let isAudioOn = $state(false);

  // Video element references for manual srcObject assignment
  let localVideoEl: HTMLVideoElement | undefined = $state(undefined);
  let remoteVideoEl: HTMLVideoElement | undefined = $state(undefined);

  // 1. Correctly set srcObject whenever localStream or remoteStream changes
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
      console.error('❌ Failed to get local media:', error);
      addToastMessage('Failed to get camera/mic access. Media channel will be audio/video disabled.', 'warning');
      return undefined;
    }
  }

  function toggleVideo() {
    if (localStream) {
      const tracks = localStream.getVideoTracks();
      if (tracks.length > 0) {
        tracks.forEach(track => {
            track.enabled = !track.enabled;
        });
        isVideoOn = tracks[0].enabled;
        addToastMessage(`Video ${isVideoOn ? 'on' : 'off'}`, isVideoOn ? 'info' : 'warning');
      }
    }
  }

  function toggleAudio() {
    if (localStream) {
      const tracks = localStream.getAudioTracks();
      if (tracks.length > 0) {
        tracks.forEach(track => {
            track.enabled = !track.enabled;
        });
        isAudioOn = tracks[0].enabled;
        addToastMessage(`Audio ${isAudioOn ? 'on' : 'off'}`, isAudioOn ? 'info' : 'warning');
      }
    }
  }
  // --- END VIDEO/VOICE CALL STATE AND FUNCTIONS ---


  async function processConnectionPIN() {
    if (!connectionPIN || connectionPIN.length !== 6) {
      addToastMessage('Please enter a valid 6-digit PIN', 'error');
      return;
    }

    isProcessing = true;
    addToastMessage('Listening for offer...', 'info');


    try {
      // Listen for offer with this PIN
      cleanupListener = signalingService.listenForOffer(connectionPIN, async (offer: SignalingMessage) => {
        try {
          const stream = await startLocalMedia();

          // Create peer connection
          const iceServer = offer.iceServer || defaultSendOptions.iceServer;
          connection = new RTCPeerConnection({
            iceServers: [{ urls: iceServer }],
            bundlePolicy: 'balanced',
            iceCandidatePoolSize: 4
          });

          // Key exchange setup: Store offer public key & generate our own key pair
          if (offer.publicKey) {
            rsaPub = await importRsaPublicKeyFromBase64(offer.publicKey);
            rsa = await generateRsaKeyPair();
          } else {
            rsa = undefined;
            rsaPub = undefined;
          }

          // Add local tracks (Video/Voice)
          if (stream && connection) {
            stream.getTracks().forEach(track => connection.addTrack(track, stream));
            console.log('✅ Local tracks added to peer connection');
          }

          // Handle remote tracks (Video/Voice)
          if (connection) {
            connection.ontrack = (event) => {
              console.log('🔊 Received remote track:', event.track.kind);
              if (!remoteStream && event.streams && event.streams[0]) {
                remoteStream = event.streams[0];
              }
            };
          }


          // Set up data channel handler
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
                // Optionally add logic to close the connection/stop streams here if desired
              };
            };
          }


          // Set remote description (offer)
          if (!connection) return; // Should not happen if successful
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
            if (!event.candidate && connection!.localDescription) {
              // Send answer through signaling service
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

          // ICE candidate gathering timeout
          setTimeout(() => {
            if (connection!.iceGatheringState !== 'complete') {
              console.log('⏳ ICE timeout reached, forcing answer send.');
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
    };
  });

  onDestroy(() => {
    if (cleanupListener) {
      cleanupListener();
    }
    // Cleanup for media and WebRTC
    if (localStream) {
      localStream.getTracks().forEach(track => track.stop());
    }
    if (connection) {
        connection.close();
    }
  });
</script>

<div class="container mx-auto p-4 sm:p-6 lg:p-8">
  <div class="flex flex-col lg:flex-row gap-6">
    <div class="lg:w-1/3 space-y-4">
      <div class="card bg-base-100 shadow-xl">
        <div class="card-body">
          <h2 class="card-title text-2xl mb-4 text-warning">
            <Antenna class="w-6 h-6 mr-2" />
            Connection Setup (Receive)
          </h2>

          {#if !isConnecting}
            <p class="mb-4 text-sm text-base-content/70">
              Enter the 6-digit PIN provided by the sender.
            </p>
            <div class="form-control">
              <label class="label">
                <span class="label-text font-semibold">Connection PIN</span>
              </label>
              <input
                type="text"
                placeholder="000000"
                class="input input-bordered input-lg w-full font-mono text-center text-xl tracking-widest"
                bind:value={connectionPIN}
                maxlength={6}
                disabled={isProcessing}
                onkeydown={(e) => {
                  if (e.key === 'Enter') processConnectionPIN();
                }}
                oninput={(e) => {
                  // Only allow numbers
                  const target = e.target as HTMLInputElement;
                  target.value = target.value.replace(/[^0-9]/g, '');
                  connectionPIN = target.value;
                }}
              />
            </div>

            <button
              class="btn btn-warning btn-lg w-full mt-4"
              onclick={processConnectionPIN}
              disabled={isProcessing || connectionPIN.length !== 6}
            >
              {#if isProcessing}
                <span class="loading loading-spinner"></span>
                Processing Offer...
              {:else}
                Connect <Key class="w-6 h-6 ml-2" />
              {/if}
            </button>
            <a href="/" data-navigo>
              <button class="btn btn-outline btn-sm w-full mt-2" onclick={navigateToOfferPage}>
                Go to Offer Page <CircleArrowOutUpLeft />
              </button>
            </a>
            
            {#if isProcessing}
              <div class="alert alert-info mt-4">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="stroke-current shrink-0 w-6 h-6">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
                </svg>
                <span>Waiting for sender to generate offer...</span>
              </div>
            {/if}

          {:else}
            <div class="alert alert-success shadow-lg">
              <Key class="w-6 h-6" />
              <div>
                <h3 class="font-bold">Connected!</h3>
                <div class="text-xs">Peer connection established. PIN: <span class="font-mono font-bold">{connectionPIN}</span></div>
              </div>
            </div>
          {/if}
        </div>
      </div>
    </div>

    <div class="lg:w-2/3 space-y-4">
      <Toast />

      {#if isConnecting}
        <div class="card bg-base-100 shadow-xl p-4">
          <h3 class="card-title text-lg mb-4">Live Media</h3>
          <div class="flex flex-col md:flex-row gap-4">
            <div class="relative w-full md:w-1/2 aspect-video bg-black rounded-lg overflow-hidden">
              <video bind:this={localVideoEl} autoplay muted class="w-full h-full object-cover rounded-lg" />
              {#if !localStream}
                <div class="absolute inset-0 flex items-center justify-center bg-gray-900/80 text-white">Waiting for Local Media...</div>
              {/if}
              <span class="badge badge-info absolute top-2 left-2">Local</span>
            </div>

            <div class="relative w-full md:w-1/2 aspect-video bg-black rounded-lg overflow-hidden">
              <video bind:this={remoteVideoEl} autoplay class="w-full h-full object-cover rounded-lg" />
              {#if !remoteStream}
                <div class="absolute inset-0 flex items-center justify-center bg-gray-900/80 text-white">Waiting for Remote Stream...</div>
              {/if}
              <span class="badge badge-success absolute top-2 left-2">Remote</span>
            </div>
          </div>

          <div class="flex justify-center gap-4 mt-4">
            <button class="btn btn-circle" class:btn-success={isAudioOn} class:btn-error={!isAudioOn} onclick={toggleAudio} disabled={!localStream}>
              {#if isAudioOn}
                <Mic class="w-6 h-6" />
              {:else}
                <MicOff class="w-6 h-6" />
              {/if}
            </button>
            <button class="btn btn-circle" class:btn-success={isVideoOn} class:btn-error={!isVideoOn} onclick={toggleVideo} disabled={!localStream}>
              {#if isVideoOn}
                <Video class="w-6 h-6" />
              {:else}
                <VideoOff class="w-6 h-6" />
              {/if}
            </button>
          </div>
        </div>
      {/if}

      <div class="collapse collapse-open border border-base-300 bg-base-100 shadow-xl" class:hidden={!isConnecting}>
        <div class="collapse-title text-xl font-medium flex items-center gap-2">
            <Antenna class="w-6 h-6" />
            File Transfer & Chat
        </div>
        <div class="collapse-content">
            {#if dataChannel}
                <div class="flex w-full mb-4 mt-2 justify-center">
                    <div class="join w-full">
                        <button
                          class="btn btn-dash btn-warning join-item w-1/2 text-xl py-4 min-h-[3.5rem] inline-flex items-center justify-center gap-x-2"
                          onclick={() => {
                            sendMode = true;
                          }}
                          class:btn-active={sendMode}
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
                            class:btn-active={!sendMode}
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
        </div>
      </div>
    </div>
  </div>
</div>