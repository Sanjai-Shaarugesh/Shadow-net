<script lang="ts">
  // Compact QR scanner: camera (back by default), torch, camera switch, or upload an image.
  // Bottom-sheet on phones, centered card on desktop. Same props as before.
  import QrScanner from 'qr-scanner';
  import { onMount, onDestroy, tick } from 'svelte';
  import { ScanLine, X, SwitchCamera, Flashlight, Upload, RotateCcw } from '@lucide/svelte';

  interface Props {
    onScanSuccess: (data: string) => void;
    buttonText?: string;
    modalTitle?: string;
    autoStart?: boolean;
    continuousScanning?: boolean;
    allowImageUpload?: boolean;
    theme?: 'light' | 'dark' | 'auto'; // kept for compatibility, daisyUI theme is used
  }
  const {
    onScanSuccess,
    buttonText = 'Scan QR',
    modalTitle = 'Scan QR code',
    autoStart = false,
    continuousScanning = false,
    allowImageUpload = true
  }: Props = $props();

  let open = $state(false);
  let video: HTMLVideoElement | undefined = $state();
  let fileInput: HTMLInputElement | undefined = $state();
  let scanner: QrScanner | null = null;
  let cameras = $state<QrScanner.Camera[]>([]);
  let camIdx = 0;
  let hasTorch = $state(false);
  let torchOn = $state(false);
  let starting = $state(false);
  let error = $state('');
  let last = { data: '', at: 0 };

  onMount(() => {
    if (autoStart) openModal();
  });
  onDestroy(stop);

  async function openModal() {
    open = true;
    await tick();
    await start();
  }

  function closeModal() {
    stop();
    open = false;
  }

  function stop() {
    try {
      scanner?.stop();
      scanner?.destroy();
    } catch {
      /* ignore */
    }
    scanner = null;
    torchOn = false;
    hasTorch = false;
  }

  function friendly(e: unknown): string {
    const n = (e as any)?.name ?? '';
    const m = String((e as any)?.message ?? e);
    if (n === 'NotAllowedError' || /denied|permission/i.test(m))
      return 'Camera is blocked. Allow camera access in your browser/app settings, or upload an image instead.';
    if (n === 'NotFoundError' || /no camera/i.test(m))
      return 'No camera found. Upload an image instead.';
    if (n === 'NotReadableError') return 'Camera is busy in another app. Close it and retry.';
    if (!window.isSecureContext) return 'Camera needs HTTPS (or localhost).';
    return m || 'Could not start the camera.';
  }

  async function start() {
    if (!video) return;
    starting = true;
    error = '';
    stop();
    try {
      scanner = new QrScanner(video, (r) => onResult(r.data), {
        preferredCamera: 'environment',
        highlightScanRegion: true,
        highlightCodeOutline: true,
        maxScansPerSecond: 20,
        returnDetailedScanResult: true
      });
      await scanner.start();
      cameras = await QrScanner.listCameras(true).catch(() => []);
      hasTorch = await scanner.hasFlash().catch(() => false);
    } catch (e) {
      error = friendly(e);
      stop();
    } finally {
      starting = false;
    }
  }

  function onResult(data: string) {
    const now = Date.now();
    if (data === last.data && now - last.at < 1500) return; // debounce repeats
    last = { data, at: now };
    if (!continuousScanning) closeModal();
    onScanSuccess(data);
  }

  async function switchCamera() {
    if (!scanner || cameras.length < 2) return;
    camIdx = (camIdx + 1) % cameras.length;
    try {
      await scanner.setCamera(cameras[camIdx].id);
      hasTorch = await scanner.hasFlash().catch(() => false);
      torchOn = false;
    } catch (e) {
      error = friendly(e);
    }
  }

  async function toggleTorch() {
    if (!scanner) return;
    try {
      await scanner.toggleFlash();
      torchOn = scanner.isFlashOn();
    } catch {
      hasTorch = false;
    }
  }

  async function onFile(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    error = '';
    try {
      const r = await QrScanner.scanImage(file, { returnDetailedScanResult: true });
      onResult(r.data);
    } catch {
      error = 'No QR code found in that image.';
    }
  }

  const onHide = () => {
    if (!open || !scanner) return;
    if (document.hidden) scanner.stop();
    else scanner.start().catch((e) => (error = friendly(e)));
  };
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && open && closeModal()} />
<svelte:document onvisibilitychange={onHide} />

<button
  class="btn btn-sm sm:btn-md btn-outline btn-accent gap-1"
  onclick={openModal}
  aria-label={buttonText}
>
  <ScanLine class="h-4 w-4" />
  <span>{buttonText}</span>
</button>

{#if open}
  <div
    class="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center sm:p-4"
    role="presentation"
    onclick={(e) => e.target === e.currentTarget && closeModal()}
  >
    <div
      class="bg-base-100 flex max-h-[96dvh] w-full flex-col overflow-hidden rounded-t-2xl shadow-2xl sm:max-w-sm sm:rounded-2xl"
      style="padding-bottom: env(safe-area-inset-bottom)"
      role="dialog"
      aria-modal="true"
      aria-label={modalTitle}
    >
      <div class="flex items-center gap-1 px-3 py-2">
        <h3 class="min-w-0 flex-1 truncate text-base font-bold">{modalTitle}</h3>
        {#if cameras.length > 1}
          <button
            class="btn btn-ghost btn-sm btn-circle"
            onclick={switchCamera}
            aria-label="Switch camera"
          >
            <SwitchCamera class="h-4 w-4" />
          </button>
        {/if}
        {#if hasTorch}
          <button
            class="btn btn-ghost btn-sm btn-circle"
            class:text-warning={torchOn}
            onclick={toggleTorch}
            aria-label="Toggle flashlight"
          >
            <Flashlight class="h-4 w-4" />
          </button>
        {/if}
        <button class="btn btn-ghost btn-sm btn-circle" onclick={closeModal} aria-label="Close">
          <X class="h-4 w-4" />
        </button>
      </div>

      <!-- viewfinder: square, but never taller than 58% of the screen (landscape phones) -->
      <div
        class="relative mx-3 aspect-square max-h-[58dvh] self-center overflow-hidden rounded-xl bg-black"
        style="width: min(100%, 58dvh)"
      >
        <video bind:this={video} class="h-full w-full object-cover" playsinline muted></video>

        {#if starting && !error}
          <div class="absolute inset-0 grid place-items-center bg-black/50">
            <span class="loading loading-spinner loading-md text-white"></span>
          </div>
        {/if}

        {#if error}
          <div
            class="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-base-100/95 p-4 text-center"
          >
            <p class="text-sm">{error}</p>
            <button class="btn btn-sm btn-primary" onclick={start}
              ><RotateCcw class="h-4 w-4" /> Retry</button
            >
          </div>
        {/if}
      </div>

      <div class="flex items-center gap-2 px-3 py-2">
        <p class="flex-1 text-xs opacity-70">Point the camera at the QR code.</p>
        {#if allowImageUpload}
          <button class="btn btn-sm btn-ghost" onclick={() => fileInput?.click()}>
            <Upload class="h-4 w-4" /> Image
          </button>
          <input
            bind:this={fileInput}
            type="file"
            accept="image/*"
            class="hidden"
            onchange={onFile}
          />
        {/if}
      </div>
    </div>
  </div>
{/if}
