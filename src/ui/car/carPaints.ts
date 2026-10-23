// Factory paint colours, kept apart from the car designs so the start-up bundle (the app shell and the
// onboarding picker) doesn't carry the 3D design table, which loads with the Car tab.
import type { CarPaint } from './carDesign.ts';

/** Factory colours per design id: [name, hex]. */
export const PAINT_SPECS: Record<string, ReadonlyArray<readonly [string, string]>> = {
  'tata-nexon-ev': [['Empowered Oxide', '#8A8F86'], ['Pristine White', '#F2F2EF'], ['Daytona Grey', '#5E6266'], ['Ocean Blue', '#1F4E79'], ['Pure Grey', '#9B9EA0']],
  'tata-punch-ev': [['Fearless Yellow', '#E9B824'], ['Supernova Copper', '#B36A45'], ['Bengal Rouge', '#8E2430'], ['Empowered Oxide', '#8A8F86'], ['Pristine White', '#F2F2EF']],
  'tata-tiago-ev': [['Dehradun Dew', '#7FA88B'], ['Sobo Surge', '#2F5D8A'], ['Pangong Pulse', '#4A86B8'], ['Pure Grey', '#9B9EA0'], ['Pristine White', '#F2F2EF']],
  'tata-curvv-ev': [['Virtual Sunrise', '#C8643B'], ['Empowered Oxide', '#8A8F86'], ['Flame Red', '#B3202A'], ['Pure Grey', '#9B9EA0'], ['Pristine White', '#F2F2EF']],
  'tata-harrier-ev': [['Nainital Nocturne', '#1E2A3A'], ['Empowered Oxide', '#8A8F86'], ['Seaweed Green', '#4E5E4A'], ['Pure Grey', '#9B9EA0'], ['Pristine White', '#F2F2EF']],
  'mg-zs-ev': [['Glaze Red', '#A3212B'], ['Aurora Silver', '#B9BCBE'], ['Starry Black', '#16181B'], ['Candy White', '#F3F3F0']],
  'mg-windsor': [['Starburst Black', '#121315'], ['Pearl White', '#EFEFEA'], ['Clay Beige', '#B9A58C'], ['Turquoise Green', '#3E8B84'], ['Aurora Silver', '#B9BCBE']],
  'mg-comet': [['Apple Green', '#9BC33A'], ['Candy White', '#F3F3F0'], ['Aurora Silver', '#B9BCBE'], ['Starry Black', '#16181B']],
  'mahindra-xuv400': [['Everest White', '#F1F1EE'], ['Nebula Blue', '#2A4A73'], ['Galaxy Grey', '#5B5F63'], ['Stealth Black', '#141517'], ['Arctic Blue', '#8DB7D6']],
  'mahindra-be6': [['Firestorm Orange', '#D9581F'], ['Tango Red', '#B01E2A'], ['Deep Forest', '#2F3B2C'], ['Desert Myst', '#B8AE9C'], ['Everest White', '#F1F1EE']],
  'mahindra-xev9e': [['Everest White', '#F1F1EE'], ['Nebula Blue', '#2A4A73'], ['Ruby Velvet', '#6E1F2E'], ['Desert Myst', '#B8AE9C'], ['Stealth Black', '#141517']],
  'mahindra-xev9s': [['Nebula Blue', '#2A4A73'], ['Ruby Velvet', '#6E1F2E'], ['Desert Myst', '#B8AE9C'], ['Midnight Black', '#151B2B'], ['Everest White', '#F1F1EE']],
  'hyundai-creta-electric': [['Ocean Blue', '#1E4F7C'], ['Atlas White', '#F0F0EC'], ['Fiery Red', '#B1202B'], ['Starry Night', '#232B3B'], ['Abyss Black', '#121314']],
  'hyundai-ioniq5': [['Gravity Gold Matte', '#A49A78'], ['Midnight Black Pearl', '#141516'], ['Titan Grey', '#6A6D70'], ['Optic White', '#F2F2EF']],
  'kia-ev6': [['Snow White Pearl', '#F1F1EC'], ['Wolf Gray', '#5E6164'], ['Runway Red', '#A71E2A'], ['Aurora Black Pearl', '#121314'], ['Yacht Blue Matte', '#25344B']],
  'byd-atto3': [['Ski White', '#F2F2EF'], ['Cosmos Black', '#131416'], ['Harbour Grey', '#6B7075'], ['Atlantis Gray', '#4B5A66']],
  'byd-seal': [['Aurora White', '#F2F2EF'], ['Atlantis Gray', '#4B5A66'], ['Cosmos Black', '#131416'], ['Shark Gray', '#7A7F84']],
  'byd-emax7': [['Quartz Blue', '#2C4E6E'], ['Cosmos Black', '#131416'], ['Crystal White', '#F2F2EF'], ['Harbour Grey', '#6B7075']],
  'citroen-ec3': [['Polar White', '#F2F2EF'], ['Perla Nera Black', '#131416'], ['Cosmo Blue', '#2F5B8F']],
  'maruti-e-vitara': [['Nexa Blue', '#1F3C78'], ['Opulent Red', '#8E1F2A'], ['Land Breeze Green', '#7E9C8A'], ['Grandeur Grey', '#5B5F63'], ['Arctic White', '#F2F2EF']],
  'tesla-model-y': [['Stealth Grey', '#4D5156'], ['Pearl White Multi-Coat', '#F1F1EC'], ['Diamond Black', '#121314'], ['Glacier Blue', '#6E8EA8'], ['Ultra Red', '#A8141E']],
  'vinfast-vf7': [['Infinity Blanc', '#F2F2EF'], ['Crimson Red', '#9E1B25'], ['Jet Black', '#111213'], ['Zenith Grey', '#5A5E62'], ['Urban Mint', '#9FC2B4']],
};

export const DEFAULT_PAINTS: CarPaint[] = [
  { name: 'White', hex: '#f2f2ef' },
  { name: 'Silver', hex: '#b9bcbe' },
  { name: 'Grey', hex: '#5e6266' },
  { name: 'Black', hex: '#131416' },
  { name: 'Blue', hex: '#1f4e79' },
  { name: 'Red', hex: '#a8141e' },
];

const FACTORY: Record<string, CarPaint[]> = Object.fromEntries(
  Object.entries(PAINT_SPECS).map(([k, p]) => [k, p.map(([name, hex]) => ({ name, hex: hex.toLowerCase() }))]),
);

/** Factory colours for a model, or a plain set for a car ChargeOne has no design for. */
export function paintsFor(modelId: string): CarPaint[] {
  const key = Object.keys(PAINT_SPECS).find((k) => modelId.startsWith(k));
  return (key && FACTORY[key].length && FACTORY[key]) || DEFAULT_PAINTS;
}
