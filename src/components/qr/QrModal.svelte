<script lang="ts">
  // Compact "show QR" button + bottom-sheet (mobile) / centered (desktop) modal.
  import { onMount } from 'svelte';
  import { QRByte, Encoder, ErrorCorrectionLevel } from '@nuintun/qrcode';
  import { QrCode, X, Share2, Download, Copy, Check } from '@lucide/svelte';
  import { Capacitor } from '@capacitor/core';
  import { Share } from '@capacitor/share';
  import { Filesystem, Directory } from '@capacitor/filesystem';
  import { Clipboard } from '@capacitor/clipboard';

  type Props = { title: string; qrData: string; inline?: boolean };
  const { title, qrData, inline = false }: Props = $props();

  let open = $state(false);
  let busy = $state(false);
  let status = $state('');
  let native = false;
  onMount(() => (native = Capacitor.isNativePlatform()));

  // null = data too large for a QR (very long offline codes)
  const qr = $derived.by(() => {
    if (!qrData) return null;
    try {
      return new Encoder({
        encodingHint: true,
        errorCorrectionLevel: ErrorCorrectionLevel.M,
        version: 0
      })
        .write(
          new QRByte(qrData, (d: string) => ({
            bytes: d.split('').map((c) => c.charCodeAt(0)),
            encoding: 27
          }))
        )
        .make();
    } catch {
      return null;
    }
  });
  const src = $derived(qr ? qr.toDataURL(8) : '');
  const isShort = $derived(qrData.length > 0 && qrData.length <= 24);
  const fileName = $derived(`QR_${title.replace(/[^a-z0-9]/gi, '_')}.png`);

  export function close() {
    open = false;
  }

  function flash(msg: string) {
    status = msg;
    setTimeout(() => (status = ''), 1800);
  }

  async function share() {
    if (!src) return;
    busy = true;
    try {
      if (native) {
        const f = await Filesystem.writeFile({
          path: fileName,
          data: src.split(',')[1],
          directory: Directory.Cache
        });
        await Share.share({ title, url: f.uri, dialogTitle: 'Share QR' });
      } else {
        const blob = await (await fetch(src)).blob();
        const file = new File([blob], fileName, { type: 'image/png' });
        if (navigator.canShare?.({ files: [file] }))
          await navigator.share({ title, files: [file] });
        else await save();
      }
    } catch (e: any) {
      if (e?.name !== 'AbortError') flash('Share failed');
    } finally {
      busy = false;
    }
  }

  async function save() {
    if (!src) return;
    try {
      if (native) {
        try {
          await Filesystem.writeFile({
            path: fileName,
            data: src.split(',')[1],
            directory: Directory.Documents
          });
        } catch {
          await Filesystem.writeFile({
            path: fileName,
            data: src.split(',')[1],
            directory: Directory.Cache
          });
        }
      } else {
        const a = document.createElement('a');
        a.href = src;
        a.download = fileName;
        a.click();
      }
      flash('Saved');
    } catch {
      flash('Save failed');
    }
  }

  async function copy() {
    try {
      if (native) await Clipboard.write({ string: qrData });
      else await navigator.clipboard.writeText(qrData);
      flash('Copied');
    } catch {
      flash('Copy failed');
    }
  }
</script>

{#snippet body()}
  <div class="flex flex-col items-center gap-3 p-3">
    {#if src}
      <!-- white background on purpose: QR must stay dark-on-light in dark themes -->
      <div class="rounded-xl bg-white p-2 shadow">
        <img
          {src}
          alt="QR code for {title}"
          class="block aspect-square w-[min(68vw,18rem)] select-none [image-rendering:pixelated]"
          draggable="false"
        />
      </div>
      {#if isShort}
        <p class="font-mono text-lg font-bold tracking-wider select-all">{qrData}</p>
      {/if}
      <p class="text-xs opacity-70">Scan with the other device's camera</p>

      <div class="flex w-full gap-2">
        <button class="btn btn-sm btn-primary flex-1" onclick={share} disabled={busy}>
          {#if busy}<span class="loading loading-spinner loading-xs"></span>{:else}<Share2
              class="h-4 w-4"
            />{/if}
          Share
        </button>
        <button class="btn btn-sm btn-success flex-1" onclick={save}>
          <Download class="h-4 w-4" /> Save
        </button>
        <button class="btn btn-sm btn-secondary flex-1" onclick={copy}>
          {#if status === 'Copied'}<Check class="h-4 w-4" />{:else}<Copy class="h-4 w-4" />{/if}
          Copy
        </button>
      </div>
      <p class="h-4 text-xs text-success" aria-live="polite">{status}</p>
    {:else}
      <p class="py-6 text-center text-sm opacity-80">
        This code is too long for a QR. Use <b>Copy</b> and send it instead.
      </p>
      <button class="btn btn-sm btn-secondary" onclick={copy}
        ><Copy class="h-4 w-4" /> Copy code</button
      >
    {/if}
  </div>
{/snippet}

<svelte:window onkeydown={(e) => e.key === 'Escape' && open && (open = false)} />

{#if inline}
  {@render body()}
{:else}
  <button
    class="btn btn-sm sm:btn-md btn-outline btn-warning gap-1"
    onclick={() => (open = true)}
    disabled={!qrData}
    aria-label="Show QR code"
  >
    <QrCode class="h-4 w-4" />
    <span>Show QR</span>
  </button>

  {#if open}
    <div
      class="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center sm:p-4"
      role="presentation"
      onclick={(e) => e.target === e.currentTarget && (open = false)}
    >
      <div
        class="bg-base-100 flex max-h-[92dvh] w-full flex-col overflow-y-auto rounded-t-2xl shadow-2xl sm:max-w-xs sm:rounded-2xl"
        style="padding-bottom: env(safe-area-inset-bottom)"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div class="flex items-center justify-between gap-2 px-3 pt-3">
          <h3 class="truncate text-base font-bold">{title}</h3>
          <button
            class="btn btn-ghost btn-sm btn-circle"
            onclick={() => (open = false)}
            aria-label="Close"
          >
            <X class="h-4 w-4" />
          </button>
        </div>

        {@render body()}
      </div>
    </div>
  {/if}
{/if}
