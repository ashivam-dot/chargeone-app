import { describe, expect, it } from 'vitest';
import type { TripIntent } from '../shared/contracts.ts';
import type { PlanSummary } from './agentContext.ts';
import { confirmTrip, missingQuestion, speakPlan, VOICE_TEXT } from './phrases.ts';

const trip = (over: Partial<TripIntent>): TripIntent => ({ from: 'Delhi', to: 'Jaipur', batteryPct: 80, dailyHours: null, lang: 'en', ...over });
const summary: PlanSummary = { feasible: true, distanceKm: 281.4, totalMinutes: 342, arrivalSocPct: 32, stopCount: 1, firstStopName: 'Tata Power Behror', nights: 0 };

describe('confirmTrip', () => {
  it('confirms in English and Hindi', () => {
    expect(confirmTrip(trip({}), 'en')).toBe('Planning Delhi to Jaipur with 80% battery.');
    expect(confirmTrip(trip({}), 'hi')).toBe('दिल्ली से जयपुर का प्लान बना रहा हूँ, बैटरी 80%.');
  });

  it('says "from here" and leaves out what was not said', () => {
    expect(confirmTrip(trip({ from: null, batteryPct: null }), 'en')).toBe('Planning from here to Jaipur.');
    expect(confirmTrip(trip({ from: null, batteryPct: null }), 'hi')).toBe('यहाँ से जयपुर का प्लान बना रहा हूँ.');
  });

  it('mentions the daily driving limit', () => {
    expect(confirmTrip(trip({ dailyHours: 6 }), 'en')).toBe('Planning Delhi to Jaipur with 80% battery, driving up to 6 hours a day.');
    expect(confirmTrip(trip({ dailyHours: 6, lang: 'hi' }))).toBe('दिल्ली से जयपुर का प्लान बना रहा हूँ, बैटरी 80%, रोज़ 6 घंटे ड्राइव.');
  });

  it('keeps unknown places as said', () => {
    expect(confirmTrip(trip({ from: 'Kotdwar', to: 'Lansdowne' }), 'hi')).toBe('Kotdwar से लैंसडाउन का प्लान बना रहा हूँ, बैटरी 80%.');
  });

  it('asks where to when there is no destination', () => {
    expect(confirmTrip(trip({ to: null }), 'hi')).toBe('कहाँ जाना है?');
  });
});

describe('missingQuestion', () => {
  it('asks for the destination first, then the battery', () => {
    expect(missingQuestion(trip({ to: null, batteryPct: null }))).toBe('Where to?');
    expect(missingQuestion(trip({ batteryPct: null, lang: 'hi' }))).toBe('अभी बैटरी कितनी है?');
    expect(missingQuestion(trip({}))).toBeNull();
  });
});

describe('speakPlan', () => {
  it('reads a plan aloud in English', () => {
    expect(speakPlan(summary, 'en', 'Jaipur')).toBe(
      "Jaipur is 281 kilometres, about 5 hours 40 minutes with charging. One charging stop, at Tata Power Behror. You'll arrive with about 32 percent battery.",
    );
  });

  it('reads a plan aloud in Hindi', () => {
    expect(speakPlan(summary, 'hi', 'Jaipur')).toBe(
      'जयपुर तक 281 किलोमीटर, चार्जिंग मिलाकर लगभग 5 घंटे 40 मिनट। 1 चार्जिंग स्टॉप, पहला Tata Power Behror पर। पहुँचने पर बैटरी लगभग 32 प्रतिशत रहेगी।',
    );
  });

  it('covers no stops, several stops, nights and an unsafe plan', () => {
    expect(speakPlan({ ...summary, stopCount: 0, firstStopName: null, totalMinutes: 60 }, 'en')).toBe(
      "281 kilometres, about 1 hour with charging. No charging stops needed. You'll arrive with about 32 percent battery.",
    );
    expect(speakPlan({ ...summary, stopCount: 3, nights: 2, feasible: false }, 'en')).toContain('3 charging stops, the first at Tata Power Behror. 2 nights on the way.');
    expect(speakPlan({ ...summary, feasible: false }, 'en')).toContain("isn't safe as planned");
    expect(speakPlan({ ...summary, stopCount: 0, nights: 1, feasible: false }, 'hi')).toBe(
      '281 किलोमीटर, चार्जिंग मिलाकर लगभग 5 घंटे 40 मिनट। कोई चार्जिंग स्टॉप नहीं चाहिए। रास्ते में 1 रात रुकना होगा। यह ट्रिप इस प्लान से सुरक्षित नहीं है। स्क्रीन पर चेतावनी देखें।',
    );
  });
});

describe('VOICE_TEXT', () => {
  it('has every string in both languages', () => {
    expect(Object.keys(VOICE_TEXT.hi).sort()).toEqual(Object.keys(VOICE_TEXT.en).sort());
    for (const lang of ['en', 'hi'] as const) {
      for (const v of Object.values(VOICE_TEXT[lang])) expect(Array.isArray(v) ? v.length : v.length).toBeGreaterThan(0);
    }
    expect(VOICE_TEXT.hi.listening).toBe('सुन रहा हूँ…');
  });
});
