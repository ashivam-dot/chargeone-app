import { playUrl, type OperatorApp } from '../shared/operatorApps.ts';
import { PLATFORM } from './bridge.ts';

const launcher = () => import('@capacitor/app-launcher').then((m) => m.AppLauncher);

/** Android only: whether the operator's app is on the phone, so the button can say "Open" instead of "Get". */
export async function isOperatorAppInstalled(app: OperatorApp): Promise<boolean> {
  if (PLATFORM !== 'android' || !app.androidPackage) return false;
  try {
    return (await (await launcher()).canOpenUrl({ url: app.androidPackage })).value;
  } catch {
    return false;
  }
}

/** Opens the operator's app if installed, otherwise its store page, otherwise its website. */
export async function openOperatorApp(app: OperatorApp): Promise<void> {
  const l = await launcher();
  if (PLATFORM === 'android' && app.androidPackage) {
    const pkg = app.androidPackage;
    if (await isOperatorAppInstalled(app)) {
      if ((await l.openUrl({ url: pkg })).completed) return;
    }
    if ((await l.openUrl({ url: `market://details?id=${pkg}` })).completed) return;
    await l.openUrl({ url: playUrl(pkg) });
    return;
  }
  // iOS can't tell whether an app is installed without its URL scheme; the App Store page shows Open or Get.
  if (PLATFORM === 'ios' && app.iosAppId) {
    await l.openUrl({ url: `itms-apps://apps.apple.com/app/id${app.iosAppId}` });
    return;
  }
  if (app.website) await l.openUrl({ url: app.website });
}
