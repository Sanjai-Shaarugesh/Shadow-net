<script lang="ts">
  import { defaultReceiveOptions } from '../../configs';
  import { addToastMessage } from '../../stores/toastStore';
  import { validateFileMetadata } from '../../utils/validator';
  import { Message, MetaData, ReceiveEvent } from '../../proto/message';
  import ReceivingFileList from './ReceivingFileList.svelte';
  import ReceiverOptions from './ReceiverOptions.svelte';
  import { FileStatus, type ReceiveOptions, type ReceivingFile } from '../../type';
  import { decryptAesGcm, decryptAesKeyWithRsaPrivateKey } from '../../utils/crypto';
  import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
  import JSZip from 'jszip';
  import { FolderArchive, FolderDown, FileDown } from '@lucide/svelte';
  
  type Props = {
    dataChannel: RTCDataChannel;
    isEncrypt: boolean;
    rsa: CryptoKeyPair | undefined;
  };

  let { dataChannel, isEncrypt, rsa }: Props = $props();

  let receiveOptions: ReceiveOptions = $state(defaultReceiveOptions);
  let receivingFiles: { [key: string]: ReceivingFile } = $state({});
  let chatHistory: { message: string, timestamp: number }[] = $state([]); // New state for chat history
  
  // Detect platform
  let isMobile = $state(false);

  // Check if running in Capacitor environment
  const checkPlatform = async () => {
    try {
      // This is a simple check to determine if we're on mobile
      const platform = (window as any)?.Capacitor?.getPlatform();
      isMobile = platform === 'ios' || platform === 'android';
    } catch (e) {
      isMobile = false;
    }
  };
  
  checkPlatform();

  // --- Real-time Date/Time State and Logic (New) ---
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

  // Helper to format chat timestamp (Updated to include date, seconds, and 12-hour format)
  function formatTime(timestamp: number): string {
    const date = new Date(timestamp);
    return date.toLocaleDateString(undefined, { year: 'numeric', month: 'numeric', day: 'numeric' }) 
      + ' ' + date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });
  }
  // --- End Real-time Date/Time State and Logic ---


  export async function onMetaData(id: string, metaData: MetaData) {
    let aesKey: CryptoKey | undefined;
    if (isEncrypt && rsa) {
      aesKey = await decryptAesKeyWithRsaPrivateKey(rsa.privateKey, metaData.key);
    }

    receivingFiles[id] = {
      metaData: metaData,
      progress: 0,
      bitrate: 0,
      receivedSize: 0,
      receivedChunks: [],
      startTime: 0,
      status: FileStatus.WaitingAccept,
      aesKey: aesKey
    };

    const validateErr = validateFileMetadata(metaData, receiveOptions.maxSize);
    if (validateErr) {
      addToastMessage(`${metaData.name} ${validateErr.message}`, 'error');

      dataChannel.send(
        Message.encode({
          id: id,
          receiveEvent: ReceiveEvent.EVENT_VALIDATE_ERROR
        }).finish()
      );

      receivingFiles[id].error = validateErr;

      return;
    }

    if (receiveOptions.autoAccept) {
      dataChannel.send(
        Message.encode({
          id: id,
          receiveEvent: ReceiveEvent.EVENT_RECEIVER_ACCEPT
        }).finish()
      );

      receivingFiles[id].status = FileStatus.Processing;
      receivingFiles[id].startTime = Date.now();
    }
  }

  export async function onChunkData(id: string, chunk: Uint8Array) {
    // --- New Chat Handling ---
    if (id === '__CHAT_MESSAGE__') {
      try {
        const chatDataString = new TextDecoder().decode(chunk);
        const chatMessage = JSON.parse(chatDataString);
        chatHistory.push(chatMessage);
        // Ensure the array reference is updated for Svelte reactivity
        chatHistory = chatHistory; 
        addToastMessage(`🗞️ New Message: ${chatMessage.message.substring(0, 30)}...`, 'chat');
      } catch (e) {
        console.error('Failed to parse chat message:', e);
      }
      // Do *not* send a receive event back for chat messages to avoid file transfer logic interference
      return;
    }
    // --- End New Chat Handling ---
    
    let arrayBuffer = chunk;

    dataChannel.send(
      Message.encode({
        id: id,
        receiveEvent: ReceiveEvent.EVENT_RECEIVED_CHUNK
      }).finish()
    );

    const receivingFile = receivingFiles[id];

    if (isEncrypt && receivingFile.aesKey) {
      arrayBuffer = await decryptAesGcm(receivingFile.aesKey, arrayBuffer);
    }
    const receivingSize = arrayBuffer.byteLength;

    receivingFiles[id].receivedChunks.push(arrayBuffer);
    receivingFiles[id].receivedSize += receivingSize;

    // calculate progress
    receivingFiles[id].progress = Math.round(
      (receivingFiles[id].receivedSize / receivingFile.metaData.size) * 100
    );

    // calculate bitrate
    receivingFiles[id].bitrate = Math.round(
      receivingFiles[id].receivedSize / ((Date.now() - receivingFiles[id].startTime) / 1000)
    );

    if (receivingFiles[id].receivedSize >= receivingFile.metaData.size) {
      receivingFiles[id].status = FileStatus.Success;
      addToastMessage(`Received ${receivingFiles[id].metaData.name}`, 'success');
    }
  }

  function blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = reject;
      reader.onload = () => {
        const base64String = (reader.result as string).split(',')[1];
        resolve(base64String);
      };
      reader.readAsDataURL(blob);
    });
  }
  
  function onRemove(key: string) {
    if (receivingFiles[key].status != FileStatus.Success) {
      dataChannel.send(
        Message.encode({
          id: key,
          receiveEvent: ReceiveEvent.EVENT_RECEIVER_REJECT
        }).finish()
      );
    }
    delete receivingFiles[key];
    receivingFiles = { ...receivingFiles }; // Create new reference to trigger reactivity
  }

  // Download file for web browsers
  async function downloadFileWeb(fileName: string, blob: Blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    
    // Clean up
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
    
    addToastMessage(`Downloaded ${fileName}`, 'success');
  }

  // Download file for mobile using Capacitor
  async function downloadFileMobile(fileName: string, base64Data: string) {
    try {
      // Define download folder path
      const downloadDir = 'ShadowNet';
      
      // Create directory if it doesn't exist
      try {
        await Filesystem.mkdir({
          path: downloadDir,
          directory: Directory.Documents,
          recursive: true
        });
      } catch (err: any) {
        // Ignore "Directory exists" error
        if (!err.message?.includes('Directory exists')) {
          throw err;
        }
      }
      
      // Save the file
      await Filesystem.writeFile({
        path: `${downloadDir}/${fileName}`,
        data: base64Data,
        directory: Directory.Documents
      });
      
      addToastMessage(`Saved ${fileName} to Documents/ShadowNet`, 'success');
    } catch (error: any) {
      console.error('Filesystem write error:', error);
      addToastMessage(`Error saving file: ${error.message}`, 'error');
    }
  }

  async function onDownload(key: string) {
    try {
      const receivedFile = receivingFiles[key];
      const blobFile = new Blob(receivedFile.receivedChunks, {
        type: receivedFile.metaData.type
      });
      const fileName = receivedFile.metaData.name;
      
      if (isMobile) {
        // Mobile path using Capacitor
        const base64Data = await blobToBase64(blobFile);
        await downloadFileMobile(fileName, base64Data);
      } else {
        // Web browser path
        await downloadFileWeb(fileName, blobFile);
      }
    } catch (error: any) {
      console.error('Download error:', error);
      addToastMessage(`Download failed: ${error.message}`, 'error');
    }
  }

  function onAccept(key: string) {
    dataChannel.send(
      Message.encode({
        id: key,
        receiveEvent: ReceiveEvent.EVENT_RECEIVER_ACCEPT
      }).finish()
    );

    receivingFiles[key].status = FileStatus.Processing;
    receivingFiles[key].startTime = Date.now();
  }

  function onDeny(key: string) {
    dataChannel.send(
      Message.encode({
        id: key,
        receiveEvent: ReceiveEvent.EVENT_RECEIVER_REJECT
      }).finish()
    );
    delete receivingFiles[key];
    receivingFiles = { ...receivingFiles }; // Create new reference to trigger reactivity
  }

  async function downloadAllFiles() {
    try {
      const zip = new JSZip();
      const folder = zip.folder('received-files');
      const zipFileName = `received_files_${Date.now()}.zip`;
      
      // Add each file to the zip
      for (const key of Object.keys(receivingFiles)) {
        const file = receivingFiles[key];
        if (file.status !== FileStatus.Success || file.error) continue;
        
        const blob = new Blob(file.receivedChunks, {
          type: file.metaData.type
        });
        
        folder?.file(file.metaData.name, blob);
      }
      
      if (isMobile) {
        // Mobile path using Capacitor
        const zipBlob = await zip.generateAsync({ type: 'blob' });
        const base64Data = await blobToBase64(zipBlob);
        
        await downloadFileMobile(zipFileName, base64Data);
      } else {
        // Web browser path
        const zipBlob = await zip.generateAsync({ type: 'blob' });
        await downloadFileWeb(zipFileName, zipBlob);
      }
    } catch (error: any) {
      console.error('Failed to save ZIP:', error);
      addToastMessage(`Error saving ZIP: ${error.message}`, 'error');
    }
  }

  function onOptionsUpdate(options: ReceiveOptions) {
    receiveOptions = options;
  }
</script>

<!-- Replace the existing template section with this structure -->
<div class="flex flex-col h-full max-h-screen p-4 sm:p-6 bg-base-100/50 rounded-lg shadow-2xl space-y-4 md:space-y-6">
  
  <!-- Receiver Options -->
  <ReceiverOptions onUpdate={onOptionsUpdate} />
  
  <!-- Chat History Section -->
  {#if chatHistory.length > 0}
      <div class="flex flex-col flex-grow min-h-0 rounded-xl shadow-inner bg-base-200/70">
        <!-- Scrollable chat container -->
        <div class="flex-1 overflow-y-auto p-4 space-y-3" id="chat-history">
          <!-- Sticky header -->
          <h3 class="font-bold text-sm mb-3 text-base-content/80 sticky top-0 bg-base-200/90 backdrop-blur-sm py-2 -mx-4 px-4 border-b border-base-content/10 z-10">
            Real-time Chat
          </h3>
    
          {#each chatHistory as chat (chat.timestamp)}
            <div class="chat chat-start transition-opacity duration-300">
              <div class="chat-bubble chat-bubble-info break-words max-w-xs md:max-w-md lg:max-w-lg">
                {chat.message}
              </div>
              <div class="chat-footer opacity-70 text-xs mt-0.5">
                Sender : {formatTime(chat.timestamp)}
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
      <!-- Empty Chat State -->
      <div class="flex-shrink-0 rounded-xl shadow-inner bg-base-200/70 h-32">
        <div class="h-full flex flex-col justify-center items-center p-4">
          <h3 class="font-bold text-sm mb-2 text-base-content/80">Real-time Chat</h3>
          <p class="text-center text-sm text-base-content/60 italic">
            No messages yet. Messages from the sender will appear here. ðŸ’¬
          </p>
        </div>
      </div>
    {/if}


  <!-- File Transfer Section -->
  {#if Object.keys(receivingFiles).length > 0}
    <div class="space-y-4">
      <ReceivingFileList {receivingFiles} {onRemove} {onDownload} {onAccept} {onDeny} />
      <div class="flex justify-center">
        <button class="btn btn-outline btn-success btn-sm w-full max-w-xs" onclick={downloadAllFiles}>
          Download <FolderDown class="w-4 h-4" /> all files (zip) <FolderArchive class="w-4 h-4" />
        </button>
      </div>
    </div>
  {:else}
    <!-- Empty Files State -->
    <div class="flex-shrink-0 rounded-xl shadow-inner bg-base-200/70 h-24">
      <div class="h-full flex items-center justify-center p-4">
        <p class="text-center text-sm text-base-content/60 italic">
          Connected, waiting for files... 📡“
        </p>
      </div>
    </div>
  {/if}
  
</div>