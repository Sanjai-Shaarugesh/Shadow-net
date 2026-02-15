import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.speed_share.app',
  appName: 'ShadowNet',
  webDir: './build',
  server: {
    androidScheme: 'https',
    allowNavigation: ['/','/answer']
  },
  plugins: {
      SplashScreen: {
        launchShowDuration: 100,
        launchAutoHide: true,
        launchFadeOutDuration: 300,
        backgroundColor: "#00000000",
        androidSplashResourceName: "splash",
        androidScaleType: "CENTER_CROP",
        showSpinner: true,
        androidSpinnerStyle: "large",
        iosSpinnerStyle: "small",
        spinnerColor: "#999999",
        splashFullScreen: true,
        splashImmersive: true,
        layoutName: "launch_screen",
        useDialog: true,
      },

    },
    android: {
      allowMixedContent: true
    }
};

export default config;
