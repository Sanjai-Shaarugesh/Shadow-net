<script lang="ts">
  import { onMount } from 'svelte';
  import { QRByte, Encoder, ErrorCorrectionLevel } from '@nuintun/qrcode';
  import { QrCode, X, Share2, Download, Copy, Check } from '@lucide/svelte';

  // Capacitor imports
  import { Capacitor } from '@capacitor/core';
  import { Share } from '@capacitor/share';
  import { Filesystem, Directory } from '@capacitor/filesystem';
  import { Toast } from '@capacitor/toast';
  import { Clipboard } from '@capacitor/clipboard';
  import { Haptics, ImpactStyle } from '@capacitor/haptics';

  type Props = {
    title: string;
    qrData: string;
  };

  const { title, qrData }: Props = $props();

  let isModalOpen = $state(false);
  let qrcode = $state<Encoder | null>(null);
  let isClosing = $state(false);
  let isSharing = $state(false);
  let isDownloading = $state(false);
  let copySuccess = $state(false);
  let isNativePlatform = $state(false);

  // Export function to close modal
  export function close() {
    isClosing = true;
    setTimeout(() => {
      isModalOpen = false;
      isClosing = false;
    }, 300);
  }

  // Check if running on native platform
  onMount(() => {
    isNativePlatform = Capacitor.isNativePlatform();
  });

  // Generate QR code when qrData changes
  $effect(() => {
    if (qrData) {
      qrcode = new Encoder({
        encodingHint: true,
        errorCorrectionLevel: ErrorCorrectionLevel.M,
        version: 0
      })
        .write(
          new QRByte(qrData, (data: string) => {
            const bytes = data.split('').map((char) => char.charCodeAt(0));
            return { bytes: bytes, encoding: 27 };
          })
        )
        .make();
    }
  });

  function openModal() {
    isModalOpen = true;
    // Add haptic feedback on native platforms
    if (isNativePlatform) {
      Haptics.impact({ style: ImpactStyle.Light });
    }
  }

  function closeModal() {
    isClosing = true;
    // Add haptic feedback on native platforms
    if (isNativePlatform) {
      Haptics.impact({ style: ImpactStyle.Light });
    }
    setTimeout(() => {
      isModalOpen = false;
      isClosing = false;
    }, 300);
  }

  // Convert data URL to blob
  function dataURLToBlob(dataURL: string): Blob {
    const arr = dataURL.split(',');
    const mime = arr[0].match(/:(.*?);/)![1];
    const bstr = atob(arr[1]);
    let n = bstr.length;
    const u8arr = new Uint8Array(n);
    while (n--) {
      u8arr[n] = bstr.charCodeAt(n);
    }
    return new Blob([u8arr], { type: mime });
  }

  // Show toast message
  async function showToast(message: string) {
    if (isNativePlatform) {
      await Toast.show({
        text: message,
        duration: 'short',
        position: 'bottom'
      });
    }
  }

  // Share QR code - Capacitor native or web fallback
  async function shareQRCode() {
    if (!qrcode) return;

    isSharing = true;

    try {
      const dataURL = qrcode.toDataURL(8);
      const fileName = `QR_${title.replace(/[^a-z0-9]/gi, '_')}_${Date.now()}.png`;

      if (isNativePlatform) {
        // Native sharing using Capacitor
        const base64Data = dataURL.replace(/^data:image\/png;base64,/, '');

        // Write temporary file to Cache directory
        const result = await Filesystem.writeFile({
          path: fileName,
          data: base64Data,
          directory: Directory.Cache
        });

        // console.log('🔗 Temp file created for sharing:', result.uri);

        // Share the file
        await Share.share({
          title: `QR Code - ${title}`,
          text: `QR Code for ${title}`,
          url: result.uri,
          dialogTitle: 'Share QR Code'
        });

        // Add haptic feedback
        await Haptics.impact({ style: ImpactStyle.Medium });
        await showToast('📤 QR Code shared!');

        // console.log('✅ QR Code shared successfully');

      } else {
        // Web fallback
        const blob = dataURLToBlob(dataURL);
        const file = new File([blob], fileName, { type: 'image/png' });

        if (navigator.share && navigator.canShare?.({ files: [file] })) {
          await navigator.share({
            title: `QR Code - ${title}`,
            text: `QR Code for ${title}`,
            files: [file]
          });
        } else if (navigator.clipboard && 'write' in navigator.clipboard) {
          await navigator.clipboard.write([
            new ClipboardItem({
              'image/png': blob
            })
          ]);
          copySuccess = true;
          setTimeout(() => {
            copySuccess = false;
          }, 2000);
        } else {
          // Final fallback: download the image
          downloadQRCode();
        }
      }
    } catch (error) {
      console.error('❌ Share error:', error);
      await showToast(`❌ Share failed: ${error.message}`);
      // Fallback to download
      downloadQRCode();
    } finally {
      isSharing = false;
    }
  }

  // Download QR code - Capacitor native or web fallback
  async function downloadQRCode() {
    if (!qrcode) return;

    isDownloading = true;

    try {
      const dataURL = qrcode.toDataURL(8);
      const fileName = `QR_${title.replace(/[^a-z0-9]/gi, '_')}_${Date.now()}.png`;

      if (isNativePlatform) {
        // Native download using Capacitor Filesystem
        const base64Data = dataURL.replace(/^data:image\/png;base64,/, '');

        try {
          let result;
          let savedLocation = '';

          if (Capacitor.getPlatform() === 'android') {
            // Android: Try different approaches
            try {
              // First try: External storage with subdirectory
              result = await Filesystem.writeFile({
                path: `Download/${fileName}`,
                data: base64Data,
                directory: Directory.ExternalStorage,
                recursive: true
              });
              savedLocation = 'Downloads folder';
            } catch (androidError) {
              // console.log('External storage failed, trying Documents:', androidError);
              // Fallback: Documents directory
              result = await Filesystem.writeFile({
                path: fileName,
                data: base64Data,
                directory: Directory.Documents
              });
              savedLocation = 'Documents folder';
            }
          } else if (Capacitor.getPlatform() === 'ios') {
            // iOS: Save to Documents directory (accessible via Files app)
            result = await Filesystem.writeFile({
              path: fileName,
              data: base64Data,
              directory: Directory.Documents
            });
            savedLocation = 'Files App → On My iPhone → [Your App]';
          } else {
            // Other platforms
            result = await Filesystem.writeFile({
              path: fileName,
              data: base64Data,
              directory: Directory.Documents
            });
            savedLocation = 'Documents';
          }

          // Success feedback
          await Haptics.impact({ style: ImpactStyle.Medium });
          await showToast(`✅ QR saved to ${savedLocation}`);

          // console.log('✅ File saved successfully!');
          // console.log('📁 Path:', result.uri);
          // console.log('📱 Platform:', Capacitor.getPlatform());

        } catch (primaryError) {
          console.error('Primary save failed:', primaryError);

          // Emergency fallback: Cache directory
          try {
            const cacheResult = await Filesystem.writeFile({
              path: fileName,
              data: base64Data,
              directory: Directory.Cache
            });

            await Haptics.impact({ style: ImpactStyle.Light });
            await showToast('⚠️ QR saved to app cache (temporary)');
            // console.log('📦 Fallback: File saved to cache:', cacheResult.uri);

          } catch (cacheError) {
            console.error('❌ All save methods failed:', cacheError);
            throw new Error(`Storage failed: ${primaryError.message}`);
          }
        }
      } else {
        // Web download fallback
        const link = document.createElement('a');
        link.download = fileName;
        link.href = dataURL;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);

        copySuccess = true;
        setTimeout(() => {
          copySuccess = false;
        }, 2000);
      }
    } catch (error) {
      console.error('❌ Download error:', error);
      await showToast(`❌ Save failed: ${error.message}`);
    } finally {
      isDownloading = false;
    }
  }

  // Copy QR data to clipboard - Capacitor native or web fallback
  async function copyQRData() {
    try {
      if (isNativePlatform) {
        // Native clipboard using Capacitor
        await Clipboard.write({
          string: qrData
        });

        await Haptics.impact({ style: ImpactStyle.Light });
        await showToast('QR data copied to clipboard!');
      } else {
        // Web fallback
        await navigator.clipboard.writeText(qrData);
      }

      copySuccess = true;
      setTimeout(() => {
        copySuccess = false;
      }, 2000);
    } catch (error) {
      console.error('Error copying to clipboard:', error);
      await showToast('Failed to copy QR data');
    }
  }

  // Handle keyboard shortcuts (mainly for web, but works on native with external keyboard)
  function handleShortcut(event: KeyboardEvent) {
    if (event.shiftKey && event.key.toLowerCase() === 'q') {
      event.preventDefault();
      openModal();
    }
    if (event.key === 'Escape' && isModalOpen) {
      event.preventDefault();
      closeModal();
    }
    if (event.key.toLowerCase() === 's' && isModalOpen && qrcode) {
      event.preventDefault();
      shareQRCode();
    }
    if (event.key.toLowerCase() === 'd' && isModalOpen && qrcode) {
      event.preventDefault();
      downloadQRCode();
    }
    if (event.key.toLowerCase() === 'c' && isModalOpen) {
      event.preventDefault();
      copyQRData();
    }
  }

  function handleBackdropClick() {
    closeModal();
  }

  onMount(() => {
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  });
</script>

<style>
  /* Mobile-first responsive animations */
  @keyframes modalEnter {
    0% {
      opacity: 0;
      transform: scale(0.9) translateY(20px);
    }
    100% {
      opacity: 1;
      transform: scale(1) translateY(0px);
    }
  }

  @keyframes modalExit {
    0% {
      opacity: 1;
      transform: scale(1) translateY(0px);
    }
    100% {
      opacity: 0;
      transform: scale(0.95) translateY(15px);
    }
  }

  @keyframes backdropEnter {
    0% {
      opacity: 0;
    }
    100% {
      opacity: 1;
    }
  }

  @keyframes backdropExit {
    0% {
      opacity: 1;
    }
    100% {
      opacity: 0;
    }
  }

  @keyframes qrFloat {
    0%, 100% {
      transform: translateY(0px);
    }
    50% {
      transform: translateY(-2px);
    }
  }

  @keyframes pulseSuccess {
    0%, 100% {
      box-shadow: 0 0 15px rgba(34, 197, 94, 0.3);
    }
    50% {
      box-shadow: 0 0 25px rgba(34, 197, 94, 0.5);
    }
  }

  @keyframes buttonPulse {
    0%, 100% {
      transform: scale(1);
    }
    50% {
      transform: scale(1.05);
    }
  }

  /* Base styles optimized for mobile */
  .modal-enter {
    animation: modalEnter 0.3s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
  }

  .modal-exit {
    animation: modalExit 0.25s cubic-bezier(0.55, 0.055, 0.675, 0.19) forwards;
  }

  .backdrop-enter {
    animation: backdropEnter 0.3s ease-out forwards;
  }

  .backdrop-exit {
    animation: backdropExit 0.25s ease-in forwards;
  }

  .button-hover {
    transition: all 0.2s ease-out;
    -webkit-tap-highlight-color: transparent;
  }

  .button-active {
    animation: buttonPulse 0.3s ease-in-out;
  }

  .exit-button {
    transition: all 0.2s ease-out;
    -webkit-tap-highlight-color: transparent;
  }

  .qr-container {
    animation: qrFloat 4s ease-in-out infinite;
  }

  .success-glow {
    animation: pulseSuccess 1s ease-in-out;
  }

  /* Enhanced effects for larger screens */
  @media (min-width: 768px) {
    .button-hover:hover {
      transform: translateY(-2px) scale(1.03);
    }

    .exit-button:hover {
      transform: scale(1.1) rotate(90deg);
    }

    .qr-container:hover {
      animation-play-state: paused;
      transform: scale(1.02);
    }
  }

  /* Reduced motion for accessibility */
  @media (prefers-reduced-motion: reduce) {
    .modal-enter,
    .modal-exit,
    .qr-container,
    .button-hover,
    .exit-button {
      animation: none !important;
      transition: opacity 0.2s ease !important;
    }
  }

  /* High contrast mode support */
  @media (prefers-contrast: high) {
    .modal-content {
      border: 2px solid;
    }

    .exit-button {
      border: 2px solid;
    }
  }

  /* Safe area handling for mobile devices */
  @supports (padding: max(0px)) {
    .modal-content {
      padding-left: max(1rem, env(safe-area-inset-left));
      padding-right: max(1rem, env(safe-area-inset-right));
      padding-bottom: max(1rem, env(safe-area-inset-bottom));
    }
  }
</style>

<!-- Open Modal Button -->
<button
  onclick={openModal}
  class="button-hover inline-flex items-center gap-2 px-3 py-2 sm:px-4 sm:py-2
         text-xs sm:text-sm font-semibold bg-transparent border-2
         border-yellow-500 dark:border-yellow-400
         text-yellow-600 dark:text-yellow-400 rounded-lg
         hover:bg-yellow-500 hover:dark:bg-yellow-400
         hover:text-white hover:dark:text-gray-900
         active:scale-95 transition-all duration-200
         focus:outline-none focus:ring-2 focus:ring-yellow-500/50
         focus:ring-offset-2 focus:ring-offset-white dark:focus:ring-offset-gray-900
         touch-manipulation select-none"
  aria-label="Show QR Code"
>
  <QrCode class="w-3 h-3 sm:w-4 sm:h-4" />
  <span class="hidden xs:inline">Show QR</span>
  <span class="xs:hidden">QR</span>
</button>

<!-- Modal Content -->
{#if isModalOpen}
  <div class="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
    <!-- Backdrop -->
    <div
      class="absolute inset-0 bg-black/50 dark:bg-black/70 {isClosing ? 'backdrop-exit' : 'backdrop-enter'}"
      onclick={handleBackdropClick}
    ></div>

    <!-- Modal Box -->
    <div
      class="modal-content relative z-10 w-full max-w-sm sm:max-w-md lg:max-w-xl
             bg-white/95 dark:bg-gray-900/95
             text-gray-900 dark:text-gray-100
             shadow-2xl backdrop-blur-sm
             border border-gray-200/80 dark:border-gray-700/80
             rounded-2xl sm:rounded-3xl
             p-4 sm:p-6 lg:p-8
             {isClosing ? 'modal-exit' : 'modal-enter'}
             max-h-[90vh] overflow-y-auto"
      onclick={(e) => e.stopPropagation()}
    >
      <!-- Exit Button -->
      <button
        onclick={closeModal}
        class="exit-button absolute top-3 right-3 sm:top-4 sm:right-4
               w-8 h-8 sm:w-10 sm:h-10 rounded-full
               bg-gradient-to-br from-gray-100 to-gray-200
               dark:from-gray-700 dark:to-gray-800
               hover:from-red-100 hover:to-red-200
               dark:hover:from-red-800 dark:hover:to-red-900
               text-gray-600 dark:text-gray-300
               hover:text-red-600 dark:hover:text-red-300
               active:scale-90
               flex items-center justify-center
               shadow-lg border border-gray-300 dark:border-gray-600
               hover:border-red-300 dark:hover:border-red-600
               focus:outline-none focus:ring-2 focus:ring-red-500/50 focus:ring-offset-2
               focus:ring-offset-white dark:focus:ring-offset-gray-900
               touch-manipulation select-none"
        aria-label="Close modal"
      >
        <X class="w-4 h-4 sm:w-5 sm:h-5" />
      </button>

      <!-- Title -->
      <h3 class="text-lg sm:text-xl lg:text-2xl font-bold mb-4 sm:mb-6 text-center
                 bg-gradient-to-r from-gray-800 to-gray-600
                 dark:from-gray-100 dark:to-gray-300
                 bg-clip-text text-transparent pr-12">
        {title}
      </h3>

      <!-- QR Code Image -->
      {#if qrcode}
        <div class="flex justify-center items-center mb-4 sm:mb-6">
          <div class="qr-container rounded-xl sm:rounded-2xl shadow-2xl overflow-hidden
                      border-2 sm:border-4 border-yellow-400/60 dark:border-yellow-500/60
                      p-1 sm:p-2 bg-gradient-to-br from-yellow-50 to-yellow-100
                      dark:from-yellow-900/20 dark:to-yellow-800/20
                      hover:border-yellow-500/80 dark:hover:border-yellow-400/80
                      transition-colors duration-300">
            <img
              src={qrcode.toDataURL(8)}
              alt="QR Code for {title}"
              class="rounded-lg sm:rounded-xl w-full h-auto block
                     max-w-[240px] sm:max-w-[280px] lg:max-w-[320px]
                     select-none pointer-events-none"
              loading="lazy"
            />
          </div>
        </div>

        <!-- Action Buttons -->
        <div class="flex flex-wrap justify-center gap-2 sm:gap-3 mb-4">
          <!-- Share Button -->
          <button
            onclick={shareQRCode}
            disabled={isSharing}
            class="button-hover flex items-center gap-2 px-3 py-2.5 sm:px-4 sm:py-3
                   text-xs sm:text-sm font-semibold rounded-lg
                   bg-gradient-to-r from-blue-500 to-blue-600
                   hover:from-blue-600 hover:to-blue-700
                   active:scale-95 text-white shadow-lg
                   disabled:opacity-50 disabled:cursor-not-allowed
                   focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:ring-offset-2
                   focus:ring-offset-white dark:focus:ring-offset-gray-900
                   transition-all duration-200 touch-manipulation select-none"
            aria-label="Share QR Code"
          >
            {#if isSharing}
              <div class="animate-spin rounded-full h-3 w-3 sm:h-4 sm:w-4
                          border-2 border-white border-t-transparent"></div>
            {:else}
              <Share2 class="w-3 h-3 sm:w-4 sm:h-4" />
            {/if}
            <span>Share</span>
          </button>

          <!-- Download Button -->
          <button
            onclick={downloadQRCode}
            disabled={isDownloading}
            class="button-hover flex items-center gap-2 px-3 py-2.5 sm:px-4 sm:py-3
                   text-xs sm:text-sm font-semibold rounded-lg
                   bg-gradient-to-r from-green-500 to-green-600
                   hover:from-green-600 hover:to-green-700
                   active:scale-95 text-white shadow-lg
                   disabled:opacity-50 disabled:cursor-not-allowed
                   focus:outline-none focus:ring-2 focus:ring-green-500/50 focus:ring-offset-2
                   focus:ring-offset-white dark:focus:ring-offset-gray-900
                   transition-all duration-200 touch-manipulation select-none"
            aria-label="Download QR Code"
          >
            {#if isDownloading}
              <div class="animate-spin rounded-full h-3 w-3 sm:h-4 sm:w-4
                          border-2 border-white border-t-transparent"></div>
            {:else}
              <Download class="w-3 h-3 sm:w-4 sm:h-4" />
            {/if}
            <span>Save</span>
          </button>

          <!-- Copy Data Button -->
          <button
            onclick={copyQRData}
            class="button-hover flex items-center gap-2 px-3 py-2.5 sm:px-4 sm:py-3
                   text-xs sm:text-sm font-semibold rounded-lg
                   bg-gradient-to-r from-purple-500 to-purple-600
                   hover:from-purple-600 hover:to-purple-700
                   active:scale-95 text-white shadow-lg
                   focus:outline-none focus:ring-2 focus:ring-purple-500/50 focus:ring-offset-2
                   focus:ring-offset-white dark:focus:ring-offset-gray-900
                   transition-all duration-200 touch-manipulation select-none
                   {copySuccess ? 'success-glow' : ''}"
            aria-label="Copy QR Data"
          >
            {#if copySuccess}
              <Check class="w-3 h-3 sm:w-4 sm:h-4" />
            {:else}
              <Copy class="w-3 h-3 sm:w-4 sm:h-4" />
            {/if}
            <span>{copySuccess ? 'Copied!' : 'Copy'}</span>
          </button>
        </div>

        <!-- Instructions -->
        <div class="text-center space-y-2">
          <p class="text-xs sm:text-sm text-gray-600 dark:text-gray-400">
            Scan with your device camera or QR reader
          </p>

          <!-- Show keyboard shortcuts only on non-mobile or when external keyboard detected -->
          {#if !isNativePlatform}
            <div class="flex flex-wrap justify-center gap-1 sm:gap-2 text-xs text-gray-500 dark:text-gray-500">
              <div class="flex items-center gap-1">
                <kbd class="px-1 py-0.5 bg-gray-200 dark:bg-gray-700 rounded text-xs font-mono">S</kbd>
                <span>Share</span>
              </div>
              <div class="flex items-center gap-1">
                <kbd class="px-1 py-0.5 bg-gray-200 dark:bg-gray-700 rounded text-xs font-mono">D</kbd>
                <span>Save</span>
              </div>
              <div class="flex items-center gap-1">
                <kbd class="px-1 py-0.5 bg-gray-200 dark:bg-gray-700 rounded text-xs font-mono">C</kbd>
                <span>Copy</span>
              </div>
              <div class="flex items-center gap-1">
                <kbd class="px-1 py-0.5 bg-gray-200 dark:bg-gray-700 rounded text-xs font-mono">Esc</kbd>
                <span>Close</span>
              </div>
            </div>
          {/if}
        </div>
      {:else}
        <div class="flex justify-center items-center h-48 sm:h-64 lg:h-80">
          <div class="flex flex-col items-center space-y-3 sm:space-y-4">
            <div class="animate-spin rounded-full h-8 w-8 sm:h-12 sm:w-12
                        border-2 sm:border-4 border-yellow-400 dark:border-yellow-500
                        border-t-transparent"></div>
            <div class="text-sm sm:text-base text-gray-500 dark:text-gray-400">
              Generating QR code...
            </div>
          </div>
        </div>
      {/if}
    </div>
  </div>
{/if}