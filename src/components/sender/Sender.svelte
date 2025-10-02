<script lang="ts">
  import DragAndDrop from './DragAndDrop.svelte';
  import EventEmitter from 'eventemitter3';
  import { FileStatus, type SendingFile } from '../../type';
  import SendingFileList from './SendingFileList.svelte';
  import { encryptAesGcm, encryptAesKeyWithRsaPublicKey, generateAesKey } from '../../utils/crypto';
  import { validateFileMetadata } from '../../utils/validator';
  import { Message, MetaData, ReceiveEvent, receiveEventToJSON } from '../../proto/message';
  import { addToastMessage } from '../../stores/toastStore';
  import { RollerCoaster, Send } from '@lucide/svelte'; // Added Send icon

  type Props = {
    dataChannel: RTCDataChannel;
    chunkSize: number;
    isEncrypt: boolean;
    rsaPub: CryptoKey | undefined;
  };

  const { dataChannel, chunkSize, isEncrypt, rsaPub }: Props = $props();

  let sendingFiles: { [key: string]: SendingFile } = $state({});
  let chatMessage = $state(''); // State for the chat input

  // --- Chat History Type and State ---
  type ChatMessage = {
    type: 'sent' | 'received'; // Distinguish between messages sent by us or received
    message: string;
    timestamp: number;
  };

  let chatHistory: ChatMessage[] = $state([]); // State for storing chat messages
  // --- End Chat History Type and State ---

  // --- Real-time Date/Time State and Logic ---
  let currentLocalTime = $state(
    new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true })
  );

  $effect(() => {
    const updateTime = () => {
      // Using 'undefined' locale parameter ensures it uses the user's default locale settings
      currentLocalTime = new Date().toLocaleTimeString(undefined, {
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
        hour12: true // Ensures 12-hour format with AM/PM
      });
    };

    // Update every second
    const interval = setInterval(updateTime, 1000);

    // Cleanup function for when the component is destroyed
    return () => clearInterval(interval);
  });

  // Helper to format chat timestamp with local date and time in 12-hour format
  function formatChatTimestamp(timestamp: number): string {
    const date = new Date(timestamp);
    return date.toLocaleDateString(undefined, { year: 'numeric', month: 'numeric', day: 'numeric' }) 
      + ' ' + date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });
  }
  // --- End Real-time Date/Time State and Logic ---


  // --- New Chat Functionality (Modified) ---

  function sendChatMessage() {
    if (chatMessage.trim() === '') return;

    const messageText = chatMessage.trim();
    // Use the local timestamp when sending
    const localTimestamp = Date.now(); 

    const chatData = JSON.stringify({
      type: 'chat',
      message: messageText,
      timestamp: localTimestamp
    });

    try {
      dataChannel.send(
        Message.encode({
          id: '__CHAT_MESSAGE__', // Reserved ID for chat messages
          chunk: new TextEncoder().encode(chatData) // Encode the JSON string as Uint8Array
        }).finish()
      );

      // Add sent message to chat history
      chatHistory = [
        ...chatHistory,
        { type: 'sent', message: messageText, timestamp: localTimestamp }
      ];

      addToastMessage('Message Sent', 'info');
      chatMessage = ''; // Clear the input
    } catch (e) {
      console.error('Failed to send chat message:', e);
      addToastMessage('Failed to send message', 'error');
    }
  }

  /**
   * Function to handle a received chat message chunk.
   * This will be called externally when a message with id '__CHAT_MESSAGE__' is received.
   */
  export function onReceiveChatMessage(chunk: Uint8Array) {
    try {
      const jsonString = new TextDecoder().decode(chunk);
      const receivedData = JSON.parse(jsonString);

      if (receivedData.type === 'chat' && receivedData.message) {
        // Add received message to chat history. 
        // It's best practice to use the timestamp from the sender, but we process it locally.
        chatHistory = [
          ...chatHistory,
          {
            type: 'received',
            message: receivedData.message,
            timestamp: receivedData.timestamp || Date.now()
          }
        ];
        addToastMessage('New Message Received', 'info');
      }
    } catch (e) {
      console.error('Failed to process received chat message:', e);
    }
  }

  // --- End New Chat Functionality (Modified) ---


  export function onReceiveEvent(id: string, receiveEvent: ReceiveEvent) {
    const sendingFile = sendingFiles[id];
    if (sendingFile && sendingFile.event) {
      sendingFile.event.emit(receiveEventToJSON(receiveEvent));
    }
  }

  async function onSend(key: string) {
    const sendingFile = sendingFiles[key];
    let offset = 0;

    // reset value
    sendingFiles[key].error = undefined;
    sendingFiles[key].stop = false;

    sendingFiles[key].event = new EventEmitter();

    sendingFiles[key].event?.on(
      receiveEventToJSON(ReceiveEvent.EVENT_RECEIVER_ACCEPT),
      async () => {
        sendingFiles[key].status = FileStatus.Processing;
        sendingFiles[key].startTime = Date.now();
        await sendNextChunk();
      }
    );
    sendingFiles[key].event?.on(receiveEventToJSON(ReceiveEvent.EVENT_RECEIVED_CHUNK), async () => {
      if (sendingFiles[key].stop) {
        return;
      }
      if (sendingFiles[key].error || sendingFiles[key].status != FileStatus.Processing) {
        sendingFiles[key].progress = 0;
        sendingFiles[key].status = FileStatus.Pending;
        sendingFiles[key].stop = false;
        return;
      }

      if (offset < sendingFile.metaData.size) {
        await sendNextChunk();
        return;
      }

      sendingFiles[key].status = FileStatus.Success;
      addToastMessage(`File ${sendingFile.metaData.name} sent successfully`, 'success');
    });

    sendingFiles[key].event?.on(receiveEventToJSON(ReceiveEvent.EVENT_VALIDATE_ERROR), () => {
      addToastMessage('Receiver validate error', 'error');
      sendingFiles[key].error = new Error('Receiver validate error');
      sendingFiles[key].status = FileStatus.Pending;
    });

    sendingFiles[key].event?.on(receiveEventToJSON(ReceiveEvent.EVENT_RECEIVER_REJECT), () => {
      addToastMessage('Receiver reject the file', 'error');
      sendingFiles[key].error = new Error('Receiver reject the file');
      sendingFiles[key].status = FileStatus.Pending;
    });

    async function sendBuffer(buffer: ArrayBuffer) {
      if (isEncrypt) {
        const aesKey = sendingFiles[key].aesKey;
        if (aesKey) {
          const encrypted = await encryptAesGcm(aesKey, buffer);
          dataChannel.send(
            Message.encode({
              id: sendingFile.metaData.name,
              chunk: encrypted
            }).finish()
          );
          return;
        }
      }

      dataChannel.send(
        Message.encode({
          id: sendingFile.metaData.name,
          chunk: new Uint8Array(buffer)
        }).finish()
      );
    }

    async function sendNextChunk() {
      const slice = sendingFile.file.slice(offset, offset + chunkSize);
      const buffer = await slice.arrayBuffer();

      await sendBuffer(buffer);

      offset += buffer.byteLength;

      // calculate progress
      sendingFiles[key].progress = Math.round((offset / sendingFile.metaData.size) * 100);

      // calculate bitrate
      sendingFiles[key].bitrate = Math.round(
        offset / ((Date.now() - sendingFiles[key].startTime) / 1000)
      );
    }

    // send meta data
    dataChannel.send(
      Message.encode({
        id: sendingFile.metaData.name,
        metaData: sendingFile.metaData
      }).finish()
    );

    sendingFiles[key].status = FileStatus.WaitingAccept;
    // TODO: wait finish to send 1 by 1 file (success, error)
  }

  async function sendAllFiles() {
    for (const key of Object.keys(sendingFiles)) {
      if (sendingFiles[key].status != FileStatus.Pending || sendingFiles[key].error) {
        continue;
      }
      await onSend(key);
    }
  }

  async function onStop(key: string) {
    sendingFiles[key].stop = true;
  }

  async function onContinue(key: string) {
    sendingFiles[key].stop = false;
    sendingFiles[key].event?.emit(receiveEventToJSON(ReceiveEvent.EVENT_RECEIVED_CHUNK));
  }

  function onRemove(key: string) {
    if (sendingFiles[key].status === FileStatus.Processing) {
      sendingFiles[key].stop = true;
    }
    delete sendingFiles[key];
    sendingFiles = sendingFiles; // do this to trigger update the map
  }

  function onFilesPick(files: FileList) {
    Array.from(files).forEach(async (file) => {
      let aesKey;
      let aesEncrypted = new Uint8Array();
      if (isEncrypt && rsaPub) {
        aesKey = await generateAesKey();
        aesEncrypted = await encryptAesKeyWithRsaPublicKey(rsaPub, aesKey);
      }

      const fileMetaData: MetaData = {
        name: file.name,
        size: file.size,
        type: file.type,
        key: aesEncrypted
      };
      const validateErr = validateFileMetadata(fileMetaData);
      if (validateErr) {
        addToastMessage(`${file.name} ${validateErr.message}`, 'error');
      }

      sendingFiles[file.name] = {
        file: file,
        metaData: fileMetaData,
        progress: 0,
        bitrate: 0,
        stop: false,
        error: validateErr,
        startTime: 0,
        status: FileStatus.Pending,
        aesKey: aesKey
      };
    });
  }
</script>

<!-- Replace the existing chat section with this structure -->
<div class="flex flex-col h-full max-h-screen p-4 sm:p-6 bg-base-100/50 rounded-lg shadow-2xl space-y-4 md:space-y-6">
  
  <!-- Chat History Section -->
  {#if chatHistory.length > 0}
    <div class="flex flex-col flex-grow min-h-0 rounded-xl shadow-inner bg-base-200/70">
      <!-- Scrollable chat container with modern scrollbar -->
      <div class="flex-1 overflow-y-auto p-4 space-y-3 scrollbar-thin scrollbar-thumb-primary scrollbar-track-base-200/50" id="chat-history">
        {#each chatHistory as chat}
          <div class="chat transition-opacity duration-300" 
               class:chat-end={chat.type === 'sent'} 
               class:chat-start={chat.type === 'received'}>
            <div class="chat-bubble break-words max-w-xs md:max-w-md lg:max-w-lg transition-colors duration-300" 
                 class:chat-bubble-primary={chat.type === 'sent'} 
                 class:chat-bubble-info={chat.type === 'received'}>
              {chat.message}
            </div>
            <div class="chat-footer opacity-70 text-xs mt-0.5">
              {formatChatTimestamp(chat.timestamp)}
            </div>
          </div>
        {/each}
      </div>
  
      <!-- Clear Chat Button -->
      <div class="flex justify-center p-2 border-t border-base-300">
        <button class="btn btn-outline btn-warning btn-sm" onclick={() => chatHistory = []}>
          Clear Chat History
        </button>
      </div>
    </div>
  {:else}

    <!-- Empty State -->
    <div class="flex-grow flex items-center justify-center rounded-xl shadow-inner bg-base-200/70">
      <p class="text-center text-sm text-base-content/60 italic p-6 rounded-lg bg-base-300/50">
        Start a real-time conversation! ðŸ’¬
      </p>
    </div>
  {/if}

  <!-- Chat Input Section -->
  <div class="flex items-center gap-2">
    <input
      type="text"
      bind:value={chatMessage}
      onkeydown={(e) => {
        if (e.key === 'Enter') sendChatMessage();
      }}
      placeholder="Type a message..."
      class="input input-bordered w-full input-lg shadow-md focus:shadow-lg focus:outline-none focus:border-primary transition-all duration-200"
    />
    <button class="btn btn-primary btn-lg btn-square shadow-lg" 
            onclick={sendChatMessage} 
            disabled={!dataChannel || dataChannel.readyState !== 'open'}>
      <Send class="w-6 h-6" />
    </button>
  </div>

  <!-- File Transfer Section -->
  <div class="space-y-4">
    <DragAndDrop {onFilesPick} class="p-4 border-2 border-dashed border-base-content/20 rounded-xl hover:border-primary transition-colors duration-200 cursor-pointer text-center text-sm" />
  
    {#if Object.keys(sendingFiles).length > 0}
      <SendingFileList {sendingFiles} {onRemove} {onSend} {onStop} {onContinue} />
      <div class="flex justify-center">
        <button class="btn btn-outline btn-secondary btn-sm mt-2 w-full max-w-xs" onclick={sendAllFiles}>
          Send all files <RollerCoaster class="w-4 h-4" />
        </button>
      </div>
    {:else}
      <p class="text-center text-sm text-base-content/70">No files selected for transfer.</p>
    {/if}
  </div>
</div>


