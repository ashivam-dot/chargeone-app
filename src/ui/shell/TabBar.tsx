import { CarFront, CircleUser, Compass, Route, Sparkles } from 'lucide-preact';
import { haptic } from '../../native/platform.ts';
import './shell.css';

export type Tab = 'explore' | 'trip' | 'car' | 'copilot' | 'you';

const TABS: Array<{ id: Tab; label: string; Icon: typeof Compass }> = [
  { id: 'explore', label: 'Explore', Icon: Compass },
  { id: 'trip', label: 'Trip', Icon: Route },
  { id: 'car', label: 'Car', Icon: CarFront },
  { id: 'copilot', label: 'Copilot', Icon: Sparkles },
  { id: 'you', label: 'You', Icon: CircleUser },
];

interface Props {
  tab: Tab;
  onChange: (tab: Tab) => void;
  /** Small dot on a tab, e.g. a live car connection. */
  live?: Partial<Record<Tab, boolean>>;
}

export function TabBar({ tab, onChange, live }: Props) {
  const index = TABS.findIndex((t) => t.id === tab);
  return (
    <nav class="tabbar" aria-label="Main">
      <div class="tabbar__inner" style={{ '--i': index }}>
        <span class="tabbar__indicator" aria-hidden="true" />
        {TABS.map(({ id, label, Icon }) => (
          <button
            key={id}
            class={`tabbar__tab${id === tab ? ' is-active' : ''}${id === 'copilot' ? ' tabbar__tab--copilot' : ''}`}
            aria-current={id === tab ? 'page' : undefined}
            data-testid={`tab-${id}`}
            onClick={() => {
              if (id !== tab) void haptic('selection');
              onChange(id);
            }}
          >
            <span class="tabbar__icon">
              <Icon size={22} strokeWidth={id === tab ? 2.4 : 1.9} aria-hidden="true" />
              {live?.[id] && <span class="tabbar__live" aria-hidden="true" />}
            </span>
            <span class="tabbar__label">{label}</span>
          </button>
        ))}
      </div>
    </nav>
  );
}
