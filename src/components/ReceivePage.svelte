<script lang="ts">
  import { defaultSendOptions, waitIceCandidatesTimeout } from '../configs';
  import { addToastMessage } from '../stores/toastStore';
  import { Message } from '../proto/message';
  import ScanQrModal from '../components/qr/ScanQrModal.svelte';
  import Collapse from '../components/layout/Collapse.svelte';
  import Eye from '../components/icons/Eye.svelte';
 
  // Manually added Eye import
  import {
    Antenna,
    Copy,
    Minimize2,
    Send,
    HeartHandshake,
    Key,
    Video,
    Mic,
    VideoOff,
    MicOff,
    QrCode,
    ArrowRight,
    RotateCw,
    CircleArrowOutUpLeft,
    Maximize2,
    X
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
  

  let isMinimized = $state(true);


  let localStream: MediaStream | undefined = $state(undefined);
  let remoteStream: MediaStream | undefined = $state(undefined);
  let isVideoOn = $state(false);
  let isAudioOn = $state(false);
  
  let currentCamera: 'user' | 'environment' = $state('user'); // 'user' is front, 'environment' is back
  let isFullscreen = $state(false);
  let isRemoteAudioActivity = $state(false);
  // For audio animation

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
      const stream = await navigator.mediaDevices.getUserMedia({
              video: { facingMode: currentCamera }, // Use currentCamera state
              audio: true
            });
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

  function toggleFullScreen() {
      if (remoteVideoEl) {
        if (!document.fullscreenElement) {
          remoteVideoEl.requestFullscreen().catch(err => {
            console.error(`Error attempting to enable full-screen mode: ${err.message} (${err.name})`);
            addToastMessage('Failed to enter fullscreen', 'error');
          });
          isFullscreen = true;
        } else {
          document.exitFullscreen();
          isFullscreen = false;
        }
      }
    }
  
    function toggleMinimize() {
      isMinimized = !isMinimized;
      if (isFullscreen && isMinimized) {
        document.exitFullscreen();
        isFullscreen = false;
      }
    }
    
    async function switchCamera() {
      currentCamera = currentCamera === 'user' ? 'environment' : 'user';
      addToastMessage(`Switching to ${currentCamera === 'user' ? 'Front' : 'Back'} Camera...`, 'info');
      // Stop current tracks
      if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = undefined;
      }
  
      // Restart media with new constraint
      const newStream = await startLocalMedia();
      // Replace tracks in the peer connection
      if (connection && newStream) {
        // Find current video sender and replace track
        const videoTrack = newStream.getVideoTracks()[0];
        if (videoTrack) {
          const sender = connection.getSenders().find(s => s.track?.kind === 'video');
          if (sender) {
            await sender.replaceTrack(videoTrack);
            console.log('✅ Video track replaced with new camera');
          } else {
            // If sender not found (e.g., first setup), add the track
            connection.addTrack(videoTrack, newStream);
          }
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
            connection.ontrack = (event) => 
            {
       
              console.log('Received remote track:', event.track.kind);
              if (!remoteStream && event.streams && event.streams[0]) {
                remoteStream = event.streams[0];
              }

              // NEW: Audio Activity Check
              if (event.track.kind === 'audio' && remoteStream) {
                const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
                const mediaStreamSource = audioContext.createMediaStreamSource(remoteStream);
                const analyser = audioContext.createAnalyser();
                analyser.fftSize = 256;
                mediaStreamSource.connect(analyser);

                const dataArray = new Uint8Array(analyser.frequencyBinCount);
                const checkAudio = () => {
                  analyser.getByteFrequencyData(dataArray);
                  const average = dataArray.reduce((acc, val) => acc + val, 0) / dataArray.length;
                  // Trigger audio activity if average volume is above a threshold (e.g., 5)
                  isRemoteAudioActivity = average > 5;
                  requestAnimationFrame(checkAudio);
                };
                checkAudio();
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
       } else if ((e.ctrlKey 
          || e.metaKey) && e.key.toLowerCase() === 
          'v') {
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
        
          <svg 
            xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="stroke-current shrink-0 w-6 h-6">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
          </svg>
          <span>Waiting for sender to generate offer with this PIN...</span>
        </div>
      {/if}
    </div>
  </Collapse>

 
  <Collapse title="2.
  Transfer Files" isOpen={isConnecting}>
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
              style="top: 0;
                right: 10%; left: 70%; z-index: 10;"
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
  
      
      {#if isConnecting}
        <div 
          class="video-call-container {isMinimized ? 'minimized' : 'fullscreen'}"
          style="display: {isConnecting ? 'block' : 'none'};"
        >
          {#if !isMinimized}
            <!-- Full Screen Mode -->
            <div class="absolute inset-0 z-50 bg-[#0b141a]">
              <!-- Remote Video (Full Screen Background) -->
              <div class="absolute inset-0">
                <video
                  bind:this={remoteVideoEl}
                  autoplay
                  class="w-full h-full object-cover"
                />
                {#if !remoteStream}
                  <div class="absolute inset-0 flex flex-col items-center justify-center bg-gradient-to-b from-[#0b141a] to-[#1f2c34] text-white">
                    <div class="w-32 h-32 rounded-full bg-[#25d366]/20 flex items-center justify-center mb-6">
                      <div class="w-24 h-24 rounded-full bg-[#25d366]/30 flex items-center justify-center">
                        <Video class="w-12 h-12 text-[#25d366]" />
                      </div>
                    </div>
                    <p class="text-xl font-medium">Connecting...</p>
                    <p class="text-sm text-gray-400 mt-2">Waiting for remote stream</p>
                  </div>
                {/if}
              </div>
    
              <!-- Top Bar -->
              <div class="absolute top-0 left-0 right-0 bg-gradient-to-b from-black/70 to-transparent p-4 z-10">
                <div class="flex items-center justify-between">
                  <div class="flex items-center gap-3">
                    <div class="w-10 h-10 rounded-full bg-gray-600 flex items-center justify-center">
                      <span class="text-white text-sm font-semibold">P</span>
                    </div>
                    <div>
                      <p class="text-white font-semibold text-sm">Peer User</p>
                      <p class="text-gray-300 text-xs">
                        {#if isRemoteAudioActivity}
                          Speaking...
                        {:else}
                          Connected
                        {/if}
                      </p>
                    </div>
                  </div>
                  <div class="flex gap-2">
                    <button
                      onclick={toggleMinimize}
                      class="p-2 rounded-full hover:bg-white/10 transition-colors"
                      title="Minimize"
                    >
                      <Minimize2 class="w-5 h-5 text-white" />
                    </button>
                    
                  </div>
                </div>
              </div>
    
              <!-- Local Video (Floating Picture-in-Picture) -->
              <div class="absolute top-20 right-4 w-28 h-40 rounded-2xl overflow-hidden shadow-2xl border-2 border-white/20 z-20">
                <video
                  bind:this={localVideoEl}
                  autoplay
                  muted
                  class="w-full h-full object-cover"
                />
                {#if !localStream}
                  <div class="absolute inset-0 flex items-center justify-center bg-[#1f2c34]">
                    <VideoOff class="w-8 h-8 text-gray-500" />
                  </div>
                {/if}
                {#if !isVideoOn && localStream}
                  <div class="absolute inset-0 flex items-center justify-center bg-[#1f2c34]">
                    <div class="w-12 h-12 rounded-full bg-gray-600 flex items-center justify-center">
                      <span class="text-white text-lg font-semibold">You</span>
                    </div>
                  </div>
                {/if}
              </div>
    
              <!-- Audio Activity Indicator -->
              {#if isRemoteAudioActivity}
                <div class="absolute top-4 left-1/2 transform -translate-x-1/2 z-10">
                  <div class="flex items-center gap-2 bg-[#25d366]/90 px-4 py-2 rounded-full">
                    <div class="flex gap-1">
                      <div class="w-1 h-4 bg-white rounded-full animate-pulse" style="animation-delay: 0ms;"></div>
                      <div class="w-1 h-4 bg-white rounded-full animate-pulse" style="animation-delay: 150ms;"></div>
                      <div class="w-1 h-4 bg-white rounded-full animate-pulse" style="animation-delay: 300ms;"></div>
                    </div>
                    <span class="text-white text-xs font-medium">Speaking</span>
                  </div>
                </div>
              {/if}
    
              <!-- Bottom Controls (WhatsApp Style) -->
              <div class="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent p-6 z-10">
                <div class="flex items-center justify-center gap-6">
                  <!-- Audio Toggle -->
                  <button
                    onclick={toggleAudio}
                    disabled={!localStream}
                    class="w-14 h-14 rounded-full flex items-center justify-center transition-all {isAudioOn
                      ? 'bg-[#233138] hover:bg-[#2a3942]'
                      : 'bg-[#f15c6d] hover:bg-[#d93d51]'} disabled:opacity-50 disabled:cursor-not-allowed"
                    title={isAudioOn ? 'Mute' : 'Unmute'}
                  >
                    {#if isAudioOn}
                      <Mic class="w-6 h-6 text-white" />
                    {:else}
                      <MicOff class="w-6 h-6 text-white" />
                    {/if}
                  </button>
    
                  <!-- Video Toggle -->
                  <button
                    onclick={toggleVideo}
                    disabled={!localStream}
                    class="w-14 h-14 rounded-full flex items-center justify-center transition-all {isVideoOn
                      ? 'bg-[#233138] hover:bg-[#2a3942]'
                      : 'bg-[#f15c6d] hover:bg-[#d93d51]'} disabled:opacity-50 disabled:cursor-not-allowed"
                    title={isVideoOn ? 'Turn off camera' : 'Turn on camera'}
                  >
                    {#if isVideoOn}
                      <Video class="w-6 h-6 text-white" />
                    {:else}
                      <VideoOff class="w-6 h-6 text-white" />
                    {/if}
                  </button>
    
                  <!-- End Call (Not functional - just for UI) -->
                  <button
                    class="w-16 h-16 rounded-full bg-[#f15c6d] hover:bg-[#d93d51] flex items-center justify-center transition-all shadow-lg"
                    title="End call"
                  >
                    <X class="w-8 h-8 text-white" />
                  </button>
    
                  <!-- Switch Camera -->
                  <button
                    onclick={switchCamera}
                    disabled={!localStream}
                    class="w-14 h-14 rounded-full bg-[#233138] hover:bg-[#2a3942] flex items-center justify-center transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                    title="Switch camera"
                  >
                    <RotateCw class="w-6 h-6 text-white" />
                  </button>
                </div>
              </div>
            </div>
          {:else}
            <!-- Minimized Mode (Small Floating Widget) -->
            <div class="fixed bottom-4 right-4 z-50 w-80 bg-[#0b141a] rounded-2xl shadow-2xl overflow-hidden border-2 border-[#25d366]/30">
              <!-- Minimized Header -->
              <div class="bg-[#1f2c34] p-3 flex items-center justify-between cursor-move">
                <div class="flex items-center gap-2">
                  <div class="w-8 h-8 rounded-full bg-[#25d366]/30 flex items-center justify-center">
                    <Video class="w-4 h-4 text-[#25d366]" />
                  </div>
                  <div>
                    <p class="text-white text-sm font-semibold">Peer User</p>
                    <p class="text-gray-400 text-xs">
                      {#if isRemoteAudioActivity}
                        <span class="inline-flex items-center gap-1">
                          <span class="w-2 h-2 bg-[#25d366] rounded-full animate-pulse"></span>
                          Speaking
                        </span>
                      {:else}
                        Connected
                      {/if}
                    </p>
                  </div>
                </div>
                <button
                  onclick={toggleMinimize}
                  class="p-1.5 rounded-lg hover:bg-white/10 transition-colors"
                  title="Maximize"
                >
                  <Maximize2 class="w-4 h-4 text-white" />
                </button>
              </div>
    
              <!-- Minimized Video -->
              <div class="relative aspect-video bg-black">
                <video
                  bind:this={remoteVideoEl}
                  autoplay
                  class="w-full h-full object-cover"
                />
                {#if !remoteStream}
                  <div class="absolute inset-0 flex items-center justify-center bg-[#1f2c34]">
                    <div class="w-16 h-16 rounded-full bg-[#25d366]/20 flex items-center justify-center">
                      <Video class="w-8 h-8 text-[#25d366]/50" />
                    </div>
                  </div>
                {/if}
    
                <!-- Small Local Video in Corner -->
                <div class="absolute bottom-2 right-2 w-20 h-28 rounded-lg overflow-hidden border border-white/30">
                  <video
                    bind:this={localVideoEl}
                    autoplay
                    muted
                    class="w-full h-full object-cover"
                  />
                  {#if !isVideoOn && localStream}
                    <div class="absolute inset-0 flex items-center justify-center bg-[#1f2c34]">
                      <div class="w-8 h-8 rounded-full bg-gray-600 flex items-center justify-center">
                        <span class="text-white text-xs font-semibold">You</span>
                      </div>
                    </div>
                  {/if}
                </div>
              </div>
    
              <!-- Minimized Controls -->
              <div class="bg-[#0b141a] p-3 flex items-center justify-center gap-3">
                <button
                  onclick={toggleAudio}
                  disabled={!localStream}
                  class="w-10 h-10 rounded-full flex items-center justify-center transition-all {isAudioOn
                    ? 'bg-[#233138] hover:bg-[#2a3942]'
                    : 'bg-[#f15c6d] hover:bg-[#d93d51]'} disabled:opacity-50"
                  title={isAudioOn ? 'Mute' : 'Unmute'}
                >
                  {#if isAudioOn}
                    <Mic class="w-4 h-4 text-white" />
                  {:else}
                    <MicOff class="w-4 h-4 text-white" />
                  {/if}
                </button>
    
                <button
                  onclick={toggleVideo}
                  disabled={!localStream}
                  class="w-10 h-10 rounded-full flex items-center justify-center transition-all {isVideoOn
                    ? 'bg-[#233138] hover:bg-[#2a3942]'
                    : 'bg-[#f15c6d] hover:bg-[#d93d51]'} disabled:opacity-50"
                  title={isVideoOn ? 'Turn off camera' : 'Turn on camera'}
                >
                  {#if isVideoOn}
                    <Video class="w-4 h-4 text-white" />
                  {:else}
                    <VideoOff class="w-4 h-4 text-white" />
                  {/if}
                </button>
    
                <button
                  onclick={switchCamera}
                  disabled={!localStream}
                  class="w-10 h-10 rounded-full bg-[#233138] hover:bg-[#2a3942] flex items-center justify-center transition-all disabled:opacity-50"
                  title="Switch camera"
                >
                  <RotateCw class="w-4 h-4 text-white" />
                </button>
              </div>
            </div>
          {/if}
        </div>
      {/if}
</div>


<style>
  @keyframes pulse {
    0%, 100% {
      opacity: 0.4;
      transform: scaleY(0.8);
    }
    50% {
      opacity: 1;
      transform: scaleY(1.2);
    }
  }
  
  .animate-pulse {
    animation: pulse 1s cubic-bezier(0.4, 0, 0.6, 1) infinite;
  }

  .video-call-container {
    transition: all 0.3s ease-in-out;
  }

  .video-call-container.fullscreen {
    position: fixed;
    inset: 0;
    z-index: 9999;
  }

  .video-call-container.minimized {
    position: relative;
  }
</style>
