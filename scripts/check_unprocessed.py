#!/usr/bin/env python3
"""
Report unprocessed inbox comments — comments not yet referenced by any history batch.

Checks BOTH the live feedback/history.json AND feedback/_archive/history-archive.jsonl
so the agent doesn't have to manually cross-reference them each session.

Usage:
    python check_unprocessed.py <artifact_dir>          # human-readable summary
    python check_unprocessed.py <artifact_dir> --json   # full JSON for programmatic use
    python check_unprocessed.py <artifact_dir> --ids    # just the unprocessed IDs, one per line

Exit codes:
    0 — nothing unprocessed
    1 — unprocessed comments found (details on stdout)
    2 — error (bad dir, missing inbox, etc.)
"""
import argparse
import json
import sys
from pathlib import Path


def load_processed_ids(feedback: Path) -> set:
    processed = set()

    def drain(batches):
        for b in batches:
            for change in b.get("changes", []):
                for cid in change.get("in_response_to", []):
                    processed.add(cid)

    history_path = feedback / "history.json"
    if history_path.exists():
        try:
            hist = json.loads(history_path.read_text() or "[]")
            drain(hist if isinstance(hist, list) else hist.get("batches", []))
        except json.JSONDecodeError:
            pass

    archive_path = feedback / "_archive" / "history-archive.jsonl"
    if archive_path.exists():
        for line in archive_path.read_text().splitlines():
            if not line.strip():
                continue
            try:
                drain([json.loads(line)])
            except json.JSONDecodeError:
                pass

    return processed


def load_inbox_batches(feedback: Path) -> list:
    batches = []
    inbox = feedback / "inbox.jsonl"
    if inbox.exists():
        for line in inbox.read_text().splitlines():
            if not line.strip():
                continue
            try:
                batches.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return batches


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("artifact_dir")
    ap.add_argument("--json", action="store_true", help="Output full JSON")
    ap.add_argument("--ids", action="store_true", help="Output only IDs, one per line")
    args = ap.parse_args()

    feedback = Path(args.artifact_dir).resolve() / "feedback"
    if not feedback.is_dir():
        sys.stderr.write(f"error: {feedback} does not exist\n")
        return 2

    processed = load_processed_ids(feedback)
    batches = load_inbox_batches(feedback)

    unprocessed = []
    for b in batches:
        vp = b.get("viewport", {})
        for c in b.get("comments", []):
            cid = c.get("id", "")
            if cid and cid not in processed:
                unprocessed.append({"batch_viewport": vp, **c})

    if not unprocessed:
        print("0 unprocessed comments")
        return 0

    if args.ids:
        for c in unprocessed:
            print(c["id"])
        return 1

    if args.json:
        print(json.dumps(unprocessed, indent=2, ensure_ascii=False))
        return 1

    # Human-readable summary
    print(f"{len(unprocessed)} unprocessed comment(s):\n")
    for c in unprocessed:
        vp = c.get("batch_viewport", {})
        vp_str = f"{vp.get('width','?')}x{vp.get('height','?')}" if vp else "?"
        ctype = c.get("type", "?")
        comment = c.get("comment", "").strip()
        els = c.get("elements", [])
        el_str = ""
        if els:
            el = els[0]
            snippet = el.get("text_snippet", "")[:50]
            el_str = f" | {el.get('tag')} {el.get('cf_id')} \"{snippet}\""
        snap = f" | snapshot:{c['image_path']}" if c.get("image_path") else ""
        print(f"  {c['id']}  [{ctype}] vp={vp_str}")
        if comment:
            print(f"    → {comment}")
        if el_str:
            print(f"    {el_str.strip()}")
        if snap:
            print(f"    {snap.strip()}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
