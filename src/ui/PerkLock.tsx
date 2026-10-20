import { Lock } from 'lucide-preact';
import type { Plan } from '../shared/plans.ts';

interface Props {
  text: string;
  plan: Plan;
  onUnlock: () => void;
}

/** A paid feature the current plan doesn't include, shown in place with the plan that unlocks it. */
export function PerkLock({ text, plan, onUnlock }: Props) {
  return (
    <button type="button" class="perk-lock" onClick={onUnlock}>
      <Lock size={14} aria-hidden="true" />
      <span class="perk-lock__text">{text}</span>
      <span class="perk-lock__plan">{plan.id === 'trip_pass' ? 'Trip Pass' : 'Plus'}</span>
    </button>
  );
}
