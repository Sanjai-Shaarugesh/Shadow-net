<script lang="ts">
  import { FileStatus, type SendingFile } from '../../type';
  import FileCard from '../FileCard.svelte';
  import { Send, Forward, CircleStop, Shredder, Workflow } from '@lucide/svelte';

  type Props = {
    sendingFiles: { [key: string]: SendingFile };
    onRemove: (key: string) => void;
    onSend: (key: string) => void;
    onStop: (key: string) => void;
    onContinue: (key: string) => void;
  };
  const { sendingFiles, onRemove, onSend, onStop, onContinue }: Props = $props();
</script>

<div class="grid min-w-0 gap-4">
  {#each Object.entries(sendingFiles) as [key, sendingFile] (key)}
    <FileCard fileDetail={sendingFile} isSender={true}>
      <div class="flex flex-wrap justify-end gap-2">
        {#if sendingFile.error}
          <button onclick={() => onSend(key)} class="btn btn-primary btn-sm">
            Resend <Forward class="h-4 w-4" />
          </button>
        {:else if sendingFile.stop}
          <button onclick={() => onContinue(key)} class="btn btn-secondary btn-sm">
            Continue <Workflow class="h-4 w-4" />
          </button>
        {:else if sendingFile.status === FileStatus.Processing}
          <button onclick={() => onStop(key)} class="btn btn-secondary btn-sm">
            Stop <CircleStop class="h-4 w-4" />
          </button>
        {:else if sendingFile.status !== FileStatus.Success && sendingFile.status !== FileStatus.WaitingAccept}
          <button onclick={() => onSend(key)} class="btn btn-outline btn-accent btn-sm">
            Send <Send class="h-4 w-4" /></button
          >
        {/if}
        <button onclick={() => onRemove(key)} class="btn btn-error btn-sm">
          Remove <Shredder class="h-4 w-4" />
        </button>
      </div>
    </FileCard>
  {/each}
</div>
