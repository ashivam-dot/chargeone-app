import type { ComponentType, JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';

/** A component loaded on first use, so heavy screens stay out of the start-up bundle. */
export function lazy<P extends object>(load: () => Promise<ComponentType<P>>, fallback?: () => JSX.Element) {
  let loaded: ComponentType<P> | null = null;
  let pending: Promise<ComponentType<P>> | null = null;
  const get = () => {
    pending ??= load()
      .then((c) => (loaded = c))
      .catch((err: unknown) => {
        pending = null;
        throw err;
      });
    return pending;
  };
  function Lazy(props: P) {
    const [C, setC] = useState<ComponentType<P> | null>(() => loaded);
    const [failed, setFailed] = useState(false);
    useEffect(() => {
      if (C) return;
      let live = true;
      get().then(
        (c) => live && setC(() => c),
        () => live && setFailed(true),
      );
      return () => {
        live = false;
      };
    }, []);
    if (C) return <C {...props} />;
    if (failed)
      return (
        <div class="page-loading" role="alert">
          <p>This screen couldn't load. Check your connection.</p>
          <button class="btn btn--glass" onClick={() => location.reload()}>
            Reload
          </button>
        </div>
      );
    return fallback ? fallback() : <div class="page-loading" aria-busy="true" />;
  }
  Lazy.preload = () => void get().catch(() => undefined);
  return Lazy;
}
