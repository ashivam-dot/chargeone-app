import type { TripIntent } from '../shared/contracts.ts';

/** Words that ask for a trip to be planned, even inside a question ("Can you plan Pune to Goa?"). */
const PLAN_VERB = /\b(plan|take me|navigate|route me|drive me|jaana|jana|jaana hai|chalo|le chalo)\b|जाना|चलो|प्लान|ले चलो/i;
const TRIP_WORD = /\b(trip|drive|go to|travel|route)\b|यात्रा|ट्रिप/i;
const QUESTION_START =
  /^\s*(is|are|was|what|whats|how|why|when|which|who|should|can|could|would|will|do|does|did|kya|kaise|kitna|kitni|kab|kyun|kyon)\b|^\s*(क्या|कैसे|कितना|कितनी|कब|क्यों)/i;

export function isQuestion(text: string): boolean {
  return /\?\s*$/.test(text) || QUESTION_START.test(text);
}

/** True when the words ask to plan a trip, rather than ask something about one. */
export function looksLikeTripRequest(text: string, intent: Pick<TripIntent, 'from' | 'to'>): boolean {
  if (!intent.to) return false;
  if (PLAN_VERB.test(text)) return true;
  if (isQuestion(text)) return false;
  return Boolean(intent.from) || TRIP_WORD.test(text);
}
