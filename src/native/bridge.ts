// The native shells inject window.Capacitor before any app script runs, so reading it here costs the web bundle nothing.

export type PlatformId = 'web' | 'android' | 'ios';

interface InjectedBridge {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
}

const bridge = (globalThis as { Capacitor?: InjectedBridge }).Capacitor;

export const IS_NATIVE: boolean = bridge?.isNativePlatform?.() === true;

export const PLATFORM: PlatformId = (() => {
  if (!IS_NATIVE) return 'web';
  const id = bridge?.getPlatform?.();
  return id === 'ios' ? 'ios' : id === 'android' ? 'android' : 'web';
})();
