<script lang="ts">
  import { addToastMessage } from '../stores/toastStore';
  import { defaultSendOptions, waitIceCandidatesTimeout } from '../configs';
  import Eye from '../components/icons/Eye.svelte';
  import { Message } from '../proto/message';
  import Collapse from '../components/layout/Collapse.svelte';
  import OfferOptions from '../components/OfferOptions.svelte';
  import {
    Cog,
    ChevronsLeftRightEllipsis,
    Clipboard,
    Send,
    HeartHandshake,
    Key,
    Video,
    Mic,
    VideoOff,
    MicOff,
    X,
    Maximize2,
    Minimize2,
    RotateCw
  } from '@lucide/svelte';
  import { onMount, onDestroy } from 'svelte';
  import SignalingService from '../utils/signaling';
  import {
    exportRsaPublicKeyToBase64,
    generateRsaKeyPair,
    importRsaPublicKeyFromBase64
  } from '../utils/crypto';
  import type { SendOptions } from '../type';
  import Sender from '../components/sender/Sender.svelte';
  import Receiver from '../components/receiver/Receiver.svelte';
  import Toast from '../components/Toast.svelte';

  let signalingService = SignalingService.getInstance();

  let sendOptions = $state(defaultSendOptions);
  let rsa: CryptoKeyPair | undefined = $state(undefined);
  let rsaPub: CryptoKey | undefined = $state(undefined);

  let connectionPIN = $state('');
  let showPIN = $state(false);

  let connection: RTCPeerConnection | undefined = $state(undefined);
  let dataChannel: RTCDataChannel | undefined = $state(undefined);
  let isConnecting = $state(false);
  let generating = $state(false);

  let receiver: Receiver | undefined = $state(undefined);
  let sender: Sender | undefined = $state(undefined);
  let sendMode = $state(true);
  let showNewFile = $state(false);
  let showOfferOptions = $state(false);

  let cleanupListener: (() => void) | undefined = $state(undefined);
  
  let localStream: MediaStream | undefined = $state(undefined);
  let remoteStream: MediaStream | undefined = $state(undefined);
  
  let currentCamera: 'user' | 'environment' = $state('user');
  let isFullscreen = $state(false);
  let isMinimized = $state(true);
  let isRemoteAudioActivity = $state(false);
    
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
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: currentCamera },
        audio: true
      });
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

  function toggleFullScreen() {
    if (isMinimized) {
      isMinimized = true;
      return;
    }
    
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
    
    if (localStream) {
      localStream.getTracks().forEach(track => track.stop());
      localStream = undefined;
    }

    const newStream = await startLocalMedia();
    
    if (connection && newStream) {
      const videoTrack = newStream.getVideoTracks()[0];
      if (videoTrack) {
        const sender = connection.getSenders().find(s => s.track?.kind === 'video');
        if (sender) {
          await sender.replaceTrack(videoTrack);
          console.log('✅ Video track replaced with new camera');
        } else {
          connection.addTrack(videoTrack, newStream);
        }
      }
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

  async function createPeerAndDataChannel() {
    console.log('🔧 Creating peer connection and data channel...');
    const stream = await startLocalMedia();
    connection = new RTCPeerConnection({
      iceServers: [{ urls: sendOptions.iceServer }],
      bundlePolicy: 'balanced',
      iceCandidatePoolSize: 4
    });
    connection.onicecandidateerror = (err) => {
      console.error('❌ ICE Candidate error:', err);
      addToastMessage('ICE Candidate error', 'error');
    };
    
    if (stream) {
      stream.getTracks().forEach(track => connection!.addTrack(track, stream));
      console.log('✅ Local tracks added to peer connection');
    }

    connection.ontrack = (event) => {
      console.log('📊 Received remote track:', event.track.kind);
      if (!remoteStream && event.streams && event.streams[0]) {
        remoteStream = event.streams[0];
      }
      
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
          isRemoteAudioActivity = average > 5;
          requestAnimationFrame(checkAudio);
        };
        checkAudio();
      }
    };

    dataChannel = connection.createDataChannel('data', {
      ordered: false
    });
    dataChannel.onopen = () => {
      console.log('✅ Data channel opened!');
      addToastMessage('Connected successfully!', 'success');
      isConnecting = true;
      generating = false;
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

    dataChannel.onerror = (err) => {
      console.error('❌ Data channel error:', err);
      addToastMessage('Connection error', 'error');
      isConnecting = false;
      connectionPIN = '';
    };
    dataChannel.onclose = () => {
      console.log('🔌 Data channel closed');
      addToastMessage('Disconnected', 'error');
      isConnecting = false;
      connectionPIN = '';
      if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = undefined;
      }
      remoteStream = undefined;
    };

    console.log('✅ Peer connection and data channel created');
  }

  async function generateConnectionPIN() {
    console.log('🚀 Starting PIN generation...');
    generating = true;
    try {
      await createPeerAndDataChannel();

      if (!connection) {
        throw new Error('Failed to create connection');
      }

      connectionPIN = signalingService.generatePIN();
      console.log('🔑 PIN generated:', connectionPIN);

      let publicKeyBase64 = '';
      if (sendOptions.isEncrypt) {
        console.log('🔐 Generating encryption keys...');
        rsa = await generateRsaKeyPair();
        publicKeyBase64 = await exportRsaPublicKeyToBase64(rsa.publicKey);
      }

      console.log('👂 Setting up answer listener for PIN:', connectionPIN);
      cleanupListener = signalingService.listenForAnswer(connectionPIN, async (answer) => {
        console.log('📨 Received answer for PIN:', connectionPIN);

        try {
          if (sendOptions.isEncrypt && answer.publicKey) {
            console.log('🔐 Importing receiver public key...');
            rsaPub = await importRsaPublicKeyFromBase64(answer.publicKey);
          }

          const remoteDesc: RTCSessionDescriptionInit = {
            type: 'answer',
            sdp: answer.sdp
          };

          console.log('🔗 Setting remote description...');
          await connection!.setRemoteDescription(remoteDesc);
          console.log('✅ Remote description set, connection establishing...');
          addToastMessage('Answer received, connecting...', 'success');
        } catch (error) {
          console.error('❌ Error processing answer:', error);
          addToastMessage('Error processing answer', 'error');
        }
      });
      
      connection.onicecandidate = async (event) => {
        if (!event.candidate && connection!.localDescription) {
          console.log('📤 All ICE candidates gathered, sending offer...');
          await signalingService.sendOffer(connectionPIN, connection!.localDescription.sdp, {
            publicKey: publicKeyBase64,
            iceServer: sendOptions.iceServer !== defaultSendOptions.iceServer ? sendOptions.iceServer : undefined,
            chunkSize: sendOptions.chunkSize !== defaultSendOptions.chunkSize ? sendOptions.chunkSize : undefined
          });
          generating = false;
          addToastMessage('PIN ready! Share with receiver', 'success');
        } else if (event.candidate) {
          console.log('🧊 ICE candidate:', event.candidate.candidate.substring(0, 50) + '...');
        }
      };

      console.log('📝 Creating offer...');
      const offer = await connection.createOffer({
        offerToReceiveVideo: true,
        offerToReceiveAudio: true
      });
      console.log('✏️ Setting local description...');
      await connection.setLocalDescription(offer);
      console.log('✅ Local description set');
      
      setTimeout(async () => {
        if (!connection?.localDescription || !generating) return;

        console.log('⏰ ICE gathering timeout, sending offer anyway...');
        addToastMessage('Sending offer (timeout)...', 'info');

        await signalingService.sendOffer(connectionPIN, connection.localDescription.sdp, {
          publicKey: publicKeyBase64,
          iceServer: sendOptions.iceServer !== defaultSendOptions.iceServer ? sendOptions.iceServer : undefined,
          chunkSize: sendOptions.chunkSize !== defaultSendOptions.chunkSize ? sendOptions.chunkSize : undefined
        });

        generating = false;
      }, waitIceCandidatesTimeout);
    } catch (error) {
      console.error('❌ Error generating offer:', error);
      addToastMessage('Failed to generate offer', 'error');
      generating = false;
    }
  }

  async function copyPIN() {
    try {
      await navigator.clipboard.writeText(connectionPIN);
      addToastMessage('PIN copied!', 'info');
    } catch (error) {
      console.error('Failed to copy:', error);
      addToastMessage('Failed to copy PIN', 'error');
    }
  }

  function onOptionsUpdate(options: SendOptions) {
    sendOptions = options;
  }

  function navigateToAnswerPage() {
    window.location.href = `${window.location.origin}/answer.html`;
  }

  onMount(() => {
    console.log('📄 Offer page mounted');

    const handleShortcut = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key.toLowerCase() == 'o') {
        event.preventDefault();
        generateConnectionPIN();
      } else if (event.ctrlKey && event.key.toLowerCase() == 'c') {
        event.preventDefault();
        copyPIN();
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
    console.log('🧹 Offer page cleanup');
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
  <h1 class="text-2xl font-bold mb-4">File Transfer - Offer Page</h1>

  <Collapse title="1. Generate Connection PIN" isOpen={!connectionPIN}>
    {#if generating}
      <div class="flex flex-col items-center justify-center gap-2">
        <span class="loading loading-spinner loading-lg"></span>
        <div>Generating Connection PIN...</div>
      </div>
    {:else}
      <p class="mb-4">
        Generate a 6-digit PIN to establish a secure connection.
        Share this PIN with your peer.
      </p>
      <div class="mt-4">
        {#if showOfferOptions}
          <OfferOptions onUpdate={onOptionsUpdate} />
        {/if}
        <div class="flex gap-2 flex-wrap">
          <button class="btn btn-soft btn-secondary" onclick={generateConnectionPIN}>
            Generate PIN <Key />
          </button>

          {#if !showOfferOptions}
            <button
              class="btn btn-secondary"
              onclick={() => {
                showOfferOptions = true;
              }}>
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

  <Collapse title="2. Share Connection PIN" isOpen={connectionPIN !== '' && !isConnecting}>
    {#if connectionPIN}
      <p class="mb-4">
        Share this 6-digit PIN with your peer.
        They will need to enter it on the Answer page to connect.
      </p>
      
      <div class="flex justify-center mb-6">
        <div class="stats shadow bg-primary text-primary-content">
          <div class="stat place-items-center">
            <div class="stat-title text-primary-content/70">Connection PIN</div>
            <div class="stat-value text-5xl font-mono tracking-wider">
              {showPIN ? connectionPIN : '••••••'}
            </div>
            <div class="stat-desc text-primary-content/70">Share with receiver</div>
          </div>
        </div>
      </div>

      <div class="flex gap-2 justify-center flex-wrap">
        <button class="btn btn-soft btn-success" onclick={copyPIN}>
          Copy PIN <Clipboard />
        </button>
        <button class="btn btn-ghost" onclick={() => (showPIN = !showPIN)}>
          {showPIN ? 'Hide' : 'Show'} PIN
        </button>
      </div>

      <div class="alert alert-info mt-4">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="stroke-current shrink-0 w-6 h-6">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
        </svg>
        <span>Waiting for receiver to connect with this PIN...</span>
      </div>
    {/if}
  </Collapse>

  <Collapse title="3. Transfer Files" isOpen={isConnecting}>
    {#if dataChannel}
      <div class="flex w-full mb-4 mt-2 justify-center">
        <div class="join w-full">
          <button
            class="btn btn-dash btn-secondary join-item w-1/2 text-xl py-4 min-h-[3.5rem]"
            onclick={() => {
              sendMode = true;
            }}
          >
            <Send />
            <span>Send</span>
          </button>

          <div class="relative w-1/2">
            <span
              class="indicator-item badge badge-success text-xs animate-bounce absolute"
              class:hidden={!showNewFile}
              style="top: -8px; right: 12px; z-index: 10;"
            >
              New files
            </span>
            <button
              class="btn btn-dash btn-warning join-item w-full text-xl py-4 min-h-[3.5rem]"
              onclick={() => {
                showNewFile = false;
                sendMode = false;
              }}
            >
              <HeartHandshake />
              <span>Receive</span>
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
 
  <!-- WhatsApp-Style Video Call UI with Minimize -->
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