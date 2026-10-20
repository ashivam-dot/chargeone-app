import { ArrowUp, Lock, Mic, Sparkles, Square, Volume2, VolumeX } from 'lucide-preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { ApiError } from '../../lib/api.ts';
import { chatHistory, parseTrip, streamAgent } from '../../lib/agentClient.ts';
import { searchPlaces } from '../../lib/geocode.ts';
import { haptic } from '../../native/platform.ts';
import type { AgentLang, AgentMessage, TripIntent } from '../../shared/contracts.ts';
import { TRIAL_DAYS } from '../../shared/plans.ts';
import type { MyVehicle } from '../../shared/vehicles.ts';
import { buildAgentContext } from '../../voice/agentContext.ts';
import { detectLang, parseTripIntent } from '../../voice/intent.ts';
import { VOICE_TEXT, confirmTrip, missingQuestion } from '../../voice/phrases.ts';
import { looksLikeTripRequest } from '../../voice/tripRequest.ts';
import { listen, speak, speechLang, speechSupport, stopSpeaking } from '../../voice/speech.ts';
import { carLinkState } from '../car/carLink.ts';
import type { PickedPlace } from '../PlaceInput.tsx';
import { Page } from '../shell/Page.tsx';
import type { PlannedTrip } from '../TripPlanner.tsx';
import './copilot.css';

export interface VoiceTrip {
  from: PickedPlace | null;
  to: PickedPlace;
  batteryPct: number | null;
  lang: AgentLang;
}

interface Props {
  signedIn: boolean;
  /** Who the conversation belongs to; it starts over when this changes. */
  account: string | null;
  /** Plus or a running trial. */
  canUse: boolean;
  trialAvailable: boolean;
  vehicle: MyVehicle | null;
  trip: PlannedTrip | null;
  onPlanTrip: (trip: VoiceTrip) => void;
  onUnlock: () => void;
  onStartTrial: () => void;
  onSignIn: () => void;
}

interface Bubble extends AgentMessage {
  id: number;
  pending?: boolean;
  error?: boolean;
}

type Orb = 'idle' | 'listening' | 'thinking' | 'speaking';

const MAX_HISTORY = 12;
const BARE_NUMBER = /^\D*(\d{1,3})\D*$/;
/** Ends a "where to?" follow-up instead of searching for the reply as a place. */
const CANCEL = /^\s*(?:cancel|stop|never\s*mind|forget it|leave it|no|nope|nahi|nahin|rehne do|chhodo|chodo|रहने दो|छोड़ो|नहीं|कैंसल)(?:$|[\s,.!?।])/i;

const SUGGEST: Record<AgentLang, { trip: string[]; none: string[] }> = {
  en: {
    trip: ['Where can we eat on the way?', 'What if my next charger is down?', 'Can I skip a charging stop?', 'How much will charging cost?'],
    none: ['Plan Pune to Goa with 80% battery', 'How far can my car go at 100 km/h?', 'Best way to charge on a road trip?', 'Fast chargers near me'],
  },
  hi: {
    trip: ['रास्ते में खाना कहाँ मिलेगा?', 'अगर अगला चार्जर बंद हो तो?', 'क्या एक स्टॉप छोड़ सकते हैं?', 'चार्जिंग का खर्च कितना होगा?'],
    none: ['दिल्ली से जयपुर, बैटरी 80 प्रतिशत', '100 की स्पीड पर गाड़ी कितनी दूर जाएगी?', 'रोड ट्रिप पर चार्जिंग कैसे करें?', 'पास में फ़ास्ट चार्जर'],
  },
};

const GREETING: Record<AgentLang, [string, string]> = {
  en: ['Hi, I’m your trip copilot', 'Ask about your route, chargers, food, your car, or just say where you want to go.'],
  hi: ['नमस्ते, मैं आपका ट्रिप कोपायलट हूँ', 'रास्ते, चार्जर, खाने या गाड़ी के बारे में पूछें, या बस बताएँ कहाँ जाना है।'],
};

// The conversation survives switching tabs.
let memory: { account: string | null; bubbles: Bubble[]; lang: AgentLang; speakOn: boolean } = { account: null, bubbles: [], lang: 'en', speakOn: true };
let nextId = 1;

async function resolvePlace(name: string, signal: AbortSignal): Promise<PickedPlace | null> {
  const [p] = await searchPlaces(name, signal);
  return p ? { name: p.name, lat: p.lat, lng: p.lng, bbox: p.bbox } : null;
}

export function CopilotScreen({ signedIn, account, canUse, trialAvailable, vehicle, trip, onPlanTrip, onUnlock, onStartTrial, onSignIn }: Props) {
  const [bubbles, setBubbles] = useState<Bubble[]>(memory.account === account ? memory.bubbles : []);
  const owner = useRef(account);
  const [lang, setLang] = useState<AgentLang>(memory.lang);
  const [speakOn, setSpeakOn] = useState(memory.speakOn);
  const [orb, setOrb] = useState<Orb>('idle');
  const [draft, setDraft] = useState('');
  const [partial, setPartial] = useState('');
  const [canListen, setCanListen] = useState(true);
  const stopListen = useRef<(() => void) | null>(null);
  const abort = useRef<AbortController | null>(null);
  const pendingTrip = useRef<TripIntent | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const text = VOICE_TEXT[lang];

  useEffect(() => {
    memory = { account, bubbles, lang, speakOn };
  }, [account, bubbles, lang, speakOn]);

  useEffect(() => {
    if (owner.current === account) return;
    owner.current = account;
    abort.current?.abort();
    pendingTrip.current = null;
    setBubbles([]);
  }, [account]);

  useEffect(() => {
    void speechSupport().then((s) => setCanListen(s.listen));
    return () => {
      abort.current?.abort();
      stopListen.current?.();
      void stopSpeaking();
    };
  }, []);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [bubbles]);

  const add = (b: Omit<Bubble, 'id'>): number => {
    const id = nextId++;
    setBubbles((cur) => [...cur, { ...b, id }]);
    return id;
  };
  const patch = (id: number, p: Partial<Bubble>) => setBubbles((cur) => cur.map((b) => (b.id === id ? { ...b, ...p } : b)));

  const say = async (s: string, l: AgentLang, voice: boolean) => {
    if (!voice || !speakOn) return;
    setOrb('speaking');
    await speak(s, l);
    setOrb((o) => (o === 'speaking' ? 'idle' : o));
  };

  const handoff = async (intent: TripIntent, voice: boolean) => {
    const l = intent.lang;
    const question = missingQuestion(intent, l);
    if (question) {
      pendingTrip.current = intent;
      add({ role: 'assistant', content: question });
      await say(question, l, voice);
      return;
    }
    pendingTrip.current = null;
    const ctrl = new AbortController();
    abort.current = ctrl;
    setOrb('thinking');
    const [from, to] = await Promise.all([
      intent.from ? resolvePlace(intent.from, ctrl.signal).catch(() => null) : Promise.resolve(null),
      resolvePlace(intent.to!, ctrl.signal).catch(() => null),
    ]);
    if (ctrl.signal.aborted) return;
    setOrb('idle');
    if (!to || (intent.from && !from)) {
      const missing = !to ? intent.to : intent.from;
      const msg = l === 'hi' ? `“${missing}” नहीं मिला। जगह का नाम फिर से बताएँ।` : `I couldn't find “${missing}”. Try the town name again.`;
      add({ role: 'assistant', content: msg, error: true });
      await say(msg, l, voice);
      return;
    }
    const confirm = confirmTrip(intent, l);
    add({ role: 'assistant', content: confirm });
    void haptic('success');
    void say(confirm, l, voice);
    onPlanTrip({ from, to, batteryPct: intent.batteryPct, lang: l });
  };

  const askAgent = async (history: AgentMessage[], l: AgentLang, voice: boolean) => {
    const id = add({ role: 'assistant', content: '', pending: true });
    const ctrl = new AbortController();
    abort.current = ctrl;
    setOrb('thinking');
    const link = carLinkState();
    const t = link.state === 'connected' ? link.telemetry : null;
    const context = buildAgentContext({
      vehicle: vehicle ? { vehicle, socPct: t?.socPct ?? null, rangeKm: t?.rangeKm ?? null } : null,
      trip: trip ? { from: trip.from.name, to: trip.to.name, plan: trip.journey } : null,
      position: t && t.lat !== null && t.lng !== null ? { lat: t.lat, lng: t.lng } : null,
    });
    try {
      const full = await streamAgent({ messages: history, context, lang: l }, { signal: ctrl.signal, onText: (_c, all) => patch(id, { content: all }) });
      patch(id, { content: full, pending: false });
      setOrb('idle');
      void say(full, l, voice);
    } catch (e) {
      setOrb('idle');
      if (ctrl.signal.aborted) {
        patch(id, { pending: false });
        return;
      }
      if (e instanceof ApiError && e.status === 401) onSignIn();
      if (e instanceof ApiError && e.status === 402) onUnlock();
      patch(id, { content: e instanceof Error ? e.message : 'Something went wrong.', pending: false, error: true });
    }
  };

  const submit = async (raw: string, voice: boolean) => {
    const input = raw.trim().slice(0, 1000);
    if (!input || orb === 'thinking') return;
    void stopSpeaking();
    const l = voice ? lang : detectLang(input) === 'hi' ? 'hi' : lang;
    setDraft('');
    const history = chatHistory([...bubbles.filter((b) => !b.error).map(({ role, content }) => ({ role, content })), { role: 'user', content: input }], MAX_HISTORY);
    add({ role: 'user', content: input });

    if (pendingTrip.current && CANCEL.test(input)) pendingTrip.current = null;
    const pending = pendingTrip.current;
    if (pending) {
      const more = parseTripIntent(input, l);
      const bare = input.match(BARE_NUMBER);
      const n = bare ? Number(bare[1]) : NaN;
      const merged: TripIntent = {
        ...pending,
        to: pending.to ?? more.to ?? (more.from ? more.from : !bare ? input : null),
        batteryPct: pending.batteryPct ?? more.batteryPct ?? (n >= 5 && n <= 100 ? n : null),
      };
      if (merged.to !== pending.to || merged.batteryPct !== pending.batteryPct) {
        await handoff(merged, voice);
        return;
      }
      pendingTrip.current = null;
    }

    const local = parseTripIntent(input, l);
    if (looksLikeTripRequest(input, local)) {
      const ctrl = new AbortController();
      abort.current = ctrl;
      setOrb('thinking');
      const intent = await parseTrip(input, l, { remote: canUse, signal: ctrl.signal });
      if (ctrl.signal.aborted) return;
      const soc = carLinkState().telemetry?.socPct;
      await handoff({ ...intent, lang: l, batteryPct: intent.batteryPct ?? (soc !== undefined && soc !== null ? Math.round(soc) : null) }, voice);
      return;
    }
    await askAgent(history, l, voice);
  };

  const toggleMic = async () => {
    if (orb === 'listening') {
      stopListen.current?.();
      return;
    }
    void stopSpeaking();
    void haptic('medium');
    setPartial('');
    setOrb('listening');
    stopListen.current = await listen({
      lang: speechLang(lang),
      onPartial: setPartial,
      onFinal: (said) => {
        stopListen.current = null;
        setPartial('');
        setOrb('idle');
        void submit(said, true);
      },
      onError: (message) => {
        stopListen.current = null;
        setPartial('');
        setOrb('idle');
        add({ role: 'assistant', content: message, error: true });
      },
    });
  };

  const stop = () => {
    abort.current?.abort();
    void stopSpeaking();
    setOrb('idle');
  };

  if (!canUse) {
    return (
      <Page title="Copilot" testId="screen-copilot" eyebrow={<span class="pill pill--plus">Plus</span>}>
        <div class="copilot-hero">
          <div class="orb orb--idle" aria-hidden="true">
            <span class="orb__core">
              <Mic size={30} />
            </span>
            <span class="orb__ring" />
            <span class="orb__ring orb__ring--2" />
          </div>
          <h2 class="grad-text--plus">Plan your whole trip by voice</h2>
          <p class="muted">Say “Pune se Goa jaana hai, battery 80 percent” or ask anything on the way: chargers, food, cost, your car. In Hindi or English.</p>
        </div>
        <div class="copilot-sample" aria-label="Example conversation">
          <div class="bubble bubble--user">Lonavala ke baad agla charger kaisa hai?</div>
          <div class="bubble bubble--assistant">The next one is a 60 kW charger 22 km ahead, reported working 40 minutes ago. You'll reach it with about 41%.</div>
          <span class="small muted center">An example. Real answers use your trip and the latest charger reports.</span>
        </div>
        <button class="btn btn--plus btn--block btn--lg" onClick={trialAvailable ? onStartTrial : onUnlock} data-testid="copilot-unlock">
          {trialAvailable ? <Sparkles size={18} aria-hidden="true" /> : <Lock size={18} aria-hidden="true" />}
          {trialAvailable ? `Try Plus free for ${TRIAL_DAYS} days` : 'Unlock with Plus'}
        </button>
        {!signedIn && <p class="small muted center">You'll sign in with Google first.</p>}
      </Page>
    );
  }

  const greeting = GREETING[lang];
  const ideas = trip ? SUGGEST[lang].trip : SUGGEST[lang].none;

  return (
    <Page
      title="Copilot"
      testId="screen-copilot"
      class="page--copilot"
      eyebrow={<span class="pill pill--plus">Plus</span>}
      actions={
        <button class="icon-btn" onClick={() => setSpeakOn((v) => !v)} aria-pressed={speakOn} aria-label={speakOn ? 'Stop reading answers aloud' : 'Read answers aloud'}>
          {speakOn ? <Volume2 size={18} /> : <VolumeX size={18} />}
        </button>
      }
    >
      <div class="seg" role="radiogroup" aria-label="Language">
        {(['en', 'hi'] as const).map((l) => (
          <button
            key={l}
            role="radio"
            aria-checked={lang === l}
            class={`seg__btn${lang === l ? ' is-on' : ''}`}
            onClick={() => {
              void haptic('selection');
              setLang(l);
            }}
            data-testid={`lang-${l}`}
          >
            {l === 'en' ? 'English' : 'हिंदी'}
          </button>
        ))}
      </div>
      <div class="chat" ref={listRef} aria-live="polite">
        {bubbles.length === 0 && (
          <div class="copilot-hero copilot-hero--chat">
            <button class={`orb orb--${orb}`} onClick={() => void toggleMic()} aria-label={orb === 'listening' ? 'Stop listening' : 'Speak'} disabled={!canListen}>
              <span class="orb__core">
                <Mic size={30} aria-hidden="true" />
              </span>
              <span class="orb__ring" />
              <span class="orb__ring orb__ring--2" />
            </button>
            <h2>{greeting[0]}</h2>
            <p class="muted">{greeting[1]}</p>
            {trip && (
              <span class="pill">
                Knows your trip: {trip.from.name} to {trip.to.name}
              </span>
            )}
          </div>
        )}
        {bubbles.map((b) => (
          <div key={b.id} class={`bubble bubble--${b.role}${b.error ? ' bubble--error' : ''}${b.pending ? ' is-pending' : ''}`}>
            {b.content || (b.pending ? <span class="dots" aria-label={text.thinking} /> : null)}
          </div>
        ))}
        {orb === 'listening' && (
          <div class="bubble bubble--user bubble--live" aria-live="assertive">
            {partial || text.listening}
          </div>
        )}
      </div>

      {bubbles.length < 2 && (
        <div class="chips chips--scroll" aria-label="Suggestions">
          {ideas.map((s) => (
            <button key={s} class="chip" onClick={() => void submit(s, false)}>
              {s}
            </button>
          ))}
        </div>
      )}

      <form
        class="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(draft, false);
        }}
      >
        <button
          type="button"
          class={`composer__mic${orb === 'listening' ? ' is-on' : ''}`}
          onClick={() => void toggleMic()}
          disabled={!canListen}
          aria-label={orb === 'listening' ? 'Stop listening' : 'Speak'}
          data-testid="copilot-mic"
        >
          <Mic size={20} />
        </button>
        <input
          class="composer__input"
          value={draft}
          maxLength={1000}
          placeholder={lang === 'hi' ? 'कुछ भी पूछें या ट्रिप बताएँ' : 'Ask anything, or say a trip'}
          aria-label="Message"
          onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
          data-testid="copilot-input"
        />
        {orb === 'thinking' || orb === 'speaking' ? (
          <button type="button" class="composer__send" onClick={stop} aria-label="Stop">
            <Square size={16} />
          </button>
        ) : (
          <button type="submit" class="composer__send" disabled={!draft.trim()} aria-label="Send" data-testid="copilot-send">
            <ArrowUp size={18} />
          </button>
        )}
      </form>
    </Page>
  );
}
