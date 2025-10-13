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

<div class="grid gap-4">
  {#each Object.entries(sendingFiles) as [key, sendingFile], index (key)}
    <FileCard fileDetail={sendingFile} isSender={true}>
      <div class="flex-none my-5">
        {#if sendingFile.error}
          <button onclick={() => onSend(key)} class="btn btn-primary"> Resend <Forward /> </button>
        {:else if sendingFile.stop}
          <button onclick={() => onContinue(key)} class="btn btn-secondary">
            Continue <Workflow />
          </button>
        {:else if sendingFile.status === FileStatus.Processing}
          <button onclick={() => onStop(key)} class="btn btn-secondary">
            Stop <CircleStop />
          </button>
        {:else if sendingFile.status !== FileStatus.Success && sendingFile.status !== FileStatus.WaitingAccept}
          <button onclick={() => onSend(key)} class="btn btn-outline btn-accent">
            Send <Send /></button
          >
        {/if}
        <button onclick={() => onRemove(key)} class="btn btn-error"> Remove <Shredder /> </button>
      </div>
    </FileCard>
  {/each}
</div>