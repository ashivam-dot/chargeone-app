// The charging network's own app for a station, so a driver can check live status and pay there.
// Every androidPackage was checked on Google Play (HTTP 200, matching title and developer) and every
// iosAppId through the iTunes lookup for India (one result, matching name and seller), 2026-10-21.
// Nothing here was taken from inside an app: apps open by package name or by their store page.

export interface OperatorApp {
  /** RegExp source, compiled with the `i` flag. The first match wins, so order matters. */
  operatorMatch: string;
  name: string;
  androidPackage: string | null;
  iosAppId: string | null;
  website: string | null;
}

export const OPERATOR_APPS: OperatorApp[] = [
  { operatorMatch: 'tata\\s*motors|tata\\.ev|\\bira\\.ev', name: 'Tata Motors iRA.ev', androidPackage: 'com.tatamotors.evoneapp', iosAppId: '6470965268', website: 'https://ev.tatamotors.com' },
  { operatorMatch: '\\btata\\b|ez\\s*charge', name: 'Tata Power EZ Charge', androidPackage: 'com.tatapower.evapp', iosAppId: '1496350476', website: 'https://www.tatapower.com' },
  { operatorMatch: 't[gs]\\s*redco|\\btgev\\b', name: 'TGEV (TGREDCO)', androidPackage: 'com.statiq.tsredco', iosAppId: '1628094846', website: 'https://tsredco.telangana.gov.in' },
  { operatorMatch: 'statiq', name: 'Statiq', androidPackage: 'com.statiq', iosAppId: '1520534378', website: 'https://www.statiq.in' },
  { operatorMatch: 'charge\\s*zone|gentari', name: 'ChargeZone', androidPackage: 'com.chargezone', iosAppId: '1627426498', website: 'https://www.chargezone.com' },
  { operatorMatch: 'jio[\\s-]*(bp|pulse)|\\bbp\\s*pulse', name: 'Jio-bp pulse', androidPackage: 'com.jiobp.pulse_charge', iosAppId: '6503143542', website: 'https://www.jiobp.com' },
  { operatorMatch: '\\bzeon\\b', name: 'Zeon Charging', androidPackage: 'com.namp.zeon', iosAppId: '1539882735', website: 'https://zeoncharging.com' },
  { operatorMatch: 'glida|fortum', name: 'Glida', androidPackage: 'com.fortum.ChargeAndDriveIndia', iosAppId: '1340234932', website: 'https://www.glida.in' },
  { operatorMatch: '\\bather\\b', name: 'Ather Grid', androidPackage: 'com.atherenergy.aegridapp', iosAppId: '1356687521', website: 'https://www.atherenergy.com' },
  { operatorMatch: 'kazam', name: 'Kazam', androidPackage: 'com.kazam.ev', iosAppId: '1563868545', website: 'https://kazam.energy' },
  { operatorMatch: '^bolt\\b|bolt\\.earth', name: 'Bolt.Earth', androidPackage: 'com.revos.bolt.android', iosAppId: '1541141946', website: 'https://bolt.earth' },
  { operatorMatch: 'electree\\s*fi', name: 'ElectreeFi', androidPackage: 'com.electreefi.techperspect', iosAppId: '1460812420', website: 'https://electreefi.com' },
  { operatorMatch: 'relux', name: 'Relux Electric', androidPackage: 'com.namp.relux', iosAppId: '1552174323', website: 'http://www.reluxelectric.com' },
  // The Android app was removed from Play; Android opens the website.
  { operatorMatch: 'magenta|charge\\s*grid', name: 'Magenta ChargeGrid', androidPackage: null, iosAppId: '1575081547', website: 'https://www.magentamobility.com' },
  { operatorMatch: '\\bshell\\b', name: 'Shell Recharge India', androidPackage: 'com.shell.sitibv.rechargeindia', iosAppId: '1639995262', website: 'https://www.shell.in/motorists/shell-recharge.html' },
  { operatorMatch: '\\bhpcl\\b|\\bhp\\s*e-?charge|hind\\w*\\s*petrol', name: 'HP eCharge', androidPackage: 'com.hpcl.ev', iosAppId: '6446473854', website: 'https://www.hindustanpetroleum.com' },
  { operatorMatch: '\\bbpcl\\b|bharat\\s*petroleum', name: 'eDrive BPCL', androidPackage: 'com.edrive.bpcl', iosAppId: '6502164392', website: 'https://www.bharatpetroleum.in' },
  { operatorMatch: 'indian\\s*oil|\\biocl?\\b', name: 'IndianOil e-Charge', androidPackage: 'com.iocl.ev', iosAppId: '6450923369', website: 'https://iocl.com' },
  { operatorMatch: 'ionage', name: 'IONAGE', androidPackage: 'com.ionage.app', iosAppId: '1591774543', website: 'https://www.ionage.in' },
  { operatorMatch: '\\bevre\\b', name: 'EVRE One', androidPackage: 'in.evre.charge', iosAppId: '6806952575', website: 'https://www.evre.in' },
  { operatorMatch: 'park\\s*\\+|park\\s*plus', name: 'Park+', androidPackage: 'com.ovunque.parkwheels', iosAppId: '1244749178', website: 'https://parkplus.io' },
  { operatorMatch: '\\bmg\\s*(motor|e?hub|charge)|\\behub\\b', name: 'eHUB by MG', androidPackage: 'com.mgmotor.ehub', iosAppId: '6578443964', website: 'https://www.mgmotor.co.in' },
  { operatorMatch: 'mahindra|charge_?in\\b', name: 'Charge_iN (Mahindra)', androidPackage: 'com.mahendra.chargin', iosAppId: '6754163852', website: 'https://www.mahindra.com' },
  { operatorMatch: 'hyundai', name: 'myHyundai (India)', androidPackage: 'com.hmil.myhyundai', iosAppId: '6444684620', website: 'https://www.hyundai.com/in/en' },
  { operatorMatch: '\\bkseb\\b', name: 'KeMAPP (KSEB)', androidPackage: 'com.bpm.ksebapp', iosAppId: '6447747383', website: 'https://kseb.in' },
  { operatorMatch: 'honda', name: 'Honda e:Swap', androidPackage: 'com.honda_mpp.in.heid.eswap', iosAppId: '1617607025', website: 'https://www.honda-mpp.com/in/' },
  { operatorMatch: 'yuma', name: 'Yuma Energy', androidPackage: 'com.yuma.oem', iosAppId: '6752381305', website: 'https://yuma.energy' },
  { operatorMatch: 'electriva', name: 'ElectriVa', androidPackage: 'com.electriva', iosAppId: '1618431262', website: 'https://electriva.in' },
  { operatorMatch: '\\bvida\\b', name: 'VIDA Charge', androidPackage: 'com.hero.communitycharging', iosAppId: '6474018826', website: 'https://www.vidaworld.com' },
  { operatorMatch: 'bescom', name: 'BESCOM EV Mithra', androidPackage: 'com.bescom.evmithra', iosAppId: '6633439725', website: 'https://bescom.karnataka.gov.in' },
  { operatorMatch: '\\bgo\\s*ec\\b', name: 'GOEC', androidPackage: 'com.namp.azadpower', iosAppId: '1600027947', website: 'https://goecworld.com' },
  { operatorMatch: 'sun\\s*mobility', name: 'SUN Mobility', androidPackage: 'com.sunmobility.app', iosAppId: '6761612320', website: 'https://www.sunmobility.com' },
  { operatorMatch: 'bijlify', name: 'Bijlify', androidPackage: 'com.evigo.evigo', iosAppId: '1579016328', website: 'https://bijlifynow.com' },
  { operatorMatch: 'tesla', name: 'Tesla', androidPackage: 'com.teslamotors.tesla', iosAppId: '582007913', website: 'https://www.tesla.com/en_in' },
  { operatorMatch: 'adani', name: 'Adani Gas EV Charging (ATGL)', androidPackage: 'com.namp.adani', iosAppId: '1614424084', website: 'https://www.adanigas.com' },
  { operatorMatch: 'lectrix', name: 'Lectrix', androidPackage: 'ai.lime.lectrix', iosAppId: '1637083917', website: 'https://lectrixev.com' },
  { operatorMatch: 'vinfast', name: 'VinFast', androidPackage: 'com.vinfast.in', iosAppId: '6748715154', website: 'https://vinfastauto.in' },
  { operatorMatch: 'plug\\s*share', name: 'PlugShare', androidPackage: 'com.xatori.Plugshare', iosAppId: '421788217', website: 'https://www.plugshare.com' },
  { operatorMatch: '\\bola\\b', name: 'Ola Electric', androidPackage: 'com.olaelectric.companion', iosAppId: '1537809074', website: 'https://www.olaelectric.com' },
  { operatorMatch: 'battery\\s*smart', name: 'Battery Smart', androidPackage: 'com.mobile.batterysmart', iosAppId: null, website: 'https://www.batterysmart.in' },
  { operatorMatch: 'charge\\s*mod', name: 'chargeMOD', androidPackage: 'com.bpm.chargemod', iosAppId: '1661535841', website: 'https://www.chargemod.com' },
  { operatorMatch: 'yulu', name: 'Yulu', androidPackage: 'app.yulu.bike', iosAppId: '1331504548', website: 'https://www.yulu.bike' },
  { operatorMatch: 'e?xicom', name: 'SPIN by Exicom', androidPackage: 'com.exicom.android.spinev', iosAppId: '1636262264', website: 'https://www.exicom.in' },
  { operatorMatch: '\\bevok\\b', name: 'EVOK', androidPackage: 'com.bpm.evok', iosAppId: '6449674142', website: 'https://evok.co.in' },
  { operatorMatch: 'uplug', name: 'Uplug', androidPackage: 'com.uplugappnew.techperspect', iosAppId: '6761747989', website: 'https://uplug.co.in' },
  { operatorMatch: 'ev\\s*dock', name: 'EV Dock', androidPackage: 'app.evdock.evdock', iosAppId: '1625633222', website: 'https://tritanev.com' },
  // EESL's public charging runs through its subsidiary CESL.
  { operatorMatch: '\\b[ec]esl\\b', name: 'CESL Smart Charge', androidPackage: 'com.cesl.echarge', iosAppId: '6446774678', website: 'https://cesl.electreefi.com' },
  { operatorMatch: 'mahavitaran|msedcl|power\\s*up', name: 'PowerUpEV (MSEDCL)', androidPackage: 'com.nxccontrols.msedcl', iosAppId: null, website: 'https://www.mahadiscom.in' },
  { operatorMatch: 'volt?r[ao]n', name: 'Voltran', androidPackage: 'com.voltran.app', iosAppId: null, website: 'https://www.voltran.in' },
  { operatorMatch: 'go\\s*e\\s*go', name: 'goME (goEgo Network)', androidPackage: 'com.goegonetwork.app', iosAppId: null, website: 'https://goegonetwork.com' },
  { operatorMatch: 'charj\\s*karo', name: 'CHARJKARO', androidPackage: 'com.charjkaro', iosAppId: null, website: null },
  { operatorMatch: 'esygo', name: 'ESYGO', androidPackage: 'com.esygo.esyandroid', iosAppId: null, website: 'http://www.esygo.in' },
  { operatorMatch: 'nikol', name: 'Nikol EV', androidPackage: 'com.nikolev', iosAppId: '1626784251', website: 'http://nikolev.in' },
  { operatorMatch: 'mercedes', name: 'Mercedes-Benz', androidPackage: 'com.daimler.ris.mercedesme.ece.android', iosAppId: '1487652920', website: 'https://www.mercedes-benz.co.in' },
  { operatorMatch: '\\bbmw\\b', name: 'My BMW', androidPackage: 'de.bmw.connected.mobile20.row', iosAppId: '1519034860', website: 'https://www.bmw.in' },
  { operatorMatch: 'pulse\\s*energy', name: 'Pulse Energy', androidPackage: 'com.pulseenergy.pulse', iosAppId: '1526714273', website: 'https://pulseenergy.io' },
  { operatorMatch: 'electric\\s*pe\\b', name: 'ElectricPe', androidPackage: 'com.wattapp.electricpe', iosAppId: '1612648568', website: 'https://electricpe.com' },
  { operatorMatch: 'indofast', name: 'Indofast Rider', androidPackage: 'com.indofast.rider', iosAppId: null, website: 'https://www.indofastenergy.com' },
  { operatorMatch: '\\bbses\\b', name: 'BSES EV', androidPackage: 'com.bses.elv', iosAppId: null, website: 'https://www.bsesdelhi.com' },
  { operatorMatch: 'minooki', name: 'MINOOKI', androidPackage: 'com.minooki.android.apps.minooki.bc', iosAppId: '1662339092', website: 'https://minooki.com' },
  { operatorMatch: 'one\\s*delhi|switch\\s*delhi', name: 'One Delhi', androidPackage: 'com.delhitransport.onedelhi', iosAppId: null, website: 'https://ev.delhi.gov.in' },
];

const COMPILED = OPERATOR_APPS.map((app) => ({ app, re: new RegExp(app.operatorMatch, 'i') }));

/** The operator's app for a station, matched on its operator first and then on its name. */
export function operatorAppFor(station: { operator: string | null; name: string }): OperatorApp | null {
  for (const text of [station.operator, station.name]) {
    if (!text) continue;
    const hit = COMPILED.find((c) => c.re.test(text));
    if (hit) return hit.app;
  }
  return null;
}

export const playUrl = (pkg: string) => `https://play.google.com/store/apps/details?id=${encodeURIComponent(pkg)}&hl=en_IN`;
export const appStoreUrl = (id: string) => `https://apps.apple.com/in/app/id${encodeURIComponent(id)}`;

export type AppDevice = 'android' | 'ios' | 'desktop';

export function deviceFromUa(ua: string, touchPoints = 0): AppDevice {
  if (/Android/i.test(ua)) return 'android';
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1)) return 'ios';
  return 'desktop';
}

/** For the web app: the store page on phones (it shows Open when the app is installed), the website on desktop. */
export function webLink(app: OperatorApp, device: AppDevice): { href: string; kind: 'store' | 'website' } | null {
  if (device === 'android' && app.androidPackage) return { href: playUrl(app.androidPackage), kind: 'store' };
  if (device === 'ios' && app.iosAppId) return { href: appStoreUrl(app.iosAppId), kind: 'store' };
  return app.website ? { href: app.website, kind: 'website' } : null;
}
