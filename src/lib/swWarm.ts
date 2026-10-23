// On the very first visit the page loads its map tiles, charger shards and places before the service worker
// installs and takes control, so none of them pass through its runtime caches. When it takes control, fetch
// those once more (mostly from the browser's HTTP cache) so they are kept for offline use too.

const TILE_HOSTS = new Set(['tiles.openfreemap.org', 'tiles.mapterhorn.com']);
const MAX_URLS = 400;

/** The resources worth keeping offline from what the page has loaded so far. */
export function warmable(urls: string[], origin: string): string[] {
  const out = new Set<string>();
  for (const u of urls) {
    let url: URL;
    try {
      url = new URL(u);
    } catch {
      continue;
    }
    const own = url.origin === origin && /^\/(data|map)\//.test(url.pathname) && !url.searchParams.has('fresh');
    if (own || TILE_HOSTS.has(url.hostname)) out.add(url.href);
    if (out.size >= MAX_URLS) break;
  }
  return [...out];
}

export function warmCachesOnFirstControl(): void {
  const sw = typeof navigator === 'undefined' ? undefined : navigator.serviceWorker;
  // Only the first install: later visits are already controlled, so every fetch is cached as it happens.
  if (!sw || sw.controller) return;
  sw.addEventListener(
    'controllerchange',
    () => {
      const loaded = performance.getEntriesByType('resource').map((e) => e.name);
      for (const url of warmable(loaded, location.origin)) fetch(url).catch(() => undefined);
    },
    { once: true },
  );
}
