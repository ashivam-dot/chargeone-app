// Open tabs pick up a new deploy. The service worker updates itself (registerType autoUpdate), but the
// browser only checks for a new one on a navigation, so a tab left open for days kept running the old
// build. Ask for an update when the tab comes back into view or gains focus, and every half hour. When a
// new worker takes control, reload, unless the user is planning a trip or typing; then offer a Reload
// button instead, so a half-typed destination or a planned trip is never thrown away.

import { reloadBlocked } from './reloadGuard.ts';

export const CHECK_EVERY_MS = 30 * 60_000;
/** Focus and visibility often fire together; one check covers both. */
export const MIN_GAP_MS = 60_000;

type Listen = { addEventListener(type: string, fn: () => void): void };

export interface UpdateEnv {
  sw: Listen & { readonly controller: unknown; getRegistration(): Promise<{ update(): Promise<unknown> } | undefined> };
  win: Listen & { setInterval(fn: () => void, ms: number): unknown };
  doc: Listen & { readonly visibilityState: string; readonly activeElement: Element | null };
  now: () => number;
  reload: () => void;
  /** Shows the "New version ready" prompt; its button calls reload. */
  offerReload: (reload: () => void) => void;
}

export function isEditing(el: Element | null): boolean {
  if (!el) return false;
  return /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || (el as HTMLElement).isContentEditable === true;
}

export function watchForUpdates(env: UpdateEnv): void {
  let last = -Infinity;
  const check = () => {
    if (env.now() - last < MIN_GAP_MS) return;
    last = env.now();
    env.sw
      .getRegistration()
      .then((reg) => reg?.update())
      .catch(() => undefined);
  };
  env.doc.addEventListener('visibilitychange', () => {
    if (env.doc.visibilityState === 'visible') check();
  });
  env.win.addEventListener('focus', check);
  env.win.setInterval(check, CHECK_EVERY_MS);

  // The first install also takes control (clientsClaim) and replaces no older build.
  let controlled = Boolean(env.sw.controller);
  let done = false;
  env.sw.addEventListener('controllerchange', () => {
    if (!controlled) {
      controlled = true;
      return;
    }
    if (done) return;
    done = true;
    if (!reloadBlocked() && !isEditing(env.doc.activeElement)) env.reload();
    else env.offerReload(env.reload);
  });
}

function offerReload(reload: () => void): void {
  const box = document.createElement('div');
  box.className = 'toast';
  // At the top, so it never covers the trip sheet or the app's own toasts. Styled here, not in the
  // start-up CSS, since this module loads after start-up.
  box.style.cssText = 'top:calc(env(safe-area-inset-top,0px) + 12px);bottom:auto;display:flex;align-items:center;gap:12px';
  box.setAttribute('role', 'status');
  box.dataset.testid = 'update-toast';
  box.append('New version ready');
  const button = (label: string, onClick: () => void) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.onclick = onClick;
    b.style.cssText = 'font:inherit;color:var(--accent);background:none;border:0;padding:4px 2px;cursor:pointer';
    box.append(b);
  };
  button('Reload', reload);
  button('Later', () => box.remove());
  document.body.append(box);
}

export function watchForUpdatesInBrowser(): void {
  const sw = typeof navigator === 'undefined' ? undefined : navigator.serviceWorker;
  if (!sw) return;
  watchForUpdates({ sw, win: window, doc: document, now: Date.now, reload: () => location.reload(), offerReload });
}
