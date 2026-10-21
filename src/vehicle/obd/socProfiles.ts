// Reading battery % from EVs that do not answer the standard OBD-II PID 0x5B, using each maker's own
// diagnostic "state of charge" identifier. These are read-only Mode 22 ReadDataByIdentifier requests
// taken from published community PID lists — the same ones Car Scanner and Torque Pro ship. ChargeOne
// only ever reads; it never writes, clears codes, or reverse-engineers a maker's phone app.
//
// Every profile value is range-gated (decode returns null outside 0-100 %) and cross-checked on connect
// (two reads must agree), so a wrong car or changed firmware shows nothing rather than a misleading number.

import type { Maker } from '../../shared/vin.ts';

export interface SocProfile {
  maker: Maker;
  /** Short label for the About page and logs, e.g. 'MG BMS (22B046)'. */
  label: string;
  /** ATSH header of the ECU (BMS) that answers. */
  header: string;
  /** Mode 22 request, e.g. '22B046'. */
  request: string;
  /** Cleaned response prefix to find in the reply, e.g. '62B046'. */
  responsePrefix: string;
  /** Data bytes after the prefix → SoC %, or null when the value is outside the plausible 0-100 range. */
  decode: (data: number[]) => number | null;
  /** Published source for the PID and its formula. */
  source: string;
}

function pct(v: number): number | null {
  return Number.isFinite(v) && v > 0 && v <= 100 ? Math.round(v * 10) / 10 : null;
}

export const SOC_PROFILES: readonly SocProfile[] = [
  {
    maker: 'mg',
    label: 'MG BMS (22B046)',
    header: '781',
    request: '22B046',
    responsePrefix: '62B046',
    // INT16(A:B) / 10. Verified on an MG ZS EV: 62 B0 46 02 68 → 0x0268 / 10 = 61.6 %.
    decode: (b) => (b.length >= 2 ? pct(((b[0] << 8) | b[1]) / 10) : null),
    source: 'github.com/peternixon/MG-EV-OBD-PID',
  },
  {
    maker: 'byd',
    label: 'BYD BMS (221FFC)',
    header: '7E7',
    request: '221FFC',
    responsePrefix: '621FFC',
    // (A + B * 256) / 100, little-endian. Verified on a BYD Atto 3: 62 1F FC 24 22 → (36 + 34*256) / 100 = 87.4 %.
    decode: (b) => (b.length >= 2 ? pct((b[0] + b[1] * 256) / 100) : null),
    source: 'github.com/loryanstrant/BYD-PID-list',
  },
];

/** The maker-specific SoC profile to try when the car skips the standard PID 0x5B, or null. */
export function socProfileFor(maker: Maker): SocProfile | null {
  return SOC_PROFILES.find((p) => p.maker === maker) ?? null;
}

/** The maker an app vehicle id belongs to (ids are '<maker>-<model>…'). */
export function makerFromModelId(modelId: string): Maker {
  const makers: Maker[] = ['tata', 'mahindra', 'mg', 'hyundai', 'kia', 'maruti', 'citroen', 'toyota', 'jeep', 'byd', 'tesla', 'vinfast'];
  const head = modelId.split('-')[0] as Maker;
  return makers.includes(head) ? head : 'other';
}
