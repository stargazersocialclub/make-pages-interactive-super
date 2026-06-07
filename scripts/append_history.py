#!/usr/bin/env python3
"""
Append a history batch to <dir>/feedback/history.json with auto-archival.

The agent calls this instead of writing inline JSON-manipulation heredocs each
batch. Two benefits: (1) one-line append in the agent's tool calls, and (2)
history.json stays bounded — older batches roll off into a JSONL archive so
the page's polling-transfer + agent's read/rewrite cost stay flat over time.

Usage:
    echo '<batch-json>' | python append_history.py <artifact_dir>
    python append_history.py <artifact_dir> --batch-file batch.json
    python append_history.py <artifact_dir> --keep 30 < batch.json

When live batch count exceeds --keep (default 30), the oldest overflow batches
are appended to <dir>/feedback/_archive/history-archive.jsonl (one batch per
line, append-only — O(1) growth). Live history.json keeps only the most recent
--keep batches.

Exit codes:
    0 — appended OK
    2 — bad input or missing dir
"""
import argparse
import json
import sys
from pathlib import Path


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("artifact_dir", help="The directory containing feedback/")
    ap.add_argument("--batch-file", help="Read batch JSON from this file instead of stdin")
    ap.add_argument("--keep", type=int, default=30,
                    help="Max batches to keep live in history.json (default 30)")
    args = ap.parse_args()

    art = Path(args.artifact_dir).resolve()
    feedback = art / "feedback"
    if not feedback.is_dir():
        sys.stderr.write(f"error: {feedback} does not exist\n")
        return 2

    history_path = feedback / "history.json"
    archive_dir = feedback / "_archive"
    archive_dir.mkdir(exist_ok=True)
    archive_path = archive_dir / "history-archive.jsonl"

    raw = Path(args.batch_file).read_text() if args.batch_file else sys.stdin.read()
    try:
        batch = json.loads(raw)
    except json.JSONDecodeError as e:
        sys.stderr.write(f"error: input is not valid JSON: {e}\n")
        return 2

    if history_path.exists():
        hist = json.loads(history_path.read_text() or "[]")
    else:
        hist = []
    is_list = isinstance(hist, list)
    batches = hist if is_list else hist.get("batches", [])

    batches.append(batch)

    archived = 0
    if len(batches) > args.keep:
        overflow = batches[: -args.keep]
        batches = batches[-args.keep:]
        with archive_path.open("a") as f:
            for b in overflow:
                f.write(json.dumps(b, ensure_ascii=False) + "\n")
        archived = len(overflow)

    out = batches if is_list else {"batches": batches}
    history_path.write_text(json.dumps(out, indent=2, ensure_ascii=False))

    msg = f"appended {batch.get('batch_id', '<no id>')} (live: {len(batches)}/{args.keep}"
    if archived:
        msg += f", archived {archived} oldest"
    msg += ")"
    print(msg)
    return 0


if __name__ == "__main__":
    sys.exit(main())
