import type { ComponentChildren } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';

interface Props {
  title: string;
  onClose: () => void;
  children: ComponentChildren;
  /** Modal sheets dim the map and trap attention; panels leave the map usable. */
  modal?: boolean;
}

/** Open sheets, oldest first. Only the newest one that can be seen answers Escape and holds focus. */
const openSheets: HTMLElement[] = [];

/** The sheet the keyboard belongs to: the newest open one not inside a hidden container. */
function topSheet(): HTMLElement | undefined {
  for (let i = openSheets.length - 1; i >= 0; i--) {
    const el = openSheets[i];
    if (el.isConnected && !el.closest('[hidden]')) return el;
  }
  return undefined;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.closest('[hidden]') && el.getClientRects().length > 0);
}

export function Sheet({ title, onClose, children, modal = false }: Props) {
  const ref = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const [collapsed, setCollapsed] = useState(false);

  // A layout effect runs as the sheet is committed, before the first paint: Escape and focus work from
  // the moment the sheet can be seen. useEffect ran after paint, so an early Escape could go unheard.
  // Escape closes only the sheet on top: sign-in opened over a trip closes, the trip stays. A modal sheet
  // also keeps Tab inside itself, so keyboard focus can't wander to the map and panels behind the scrim.
  const isModal = useRef(modal);
  isModal.current = modal;
  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const el = ref.current;
    if (el) openSheets.push(el);
    el?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (!el || topSheet() !== el) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        close.current();
        return;
      }
      if (e.key !== 'Tab' || !isModal.current) return;
      const items = focusables(el);
      if (!items.length) {
        e.preventDefault();
        el.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      const inside = Boolean(active && el.contains(active));
      if (e.shiftKey && (!inside || active === first || active === el)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (!inside || active === last)) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      const at = el ? openSheets.lastIndexOf(el) : -1;
      if (at >= 0) openSheets.splice(at, 1);
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
