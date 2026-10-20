import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OPERATOR_APPS, deviceFromUa, operatorAppFor, webLink } from './operatorApps.ts';

const st = (operator: string | null, name = 'EV charging station') => ({ operator, name });

describe('operatorAppFor', () => {
  it('matches the operator field, case-insensitively', () => {
    expect(operatorAppFor(st('Tata Power EZ Charge'))?.name).toBe('Tata Power EZ Charge');
    expect(operatorAppFor(st('TATA'))?.name).toBe('Tata Power EZ Charge');
    expect(operatorAppFor(st('Jio-bp pulse'))?.name).toBe('Jio-bp pulse');
    expect(operatorAppFor(st('Zeon Charging'))?.name).toBe('Zeon Charging');
  });

  it('puts the more specific network first', () => {
    expect(operatorAppFor(st('Tata Motors'))?.name).toBe('Tata Motors iRA.ev');
    expect(operatorAppFor(st('TGREDCO Statiq'))?.name).toBe('TGEV (TGREDCO)');
  });

  it('falls back to the station name when the operator is missing', () => {
    expect(operatorAppFor(st(null, 'Ather Fast Charger'))?.name).toBe('Ather Grid');
    expect(operatorAppFor(st(null, 'Chargezone EV Charging (Gentari)'))?.name).toBe('ChargeZone');
  });

  it('returns nothing for one-off hosts', () => {
    expect(operatorAppFor(st('Laxmi Refreshments', 'EV charging station'))).toBeNull();
    expect(operatorAppFor(st(null))).toBeNull();
  });

  it('covers most mapped stations in the shipped data', () => {
    const data = JSON.parse(readFileSync('public/data/stations.json', 'utf8')) as { stations: Array<{ operator: string | null; name: string }> };
    const matched = data.stations.filter((s) => operatorAppFor(s)).length;
    expect(matched).toBeGreaterThanOrEqual(260);
  });
});

describe('webLink', () => {
  const tata = operatorAppFor(st('Tata Power'))!;
  it('sends phones to their store page and desktops to the website', () => {
    expect(webLink(tata, 'android')?.href).toBe('https://play.google.com/store/apps/details?id=com.tatapower.evapp&hl=en_IN');
    expect(webLink(tata, 'ios')?.href).toBe('https://apps.apple.com/in/app/id1496350476');
    expect(webLink(tata, 'desktop')).toEqual({ href: 'https://www.tatapower.com', kind: 'website' });
  });
  it('uses the website when a platform has no app', () => {
    const magenta = operatorAppFor(st('Magenta ChargeGrid'))!;
    expect(webLink(magenta, 'android')?.kind).toBe('website');
  });
  it('reads the device from the user agent', () => {
    expect(deviceFromUa('Mozilla/5.0 (Linux; Android 14; Pixel 7)')).toBe('android');
    expect(deviceFromUa('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)')).toBe('ios');
    expect(deviceFromUa('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5)).toBe('ios');
    expect(deviceFromUa('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('desktop');
  });
});

describe('Android package visibility', () => {
  it('declares every operator app in <queries>, or Android 11+ reports it as not installed', () => {
    const manifest = readFileSync('android/app/src/main/AndroidManifest.xml', 'utf8');
    const missing = OPERATOR_APPS.flatMap((a) => (a.androidPackage && !manifest.includes(`<package android:name="${a.androidPackage}" />`) ? [a.androidPackage] : []));
    expect(missing).toEqual([]);
  });
});
