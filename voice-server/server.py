"""ChargeOne HD voice: a small HTTP server that turns a sentence into speech with open models.

Supertonic 3 (Supertone, OpenRAIL-M weights, 31 languages including Hindi and English) runs on the CPU
through sherpa-onnx. No GPU, no account and no paid API. The ChargeOne Worker is the only client:
it sends one sentence at a time and caches the result, so the box needs little power.

  POST /tts     {"text": "...", "lang": "en" | "hi"}   -> audio/mpeg
  GET  /health                                          -> {"ok": true, ...}

Environment:
  VOICE_TOKEN    required; the Worker sends it as "Authorization: Bearer <token>"
  MODEL_DIR      the unpacked sherpa-onnx Supertonic model (default ./models/supertonic-3)
  PORT           default 8080
  THREADS        ONNX threads per request (default 2)
  VOICE_EN, VOICE_HI   speaker ids 0-9; 0-4 are higher voices, 5-9 lower (default 1)
  STEPS          denoising steps, 5-12 (default 8)

Run it (any free 2-4 core CPU box, e.g. Oracle Cloud's Always Free Ampere A1; about 1.5 GB of RAM):
  python3 fetch_model.py                  # downloads the model and checks its sha256
  pip install -r requirements.txt
  VOICE_TOKEN=<random 32+ chars> python3 server.py
or build the Dockerfile. Put it behind HTTPS (Caddy, or a Cloudflare Tunnel), then set the Worker's
VOICE_TTS_URL and VOICE_TTS_TOKEN secrets. Unset, the app reads with the phone's own voice.
"""

import hmac
import io
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import sherpa_onnx
import soundfile as sf

MAX_CHARS = 400
OUT_RATE = 24000
LANGS = {'en', 'hi'}

TOKEN = os.environ.get('VOICE_TOKEN', '')
MODEL_DIR = os.environ.get('MODEL_DIR', os.path.join(os.path.dirname(__file__), 'models', 'supertonic-3'))
SPEAKER = {'en': int(os.environ.get('VOICE_EN', '1')), 'hi': int(os.environ.get('VOICE_HI', '1'))}
# Denoising steps: more is clearer (Hindi especially) and slower. On a 4-thread laptop CPU, 5 steps ran at
# about 0.2x real time and 10 at 0.2-0.6x (Hindi slowest); lower it on a slow box.
STEPS = int(os.environ.get('STEPS', '8'))


def load_tts() -> sherpa_onnx.OfflineTts:
    m = MODEL_DIR
    cfg = sherpa_onnx.OfflineTtsConfig(
        model=sherpa_onnx.OfflineTtsModelConfig(
            supertonic=sherpa_onnx.OfflineTtsSupertonicModelConfig(
                duration_predictor=f'{m}/duration_predictor.int8.onnx',
                text_encoder=f'{m}/text_encoder.int8.onnx',
                vector_estimator=f'{m}/vector_estimator.int8.onnx',
                vocoder=f'{m}/vocoder.int8.onnx',
                tts_json=f'{m}/tts.json',
                unicode_indexer=f'{m}/unicode_indexer.bin',
                voice_style=f'{m}/voice.bin',
            ),
            num_threads=int(os.environ.get('THREADS', '2')),
        ),
    )
    return sherpa_onnx.OfflineTts(cfg)


def to_mp3(samples: np.ndarray, rate: int) -> bytes:
    """Mono MP3 at 24 kHz: about 4 KB per second of speech, playable on every phone and browser."""
    if rate != OUT_RATE:
        n = int(len(samples) * OUT_RATE / rate)
        samples = np.interp(np.linspace(0, len(samples) - 1, n), np.arange(len(samples)), samples)
    peak = float(np.max(np.abs(samples))) if len(samples) else 0.0
    if peak > 0.98:
        samples = samples * (0.98 / peak)
    buf = io.BytesIO()
    sf.write(buf, samples.astype(np.float32), OUT_RATE, format='MP3')
    return buf.getvalue()


class Voice:
    def __init__(self) -> None:
        self.tts = load_tts()
        # One model, one synthesis at a time; requests queue briefly instead of thrashing the CPU.
        self.lock = threading.Lock()

    def speak(self, text: str, lang: str) -> tuple[bytes, float, float]:
        g = sherpa_onnx.GenerationConfig()
        g.sid = SPEAKER[lang]
        g.speed = 1.0
        g.num_steps = STEPS
        g.extra = {'lang': lang}
        t0 = time.time()
        with self.lock:
            audio = self.tts.generate(text, g)
        took = time.time() - t0
        samples = np.asarray(audio.samples, dtype=np.float32)
        return to_mp3(samples, audio.sample_rate), len(samples) / audio.sample_rate, took


VOICE: Voice | None = None


class Handler(BaseHTTPRequestHandler):
    server_version = 'chargeone-voice'

    def _send(self, code: int, body: bytes, kind: str = 'application/json', extra: dict | None = None) -> None:
        self.send_response(code)
        self.send_header('Content-Type', kind)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code: int, data: dict) -> None:
        self._send(code, json.dumps(data).encode())

    def log_message(self, fmt: str, *args) -> None:
        # Never log request bodies: they are what a driver asked the copilot.
        pass

    def do_GET(self) -> None:
        if self.path == '/health':
            self._json(200, {'ok': VOICE is not None, 'model': 'supertonic-3', 'langs': sorted(LANGS)})
        else:
            self._json(404, {'error': 'not_found'})

    def do_POST(self) -> None:
        if self.path != '/tts':
            return self._json(404, {'error': 'not_found'})
        auth = self.headers.get('Authorization', '')
        if not TOKEN or not hmac.compare_digest(auth.encode(), f'Bearer {TOKEN}'.encode()):
            return self._json(401, {'error': 'unauthorized'})
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if length <= 0 or length > 4096:
                return self._json(413, {'error': 'too_large'})
            data = json.loads(self.rfile.read(length))
            if not isinstance(data, dict):
                raise ValueError('not an object')
            text = str(data.get('text', '')).strip()
            lang = str(data.get('lang', 'en'))
        except (ValueError, UnicodeDecodeError):
            return self._json(400, {'error': 'bad_request'})
        if not text or len(text) > MAX_CHARS or lang not in LANGS:
            return self._json(400, {'error': 'bad_request'})
        assert VOICE is not None
        try:
            mp3, secs, took = VOICE.speak(text, lang)
        except Exception:
            return self._json(500, {'error': 'synthesis_failed'})
        self._send(200, mp3, 'audio/mpeg', {'X-Audio-Seconds': f'{secs:.2f}', 'X-Synth-Seconds': f'{took:.2f}'})


def main() -> None:
    global VOICE
    if len(TOKEN) < 24:
        raise SystemExit('Set VOICE_TOKEN to a random string of at least 24 characters.')
    VOICE = Voice()
    port = int(os.environ.get('PORT', '8080'))
    print(f'ChargeOne voice on :{port}, speakers {SPEAKER}', flush=True)
    ThreadingHTTPServer(('0.0.0.0', port), Handler).serve_forever()


if __name__ == '__main__':
    main()
