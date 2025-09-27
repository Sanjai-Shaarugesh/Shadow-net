<script lang="ts">
  import QrScanner from 'qr-scanner';
  import { onMount, onDestroy } from 'svelte';
  import { ScanLine, ScanQrCode, Camera, RotateCcw, Upload, Image as ImageIcon, Sun, Moon, Zap, Flashlight, Smartphone, Monitor, Package } from '@lucide/svelte';

  interface Props {
    onScanSuccess: (data: string) => void;
    buttonText?: string;
    modalTitle?: string;
    autoStart?: boolean;
    continuousScanning?: boolean;
    allowImageUpload?: boolean;
    theme?: 'light' | 'dark' | 'auto';
  }

  let {
    onScanSuccess,
    buttonText = 'Scan QR Code',
    modalTitle = 'Scan QR Code',
    autoStart = false,
    continuousScanning = false,
    allowImageUpload = true,
    theme = 'auto'
  }: Props = $props();

  // Core state - Fixed: Proper initialization without mutations
  let isModalOpen = $state(false);
  let qrScanner = $state<QrScanner | null>(null);
  let videoElement = $state<HTMLVideoElement | null>(null);
  let isCameraActive = $state(false);
  let errorMessage = $state('');
  let permissionRequested = $state(false);
  let isScanning = $state(false);
  let scanCount = $state(0);
  let lastScanTime = $state(0);
  let availableCameras = $state<QrScanner.Camera[]>([]);
  let currentCameraIndex = $state(0);
  let isFlipped = $state(false);
  let scanningIndicator = $state(false);

  // Image upload state
  let fileInput = $state<HTMLInputElement | null>(null);
  let isProcessingImage = $state(false);
  let uploadedImageUrl = $state<string | null>(null);
  let scanMode = $state<'camera' | 'image'>('camera');

  // Enhanced platform detection
  let platform = $state<'browser' | 'electron' | 'flatpak' | 'appimage' | 'snap' | 'deb' | 'rpm' | 'mobile' | 'tauri'>('browser');
  let deviceType = $state<'desktop' | 'tablet' | 'mobile'>('desktop');
  let operatingSystem = $state<'windows' | 'macos' | 'linux' | 'android' | 'ios' | 'unknown'>('unknown');
  let currentTheme = $state<'light' | 'dark'>('light');
  let hasFlashlight = $state(false);
  let isFlashlightOn = $state(false);
  let nativePermissionStatus = $state<'granted' | 'denied' | 'prompt' | 'unknown'>('unknown');
  let isLandscape = $state(false);
  let isCapacitor = $state(false);

  // Enhanced mobile detection
  let isSamsungDevice = $state(false);
  let isOneUI = $state(false);
  let samsungCameraWorkaround = $state(false);
  let androidVersion = $state(0);
  let chromeVersion = $state(0);
  let isMiui = $state(false);
  let isColorOS = $state(false);
  let isHarmonyOS = $state(false);

  // Native integration
  let electronAPI = $state<any>(null);
  let tauriAPI = $state<any>(null);
  let nativeStreamConstraints = $state<MediaStreamConstraints | null>(null);
  let supportedConstraints = $state<MediaTrackSupportedConstraints | null>(null);

  // Mobile optimizations
  let screenDimensions = $state({ width: 0, height: 0 });
  let isMobileSafari = $state(false);
  let isWebView = $state(false);
  let pixelRatio = $state(1);

  // Linux-specific detection
  let linuxDistro = $state<string>('unknown');
  let desktopEnvironment = $state<string>('unknown');
  let waylandSession = $state(false);
  let x11Session = $state(false);

  // Enhanced scanner configuration - Fixed: Use $derived properly
  let scannerConfig = $derived(() => ({
    highlightScanRegion: true,
    highlightCodeOutline: true,
    preferredCamera: getPreferredCamera(),
    maxScansPerSecond: getOptimalScanRate(),
    calculateScanRegion: (video: HTMLVideoElement) => {
      const devicePixelRatio = Math.min(pixelRatio, 2);
      const smallerDimension = Math.min(video.videoWidth, video.videoHeight);
      const scanRegionSize = Math.round(getScanRegionMultiplier() * smallerDimension);

      return {
        x: Math.round((video.videoWidth - scanRegionSize) / 2),
        y: Math.round((video.videoHeight - scanRegionSize) / 2),
        width: scanRegionSize,
        height: scanRegionSize,
        downScaledWidth: Math.round(getDownscaleWidth() * devicePixelRatio),
        downScaledHeight: Math.round(getDownscaleHeight() * devicePixelRatio),
      };
    },
    returnDetailedScanResult: false,
    highlightCodeOutlineColor: currentTheme === 'dark' ? '#00ff88' : '#00aa44',
    highlightScanRegionColor: currentTheme === 'dark' ? 'rgba(0, 255, 136, 0.15)' : 'rgba(0, 170, 68, 0.15)',
  }));

  function getScanRegionMultiplier(): number {
    if (isSamsungDevice && samsungCameraWorkaround) return 0.65;
    if (isCapacitor) return 0.7;
    if (deviceType === 'mobile') return 0.75;
    return 0.8;
  }

  function getDownscaleWidth(): number {
    if (isSamsungDevice) return 350;
    if (isCapacitor && deviceType === 'mobile') return 400;
    if (deviceType === 'mobile') return 450;
    if (platform === 'flatpak') return 500;
    return 600;
  }

  function getDownscaleHeight(): number {
    return getDownscaleWidth();
  }

  function getPreferredCamera(): string {
    if (availableCameras.length === 0) return 'environment';

    // Samsung-specific camera detection
    if (isSamsungDevice) {
      const backCameras = availableCameras.filter(camera => {
        const label = camera.label.toLowerCase();
        return label.includes('back') ||
               label.includes('rear') ||
               label.includes('environment') ||
               label.includes('camera2 0') || // Samsung Camera2 API
               label.includes('camera 0') ||
               (label.includes('camera') && !label.includes('front'));
      });

      if (backCameras.length > 0) {
        // Prefer the first back camera found
        const camera = backCameras[0];
        const originalIndex = availableCameras.findIndex(cam => cam.id === camera.id);
        if (originalIndex !== -1) {
          currentCameraIndex = originalIndex;
          return camera.id;
        }
      }
    }

    // Filter unique cameras for all devices
    const uniqueCameras = filterUniqueCameras(availableCameras);

    // Standard back camera detection
    const backCamera = uniqueCameras.find(camera =>
      camera.label.toLowerCase().includes('back') ||
      camera.label.toLowerCase().includes('rear') ||
      camera.label.toLowerCase().includes('environment') ||
      camera.id === 'environment'
    );

    if (backCamera) {
      const originalIndex = availableCameras.findIndex(cam => cam.id === backCamera.id);
      if (originalIndex !== -1) {
        currentCameraIndex = originalIndex;
        return backCamera.id;
      }
    }

    // Fallback
    return 'environment';
  }

  function filterUniqueCameras(cameras: QrScanner.Camera[]): QrScanner.Camera[] {
    if (!isSamsungDevice && !isCapacitor) return cameras;

    const seen = new Set<string>();
    const unique: QrScanner.Camera[] = [];

    for (const camera of cameras) {
      let key: string;

      if (isSamsungDevice) {
        // Samsung-specific deduplication
        key = `${camera.label.toLowerCase().replace(/\s+/g, '')}-${getFacingMode(camera)}`;
      } else {
        // Standard deduplication
        key = `${camera.label.toLowerCase().trim()}-${getFacingMode(camera)}`;
      }

      if (!seen.has(key)) {
        seen.add(key);
        unique.push(camera);
      }
    }

    // console.log(`Camera deduplication: ${cameras.length} → ${unique.length}`, { isSamsungDevice, isCapacitor });
    return unique;
  }

  function getFacingMode(camera: QrScanner.Camera): string {
    const label = camera.label.toLowerCase();
    if (label.includes('back') || label.includes('rear') || label.includes('environment') || label.includes('camera2 0') || label.includes('camera 0')) {
      return 'environment';
    }
    if (label.includes('front') || label.includes('user') || label.includes('facing') || label.includes('camera2 1') || label.includes('camera 1')) {
      return 'user';
    }
    return 'unknown';
  }

  function getOptimalScanRate(): number {
    if (isSamsungDevice && samsungCameraWorkaround) return 10;
    if (isCapacitor && deviceType === 'mobile') return 15;
    if (platform === 'flatpak') return 20;
    if (platform === 'snap') return 18;
    if (platform === 'appimage') return 25;
    if (platform === 'mobile' || deviceType === 'mobile') return 25;
    if (platform === 'electron') return 35;
    if (platform === 'tauri') return 40;
    return 45;
  }

  // Theme classes - Fixed: Use $derived properly
  let themeClasses = $derived(() => ({
    modal: currentTheme === 'dark' ? 'bg-base-300/95 backdrop-blur-xl border border-base-content/20 shadow-2xl' : 'bg-base-100/95 backdrop-blur-xl border border-base-content/20 shadow-2xl',
    card: currentTheme === 'dark' ? 'bg-base-200/50 backdrop-blur-md border border-base-content/30' : 'bg-base-100/50 backdrop-blur-md border border-base-content/30',
    button: currentTheme === 'dark' ? 'bg-base-content/15 hover:bg-base-content/25 backdrop-blur-sm border border-base-content/30' : 'bg-base-content/10 hover:bg-base-content/20 backdrop-blur-sm border border-base-content/30',
    text: currentTheme === 'dark' ? 'text-base-content' : 'text-base-content',
    accent: currentTheme === 'dark' ? 'text-accent' : 'text-primary'
  }));

  // Responsive modal size - Fixed: Use $derived properly
  let modalSize = $derived(() => {
    if (deviceType === 'mobile') {
      return isLandscape ? 'w-full max-w-2xl mx-2' : 'w-full max-w-sm mx-2';
    }
    if (deviceType === 'tablet') return 'w-full max-w-md mx-4';
    return 'w-full max-w-lg mx-8';
  });

  onMount(async () => {
    await initializePlatformDetection();
    await initializeNativeIntegrations();
    initializeTheme();
    setupResponsiveHandlers();
    await setupCameraSystem();
    setupPlatformEventListeners();

    if (autoStart) {
      toggleModal(true);
    }

    return () => cleanupAll();
  });

  onDestroy(() => cleanupAll());

  async function initializePlatformDetection() {
    if (typeof window === 'undefined') return;

    // Fixed: Batch state updates to avoid mutations
    const newScreenDimensions = { width: window.innerWidth, height: window.innerHeight };
    const newPixelRatio = window.devicePixelRatio || 1;

    const userAgent = navigator.userAgent.toLowerCase();
    const platform_info = navigator.platform?.toLowerCase() || '';

    // Enhanced mobile detection
    const isMobile = /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini/i.test(userAgent);
    const isTablet = /ipad|android(?!.*mobile)/i.test(userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

    // Samsung device detection
    const newIsSamsungDevice = /samsung/i.test(userAgent) || /sm-/i.test(userAgent) || /galaxy/i.test(userAgent);
    const newIsOneUI = newIsSamsungDevice && (/samsungbrowser/i.test(userAgent) || /wv/i.test(userAgent));

    // Other Android OEM detection
    const newIsMiui = /miui/i.test(userAgent) || /xiaomi/i.test(userAgent);
    const newIsColorOS = /oppo|oneplus|realme|coloros/i.test(userAgent);
    const newIsHarmonyOS = /harmonyos|huawei/i.test(userAgent);

    // Android version detection
    const androidMatch = userAgent.match(/android (\d+\.?\d*)/i);
    const newAndroidVersion = androidMatch ? parseFloat(androidMatch[1]) : 0;

    // Chrome version detection
    const chromeMatch = userAgent.match(/chrome\/(\d+)/i);
    const newChromeVersion = chromeMatch ? parseInt(chromeMatch[1]) : 0;

    // Samsung camera workaround detection
    const newSamsungCameraWorkaround = newIsSamsungDevice && (newAndroidVersion >= 10 || newChromeVersion >= 80);

    // Capacitor detection
    const newIsCapacitor = !!(window as any).Capacitor;
    const newIsWebView = !!(window as any).webkit?.messageHandlers || !!(window as any).chrome?.webview || newIsCapacitor;
    const newIsMobileSafari = /iphone|ipad|ipod/i.test(userAgent) && /safari/i.test(userAgent) && !/chrome|crios|fxios/i.test(userAgent);

    const newDeviceType = isMobile ? 'mobile' : isTablet ? 'tablet' : 'desktop';

    // OS Detection
    let newOperatingSystem: typeof operatingSystem = 'unknown';
    if (/android/i.test(userAgent)) newOperatingSystem = 'android';
    else if (/iphone|ipad|ipod/i.test(userAgent)) newOperatingSystem = 'ios';
    else if (/mac/i.test(userAgent)) newOperatingSystem = 'macos';
    else if (/win/i.test(userAgent)) newOperatingSystem = 'windows';
    else if (/linux/i.test(userAgent)) newOperatingSystem = 'linux';

    // Platform detection with enhanced Linux support
    let newPlatform: typeof platform = 'browser';
    if ((window as any).__TAURI__) {
      tauriAPI = (window as any).__TAURI__;
      newPlatform = 'tauri';
    } else if (window.electronAPI || (window as any).require) {
      electronAPI = window.electronAPI || (window as any).require?.('electron');

      // Detect Linux package type
      if (newOperatingSystem === 'linux') {
        newPlatform = await detectLinuxPackageType();
      } else {
        newPlatform = 'electron';
      }
    } else if (newDeviceType === 'mobile' || newIsCapacitor) {
      newPlatform = 'mobile';
    } else {
      newPlatform = 'browser';
    }

    // Fixed: Update all state at once to avoid mutations
    screenDimensions = newScreenDimensions;
    pixelRatio = newPixelRatio;
    isSamsungDevice = newIsSamsungDevice;
    isOneUI = newIsOneUI;
    isMiui = newIsMiui;
    isColorOS = newIsColorOS;
    isHarmonyOS = newIsHarmonyOS;
    androidVersion = newAndroidVersion;
    chromeVersion = newChromeVersion;
    samsungCameraWorkaround = newSamsungCameraWorkaround;
    isCapacitor = newIsCapacitor;
    isWebView = newIsWebView;
    isMobileSafari = newIsMobileSafari;
    deviceType = newDeviceType;
    operatingSystem = newOperatingSystem;
    platform = newPlatform;

    // Linux environment detection
    if (newOperatingSystem === 'linux') {
      await detectLinuxEnvironment();
    }

    // console.log('Enhanced Platform Detection:', {
    //   platform: newPlatform,
    //   deviceType: newDeviceType,
    //   operatingSystem: newOperatingSystem,
    //   isSamsungDevice: newIsSamsungDevice,
    //   isOneUI: newIsOneUI,
    //   samsungCameraWorkaround: newSamsungCameraWorkaround,
    //   androidVersion: newAndroidVersion,
    //   chromeVersion: newChromeVersion,
    //   isCapacitor: newIsCapacitor,
    //   isWebView: newIsWebView,
    //   isMobileSafari: newIsMobileSafari,
    //   linuxDistro,
    //   desktopEnvironment,
    //   waylandSession,
    //   screenDimensions: newScreenDimensions,
    //   pixelRatio: newPixelRatio
    // });
  }

  async function detectLinuxPackageType(): Promise<typeof platform> {
    try {
      if (electronAPI?.ipcRenderer) {
        const packageInfo = await electronAPI.ipcRenderer.invoke('detect-package-type');
        if (packageInfo?.type) {
          linuxDistro = packageInfo.distro || 'unknown';
          return packageInfo.type; // 'flatpak', 'snap', 'appimage', 'deb', 'rpm'
        }
      }

      // Fallback detection
      const processEnv = (window as any).process?.env || {};
      if (processEnv.FLATPAK_ID || processEnv.FLATPAK_DEST) return 'flatpak';
      if (processEnv.SNAP || processEnv.SNAP_NAME) return 'snap';
      if (processEnv.APPIMAGE || processEnv.APPDIR) return 'appimage';

    } catch (e) {
      console.warn('Could not detect Linux package type:', e);
    }
    return 'electron';
  }

  async function detectLinuxEnvironment() {
    try {
      if (electronAPI?.ipcRenderer) {
        const envInfo = await electronAPI.ipcRenderer.invoke('detect-linux-environment');
        if (envInfo) {
          desktopEnvironment = envInfo.desktop || 'unknown';
          waylandSession = envInfo.wayland || false;
          x11Session = envInfo.x11 || false;
        }
      }
    } catch (e) {
      console.warn('Could not detect Linux environment:', e);
    }
  }

  async function initializeNativeIntegrations() {
    if (platform === 'electron' || platform === 'flatpak' || platform === 'snap' || platform === 'appimage' || platform === 'deb' || platform === 'rpm') {
      await setupElectronIntegration();
    } else if (platform === 'tauri') {
      await setupTauriIntegration();
    }

    if (navigator.mediaDevices) {
      supportedConstraints = navigator.mediaDevices.getSupportedConstraints();
    }
  }

  async function setupElectronIntegration() {
    if (!electronAPI?.ipcRenderer) return;

    try {
      // Request camera permission with platform info
      const permissionResult = await electronAPI.ipcRenderer.invoke('request-camera-permission', {
        platform,
        operatingSystem,
        linuxDistro,
        desktopEnvironment,
        waylandSession
      });
      nativePermissionStatus = permissionResult?.status || 'unknown';

      // Platform-specific setup
      if (platform === 'flatpak') {
        await setupFlatpakIntegration();
      } else if (platform === 'snap') {
        await setupSnapIntegration();
      } else if (platform === 'appimage') {
        await setupAppImageIntegration();
      }

      // Get optimal camera constraints
      nativeStreamConstraints = await electronAPI.ipcRenderer.invoke('get-optimal-camera-constraints', {
        platform,
        deviceType,
        operatingSystem,
        linuxDistro,
        desktopEnvironment,
        waylandSession
      });

    } catch (error) {
      console.warn('Electron integration setup failed:', error);
      handleNativeIntegrationError(error);
    }
  }

  async function setupTauriIntegration() {
    if (!tauriAPI) return;

    try {
      // Tauri camera permission
      const permissionResult = await tauriAPI.invoke('request_camera_permission', {
        platform: 'tauri',
        os: operatingSystem
      });
      nativePermissionStatus = permissionResult?.status || 'unknown';

      nativeStreamConstraints = await tauriAPI.invoke('get_camera_constraints', {
        platform: 'tauri',
        device_type: deviceType,
        os: operatingSystem
      });

    } catch (error) {
      console.warn('Tauri integration setup failed:', error);
      handleNativeIntegrationError(error);
    }
  }

  async function setupFlatpakIntegration() {
    if (!electronAPI?.ipcRenderer) return;

    try {
      const flatpakPerms = await electronAPI.ipcRenderer.invoke('check-flatpak-permissions');
      if (!flatpakPerms?.camera) {
        const granted = await electronAPI.ipcRenderer.invoke('request-flatpak-camera-permission');
        if (!granted) {
          errorMessage = 'Flatpak camera permission required. Please grant camera access in Flatseal or run:\nflatpak permission-set camera com.yourapp.name yes';
          return;
        }
      }

      // Flatpak-optimized constraints
      nativeStreamConstraints = {
        video: {
          width: { ideal: 1280, min: 640 },
          height: { ideal: 720, min: 480 },
          frameRate: { ideal: 20, min: 10, max: 25 },
          facingMode: 'environment'
        }
      };
    } catch (error) {
      console.warn('Flatpak integration failed:', error);
      errorMessage = `Flatpak camera setup failed: ${error.message}. Check permissions and portal access.`;
    }
  }

  async function setupSnapIntegration() {
    if (!electronAPI?.ipcRenderer) return;

    try {
      const snapPerms = await electronAPI.ipcRenderer.invoke('check-snap-permissions');
      if (!snapPerms?.camera) {
        errorMessage = 'Snap camera permission required. Please connect camera interface:\nsudo snap connect yourapp:camera';
        return;
      }

      nativeStreamConstraints = {
        video: {
          width: { ideal: 1280, min: 640 },
          height: { ideal: 720, min: 480 },
          frameRate: { ideal: 18, min: 10, max: 25 },
          facingMode: 'environment'
        }
      };
    } catch (error) {
      console.warn('Snap integration failed:', error);
      errorMessage = `Snap camera setup failed: ${error.message}`;
    }
  }

  async function setupAppImageIntegration() {
    // AppImage has no special permission system, use standard constraints
    nativeStreamConstraints = {
      video: {
        width: { ideal: 1920, min: 640 },
        height: { ideal: 1080, min: 480 },
        frameRate: { ideal: 25, min: 15, max: 30 },
        facingMode: 'environment'
      }
    };
  }

  function handleNativeIntegrationError(error: any) {
    const errorMsg = error?.message || String(error);

    switch (platform) {
      case 'flatpak':
        errorMessage = `Flatpak integration error: ${errorMsg}. Check camera portal access and permissions.`;
        break;
      case 'snap':
        errorMessage = `Snap integration error: ${errorMsg}. Connect camera interface with: sudo snap connect yourapp:camera`;
        break;
      case 'appimage':
        errorMessage = `AppImage integration error: ${errorMsg}. Check system camera permissions.`;
        break;
      case 'tauri':
        errorMessage = `Tauri integration error: ${errorMsg}. Check native module setup.`;
        break;
      default:
        errorMessage = `Electron integration error: ${errorMsg}. Check native module dependencies.`;
    }
  }

  function initializeTheme() {
    if (theme === 'auto') {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      currentTheme = mediaQuery.matches ? 'dark' : 'light';
      mediaQuery.addEventListener('change', (e) => {
        currentTheme = e.matches ? 'dark' : 'light';
        updateDocumentTheme();
      });
    } else {
      currentTheme = theme;
    }
    updateDocumentTheme();
  }

  function updateDocumentTheme() {
    document.documentElement.setAttribute('data-theme', currentTheme);
    if (deviceType === 'mobile') {
      updateMobileViewport();
    }
  }

  function updateMobileViewport() {
    let viewport = document.querySelector('meta[name="viewport"]');
    if (!viewport) {
      viewport = document.createElement('meta');
      viewport.setAttribute('name', 'viewport');
      document.head.appendChild(viewport);
    }

    let content = 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no';

    // Samsung-specific viewport adjustments
    if (isSamsungDevice && isOneUI) {
      content += ', viewport-fit=cover, shrink-to-fit=no';
    } else if (isCapacitor) {
      content += ', viewport-fit=cover';
    }

    viewport.setAttribute('content', content);
  }

  function setupResponsiveHandlers() {
    if (typeof window === 'undefined') return;

    const handleOrientationChange = () => {
      screenDimensions = { width: window.innerWidth, height: window.innerHeight };
      isLandscape = window.matchMedia('(orientation: landscape)').matches;

      if (deviceType === 'mobile' && isModalOpen && isCameraActive) {
        // Restart scanner after orientation change with Samsung-specific delay
        const delay = isSamsungDevice ? 500 : 300;
        setTimeout(() => restartScanner(), delay);
      }
    };

    const handleResize = () => {
      screenDimensions = { width: window.innerWidth, height: window.innerHeight };
    };

    window.addEventListener('orientationchange', handleOrientationChange);
    window.addEventListener('resize', handleResize);

    // Samsung-specific event listeners
    if (isSamsungDevice) {
      document.addEventListener('webkitfullscreenchange', handleOrientationChange);
      document.addEventListener('fullscreenchange', handleOrientationChange);
    }

    handleOrientationChange();
  }

  async function setupCameraSystem() {
    try {
      // Enhanced camera listing with Samsung workarounds
      const newAvailableCameras = await listCamerasWithRetry();

      if (isSamsungDevice || isCapacitor || deviceType === 'mobile') {
        const uniqueCameras = filterUniqueCameras(newAvailableCameras);
        // console.log(`Camera filtering - Original: ${newAvailableCameras.length}, Unique: ${uniqueCameras.length}`, {
        //   isSamsungDevice,
        //   samsungCameraWorkaround,
        //   isOneUI
        // });

        // Update available cameras list to only include unique ones
        availableCameras = newAvailableCameras.filter(camera =>
          uniqueCameras.some(unique => unique.id === camera.id)
        );
      } else {
        availableCameras = newAvailableCameras;
      }

      if (availableCameras.length > 0) {
        getPreferredCamera();
        await checkFlashlightSupport();
      }

      // console.log('Camera system setup complete:', {
      //   totalCameras: availableCameras.length,
      //   currentIndex: currentCameraIndex,
      //   isSamsungDevice,
      //   samsungCameraWorkaround,
      //   isCapacitor,
      //   preferredCamera: getPreferredCamera()
      // });

    } catch (error) {
      console.warn('Camera system setup failed:', error);
      handleCameraSystemError(error);
    }
  }

  async function listCamerasWithRetry(maxRetries: number = 3): Promise<QrScanner.Camera[]> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const cameras = await QrScanner.listCameras(true);
        if (cameras.length > 0 || attempt === maxRetries) {
          return cameras;
        }
      } catch (error) {
        console.warn(`Camera listing attempt ${attempt} failed:`, error);
        if (attempt === maxRetries) throw error;
      }

      // Progressive delay for Samsung devices
      const delay = isSamsungDevice ? attempt * 1000 : attempt * 500;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
    return [];
  }

  function handleCameraSystemError(error: any) {
    const errorMsg = error?.message || String(error);

    if (platform === 'flatpak') {
      errorMessage = `Flatpak camera access error: ${errorMsg}. Check permissions and hardware access.`;
    } else if (platform === 'snap') {
      errorMessage = `Snap camera access error: ${errorMsg}. Connect camera interface: sudo snap connect yourapp:camera`;
    } else if (platform === 'mobile' && isSamsungDevice) {
      errorMessage = `Samsung device camera error: ${errorMsg}. Try restarting the browser or clearing camera permissions.`;
    } else if (platform === 'mobile') {
      errorMessage = `Mobile camera error: ${errorMsg}. Check browser permissions and camera availability.`;
    } else if (platform === 'electron' || platform === 'tauri') {
      errorMessage = `Native camera error: ${errorMsg}. Check system permissions and camera drivers.`;
    } else {
      errorMessage = `Camera error: ${errorMsg}`;
    }
  }

  function setupPlatformEventListeners() {
    // Electron/Tauri event listeners
    if ((platform === 'electron' || platform === 'flatpak' || platform === 'snap' || platform === 'appimage' || platform === 'deb' || platform === 'rpm') && electronAPI?.ipcRenderer) {
      electronAPI.ipcRenderer.on('auto-open-qr-scanner', () => toggleModal(true));
      electronAPI.ipcRenderer.on('camera-permission-changed', (_: any, data: any) => {
        nativePermissionStatus = data.status;
        if (data.status === 'granted' && isModalOpen && !isCameraActive) {
          startScanner();
        }
      });

      // Platform-specific listeners
      if (platform === 'flatpak') {
        electronAPI.ipcRenderer.on('flatpak-permission-granted', () => {
          if (isModalOpen && scanMode === 'camera') startScanner();
        });
      } else if (platform === 'snap') {
        electronAPI.ipcRenderer.on('snap-interface-connected', () => {
          if (isModalOpen && scanMode === 'camera') startScanner();
        });
      }
    }

    // Tauri event listeners
    if (platform === 'tauri' && tauriAPI) {
      tauriAPI.listen('camera-permission-changed', (data: any) => {
        nativePermissionStatus = data.payload.status;
        if (data.payload.status === 'granted' && isModalOpen && !isCameraActive) {
          startScanner();
        }
      });
    }

    // Mobile/Capacitor event listeners
    if (deviceType === 'mobile') {
      document.addEventListener('visibilitychange', () => {
        if (document.hidden && isCameraActive) {
          pauseScanner();
        } else if (!document.hidden && isModalOpen && scanMode === 'camera') {
          const delay = isSamsungDevice ? 200 : 100;
          setTimeout(() => resumeScanner(), delay);
        }
      });

      // Capacitor-specific listeners
      if (isCapacitor && (window as any).Capacitor?.Plugins?.App) {
        (window as any).Capacitor.Plugins.App.addListener('appStateChange', (state: any) => {
          if (state.isActive && isModalOpen && scanMode === 'camera' && !isCameraActive) {
            const delay = isSamsungDevice ? 300 : 200;
            setTimeout(() => resumeScanner(), delay);
          }
        });

        // Samsung-specific Capacitor listeners
        if (isSamsungDevice && (window as any).Capacitor?.Plugins?.Device) {
          (window as any).Capacitor.Plugins.Device.addListener('orientationChange', () => {
            if (isModalOpen && isCameraActive) {
              setTimeout(() => restartScanner(), 600);
            }
          });
        }
      }

      // Samsung One UI specific listeners
      if (isSamsungDevice && isOneUI) {
        window.addEventListener('focus', () => {
          if (isModalOpen && scanMode === 'camera' && !isCameraActive) {
            setTimeout(() => resumeScanner(), 400);
          }
        });
      }
    }
  }

  async function checkFlashlightSupport() {
    try {
      const constraints = getNativeConstraints();
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      const videoTrack = stream.getVideoTracks()[0];

      // Enhanced flashlight detection for Samsung devices
      if (isSamsungDevice) {
        const capabilities = videoTrack.getCapabilities();
        hasFlashlight = !!(capabilities.torch || capabilities.fillLightMode);
      } else {
        hasFlashlight = !!videoTrack.getCapabilities().torch;
      }

      stream.getTracks().forEach(track => track.stop());
    } catch (e) {
      hasFlashlight = false;
      console.warn('Could not check flashlight support:', e);
    }
  }

  function getNativeConstraints(): MediaStreamConstraints {
    const baseConstraints = {
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: getOptimalWidth(), min: 640 },
        height: { ideal: getOptimalHeight(), min: 480 },
        frameRate: { ideal: getOptimalScanRate(), min: 10, max: 30 }
      }
    };

    // Apply native constraints from platform integrations
    if (nativeStreamConstraints?.video) {
      Object.assign(baseConstraints.video, nativeStreamConstraints.video);
    }

    // Apply platform-specific constraints
    Object.assign(baseConstraints.video, getPlatformSpecificConstraints());

    return baseConstraints;
  }

  function getOptimalWidth(): number {
    if (isSamsungDevice && samsungCameraWorkaround) return isLandscape ? 1280 : 720;
    if (isCapacitor && deviceType === 'mobile') return isLandscape ? 1280 : 720;
    if (platform === 'flatpak') return 1280;
    if (platform === 'snap') return 1280;
    if (deviceType === 'mobile') return isLandscape ? 1920 : 1080;
    if (platform === 'electron' || platform === 'tauri') return 1920;
    return 1920;
  }

  function getOptimalHeight(): number {
    if (isSamsungDevice && samsungCameraWorkaround) return isLandscape ? 720 : 1280;
    if (isCapacitor && deviceType === 'mobile') return isLandscape ? 720 : 1280;
    if (platform === 'flatpak') return 720;
    if (platform === 'snap') return 720;
    if (deviceType === 'mobile') return isLandscape ? 1080 : 1920;
    if (platform === 'electron' || platform === 'tauri') return 1080;
    return 1080;
  }

  function getPlatformSpecificConstraints(): any {
    const constraints: any = {};

    // Apply supported constraints
    if (supportedConstraints) {
      if (supportedConstraints.focusMode) constraints.focusMode = 'continuous';
      if (supportedConstraints.exposureMode) constraints.exposureMode = 'continuous';
      if (supportedConstraints.whiteBalanceMode) constraints.whiteBalanceMode = 'continuous';
    }

    // Mobile-specific constraints
    if (deviceType === 'mobile') {
      constraints.aspectRatio = isLandscape ? 16/9 : 9/16;

      if (isSamsungDevice) {
        // Samsung-specific optimizations
        constraints.frameRate = { ideal: samsungCameraWorkaround ? 15 : 20, min: 10, max: 25 };
        constraints.width = { ideal: isLandscape ? 1280 : 720, min: 480 };
        constraints.height = { ideal: isLandscape ? 720 : 1280, min: 640 };

        if (isOneUI) {
          constraints.latency = { ideal: 0.1 };
        }
      } else if (isCapacitor) {
        constraints.frameRate = { ideal: 15, min: 10, max: 20 };
        constraints.width = { ideal: isLandscape ? 1280 : 720, min: 480 };
        constraints.height = { ideal: isLandscape ? 720 : 1280, min: 640 };
      } else if (operatingSystem === 'ios') {
        constraints.frameRate = { ideal: 25, min: 15, max: 30 };
      } else if (operatingSystem === 'android') {
        constraints.frameRate = { ideal: 20, min: 15, max: 25 };
      }
    }

    // Platform-specific constraints
    if (platform === 'flatpak') {
      constraints.frameRate = { ideal: 20, min: 15, max: 25 };
      constraints.aspectRatio = 16/9;
      if (waylandSession) {
        constraints.latency = { ideal: 0.2 };
      }
    } else if (platform === 'snap') {
      constraints.frameRate = { ideal: 18, min: 12, max: 25 };
      constraints.aspectRatio = 16/9;
    } else if (platform === 'appimage' || platform === 'deb' || platform === 'rpm') {
      constraints.frameRate = { ideal: 25, min: 15, max: 30 };
    } else if (platform === 'tauri') {
      constraints.frameRate = { ideal: 30, min: 20, max: 40 };
    }

    return constraints;
  }

  async function requestCameraPermission(): Promise<boolean> {
    errorMessage = '';
    permissionRequested = true;

    // Native permission request
    if ((platform === 'electron' || platform === 'flatpak' || platform === 'snap' || platform === 'appimage' || platform === 'deb' || platform === 'rpm') && electronAPI) {
      try {
        const result = await electronAPI.ipcRenderer.invoke('request-camera-permission', {
          platform,
          operatingSystem,
          linuxDistro,
          desktopEnvironment,
          waylandSession
        });
        nativePermissionStatus = result?.status || 'unknown';
        return result?.granted || false;
      } catch (error) {
        console.warn('Native permission request failed:', error);
      }
    } else if (platform === 'tauri' && tauriAPI) {
      try {
        const result = await tauriAPI.invoke('request_camera_permission', {
          platform: 'tauri',
          os: operatingSystem
        });
        nativePermissionStatus = result?.status || 'unknown';
        return result?.granted || false;
      } catch (error) {
        console.warn('Tauri permission request failed:', error);
      }
    }

    // Browser permission request
    if (!navigator.mediaDevices?.getUserMedia) {
      errorMessage = 'Camera access not supported in this browser.';
      return false;
    }

    try {
      const constraints = getNativeConstraints();
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      stream.getTracks().forEach(track => track.stop());
      nativePermissionStatus = 'granted';
      return true;
    } catch (err) {
      handlePermissionError(err);
      return false;
    }
  }

  function handlePermissionError(error: Error) {
    nativePermissionStatus = 'denied';

    if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
      if (platform === 'flatpak') {
        errorMessage = 'Flatpak camera access denied. Grant permission in Flatseal or run:\nflatpak permission-set camera com.yourapp.name yes';
      } else if (platform === 'snap') {
        errorMessage = 'Snap camera access denied. Connect camera interface:\nsudo snap connect yourapp:camera';
      } else if (platform === 'electron' || platform === 'tauri') {
        errorMessage = 'Camera access denied. Check system privacy settings.';
      } else if (isCapacitor) {
        errorMessage = 'Camera access denied. Enable camera permission in app settings.';
      } else if (deviceType === 'mobile') {
        if (isSamsungDevice) {
          errorMessage = 'Camera access denied. Enable camera permission in Samsung Internet or Chrome settings.';
        } else if (operatingSystem === 'ios') {
          errorMessage = 'Camera access denied. Enable in iOS Settings > Safari > Camera.';
        } else if (operatingSystem === 'android') {
          errorMessage = 'Camera access denied. Enable in Android Settings > Apps > Browser > Permissions.';
        } else {
          errorMessage = 'Camera access denied. Allow camera access in browser settings.';
        }
      } else {
        errorMessage = getDesktopPermissionMessage();
      }
    } else if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
      errorMessage = 'No camera found. Please connect a camera and try again.';
    } else if (error.name === 'NotReadableError' || error.name === 'TrackStartError') {
      errorMessage = 'Camera is busy. Close other applications using the camera and try again.';
    } else if (error.name === 'OverconstrainedError') {
      errorMessage = 'Camera constraints not supported. Retrying with basic settings...';
      setTimeout(() => startScannerWithBasicConstraints(), 1000);
    } else {
      errorMessage = `Camera error: ${error.message || 'Unknown error'}`;
    }
  }

  function getDesktopPermissionMessage(): string {
    if (operatingSystem === 'macos') return 'Camera access denied. Check System Preferences > Security & Privacy > Camera.';
    if (operatingSystem === 'windows') return 'Camera access denied. Check Windows Settings > Privacy > Camera.';
    if (operatingSystem === 'linux') {
      if (platform === 'flatpak') return 'Camera access denied. Check Flatpak permissions and camera portal access.';
      if (platform === 'snap') return 'Camera access denied. Connect camera interface with snap connect.';
      return 'Camera access denied. Check browser permissions and system camera access.';
    }
    return 'Camera access denied. Allow camera access in browser settings.';
  }

  async function startScanner() {
    if (!videoElement) {
      errorMessage = 'Video element not found. Waiting for DOM...';
      await waitForVideoElement();
      if (!videoElement) {
        errorMessage = 'Video element unavailable after waiting.';
        return;
      }
    }

    if (!permissionRequested) {
      const permissionGranted = await requestCameraPermission();
      if (!permissionGranted) return;
    }

    try {
      // Fixed: Use the derived value properly
      qrScanner = new QrScanner(videoElement, handleScanResult, scannerConfig());

      // Samsung-specific scanner setup
      if (isSamsungDevice) {
        setupSamsungScannerOptimizations();
      }

      await qrScanner.start();
      isCameraActive = true;
      isScanning = true;
      errorMessage = '';

      await applyPlatformOptimizations();

      if (continuousScanning) setupContinuousScanning();

    } catch (err) {
      handleScannerError(err);
    }
  }

  function setupSamsungScannerOptimizations() {
    if (!qrScanner) return;

    try {
      // Samsung-specific QR scanner optimizations
      if (typeof qrScanner.setGrayscaleWeights === 'function') {
        qrScanner.setGrayscaleWeights(0.299, 0.587, 0.114, false);
      }

      if (typeof qrScanner.setInversionMode === 'function') {
        qrScanner.setInversionMode('both');
      }

      // Reduce processing intensity for Samsung devices
      if (samsungCameraWorkaround && typeof qrScanner.setMaxScansPerSecond === 'function') {
        qrScanner.setMaxScansPerSecond(10);
      }
    } catch (e) {
      console.warn('Could not apply Samsung optimizations:', e);
    }
  }

  async function startScannerWithBasicConstraints() {
    const basicConstraints: MediaStreamConstraints = {
      video: {
        facingMode: { ideal: 'environment' },
        width: { min: 320, ideal: isSamsungDevice ? 640 : 720 },
        height: { min: 240, ideal: isSamsungDevice ? 480 : 540 },
        frameRate: { min: 10, ideal: isSamsungDevice ? 12 : 15 }
      }
    };
    await startScannerWithCustomConstraints(basicConstraints);
  }

  async function startScannerWithCustomConstraints(constraints: MediaStreamConstraints) {
    if (!videoElement) {
      errorMessage = 'Video element not available.';
      await waitForVideoElement();
      if (!videoElement) {
        errorMessage = 'Video element unavailable after waiting.';
        return;
      }
    }

    try {
      // Fixed: Use the derived value properly with proper config
      const config = {
        ...scannerConfig(),
        onDecodeError: (error: any) => console.debug('QR decode attempt:', error)
      };

      qrScanner = new QrScanner(videoElement, handleScanResult, config);

      setupScannerErrorHandling();

      if (isSamsungDevice) {
        setupSamsungScannerOptimizations();
      }

      await qrScanner.start();
      isCameraActive = true;
      isScanning = true;
      errorMessage = '';

      await applyPlatformOptimizations();

      if (continuousScanning) setupContinuousScanning();

    } catch (err) {
      handleScannerError(err);
    }
  }

  async function waitForVideoElement(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (videoElement?.parentNode) {
        resolve();
        return;
      }

      const observer = new MutationObserver(() => {
        if (videoElement?.parentNode) {
          observer.disconnect();
          resolve();
        }
      });

      observer.observe(document.body, { childList: true, subtree: true });

      const timeout = isSamsungDevice ? 5000 : 3000;
      setTimeout(() => {
        observer.disconnect();
        if (!videoElement?.parentNode) {
          reject(new Error('Video element not found in DOM'));
        }
      }, timeout);
    });
  }

  function setupScannerErrorHandling() {
    if (!qrScanner) return;

    try {
      if ('addEventListener' in qrScanner) {
        (qrScanner as any).addEventListener('error', (event: any) => {
          handleScannerError(event.detail || event);
        });
      }
    } catch (e) {
      console.warn('Could not attach error listener:', e);
    }
  }

  async function applyPlatformOptimizations() {
    if (!qrScanner || !videoElement) return;

    try {
      const videoTrack = (videoElement.srcObject as MediaStream)?.getVideoTracks?.()?.[0];
      if (!videoTrack?.applyConstraints) return;

      const constraints: any = {};

      // Apply supported constraints
      if (supportedConstraints?.focusMode) constraints.focusMode = 'continuous';
      if (supportedConstraints?.exposureMode) constraints.exposureMode = 'continuous';
      if (supportedConstraints?.whiteBalanceMode) constraints.whiteBalanceMode = 'continuous';

      // Platform-specific optimizations
      if (isSamsungDevice && samsungCameraWorkaround) {
        constraints.frameRate = { ideal: 12, max: 15 };
        if (supportedConstraints?.brightness) constraints.brightness = { ideal: 0.1 };
      } else if (isCapacitor && deviceType === 'mobile') {
        constraints.frameRate = { ideal: 15, max: 20 };
      } else if (platform === 'mobile' && operatingSystem === 'ios') {
        constraints.frameRate = { ideal: 25 };
      } else if (platform === 'flatpak') {
        constraints.frameRate = { ideal: 20 };
      } else if (platform === 'snap') {
        constraints.frameRate = { ideal: 18 };
      } else if (platform === 'tauri') {
        constraints.frameRate = { ideal: 30 };
      }

      // Apply constraints if any were set
      if (Object.keys(constraints).length > 0) {
        await videoTrack.applyConstraints(constraints);
      }

      applyQRScannerOptimizations();

    } catch (error) {
      console.warn('Could not apply platform optimizations:', error);
    }
  }

  function applyQRScannerOptimizations() {
    if (!qrScanner) return;

    try {
      if (typeof (qrScanner as any).setGrayscaleWeights === 'function') {
        if (isSamsungDevice) {
          (qrScanner as any).setGrayscaleWeights(0.299, 0.587, 0.114, false);
        } else {
          (qrScanner as any).setGrayscaleWeights(0.2126, 0.7152, 0.0722, false);
        }
      }

      if (typeof (qrScanner as any).setInversionMode === 'function') {
        (qrScanner as any).setInversionMode('both');
      }
    } catch (e) {
      console.warn('Could not apply QR scanner optimizations:', e);
    }
  }

  function setupContinuousScanning() {
    // console.log(`Continuous scanning enabled for ${platform} on ${deviceType}`, {
    //   isSamsungDevice,
    //   samsungCameraWorkaround,
    //   isCapacitor
    // });
  }

  function handleScannerError(err: any) {
    console.error('Scanner error:', err);
    const message = err instanceof Error ? err.message : typeof err === 'string' ? err : err?.message || String(err);
    errorMessage = `Scanner error: ${message}`;
    isCameraActive = false;
    isScanning = false;
    scanningIndicator = false;

    const isRetryableError = !errorMessage.toLowerCase().includes('denied') &&
                            !errorMessage.toLowerCase().includes('not found') &&
                            !errorMessage.toLowerCase().includes('not supported');

    if (isRetryableError && isModalOpen && scanMode === 'camera') {
      setTimeout(() => {
        if (isModalOpen && !isCameraActive && scanMode === 'camera') {
          // console.log('Auto-retrying scanner...');
          startScanner();
        }
      }, getRetryDelay());
    }
  }

  function getRetryDelay(): number {
    if (isSamsungDevice && samsungCameraWorkaround) return 3000;
    if (isCapacitor) return 2000;
    if (platform === 'flatpak') return 3000;
    if (platform === 'snap') return 2500;
    if (deviceType === 'mobile') return 1500;
    return 1000;
  }

  function pauseScanner() {
    if (qrScanner && isCameraActive) {
      try {
        qrScanner.stop();
        isCameraActive = false;
      } catch (e) {
        console.warn('Error pausing scanner:', e);
      }
    }
  }

  function resumeScanner() {
    if (qrScanner && !isCameraActive && isModalOpen && scanMode === 'camera') {
      qrScanner.start().then(() => {
        isCameraActive = true;
      }).catch(handleScannerError);
    }
  }

  function restartScanner() {
    stopScanner();
    const delay = isSamsungDevice ? 800 : isCapacitor ? 700 : 500;
    setTimeout(() => {
      if (isModalOpen && scanMode === 'camera') startScanner();
    }, delay);
  }

  function stopScanner() {
    cleanupScanner();
    scanningIndicator = false;
  }

  function cleanupScanner() {
    if (qrScanner) {
      try {
        qrScanner.stop();
        qrScanner.destroy();
      } catch (e) {
        console.warn('Error cleaning up scanner:', e);
      }
      qrScanner = null;
    }
    isCameraActive = false;
    isScanning = false;
    isFlashlightOn = false;
  }

  function cleanupAll() {
    cleanupScanner();
    cleanupPlatformListeners();
    if (uploadedImageUrl) {
      URL.revokeObjectURL(uploadedImageUrl);
      uploadedImageUrl = null;
    }
  }

  function cleanupPlatformListeners() {
    // Electron cleanup
    if ((platform === 'electron' || platform === 'flatpak' || platform === 'snap' || platform === 'appimage' || platform === 'deb' || platform === 'rpm') && electronAPI?.ipcRenderer) {
      electronAPI.ipcRenderer.removeAllListeners('auto-open-qr-scanner');
      electronAPI.ipcRenderer.removeAllListeners('camera-permission-changed');
      electronAPI.ipcRenderer.removeAllListeners('flatpak-permission-granted');
      electronAPI.ipcRenderer.removeAllListeners('snap-interface-connected');
    }

    // Tauri cleanup
    if (platform === 'tauri' && tauriAPI) {
      // Tauri cleanup handled automatically
    }
  }

  async function toggleFlashlight() {
    if (!hasFlashlight || !qrScanner || !videoElement?.srcObject) return;

    try {
      const videoTrack = (videoElement.srcObject as MediaStream).getVideoTracks()[0];

      if (isSamsungDevice) {
        // Samsung-specific flashlight toggle
        const constraints = isFlashlightOn
          ? { advanced: [{ torch: false }] }
          : { advanced: [{ torch: true }] };
        await videoTrack.applyConstraints(constraints);
      } else {
        // Standard flashlight toggle
        await videoTrack.applyConstraints({
          advanced: [{ torch: !isFlashlightOn }]
        });
      }

      isFlashlightOn = !isFlashlightOn;
    } catch (e) {
      console.warn('Flashlight not supported or failed:', e);
    }
  }

  function handleScanResult(result: QrScanner.ScanResult | string) {
    const currentTime = Date.now();
    const debounceTime = isSamsungDevice ? 500 : 300;

    if (currentTime - lastScanTime < debounceTime) return;
    lastScanTime = currentTime;
    scanCount++;
    scanningIndicator = true;

    const indicatorDuration = isSamsungDevice ? 800 : 600;
    setTimeout(() => scanningIndicator = false, indicatorDuration);

    const data = typeof result === 'string' ? result : result.data;

    if (!continuousScanning) {
      stopScanner();
      isModalOpen = false;
    }

    onScanSuccess(data);

    // Send to native platforms
    if ((platform === 'electron' || platform === 'flatpak' || platform === 'snap' || platform === 'appimage' || platform === 'deb' || platform === 'rpm') && electronAPI?.ipcRenderer) {
      electronAPI.ipcRenderer.send('qr-scanned', {
        data,
        timestamp: currentTime,
        scanCount,
        platform,
        deviceType,
        operatingSystem,
        isSamsungDevice,
        samsungCameraWorkaround
      });
    } else if (platform === 'tauri' && tauriAPI) {
      tauriAPI.emit('qr-scanned', {
        data,
        timestamp: currentTime,
        scanCount,
        platform,
        deviceType,
        operatingSystem
      });
    }
  }

  function handleFileSelect() {
    fileInput?.click();
  }

  async function handleFileChange(event: Event) {
    const target = event.target as HTMLInputElement;
    const file = target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      errorMessage = 'Please select a valid image file.';
      return;
    }

    isProcessingImage = true;
    errorMessage = '';

    try {
      if (uploadedImageUrl) URL.revokeObjectURL(uploadedImageUrl);
      uploadedImageUrl = URL.createObjectURL(file);

      const result = await QrScanner.scanImage(file, {
        returnDetailedScanResult: false,
        scanRegion: undefined,
        qrEngine: QrScanner.createQrEngine(),
        inversionAttempts: 'both'
      });

      handleImageScanResult(result);
    } catch (error) {
      console.error('Error scanning image:', error);
      errorMessage = 'No QR code found in the image. Try another image or adjust the lighting.';
    } finally {
      isProcessingImage = false;
      if (target) target.value = '';
    }
  }

  function handleImageScanResult(result: QrScanner.ScanResult | string) {
    const currentTime = Date.now();
    scanCount++;
    scanningIndicator = true;
    setTimeout(() => scanningIndicator = false, 500);
    isModalOpen = false;

    const data = typeof result === 'string' ? result : result.data;
    onScanSuccess(data);

    // Send to native platforms
    if ((platform === 'electron' || platform === 'flatpak' || platform === 'snap' || platform === 'appimage' || platform === 'deb' || platform === 'rpm') && electronAPI?.ipcRenderer) {
      electronAPI.ipcRenderer.send('qr-scanned', {
        data,
        timestamp: currentTime,
        scanCount,
        source: 'image',
        platform,
        deviceType,
        operatingSystem
      });
    } else if (platform === 'tauri' && tauriAPI) {
      tauriAPI.emit('qr-scanned', {
        data,
        timestamp: currentTime,
        scanCount,
        source: 'image',
        platform,
        deviceType,
        operatingSystem
      });
    }
  }

  async function switchCamera() {
    if (availableCameras.length <= 1 || !qrScanner) return;

    const previousIndex = currentCameraIndex;
    currentCameraIndex = (currentCameraIndex + 1) % availableCameras.length;

    try {
      await qrScanner.setCamera(availableCameras[currentCameraIndex].id);
      const delay = isSamsungDevice ? 500 : 300;
      setTimeout(() => applyPlatformOptimizations(), delay);
    } catch (err) {
      console.error('Failed to switch camera:', err);
      currentCameraIndex = previousIndex;
      restartScanner();
    }
  }

  function flipCamera() {
    isFlipped = !isFlipped;
    if (videoElement) {
      videoElement.style.transform = isFlipped ? 'scaleX(-1)' : 'scaleX(1)';
    }
  }

  function switchScanMode(mode: 'camera' | 'image') {
    scanMode = mode;
    errorMessage = '';

    if (mode === 'camera') {
      if (uploadedImageUrl) {
        URL.revokeObjectURL(uploadedImageUrl);
        uploadedImageUrl = null;
      }
      if (!isCameraActive && (nativePermissionStatus === 'granted' || !permissionRequested)) {
        startScanner();
      }
    } else {
      stopScanner();
    }
  }

  function toggleTheme() {
    currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
    updateDocumentTheme();
  }

  function toggleModal(open: boolean) {
    isModalOpen = open;

    if (open) {
      errorMessage = '';
      scanMode = 'camera';

      if (nativePermissionStatus === 'granted' || !permissionRequested) {
        const delay = isSamsungDevice ? 200 : 100;
        setTimeout(() => startScanner(), delay);
      } else if (nativePermissionStatus === 'denied') {
        errorMessage = 'Camera permission was previously denied. Please allow camera access and try again.';
      }
    } else {
      stopScanner();
      scanCount = 0;
      if (uploadedImageUrl) {
        URL.revokeObjectURL(uploadedImageUrl);
        uploadedImageUrl = null;
      }
    }
  }

  async function retryScanner() {
    permissionRequested = false;
    nativePermissionStatus = 'unknown';
    errorMessage = '';

    const granted = await requestCameraPermission();
    if (granted) await startScanner();
  }

  function getPlatformIcon() {
    switch (platform) {
      case 'flatpak': return Package;
      case 'snap': return Package;
      case 'appimage': return Package;
      case 'deb': return Package;
      case 'rpm': return Package;
      case 'electron': return Monitor;
      case 'tauri': return Monitor;
      case 'mobile': return Smartphone;
      default: return Camera;
    }
  }

  function getPlatformColor() {
    switch (platform) {
      case 'flatpak': return 'bg-warning';
      case 'snap': return 'bg-info';
      case 'appimage': return 'bg-success';
      case 'deb': return 'bg-primary';
      case 'rpm': return 'bg-secondary';
      case 'electron': return 'bg-info';
      case 'tauri': return 'bg-accent';
      case 'mobile': return 'bg-secondary';
      default: return 'bg-success';
    }
  }

  function getPlatformLabel() {
    const labels = {
      flatpak: 'Flatpak',
      snap: 'Snap',
      appimage: 'AppImage',
      deb: 'DEB',
      rpm: 'RPM',
      electron: 'Electron',
      tauri: 'Tauri',
      mobile: 'Mobile',
      browser: 'Browser'
    };
    return labels[platform] || 'Unknown';
  }
</script>

<!-- Enhanced mobile-optimized button -->
<button
  class="btn btn-ghost relative group overflow-hidden {themeClasses().button} transition-all duration-300 hover:scale-105 hover:shadow-xl
         {deviceType === 'mobile' ? 'btn-lg min-h-14 px-6 text-base rounded-2xl' : 'btn-md'}
         {isCapacitor ? 'shadow-lg border-2' : ''}
         {isSamsungDevice ? 'samsung-optimized' : ''}"
  onclick={() => toggleModal(true)}
  aria-label="Open QR Scanner"
>
  <div class="absolute inset-0 bg-gradient-to-r from-primary/30 to-secondary/30 opacity-0 group-hover:opacity-100 transition-opacity duration-500"></div>
  <ScanLine class="{scanningIndicator ? 'animate-pulse text-success scale-110' : 'group-hover:rotate-12'} relative z-10 transition-all duration-300 {deviceType === 'mobile' ? 'w-6 h-6' : 'w-5 h-5'}" />
  <span class="relative z-10 font-medium {deviceType === 'mobile' ? 'text-base' : 'text-sm'}">{buttonText}</span>
  {#if scanCount > 0}
    <div class="absolute -top-2 -right-2 badge badge-success {deviceType === 'mobile' ? 'badge-md' : 'badge-sm'} animate-bounce shadow-lg backdrop-blur-sm">{scanCount}</div>
  {/if}
  <div class="absolute bottom-1 right-1 flex items-center gap-1">
    <div class="w-2 h-2 rounded-full {getPlatformColor()} {isCapacitor || isSamsungDevice ? 'animate-pulse' : ''}"></div>
    {#if deviceType !== 'mobile'}
      <svelte:component this={getPlatformIcon()} class="w-3 h-3 opacity-60" />
    {/if}
    {#if isSamsungDevice}
      <div class="text-[8px] opacity-50 font-bold">S</div>
    {/if}
  </div>
</button>

<input
  bind:this={fileInput}
  type="file"
  accept="image/*"
  onchange={handleFileChange}
  class="hidden"
  aria-label="Upload QR Code Image"
/>

{#if isModalOpen}
  <div class="fixed inset-0 bg-black/50 backdrop-blur-md flex items-center justify-center z-50
              {deviceType === 'mobile' ? 'p-1' : 'p-4'} animate-fade-in">
    <div class="{modalSize()} {themeClasses().modal} rounded-3xl shadow-2xl animate-scale-in overflow-hidden
                {deviceType === 'mobile' ? 'max-h-[98vh] mx-1' : 'max-h-[95vh]'}">

      <!-- Enhanced Header -->
      <div class="relative p-3 {deviceType === 'mobile' ? 'p-2' : 'p-4'} border-b border-base-content/20">
        <div class="absolute inset-0 opacity-10">
          <div class="absolute inset-0 bg-gradient-to-br from-primary via-secondary to-accent"></div>
          <div class="absolute inset-0" style="background-image: radial-gradient(circle at 25% 25%, rgba(255,255,255,0.2) 1px, transparent 1px); background-size: 15px 15px;"></div>
        </div>
        <div class="relative flex justify-between items-center">
          <div class="flex items-center gap-2 {deviceType === 'mobile' ? 'gap-2' : 'gap-3'}">
            <div class="w-8 h-8 {deviceType === 'mobile' ? 'w-8 h-8' : 'w-10 h-10'} rounded-xl bg-gradient-to-br from-primary/30 to-secondary/30 flex items-center justify-center backdrop-blur-sm border border-base-content/20">
              <ScanQrCode class="w-4 h-4 {deviceType === 'mobile' ? 'w-4 h-4' : 'w-5 h-5'} {themeClasses().accent}" />
            </div>
            <div>
              <h3 class="text-base {deviceType === 'mobile' ? 'text-sm' : 'text-lg'} font-bold {themeClasses().text}">{modalTitle}</h3>
              <div class="flex items-center gap-1 text-xs {deviceType === 'mobile' ? 'text-[10px]' : 'text-xs'} opacity-70 {themeClasses().text}">
                <svelte:component this={getPlatformIcon()} class="w-3 h-3" />
                <span>{getPlatformLabel()}</span>
                {#if operatingSystem !== 'unknown'}
                  <span>• {operatingSystem}</span>
                {/if}
                {#if isCapacitor}
                  <span class="text-warning">• native</span>
                {/if}
                {#if isSamsungDevice}
                  <span class="text-info">• Samsung</span>
                {/if}
                {#if isLandscape && deviceType === 'mobile'}
                  <span>• landscape</span>
                {/if}
                {#if linuxDistro !== 'unknown' && operatingSystem === 'linux'}
                  <span>• {linuxDistro}</span>
                {/if}
              </div>
            </div>
          </div>
          <div class="flex gap-1">
            <button
              class="btn btn-ghost btn-xs {themeClasses().button} rounded-lg"
              onclick={toggleTheme}
              aria-label="Toggle Theme"
            >
              {#if currentTheme === 'dark'}
                <Sun class="w-3 h-3" />
              {:else}
                <Moon class="w-3 h-3" />
              {/if}
            </button>
            {#if scanMode === 'camera'}
              {#if availableCameras.length > 1}
                <button
                  class="btn btn-ghost btn-xs {themeClasses().button} rounded-lg"
                  onclick={switchCamera}
                  aria-label="Switch Camera ({availableCameras.length} available)"
                >
                  <Camera class="w-3 h-3" />
                  {#if deviceType !== 'mobile'}
                    <span class="text-xs">{currentCameraIndex + 1}</span>
                  {/if}
                </button>
              {/if}
              <button
                class="btn btn-ghost btn-xs {themeClasses().button} rounded-lg"
                onclick={flipCamera}
                aria-label="Flip Camera"
              >
                <RotateCcw class="w-3 h-3" />
              </button>
              {#if hasFlashlight}
                <button
                  class="btn btn-ghost btn-xs {themeClasses().button} rounded-lg {isFlashlightOn ? 'text-warning bg-warning/20' : ''}"
                  onclick={toggleFlashlight}
                  aria-label="Toggle Flashlight"
                >
                  <Flashlight class="w-3 h-3" />
                </button>
              {/if}
            {/if}
            <button
              class="btn btn-ghost btn-xs {themeClasses().button} rounded-lg hover:bg-error/20"
              onclick={() => toggleModal(false)}
              aria-label="Close QR Scanner"
            >
              ✕
            </button>
          </div>
        </div>
      </div>

      <!-- Mode Toggle -->
      {#if allowImageUpload}
        <div class="p-2 {deviceType === 'mobile' ? 'p-1' : 'p-3'}">
          <div class="bg-base-200/30 backdrop-blur-lg rounded-xl p-1 flex border border-base-content/20">
            <button
              class="flex-1 flex items-center justify-center gap-2 py-2 px-3 rounded-lg text-xs font-medium transition-all duration-300
                     {scanMode === 'camera' ? 'bg-primary text-primary-content shadow-lg scale-[0.98] backdrop-blur-sm' : 'hover:bg-base-content/15 ' + themeClasses().text}"
              onclick={() => switchScanMode('camera')}
            >
              <Camera class="w-3 h-3" />
              <span>Camera</span>
            </button>
            <button
              class="flex-1 flex items-center justify-center gap-2 py-2 px-3 rounded-lg text-xs font-medium transition-all duration-300
                     {scanMode === 'image' ? 'bg-secondary text-secondary-content shadow-lg scale-[0.98] backdrop-blur-sm' : 'hover:bg-base-content/15 ' + themeClasses().text}"
              onclick={() => switchScanMode('image')}
            >
              <ImageIcon class="w-3 h-3" />
              <span>Upload</span>
            </button>
          </div>
        </div>
      {/if}

      <!-- Enhanced Scanner Area -->
      <div class="p-2 {deviceType === 'mobile' ? 'p-1' : 'p-3'}">
        <div class="relative w-full {deviceType === 'mobile' && isLandscape ? 'aspect-[16/10]' : 'aspect-square'}
                    {themeClasses().card} rounded-2xl overflow-hidden shadow-inner border-2 border-transparent
                    bg-gradient-to-br from-primary/20 via-transparent to-secondary/20 bg-clip-border
                    {isSamsungDevice ? 'samsung-scanner-area' : ''}">
          <div class="absolute inset-[2px] rounded-2xl bg-base-100/10 backdrop-blur-lg border border-base-content/10"></div>

          {#if scanMode === 'camera'}
            <div class="relative w-full h-full bg-gray-100 rounded-lg overflow-hidden">
              <video
                bind:this={videoElement}
                class="w-full h-full object-cover {isCapacitor ? 'video-capacitor' : ''} {isSamsungDevice ? 'video-samsung' : ''}"
                playsinline
                muted
                style="transform: {isFlipped ? 'scaleX(-1)' : 'scaleX(1)'}"
              >
                <track kind="captions" />
              </video>

              {#if !isCameraActive && !errorMessage}
                <div class="absolute inset-0 z-20 flex flex-col items-center justify-center bg-gradient-to-br from-base-200/90 to-base-300/90 backdrop-blur-xl rounded-2xl border border-base-content/20">
                  <div class="loading loading-spinner loading-lg text-primary mb-3"></div>
                  <div class="text-sm {deviceType === 'mobile' ? 'text-xs' : 'text-sm'} font-semibold {themeClasses().text} mb-2 text-center">
                    Starting camera...
                  </div>
                  <div class="text-xs opacity-60 {themeClasses().text} text-center">
                    <div class="flex items-center justify-center gap-2 mb-1">
                      <svelte:component this={getPlatformIcon()} class="w-3 h-3" />
                      <span>{getPlatformLabel()}</span>
                      {#if isSamsungDevice}
                        <span class="text-info">Samsung</span>
                      {/if}
                      {#if isCapacitor}
                        <span class="text-warning">Native</span>
                      {/if}
                    </div>
                    {#if isSamsungDevice && samsungCameraWorkaround}
                      <div class="text-[10px]">Applying Samsung optimizations...</div>
                    {:else if isCapacitor}
                      <div class="text-[10px]">Optimizing for native app...</div>
                    {:else if platform === 'mobile'}
                      <div class="text-[10px]">Requesting back camera...</div>
                    {:else if platform === 'flatpak'}
                      <div class="text-[10px]">Initializing Flatpak camera portal...</div>
                    {:else if platform === 'snap'}
                      <div class="text-[10px]">Connecting Snap camera interface...</div>
                    {/if}
                  </div>
                </div>
              {/if}
            </div>

            {#if scanningIndicator}
              <div class="absolute inset-0 z-30 flex items-center justify-center pointer-events-none">
                <div class="bg-success/95 text-success-content px-4 py-2 rounded-full shadow-xl backdrop-blur-lg animate-pulse border border-success/30">
                  <div class="flex items-center gap-2">
                    <Zap class="w-4 h-4 animate-bounce" />
                    <span class="font-medium text-sm">
                      {isSamsungDevice ? 'Samsung Scanned!' : 'Scanned!'}
                    </span>
                  </div>
                </div>
              </div>
            {/if}

          {:else}
            <!-- Image Upload Mode -->
            <div class="relative z-10 w-full h-full flex flex-col items-center justify-center p-3">
              {#if uploadedImageUrl}
                <div class="relative w-full h-full flex items-center justify-center">
                  <img src={uploadedImageUrl} alt="Uploaded QR Code" class="max-w-full max-h-full object-contain rounded-xl shadow-xl border border-base-content/20" />
                  <button
                    class="absolute top-2 right-2 btn btn-circle btn-sm bg-error/90 hover:bg-error text-error-content border-none shadow-lg backdrop-blur-sm"
                    onclick={() => {
                      if (uploadedImageUrl) {
                        URL.revokeObjectURL(uploadedImageUrl);
                        uploadedImageUrl = null;
                      }
                    }}
                  >
                    ✕
                  </button>
                </div>
              {:else}
                <div class="text-center w-full">
                  <div class="relative mb-3">
                    <div class="w-12 h-12 mx-auto bg-gradient-to-br from-secondary/30 to-primary/30 rounded-full flex items-center justify-center backdrop-blur-lg border border-base-content/20 shadow-lg">
                      <Upload class="w-6 h-6 {themeClasses().accent} animate-bounce" />
                    </div>
                    <div class="absolute -top-1 -right-1 w-3 h-3 bg-primary/70 rounded-full animate-ping shadow-lg"></div>
                    <div class="absolute -bottom-1 -left-1 w-2 h-2 bg-secondary/70 rounded-full animate-ping shadow-lg" style="animation-delay: 0.5s;"></div>
                  </div>
                  <h4 class="text-sm font-semibold {themeClasses().text} mb-2">Upload QR Code</h4>
                  <p class="text-xs opacity-70 {themeClasses().text} mb-3 leading-relaxed">
                    Select an image containing a QR code
                  </p>
                  <button
                    class="btn btn-md bg-gradient-to-r from-primary via-secondary to-accent text-primary-content border-none rounded-xl shadow-xl hover:shadow-2xl transform hover:scale-105 active:scale-95 transition-all duration-300 backdrop-blur-lg"
                    onclick={handleFileSelect}
                    disabled={isProcessingImage}
                  >
                    {#if isProcessingImage}
                      <span class="loading loading-spinner loading-sm"></span>
                      Processing...
                    {:else}
                      <Upload class="w-4 h-4" />
                      Choose Image
                    {/if}
                  </button>
                </div>
              {/if}
            </div>
          {/if}

          <!-- Enhanced Error Overlay -->
          {#if errorMessage}
            <div class="absolute inset-0 z-40 flex flex-col items-center justify-center bg-error/15 backdrop-blur-xl rounded-2xl border border-error/30">
              <div class="max-w-xs mx-auto text-center p-3 bg-base-100/30 backdrop-blur-lg rounded-xl border border-base-content/20 shadow-xl">
                <div class="w-10 h-10 mx-auto mb-2 bg-error/30 rounded-full flex items-center justify-center backdrop-blur-sm border border-error/40">
                  <svg class="w-5 h-5 text-error" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
                  </svg>
                </div>
                <p class="text-xs {themeClasses().text} mb-2 leading-relaxed whitespace-pre-line">{errorMessage}</p>
                {#if scanMode === 'camera'}
                  <button
                    class="btn btn-sm bg-primary/90 hover:bg-primary text-primary-content border-none rounded-lg backdrop-blur-lg shadow-lg hover:shadow-xl transition-all duration-300"
                    onclick={retryScanner}
                  >
                    <RotateCcw class="w-3 h-3" />
                    Try Again
                  </button>
                {:else}
                  <button
                    class="btn btn-sm bg-secondary/90 hover:bg-secondary text-secondary-content border-none rounded-lg backdrop-blur-lg shadow-lg hover:shadow-xl transition-all duration-300"
                    onclick={handleFileSelect}
                  >
                    <Upload class="w-3 h-3" />
                    Choose Different Image
                  </button>
                {/if}
              </div>
            </div>
          {/if}

          <!-- Processing Overlay -->
          {#if isProcessingImage}
            <div class="absolute inset-0 z-30 flex flex-col items-center justify-center bg-base-200/90 backdrop-blur-xl rounded-2xl border border-base-content/20">
              <div class="loading loading-spinner loading-lg text-secondary mb-3"></div>
              <div class="text-sm font-semibold {themeClasses().text} mb-1">Processing image...</div>
              <div class="text-xs opacity-60 {themeClasses().text}">Scanning for QR codes</div>
            </div>
          {/if}
        </div>
      </div>

      <!-- Enhanced Info Panel -->
      <div class="p-2 {deviceType === 'mobile' ? 'p-1' : 'p-3'}">
        <div class="{themeClasses().card} rounded-xl p-2 border border-base-content/20">
          <div class="flex items-start gap-2">
            <div class="w-6 h-6 bg-info/30 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5 backdrop-blur-sm border border-info/40">
              <svg class="w-3 h-3 text-info" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
              </svg>
            </div>
            <div class="flex-1">
              <p class="text-xs {themeClasses().text} leading-relaxed">
                {#if scanMode === 'camera'}
                  Position QR codes within the camera frame. Back camera selected by default.
                  {#if isSamsungDevice && samsungCameraWorkaround}
                    <br />Samsung device optimizations active for better performance.
                  {:else if isCapacitor}
                    <br />Optimized for native app performance.
                  {/if}
                  {#if hasFlashlight}
                    <br />Use flashlight for low light conditions.
                  {/if}
                  {#if platform === 'flatpak'}
                    <br />Using Flatpak camera portal for secure access.
                  {:else if platform === 'snap'}
                    <br />Using Snap camera interface for sandboxed access.
                  {/if}
                {:else}
                  Upload images containing QR codes. Supports common formats.
                {/if}
              </p>
              {#if scanCount > 0 || availableCameras.length > 0}
                <div class="mt-1 flex flex-wrap items-center gap-1 text-[10px] opacity-60 {themeClasses().text}">
                  {#if scanCount > 0}
                    <span class="flex items-center gap-1">
                      <Zap class="w-2 h-2" />
                      {scanCount}
                    </span>
                  {/if}
                  {#if scanMode === 'camera' && availableCameras.length > 0}
                    <span class="flex items-center gap-1">
                      <Camera class="w-2 h-2" />
                      {availableCameras.length} cam{availableCameras.length > 1 ? 's' : ''}
                    </span>
                  {/if}
                  {#if hasFlashlight}
                    <span class="flex items-center gap-1">
                      <Flashlight class="w-2 h-2" />
                      flash
                    </span>
                  {/if}
                  {#if isSamsungDevice}
                    <span class="flex items-center gap-1">
                      <div class="w-2 h-2 rounded-full bg-info animate-pulse"></div>
                      Samsung
                    </span>
                  {/if}
                  {#if isCapacitor}
                    <span class="flex items-center gap-1">
                      <div class="w-2 h-2 rounded-full bg-warning animate-pulse"></div>
                      native
                    </span>
                  {/if}
                  {#if platform === 'flatpak'}
                    <span class="flex items-center gap-1">
                      <div class="w-2 h-2 rounded-full bg-warning"></div>
                      flatpak
                    </span>
                  {:else if platform === 'snap'}
                    <span class="flex items-center gap-1">
                      <div class="w-2 h-2 rounded-full bg-info"></div>
                      snap
                    </span>
                  {/if}
                </div>
              {/if}
            </div>
          </div>
        </div>
      </div>

      <!-- Enhanced Footer -->
      <div class="p-2 {deviceType === 'mobile' ? 'p-1' : 'p-3'} border-t border-base-content/20">
        <div class="flex justify-between items-center gap-1">
          <div class="flex gap-1">
            {#if scanMode === 'camera' && isCameraActive && !continuousScanning}
              <button
                class="btn btn-xs bg-success/90 hover:bg-success text-success-content border-none rounded-lg backdrop-blur-lg shadow-lg hover:shadow-xl transition-all duration-300"
                onclick={() => {
                  continuousScanning = true;
                  setupContinuousScanning();
                }}
              >
                <Zap class="w-3 h-3" />
                {#if deviceType !== 'mobile'}
                  <span class="text-xs">Continuous</span>
                {/if}
              </button>
            {/if}
            {#if scanMode === 'image' && !uploadedImageUrl}
              <button
                class="btn btn-xs bg-secondary/90 hover:bg-secondary text-secondary-content border-none rounded-lg backdrop-blur-lg shadow-lg hover:shadow-xl transition-all duration-300"
                onclick={handleFileSelect}
                disabled={isProcessingImage}
              >
                {#if isProcessingImage}
                  <span class="loading loading-spinner loading-xs"></span>
                {:else}
                  <Upload class="w-3 h-3" />
                  {#if deviceType !== 'mobile'}
                    <span class="text-xs">Choose</span>
                  {/if}
                {/if}
              </button>
            {/if}
            {#if isSamsungDevice}
              <div class="flex items-center gap-1 px-2 py-1 bg-info/20 rounded-lg backdrop-blur-sm text-xs {themeClasses().text}">
                <div class="w-2 h-2 rounded-full bg-info animate-pulse"></div>
                {#if deviceType !== 'mobile'}
                  <span class="text-xs">Samsung</span>
                {/if}
              </div>
            {:else if isCapacitor}
              <div class="flex items-center gap-1 px-2 py-1 bg-warning/20 rounded-lg backdrop-blur-sm text-xs {themeClasses().text}">
                <div class="w-2 h-2 rounded-full bg-warning animate-pulse"></div>
                {#if deviceType !== 'mobile'}
                  <span class="text-xs">Native</span>
                {/if}
              </div>
            {:else if platform === 'flatpak' || platform === 'snap'}
              <div class="flex items-center gap-1 px-2 py-1 bg-primary/20 rounded-lg backdrop-blur-sm text-xs {themeClasses().text}">
                <svelte:component this={getPlatformIcon()} class="w-3 h-3" />
                {#if deviceType !== 'mobile'}
                  <span class="text-xs">{getPlatformLabel()}</span>
                {/if}
              </div>
            {/if}
          </div>
          <div class="flex gap-1">
            {#if !isCameraActive && errorMessage && scanMode === 'camera'}
              <button
                class="btn btn-xs bg-warning/90 hover:bg-warning text-warning-content border-none rounded-lg backdrop-blur-lg shadow-lg hover:shadow-xl transition-all duration-300"
                onclick={retryScanner}
              >
                <RotateCcw class="w-3 h-3" />
                {#if deviceType !== 'mobile'}
                  <span class="text-xs">Retry</span>
                {/if}
              </button>
            {/if}
            <button
              class="btn btn-xs bg-base-content/15 hover:bg-base-content/25 {themeClasses().text} border-none rounded-lg backdrop-blur-lg transition-all duration-300"
              onclick={() => toggleModal(false)}
            >
              {#if deviceType === 'mobile'}
                ✕
              {:else}
                <span class="text-xs">Cancel</span>
              {/if}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
{/if}

<style>
  @keyframes fade-in {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  @keyframes scale-in {
    from { opacity: 0; transform: scale(0.9) translateY(20px); }
    to { opacity: 1; transform: scale(1) translateY(0); }
  }

  .animate-fade-in { animation: fade-in 0.2s ease-out; }
  .animate-scale-in { animation: scale-in 0.3s cubic-bezier(0.34, 1.56, 0.64, 1); }
  .backdrop-blur-xs { backdrop-filter: blur(2px); }
  .backdrop-blur-2xl { backdrop-filter: blur(40px); }
  .shadow-inner { box-shadow: inset 0 2px 8px 0 rgba(0, 0, 0, 0.1); }

  .btn:hover { transform: translateY(-1px); }
  .btn:active { transform: translateY(0); }

  /* Samsung-specific optimizations */
  .samsung-optimized {
    -webkit-tap-highlight-color: transparent;
    touch-action: manipulation;
  }

  .samsung-scanner-area {
    -webkit-backface-visibility: hidden;
    backface-visibility: hidden;
  }

  .video-samsung {
    image-rendering: optimizeQuality;
    -webkit-transform: translateZ(0);
    transform: translateZ(0);
    -webkit-backface-visibility: hidden;
    backface-visibility: hidden;
  }

  /* Mobile optimizations */
  @media (max-width: 640px) {
    .btn-lg {
      min-height: 3.5rem;
      padding: 0.75rem 1.5rem;
      font-size: 1rem;
      font-weight: 600;
    }
    .modal-box { margin: 0.25rem; }
    .btn-xs { min-height: 1.75rem; min-width: 1.75rem; padding: 0.25rem 0.5rem; }
  }

  /* Landscape mobile adjustments */
  @media (max-height: 640px) and (orientation: landscape) {
    .aspect-square { aspect-ratio: 16/10; }
    .btn-lg { min-height: 3rem; }
  }

  /* Capacitor-specific optimizations */
  .video-capacitor {
    image-rendering: optimizeQuality;
    -webkit-transform: translateZ(0);
    transform: translateZ(0);
  }

  /* Platform-specific styles */
  .flatpak-optimized {
    image-rendering: crisp-edges;
    filter: contrast(1.1) brightness(1.05);
  }

  .electron-native {
    -webkit-app-region: no-drag;
  }

  .snap-optimized {
    image-rendering: pixelated;
    filter: contrast(1.05);
  }

  .tauri-optimized {
    image-rendering: high-quality;
    filter: contrast(1.02) brightness(1.01);
  }

  /* Performance optimizations */
  .loading-spinner { animation-duration: 0.8s; }

  video {
    filter: contrast(1.05) brightness(1.02);
    -webkit-backface-visibility: hidden;
    backface-visibility: hidden;
  }

  /* Samsung-specific video optimizations */
  .video-samsung {
    filter: contrast(1.1) brightness(1.03) saturate(1.1);
  }

  /* Linux distribution specific optimizations */
  .ubuntu-optimized video {
    filter: contrast(1.08) brightness(1.04);
  }

  .fedora-optimized video {
    filter: contrast(1.06) brightness(1.02);
  }

  .arch-optimized video {
    filter: contrast(1.1) brightness(1.05) hue-rotate(2deg);
  }

  /* Scan guide for mobile */
  .scan-guide-mobile {
    border-width: 2px;
    border-style: dashed;
    animation: scan-pulse 2s infinite ease-in-out;
  }

  @keyframes scan-pulse {
    0%, 100% { opacity: 0.5; transform: scale(1); }
    50% { opacity: 1; transform: scale(1.01); }
  }

  /* Samsung scan pulse - slower for better performance */
  .samsung-scan-pulse {
    animation: samsung-pulse 3s infinite ease-in-out;
  }

  @keyframes samsung-pulse {
    0%, 100% { opacity: 0.4; transform: scale(1); }
    50% { opacity: 0.9; transform: scale(1.005); }
  }

  /* Native app indicators */
  .native-indicator { position: relative; }
  .native-indicator::after {
    content: '';
    position: absolute;
    top: -2px;
    right: -2px;
    width: 6px;
    height: 6px;
    background: #fbbf24;
    border-radius: 50%;
    animation: native-pulse 2s infinite;
  }

  @keyframes native-pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.7; transform: scale(0.9); }
  }

  /* Samsung indicator - blue pulse */
  .samsung-indicator::after {
    background: #3b82f6;
    animation: samsung-indicator-pulse 2.5s infinite;
  }

  @keyframes samsung-indicator-pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.6; transform: scale(0.85); }
  }

  /* Platform-specific indicators */
  .flatpak-indicator::after { background: #f59e0b; }
  .snap-indicator::after { background: #10b981; }
  .appimage-indicator::after { background: #8b5cf6; }
  .tauri-indicator::after { background: #06b6d4; }

  /* Touch-friendly buttons for mobile */
  @media (pointer: coarse) {
    .btn {
      min-height: 44px;
      min-width: 44px;
    }
    .btn-xs {
      min-height: 36px;
      min-width: 36px;
    }
  }

  /* Samsung-specific touch optimizations */
  @media (pointer: coarse) and (-webkit-min-device-pixel-ratio: 2) {
    .samsung-optimized.btn {
      min-height: 48px;
      min-width: 48px;
      padding: 0.75rem 1rem;
    }
  }

  /* Reduce motion for accessibility */
  @media (prefers-reduced-motion: reduce) {
    .animate-fade-in,
    .animate-scale-in,
    .animate-bounce,
    .animate-pulse,
    .scan-pulse,
    .samsung-scan-pulse,
    .native-pulse,
    .samsung-indicator-pulse {
      animation: none;
    }
    .btn:hover { transform: none; }
  }

  /* High contrast mode */
  @media (prefers-contrast: high) {
    .backdrop-blur-xl,
    .backdrop-blur-lg,
    .backdrop-blur-md {
      backdrop-filter: none;
      background-color: var(--fallback-b1, oklch(var(--b1)));
    }
    .border-base-content\/20 {
      border-color: var(--fallback-bc, oklch(var(--bc)));
    }

    /* Enhanced contrast for Samsung devices */
    .video-samsung {
      filter: contrast(1.5) brightness(1.2);
    }
  }

  /* iOS Safari specific fixes */
  @supports (-webkit-touch-callout: none) {
    .fixed {
      -webkit-transform: translateZ(0);
      transform: translateZ(0);
    }
    video {
      -webkit-playsinline: true;
      object-position: center center;
    }
  }

  /* Android WebView optimizations */
  @media screen and (-webkit-min-device-pixel-ratio: 2) {
    video {
      image-rendering: -webkit-optimize-contrast;
    }

    /* Samsung-specific WebView optimizations */
    .video-samsung {
      image-rendering: optimizeSpeed;
      -webkit-transform: translate3d(0, 0, 0);
    }
  }

  /* Samsung Internet Browser specific optimizations */
  @media screen and (-webkit-min-device-pixel-ratio: 3) {
    .samsung-optimized {
      will-change: transform;
      transform: translateZ(0);
    }
  }

  /* Capacitor status bar safe area */
  @supports (padding-top: env(safe-area-inset-top)) {
    .capacitor-safe-top {
      padding-top: env(safe-area-inset-top);
    }
    .capacitor-safe-bottom {
      padding-bottom: env(safe-area-inset-bottom);
    }
  }

  /* Samsung One UI safe area adjustments */
  @supports (padding-top: env(safe-area-inset-top)) and (-webkit-min-device-pixel-ratio: 2) {
    .samsung-modal {
      padding-top: calc(env(safe-area-inset-top) + 0.5rem);
      padding-bottom: calc(env(safe-area-inset-bottom) + 0.5rem);
    }
  }

  /* PWA display optimizations */
  @media (display-mode: standalone) {
    .btn-lg {
      touch-action: manipulation;
      -webkit-tap-highlight-color: transparent;
    }

    /* Samsung PWA optimizations */
    .samsung-optimized {
      -webkit-user-select: none;
      user-select: none;
    }
  }

  /* Linux-specific optimizations */
  @media (pointer: fine) and (hover: hover) {
    /* Desktop Linux optimizations */
    .electron-native:hover {
      filter: brightness(1.05);
    }

    .flatpak-optimized:hover {
      filter: contrast(1.15) brightness(1.08);
    }

    .snap-optimized:hover {
      filter: contrast(1.08) brightness(1.03);
    }
  }

  /* Wayland-specific adjustments */
  @media (prefers-reduced-transparency: no-preference) {
    .wayland-session {
      backdrop-filter: blur(8px);
    }
  }

  /* X11-specific adjustments */
  .x11-session {
    image-rendering: pixelated;
  }

  /* Dark theme enhancements */
  [data-theme="dark"] .samsung-scanner-area {
    filter: brightness(1.1) contrast(1.1);
  }

  [data-theme="dark"] .video-samsung {
    filter: contrast(1.15) brightness(1.08) saturate(1.15);
  }

  /* Light theme enhancements */
  [data-theme="light"] .samsung-scanner-area {
    filter: brightness(0.95) contrast(1.05);
  }

  [data-theme="light"] .video-samsung {
    filter: contrast(1.08) brightness(1.02) saturate(1.05);
  }

  /* Error state styling */
  .error-overlay {
    backdrop-filter: blur(12px);
    background: linear-gradient(135deg, rgba(239, 68, 68, 0.1), rgba(220, 38, 38, 0.2));
  }

  /* Success state styling */
  .success-overlay {
    backdrop-filter: blur(8px);
    background: linear-gradient(135deg, rgba(34, 197, 94, 0.1), rgba(22, 163, 74, 0.2));
  }

  /* Platform detection indicator styles */
  .platform-badge {
    position: relative;
    overflow: hidden;
  }

  .platform-badge::before {
    content: '';
    position: absolute;
    top: 0;
    left: -100%;
    width: 100%;
    height: 100%;
    background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.4), transparent);
    animation: shimmer 2s infinite;
  }

  @keyframes shimmer {
    0% { left: -100%; }
    100% { left: 100%; }
  }

  /* Responsive typography */
  @media (max-width: 480px) {
    .text-xs { font-size: 0.65rem; }
    .text-sm { font-size: 0.75rem; }
  }

  /* Samsung-specific responsive adjustments */
  @media (max-width: 480px) and (-webkit-min-device-pixel-ratio: 2) {
    .samsung-optimized .text-xs { font-size: 0.7rem; }
    .samsung-optimized .text-sm { font-size: 0.8rem; }
  }

  /* Focus styles for accessibility */
  .btn:focus-visible {
    outline: 2px solid var(--fallback-p, oklch(var(--p)));
    outline-offset: 2px;
  }

  /* Samsung-specific focus styles */
  .samsung-optimized:focus-visible {
    outline: 3px solid #3b82f6;
    outline-offset: 3px;
  }

  /* Print styles */
  @media print {
    .fixed, .modal, .backdrop {
      display: none !important;
    }
  }

  /* Performance optimization classes */
  .gpu-accelerated {
    will-change: transform;
    transform: translateZ(0);
    -webkit-transform: translateZ(0);
  }

  .optimize-legibility {
    text-rendering: optimizeLegibility;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }

  /* Battery-saving mode adjustments */
  @media (prefers-reduced-motion: reduce) {
    .video-samsung {
      filter: none;
    }

    .loading-spinner {
      animation: none;
      border: 2px solid currentColor;
      border-top-color: transparent;
    }
  }
</style>