"""Encodes the recorded demo frames and lays each narration line at its cue: ../demo/ChargeOne-demo.mp4.

Usage: python3 scripts/demo-mix.py   (after demo-voice.py and demo-video.ts)
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

DEMO = Path(__file__).resolve().parent.parent.parent / "demo"
RAW = DEMO / "raw"
OUT = DEMO / "ChargeOne-demo.mp4"
# Frames are 824x1830; H.264 needs even dimensions, so pad to 1832.
VIDEO_FILTER = (
    "fps=30,scale=824:1832:force_original_aspect_ratio=decrease:flags=lanczos,"
    "pad=824:1832:0:0:color=0x0f172a,format=yuv420p"
)


def main() -> int:
    cues = json.loads((RAW / "cues.json").read_text())
    durations = json.loads((RAW / "voice" / "durations.json").read_text())

    overlaps = [
        f"{a['id']} runs {a['at'] + durations[a['id']] - b['at']:.2f} s into {b['id']}"
        for a, b in zip(cues, cues[1:])
        if a["at"] + durations[a["id"]] > b["at"] + 0.01
    ]
    if overlaps:
        print("Narration overlaps:\n  " + "\n  ".join(overlaps))
        return 1

    args = ["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", str(RAW / "frames.txt")]
    chains, labels = [], []
    for i, cue in enumerate(cues, start=1):
        args += ["-i", str(RAW / "voice" / f"{cue['id']}.wav")]
        ms = max(0, round(cue["at"] * 1000))
        chains.append(f"[{i}:a]aresample=48000,adelay={ms}:all=1[a{i}]")
        labels.append(f"[a{i}]")
    mix = f"{''.join(labels)}amix=inputs={len(labels)}:normalize=0:dropout_transition=0,loudnorm=I=-16:TP=-1.5:LRA=11,apad[aout]"
    args += [
        "-filter_complex", ";".join([*chains, mix, f"[0:v]{VIDEO_FILTER}[vout]"]),
        "-map", "[vout]", "-map", "[aout]", "-shortest",
        "-c:v", "libx264", "-preset", "slow", "-crf", "18",
        "-c:a", "aac", "-b:a", "160k", "-ar", "48000",
        "-movflags", "+faststart", str(OUT),
    ]
    subprocess.run(args, check=True)
    speech = sum(durations[c["id"]] for c in cues)
    print(f"Wrote {OUT} with {len(cues)} narration lines ({speech:.0f} s of speech)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
