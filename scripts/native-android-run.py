"""Drives the Android emulator smoke run in CI (android.yml, job emulator-e2e).

Expects a booted emulator, `wrangler dev` listening on the host at :8787 and a debug APK built with
VITE_API_ORIGIN=http://localhost:8787. `adb reverse` makes that localhost reach the host, and localhost is a
secure context, so the session cookie works without https.

Usage: python3 scripts/native-android-run.py --apk app-debug.apk [--out native-artifacts]
"""

import argparse
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

PKG = "in.chargeone.app"
ACTIVITY = f"{PKG}/.MainActivity"
API_PORT = 8787
# screenrecord stops by itself at 180 s, so longer runs are recorded as numbered segments.
SEGMENT_SECONDS = 180
LOG_PATTERN = re.compile(r"Capacitor|chromium|cr_|WebView|Console|AndroidRuntime|FATAL|in\.chargeone", re.I)


def find_adb() -> str:
    found = shutil.which("adb")
    if found:
        return found
    for var in ("ANDROID_HOME", "ANDROID_SDK_ROOT"):
        candidate = Path(os.environ.get(var, "")) / "platform-tools" / "adb"
        if os.environ.get(var) and candidate.exists():
            return str(candidate)
    raise SystemExit("adb not found on PATH or in $ANDROID_HOME/platform-tools")


ADB = find_adb()


def adb(*args: str, check: bool = True, timeout: float = 120) -> subprocess.CompletedProcess:
    return subprocess.run([ADB, *args], check=check, timeout=timeout, capture_output=True)


def wait_for_api(timeout_s: float) -> None:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"http://localhost:{API_PORT}/api/health", timeout=5) as r:
                if r.status == 200:
                    print("API is up on the host")
                    return
        except OSError:
            pass
        time.sleep(2)
    raise SystemExit(f"API on :{API_PORT} did not answer /api/health within {timeout_s:.0f}s")


class ScreenRecorder:
    def __init__(self) -> None:
        self.stopping = threading.Event()
        self.segments: list[str] = []
        self.thread = threading.Thread(target=self._loop, daemon=True)

    def _loop(self) -> None:
        while not self.stopping.is_set():
            path = f"/sdcard/demo-{len(self.segments):02d}.mp4"
            self.segments.append(path)
            started = time.time()
            result = subprocess.run(
                [ADB, "shell", "screenrecord", "--bit-rate", "6000000", "--time-limit", str(SEGMENT_SECONDS), path],
                capture_output=True,
            )
            if not self.stopping.is_set() and time.time() - started < 5:
                print(f"screenrecord stopped early, no video: {result.stderr.decode('utf-8', 'replace').strip()}")
                return

    def start(self) -> None:
        self.thread.start()

    def stop(self) -> None:
        self.stopping.set()
        # SIGINT lets screenrecord finish writing the mp4 index; a killed recording is unplayable.
        adb("shell", "pkill", "-INT", "screenrecord", check=False)
        self.thread.join(timeout=30)
        time.sleep(2)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apk", required=True)
    parser.add_argument("--out", default="native-artifacts")
    args = parser.parse_args()

    out = Path(args.out)
    (out / "screenshots").mkdir(parents=True, exist_ok=True)
    (out / "video").mkdir(parents=True, exist_ok=True)

    adb("wait-for-device", timeout=300)
    wait_for_api(180)
    adb("reverse", f"tcp:{API_PORT}", f"tcp:{API_PORT}")
    # -g grants the runtime permissions up front so no system dialog covers the app during the smoke run.
    adb("install", "-r", "-g", args.apk, timeout=300)
    adb("logcat", "-c", check=False)

    recorder = ScreenRecorder()
    recorder.start()
    time.sleep(1)
    adb("shell", "am", "start", "-W", "-n", ACTIVITY)

    code = 1
    try:
        code = subprocess.run(["node", "scripts/native-e2e.ts"], env={**os.environ, "NATIVE_ARTIFACTS": str(out)}).returncode
    finally:
        recorder.stop()
        for seg in recorder.segments:
            adb("pull", seg, str(out / "video" / Path(seg).name), check=False, timeout=300)
        shot = adb("exec-out", "screencap", "-p", check=False)
        if shot.returncode == 0 and shot.stdout:
            (out / "screenshots" / "final-device.png").write_bytes(shot.stdout)
        log = adb("logcat", "-d", "-v", "time", check=False, timeout=120).stdout.decode("utf-8", "replace")
        (out / "logcat-full.txt").write_text(log)
        relevant = [line for line in log.splitlines() if LOG_PATTERN.search(line)]
        errors = [line for line in relevant if re.search(r"\s[EF]/|error|exception|fatal", line, re.I)]
        (out / "logcat-app.txt").write_text("\n".join(relevant) + "\n")
        (out / "logcat-errors.txt").write_text("\n".join(errors) + "\n")
        print(f"Saved {len(recorder.segments)} video segment(s), logcat ({len(errors)} error lines) to {out}/")

    return code


if __name__ == "__main__":
    sys.exit(main())
