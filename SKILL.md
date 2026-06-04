---
name: make-pages-interactive
description: Turn a directory of static HTML pages into a live commenting surface. Injects a feedback library, starts a tiny server, and routes user comments into a JSONL inbox that the agent monitors and responds to by editing the pages. Trigger phrases — "make this page interactive", "make these pages interactive", "let me comment on this page", "add feedback to these pages".
---

# Make Pages Interactive

Turns any folder of HTML files into a place the user can leave inline comments on (text selections, element selections, page-level notes, inline text edits, drag-reorders, region snapshots). Comments POST to a local JSONL inbox; you (the agent) Monitor that inbox, edit the HTML in response, append to `feedback/history.json`, and the page shows a "changes ready" banner — the user presses `R` to reload and see a walkthrough of what changed.

## When to invoke

User says any of:
- "make this page interactive" / "make these pages interactive" → **Setup flow**
- "add feedback to this page" / "let me comment on this page" → **Setup flow**
- "set up feedback on <dir>" → **Setup flow**
- "stop the feedback server" / "kill the server" / "shut it down" → **Stop flow**
- "remove the feedback layer" / "make pages static again" → **Removal flow**
- "update the make-pages-interactive skill" → **Update flow**

## Setup flow (when user wants to make pages interactive)

1. **Identify the target directory.** Usually the user's current working directory or a folder they named. If ambiguous, ask.
2. **Inject the feedback tags** into every `*.html` in that directory:
   ```
   python ~/.claude/skills/make-pages-interactive/scripts/inject.py <dir>
   ```
   Add `--recursive` if the pages live in subfolders. The script is idempotent — safe to re-run. It also creates `<dir>/feedback/inbox.jsonl` and `<dir>/feedback/history.json` if missing.
3. **Pick a port.** Default 5050. Before starting, check what's there:
   ```
   curl -s --max-time 2 http://localhost:5050/info
   ```
   - JSON with `artifact_dir` matching this `<dir>` → reuse it, skip to step 5.
   - JSON with a *different* `artifact_dir` → port is held by another exploration. Either ask the user to free it (`lsof -ti:5050 | xargs kill`) or use port 5051, 5052, … (try the next port; tell the user the URL).
   - No response → port 5050 is free.
4. **Start the server in the background** via Bash with `run_in_background: true`:
   ```
   python ~/.claude/skills/make-pages-interactive/lib/server.py <dir> --port <chosen>
   ```
   The server auto-shuts-down on parent death or 10 min of idle, so you don't need to manage its lifecycle.
5. **Tell the user the URL.** For example: `http://localhost:5050/index.html` (use whatever filename they actually have — `index.html`, `report.html`, etc.). If they have multiple pages, list the top-level ones.
6. **Start a Monitor on the inbox** so new comments notify you immediately:
   ```
   Monitor on path: <dir>/feedback/inbox.jsonl
   ```
   Do NOT poll — let the Monitor notification arrive.

## Responding to a feedback batch

When a new batch arrives in `inbox.jsonl`:
- Read the entry. Each comment has a stable `cf_id` and a selector pointing to the exact element/text the user commented on.
- Edit the relevant HTML files to address each comment. Wrap each modified region with `<span data-cf-change="ch-<short-slug>">…</span>` (or add `data-cf-change` to an existing wrapping element) so the post-reload walkthrough can find the change. One anchor per change.
- **Append** a new batch object to the end of `<dir>/feedback/history.json` (newest = last; the library walks from the end to find the latest batch). Schema:
  ```json
  {
    "batch_id": "b-<timestamp-or-slug>",
    "timestamp": "<ISO 8601>",
    "comments": [ /* echo back the inbox comments you addressed */ ],
    "changes": [
      {
        "id": "ch-<slug>",
        "in_response_to": ["<cf_id from inbox>"],
        "anchor": "ch-<slug>",   // must match a data-cf-change in the HTML
        "title": "short, concrete",
        "description": "longer prose (hidden in UI, just for the record)"
      }
    ]
  }
  ```
- The page polls `history.json`, sees the new batch, and surfaces a "changes ready" banner at the top of the page (plus a 🔔 prefix in the tab title). The user presses `R` (or clicks the banner) to reload — scroll position is preserved, and the walkthrough is reachable via `T` or the panel button. The "processing…" banner clears automatically when any `in_response_to` matches a submitted comment id.

### Comment types

Each inbox comment carries a `type` field:

- **`selection`** — user highlighted a span of text. Payload: `quote` (the selected text), `anchor` (the enclosing element's info), `comment` (the user's note).
- **`elements`** — user clicked one or more elements in element-selection mode. Payload: `elements[]` (anchor info for each), `comment`.
- **`general`** — page-level comment not tied to a region. Payload: `comment` only.
- **`text-edit`** — user double-clicked an element and edited it inline (see below). Payload: `elements[]` (single-item; the edited element), `original_text` / `new_text` (innerText), `original_html` / `new_html` (innerHTML), `original_outer_html` / `new_outer_html` (outerHTML; needed for style-only edits since style attrs live on the element tag itself, not in innerHTML), optional `comment` (their note about the edit), and optional `dimensional_conflict` (only present when the user committed a resize drag that pushed the element past a parent constraint — see below). Special cases:
  - **Image edit**: the dblclick landed on an `<img>`/`<video>`/`<canvas>`/`<svg>`/`<picture>`/`<iframe>` — text won't change but `new_outer_html` will have new `width`/`height` (and possibly `margin-left`/`margin-top`) inline styles from the drag handles. Apply by updating the element's `style` attribute in source.
  - **List edit**: the dblclick landed inside a `<ul>`/`<ol>` — the editing target is the *list*, not a single `<li>`. Diff against `new_html` to see added / removed / reordered `<li>` items.
  - **Dimensional conflict**: when present, `dimensional_conflict` is `{ kind, source, constraint, constraint_value_px, actual_px, description }` — e.g. `{ kind: "parent-max-width", source: ".sec-head", constraint: "max-width", constraint_value_px: 620, actual_px: 877, description: "exceeds .sec-head max-width 620px" }`. The user saw a warning chip in the editor toolbar at commit time and chose to submit anyway, so they're consciously asking you to handle the conflict. Two common resolutions: (a) raise the constraint (e.g. add a `max-width: none` override on the parent and drop the inline width/height so the element scales responsively), or (b) commit the literal pixel dimensions and accept the overflow. Pick (a) by default for text containers, (b) for elements where the explicit size is the point. Note the choice in the history `description`. `kind` values: `parent-max-width`, `parent-overflow`, `track-overflow` (grid/flex), `viewport-overflow`.
- **`snapshot`** — user Alt-dragged a region. Payload: `region` ({ `x`, `y`, `w`, `h`, viewport coords too }), `image_path` (relative path like `feedback/snapshots/snap-<ts>-<rand>.png` — Read it with the Read tool to view), `elements[]` (up to 15 element anchors whose bounding rects intersect the captured region — structural context alongside the pixels), and the user's `comment`.
- **`delete`** — user clicked "delete" in the element-mode popup (or queued it via shift-multi-select). The element was already removed from the live DOM client-side; the agent's job is to mirror that removal in source. Payload: `element` (anchor info — `cf_id` / `selector` / `tag` / `text_snippet` / truncated `outer_html`), `parent` ({ `tag`, `id`, `selector` }), `index` (the element's position among its parent's children at the moment of deletion), `original_outer_html` (full untruncated outerHTML so the source-side removal can be a direct text match if `cf_id` is stale).

### Handling `text-edit` comments

The user has already made the edit they want — your job is to apply it to the file and let them see it stick. The visual change is showing in their browser until the page reloads.

1. Locate the element in the HTML using the anchor info (`elements[0].cf_id` / `selector` / `text_snippet`).
2. Apply the change. If only the visible text differs (most common case), do a straight text swap in the file: replace `original_text` with `new_text` in that element's content. If `new_html` differs from `original_html` in structure (the user added/removed `<b>`, `<i>`, `<br>` via the toolbar), use `new_html` as your reference for inner content. If `new_outer_html` differs from `original_outer_html` in attributes (the user used the toolbar to set font-family, font-size, color, background, border weight/color, or border-radius), update the element's `style="…"` attribute in the file to match `new_outer_html`. A single text-edit may involve text + HTML + style changes at once.
3. **Quietly fix obvious spelling AND grammar errors in `new_text` before writing it.** The user types in the browser without aggressive spell/grammar check and prefers these fixed silently rather than mirrored into the file. Fix: typos, missing/extra articles ("with restaurant" → "with a restaurant"), plural/tense agreement, terminal punctuation, missing possessive apostrophes, whitespace artifacts (`&nbsp;`, double spaces), Oxford commas in new 3+ item lists. Do NOT touch: wording, voice, register (incl. intentional informalisms like "fam"), em-dashes, sentence fragments used rhetorically, capitalization, or substantive copy. If unsure, leave it. Note any QC fixes in the history `description` so the diff is traceable.
4. Add a `data-cf-change="ch-<slug>"` anchor to the element (or a wrapper) just like any other change.
5. Record a history entry where the `title` summarizes the edit and the `description` notes both the old and new text (helps you reconstruct intent later if needed).

If the user added a note in `comment`, treat it as additional intent — they may want you to also adjust adjacent prose for consistency, fix Oxford commas in a list they just expanded, etc.

### Handling `delete` comments

The element is already gone from the live page — your job is to remove it from source so reloads stay consistent.

1. Locate the element in source HTML. Try in order: `element.cf_id` (`data-cf-id="el-N"` — usually a closing match against an in-document attribute), `element.selector`, then a direct text-match against `original_outer_html` (the full untruncated outerHTML — useful when `cf_id` was session-only and not persisted to source).
2. Remove the element. If it spans multiple lines in source, take the whole range.
3. Don't try to fill the gap — DOM reflow handles that on the browser side. If the deletion leaves a visibly broken layout (an empty grid column, a hanging `<hr>`, etc.) the user will surface that as a follow-up comment; don't pre-emptively rewrite siblings.
4. Add a `data-cf-change="ch-<slug>"` anchor on the **next sibling**, or on the **parent** if the deleted element was the last child. The walkthrough scrolls there so the user lands at the spot the deletion happened.
5. Record a history entry — `title` like `Deleted the <tag> "<short snippet>"`; `description` notes the parent + index so future-you can reconstruct intent.

If the user deleted multiple elements in one batch, each is a separate `delete` comment in the same submission. Apply them in document order; if any pair has a parent-child relationship (the user shift-selected nested elements), the child's deletion is a no-op once the parent is gone — skip it instead of erroring.

### Handling `snapshot` comments

The user wants to point at something visual.

1. Read the image with the `Read` tool — `feedback/snapshots/<filename>.png` (the `image_path` field). The PNG was captured by html2canvas in the user's browser.
2. The `elements[]` array lists the cf_ids / tags / text snippets that intersect the captured region — use it to narrow down which source elements the user is pointing at.
3. The `comment` field is the user's note. Combine the image, the elements list, and the comment to figure out what to change.
4. Record a history entry; reference the snapshot's image_path in the description so future-you knows what was shown.

## On startup in a directory that already has feedback

If you find `<dir>/feedback/inbox.jsonl` and `<dir>/feedback/history.json` and the skill has been invoked in this session:
1. Scan inbox for comment ids.
2. Scan history's `changes[*].in_response_to` union — those are already processed.
3. If unprocessed comments exist, tell the user the count and ask whether to process now.
4. Either way, set up the Monitor on the inbox.

## Stop flow (user wants to kill the server)

1. Identify the port. If you started the server in this session, you know it. Otherwise check `curl -s http://localhost:5050/info` (try 5051, 5052 if 5050 returns nothing or a different artifact).
2. Kill it: `lsof -ti:<port> | xargs kill` (use `kill -9` only if a plain kill doesn't free the port within a few seconds — the server traps SIGTERM and exits cleanly).
3. Confirm: `lsof -i :<port>` should be silent.
4. If you also started a `Monitor` on the inbox in this session, it will keep watching the file — that's fine, the file just won't get new entries.

Note: in most cases the user doesn't need to manually stop the server. It auto-shuts-down when (a) the parent process dies (e.g. they close the Claude Code window — within ~5–10 s) or (b) no client requests for 10 min. Manual stop is for the case where they want the port back *right now* in the same session.

## Update flow (user wants the latest lib/)

```
python ~/.claude/skills/make-pages-interactive/scripts/update.py
```
Runs `git pull --ff-only` inside the skill dir. Requires git-clone install (the script tells the user how to re-install if not).

## Removal flow (clean static copy)

If the user wants their HTML back to a clean, server-independent state:
```
python ~/.claude/skills/make-pages-interactive/scripts/inject.py <dir> --remove
```
Strips both tags from every `*.html`. Leaves the `feedback/` directory alone (delete manually if not wanted).

## Files in this skill

```
~/.claude/skills/make-pages-interactive/
├── SKILL.md                # this file (agent-facing)
├── README.md               # GitHub-facing docs (human readers)
├── CHANGELOG.md            # versioned change log (Keep a Changelog format)
├── LICENSE
├── screenshot.png          # README screenshot
├── docs/                   # design / scope notes (e.g. viewport-switcher v0.3)
├── lib/
│   ├── feedback.js         # client library: selection, element mode, snapshot
│   │                       # mode, inline editor (text + image), grid overlay
│   │                       # + snap-to-grid, draggable launcher, pending list
│   │                       # with per-element markers + marker menu,
│   │                       # quick-guide overlay, history walkthrough
│   ├── feedback.css        # styles (scoped under #claude-feedback-root)
│   ├── html2canvas.min.js  # vendored html2canvas 1.4.1, lazy-loaded on first
│   │                       # snapshot. Bundled so it works offline.
│   └── server.py           # stdlib-only HTTP server, also serves snapshot PNG
│                           # uploads at POST /snapshot/<id>.png
└── scripts/
    ├── inject.py           # idempotent tag injection / removal
    └── update.py           # git pull --ff-only
```

## Gotchas

- The injected `<link>` and `<script>` reference absolute paths `/lib/feedback.css` and `/lib/feedback.js`. These resolve through `server.py`, which routes `/lib/*` to the skill's own `lib/` directory. So pages only work when opened through this server — opening the HTML file directly in a browser will silently fail to load the feedback widget (the page itself still renders).
- `history.json` order matters: append (don't prepend). The library walks from the end to find the latest batch for the walkthrough.
- `anchor` values must match a `data-cf-change` attribute actually present in the HTML. Typos here cause "anchor not found" warnings post-reload.
- Snapshots are saved to `feedback/snapshots/<id>.png` by the server. The agent reads them via the `Read` tool on the relative path. `inbox.jsonl` carries the path, not the bytes — the file stays compact even with many snapshots.
- Host-page opt-out: any element marked with the `data-cf-ignore` attribute (or its descendants) is invisible to feedback handlers — no selection popup, no double-click-to-edit, no element-mode hover, no snapshot arming. Use this on host-side admin panels, modals, or custom editors that need to swallow their own input without triggering the feedback layer.
- Host-page queue API: `window.cfFeedback.queueComment(comment)` lets a host page push its own comment object into the pending queue instead of POSTing to `/feedback` directly. The comment shows up in the same panel the user already trusts to review + submit feedback; nothing ships until they hit submit. Use for host-side editors / admin panels (e.g. a gallery content manager). The `comment` must have a `type`; `id` and `created_at` auto-fill. Custom types (anything other than `selection`/`elements`/`general`/`text-edit`/`snapshot`/`delete`) render with a generic row in the pending list — add a branch in `renderPending()` to give them a nicer preview. The agent handles them the same way as built-in types: by branching on `type` in the inbox.
