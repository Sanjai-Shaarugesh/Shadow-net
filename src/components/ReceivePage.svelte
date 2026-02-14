<script lang="ts">
  import { defaultSendOptions, waitIceCandidatesTimeout } from '../configs';
  import { addToastMessage } from '../stores/toastStore';
  import { Message } from '../proto/message';
  import ScanQrModal from '../components/qr/ScanQrModal.svelte';
  import Collapse from '../components/layout/Collapse.svelte';
  import Eye from '../components/icons/Eye.svelte';
 
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
  let isVideoCallVisible = $state(false);

  let localStream: MediaStream | undefined = $state(undefined);
  let remoteStream: MediaStream | undefined = $state(undefined);
  let isVideoOn = $state(false);
  let isAudioOn = $state(false);
  
  let currentCamera: 'user' | 'environment' = $state('user');
  let isFullscreen = $state(false);
  let isRemoteAudioActivity = $state(false);

  let localVideoEl: HTMLVideoElement | undefined = $state(undefined);
  let remoteVideoEl: HTMLVideoElement | undefined = $state(undefined);

  // Capacitor detection
  let isCapacitor = $state(false);
  let isAndroid = $state(false);

  $effect(() => {
    if (localVideoEl && localStream) {
      localVideoEl.srcObject = localStream;
      localVideoEl.play().catch(err => console.error('Error playing local video:', err));
    }
  });
  
  $effect(() => {
    if (remoteVideoEl && remoteStream) {
      remoteVideoEl.srcObject = remoteStream;
      remoteVideoEl.play().catch(err => console.error('Error playing remote video:', err));
    }
  });
  
  async function startLocalMedia() {
    try {
      // For Capacitor Android, request permissions first
      if (isCapacitor && isAndroid) {
        try {
          // @ts-ignore - Capacitor plugins
          const { Camera } = await import('@capacitor/camera');
          await Camera.requestPermissions();
        } catch (e) {
          console.log('Camera permission request failed:', e);
        }
      }

      const constraints: MediaStreamConstraints = {
        video: {
          facingMode: currentCamera,
          width: { ideal: 1280 },
          height: { ideal: 720 }
        },
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      
      // Disable video and audio by default
      stream.getVideoTracks().forEach(track => track.enabled = false);
      stream.getAudioTracks().forEach(track => track.enabled = false);
      
      localStream = stream;
      isVideoOn = false;
      isAudioOn = false;
      
      addToastMessage('Local media started (video and audio disabled)', 'success');
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
      if (document.fullscreenElement) {
        document.exitFullscreen();
      }
      isFullscreen = false;
    }
    
    // Prevent body scroll when in fullscreen
    if (!isMinimized) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
  }

  function toggleVideoCallVisibility() {
    isVideoCallVisible = !isVideoCallVisible;
    if (!isVideoCallVisible) {
      isMinimized = true;
      if (document.fullscreenElement) {
        document.exitFullscreen();
      }
      isFullscreen = false;
      document.body.style.overflow = '';
    }
  }
    
  async function switchCamera() {
    currentCamera = currentCamera === 'user' ? 'environment' : 'user';
    addToastMessage(`Switching to ${currentCamera === 'user' ? 'Front' : 'Back'} Camera...`, 'info');
    
    if (localStream) {
      localStream.getTracks().forEach(track => track.stop());
      localStream = undefined;
    }

    const newStream = await startLocalMedia();
    
    if (connection && newStream) {
      const videoTrack = newStream.getVideoTracks()[0];
      const audioTrack = newStream.getAudioTracks()[0];
      
      if (videoTrack) {
        const sender = connection.getSenders().find(s => s.track?.kind === 'video');
        if (sender) {
          await sender.replaceTrack(videoTrack);
          console.log('✅ Video track replaced with new camera');
        } else {
          connection.addTrack(videoTrack, newStream);
        }
      }

      if (audioTrack) {
        const sender = connection.getSenders().find(s => s.track?.kind === 'audio');
        if (sender) {
          await sender.replaceTrack(audioTrack);
        } else {
          connection.addTrack(audioTrack, newStream);
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

          if (offer.publicKey) {
            rsaPub = await importRsaPublicKeyFromBase64(offer.publicKey);
            rsa = await generateRsaKeyPair();
          } else {
            rsa = undefined;
            rsaPub = undefined;
          }

          if (stream && connection) {
            stream.getTracks().forEach(track => {
              connection!.addTrack(track, stream);
              console.log(`✅ Added ${track.kind} track to peer connection`);
            });
          }

          if (connection) {
            connection.ontrack = (event) => {
              console.log('Received remote track:', event.track.kind);
              if (event.streams && event.streams[0]) {
                remoteStream = event.streams[0];
                console.log('✅ Remote stream set');
              }

              if (event.track.kind === 'audio' && remoteStream) {
                try {
                  const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
                  const mediaStreamSource = audioContext.createMediaStreamSource(remoteStream);
                  const analyser = audioContext.createAnalyser();
                  analyser.fftSize = 256;
                  mediaStreamSource.connect(analyser);

                  const dataArray = new Uint8Array(analyser.frequencyBinCount);
                  const checkAudio = () => {
                    analyser.getByteFrequencyData(dataArray);
                    const average = dataArray.reduce((acc, val) => acc + val, 0) / dataArray.length;
                    isRemoteAudioActivity = average > 5;
                    requestAnimationFrame(checkAudio);
                  };
                  checkAudio();
                } catch (e) {
                  console.error('Audio analysis error:', e);
                }
              }
            };
          }

          if (connection) {
            connection.ondatachannel = (event) => {
              dataChannel = event.channel;
              dataChannel.onopen = () => {
                addToastMessage('Connected! Click "Show Video Call" to enable camera/mic.', 'success');
                isConnecting = true;
                isProcessing = false;
                // Video call stays hidden until user clicks "Show Video Call" button
                isVideoCallVisible = false;
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
                isVideoCallVisible = false;
              };

              dataChannel.onclose = () => {
                addToastMessage('Disconnected', 'error');
                isConnecting = false;
                isVideoCallVisible = false;
                if (localStream) {
                  localStream.getTracks().forEach(track => track.stop());
                  localStream = undefined;
                }
                remoteStream = undefined;
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
    console.log('📄 Answer page mounted');

    // Detect Capacitor
    isCapacitor = !!(window as any).Capacitor;
    isAndroid = isCapacitor && (window as any).Capacitor?.getPlatform() === 'android';

    console.log('Platform:', { isCapacitor, isAndroid });

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
    console.log('🧹 Answer page cleanup');
    if (cleanupListener) {
      cleanupListener();
    }
    if (localStream) {
      localStream.getTracks().forEach(track => track.stop());
    }
    if (connection) {
      connection.close();
    }
    // Restore body scroll
    document.body.style.overflow = '';
  });
</script>

<div class="container mx-auto p-4 max-w-3xl" class:video-call-active={isConnecting && isVideoCallVisible}>
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

      {#if isConnecting}
        <div class="mt-6 flex justify-center">
          <button 
            class="btn btn-primary btn-lg gap-2 shadow-lg"
            class:animate-pulse={!isVideoCallVisible}
            onclick={toggleVideoCallVisibility}
          >
            <Video class="w-5 h-5" />
            {isVideoCallVisible ? 'Hide Video Call' : 'Show Video Call'}
            {#if !isVideoCallVisible}
              <span class="badge badge-success badge-sm ml-2">Click to Enable</span>
            {/if}
          </button>
        </div>
      {/if}
    {/if}
  </Collapse>

  <Toast />
</div>

<!-- Video Call UI - OUTSIDE main container to prevent overlap -->
{#if isConnecting && isVideoCallVisible}
  <div 
    class="video-call-container {isMinimized ? 'minimized' : 'fullscreen'}"
    style="display: block;"
  >
    {#if !isMinimized}
      <!-- Full Screen Mode -->
      <div class="video-fullscreen-wrapper">
          <!-- Remote Video (Full Screen Background) -->
          <div class="video-remote-container">
            <video
              bind:this={remoteVideoEl}
              autoplay
              playsinline
              class="video-element"
            />
            {#if !remoteStream}
              <div class="video-placeholder">
                <div class="video-placeholder-icon">
                  <div class="video-placeholder-inner">
                    <Video class="w-12 h-12 text-[#25d366]" />
                  </div>
                </div>
                <p class="video-placeholder-text">Connecting...</p>
                <p class="video-placeholder-subtext">Waiting for remote stream</p>
              </div>
            {/if}
          </div>

          <!-- Top Bar -->
          <div class="video-topbar">
            <div class="video-topbar-content">
              <div class="video-topbar-user">
                <div class="video-avatar">
                  <span class="video-avatar-text">P</span>
                </div>
                <div>
                  <p class="video-username">Peer User</p>
                  <p class="video-status">
                    {#if isRemoteAudioActivity}
                      Speaking...
                    {:else}
                      Connected
                    {/if}
                  </p>
                </div>
              </div>
              <div class="video-topbar-actions">
                <button
                  onclick={toggleMinimize}
                  class="video-icon-btn"
                  title="Minimize"
                >
                  <Minimize2 class="w-5 h-5 text-white" />
                </button>
              </div>
            </div>
          </div>

          <!-- Local Video (Floating Picture-in-Picture) -->
          <div class="video-local-pip">
            <video
              bind:this={localVideoEl}
              autoplay
              playsinline
              muted
              class="video-element"
            />
            {#if !localStream}
              <div class="video-local-placeholder">
                <VideoOff class="w-8 h-8 text-gray-500" />
              </div>
            {/if}
            {#if !isVideoOn && localStream}
              <div class="video-local-placeholder">
                <div class="video-local-avatar">
                  <span class="video-local-avatar-text">You</span>
                </div>
              </div>
            {/if}
          </div>

          <!-- Audio Activity Indicator -->
          {#if isRemoteAudioActivity}
            <div class="video-audio-indicator">
              <div class="video-audio-badge">
                <div class="video-audio-bars">
                  <div class="video-audio-bar" style="animation-delay: 0ms;"></div>
                  <div class="video-audio-bar" style="animation-delay: 150ms;"></div>
                  <div class="video-audio-bar" style="animation-delay: 300ms;"></div>
                </div>
                <span class="video-audio-text">Speaking</span>
              </div>
            </div>
          {/if}

          <!-- Bottom Controls -->
          <div class="video-controls">
            <div class="video-controls-inner">
              <!-- Audio Toggle -->
              <button
                onclick={toggleAudio}
                disabled={!localStream}
                class="video-control-btn {isAudioOn ? 'video-control-btn-active' : 'video-control-btn-inactive'}"
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
                class="video-control-btn {isVideoOn ? 'video-control-btn-active' : 'video-control-btn-inactive'}"
                title={isVideoOn ? 'Turn off camera' : 'Turn on camera'}
              >
                {#if isVideoOn}
                  <Video class="w-6 h-6 text-white" />
                {:else}
                  <VideoOff class="w-6 h-6 text-white" />
                {/if}
              </button>

              <!-- End Call -->
              <button
                onclick={toggleVideoCallVisibility}
                class="video-control-btn video-control-btn-end"
                title="Hide video call"
              >
                <X class="w-8 h-8 text-white" />
              </button>

              <!-- Switch Camera -->
              <button
                onclick={switchCamera}
                disabled={!localStream}
                class="video-control-btn video-control-btn-active"
                title="Switch camera"
              >
                <RotateCw class="w-6 h-6 text-white" />
              </button>
            </div>
        </div>
      </div>
    {:else}
      <!-- Minimized Mode -->
      <div class="video-minimized-wrapper">
          <!-- Minimized Header -->
          <div class="video-minimized-header">
            <div class="video-minimized-user">
              <div class="video-minimized-icon">
                <Video class="w-4 h-4 text-[#25d366]" />
              </div>
              <div>
                <p class="video-minimized-username">Peer User</p>
                <p class="video-minimized-status">
                  {#if isRemoteAudioActivity}
                    <span class="video-minimized-speaking">
                      <span class="video-minimized-dot"></span>
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
              class="video-minimized-btn"
              title="Maximize"
            >
              <Maximize2 class="w-4 h-4 text-white" />
            </button>
          </div>

          <!-- Minimized Video -->
          <div class="video-minimized-video">
            <video
              bind:this={remoteVideoEl}
              autoplay
              playsinline
              class="video-element"
            />
            {#if !remoteStream}
              <div class="video-minimized-placeholder">
                <div class="video-minimized-placeholder-icon">
                  <Video class="w-8 h-8 text-[#25d366]/50" />
                </div>
              </div>
            {/if}

            <!-- Small Local Video in Corner -->
            <div class="video-minimized-local">
              <video
                bind:this={localVideoEl}
                autoplay
                playsinline
                muted
                class="video-element"
              />
              {#if !isVideoOn && localStream}
                <div class="video-minimized-local-placeholder">
                  <div class="video-minimized-local-avatar">
                    <span class="video-minimized-local-avatar-text">You</span>
                  </div>
                </div>
              {/if}
            </div>
          </div>

          <!-- Minimized Controls -->
          <div class="video-minimized-controls">
            <button
              onclick={toggleAudio}
              disabled={!localStream}
              class="video-minimized-control {isAudioOn ? 'video-minimized-control-active' : 'video-minimized-control-inactive'}"
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
              class="video-minimized-control {isVideoOn ? 'video-minimized-control-active' : 'video-minimized-control-inactive'}"
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
              class="video-minimized-control video-minimized-control-active"
              title="Switch camera"
            >
              <RotateCw class="w-4 h-4 text-white" />
            </button>

            <button
              onclick={toggleVideoCallVisibility}
              class="video-minimized-control video-minimized-control-inactive"
              title="Hide video call"
            >
              <X class="w-4 h-4 text-white" />
            </button>
        </div>
      </div>
    {/if}
  </div>
{/if}

<style>
  /* Incoming Call Notification */
  .incoming-call-notification {
    position: fixed;
    top: 1rem;
    right: 1rem;
    z-index: 10000;
    background: linear-gradient(135deg, #0b141a 0%, #1f2c34 100%);
    border: 2px solid rgba(37, 211, 102, 0.4);
    border-radius: 1rem;
    padding: 1rem;
    box-shadow: 0 10px 40px rgba(0, 0, 0, 0.3);
    min-width: 280px;
    animation: slideIn 0.3s ease-out;
  }

  @keyframes slideIn {
    from {
      transform: translateX(100%);
      opacity: 0;
    }
    to {
      transform: translateX(0);
      opacity: 1;
    }
  }

  .call-notification-content {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 1rem;
  }

  .call-icon-wrapper {
    width: 3rem;
    height: 3rem;
    border-radius: 50%;
    background: rgba(37, 211, 102, 0.2);
    display: flex;
    align-items: center;
    justify-content: center;
    animation: pulse-ring 1.5s ease-out infinite;
  }

  @keyframes pulse-ring {
    0% {
      box-shadow: 0 0 0 0 rgba(37, 211, 102, 0.7);
    }
    50% {
      box-shadow: 0 0 0 10px rgba(37, 211, 102, 0);
    }
    100% {
      box-shadow: 0 0 0 0 rgba(37, 211, 102, 0);
    }
  }

  .call-icon {
    width: 1.5rem;
    height: 1.5rem;
    color: #25d366;
  }

  .call-info {
    flex: 1;
  }

  .caller-name {
    color: white;
    font-size: 1rem;
    font-weight: 600;
    margin: 0;
  }

  .call-type {
    color: rgb(156, 163, 175);
    font-size: 0.875rem;
    margin: 0;
  }

  .call-actions {
    display: flex;
    gap: 0.75rem;
    justify-content: flex-end;
  }

  .call-btn {
    width: 3rem;
    height: 3rem;
    border-radius: 50%;
    border: none;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s;
    box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
  }

  .call-btn:active {
    transform: scale(0.95);
  }

  .call-btn-decline {
    background: #f15c6d;
    color: white;
  }

  .call-btn-decline:hover {
    background: #d93d51;
  }

  .call-btn-accept {
    background: #25d366;
    color: white;
  }

  .call-btn-accept:hover {
    background: #1fb855;
  }

  @media (max-width: 640px) {
    .incoming-call-notification {
      top: auto;
      bottom: 1rem;
      right: 1rem;
      left: 1rem;
      min-width: auto;
    }
  }

  /* Remove padding when video call is active - video is now outside container */
  .video-call-active {
    margin-bottom: 0;
  }

  /* Ensure content doesn't get hidden under video */
  @media (max-width: 768px) {
    .video-call-active {
      margin-bottom: 0;
    }
  }

  /* Video element */
  .video-element {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  /* Full screen mode */
  .video-fullscreen-wrapper {
    position: fixed;
    inset: 0;
    z-index: 9999;
    background: #0b141a;
  }

  .video-remote-container {
    position: absolute;
    inset: 0;
  }

  .video-placeholder {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    background: linear-gradient(to bottom, #0b141a, #1f2c34);
    color: white;
  }

  .video-placeholder-icon {
    width: 8rem;
    height: 8rem;
    border-radius: 50%;
    background: rgba(37, 211, 102, 0.2);
    display: flex;
    align-items: center;
    justify-content: center;
    margin-bottom: 1.5rem;
  }

  .video-placeholder-inner {
    width: 6rem;
    height: 6rem;
    border-radius: 50%;
    background: rgba(37, 211, 102, 0.3);
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .video-placeholder-text {
    font-size: 1.25rem;
    font-weight: 500;
  }

  .video-placeholder-subtext {
    font-size: 0.875rem;
    color: rgb(156, 163, 175);
    margin-top: 0.5rem;
  }

  /* Top bar */
  .video-topbar {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    background: linear-gradient(to bottom, rgba(0, 0, 0, 0.7), transparent);
    padding: 1rem;
    z-index: 10;
  }

  .video-topbar-content {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .video-topbar-user {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .video-avatar {
    width: 2.5rem;
    height: 2.5rem;
    border-radius: 50%;
    background: rgb(75, 85, 99);
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .video-avatar-text {
    color: white;
    font-size: 0.875rem;
    font-weight: 600;
  }

  .video-username {
    color: white;
    font-weight: 600;
    font-size: 0.875rem;
  }

  .video-status {
    color: rgb(209, 213, 219);
    font-size: 0.75rem;
  }

  .video-topbar-actions {
    display: flex;
    gap: 0.5rem;
  }

  .video-icon-btn {
    padding: 0.5rem;
    border-radius: 50%;
    background: transparent;
    transition: background 0.2s;
    border: none;
    cursor: pointer;
  }

  .video-icon-btn:hover {
    background: rgba(255, 255, 255, 0.1);
  }

  /* Local PiP */
  .video-local-pip {
    position: absolute;
    top: 5rem;
    right: 1rem;
    width: 7rem;
    height: 10rem;
    border-radius: 1rem;
    overflow: hidden;
    box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
    border: 2px solid rgba(255, 255, 255, 0.2);
    z-index: 20;
  }

  .video-local-placeholder {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #1f2c34;
  }

  .video-local-avatar {
    width: 3rem;
    height: 3rem;
    border-radius: 50%;
    background: rgb(75, 85, 99);
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .video-local-avatar-text {
    color: white;
    font-size: 1.125rem;
    font-weight: 600;
  }

  /* Audio indicator */
  .video-audio-indicator {
    position: absolute;
    top: 1rem;
    left: 50%;
    transform: translateX(-50%);
    z-index: 10;
  }

  .video-audio-badge {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    background: rgba(37, 211, 102, 0.9);
    padding: 0.5rem 1rem;
    border-radius: 9999px;
  }

  .video-audio-bars {
    display: flex;
    gap: 0.25rem;
  }

  .video-audio-bar {
    width: 0.25rem;
    height: 1rem;
    background: white;
    border-radius: 9999px;
    animation: pulse 1s cubic-bezier(0.4, 0, 0.6, 1) infinite;
  }

  .video-audio-text {
    color: white;
    font-size: 0.75rem;
    font-weight: 500;
  }

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

  /* Bottom controls */
  .video-controls {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    background: linear-gradient(to top, rgba(0, 0, 0, 0.7), transparent);
    padding: 1.5rem;
    z-index: 10;
  }

  .video-controls-inner {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 1.5rem;
  }

  .video-control-btn {
    width: 3.5rem;
    height: 3.5rem;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s;
    border: none;
    cursor: pointer;
  }

  .video-control-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .video-control-btn-active {
    background: #233138;
  }

  .video-control-btn-active:hover:not(:disabled) {
    background: #2a3942;
  }

  .video-control-btn-inactive {
    background: #f15c6d;
  }

  .video-control-btn-inactive:hover:not(:disabled) {
    background: #d93d51;
  }

  .video-control-btn-end {
    width: 4rem;
    height: 4rem;
    background: #f15c6d;
    box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1);
  }

  .video-control-btn-end:hover {
    background: #d93d51;
  }

  /* Minimized mode */
  .video-minimized-wrapper {
    position: fixed;
    bottom: 5rem;
    right: 1rem;
    z-index: 9999;
    width: 20rem;
    max-width: calc(100vw - 2rem);
    background: #0b141a;
    border-radius: 1rem;
    box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
    overflow: hidden;
    border: 2px solid rgba(37, 211, 102, 0.3);
  }

  @media (max-width: 640px) {
    .video-minimized-wrapper {
      width: calc(100vw - 2rem);
      max-width: 24rem;
      right: 1rem;
      left: 1rem;
      margin: 0 auto;
      bottom: 6rem;
    }
  }

  .video-minimized-header {
    background: #1f2c34;
    padding: 0.75rem;
    display: flex;
    align-items: center;
    justify-content: space-between;
    cursor: move;
  }

  .video-minimized-user {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .video-minimized-icon {
    width: 2rem;
    height: 2rem;
    border-radius: 50%;
    background: rgba(37, 211, 102, 0.3);
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .video-minimized-username {
    color: white;
    font-size: 0.875rem;
    font-weight: 600;
  }

  .video-minimized-status {
    color: rgb(156, 163, 175);
    font-size: 0.75rem;
  }

  .video-minimized-speaking {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
  }

  .video-minimized-dot {
    width: 0.5rem;
    height: 0.5rem;
    background: #25d366;
    border-radius: 50%;
    animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
  }

  .video-minimized-btn {
    padding: 0.375rem;
    border-radius: 0.5rem;
    background: transparent;
    transition: background 0.2s;
    border: none;
    cursor: pointer;
  }

  .video-minimized-btn:hover {
    background: rgba(255, 255, 255, 0.1);
  }

  .video-minimized-video {
    position: relative;
    aspect-ratio: 16 / 9;
    background: black;
  }

  .video-minimized-placeholder {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #1f2c34;
  }

  .video-minimized-placeholder-icon {
    width: 4rem;
    height: 4rem;
    border-radius: 50%;
    background: rgba(37, 211, 102, 0.2);
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .video-minimized-local {
    position: absolute;
    bottom: 0.5rem;
    right: 0.5rem;
    width: 5rem;
    height: 7rem;
    border-radius: 0.5rem;
    overflow: hidden;
    border: 1px solid rgba(255, 255, 255, 0.3);
  }

  .video-minimized-local-placeholder {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #1f2c34;
  }

  .video-minimized-local-avatar {
    width: 2rem;
    height: 2rem;
    border-radius: 50%;
    background: rgb(75, 85, 99);
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .video-minimized-local-avatar-text {
    color: white;
    font-size: 0.75rem;
    font-weight: 600;
  }

  .video-minimized-controls {
    background: #0b141a;
    padding: 0.75rem;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.75rem;
  }

  .video-minimized-control {
    width: 2.5rem;
    height: 2.5rem;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s;
    border: none;
    cursor: pointer;
  }

  .video-minimized-control:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .video-minimized-control-active {
    background: #233138;
  }

  .video-minimized-control-active:hover:not(:disabled) {
    background: #2a3942;
  }

  .video-minimized-control-inactive {
    background: #f15c6d;
  }

  .video-minimized-control-inactive:hover:not(:disabled) {
    background: #d93d51;
  }

  /* Animation */
  .video-call-container {
    transition: all 0.3s ease-in-out;
  }

  /* Safe area for mobile devices */
  @supports (padding: max(0px)) {
    .video-minimized-wrapper {
      bottom: max(6rem, calc(env(safe-area-inset-bottom) + 5rem));
      right: max(1rem, env(safe-area-inset-right));
    }

    @media (max-width: 640px) {
      .video-minimized-wrapper {
        left: max(1rem, env(safe-area-inset-left));
        right: max(1rem, env(safe-area-inset-right));
        bottom: max(6rem, calc(env(safe-area-inset-bottom) + 5rem));
      }
    }

    .video-controls {
      padding-bottom: max(1.5rem, calc(env(safe-area-inset-bottom) + 1rem));
    }
  }
</style>