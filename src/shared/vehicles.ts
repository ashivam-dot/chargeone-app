import type { ConnectorType } from '../data/model.ts';

export interface VehicleModel {
  id: string;
  name: string;
  /** Usable battery, kWh (approximate). */
  batteryKwh: number;
  /** Typical highway consumption at ~80 km/h with AC on, Wh/km (approximate). */
  highwayWhPerKm: number;
  /** Peak DC charging power the car accepts, kW. null = AC charging only. */
  maxDcKw: number | null;
  maxAcKw: number;
  /** Kerb weight plus driver, kg (approximate), used for hill energy. */
  massKg: number;
  dcConnector: ConnectorType | null;
}

/**
 * Starting values only. Real consumption varies with speed, load, weather and battery age, so the
 * app asks drivers for their real highway range and uses that when given.
 */
export const VEHICLES: VehicleModel[] = [
  { id: 'tata-nexon-ev-45', name: 'Tata Nexon EV 45', batteryKwh: 45, highwayWhPerKm: 150, maxDcKw: 60, maxAcKw: 7.2, massKg: 1500, dcConnector: 'CCS2' },
  { id: 'tata-nexon-ev-30', name: 'Tata Nexon EV 30', batteryKwh: 30, highwayWhPerKm: 145, maxDcKw: 50, maxAcKw: 7.2, massKg: 1450, dcConnector: 'CCS2' },
  { id: 'tata-punch-ev-35', name: 'Tata Punch EV 35', batteryKwh: 35, highwayWhPerKm: 135, maxDcKw: 50, maxAcKw: 7.2, massKg: 1350, dcConnector: 'CCS2' },
  { id: 'tata-tiago-ev-24', name: 'Tata Tiago EV 24', batteryKwh: 24, highwayWhPerKm: 125, maxDcKw: 25, maxAcKw: 7.2, massKg: 1250, dcConnector: 'CCS2' },
  { id: 'tata-curvv-ev-55', name: 'Tata Curvv EV 55', batteryKwh: 55, highwayWhPerKm: 150, maxDcKw: 70, maxAcKw: 7.2, massKg: 1650, dcConnector: 'CCS2' },
  { id: 'tata-harrier-ev-75', name: 'Tata Harrier EV 75', batteryKwh: 75, highwayWhPerKm: 175, maxDcKw: 120, maxAcKw: 7.2, massKg: 2100, dcConnector: 'CCS2' },
  { id: 'mg-zs-ev', name: 'MG ZS EV', batteryKwh: 50, highwayWhPerKm: 165, maxDcKw: 50, maxAcKw: 7.4, massKg: 1650, dcConnector: 'CCS2' },
  { id: 'mg-windsor-38', name: 'MG Windsor EV 38', batteryKwh: 38, highwayWhPerKm: 145, maxDcKw: 45, maxAcKw: 7.4, massKg: 1650, dcConnector: 'CCS2' },
  { id: 'mg-windsor-pro-53', name: 'MG Windsor EV Pro 52.9', batteryKwh: 52.9, highwayWhPerKm: 150, maxDcKw: 60, maxAcKw: 7.4, massKg: 1700, dcConnector: 'CCS2' },
  { id: 'mg-comet', name: 'MG Comet EV', batteryKwh: 17.3, highwayWhPerKm: 115, maxDcKw: null, maxAcKw: 3.3, massKg: 900, dcConnector: null },
  { id: 'mahindra-xuv400', name: 'Mahindra XUV400 EV', batteryKwh: 39.4, highwayWhPerKm: 160, maxDcKw: 50, maxAcKw: 7.2, massKg: 1650, dcConnector: 'CCS2' },
  { id: 'mahindra-be6-79', name: 'Mahindra BE 6 (79 kWh)', batteryKwh: 79, highwayWhPerKm: 165, maxDcKw: 175, maxAcKw: 11, massKg: 2050, dcConnector: 'CCS2' },
  { id: 'mahindra-xev9e-79', name: 'Mahindra XEV 9e (79 kWh)', batteryKwh: 79, highwayWhPerKm: 175, maxDcKw: 175, maxAcKw: 11, massKg: 2250, dcConnector: 'CCS2' },
  { id: 'hyundai-creta-electric-51', name: 'Hyundai Creta Electric 51.4', batteryKwh: 51.4, highwayWhPerKm: 150, maxDcKw: 75, maxAcKw: 11, massKg: 1650, dcConnector: 'CCS2' },
  { id: 'hyundai-ioniq5', name: 'Hyundai Ioniq 5', batteryKwh: 72.6, highwayWhPerKm: 170, maxDcKw: 220, maxAcKw: 11, massKg: 2100, dcConnector: 'CCS2' },
  { id: 'kia-ev6', name: 'Kia EV6', batteryKwh: 84, highwayWhPerKm: 175, maxDcKw: 240, maxAcKw: 11, massKg: 2100, dcConnector: 'CCS2' },
  { id: 'byd-atto3', name: 'BYD Atto 3', batteryKwh: 60.5, highwayWhPerKm: 165, maxDcKw: 80, maxAcKw: 7, massKg: 1850, dcConnector: 'CCS2' },
  { id: 'byd-seal', name: 'BYD Seal', batteryKwh: 82.5, highwayWhPerKm: 165, maxDcKw: 150, maxAcKw: 7, massKg: 2150, dcConnector: 'CCS2' },
  { id: 'byd-emax7', name: 'BYD eMax 7', batteryKwh: 71.8, highwayWhPerKm: 175, maxDcKw: 115, maxAcKw: 7, massKg: 2000, dcConnector: 'CCS2' },
  { id: 'citroen-ec3', name: 'Citroën ë-C3', batteryKwh: 29.2, highwayWhPerKm: 135, maxDcKw: 30, maxAcKw: 3.3, massKg: 1350, dcConnector: 'CCS2' },
  { id: 'maruti-e-vitara-61', name: 'Maruti e Vitara 61', batteryKwh: 61, highwayWhPerKm: 155, maxDcKw: 70, maxAcKw: 11, massKg: 1800, dcConnector: 'CCS2' },
  { id: 'tesla-model-y', name: 'Tesla Model Y', batteryKwh: 60, highwayWhPerKm: 150, maxDcKw: 175, maxAcKw: 11, massKg: 2000, dcConnector: 'CCS2' },
  { id: 'vinfast-vf7', name: 'VinFast VF 7', batteryKwh: 70.8, highwayWhPerKm: 170, maxDcKw: 80, maxAcKw: 11, massKg: 2000, dcConnector: 'CCS2' },
];

export const CUSTOM_VEHICLE_ID = 'custom';

export interface MyVehicle {
  modelId: string;
  name: string;
  batteryKwh: number;
  /** Real highway range on a full battery, km, as the driver knows it. Overrides the model figure. */
  realRangeKm: number | null;
  maxDcKw: number | null;
  maxAcKw: number;
  massKg: number;
  dcConnector: ConnectorType | null;
}

export function myVehicleFromModel(m: VehicleModel): MyVehicle {
  return {
    modelId: m.id,
    name: m.name,
    batteryKwh: m.batteryKwh,
    realRangeKm: null,
    maxDcKw: m.maxDcKw,
    maxAcKw: m.maxAcKw,
    massKg: m.massKg,
    dcConnector: m.dcConnector,
  };
}

export function baseWhPerKm(v: MyVehicle): number {
  if (v.realRangeKm && v.realRangeKm > 0) return (v.batteryKwh * 1000) / v.realRangeKm;
  const model = VEHICLES.find((m) => m.id === v.modelId);
  return model?.highwayWhPerKm ?? 155;
}
