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
      const downloadDir = 'Speed-share';
      
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
      
      addToastMessage(`Saved ${fileName} to Documents/Speed-share`, 'success');
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

  // Helper to format chat timestamp
  function formatTime(timestamp: number): string {
    return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
</script>

<div class="grid gap-4">  
  <ReceiverOptions onUpdate={onOptionsUpdate} />
  
  <div class="border rounded-lg p-3 bg-gray-50 [html[data-theme=dark]_&]:bg-gray-800 h-64 overflow-y-auto">
    <h3 class="font-bold text-sm mb-2 text-gray-700 [html[data-theme=dark]_&]:text-gray-300">Real-time Chat</h3>
    {#if chatHistory.length === 0}
      <p class="text-sm text-gray-500 [html[data-theme=dark]_&]:text-gray-400">No messages yet. Messages from the sender will appear here.</p>
    {:else}
      {#each chatHistory as chat (chat.timestamp)}
        <div class="chat chat-start">
          <div class="chat-bubble chat-bubble-primary text-sm">
            <span class="text-xs opacity-70 block mb-1">Sender {formatTime(chat.timestamp)}</span>
            {chat.message}
          </div>
        </div>
      {/each}
    {/if}
  </div>
  {#if Object.keys(receivingFiles).length > 0}
    <ReceivingFileList {receivingFiles} {onRemove} {onDownload} {onAccept} {onDeny} />
    <button class="btn btn-dash btn-success mt-2" onclick={downloadAllFiles}>
      Download <FolderDown /> all files (zip) <FolderArchive />
    </button>
  {:else}
    <p class="mt-4">Connected, Waiting for files...</p>
  {/if}
</div>