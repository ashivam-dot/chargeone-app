import { describe, expect, it } from 'vitest';
import type { TripIntent } from '../shared/contracts.ts';
import { detectLang, parseTripIntent } from './intent.ts';
import { fold, lookupPlace, PLACE_COUNT, placeInHindi } from './placesHi.ts';

const intent = (over: Partial<TripIntent>): TripIntent => ({ from: null, to: null, batteryPct: null, dailyHours: null, lang: 'en', ...over });

describe('parseTripIntent in English', () => {
  it.each<[string, Partial<TripIntent>]>([
    ['plan a trip from Pune to Goa with 80% battery', { from: 'Pune', to: 'Goa', batteryPct: 80 }],
    ['Bangalore to Mysore', { from: 'Bengaluru', to: 'Mysuru' }],
    ['take me to Ooty, battery is 60 percent', { to: 'Ooty', batteryPct: 60 }],
    ['I want to go to Jaipur tomorrow, drive 6 hours a day', { to: 'Jaipur', dailyHours: 6 }],
    ['from here to Lonavala', { to: 'Lonavala' }],
    ['to Goa from Pune', { from: 'Pune', to: 'Goa' }],
    ['Navigate to Navi Mumbai from my location', { to: 'Navi Mumbai' }],
    ["Let's go from Delhi to Mount Abu, battery at seventy five percent", { from: 'Delhi', to: 'Mount Abu', batteryPct: 75 }],
    ['Chennai to Pondicherry with sixty-five per cent charge', { from: 'Chennai', to: 'Puducherry', batteryPct: 65 }],
    ['Delhi - Agra, battery 90', { from: 'Delhi', to: 'Agra', batteryPct: 90 }],
    ['Mumbai → Pune', { from: 'Mumbai', to: 'Pune' }],
    ['Gurgaon Rishikesh', { from: 'Gurugram', to: 'Rishikesh' }],
    ['Kochi', { to: 'Kochi' }],
    ['Take me to Kasol please', { to: 'Kasol' }],
    ['from bhimtal to sat tal', { from: 'Bhimtal', to: 'Sat Tal' }],
    ['plan my trip to north goa', { to: 'North Goa' }],
    ['battery is full, drive to Shimla', { to: 'Shimla', batteryPct: 100 }],
    ['to Udaipur, max 5.5 hours per day', { to: 'Udaipur', dailyHours: 5.5 }],
    ['Calcutta to Digha with a hundred percent', { from: 'Kolkata', to: 'Digha', batteryPct: 100 }],
  ])('%s', (text, expected) => {
    expect(parseTripIntent(text)).toEqual(intent(expected));
  });

  it('ignores battery levels outside 5 to 100', () => {
    expect(parseTripIntent('Goa with 2% battery').batteryPct).toBeNull();
    expect(parseTripIntent('Goa with 150 percent').batteryPct).toBeNull();
  });

  it('needs a per-day or driving word before treating hours as a daily limit', () => {
    expect(parseTripIntent('Jaipur is 6 hours away').dailyHours).toBeNull();
    expect(parseTripIntent('Jaipur, 30 hours a day').dailyHours).toBeNull();
  });

  it('does not take the hours as the battery level', () => {
    expect(parseTripIntent('Agra, battery 6 hours a day')).toEqual(intent({ to: 'Agra', dailyHours: 6 }));
  });

  it('keeps an unknown request empty instead of guessing', () => {
    expect(parseTripIntent('')).toEqual(intent({}));
    expect(parseTripIntent('please plan it')).toEqual(intent({}));
  });

  it('does not take a stray word before a stated destination as the start', () => {
    expect(parseTripIntent('hey siri take me to Goa')).toEqual(intent({ to: 'Goa' }));
  });

  it('leaves out a place the driver wants to pass through', () => {
    expect(parseTripIntent('Navigate to Rishikesh via Haridwar')).toEqual(intent({ to: 'Rishikesh' }));
    expect(parseTripIntent('आगरा से मथुरा होते हुए वृंदावन')).toEqual(intent({ from: 'Agra', to: 'Vrindavan', lang: 'hi' }));
  });

  it('does not read a question as a destination unless it names a known place', () => {
    expect(parseTripIntent('what is the weather')).toEqual(intent({}));
    expect(parseTripIntent('how far is Goa')).toEqual(intent({ to: 'Goa' }));
  });
});

describe('parseTripIntent in Hindi', () => {
  it.each<[string, Partial<TripIntent>]>([
    ['मुझे दिल्ली से जयपुर जाना है, बैटरी 80 प्रतिशत है', { from: 'Delhi', to: 'Jaipur', batteryPct: 80 }],
    ['पुणे से गोवा', { from: 'Pune', to: 'Goa' }],
    ['जयपुर चलो', { to: 'Jaipur' }],
    ['मुझे आगरा जाना है बैटरी साठ प्रतिशत', { to: 'Agra', batteryPct: 60 }],
    ['रोज़ छह घंटे चलाऊंगा', { dailyHours: 6 }],
    ['बैटरी ८० प्रतिशत है, मुंबई से पुणे', { from: 'Mumbai', to: 'Pune', batteryPct: 80 }],
    ['लखनऊ से वाराणसी तक, बैटरी पैंतालीस प्रतिशत', { from: 'Lucknow', to: 'Varanasi', batteryPct: 45 }],
    ['बेंगलुरु से मैसूर का प्लान बनाओ', { from: 'Bengaluru', to: 'Mysuru' }],
    ['यहाँ से ऋषिकेश जाना है', { to: 'Rishikesh' }],
    ['गुड़गांव से मनाली, बैटरी पाँच प्रतिशत', { from: 'Gurugram', to: 'Manali', batteryPct: 5 }],
    ['चंडीगढ़ से शिमला, रोज़ साढ़े चार घंटे', { from: 'Chandigarh', to: 'Shimla', dailyHours: 4.5 }],
    ['बैटरी पच्चीस प्रतिशत है, नैनीताल ले चलो', { to: 'Nainital', batteryPct: 25 }],
    ['दिल्ली से कसौली जाना है', { from: 'Delhi', to: 'Kasauli' }],
    ['भोपाल से इंदौर, बैटरी सौ प्रतिशत', { from: 'Bhopal', to: 'Indore', batteryPct: 100 }],
    ['मुझे कोटद्वार जाना है', { to: 'कोटद्वार' }],
  ])('%s', (text, expected) => {
    expect(parseTripIntent(text)).toEqual(intent({ lang: 'hi', ...expected }));
  });

  it('reads every Hindi tens word', () => {
    const tens: Array<[string, number]> = [
      ['दस', 10], ['बीस', 20], ['तीस', 30], ['चालीस', 40], ['पचास', 50], ['साठ', 60], ['सत्तर', 70], ['अस्सी', 80], ['नब्बे', 90],
    ];
    for (const [word, n] of tens) expect(parseTripIntent(`बैटरी ${word} प्रतिशत`).batteryPct).toBe(n);
  });

  it('reads Hindi numbers in between the tens', () => {
    expect(parseTripIntent('बैटरी सत्तासी प्रतिशत').batteryPct).toBe(87);
    expect(parseTripIntent('बैटरी इकसठ प्रतिशत').batteryPct).toBe(61);
    expect(parseTripIntent('बैटरी अड़तीस प्रतिशत').batteryPct).toBe(38);
  });
});

describe('parseTripIntent in romanized Hindi', () => {
  it.each<[string, Partial<TripIntent>]>([
    ['delhi se jaipur jana hai battery assi percent', { from: 'Delhi', to: 'Jaipur', batteryPct: 80 }],
    ['mujhe agra jana hai', { to: 'Agra' }],
    ['bangalore se ooty tak, battery pachas percent', { from: 'Bengaluru', to: 'Ooty', batteryPct: 50 }],
    ['yahan se lonavla chalo', { to: 'Lonavala' }],
    ['dilli se haridwar, roz paanch ghante', { from: 'Delhi', to: 'Haridwar', dailyHours: 5 }],
    ['kal mujhe banaras jaana hai, battery sattar percent hai', { to: 'Varanasi', batteryPct: 70 }],
  ])('%s', (text, expected) => {
    expect(parseTripIntent(text)).toEqual(intent({ lang: 'hi', ...expected }));
  });
});

describe('detectLang', () => {
  it('treats any Devanagari as Hindi', () => expect(detectLang('Goa चलो')).toBe('hi'));
  it('spots romanized Hindi', () => expect(detectLang('pune se goa')).toBe('hi'));
  it('defaults to English', () => expect(detectLang('Pune to Goa')).toBe('en'));
  it('keeps the language the caller chose', () => expect(parseTripIntent('pune se goa', 'en').lang).toBe('en'));
});

describe('place names', () => {
  it('covers at least 150 places', () => expect(PLACE_COUNT).toBeGreaterThanOrEqual(150));

  it('folds spelling variants to one name', () => {
    expect(fold('पन्द्रह')).toBe(fold('पंद्रह'));
    expect(fold('रोज़ गाँव')).toBe(fold('रोज गांव'));
    expect(lookupPlace('इन्दौर')).toBe('Indore');
    expect(lookupPlace('मुम्बई')).toBe('Mumbai');
    expect(lookupPlace('BOMBAY')).toBe('Mumbai');
    expect(lookupPlace('चण्डीगढ़')).toBe('Chandigarh');
    expect(lookupPlace('Atlantis')).toBeNull();
  });

  it('gives the Hindi spelling for display', () => {
    expect(placeInHindi('Jaipur')).toBe('जयपुर');
    expect(placeInHindi('Bangalore')).toBe('बेंगलुरु');
    expect(placeInHindi('Kasol')).toBe('कसोल');
    expect(placeInHindi('Atlantis')).toBe('Atlantis');
  });
});
