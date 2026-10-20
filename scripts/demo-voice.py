"""Speaks every line of demo-narration.json with Supertonic 3 (the voice behind ChargeOne's HD voice) into
../demo/raw/voice/.

Run with the voice-server's Python (sherpa-onnx, numpy, soundfile) and its model:
    MODEL_DIR=<unpacked model> <venv>/bin/python scripts/demo-voice.py
Each line may set its own "voice" (speaker 0-9) and "lang" ("en" or "hi").
Writes <id>.wav per line and durations.json ({id: seconds}), which demo-video.ts uses to pace each scene.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "voice-server"))
os.environ.setdefault("VOICE_TOKEN", "unused-by-this-script-000000")

from server import load_tts  # noqa: E402
import sherpa_onnx  # noqa: E402

OUT = HERE.parent.parent / "demo" / "raw" / "voice"
FLOOR = 0.01


def trim(audio: np.ndarray, rate: int) -> np.ndarray:
    loud = np.flatnonzero(np.abs(audio) > FLOOR * np.abs(audio).max(initial=0.0))
    if not loud.size:
        return audio
    keep = int(0.04 * rate)
    return audio[max(0, loud[0] - keep): loud[-1] + keep + 1]


def main() -> None:
    spec = json.loads((HERE / "demo-narration.json").read_text())
    OUT.mkdir(parents=True, exist_ok=True)
    tts = load_tts()
    durations: dict[str, float] = {}
    for line in spec["lines"]:
        g = sherpa_onnx.GenerationConfig()
        g.sid = int(line.get("voice", spec["voice"]))
        g.speed = float(line.get("speed", spec["speed"]))
        # Offline, so take the slower, clearer setting; Hindi in particular is easier to follow at 12.
        g.num_steps = 12
        g.extra = {"lang": line.get("lang", spec["lang"])}
        audio = tts.generate(line["text"], g)
        samples = trim(np.asarray(audio.samples, dtype=np.float32), audio.sample_rate)
        sf.write(OUT / f"{line['id']}.wav", samples, audio.sample_rate)
        durations[line["id"]] = round(len(samples) / audio.sample_rate, 3)
        print(f"{line['id']:<11} {durations[line['id']]:5.2f} s  voice {g.sid} {g.extra['lang']}")
    (OUT / "durations.json").write_text(json.dumps(durations, indent=1))
    print(f"{sum(durations.values()):.0f} s of narration")


if __name__ == "__main__":
    main()
