/// <reference types="@capacitor/splash-screen" />
/// <reference types="@capacitor/status-bar" />
/// <reference types="@capacitor/local-notifications" />
import type { CapacitorConfig } from '@capacitor/cli';

const BACKGROUND = '#05070b';
// Read when `cap sync` copies this config into the native projects, so release builds must sync without it.
const debug = process.env.CAP_DEBUG === '1';

const config: CapacitorConfig = {
  appId: 'in.chargeone.app',
  appName: 'ChargeOne',
  webDir: 'dist',
  backgroundColor: BACKGROUND,
  loggingBehavior: debug ? 'debug' : 'production',
  plugins: {
    SplashScreen: {
      launchAutoHide: false,
      launchFadeOutDuration: 200,
      backgroundColor: BACKGROUND,
      showSpinner: false,
      androidScaleType: 'CENTER_CROP',
      splashFullScreen: false,
      splashImmersive: false,
    },
    StatusBar: {
      overlaysWebView: true,
      style: 'DARK',
    },
    LocalNotifications: {
      smallIcon: 'ic_stat_chargeone',
      iconColor: '#22d3ee',
    },
    // Map tiles and the bundled dataset must keep using the WebView's fetch; transport.ts calls CapacitorHttp itself.
    CapacitorHttp: { enabled: false },
    SocialLogin: {
      providers: { google: true, facebook: false, apple: false, twitter: false },
      logLevel: 1,
    },
  },
  android: {
    allowMixedContent: false,
    webContentsDebuggingEnabled: debug,
  },
  ios: {
    contentInset: 'never',
    backgroundColor: BACKGROUND,
    webContentsDebuggingEnabled: debug,
  },
};

export default config;
