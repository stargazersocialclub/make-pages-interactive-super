#!/usr/bin/env python3
"""
Trim <dir>/feedback/inbox.jsonl so the agent's reads stay cheap.

Inbox grows monotonically via the server's POST handler. The agent only ever
cares about the *unprocessed* tail — anything already referenced by a
history.json `in_response_to` is dead weight for future reads.

Usage:
    python trim_inbox.py <artifact_dir>
    python trim_inbox.py <artifact_dir> --keep 100
    python trim_inbox.py <artifact_dir> --dry-run

Strategy: keep the most recent --keep submissions live (default 50). Older
submissions move to <dir>/feedback/_archive/inbox-archive.jsonl (one
submission per line, append-only). A full backup of the pre-trim live file
is written to <dir>/feedback/_archive/inbox-prev-<ts>.jsonl on every run.

Safe to invoke periodically — pure file move + rewrite, no server coordination
needed (the server's inbox_lock only covers its own appends).
"""
import argparse
import json
import shutil
import sys
import time
from pathlib import Path


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("artifact_dir")
    ap.add_argument("--keep", type=int, default=50,
                    help="Max submissions to keep live in inbox.jsonl (default 50)")
    ap.add_argument("--dry-run", action="store_true",
                    help="Report counts without writing anything")
    args = ap.parse_args()

    feedback = Path(args.artifact_dir).resolve() / "feedback"
    inbox = feedback / "inbox.jsonl"
    if not inbox.exists():
        sys.stderr.write(f"error: {inbox} not found\n")
        return 2

    lines = [ln.rstrip("\n") for ln in inbox.read_text().splitlines() if ln.strip()]
    if len(lines) <= args.keep:
        print(f"inbox has {len(lines)} live submissions; below --keep {args.keep}, nothing to do")
        return 0

    keep_lines = lines[-args.keep:]
    archive_lines = lines[: -args.keep]

    if args.dry_run:
        print(f"dry-run: would archive {len(archive_lines)} of {len(lines)} submissions, keep {len(keep_lines)}")
        return 0

    archive_dir = feedback / "_archive"
    archive_dir.mkdir(exist_ok=True)

    # Append archived lines to the rolling archive
    archive_path = archive_dir / "inbox-archive.jsonl"
    with archive_path.open("a") as f:
        f.write("\n".join(archive_lines) + "\n")

    # Snapshot the pre-trim live file (point-in-time recovery)
    ts = int(time.time())
    shutil.copy(inbox, archive_dir / f"inbox-prev-{ts}.jsonl")

    # Rewrite live inbox
    inbox.write_text("\n".join(keep_lines) + "\n")

    print(f"trimmed inbox: {len(lines)} -> {len(keep_lines)} live, {len(archive_lines)} archived")
    return 0


if __name__ == "__main__":
    sys.exit(main())
