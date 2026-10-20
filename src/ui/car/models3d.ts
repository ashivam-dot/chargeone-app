import { bodyTypeFor, type BodyType } from './carArt.ts';

export interface Car3dModel {
  url: string;
  /** Name of the glTF material that is the body paint, tinted to the user's colour. */
  paintMaterial: string;
  /** True only for a licensed model of this exact car; generic bodies are labelled as such. */
  exact: boolean;
  credit: string;
}

const BODY: Record<BodyType, Car3dModel> = {
  suv: { url: '/models/suv.glb', paintMaterial: 'White', exact: false, credit: 'SUV by Quaternius (CC0)' },
  hatch: { url: '/models/hatch.glb', paintMaterial: 'LightBlue', exact: false, credit: 'Car by Quaternius (CC0)' },
  sedan: { url: '/models/sedan.glb', paintMaterial: 'Blue', exact: false, credit: 'Car by Quaternius (CC0)' },
};

/**
 * Models of the exact car, only where the licence allows app use (CC0 or CC BY with credit, logos removed).
 * Keyed by the start of the vehicle id. Research on 2026-10-21 found such models for the Hyundai Ioniq 5
 * (andikapratamaw, CC BY 4.0) and the Tata Punch (rahuld, CC BY 4.0); both download from a Sketchfab account,
 * so they are added here once the files are in `public/models/cars/`.
 */
const EXACT: Array<[prefix: string, model: Car3dModel]> = [];

export function car3dFor(modelId: string): Car3dModel {
  return EXACT.find(([prefix]) => modelId.startsWith(prefix))?.[1] ?? BODY[bodyTypeFor(modelId)];
}

export const CAR_MODEL_CREDITS = [...new Set([...Object.values(BODY), ...EXACT.map(([, m]) => m)].map((m) => m.credit))];
