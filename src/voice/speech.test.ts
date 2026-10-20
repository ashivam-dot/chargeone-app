import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Capacitor } from '@capacitor/core';
import { ApiError, api } from '../lib/api.ts';
import { hdVoiceOn, setHdVoice } from './hd.ts';
import { listen, pickVoice, speak, speechSupport, stopSpeaking } from './speech.ts';

const native = vi.hoisted(() => {
  const listeners = new Map<string, (data: never) => void>();
  return {
    listeners,
    sr: {
      available: vi.fn(),
      checkPermissions: vi.fn(),
      requestPermissions: vi.fn(),
      addListener: vi.fn((name: string, fn: (data: never) => void) => {
        listeners.set(name, fn);
        return Promise.resolve({ remove: vi.fn(() => Promise.resolve()) });
      }),
      start: vi.fn(),
      stop: vi.fn(() => Promise.resolve()),
    },
    tts: { speak: vi.fn(() => Promise.resolve()), stop: vi.fn(() => Promise.resolve()) },
  };
});

vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: vi.fn(() => false) } }));
vi.mock('../lib/api.ts', async (actual) => ({ ...(await actual<typeof import('../lib/api.ts')>()), api: { voiceTts: vi.fn() } }));
vi.mock('@capacitor-community/speech-recognition', () => ({ SpeechRecognition: native.sr }));
vi.mock('@capacitor-community/text-to-speech', () => ({ TextToSpeech: native.tts, QueueStrategy: { Flush: 0, Add: 1 } }));

const nativeMock = vi.mocked(Capacitor.isNativePlatform);

type Result = { isFinal: boolean; length: number; 0: { transcript: string } };

class FakeRecognition {
  static last: FakeRecognition;
  lang = '';
  interimResults = false;
  continuous = true;
  maxAlternatives = 5;
  onresult: ((e: { results: Result[] }) => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  started = false;
  stop = vi.fn(() => this.onend?.());
  constructor() {
    FakeRecognition.last = this;
  }
  start() {
    this.started = true;
  }
  say(...parts: Array<[string, boolean]>) {
    this.onresult?.({ results: parts.map(([transcript, isFinal]) => ({ isFinal, length: 1, 0: { transcript } })) });
  }
}

const voice = (lang: string, name = lang, localService = true) => ({ lang, name, localService, default: false, voiceURI: name }) as SpeechSynthesisVoice;

class FakeUtterance {
  lang = '';
  voice: SpeechSynthesisVoice | null = null;
  rate = 0;
  pitch = 0;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly text: string) {}
}

function fakeSynth(voices: SpeechSynthesisVoice[]) {
  const handlers: Array<() => void> = [];
  return {
    voices,
    handlers,
    getVoices: () => voices,
    speak: vi.fn((u: FakeUtterance) => queueMicrotask(() => u.onend?.())),
    cancel: vi.fn(),
    addEventListener: vi.fn((_: string, fn: () => void) => handlers.push(fn)),
    removeEventListener: vi.fn(),
  };
}

const callbacks = () => ({ onPartial: vi.fn(), onFinal: vi.fn(), onError: vi.fn() });

beforeEach(() => {
  vi.clearAllMocks();
  nativeMock.mockReturnValue(false);
  native.listeners.clear();
});
afterEach(() => vi.unstubAllGlobals());

describe('web speech', () => {
  it('reports what the browser supports', async () => {
    expect(await speechSupport()).toEqual({ listen: false, speak: false });
    vi.stubGlobal('webkitSpeechRecognition', FakeRecognition);
    vi.stubGlobal('speechSynthesis', fakeSynth([]));
    vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance);
    expect(await speechSupport()).toEqual({ listen: true, speak: true });
  });

  it('streams partial words and delivers the final sentence', async () => {
    vi.stubGlobal('SpeechRecognition', FakeRecognition);
    const cb = callbacks();
    await listen({ lang: 'hi-IN', ...cb });
    const rec = FakeRecognition.last;
    expect(rec).toMatchObject({ lang: 'hi-IN', interimResults: true, continuous: false, started: true });
    rec.say(['दिल्ली से', false]);
    rec.say(['दिल्ली से जयपुर', true]);
    rec.onend?.();
    expect(cb.onPartial.mock.calls).toEqual([['दिल्ली से'], ['दिल्ली से जयपुर']]);
    expect(cb.onFinal).toHaveBeenCalledExactlyOnceWith('दिल्ली से जयपुर');
    expect(cb.onError).not.toHaveBeenCalled();
    expect(rec.onresult).toBeNull();
  });

  it('delivers what was heard when stopped early', async () => {
    vi.stubGlobal('SpeechRecognition', FakeRecognition);
    const cb = callbacks();
    const stop = await listen({ lang: 'en-IN', ...cb });
    FakeRecognition.last.say(['Pune to', false]);
    stop();
    expect(cb.onFinal).toHaveBeenCalledExactlyOnceWith('Pune to');
    stop();
    expect(FakeRecognition.last.stop).toHaveBeenCalledTimes(1);
  });

  it('stays quiet when stopped before anything was said', async () => {
    vi.stubGlobal('SpeechRecognition', FakeRecognition);
    const cb = callbacks();
    const stop = await listen({ lang: 'en-IN', ...cb });
    stop();
    expect(cb.onFinal).not.toHaveBeenCalled();
    expect(cb.onError).not.toHaveBeenCalled();
  });

  it('says when nothing was heard', async () => {
    vi.stubGlobal('SpeechRecognition', FakeRecognition);
    const cb = callbacks();
    await listen({ lang: 'en-IN', ...cb });
    FakeRecognition.last.onend?.();
    expect(cb.onError).toHaveBeenCalledWith("Didn't catch that. Tap the mic and try again.");
  });

  it.each([
    ['not-allowed', 'en-IN', 'Allow the microphone to plan by voice.'],
    ['service-not-allowed', 'hi-IN', 'आवाज़ से प्लान करने के लिए माइक्रोफ़ोन की अनुमति दें।'],
    ['audio-capture', 'en-IN', 'No microphone found.'],
    ['network', 'en-IN', 'Voice input needs an internet connection here. Type your trip instead.'],
  ] as const)('explains a %s error', async (code, lang, message) => {
    vi.stubGlobal('SpeechRecognition', FakeRecognition);
    const cb = callbacks();
    await listen({ lang, ...cb });
    FakeRecognition.last.onerror?.({ error: code });
    FakeRecognition.last.onend?.();
    expect(cb.onError).toHaveBeenCalledExactlyOnceWith(message);
    expect(cb.onFinal).not.toHaveBeenCalled();
  });

  it('explains when the browser has no speech recognition', async () => {
    const cb = callbacks();
    const stop = await listen({ lang: 'en-IN', ...cb });
    expect(cb.onError).toHaveBeenCalledWith("Voice input isn't available on this device. Type your trip instead.");
    expect(() => stop()).not.toThrow();
  });

  it('speaks with a voice for the language', async () => {
    const synth = fakeSynth([voice('en-US'), voice('hi_IN', 'Lekha')]);
    vi.stubGlobal('speechSynthesis', synth);
    vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance);
    await speak('जयपुर तक 281 किलोमीटर', 'hi');
    const u = synth.speak.mock.calls[0][0];
    expect(u).toMatchObject({ text: 'जयपुर तक 281 किलोमीटर', lang: 'hi_IN', voice: { name: 'Lekha' } });
    expect(synth.cancel).toHaveBeenCalled();
  });

  it('still speaks when no Hindi voice is installed', async () => {
    const synth = fakeSynth([voice('en-US')]);
    vi.stubGlobal('speechSynthesis', synth);
    vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance);
    await speak('नमस्ते', 'hi-IN');
    expect(synth.speak.mock.calls[0][0]).toMatchObject({ lang: 'hi-IN', voice: null });
  });

  it('waits for voices that load late', async () => {
    const synth = fakeSynth([]);
    vi.stubGlobal('speechSynthesis', synth);
    vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance);
    const done = speak('Hello', 'en');
    await Promise.resolve();
    synth.voices.push(voice('en-IN', 'Rishi'));
    synth.handlers.forEach((h) => h());
    await done;
    expect(synth.speak.mock.calls[0][0]).toMatchObject({ voice: { name: 'Rishi' } });
  });

  it('stops speaking', async () => {
    const synth = fakeSynth([]);
    vi.stubGlobal('speechSynthesis', synth);
    vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance);
    await stopSpeaking();
    expect(synth.cancel).toHaveBeenCalledTimes(1);
  });
});

describe('pickVoice', () => {
  it('prefers an exact on-device match, then any voice of the language', () => {
    const list = [voice('en-GB'), voice('en-IN', 'cloud', false), voice('en-IN', 'local'), voice('hi-IN')];
    expect(pickVoice(list, 'en-IN')?.name).toBe('local');
    expect(pickVoice([voice('en-GB')], 'en-IN')?.lang).toBe('en-GB');
    expect(pickVoice([voice('en-GB')], 'hi-IN')).toBeNull();
  });

  it('prefers a neural Indian voice, and an Indian accent over a nicer foreign one', () => {
    const edge = [
      voice('en-IN', 'Microsoft Heera - English (India)'),
      voice('en-IN', 'Microsoft Neerja Online (Natural) - English (India)', false),
      voice('en-GB', 'Microsoft Sonia Online (Natural) - English (United Kingdom)', false),
    ];
    expect(pickVoice(edge, 'en-IN')?.name).toMatch(/Neerja/);
    const chrome = [voice('hi-IN', 'Lekha'), voice('hi-IN', 'Google हिन्दी', false)];
    expect(pickVoice(chrome, 'hi-IN')?.name).toBe('Google हिन्दी');
    expect(pickVoice([voice('en-IN', 'Rishi'), voice('en-US', 'Samantha (Enhanced)')], 'en-IN')?.name).toBe('Rishi');
  });
});

describe('speaking naturally', () => {
  it('says units and symbols as words, one sentence at a time', async () => {
    const synth = fakeSynth([voice('en-IN', 'Rishi')]);
    vi.stubGlobal('speechSynthesis', synth);
    vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance);
    await speak('Charge to 80% at Zeon Charging, Salem. It costs about ₹450 for 30 kWh.', 'en');
    expect(synth.speak.mock.calls.map((c) => c[0].text)).toEqual([
      'Charge to 80 percent at Zeon Charging, Salem.',
      'It costs about 450 rupees for 30 kilowatt-hours.',
    ]);
  });

  it('stops before the next sentence', async () => {
    const synth = fakeSynth([]);
    synth.speak.mockImplementation((u: FakeUtterance) => queueMicrotask(() => {
      void stopSpeaking();
      u.onend?.();
    }));
    vi.stubGlobal('speechSynthesis', synth);
    vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance);
    await speak('The first sentence is long enough. The second one is too.', 'en');
    expect(synth.speak).toHaveBeenCalledTimes(1);
  });
});

class FakeAudio {
  static played: string[] = [];
  static fail = false;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onpause: (() => void) | null = null;
  constructor(readonly src: string) {}
  play() {
    if (FakeAudio.fail) return Promise.reject(new Error('NotAllowedError'));
    FakeAudio.played.push(this.src);
    queueMicrotask(() => this.onended?.());
    return Promise.resolve();
  }
  pause() {
    this.onpause?.();
  }
}

describe('HD voice', () => {
  const tts = vi.mocked(api.voiceTts);
  const clip = (text: string) => ({ mime: 'audio/mpeg', audio: btoa(text), cached: false });

  beforeEach(() => {
    FakeAudio.played = [];
    FakeAudio.fail = false;
    vi.stubGlobal('Audio', FakeAudio);
    vi.stubGlobal('speechSynthesis', fakeSynth([]));
    vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance);
    setHdVoice(true);
  });
  afterEach(() => setHdVoice(false));

  it('plays each sentence from the server, fetching the next one while the first plays', async () => {
    tts.mockImplementation(async (text) => clip(text));
    const [a, b] = ['Charge at Zeon Charging in Salem.', 'Then drive on to Chennai.'];
    await speak(`${a} ${b}`, 'en');
    expect(tts.mock.calls).toEqual([[a, 'en'], [b, 'en']]);
    expect(FakeAudio.played).toEqual([`data:audio/mpeg;base64,${btoa(a)}`, `data:audio/mpeg;base64,${btoa(b)}`]);
    expect(vi.mocked(speechSynthesis.speak)).not.toHaveBeenCalled();
  });

  it('asks the server once for a line it has already read', async () => {
    tts.mockImplementation(async (text) => clip(text));
    await speak('You have arrived.', 'en');
    await speak('You have arrived.', 'en');
    expect(tts).toHaveBeenCalledTimes(1);
    expect(FakeAudio.played).toHaveLength(2);
  });

  it('lets the system voice finish when the server fails part-way', async () => {
    tts.mockImplementation(async (text) => {
      if (text.startsWith('The second')) throw new ApiError(503, 'voice_unavailable', 'down', {});
      return clip(text);
    });
    await speak('The first line is read by the server. The second line is not.', 'en');
    expect(FakeAudio.played).toHaveLength(1);
    expect(vi.mocked(speechSynthesis.speak).mock.calls.map((c) => (c[0] as unknown as FakeUtterance).text)).toEqual(['The second line is not.']);
    expect(hdVoiceOn()).toBe(true);
  });

  it("turns itself off for the session when today's allowance is used", async () => {
    tts.mockRejectedValue(new ApiError(429, 'voice_limit', 'limit', {}));
    await speak('Limit reached now.', 'en');
    expect(hdVoiceOn()).toBe(false);
    expect(vi.mocked(speechSynthesis.speak)).toHaveBeenCalledTimes(1);
  });

  it('falls back when the WebView refuses to play audio', async () => {
    FakeAudio.fail = true;
    tts.mockImplementation(async (text) => clip(text));
    await speak('Playback blocked here.', 'en');
    expect(vi.mocked(speechSynthesis.speak)).toHaveBeenCalledTimes(1);
  });
});

describe('native speech', () => {
  beforeEach(() => {
    nativeMock.mockReturnValue(true);
    native.sr.available.mockResolvedValue({ available: true });
    native.sr.checkPermissions.mockResolvedValue({ speechRecognition: 'granted' });
    native.sr.start.mockResolvedValue({});
  });

  const emit = (name: string, data: unknown) => (native.listeners.get(name) as (d: unknown) => void)(data);

  it('reports support from the plugin', async () => {
    expect(await speechSupport()).toEqual({ listen: true, speak: true });
    native.sr.available.mockRejectedValue(new Error('not implemented'));
    expect(await speechSupport()).toEqual({ listen: false, speak: true });
  });

  it('asks for the microphone and explains a refusal', async () => {
    native.sr.checkPermissions.mockResolvedValue({ speechRecognition: 'prompt' });
    native.sr.requestPermissions.mockResolvedValue({ speechRecognition: 'denied' });
    const cb = callbacks();
    await listen({ lang: 'en-IN', ...cb });
    expect(cb.onError).toHaveBeenCalledWith('Allow the microphone to plan by voice.');
    expect(native.sr.start).not.toHaveBeenCalled();
  });

  it('listens without the system popup and delivers the last partial result', async () => {
    const cb = callbacks();
    await listen({ lang: 'hi-IN', ...cb });
    expect(native.sr.start).toHaveBeenCalledWith({ language: 'hi-IN', partialResults: true, popup: false, maxResults: 1 });
    emit('partialResults', { matches: ['जयपुर'] });
    emit('partialResults', { matches: ['जयपुर चलो'] });
    emit('listeningState', { status: 'stopped' });
    expect(cb.onPartial).toHaveBeenCalledTimes(2);
    expect(cb.onFinal).toHaveBeenCalledExactlyOnceWith('जयपुर चलो');
  });

  it('stops on request and removes its listeners', async () => {
    const cb = callbacks();
    const stop = await listen({ lang: 'en-IN', ...cb });
    emit('partialResults', { matches: ['Goa'] });
    stop();
    emit('listeningState', { status: 'stopped' });
    expect(native.sr.stop).toHaveBeenCalledTimes(1);
    expect(cb.onFinal).toHaveBeenCalledExactlyOnceWith('Goa');
    const handles = await Promise.all(native.sr.addListener.mock.results.map((r) => r.value as Promise<{ remove: () => void }>));
    for (const h of handles) expect(h.remove).toHaveBeenCalled();
  });

  it('stops by itself after a pause once something was heard', async () => {
    vi.useFakeTimers();
    try {
      const cb = callbacks();
      await listen({ lang: 'en-IN', ...cb });
      emit('partialResults', { matches: ['Ooty'] });
      vi.advanceTimersByTime(2000);
      expect(native.sr.stop).toHaveBeenCalled();
      expect(cb.onFinal).toHaveBeenCalledWith('Ooty');
    } finally {
      vi.useRealTimers();
    }
  });

  it('explains a failed start', async () => {
    native.sr.start.mockRejectedValue(new Error('Missing permission'));
    const cb = callbacks();
    await listen({ lang: 'en-IN', ...cb });
    await Promise.resolve();
    expect(cb.onError).toHaveBeenCalledWith('Allow the microphone to plan by voice.');
  });

  it('speaks through the plugin in the right language and stops it', async () => {
    await speak('Charge at Behror.', 'en');
    expect(native.tts.speak).toHaveBeenCalledWith({ text: 'Charge at Behror.', lang: 'en-IN', rate: 1, pitch: 1, queueStrategy: 0 });
    native.tts.speak.mockRejectedValueOnce(new Error('Language not supported'));
    await expect(speak('नमस्ते', 'hi')).resolves.toBeUndefined();
    await stopSpeaking();
    expect(native.tts.stop).toHaveBeenCalled();
  });
});
