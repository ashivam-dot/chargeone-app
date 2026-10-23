import type { Licence, LicenceId } from './types.ts';

export const LICENCES: Record<LicenceId, Licence> = {
  'ODbL-1.0': {
    id: 'ODbL-1.0',
    name: 'Open Database License 1.0',
    attribution: '© OpenStreetMap contributors',
    url: 'https://www.openstreetmap.org/copyright',
    obligations:
      'Show "© OpenStreetMap contributors (ODbL)". The merged station layer is a derivative database: offer it under ODbL 1.0 (see chargeone-stations-odbl.zip).',
  },
  'CC-BY-4.0': {
    id: 'CC-BY-4.0',
    name: 'Creative Commons Attribution 4.0 International',
    attribution: 'Contains data from Open Charge Map contributors',
    url: 'https://openchargemap.org/site/about/terms',
    obligations:
      'Show "Contains data from Open Charge Map contributors (CC BY 4.0)". Only records from Data Provider 1 (Open Charge Map Contributors) are imported.',
  },
};

/** Government counts used as completeness denominators (not station data). */
export const GOVERNMENT_COUNTS_ATTRIBUTION = 'Government counts: Ministry of Heavy Industries, Rajya Sabha answers (via BHEL)';

/** State shapes, used only to count stations per state; never shown or shipped. */
export const BOUNDARIES_ATTRIBUTION = {
  name: 'geoBoundaries IND ADM1 (DataMeet India community, Election Commission of India)',
  licence: 'CC BY 2.5 IN',
  url: 'https://www.geoboundaries.org/',
};
