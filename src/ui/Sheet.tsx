import type { ComponentChildren } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';

interface Props {
  title: string;
  onClose: () => void;
  children: ComponentChildren;
  /** Modal sheets dim the map and trap attention; panels leave the map usable. */
  modal?: boolean;
}

export function Sheet({ title, onClose, children, modal = false }: Props) {
  const ref = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const [collapsed, setCollapsed] = useState(false);

  // A layout effect runs as the sheet is committed, before the first paint: Escape and focus work from
  // the moment the sheet can be seen. useEffect ran after paint, so an early Escape could go unheard.
  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close.current();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
  }, []);

  return (
    <>
      {modal && <div class="scrim" onClick={onClose} aria-hidden="true" />}
      <section
        ref={ref}
        class={`sheet${modal ? ' sheet--modal' : ''}${collapsed ? ' sheet--collapsed' : ''}`}
        role={modal ? 'dialog' : 'region'}
        aria-modal={modal ? 'true' : undefined}
        aria-label={title}
        tabIndex={-1}
      >
        {modal ? (
          <div class="sheet__grip" aria-hidden="true" />
        ) : (
          <button class="sheet__grip sheet__grip--button" aria-expanded={!collapsed} aria-label={collapsed ? 'Expand panel' : 'Collapse panel to see the map'} onClick={() => setCollapsed(!collapsed)} />
        )}
        <header class="sheet__head">
          <h2 onClick={() => collapsed && setCollapsed(false)}>{title}</h2>
          <button class="icon-btn" onClick={onClose} aria-label="Close">
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" />
            </svg>
          </button>
        </header>
        <div class="sheet__body">{children}</div>
      </section>
    </>
  );
}
