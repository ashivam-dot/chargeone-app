"""Boots an iPhone simulator, installs the unsigned simulator build and records it (ios.yml, macOS runner only).

Usage: python3 scripts/native-ios-run.py --app build/ios/Build/Products/Debug-iphonesimulator/App.app [--out native-artifacts]
"""

import argparse
import json
import signal
import subprocess
import sys
import time
from pathlib import Path

BUNDLE_ID = "in.chargeone.app"
RECORD_SECONDS = 20
# New Delhi, so the map opens over chargers instead of the simulator's default Cupertino.
LOCATION = "28.6139,77.2090"


def simctl(*args: str, check: bool = True, timeout: float = 300) -> subprocess.CompletedProcess:
    return subprocess.run(["xcrun", "simctl", *args], check=check, timeout=timeout, capture_output=True, text=True)


def pick_iphone() -> tuple[str, str]:
    """The newest available iOS runtime's first iPhone, as (udid, description)."""
    devices = json.loads(simctl("list", "devices", "available", "--json").stdout)["devices"]

    def runtime_version(key: str) -> tuple[int, ...]:
        tail = key.rsplit(".", 1)[-1]  # e.g. iOS-26-5
        return tuple(int(p) for p in tail.split("-")[1:] if p.isdigit())

    for runtime in sorted((k for k in devices if ".iOS-" in k), key=runtime_version, reverse=True):
        phones = [d for d in devices[runtime] if d["name"].startswith("iPhone")]
        if phones:
            phone = next((d for d in phones if d["name"].endswith("Pro")), phones[0])
            return phone["udid"], f'{phone["name"]} ({runtime.rsplit(".", 1)[-1]})'
    raise SystemExit("No available iPhone simulator found")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--app", required=True)
    parser.add_argument("--out", default="native-artifacts")
    args = parser.parse_args()

    out = Path(args.out)
    (out / "screenshots").mkdir(parents=True, exist_ok=True)
    (out / "video").mkdir(parents=True, exist_ok=True)

    udid, name = pick_iphone()
    print(f"Simulator: {name} {udid}")
    simctl("boot", udid, check=False)
    simctl("bootstatus", udid, "-b", timeout=600)
    simctl("status_bar", udid, "override", "--time", "9:41", "--batteryState", "charged", "--batteryLevel", "100", check=False)
    simctl("location", udid, "set", LOCATION, check=False)
    simctl("install", udid, args.app)
    simctl("privacy", udid, "grant", "location", BUNDLE_ID, check=False)

    video = out / "video" / "ios-demo.mp4"
    recorder = subprocess.Popen(
        ["xcrun", "simctl", "io", udid, "recordVideo", "--codec", "h264", "--force", str(video)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    time.sleep(2)
    launched = simctl("launch", udid, BUNDLE_ID, check=False)
    print(launched.stdout.strip() or launched.stderr.strip())

    started = time.time()
    for i, at in enumerate((6, 12, 18), start=1):
        time.sleep(max(0, at - (time.time() - started)))
        simctl("io", udid, "screenshot", str(out / "screenshots" / f"ios-{i:02d}.png"), check=False)
    time.sleep(max(0, RECORD_SECONDS - (time.time() - started)))

    # SIGINT makes recordVideo finalise the file; terminating it leaves a broken mp4.
    recorder.send_signal(signal.SIGINT)
    try:
        recorder.wait(timeout=30)
    except subprocess.TimeoutExpired:
        recorder.kill()

    running = simctl("spawn", udid, "launchctl", "list", check=False).stdout
    alive = BUNDLE_ID in running
    logs = simctl(
        "spawn", udid, "log", "show", "--last", "3m", "--style", "compact",
        "--predicate", 'process == "App" OR subsystem CONTAINS "capacitor"',
        check=False, timeout=180,
    )
    (out / "ios-app-log.txt").write_text(logs.stdout)
    print(f"App launched: {launched.returncode == 0}, still running: {alive}")
    return 0 if launched.returncode == 0 and alive else 1


if __name__ == "__main__":
    sys.exit(main())
