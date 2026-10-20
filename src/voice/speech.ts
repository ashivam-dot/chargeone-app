// Speech in and out: the Capacitor plugins in the apps, the Web Speech API in the browser.
import { Capacitor, type PluginListenerHandle } from '@capacitor/core';
import type { AgentLang } from '../shared/contracts.ts';
import { VOICE_TEXT, type VoiceText } from './phrases.ts';

export type SpeechLang = 'hi-IN' | 'en-IN';

export interface ListenOptions {
  lang: SpeechLang;
  /** The words so far, while the driver is still speaking. */
  onPartial?: (text: string) => void;
  /** What was said, once; not called when the driver stops before saying anything. */
  onFinal: (text: string) => void;
  /** A message for the driver; listening has ended. */
  onError: (message: string) => void;
}

interface RecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: { readonly transcript: string };
}

interface Recognition {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  onresult: ((e: { readonly results: { readonly length: number; readonly [index: number]: RecognitionResult } }) => void) | null;
  onerror: ((e: { readonly error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

type RecognitionCtor = new () => Recognition;

/** iOS keeps listening until told to stop, so the apps stop after this much quiet once something was heard. */
const NATIVE_SILENCE_MS = 1800;
const VOICES_WAIT_MS = 1000;

export const speechLang = (lang: AgentLang): SpeechLang => (lang === 'hi' ? 'hi-IN' : 'en-IN');
const textFor = (lang: SpeechLang): VoiceText => VOICE_TEXT[lang === 'hi-IN' ? 'hi' : 'en'];
const noop = () => {};

let recognitionModule: Promise<typeof import('@capacitor-community/speech-recognition')> | null = null;
let ttsModule: Promise<typeof import('@capacitor-community/text-to-speech')> | null = null;

function nativeRecognition() {
  recognitionModule ??= import('@capacitor-community/speech-recognition').catch((err: unknown) => {
    recognitionModule = null;
    throw err;
  });
  return recognitionModule.then((m) => m.SpeechRecognition);
}

function nativeTts() {
  ttsModule ??= import('@capacitor-community/text-to-speech').catch((err: unknown) => {
    ttsModule = null;
    throw err;
  });
  return ttsModule;
}

function webRecognition(): RecognitionCtor | null {
  const g = globalThis as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return g.SpeechRecognition ?? g.webkitSpeechRecognition ?? null;
}

function webSynth(): SpeechSynthesis | null {
  return 'speechSynthesis' in globalThis && typeof SpeechSynthesisUtterance === 'function' ? globalThis.speechSynthesis : null;
}

export async function speechSupport(): Promise<{ listen: boolean; speak: boolean }> {
  if (Capacitor.isNativePlatform()) {
    const listen = await nativeRecognition()
      .then((sr) => sr.available())
      .then((r) => r.available, () => false);
    return { listen, speak: true };
  }
  return { listen: webRecognition() !== null, speak: webSynth() !== null };
}

function webError(code: string, t: VoiceText): string {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return t.micDenied;
    case 'no-speech':
      return t.noSpeech;
    case 'audio-capture':
      return t.noMic;
    case 'network':
      return t.voiceOffline;
    case 'language-not-supported':
      return t.noVoice;
    default:
      return t.voiceFailed;
  }
}

function nativeError(err: unknown, t: VoiceText): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/permission|denied|not authori[sz]ed|missing/i.test(msg)) return t.micDenied;
  if (/no match|didn.?t understand|no speech|speech timeout/i.test(msg)) return t.noSpeech;
  if (/network|server/i.test(msg)) return t.voiceOffline;
  return t.voiceFailed;
}

function listenWeb(opts: ListenOptions): () => void {
  const t = textFor(opts.lang);
  const Ctor = webRecognition();
  if (!Ctor) {
    opts.onError(t.noVoice);
    return noop;
  }
  const rec = new Ctor();
  rec.lang = opts.lang;
  rec.interimResults = true;
  rec.continuous = false;
  rec.maxAlternatives = 1;
  let finalText = '';
  let latest = '';
  let stopped = false;
  let done = false;
  const finish = () => {
    done = true;
    rec.onresult = rec.onerror = rec.onend = null;
  };
  rec.onresult = (e) => {
    let fin = '';
    let interim = '';
    for (let i = 0; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) fin += r[0]?.transcript ?? '';
      else interim += r[0]?.transcript ?? '';
    }
    finalText = fin.trim();
    latest = (fin + interim).trim();
    if (latest) opts.onPartial?.(latest);
  };
  rec.onerror = (e) => {
    if (e.error === 'aborted') return;
    finish();
    opts.onError(webError(e.error, t));
  };
  rec.onend = () => {
    finish();
    const text = finalText || latest;
    if (text) opts.onFinal(text);
    else if (!stopped) opts.onError(t.noSpeech);
  };
  try {
    rec.start();
  } catch {
    finish();
    opts.onError(t.voiceFailed);
    return noop;
  }
  return () => {
    if (done) return;
    stopped = true;
    rec.stop();
  };
}

async function listenNative(opts: ListenOptions): Promise<() => void> {
  const t = textFor(opts.lang);
  let sr: Awaited<ReturnType<typeof nativeRecognition>>;
  try {
    sr = await nativeRecognition();
    if (!(await sr.available()).available) {
      opts.onError(t.noVoice);
      return noop;
    }
  } catch {
    opts.onError(t.noVoice);
    return noop;
  }
  try {
    let perm = await sr.checkPermissions();
    if (perm.speechRecognition !== 'granted') perm = await sr.requestPermissions();
    if (perm.speechRecognition !== 'granted') {
      opts.onError(t.micDenied);
      return noop;
    }
  } catch {
    opts.onError(t.micDenied);
    return noop;
  }

  let heard = '';
  let done = false;
  let quiet: ReturnType<typeof setTimeout> | undefined;
  const handles: PluginListenerHandle[] = [];
  const finish = (how: 'ended' | 'stopped' | { error: string }) => {
    if (done) return;
    done = true;
    clearTimeout(quiet);
    for (const h of handles) void h.remove().catch(noop);
    if (typeof how === 'object') opts.onError(how.error);
    else if (heard) opts.onFinal(heard);
    else if (how === 'ended') opts.onError(t.noSpeech);
  };
  const stop = () => {
    if (done) return;
    void sr.stop().catch(noop);
    finish('stopped');
  };

  try {
    handles.push(
      await sr.addListener('partialResults', ({ matches }) => {
        const text = matches?.[0]?.trim();
        if (!text || done) return;
        heard = text;
        opts.onPartial?.(text);
        clearTimeout(quiet);
        quiet = setTimeout(stop, NATIVE_SILENCE_MS);
      }),
      await sr.addListener('listeningState', ({ status }) => {
        if (status === 'stopped') finish('ended');
      }),
    );
  } catch (err) {
    finish({ error: nativeError(err, t) });
    return noop;
  }
  sr.start({ language: opts.lang, partialResults: true, popup: false, maxResults: 1 }).then(
    (r) => {
      const text = r?.matches?.[0]?.trim();
      if (text) {
        heard = text;
        finish('ended');
      }
    },
    (err: unknown) => finish({ error: nativeError(err, t) }),
  );
  return stop;
}

/** Starts listening; resolves with a function that stops and delivers what was heard so far. */
export function listen(opts: ListenOptions): Promise<() => void> {
  return Capacitor.isNativePlatform() ? listenNative(opts) : Promise.resolve(listenWeb(opts));
}

/** The best installed voice for a language: an exact match, else any voice of that language, else none. */
export function pickVoice(voices: readonly SpeechSynthesisVoice[], lang: SpeechLang): SpeechSynthesisVoice | null {
  const norm = (l: string) => l.replace('_', '-').toLowerCase();
  const want = lang.toLowerCase();
  const base = want.slice(0, 2);
  return (
    voices.find((v) => norm(v.lang) === want && v.localService) ??
    voices.find((v) => norm(v.lang) === want) ??
    voices.find((v) => norm(v.lang).startsWith(base)) ??
    null
  );
}

function loadVoices(synth: SpeechSynthesis): Promise<SpeechSynthesisVoice[]> {
  const now = synth.getVoices();
  if (now.length) return Promise.resolve(now);
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      synth.removeEventListener('voiceschanged', done);
      resolve(synth.getVoices());
    };
    const timer = setTimeout(done, VOICES_WAIT_MS);
    synth.addEventListener('voiceschanged', done);
  });
}

/** Reads text aloud, replacing anything already being read; resolves when it ends or fails. */
export async function speak(text: string, lang: SpeechLang | AgentLang): Promise<void> {
  const bcp = lang === 'hi' || lang === 'en' ? speechLang(lang) : lang;
  if (!text.trim()) return;
  if (Capacitor.isNativePlatform()) {
    try {
      const { TextToSpeech, QueueStrategy } = await nativeTts();
      await TextToSpeech.speak({ text, lang: bcp, rate: 1, pitch: 1, queueStrategy: QueueStrategy.Flush });
    } catch {
      // Missing voice data or an interrupted utterance: the text is on screen anyway.
    }
    return;
  }
  const synth = webSynth();
  if (!synth) return;
  synth.cancel();
  const voice = pickVoice(await loadVoices(synth), bcp);
  const u = new SpeechSynthesisUtterance(text);
  u.lang = voice?.lang ?? bcp;
  if (voice) u.voice = voice;
  u.rate = 1;
  u.pitch = 1;
  await new Promise<void>((resolve) => {
    u.onend = () => resolve();
    u.onerror = () => resolve();
    synth.speak(u);
  });
}

export async function stopSpeaking(): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    if (!ttsModule) return;
    try {
      await (await ttsModule).TextToSpeech.stop();
    } catch {
      // Nothing was being read.
    }
    return;
  }
  webSynth()?.cancel();
}
