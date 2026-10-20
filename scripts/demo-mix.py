"""Encodes the recorded demo frames and lays each narration line at its cue: ../demo/ChargeOne-demo.mp4 (phone
portrait, for Reels and Shorts). When demo-landscape.ts has rendered the stage, also writes
../demo/ChargeOne-demo-16x9.mp4 (1920x1080, for YouTube and the Play Store promo video).

Usage: python3 scripts/demo-mix.py   (after demo-voice.py, demo-video.ts and optionally demo-landscape.ts)
Fails when the picture stays still for MAX_STILL_S or longer. `--self-test` checks that gate.
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

DEMO = Path(__file__).resolve().parent.parent.parent / "demo"
RAW = DEMO / "raw"
OUT = DEMO / "ChargeOne-demo.mp4"
WIDE = DEMO / "ChargeOne-demo-16x9.mp4"
STAGE = RAW / "landscape"
# Frames are 824x1830; H.264 needs even dimensions, so pad to 1832.
VIDEO_FILTER = (
    "fps=30,scale=824:1832:force_original_aspect_ratio=decrease:flags=lanczos,"
    "pad=824:1832:0:0:color=0x05070b,format=yuv420p"
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
    problems = pace_problems(OUT)
    if problems:
        print("The video holds still too long:\n  " + "\n  ".join(problems))
        return 1
    if (STAGE / "stage.json").exists():
        landscape()
    return 0


# The picture must change at least every few seconds (owner's rule for every video): no still longer than this.
MAX_STILL_S = 5.0


def stills(path: Path, min_s: float = MAX_STILL_S) -> list[tuple[float, float]]:
    """(start, seconds) of every stretch of at least min_s where the picture does not change."""
    out = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostats", "-i", str(path), "-vf", f"freezedetect=n=0.002:d={min_s}", "-map", "0:v", "-f", "null", "-"],
        check=True, capture_output=True, text=True,
    ).stderr
    starts = [float(m) for m in re.findall(r"freeze_start: ([\d.]+)", out)]
    lengths = [float(m) for m in re.findall(r"freeze_duration: ([\d.]+)", out)]
    if len(lengths) < len(starts):
        lengths.append(seconds(path) - starts[-1])
    return list(zip(starts, lengths))


def pace_problems(path: Path) -> list[str]:
    return [f"{length:.1f} s still from {start:.1f} s" for start, length in stills(path)]


def self_test() -> int:
    """The gate catches a still picture and passes a moving one."""
    with tempfile.TemporaryDirectory() as tmp:
        still, moving = Path(tmp) / "still.mp4", Path(tmp) / "moving.mp4"
        for src, out in (("color=c=0x05070b:s=320x240:d=7", still), ("testsrc2=s=320x240:d=7", moving)):
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", src, "-pix_fmt", "yuv420p", str(out)], check=True)
        assert pace_problems(still), "a 7 s still picture passed the gate"
        assert not pace_problems(moving), f"a moving picture failed the gate: {pace_problems(moving)}"
    print("pace gate self-test passed")
    return 0


def seconds(path: Path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
        check=True, capture_output=True, text=True,
    )
    return float(out.stdout.strip())


def landscape() -> None:
    stage = json.loads((STAGE / "stage.json").read_text())
    screen = stage["screen"]
    total = seconds(OUT)
    timeline = stage["timeline"]
    lines = []
    for i, item in enumerate(timeline):
        end = timeline[i + 1]["from"] if i + 1 < len(timeline) else total
        lines += [f"file '{STAGE / item['file']}'", f"duration {max(0.04, end - item['from']):.3f}"]
    lines.append(f"file '{STAGE / timeline[-1]['file']}'")
    (STAGE / "stage.txt").write_text("\n".join(lines) + "\n")
    size = f"{screen['w']}:{screen['h']}"
    graph = ";".join([
        "[1:v]fps=30,format=rgba[bg]",
        f"[0:v]scale={size}:flags=lanczos,format=rgba[phone]",
        f"[2:v]scale={size},format=gray[mask]",
        "[phone][mask]alphamerge[screen]",
        f"[bg][screen]overlay={screen['x']}:{screen['y']}:shortest=1,format=yuv420p[v]",
    ])
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", str(OUT),
         "-f", "concat", "-safe", "0", "-i", str(STAGE / "stage.txt"),
         "-loop", "1", "-i", str(STAGE / "mask.png"),
         "-filter_complex", graph, "-map", "[v]", "-map", "0:a", "-t", f"{total:.3f}",
         "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-c:a", "copy",
         "-movflags", "+faststart", str(WIDE)],
        check=True,
    )
    print(f"Wrote {WIDE}")


if __name__ == "__main__":
    sys.exit(self_test() if "--self-test" in sys.argv else main())
