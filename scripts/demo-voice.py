"""Speaks every line of demo-narration.json with Kokoro-82M (Apache-2.0) into ../demo/raw/voice/.

Run with a Python that has kokoro and soundfile installed:
    <venv>/bin/python scripts/demo-voice.py
Writes <id>.wav per line and durations.json ({id: seconds}), which demo-video.ts uses to pace each scene.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import soundfile as sf
from kokoro import KPipeline

HERE = Path(__file__).resolve().parent
OUT = HERE.parent.parent / "demo" / "raw" / "voice"
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
    pipe = KPipeline(lang_code="a", repo_id="hexgrad/Kokoro-82M")
    durations: dict[str, float] = {}
    for line in spec["lines"]:
        parts = [np.asarray(audio) for _, _, audio in pipe(line["text"], voice=spec["voice"], speed=spec["speed"])]
        audio = trim(np.concatenate(parts))
        sf.write(OUT / f"{line['id']}.wav", audio, RATE)
        durations[line["id"]] = round(len(audio) / RATE, 3)
        print(f"{line['id']:<11} {durations[line['id']]:5.2f} s")
    (OUT / "durations.json").write_text(json.dumps(durations, indent=1))
    print(f"{len(durations)} lines, {sum(durations.values()):.1f} s of speech")


if __name__ == "__main__":
    main()
