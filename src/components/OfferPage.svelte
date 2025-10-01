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
    Key
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

  async function createPeerAndDataChannel() {
    console.log('🔧 Creating peer connection and data channel...');
    connection = new RTCPeerConnection({
      iceServers: [{ urls: sendOptions.iceServer }],
      bundlePolicy: 'balanced',
      iceCandidatePoolSize: 4
    });

    connection.onicecandidateerror = (err) => {
      console.error('❌ ICE Candidate error:', err);
      addToastMessage('ICE Candidate error', 'error');
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
        offerToReceiveVideo: false,
        offerToReceiveAudio: false
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
        Generate a 6-digit PIN to establish a secure connection. Share this PIN with your peer.
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
        Share this 6-digit PIN with your peer. They will need to enter it on the Answer page to connect.
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
</div>