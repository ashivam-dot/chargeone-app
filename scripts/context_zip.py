"""Scans the chat transcripts for secret-looking strings (counts only), then builds the context zip."""
import re
import sys
import zipfile
from pathlib import Path

TASK = Path("/Users/ashivam/Desktop/Side-Income/ev-charging-super-app-plan-2026-10-20")
TRANSCRIPTS = Path("/Users/ashivam/.cursor/projects/Users-ashivam/agent-transcripts/6243cc47-7489-4c2c-a518-185c44ca802a")
OUT = TASK / "ChargeOne-context.zip"

PATTERNS = {
    "github token": r"\b(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{20,}",
    "openai-style key": r"\bsk-[A-Za-z0-9_-]{20,}",
    "razorpay key": r"\brzp_(?:live|test)_[A-Za-z0-9]{8,}",
    "aws key": r"\bAKIA[0-9A-Z]{16}\b",
    "jwt": r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}",
    "salesforce session": r"\b00D[A-Za-z0-9]{12,15}![A-Za-z0-9._]{20,}",
    "bearer header": r"Bearer [A-Za-z0-9._~+/-]{20,}",
    "private key": r"-----BEGIN [A-Z ]*PRIVATE KEY-----",
    "secret assignment": r"(?i)\b(?:SESSION_SECRET|RAZORPAY_KEY_SECRET|RAZORPAY_WEBHOOK_SECRET|OCM_API_KEY|ORS_API_KEY)\s*[=:]\s*['\"]?[A-Za-z0-9_\-]{16,}",
}


def files():
    main = TRANSCRIPTS / f"{TRANSCRIPTS.name}.jsonl"
    yield main, "transcripts/main.jsonl"
    for p in sorted((TRANSCRIPTS / "subagents").glob("*.jsonl")):
        yield p, f"transcripts/subagents/{p.name}"


def scan() -> int:
    hits = 0
    for path, _ in files():
        text = path.read_text(errors="replace")
        for name, pat in PATTERNS.items():
            n = len(re.findall(pat, text))
            if n:
                hits += n
                print(f"{path.name}: {n} x {name}")
    print("secret-looking matches:", hits)
    return hits


def build():
    extra = [
        (TASK / "chargeone-app/docs/PROJECT_CONTEXT.md", "PROJECT_CONTEXT.md"),
        (TASK / "PLAN.md", "PLAN.md"),
        (TASK / "ZERO-BUDGET-PLAN.md", "ZERO-BUDGET-PLAN.md"),
        (TASK / "chargeone-app/README.md", "README.md"),
    ]
    with zipfile.ZipFile(OUT, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for src, name in [*extra, *files()]:
            z.write(src, name)
    raw = sum(i.file_size for i in zipfile.ZipFile(OUT).infolist())
    print(f"{OUT.name}: {len(zipfile.ZipFile(OUT).namelist())} files, {raw / 1e6:.1f} MB -> {OUT.stat().st_size / 1e6:.2f} MB")
    print(zipfile.ZipFile(OUT).testzip() or "zip check ok")


def classify():
    """Says whether each secret-assignment value also appears in the repo (a test fixture), never the value."""
    import subprocess

    repo = TASK / "chargeone-app"
    tracked = subprocess.run(["git", "-C", str(repo), "ls-files"], capture_output=True, text=True).stdout.split()
    corpus = "\n".join((repo / f).read_text(errors="replace") for f in tracked if (repo / f).suffix in {".ts", ".py", ".md", ".jsonc", ".json", ".yml"} and (repo / f).stat().st_size < 2_000_000)
    pat = re.compile(r"(?i)\b(SESSION_SECRET|RAZORPAY_KEY_SECRET|RAZORPAY_WEBHOOK_SECRET|OCM_API_KEY|ORS_API_KEY)\s*[=:]\s*['\"]?([A-Za-z0-9_\-]{16,})")
    for path, _ in files():
        for m in pat.finditer(path.read_text(errors="replace")):
            value = m.group(2)
            kind = "fixture in repo" if value in corpus else ("placeholder-like" if re.search(r"(?i)test|local|dev|example|x{6,}|your", value) else "UNKNOWN")
            print(m.group(1), "->", kind, f"(length {len(value)})")


if __name__ == "__main__":
    if sys.argv[1:] == ["classify"]:
        classify()
    elif sys.argv[1:] == ["scan"]:
        scan()
    elif sys.argv[1:] == ["build"]:
        build()
