import type { Licence, LicenceId } from './types.ts';

/** The Telangana dataset page (Telangana Open Data Portal, DKAN dataset dc299957-9d16-4345-957e-ee93a31b6011). */
export const TGREDCO_DATASET_URL = 'https://data.telangana.gov.in/dataset/ev-charging-stations-details-location-ownership';

/** GODL-India attribution: provider, portal, licence, link, and no endorsement. */
export const TGREDCO_ATTRIBUTION =
  `Contains data from Telangana Renewable Energy Development Corporation (TGREDCO), "EV charging stations - details of location & ownership" (data as of April 2024), Telangana Open Data Portal, under the Government Open Data License - India (${TGREDCO_DATASET_URL}). Not endorsed by the data provider.`;

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
  'GODL-India': {
    id: 'GODL-India',
    name: 'Government Open Data License - India',
    attribution: TGREDCO_ATTRIBUTION,
    url: 'https://data.gov.in/government-open-data-license-india',
    obligations:
      'Show the attribution above (provider TGREDCO, the Telangana Open Data Portal, the licence and a link to the dataset). Free for commercial use; the data must not be misrepresented, and the provider does not endorse ChargeOne. Location-only listings: never uploaded to OpenStreetMap (ODbL-incompatible attribution terms).',
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
