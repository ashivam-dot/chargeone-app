// Text written for the screen ("₹1,200 · 48 kW · 11 h 49 min") read the way a person says it.
// Every voice, system or neural, reads symbols and unit abbreviations badly, so this runs before any of them.

type Lang = 'en' | 'hi';

interface Words {
  rupees: string;
  perHour: string;
  whPerKm: string;
  kwh: string;
  kw: string;
  km: string;
  percent: string;
  hour: [string, string];
  minute: [string, string];
  degrees: string;
  about: string;
  to: string;
}

const WORDS: Record<Lang, Words> = {
  en: {
    rupees: 'rupees',
    perHour: 'kilometres per hour',
    whPerKm: 'watt-hours per kilometre',
    kwh: 'kilowatt-hours',
    kw: 'kilowatts',
    km: 'kilometres',
    percent: 'percent',
    hour: ['hour', 'hours'],
    minute: ['minute', 'minutes'],
    degrees: 'degrees',
    about: 'about',
    to: 'to',
  },
  hi: {
    rupees: 'रुपये',
    perHour: 'किलोमीटर प्रति घंटा',
    whPerKm: 'वॉट-घंटे प्रति किलोमीटर',
    kwh: 'किलोवॉट-घंटे',
    kw: 'किलोवॉट',
    km: 'किलोमीटर',
    percent: 'प्रतिशत',
    hour: ['घंटा', 'घंटे'],
    minute: ['मिनट', 'मिनट'],
    degrees: 'डिग्री',
    about: 'लगभग',
    to: 'से',
  },
};

const NUM = String.raw`\d+(?:\.\d+)?`;
const plural = (n: string, [one, many]: [string, string]) => (Number(n) === 1 ? one : many);

export function speakable(text: string, lang: Lang): string {
  const w = WORDS[lang];
  let s = text
    // Markdown and list marks never belong in speech.
    .replace(/\*\*|__|`/g, '')
    .replace(/^\s*[-•*]\s+/gm, '')
    // Indian and Western digit grouping: 1,20,000 and 120,000 both become 120000.
    .replace(/(\d)[,\u066C](?=\d)/g, '$1');

  // Ranges first ("20–80%"), so the dash isn't read as minus.
  s = s.replace(new RegExp(`(${NUM})\\s*[–—-]\\s*(${NUM})(?=\\s*(?:%|km|kW|min|h\\b))`, 'g'), `$1 ${w.to} $2`);
  s = s.replace(new RegExp(`(?:₹|Rs\\.?|INR)\\s*(${NUM})`, 'g'), `$1 ${w.rupees}`);
  s = s.replace(new RegExp(`(${NUM})\\s*km\\s*/\\s*h\\b`, 'g'), `$1 ${w.perHour}`);
  s = s.replace(new RegExp(`(${NUM})\\s*Wh\\s*/\\s*km\\b`, 'g'), `$1 ${w.whPerKm}`);
  s = s.replace(new RegExp(`(${NUM})\\s*kWh\\b`, 'g'), `$1 ${w.kwh}`);
  s = s.replace(new RegExp(`(${NUM})\\s*kW\\b`, 'g'), `$1 ${w.kw}`);
  s = s.replace(new RegExp(`(${NUM})\\s*km\\b`, 'g'), `$1 ${w.km}`);
  s = s.replace(new RegExp(`(${NUM})\\s*%`, 'g'), `$1 ${w.percent}`);
  s = s.replace(new RegExp(`(${NUM})\\s*°\\s*C\\b`, 'g'), `$1 ${w.degrees}`);
  s = s.replace(new RegExp(`(${NUM})\\s*(?:h|hr|hrs)\\b`, 'g'), (_, n: string) => `${n} ${plural(n, w.hour)}`);
  s = s.replace(new RegExp(`(${NUM})\\s*(?:min|mins)\\b`, 'g'), (_, n: string) => `${n} ${plural(n, w.minute)}`);
  s = s.replace(/\bCCS\s*2\b/g, 'CCS 2');

  return s
    .replace(/~\s*/g, `${w.about} `)
    .replace(/\s*(?:→|->)\s*/g, ` ${w.to} `)
    .replace(/\s*[·•|]\s*/g, ', ')
    .replace(/\s*\n+\s*/g, '. ')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.!?।])/g, '$1')
    .replace(/([,.])\1+/g, '$1')
    .trim();
}

/**
 * Sentence-sized pieces, so a voice can start on the first while the rest is prepared, and a driver
 * who speaks over it cuts it short at a natural point. Very short sentences are joined to their neighbour.
 */
export function sentences(text: string, max = 220): string[] {
  const parts = text.match(/[^.!?।]+(?:[.!?।]+|$)/g)?.map((p) => p.trim()).filter(Boolean) ?? [];
  const out: string[] = [];
  for (const p of parts) {
    const last = out[out.length - 1];
    if (last && (last.length < 24 || p.length < 12) && last.length + p.length + 1 <= max) out[out.length - 1] = `${last} ${p}`;
    else if (p.length <= max) out.push(p);
    else {
      // A run-on sentence breaks at its last comma before the limit.
      let rest = p;
      while (rest.length > max) {
        const cut = rest.lastIndexOf(',', max);
        const at = cut > max / 3 ? cut + 1 : max;
        out.push(rest.slice(0, at).trim());
        rest = rest.slice(at).trim();
      }
      if (rest) out.push(rest);
    }
  }
  return out;
}
