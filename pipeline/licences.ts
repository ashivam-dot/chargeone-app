import type { Licence, LicenceId } from './types.ts';

/** The Telangana dataset page (Telangana Open Data Portal, DKAN dataset dc299957-9d16-4345-957e-ee93a31b6011). */
export const TGREDCO_DATASET_URL = 'https://data.telangana.gov.in/dataset/ev-charging-stations-details-location-ownership';

/** GODL-India attribution: provider, portal, licence, link, and no endorsement. */
export const TGREDCO_ATTRIBUTION =
  `Contains data from Telangana Renewable Energy Development Corporation (TGREDCO), "EV charging stations - details of location & ownership" (data as of April 2024), Telangana Open Data Portal, under the Government Open Data License - India (${TGREDCO_DATASET_URL}). Not endorsed by the data provider.`;

/** Overture Maps Places attribution (https://docs.overturemaps.org/attribution/). */
export const OVERTURE_ATTRIBUTION_URL = 'https://docs.overturemaps.org/attribution/';

/**
 * The Places theme's contributors under CDLA Permissive 2.0, as Overture lists them. A record whose
 * `sources[].dataset` is not here, Foursquare or AllThePlaces is refused (overture.ts).
 */
export const OVERTURE_CDLA_CONTRIBUTORS = [
  'Meta',
  'Microsoft',
  'PinMeTo',
  'Krick',
  'RenderSEO',
  'DAC',
  'BrightQuery',
  'Birdeye',
  'Uberall',
  'OpenTravel Alliance',
] as const;

/** Overture's required Foursquare line (Places attribution page). */
export const FOURSQUARE_ATTRIBUTION =
  'Data from Foursquare. Copyright 2024 Foursquare Labs, Inc. All rights reserved. Available under Apache 2.0. Foursquare data was transformed to the Overture schema.';

/** The full Foursquare OS Places NOTICE.txt (https://opensource.foursquare.com/places-notice-txt/), kept verbatim. */
export const FOURSQUARE_NOTICE = `© 2026 Foursquare Labs, Inc. All rights reserved.
The Foursquare OS Places dataset (the "Data") is licensed under the Apache License, Version 2.0 (the "License"). You may not use, modify, or distribute the Data except in compliance with the License.
As set forth more fully in the License, if you use, modify, or distribute the Data, you must:
- provide recipients with a copy of the License.
- if applicable, include prominent notices to the extent you've changed the Data.
- preserve attribution to Foursquare, including preserving the full content of this NOTICE.txt file.
To ensure appropriate attribution to Foursquare, we recommend the following:
- if using/distributing the Data in flat file form as-is or after making changes/modifications: include this NOTICE.txt file, which may be modified to include an additional notice of your changes/modifications, if any.
- if using/distributing the Data in API form as-is or after making changes/modifications: include a copy of the content from this NOTICE.txt file prominently in your developer documentation for such API, which may be modified to include an additional notice of your changes/modifications, if any.
You may obtain a copy of the License at: http://www.apache.org/licenses/LICENSE-2.0
Unless required by applicable law or agreed to in writing, the Data distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.`;

export const ALLTHEPLACES_ATTRIBUTION = 'Data from AllThePlaces. Available under CC0 1.0 (https://creativecommons.org/publicdomain/zero/1.0/).';

/** The one-line Overture credit shown wherever attribution is shown. */
export const OVERTURE_ATTRIBUTION = `Contains data from Overture Maps Foundation Places (${OVERTURE_ATTRIBUTION_URL}), under the Community Data License Agreement - Permissive 2.0 (https://cdla.dev/permissive-2-0/), with data from ${OVERTURE_CDLA_CONTRIBUTORS.join(', ')}. ${FOURSQUARE_ATTRIBUTION} ${ALLTHEPLACES_ATTRIBUTION}`;

/** CDLA-Permissive-2.0 requires its text to travel with shared data (section 2.1). Verbatim from https://cdla.dev/permissive-2-0/. */
export const CDLA_PERMISSIVE_2_TEXT = `Community Data License Agreement - Permissive - Version 2.0

This is the Community Data License Agreement - Permissive, Version 2.0 (the "agreement"). Data Provider(s) and Data Recipient(s) agree as follows:

1. Provision of the Data

1.1. A Data Recipient may use, modify, and share the Data made available by Data Provider(s) under this agreement if that Data Recipient follows the terms of this agreement.

1.2. This agreement does not impose any restriction on a Data Recipient's use, modification, or sharing of any portions of the Data that are in the public domain or that may be used, modified, or shared under any other legal exception or limitation.

2. Conditions for Sharing Data

2.1. A Data Recipient may share Data, with or without modifications, so long as the Data Recipient makes available the text of this agreement with the shared Data.

3. No Restrictions on Results

3.1. This agreement does not impose any restriction or obligations with respect to the use, modification, or sharing of Results.

4. No Warranty; Limitation of Liability

4.1. All Data Recipients receive the Data subject to the following terms:

THE DATA IS PROVIDED ON AN "AS IS" BASIS, WITHOUT REPRESENTATIONS, WARRANTIES OR CONDITIONS OF ANY KIND, EITHER EXPRESS OR IMPLIED INCLUDING, WITHOUT LIMITATION, ANY WARRANTIES OR CONDITIONS OF TITLE, NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.

NO DATA PROVIDER SHALL HAVE ANY LIABILITY FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING WITHOUT LIMITATION LOST PROFITS), HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE DATA OR RESULTS, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGES.

5. Definitions

5.1. "Data" means the material received by a Data Recipient under this agreement.

5.2. "Data Provider" means any person who is the source of Data provided under this agreement and in reliance on a Data Recipient's agreement to its terms.

5.3. "Data Recipient" means any person who receives Data directly or indirectly from a Data Provider and agrees to the terms of this agreement.

5.4. "Results" means any outcome obtained by computational analysis of Data, including for example machine learning models and models' insights.
`;

const OVERTURE_OBLIGATIONS =
  'Location-only listings. Show the Overture attribution (CDLA Permissive 2.0, every contributor, the Foursquare line and NOTICE, AllThePlaces CC0) wherever attribution is shown; ship the CDLA text and the Foursquare NOTICE with the downloadable database. Never uploaded to OpenStreetMap.';

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
  'CDLA-Permissive-2.0': {
    id: 'CDLA-Permissive-2.0',
    name: 'Community Data License Agreement - Permissive 2.0',
    attribution: OVERTURE_ATTRIBUTION,
    url: 'https://cdla.dev/permissive-2-0/',
    obligations: OVERTURE_OBLIGATIONS,
  },
  'CC0-1.0': {
    id: 'CC0-1.0',
    name: 'Creative Commons Zero 1.0 (public domain)',
    attribution: ALLTHEPLACES_ATTRIBUTION,
    url: 'https://creativecommons.org/publicdomain/zero/1.0/',
    obligations: `No conditions; credited anyway. ${OVERTURE_OBLIGATIONS}`,
  },
  'Apache-2.0': {
    id: 'Apache-2.0',
    name: 'Apache License 2.0',
    attribution: FOURSQUARE_ATTRIBUTION,
    url: 'https://www.apache.org/licenses/LICENSE-2.0',
    obligations: `Ship a copy of the Apache License 2.0 and the full Foursquare NOTICE, and note that the data was changed. ${OVERTURE_OBLIGATIONS}`,
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
