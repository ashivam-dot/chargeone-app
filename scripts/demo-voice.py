"""Speaks every line of demo-narration.json with Kokoro-82M (Apache-2.0) into ../demo/raw/voice/.

Run with a Python that has kokoro and soundfile installed:
    <venv>/bin/python scripts/demo-voice.py
Each line may set its own "voice" and "lang" (Kokoro language code: "a" American English, "h" Hindi).
Writes <id>.wav per line and durations.json ({id: seconds}), which demo-video.ts uses to pace each scene.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import espeakng_loader
import numpy as np
import soundfile as sf

from kokoro import KPipeline  # noqa: E402
from phonemizer.backend.espeak.wrapper import EspeakWrapper  # noqa: E402

# espeak-ng (used for Hindi) silently ignores a data path over 160 characters and exits, so a deeply nested
# virtualenv needs ESPEAK_DATA_PATH set to a shorter link to espeakng_loader's data.
EspeakWrapper.set_data_path(os.environ.get("ESPEAK_DATA_PATH") or espeakng_loader.get_data_path())

HERE = Path(__file__).resolve().parent
OUT = HERE.parent.parent / "demo" / "raw" / "voice"
REPO = "hexgrad/Kokoro-82M"
RATE = 24000
FLOOR = 0.01


def trim(audio: np.ndarray) -> np.ndarray:
    loud = np.flatnonzero(np.abs(audio) > FLOOR * np.abs(audio).max(initial=0.0))
    if not loud.size:
        return audio
    keep = int(0.04 * RATE)
    return audio[max(0, loud[0] - keep): loud[-1] + keep + 1]


def main() -> None:
    spec = json.loads((HERE / "demo-narration.json").read_text())
    OUT.mkdir(parents=True, exist_ok=True)
    pipes: dict[str, KPipeline] = {}
    durations: dict[str, float] = {}
    for line in spec["lines"]:
        lang = line.get("lang", spec["lang"])
        voice = line.get("voice", spec["voice"])
        if lang not in pipes:
            pipes[lang] = KPipeline(lang_code=lang, repo_id=REPO)
        parts = [np.asarray(audio) for _, _, audio in pipes[lang](line["text"], voice=voice, speed=line.get("speed", spec["speed"]))]
        audio = trim(np.concatenate(parts))
        sf.write(OUT / f"{line['id']}.wav", audio, RATE)
        durations[line["id"]] = round(len(audio) / RATE, 3)
        print(f"{line['id']:<11} {durations[line['id']]:5.2f} s  {voice}")
    (OUT / "durations.json").write_text(json.dumps(durations, indent=1))
    print(f"{sum(durations.values()):.0f} s of narration")


if __name__ == "__main__":
    main()
