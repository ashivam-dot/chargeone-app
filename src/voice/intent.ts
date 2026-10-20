// Understands a spoken or typed trip request on the phone, without the network, in English, Hindi
// and romanized Hindi ("delhi se jaipur jana hai").
import type { AgentLang, TripIntent } from '../shared/contracts.ts';
import { fold, lookupPlace, MAX_PLACE_WORDS } from './placesHi.ts';

const words = (s: string): Set<string> => new Set(s.split(/\s+/).filter(Boolean).map(fold));

const HINDI_NUMBERS = [
  'एक', 'दो', 'तीन', 'चार', 'पांच', 'छह', 'सात', 'आठ', 'नौ', 'दस',
  'ग्यारह', 'बारह', 'तेरह', 'चौदह', 'पंद्रह', 'सोलह', 'सत्रह', 'अठारह', 'उन्नीस', 'बीस',
  'इक्कीस', 'बाईस', 'तेईस', 'चौबीस', 'पच्चीस', 'छब्बीस', 'सत्ताईस', 'अट्ठाईस', 'उनतीस', 'तीस',
  'इकतीस', 'बत्तीस', 'तैंतीस', 'चौंतीस', 'पैंतीस', 'छत्तीस', 'सैंतीस', 'अड़तीस', 'उनतालीस', 'चालीस',
  'इकतालीस', 'बयालीस', 'तैंतालीस', 'चवालीस', 'पैंतालीस', 'छियालीस', 'सैंतालीस', 'अड़तालीस', 'उनचास', 'पचास',
  'इक्यावन', 'बावन', 'तिरपन', 'चौवन', 'पचपन', 'छप्पन', 'सत्तावन', 'अट्ठावन', 'उनसठ', 'साठ',
  'इकसठ', 'बासठ', 'तिरसठ', 'चौंसठ', 'पैंसठ', 'छियासठ', 'सड़सठ', 'अड़सठ', 'उनहत्तर', 'सत्तर',
  'इकहत्तर', 'बहत्तर', 'तिहत्तर', 'चौहत्तर', 'पचहत्तर', 'छिहत्तर', 'सतहत्तर', 'अठहत्तर', 'उन्यासी', 'अस्सी',
  'इक्यासी', 'बयासी', 'तिरासी', 'चौरासी', 'पचासी', 'छियासी', 'सत्तासी', 'अट्ठासी', 'नवासी', 'नब्बे',
  'इक्यानवे', 'बानवे', 'तिरानवे', 'चौरानवे', 'पचानवे', 'छियानवे', 'सत्तानवे', 'अट्ठानवे', 'निन्यानवे', 'सौ',
];

const OTHER_NUMBERS: Record<string, string> = {
  1: 'ek one', 2: 'do two', 3: 'teen three', 4: 'char chaar four', 5: 'paanch panch five', 6: 'छः छे छै chhe chhah chah che six',
  7: 'saat seven', 8: 'aath eight', 9: 'nau nine', 10: 'das ten', 11: 'gyarah eleven', 12: 'barah twelve', 13: 'terah thirteen',
  14: 'chaudah fourteen', 15: 'पन्द्रह pandrah fifteen', 16: 'solah sixteen', 17: 'satrah seventeen', 18: 'atharah eighteen',
  19: 'unnis unees nineteen', 20: 'bees bis twenty', 22: 'बाइस', 23: 'तेइस', 25: 'pachchis pachees pachis', 27: 'सत्ताइस', 28: 'अट्ठाइस',
  30: 'tees tis thirty', 35: 'paintis paintees pentis', 40: 'chalis chalees chaalis forty', 45: 'पैंतालिस paintalis paintalees',
  50: 'pachas pachaas fifty', 55: 'pachpan', 60: 'saath sath sixty', 65: 'painsath pensath', 70: 'sattar sattar seventy',
  75: 'pachattar pachhattar', 80: 'assi assee ashi eighty', 85: 'pachasi', 90: 'nabbe nabe ninety', 100: 'sau hundred',
};

const NUMBER = new Map<string, number>();
HINDI_NUMBERS.forEach((w, i) => NUMBER.set(fold(w), i + 1));
for (const [n, list] of Object.entries(OTHER_NUMBERS)) for (const w of words(list)) NUMBER.set(w, Number(n));
for (const [w, n] of [['डेढ़', 1.5], ['dedh', 1.5], ['ढाई', 2.5], ['dhai', 2.5]] as const) NUMBER.set(fold(w), n);

const TENS = words('twenty thirty forty fifty sixty seventy eighty ninety');
const UNITS = words('one two three four five six seven eight nine');
const HALF_MORE = words('साढ़े sadhe saadhe sade saade');

const PERCENT = words('% percent pct cent प्रतिशत परसेंट पर्सेंट फीसदी pratishat parsent persent fisadi');
const BATTERY = words('battery batt battry bettery betri charge charged soc बैटरी बेटरी चार्ज');
const FULL = words('full फुल पूरी फुल्ल');
const HOURS = words('h hr hrs hour hours ghanta ghante ghanton घंटा घंटे घंटों');
const DAILY = words(
  'day days daily everyday din roz roj rozana rojana pratidin दिन रोज रोजाना प्रतिदिन',
);
const DRIVE_VERB = words(
  'drive driving chalaunga chalaoonga chalana chalaenge chalayenge चलाऊंगा चलाऊं चलाना चलाएंगे चलायेंगे ड्राइव',
);
const HERE = words('here yahan yaha yahaan idhar यहां इधर');
const HERE_PHRASES = new Set(['current location', 'my location', 'meri location', 'मेरी लोकेशन'].map(fold));

type Marker = 'fromPre' | 'fromPost' | 'toPre' | 'toPost' | 'viaPre' | 'viaPost';
const MARKERS = new Map<string, Marker>();
for (const w of words('via through thru')) MARKERS.set(w, 'viaPre');
for (const w of words('होते होकर hote hokar')) MARKERS.set(w, 'viaPost');
for (const w of words('from frm')) MARKERS.set(w, 'fromPre');
for (const w of words('से se')) MARKERS.set(w, 'fromPost');
for (const w of words('to towards toward till until upto')) MARKERS.set(w, 'toPre');
for (const w of words(
  'तक जाना चलो चलना को लिए तरफ जाऊंगा जाएंगे जायेंगे जाओ चलेंगे पहुंचना पहुंचाओ ' +
    'tak jana jaana chalo chalna ko liye taraf jaunga jaenge jayenge jao chalenge pahunchna pahuchna',
)) MARKERS.set(w, 'toPost');

const STOP = words(
  'i im me my we us our you your want wanna would like need have has got go going gonna get take plan planning ' +
    'a an the trip route journey ride travel travelling traveling please pls plz let lets can could will shall should ' +
    'with and is are am was be it its now currently current right tomorrow today tonight morning evening afternoon ' +
    'night on at by in of for about around approx approximately roughly hey hello ok okay chargeone car ev each every ' +
    'max maximum up only just then also there navigate show find head heading start starting leave leaving reach way ' +
    'left remaining minutes mins km kms next this weekend monday tuesday wednesday thursday friday saturday sunday ' +
    'per what where how drop far long distance much many ' +
    'मुझे मुझको मैं मै हम हमें हमको मेरा मेरी मेरे है हैं हूं था थी होगा चाहता चाहती चाहते चाहिए कल आज परसों सुबह शाम ' +
    'रात अभी हर का की के में पर और फिर भी प्लान प्लीज कृपया ट्रिप यात्रा सफर रास्ता बनाओ बना करो करना करें कीजिए ' +
    'बताओ बताइए गाड़ी कार लगभग सिर्फ बस वाला वाली साथ ले लेकर निकलना निकलेंगे निकलूंगा जरा थोड़ा मैक्सिमम ' +
    'mujhe muje mujhko main mai mein hum humein hame mera meri mere hai hain hu hoon hun tha thi hoga chahta chahti ' +
    'chahte chahiye kal aaj parso subah shaam raat abhi har ka ki ke par aur phir bhi karo karna banao batao gaadi gadi ' +
    'lagbhag sirf bas wala wali le lekar nikalna yaar bhai zara jara thoda हुए hue',
);
const QUESTION = words('what whats which why how when kya kaise kitna kitni kitne kab kyun क्या कैसे कितना कितनी कितने कब क्यों');
const HINGLISH = words(
  'se jana jaana hai hain mujhe muje chalo tak ghante ghanta roz rozana kal abhi karo banao batao chahta chahiye mera meri aur ko ka ki ke wala nahi',
);
const PUNCT = /^[,;.!?।|]$/;

const TOKEN = /[\p{L}\p{M}]+|\d+(?:\.\d+)?|%|[,;.!?।|]/gu;

interface NumberMatch {
  value: number;
  start: number;
  end: number;
}

function numberAt(t: string[], i: number): NumberMatch | null {
  const w = t[i];
  if (w === undefined) return null;
  if (HALF_MORE.has(w)) {
    const n = numberAt(t, i + 1);
    return n && Number.isInteger(n.value) ? { value: n.value + 0.5, start: i, end: n.end } : null;
  }
  if (/^\d/.test(w)) return { value: Number(w), start: i, end: i + 1 };
  if ((w === 'a' || w === 'one') && t[i + 1] === 'hundred') return { value: 100, start: i, end: i + 2 };
  const n = NUMBER.get(w);
  if (n === undefined) return null;
  if (TENS.has(w) && UNITS.has(t[i + 1] ?? '')) return { value: n + NUMBER.get(t[i + 1])!, start: i, end: i + 2 };
  return { value: n, start: i, end: i + 1 };
}

/** The longest number that ends just before `end`. */
function numberBefore(t: string[], end: number): NumberMatch | null {
  for (let start = Math.max(0, end - 3); start < end; start++) {
    const n = numberAt(t, start);
    if (n && n.end === end) return n;
  }
  return null;
}

function markUsed(used: boolean[], from: number, to: number): void {
  for (let i = from; i < to; i++) used[i] = true;
}

function battery(t: string[], used: boolean[]): number | null {
  const clamp = (n: number) => (n >= 5 && n <= 100 ? Math.round(n) : null);
  for (let i = 0; i < t.length; i++) {
    if (!PERCENT.has(t[i])) continue;
    const end = t[i] === 'cent' && t[i - 1] === 'per' ? i - 1 : i;
    const n = numberBefore(t, end);
    if (!n) continue;
    markUsed(used, n.start, i + 1);
    return clamp(n.value);
  }
  for (let i = 0; i < t.length; i++) {
    if (!BATTERY.has(t[i])) continue;
    for (let j = i + 1; j <= i + 4 && j < t.length && !PUNCT.test(t[j]); j++) {
      if (FULL.has(t[j])) return 100;
      const n = numberAt(t, j);
      if (n && !HOURS.has(t[n.end] ?? '')) {
        markUsed(used, n.start, n.end);
        return clamp(n.value);
      }
    }
    const before = numberBefore(t, i);
    if (before) {
      markUsed(used, before.start, before.end);
      return clamp(before.value);
    }
    if (FULL.has(t[i - 1] ?? '')) return 100;
  }
  return null;
}

function dailyHours(t: string[], used: boolean[]): number | null {
  for (let i = 0; i < t.length; i++) {
    if (!HOURS.has(t[i])) continue;
    const n = numberBefore(t, i);
    if (!n) continue;
    markUsed(used, n.start, i + 1);
    const perDay = t.some((w) => DAILY.has(w) || DRIVE_VERB.has(w));
    return perDay && n.value >= 1 && n.value <= 16 ? Math.round(n.value * 2) / 2 : null;
  }
  return null;
}

type Item =
  | { kind: 'place'; name: string; raw: string }
  | { kind: 'word'; raw: string }
  | { kind: 'here' }
  | { kind: 'marker'; marker: Marker }
  | { kind: 'stop' }
  | { kind: 'break' };

function classify(raw: string[], t: string[], used: boolean[]): Item[] {
  const items: Item[] = [];
  for (let i = 0; i < t.length; ) {
    if (used[i] || PUNCT.test(t[i])) {
      items.push({ kind: 'break' });
      i++;
      continue;
    }
    let matched = 0;
    for (let len = Math.min(MAX_PLACE_WORDS, t.length - i); len >= 1 && !matched; len--) {
      const span = t.slice(i, i + len);
      if (span.some((_, k) => used[i + k] || PUNCT.test(span[k]))) continue;
      const key = span.join(' ');
      if (HERE_PHRASES.has(key) || (len === 1 && HERE.has(key))) {
        items.push({ kind: 'here' });
        matched = len;
        continue;
      }
      const name = lookupPlace(key);
      if (name) {
        items.push({ kind: 'place', name, raw: raw.slice(i, i + len).join(' ') });
        matched = len;
      }
    }
    if (matched) {
      i += matched;
      continue;
    }
    const marker = MARKERS.get(t[i]);
    if (marker) items.push({ kind: 'marker', marker });
    else if (numberAt(t, i)) items.push({ kind: 'break' });
    else if (STOP.has(t[i]) || PERCENT.has(t[i]) || BATTERY.has(t[i]) || HOURS.has(t[i]) || DAILY.has(t[i]) || DRIVE_VERB.has(t[i]) || FULL.has(t[i])) {
      items.push({ kind: 'stop' });
    } else items.push({ kind: 'word', raw: raw[i] });
    i++;
  }
  return items;
}

const titleCase = (s: string): string =>
  s
    .split(' ')
    .map((w) => (/^\p{Script=Latin}/u.test(w) ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(' ');

interface Run {
  start: number;
  end: number;
  value: string | null;
  /** Every word is a known place (or "here"). */
  known: boolean;
  label: 'from' | 'to' | 'via' | null;
}

/** The nearest marker past filler words, and the marker right next to the run (for "X to Y", "X se Y"). */
function neighbourMarker(items: Item[], from: number, step: 1 | -1): { near: Marker | null; adjacent: Marker | null } {
  const at = items[from];
  const adjacent = at?.kind === 'marker' ? at.marker : null;
  for (let i = from; i >= 0 && i < items.length; i += step) {
    const it = items[i];
    if (it.kind === 'stop') continue;
    return { near: it.kind === 'marker' ? it.marker : null, adjacent };
  }
  return { near: null, adjacent };
}

function runs(items: Item[]): Run[] {
  const out: Run[] = [];
  const push = (start: number, end: number, value: string | null, known: boolean) => out.push({ start, end, value, known, label: null });
  for (let i = 0; i < items.length; ) {
    const it = items[i];
    if (it.kind === 'here') {
      push(i, i + 1, null, true);
      i++;
      continue;
    }
    if (it.kind !== 'place' && it.kind !== 'word') {
      i++;
      continue;
    }
    let j = i;
    while (j < items.length && (items[j].kind === 'place' || items[j].kind === 'word')) j++;
    const group = items.slice(i, j) as Array<Extract<Item, { kind: 'place' | 'word' }>>;
    if (group.every((g) => g.kind === 'place')) {
      group.forEach((g, k) => {
        if (g.kind === 'place') push(i + k, i + k + 1, g.name, true);
      });
    } else push(i, j, titleCase(group.map((g) => g.raw).join(' ')), false);
    i = j;
  }
  for (const r of out) {
    const prev = neighbourMarker(items, r.start - 1, -1);
    const next = neighbourMarker(items, r.end, 1);
    if (prev.near === 'viaPre' || next.near === 'viaPost') r.label = 'via';
    else if (prev.near === 'fromPre' || next.near === 'fromPost') r.label = 'from';
    else if (prev.near === 'toPre' || next.near === 'toPost') r.label = 'to';
    else if (prev.adjacent === 'fromPost') r.label = 'to';
    else if (next.adjacent === 'toPre') r.label = 'from';
  }
  return out;
}

/** A question ("what is the weather") only names a destination when it is a known place. */
function places(found: Run[], question: boolean): { from: string | null; to: string | null } {
  let from = found.find((r) => r.label === 'from');
  let to = found.findLast((r) => r.label === 'to');
  const free = found.filter((r) => !r.label && (r.known || !question));
  if (!from && !to && free.length >= 2) {
    from = free[0];
    to = free[free.length - 1];
  } else if (!to) {
    to = free.findLast((r) => !from || r.start > from.start);
  }
  return { from: from?.value ?? null, to: to?.value ?? null };
}

export function detectLang(text: string): AgentLang {
  if (/[\u0900-\u097f]/.test(text)) return 'hi';
  const t = fold(text).match(TOKEN) ?? [];
  return t.some((w) => HINGLISH.has(w)) ? 'hi' : 'en';
}

export function parseTripIntent(text: string, lang?: AgentLang): TripIntent {
  const prepared = text
    .normalize('NFC')
    .replace(/[\u0966-\u096f]/g, (d) => String(d.charCodeAt(0) - 0x966))
    .replace(/[’'`]/g, '')
    .replace(/\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)-(one|two|three|four|five|six|seven|eight|nine)\b/gi, '$1 $2')
    .replace(/\s[-–—]+\s|→/g, ' to ')
    .replace(/(\p{L})[-–—]+(?=\p{L})/gu, '$1 to ');
  const raw = prepared.match(TOKEN) ?? [];
  const t = raw.map(fold);
  const used = raw.map(() => false);
  const batteryPct = battery(t, used);
  const hours = dailyHours(t, used);
  const { from, to } = places(runs(classify(raw, t, used)), t.some((w) => QUESTION.has(w)));
  return { from, to, batteryPct, dailyHours: hours, lang: lang ?? detectLang(text) };
}
