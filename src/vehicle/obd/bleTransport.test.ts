import type { BleCharacteristicProperties, BleService } from '@capacitor-community/bluetooth-le';
import { describe, expect, it } from 'vitest';
import { ELM_BLE_PROFILES, pickElmChannel } from './bleTransport.ts';

const none: BleCharacteristicProperties = {
  broadcast: false,
  read: false,
  writeWithoutResponse: false,
  write: false,
  notify: false,
  indicate: false,
  authenticatedSignedWrites: false,
};

function service(uuid: string, chars: Array<[string, Partial<BleCharacteristicProperties>]>): BleService {
  return { uuid, characteristics: chars.map(([u, p]) => ({ uuid: u, properties: { ...none, ...p }, descriptors: [] })) };
}

describe('pickElmChannel', () => {
  it('uses the full 128-bit UUIDs of the common adapter layouts', () => {
    expect(ELM_BLE_PROFILES.map((p) => p.service)).toEqual([
      '0000ffe0-0000-1000-8000-00805f9b34fb',
      '0000fff0-0000-1000-8000-00805f9b34fb',
      '000018f0-0000-1000-8000-00805f9b34fb',
    ]);
  });

  it('finds the shared notify/write characteristic on FFE0 adapters', () => {
    const ch = pickElmChannel([
      service('00001800-0000-1000-8000-00805f9b34fb', [['00002a00-0000-1000-8000-00805f9b34fb', { read: true }]]),
      service('0000FFE0-0000-1000-8000-00805F9B34FB', [['0000FFE1-0000-1000-8000-00805F9B34FB', { notify: true, write: true, writeWithoutResponse: true }]]),
    ]);
    expect(ch).toEqual({
      service: '0000FFE0-0000-1000-8000-00805F9B34FB',
      notify: '0000FFE1-0000-1000-8000-00805F9B34FB',
      write: '0000FFE1-0000-1000-8000-00805F9B34FB',
      withoutResponse: false,
    });
  });

  it('pairs separate notify and write characteristics on FFF0 and 18F0 adapters', () => {
    expect(
      pickElmChannel([
        service('0000fff0-0000-1000-8000-00805f9b34fb', [
          ['0000fff1-0000-1000-8000-00805f9b34fb', { notify: true }],
          ['0000fff2-0000-1000-8000-00805f9b34fb', { writeWithoutResponse: true }],
        ]),
      ]),
    ).toMatchObject({ notify: '0000fff1-0000-1000-8000-00805f9b34fb', write: '0000fff2-0000-1000-8000-00805f9b34fb', withoutResponse: true });
    expect(
      pickElmChannel([
        service('000018f0-0000-1000-8000-00805f9b34fb', [
          ['00002af0-0000-1000-8000-00805f9b34fb', { indicate: true }],
          ['00002af1-0000-1000-8000-00805f9b34fb', { write: true }],
        ]),
      ]),
    ).toMatchObject({ notify: '00002af0-0000-1000-8000-00805f9b34fb', write: '00002af1-0000-1000-8000-00805f9b34fb' });
  });

  it('rejects devices without a known adapter service', () => {
    expect(pickElmChannel([service('0000180d-0000-1000-8000-00805f9b34fb', [['00002a37-0000-1000-8000-00805f9b34fb', { notify: true }]])])).toBeNull();
    expect(pickElmChannel([service('0000fff0-0000-1000-8000-00805f9b34fb', [['0000fff1-0000-1000-8000-00805f9b34fb', { read: true }]])])).toBeNull();
  });
});
