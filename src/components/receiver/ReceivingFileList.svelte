<script lang="ts">
  import { FileStatus, type ReceivingFile } from '../../type';
  import FileCard from '../FileCard.svelte';
  import { FileDown, Shredder } from '@lucide/svelte';
  import {humanFileSize} from '../../utils/humanFIleSize';

  type Props = {
      receivingFiles: { [key: string]: ReceivingFile };
      onRemove: (key: string) => void;
      onDownload: (key: string) => void;
      onAccept: (key: string) => void;
      onDeny: (key: string) => void;
    };
  
    const { receivingFiles, onRemove, onDownload, onAccept, onDeny }: Props = $props();
</script>

<div class="grid gap-8">
  {#each Object.entries(receivingFiles) as [key, receivedFile] (key)}
    <FileCard fileDetail={receivedFile} isSender={false}>
      <div class="flex flex-col items-end gap-2">
        {#if receivedFile.status === FileStatus.Receiving}
          <p class="text-sm text-gray-600">
            Progress: {receivedFile.progress?.toFixed(1) ?? 0}% 
            | Size: {humanFileSize(receivedFile.size ?? 0)}
            | Speed: {humanFileSize(receivedFile.speed ?? 0)}/s
          </p>
        {/if}
        <div class="flex gap-2">
          {#if receivedFile.status === FileStatus.WaitingAccept && !receivedFile.error}
            <button onclick={() => onAccept(key)} class="btn btn-primary">Accept</button>
            <button onclick={() => onDeny(key)} class="btn btn-ghost">Deny</button>
          {:else}
            {#if receivedFile.status === FileStatus.Success}
              <button onclick={() => onDownload(key)} class="btn btn-active btn-success">
                Download <FileDown /></button
              >
            {/if}
            <button onclick={() => onRemove(key)} class="btn btn-error"> Remove <Shredder /> </button>
          {/if}
        </div>
      </div>
    </FileCard>
  {/each}
</div>