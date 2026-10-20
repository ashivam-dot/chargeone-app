import { describe, expect, it } from 'vitest';
import { parseTripIntent } from './intent.ts';
import { isQuestion, looksLikeTripRequest } from './tripRequest.ts';

const trip = (s: string) => looksLikeTripRequest(s, parseTripIntent(s));

describe('looksLikeTripRequest', () => {
  it('plans clear trip requests in English, Hinglish and Hindi', () => {
    expect(trip('Plan a trip from Mumbai to Pune with 80% battery')).toBe(true);
    expect(trip('Pune se Goa jaana hai, battery 80 percent')).toBe(true);
    expect(trip('मुझे दिल्ली से जयपुर जाना है, बैटरी 80 प्रतिशत है')).toBe(true);
    expect(trip('Take me to Ooty, battery is 60 percent')).toBe(true);
    expect(trip('Bengaluru to Mysuru')).toBe(true);
    expect(trip('Can you plan Pune to Goa?')).toBe(true);
  });

  it('leaves questions about charging or a trip to the agent', () => {
    expect(trip('Is it better to charge to 80% or 100% before a highway trip?')).toBe(false);
    expect(trip('How long does it take to charge to 80%?')).toBe(false);
    expect(trip('What should I do if the charger at Lonavala is down?')).toBe(false);
    expect(trip('क्या मैं रास्ते में एक स्टॉप छोड़ सकता हूँ?')).toBe(false);
  });

  it('needs a destination', () => {
    expect(looksLikeTripRequest('plan a trip', { from: null, to: null })).toBe(false);
  });
});

describe('isQuestion', () => {
  it('spots question marks and question openers', () => {
    expect(isQuestion('Where can we eat on the way?')).toBe(true);
    expect(isQuestion('kya agla charger chal raha hai')).toBe(true);
    expect(isQuestion('Pune to Goa')).toBe(false);
  });
});
