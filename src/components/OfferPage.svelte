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
    // NEW Media Icons
    Video,
    Mic,
    VideoOff,
    MicOff
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

  // --- START VIDEO/VOICE CALL STATE AND FUNCTIONS ---
  let localStream: MediaStream | undefined = $state(undefined);
  let remoteStream: MediaStream | undefined = $state(undefined);
  let isVideoOn = $state(false);
  let isAudioOn = $state(false);

  // Video element references for manual srcObject assignment
  let localVideoEl: HTMLVideoElement | undefined = $state(undefined);
  let remoteVideoEl: HTMLVideoElement | undefined = $state(undefined);

  // Correctly set srcObject whenever localStream or remoteStream changes
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


  async function createPeerAndDataChannel() {
    console.log('🔧 Creating peer connection and data channel...');
    // NEW: Request and prepare local media stream
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

    // NEW: Add local tracks to peer connection
    if (stream) {
      stream.getTracks().forEach(track => connection!.addTrack(track, stream));
      console.log('✅ Local tracks added to peer connection');
    }

    // NEW: Handle remote tracks
    connection.ontrack = (event) => {
      console.log('🔊 Received remote track:', event.track.kind);
      // Ensure only one remote stream is set
      if (!remoteStream && event.streams && event.streams[0]) {
        remoteStream = event.streams[0];
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
      // Optional: stop media on disconnect
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

      // Set up answer listener BEFORE creating offer
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

      // Create and send offer
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

      console.log('🔨 Creating offer...');
      const offer = await connection.createOffer({
        // MODIFIED: Request video/audio reception for media stream
        offerToReceiveVideo: true,
        offerToReceiveAudio: true
      });

      console.log('✍️ Setting local description...');
      await connection.setLocalDescription(offer);
      console.log('✅ Local description set');

      // Timeout for ICE gathering
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
    // NEW: Stop local media tracks
    if (localStream) {
      localStream.getTracks().forEach(track => track.stop());
    }
    // NEW: Close peer connection
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
          <h2 class="card-title text-2xl mb-4 text-primary">
            <Cog class="w-6 h-6 mr-2" />
            Connection Setup (Offer)
          </h2>

          {#if !isConnecting}
            <button
              class="btn btn-primary btn-lg w-full"
              onclick={generateConnectionPIN}
              disabled={generating || connectionPIN.length === 6}
            >
              {#if generating}
                <span class="loading loading-spinner"></span>
                Generating Offer...
              {:else}
                <Key class="w-6 h-6" />
                Generate Connection PIN
              {/if}
            </button>
            
            <button class="btn btn-dash btn-warning w-full mt-2" onclick={navigateToAnswerPage}>
              Go to Answer Page <ChevronsLeftRightEllipsis />
            </button>
          {/if}

          {#if connectionPIN}
            <div class="form-control mt-4">
              <label class="label">
                <span class="label-text font-semibold">Share this PIN:</span>
              </label>
              <div class="input-group">
                <input
                  type={showPIN ? 'text' : 'password'}
                  class="input input-bordered input-lg w-full font-mono text-center text-xl"
                  value={connectionPIN}
                  readonly
                />
                <button class="btn btn-square btn-lg" onclick={copyPIN}>
                  <Clipboard class="w-6 h-6" />
                </button>
                <button class="btn btn-square btn-lg" onclick={() => (showPIN = !showPIN)}>
                  <Eye class="w-6 h-6" />
                </button>
              </div>
            </div>

            {#if !isConnecting}
              <div class="alert alert-info mt-4">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="stroke-current shrink-0 w-6 h-6">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
                </svg>
                <span>Waiting for receiver to connect with this PIN...</span>
              </div>
            {/if}
          {/if}

          <Collapse title="Offer Options" bind:show={showOfferOptions} icon={Cog} class="mt-4">
            <OfferOptions onUpdate={onOptionsUpdate} />
          </Collapse>
        </div>
      </div>
    </div>

    <div class="lg:w-2/3 space-y-4">
      <Toast />

      {#if isConnecting}
        <div class="card bg-base-100 shadow-xl mb-4 p-4">
          <h3 class="card-title text-lg">Live Media</h3>
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
          <HeartHandshake class="w-6 h-6" />
          File Transfer & Chat
        </div>
        <div class="collapse-content">
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
        </div>
      </div>
    </div>
  </div>
</div>