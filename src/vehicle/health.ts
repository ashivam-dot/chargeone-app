import type { SourceKind } from './types.ts';

export type EfficiencyLabel = 'Better than rated' | 'Good' | 'Fair' | 'Heavy';

export interface Efficiency {
  /** 0–100; 85 means driving exactly at the rated figure. */
  score: number;
  label: EfficiencyLabel;
}

/** How live consumption compares with the car's rated figure. null when either number is missing or invalid. */
export function efficiencyScore(liveWhPerKm: number | null, ratedWhPerKm: number): Efficiency | null {
  if (liveWhPerKm === null || !(liveWhPerKm > 0) || !(ratedWhPerKm > 0)) return null;
  const ratio = liveWhPerKm / ratedWhPerKm;
  const score = Math.round(Math.max(0, Math.min(100, 85 - 150 * (ratio - 1))));
  const label: EfficiencyLabel = ratio <= 1 ? 'Better than rated' : score >= 70 ? 'Good' : score >= 50 ? 'Fair' : 'Heavy';
  return { score, label };
}

const SOH_UNAVAILABLE: Record<SourceKind, string> = {
  phone: 'Not available from phone tracking',
  obd: "Not available: your car doesn't report battery health over standard OBD-II",
  demo: 'Not available',
};

/** Battery health in words. Only a figure the car itself reports is described; nothing is guessed. */
export function sohLabel(sohPct: number | null, source: SourceKind = 'phone'): string {
  if (sohPct === null || !Number.isFinite(sohPct)) return SOH_UNAVAILABLE[source];
  const pct = Math.round(Math.max(0, Math.min(100, sohPct)));
  const words = pct >= 90 ? 'Healthy' : pct >= 80 ? 'Normal wear' : pct >= 70 ? 'Noticeable wear' : 'Worn: get the battery checked';
  return `${words} (${pct}%)${source === 'demo' ? ', simulated' : ''}`;
}
