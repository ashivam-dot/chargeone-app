import { Check, Minus } from 'lucide-preact';

/** One row of a plan's perks: a tick or a dash, the label and, for a string value, the amount. */
export function PerkItem({ label, value }: { label: string; value: boolean | string }) {
  const included = value !== false;
  return (
    <li class={`perk${included ? '' : ' perk--no'}`}>
      {included ? <Check size={16} aria-hidden="true" /> : <Minus size={16} aria-hidden="true" />}
      <span>
        {typeof value === 'string' ? (
          <>
            {label}: <strong>{value}</strong>
          </>
        ) : (
          label
        )}
        {!included && <span class="visually-hidden"> (not included)</span>}
      </span>
    </li>
  );
}
