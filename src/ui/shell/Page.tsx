import type { ComponentChildren } from 'preact';
import './shell.css';

interface Props {
  title: string;
  eyebrow?: ComponentChildren;
  actions?: ComponentChildren;
  children: ComponentChildren;
  /** Extra class on the page, e.g. for a screen-specific background. */
  class?: string;
  testId?: string;
}

/** A full-screen tab page above the map, with a large title that condenses into a bar on scroll. */
export function Page({ title, eyebrow, actions, children, class: extra, testId }: Props) {
  return (
    <main class={`page${extra ? ` ${extra}` : ''}`} data-testid={testId}>
      <div class="page__aurora" aria-hidden="true" />
      <header class="page__bar">
        <span class="page__bar-title">{title}</span>
        {actions && <div class="page__actions">{actions}</div>}
      </header>
      <div class="page__scroll">
        <div class="page__head">
          {eyebrow && <div class="page__eyebrow">{eyebrow}</div>}
          <h1 class="page__title">{title}</h1>
        </div>
        <div class="page__body">{children}</div>
      </div>
    </main>
  );
}
