import type { AgentLang, TripIntent } from '../shared/contracts.ts';
import type { PlanSummary } from './agentContext.ts';
import { placeInHindi } from './placesHi.ts';

export interface VoiceText {
  listening: string;
  tapToSpeak: string;
  thinking: string;
  examples: string[];
  whereTo: string;
  batteryNow: string;
  notUnderstood: string;
  micDenied: string;
  noVoice: string;
  noSpeech: string;
  noMic: string;
  voiceOffline: string;
  voiceFailed: string;
}

export const VOICE_TEXT: Record<AgentLang, VoiceText> = {
  en: {
    listening: 'Listening…',
    tapToSpeak: 'Tap the mic and say where you want to go',
    thinking: 'Working it out…',
    examples: ['Plan a trip from Delhi to Jaipur with 80% battery', 'Bengaluru to Mysuru, battery 40 percent', 'Take me to Ooty, battery is 60 percent'],
    whereTo: 'Where to?',
    batteryNow: 'How much battery now?',
    notUnderstood: "Sorry, I didn't get that. Try “Delhi to Jaipur, battery 80 percent”.",
    micDenied: 'Allow the microphone to plan by voice.',
    noVoice: "Voice input isn't available on this device. Type your trip instead.",
    noSpeech: "Didn't catch that. Tap the mic and try again.",
    noMic: 'No microphone found.',
    voiceOffline: 'Voice input needs an internet connection here. Type your trip instead.',
    voiceFailed: 'Voice input stopped. Tap the mic to try again.',
  },
  hi: {
    listening: 'सुन रहा हूँ…',
    tapToSpeak: 'माइक दबाएँ और बताएँ कहाँ जाना है',
    thinking: 'देख रहा हूँ…',
    examples: ['मुझे दिल्ली से जयपुर जाना है, बैटरी 80 प्रतिशत है', 'बेंगलुरु से मैसूर, बैटरी 40 प्रतिशत', 'जयपुर चलो'],
    whereTo: 'कहाँ जाना है?',
    batteryNow: 'अभी बैटरी कितनी है?',
    notUnderstood: 'माफ़ कीजिए, समझ नहीं पाया। ऐसे बोलें: “दिल्ली से जयपुर, बैटरी 80 प्रतिशत”।',
    micDenied: 'आवाज़ से प्लान करने के लिए माइक्रोफ़ोन की अनुमति दें।',
    noVoice: 'इस डिवाइस पर आवाज़ से इनपुट नहीं हो सकता। ट्रिप टाइप करें।',
    noSpeech: 'सुनाई नहीं दिया। माइक दबाकर फिर बोलें।',
    noMic: 'माइक्रोफ़ोन नहीं मिला।',
    voiceOffline: 'आवाज़ से इनपुट के लिए इंटरनेट चाहिए। ट्रिप टाइप करें।',
    voiceFailed: 'आवाज़ से इनपुट रुक गया। माइक दबाकर फिर कोशिश करें।',
  },
};

const placeFor = (name: string, lang: AgentLang) => (lang === 'hi' ? placeInHindi(name) : name);

/** What to ask next when the request is missing something the planner needs; null when nothing is. */
export function missingQuestion(intent: TripIntent, lang: AgentLang = intent.lang): string | null {
  if (!intent.to) return VOICE_TEXT[lang].whereTo;
  if (intent.batteryPct === null) return VOICE_TEXT[lang].batteryNow;
  return null;
}

/** "Planning Delhi to Jaipur with 80% battery." / "दिल्ली से जयपुर का प्लान बना रहा हूँ, बैटरी 80%." */
export function confirmTrip(intent: TripIntent, lang: AgentLang = intent.lang): string {
  if (!intent.to) return VOICE_TEXT[lang].whereTo;
  const to = placeFor(intent.to, lang);
  const hours = intent.dailyHours;
  if (lang === 'hi') {
    const from = intent.from ? placeFor(intent.from, lang) : 'यहाँ';
    let s = `${from} से ${to} का प्लान बना रहा हूँ`;
    if (intent.batteryPct !== null) s += `, बैटरी ${intent.batteryPct}%`;
    if (hours !== null) s += `, रोज़ ${hours} घंटे ड्राइव`;
    return `${s}.`;
  }
  let s = intent.from ? `Planning ${intent.from} to ${to}` : `Planning from here to ${to}`;
  if (intent.batteryPct !== null) s += ` with ${intent.batteryPct}% battery`;
  if (hours !== null) s += `, driving up to ${hours} ${hours === 1 ? 'hour' : 'hours'} a day`;
  return `${s}.`;
}

function duration(minutes: number, lang: AgentLang): string {
  const total = Math.max(0, Math.round(minutes / 5) * 5);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (lang === 'hi') return [h ? `${h} घंटे` : '', m ? `${m} मिनट` : ''].filter(Boolean).join(' ') || '5 मिनट से कम';
  const parts = [h ? `${h} ${h === 1 ? 'hour' : 'hours'}` : '', m ? `${m} minutes` : ''].filter(Boolean);
  return parts.join(' ') || 'under 5 minutes';
}

/** A short trip summary written to be read aloud, so it spells out units. */
export function speakPlan(summary: PlanSummary, lang: AgentLang, to?: string | null): string {
  const km = Math.round(summary.distanceKm);
  const time = duration(summary.totalMinutes, lang);
  const n = summary.stopCount;
  const first = summary.firstStopName;
  if (lang === 'hi') {
    const parts = [
      `${to ? `${placeFor(to, lang)} तक ` : ''}${km} किलोमीटर, चार्जिंग मिलाकर लगभग ${time}।`,
      n === 0 ? 'कोई चार्जिंग स्टॉप नहीं चाहिए।' : `${n} चार्जिंग स्टॉप${first ? `, पहला ${first} पर` : ''}।`,
    ];
    if (summary.nights > 0) parts.push(`रास्ते में ${summary.nights} रात रुकना होगा।`);
    parts.push(
      summary.feasible
        ? `पहुँचने पर बैटरी लगभग ${summary.arrivalSocPct} प्रतिशत रहेगी।`
        : 'यह ट्रिप इस प्लान से सुरक्षित नहीं है। स्क्रीन पर चेतावनी देखें।',
    );
    return parts.join(' ');
  }
  const parts = [
    `${to ? `${to} is ` : ''}${km} kilometres, about ${time} with charging.`,
    n === 0
      ? 'No charging stops needed.'
      : `${n === 1 ? 'One charging stop' : `${n} charging stops`}${first ? `, ${n === 1 ? 'at' : 'the first at'} ${first}` : ''}.`,
  ];
  if (summary.nights > 0) parts.push(`${summary.nights === 1 ? 'One night' : `${summary.nights} nights`} on the way.`);
  parts.push(
    summary.feasible
      ? `You'll arrive with about ${summary.arrivalSocPct} percent battery.`
      : "This trip isn't safe as planned. Check the warnings on screen.",
  );
  return parts.join(' ');
}
