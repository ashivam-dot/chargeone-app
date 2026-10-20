import { BleClient, dataViewToText, numberToUUID, textToDataView, type BleService } from '@capacitor-community/bluetooth-le';
import { Listeners } from '../util.ts';
import type { ObdTransport } from './elm327.ts';

export interface ElmBleProfile {
  service: string;
  notify: string;
  write: string;
}

/** GATT layouts used by common Bluetooth LE ELM327 adapters (Vgate iCar, Veepeak, OBDLink CX and clones). */
export const ELM_BLE_PROFILES: ElmBleProfile[] = [
  { service: numberToUUID(0xffe0), notify: numberToUUID(0xffe1), write: numberToUUID(0xffe1) },
  { service: numberToUUID(0xfff0), notify: numberToUUID(0xfff1), write: numberToUUID(0xfff2) },
  { service: numberToUUID(0x18f0), notify: numberToUUID(0x2af0), write: numberToUUID(0x2af1) },
];

export interface ElmChannel {
  service: string;
  notify: string;
  write: string;
  withoutResponse: boolean;
}

/** Many adapters reject writes longer than the default 20-byte BLE payload. */
const MAX_WRITE_BYTES = 20;

/** Finds the notify and write characteristics of a known adapter layout among a device's services. */
export function pickElmChannel(services: BleService[]): ElmChannel | null {
  for (const profile of ELM_BLE_PROFILES) {
    const service = services.find((s) => s.uuid.toLowerCase() === profile.service);
    if (!service) continue;
    const chars = service.characteristics;
    const canNotify = (c: (typeof chars)[number]) => c.properties.notify || c.properties.indicate;
    const canWrite = (c: (typeof chars)[number]) => c.properties.write || c.properties.writeWithoutResponse;
    const notify =
      chars.find((c) => c.uuid.toLowerCase() === profile.notify && canNotify(c)) ?? chars.find(canNotify);
    const write = chars.find((c) => c.uuid.toLowerCase() === profile.write && canWrite(c)) ?? chars.find(canWrite);
    if (notify && write) {
      return { service: service.uuid, notify: notify.uuid, write: write.uuid, withoutResponse: !write.properties.write };
    }
  }
  return null;
}

export interface BleObdTransport extends ObdTransport {
  readonly deviceId: string;
}

export interface ConnectBleObdOptions {
  /** A previously paired adapter; otherwise the system device picker opens. */
  deviceId?: string;
  onDisconnect?: () => void;
}

/** Connects to a Bluetooth LE OBD-II adapter (Android, iOS, and Chrome via Web Bluetooth). */
export async function connectBleObd(opts: ConnectBleObdOptions = {}): Promise<BleObdTransport> {
  await BleClient.initialize();
  const deviceId =
    opts.deviceId ?? (await BleClient.requestDevice({ optionalServices: ELM_BLE_PROFILES.map((p) => p.service) })).deviceId;
  await BleClient.connect(deviceId, () => opts.onDisconnect?.());
  const channel = pickElmChannel(await BleClient.getServices(deviceId));
  if (!channel) {
    await BleClient.disconnect(deviceId).catch(() => undefined);
    throw new Error("That Bluetooth device doesn't look like an OBD-II adapter ChargeOne supports. Pick your ELM327 adapter.");
  }
  const listeners = new Listeners<string>();
  await BleClient.startNotifications(deviceId, channel.service, channel.notify, (value) => listeners.emit(dataViewToText(value)));

  return {
    deviceId,
    async write(text: string) {
      const full = text.endsWith('\r') ? text : `${text}\r`;
      for (let i = 0; i < full.length; i += MAX_WRITE_BYTES) {
        const value = textToDataView(full.slice(i, i + MAX_WRITE_BYTES));
        if (channel.withoutResponse) await BleClient.writeWithoutResponse(deviceId, channel.service, channel.write, value);
        else await BleClient.write(deviceId, channel.service, channel.write, value);
      }
    },
    onData: (cb) => listeners.add(cb),
    async close() {
      await BleClient.stopNotifications(deviceId, channel.service, channel.notify).catch(() => undefined);
      await BleClient.disconnect(deviceId).catch(() => undefined);
    },
  };
}
