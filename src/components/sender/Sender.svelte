<script lang="ts">
  import DragAndDrop from './DragAndDrop.svelte';
  import EventEmitter from 'eventemitter3';
  import { FileStatus, type SendingFile } from '../../type';
  import SendingFileList from './SendingFileList.svelte';
  import { encryptAesGcm, encryptAesKeyWithRsaPublicKey, generateAesKey } from '../../utils/crypto';
  import { validateFileMetadata } from '../../utils/validator';
  import { Message, MetaData, ReceiveEvent, receiveEventToJSON } from '../../proto/message';
  import { addToastMessage } from '../../stores/toastStore';
  import { RollerCoaster } from '@lucide/svelte';
  import { prepareForTransfer, type Prepared } from '../../utils/fileCompress';
  import { buildPreview, type BuiltPreview } from '../../utils/filePreview';
  import type { ControlChannel } from '../../utils/controlChannel';
  import { session } from '../session.svelte';

  type Props = {
    dataChannel: RTCDataChannel;
    ctrl: ControlChannel | undefined;
    chunkSize: number;
    isEncrypt: boolean;
    rsaPub: CryptoKey | undefined;
  };

  const { dataChannel, ctrl, chunkSize, isEncrypt, rsaPub }: Props = $props();

  let sendingFiles: { [key: string]: SendingFile } = $state({});

  // compression + raw preview are prepared in the background as soon as a file is picked
  const prepared: Record<string, Promise<{ p: Prepared; built: BuiltPreview }>> = {};

  function startPrepare(key: string, file: File) {
    session.setOutgoing(key, { phase: 'preparing' });
    prepared[key] = (async () => {
      const p = await prepareForTransfer(file);
      let built: BuiltPreview;
      try {
        built = await buildPreview(file, { codec: p.codec, payloadSize: p.payloadSize });
      } catch {
        built = {
          info: {
            name: file.name,
            size: file.size,
            payloadSize: p.payloadSize,
            codec: p.codec,
            type: file.type,
            kind: 'none'
          }
        };
      }
      const url =
        built.bytes && built.info.thumbMime
          ? URL.createObjectURL(new Blob([built.bytes as BlobPart], { type: built.info.thumbMime }))
          : undefined;
      session.setOutgoing(key, { phase: 'ready', info: built.info, bytes: built.bytes, url });
      return { p, built };
    })();
  }

  export function onReceiveEvent(id: string, receiveEvent: ReceiveEvent) {
    const sendingFile = sendingFiles[id];
    if (sendingFile && sendingFile.event) {
      sendingFile.event.emit(receiveEventToJSON(receiveEvent));
    }
  }

  async function onSend(key: string) {
    const sendingFile = sendingFiles[key];
    if (!sendingFile) return;
    let offset = 0;

    // reset value
    sendingFiles[key].error = undefined;
    sendingFiles[key].stop = false;

    let prep: { p: Prepared; built: BuiltPreview };
    try {
      prep = await prepared[key];
    } catch (e) {
      sendingFiles[key].error = e instanceof Error ? e : new Error('Could not prepare file');
      return;
    }
    const payload = prep.p.payload;
    const payloadSize = payload.size;
    // what travels over the wire is the (maybe compressed) payload
    sendingFiles[key].metaData = { ...sendingFile.metaData, size: payloadSize };

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

      if (offset < payloadSize) {
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
      const slice = payload.slice(offset, offset + chunkSize);
      const buffer = await slice.arrayBuffer();

      await sendBuffer(buffer);

      offset += buffer.byteLength;

      // calculate progress
      sendingFiles[key].progress = Math.round((offset / payloadSize) * 100);

      // calculate bitrate
      sendingFiles[key].bitrate = Math.round(
        offset / ((Date.now() - sendingFiles[key].startTime) / 1000)
      );
    }

    // 1) raw preview + extended metadata go over the control channel first ...
    ctrl?.sendPreview(key, prep.built.info, prep.built.bytes);

    // 2) ... then the classic metadata message that opens the accept/deny prompt
    dataChannel.send(
      Message.encode({
        id: sendingFile.metaData.name,
        metaData: sendingFiles[key].metaData
      }).finish()
    );

    sendingFiles[key].status = FileStatus.WaitingAccept;
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
    delete prepared[key];
    session.dropOutgoing(key);
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
      startPrepare(file.name, file);
    });
  }
</script>

<div class="flex flex-col gap-4">
  <DragAndDrop
    {onFilesPick}
    class="cursor-pointer rounded-xl border-2 border-dashed border-base-content/20 p-4 text-center text-sm transition-colors duration-200 hover:border-primary"
  />

  {#if Object.keys(sendingFiles).length > 0}
    <SendingFileList {sendingFiles} {onRemove} {onSend} {onStop} {onContinue} />
    <div class="flex justify-center">
      <button class="btn btn-outline btn-secondary btn-sm w-full max-w-xs" onclick={sendAllFiles}>
        Send all files <RollerCoaster class="h-4 w-4" />
      </button>
    </div>
  {:else}
    <p class="text-center text-sm text-base-content/70">No files selected for transfer.</p>
  {/if}
</div>
