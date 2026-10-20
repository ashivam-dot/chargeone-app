import { Lock } from 'lucide-preact';
import type { Plan } from '../shared/plans.ts';

interface Props {
  text: string;
  plan: Plan;
  onUnlock: () => void;
}

/** A paid feature the current plan doesn't include, shown in place with the plan that unlocks it. */
export function PerkLock({ text, plan, onUnlock }: Props) {
  const name = plan.id === 'trip_pass' ? 'Trip Pass' : 'Plus';
  return (
    <button type="button" class="perk-lock" onClick={onUnlock}>
      <Lock size={14} aria-hidden="true" />
      <span class="visually-hidden">Locked: </span>
      <span class="perk-lock__text">{text}</span>
      <span class="perk-lock__plan">
        <span class="visually-hidden">. Unlock with </span>
        {name}
      </span>
    </button>
  );
}
