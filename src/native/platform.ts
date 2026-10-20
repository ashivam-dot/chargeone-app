// Phone features with one call site for web and native. Native plugins load on first use so the web bundle stays small.
import { IS_NATIVE, PLATFORM, type PlatformId } from './bridge.ts';

export const isNative: boolean = IS_NATIVE;

export function platform(): PlatformId {
  return PLATFORM;
}

/** The store version on native ("1.2.0"); null on the web. */
export async function appVersion(): Promise<string | null> {
  if (!IS_NATIVE) return null;
  const { App } = await import('@capacitor/app');
  return (await App.getInfo()).version;
}

export type HapticKind = 'light' | 'medium' | 'heavy' | 'success' | 'warning' | 'error' | 'selection';

const VIBRATION: Record<HapticKind, number | number[]> = {
  light: 10,
  medium: 20,
  heavy: 35,
  success: [15, 40, 15],
  warning: [30, 60, 30],
  error: [50, 50, 50, 50, 50],
  selection: 5,
};

export async function haptic(kind: HapticKind): Promise<void> {
  try {
    if (!IS_NATIVE) {
      navigator.vibrate?.(VIBRATION[kind]);
      return;
    }
    const { Haptics, ImpactStyle, NotificationType } = await import('@capacitor/haptics');
    switch (kind) {
      case 'light':
        return await Haptics.impact({ style: ImpactStyle.Light });
      case 'medium':
        return await Haptics.impact({ style: ImpactStyle.Medium });
      case 'heavy':
        return await Haptics.impact({ style: ImpactStyle.Heavy });
      case 'success':
        return await Haptics.notification({ type: NotificationType.Success });
      case 'warning':
        return await Haptics.notification({ type: NotificationType.Warning });
      case 'error':
        return await Haptics.notification({ type: NotificationType.Error });
      case 'selection':
        await Haptics.selectionStart();
        await Haptics.selectionChanged();
        return await Haptics.selectionEnd();
    }
  } catch {
    // Haptics are a nicety; a phone without them just stays still.
  }
}

/** Asks once for permission to show alerts; resolves true when alerts can be shown. */
export async function ensureNotifyPermission(): Promise<boolean> {
  try {
    if (IS_NATIVE) {
      const { LocalNotifications } = await import('@capacitor/local-notifications');
      let { display } = await LocalNotifications.checkPermissions();
      if (display === 'prompt' || display === 'prompt-with-rationale') ({ display } = await LocalNotifications.requestPermissions());
      return display === 'granted';
    }
    if (typeof Notification === 'undefined') return false;
    if (Notification.permission === 'default') await Notification.requestPermission();
    return Notification.permission === 'granted';
  } catch {
    return false;
  }
}

export interface NotifyInput {
  /** Must fit a 32-bit signed int (Android notification ids). The same id replaces the earlier alert. */
  id: number;
  title: string;
  body: string;
}

/** Shows an alert. On the web it only shows while the page is hidden, since the driver can already see the app. */
export async function notify({ id, title, body }: NotifyInput): Promise<void> {
  try {
    if (IS_NATIVE) {
      if (!(await ensureNotifyPermission())) return;
      const { LocalNotifications } = await import('@capacitor/local-notifications');
      await LocalNotifications.schedule({ notifications: [{ id, title, body }] });
      return;
    }
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    if (document.visibilityState !== 'hidden') return;
    const options: NotificationOptions = { body, tag: String(id), icon: '/icon-192.png' };
    // Android Chrome only shows notifications through a service worker registration.
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) await reg.showNotification(title, options);
    else new Notification(title, options);
  } catch {
    // An alert that can't be shown is not worth interrupting the driver for.
  }
}

let wakeLock: WakeLockSentinel | null = null;
let wantAwake = false;

async function requestWebWakeLock(): Promise<void> {
  if (!wantAwake || wakeLock || document.visibilityState !== 'visible' || !('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => {
      wakeLock = null;
    });
  } catch {
    wakeLock = null;
  }
}

let wakeListener = false;

/** Keeps the screen on while driving (navigation, live trip). */
export async function keepAwake(on: boolean): Promise<void> {
  wantAwake = on;
  try {
    if (IS_NATIVE) {
      const { KeepAwake } = await import('@capacitor-community/keep-awake');
      await (on ? KeepAwake.keepAwake() : KeepAwake.allowSleep());
      return;
    }
    if (!wakeListener) {
      // Browsers drop the wake lock whenever the page is hidden.
      document.addEventListener('visibilitychange', () => void requestWebWakeLock());
      wakeListener = true;
    }
    if (on) await requestWebWakeLock();
    else {
      const lock = wakeLock;
      wakeLock = null;
      await lock?.release();
    }
  } catch {
    // The screen just follows the phone's own timeout.
  }
}

/** Fired on the Android back button. Call preventDefault() when the app handled it (closed a sheet, went back a step). */
export const BACK_EVENT = 'chargeone:back';

let shellStarted = false;

/** Call once after the first render: sets the status bar, wires the back button and hides the splash screen. */
export async function initNativeShell(): Promise<void> {
  if (!IS_NATIVE || shellStarted) return;
  shellStarted = true;
  try {
    const [{ StatusBar, Style }, { App }] = await Promise.all([import('@capacitor/status-bar'), import('@capacitor/app')]);
    await StatusBar.setStyle({ style: Style.Dark }).catch(() => undefined);
    if (PLATFORM === 'android') {
      // Android 15+ always draws edge to edge and rejects this call.
      await StatusBar.setOverlaysWebView({ overlay: true }).catch(() => undefined);
      await App.addListener('backButton', ({ canGoBack }) => {
        const event = new Event(BACK_EVENT, { cancelable: true });
        if (!window.dispatchEvent(event)) return;
        if (canGoBack) window.history.back();
        else void App.minimizeApp();
      });
    }
  } finally {
    const { SplashScreen } = await import('@capacitor/splash-screen');
    await SplashScreen.hide({ fadeOutDuration: 200 }).catch(() => undefined);
  }
}

/** Runs cb whenever the app comes back to the foreground; returns a function that stops listening. */
export function onAppResume(cb: () => void): () => void {
  if (!IS_NATIVE) {
    const onVisible = () => {
      if (document.visibilityState === 'visible') cb();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }
  let stopped = false;
  let remove: (() => Promise<void>) | null = null;
  void import('@capacitor/app').then(async ({ App }) => {
    const handle = await App.addListener('resume', cb);
    if (stopped) await handle.remove();
    else remove = () => handle.remove();
  });
  return () => {
    stopped = true;
    void remove?.();
  };
}
