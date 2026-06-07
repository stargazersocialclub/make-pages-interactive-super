#!/usr/bin/env python3
"""
Delete PNGs in <dir>/feedback/snapshots/ that aren't referenced by the live
inbox or history files. Snapshots accumulate forever otherwise — the server
writes them on POST and nothing in the pipeline ever cleans up.

Usage:
    python trim_snapshots.py <artifact_dir>
    python trim_snapshots.py <artifact_dir> --dry-run
    python trim_snapshots.py <artifact_dir> --include-archived

A snapshot is "referenced" if its filename appears in:
  - <dir>/feedback/inbox.jsonl (any submission's `image_path`)
  - <dir>/feedback/history.json (raw text scan for `snap-…\.png`)
  - <dir>/feedback/_archive/inbox-archive.jsonl (only with --include-archived)

History/inbox files that have been trimmed already lose their references,
so any orphaned snapshots get cleaned up safely on subsequent runs. Use
--include-archived if you want to keep snapshots referenced by the full
historical archive (otherwise default scan covers only live files).

Exit codes:
    0 — done (no-op or trimmed)
    2 — bad input
"""
import argparse
import json
import re
import sys
from pathlib import Path


SNAP_NAME_RE = re.compile(r"snap-[A-Za-z0-9_-]+\.png")


def collect_inbox_refs(jsonl_path: Path) -> set[str]:
    refs: set[str] = set()
    if not jsonl_path.exists():
        return refs
    for line in jsonl_path.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            sub = json.loads(line)
        except json.JSONDecodeError:
            continue
        for c in sub.get("comments", []) or []:
            p = c.get("image_path")
            if p:
                refs.add(Path(p).name)
    return refs


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("artifact_dir")
    ap.add_argument("--dry-run", action="store_true",
                    help="Report what would be removed without deleting")
    ap.add_argument("--include-archived", action="store_true",
                    help="Also preserve snapshots referenced in _archive/inbox-archive.jsonl")
    args = ap.parse_args()

    feedback = Path(args.artifact_dir).resolve() / "feedback"
    snap_dir = feedback / "snapshots"
    if not snap_dir.is_dir():
        print(f"no snapshots dir at {snap_dir} — nothing to do")
        return 0

    referenced = collect_inbox_refs(feedback / "inbox.jsonl")

    history_path = feedback / "history.json"
    if history_path.exists():
        referenced.update(SNAP_NAME_RE.findall(history_path.read_text()))

    if args.include_archived:
        referenced.update(collect_inbox_refs(feedback / "_archive" / "inbox-archive.jsonl"))
        # also check the rolling history archive
        rolling = feedback / "_archive" / "history-archive.jsonl"
        if rolling.exists():
            referenced.update(SNAP_NAME_RE.findall(rolling.read_text()))

    all_pngs = sorted(snap_dir.glob("*.png"))
    drop = [p for p in all_pngs if p.name not in referenced]
    keep_count = len(all_pngs) - len(drop)

    if not drop:
        print(f"all {len(all_pngs)} snapshots referenced — nothing to trim")
        return 0

    total_bytes = sum(p.stat().st_size for p in drop)

    if args.dry_run:
        print(f"dry-run: would remove {len(drop)} of {len(all_pngs)} snapshots "
              f"({total_bytes / 1024:.0f} KB), keep {keep_count}")
        for p in drop[:5]:
            print(f"  {p.name}")
        if len(drop) > 5:
            print(f"  … and {len(drop) - 5} more")
        return 0

    for p in drop:
        p.unlink()
    print(f"removed {len(drop)} unreferenced snapshots "
          f"({total_bytes / 1024:.0f} KB) — {keep_count} kept")
    return 0


if __name__ == "__main__":
    sys.exit(main())
