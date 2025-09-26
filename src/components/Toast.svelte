<script lang="ts">
  import { fade } from 'svelte/transition';
  import { toastAtom, type ToastMessage } from '../stores/toastStore';
  import { onDestroy } from 'svelte';
  import {
    CheckCircle,
    AlertCircle,
    Info,
    TriangleAlert
  } from '@lucide/svelte';

  let toasts: ToastMessage[] = $state([]);

  const unsubscribe = toastAtom.subscribe((toastMessage) => {
    if (toastMessage) {
      const toast = { ...toastMessage };
      toasts = [toast, ...toasts];

      setTimeout(() => {
        toasts = toasts.filter((t) => t.id !== toast.id);
      }, toastMessage.duration);
    }
  });

  onDestroy(unsubscribe);
</script>

<style>
  .toast-shadow {
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
  }
</style>

<div
  class="fixed bottom-5 left-1/2 transform -translate-x-1/2 z-50 space-y-3 w-[90%] max-w-md sm:right-6 sm:left-auto sm:translate-x-0"
>
  {#each toasts as toast (toast.id)}
      <div
                              class={`flex items-start gap-3 px-4 py-3 rounded-xl text-white toast-shadow
                                ${toast.status === 'success' ? 'bg-green-600' : ''}
                                ${toast.status === 'error' ? 'bg-red-600' : ''}
                                ${toast.status === 'info' ? 'bg-blue-600' : ''}
                                ${toast.status === 'warning' ? 'bg-yellow-600 text-black' : ''}
                                ${toast.status === 'chat' ? 'bg-green-400 text-white' : ''}`}
                              in:fade={{ duration: 300 }}
                              out:fade={{ duration: 300 }}
                            >
                              <div class="mt-0.5">
                                {#if toast.status === 'success'}
                                  <CheckCircle class="w-5 h-5" />
                                {:else if toast.status === 'error'}
                                  <AlertCircle class="w-5 h-5" />
                                {:else if toast.status === 'info'}
                                  <Info class="w-5 h-5" />
                                {:else if toast.status === 'warning'}
                                  <TriangleAlert class="w-5 h-5" />
                                {/if}
                              </div>
                              <div class="flex-1 text-sm font-medium">{toast.message}</div>
                            </div>
  {/each}
</div>
