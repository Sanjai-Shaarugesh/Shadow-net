<script lang="ts">
  import { FileStatus, type ReceivingFile } from '../../type';
  import FileCard from '../FileCard.svelte';
  import { FileDown, Shredder, Check, X } from '@lucide/svelte';
  import { humanFileSize } from '../../utils/humanFIleSize';

  type Props = {
    receivingFiles: { [key: string]: ReceivingFile };
    onRemove: (key: string) => void;
    onDownload: (key: string) => void;
    onAccept: (key: string) => void;
    onDeny: (key: string) => void;
  };

  const { receivingFiles, onRemove, onDownload, onAccept, onDeny }: Props = $props();
</script>

<div class="grid min-w-0 gap-4">
  {#each Object.entries(receivingFiles) as [key, receivedFile] (key)}
    <FileCard fileDetail={receivedFile} isSender={false}>
      <div class="flex min-w-0 flex-col items-end gap-2">
        {#if receivedFile.status === FileStatus.Receiving}
          <p class="text-xs opacity-70">
            {receivedFile.progress?.toFixed(1) ?? 0}% · {humanFileSize(receivedFile.size ?? 0)} ·
            {humanFileSize(receivedFile.speed ?? 0)}/s
          </p>
        {/if}
        <div class="flex flex-wrap justify-end gap-2">
          {#if receivedFile.status === FileStatus.WaitingAccept && !receivedFile.error}
            <button onclick={() => onDeny(key)} class="btn btn-ghost btn-sm"
              >Deny <X class="h-4 w-4" /></button
            >
            <button onclick={() => onAccept(key)} class="btn btn-primary btn-sm"
              >Accept <Check class="h-4 w-4" /></button
            >
          {:else}
            {#if receivedFile.status === FileStatus.Success}
              <button onclick={() => onDownload(key)} class="btn btn-success btn-sm">
                Download <FileDown class="h-4 w-4" /></button
              >
            {/if}
            <button onclick={() => onRemove(key)} class="btn btn-error btn-sm">
              Remove <Shredder class="h-4 w-4" />
            </button>
          {/if}
        </div>
      </div>
    </FileCard>
  {/each}
</div>
