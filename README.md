# make-pages-interactive-super

A heavier fork of [paraschopra/make-pages-interactive](https://github.com/paraschopra/make-pages-interactive) — a Claude Code skill that turns any folder of static HTML pages into a **live commenting surface**.

Highlight text, click an element, double-click to edit in place, drag to reorder, snapshot a region, hit `Alt`+drag to capture a screenshot — every comment lands in a local JSONL inbox that Claude reads and responds to by editing the source pages. The page auto-reloads with a walkthrough of what changed.

This fork keeps the original 3-file shape (`feedback.js` / `feedback.css` / `server.py`) and adds inline text editing, structural drag-and-drop, region screenshots, a draggable corner-anchored launcher, an opaque-dark gold-accent skin, and a lot of editor polish. All commenting goes through the same inbox.

---

## What's new vs the original

### Inline text editing
- **Double-click any text-bearing element** (`<p>`, `<h1-h6>`, `<li>`, `<td>`, `<div>` text-leaf, etc.) to edit it in place. The element becomes `contenteditable` with a floating two-row toolbar.
- **Double-click any `<li>`** to edit the whole `<ul>`/`<ol>` — Enter inside an existing bullet natively adds a new one.
- **Double-click any `<img>`/`<video>`/`<canvas>`/`<svg>`/`<picture>`/`<iframe>`** to enter a resize-only experience (no contenteditable, drag the corner handles).
- **Cancel** restores the original `innerHTML` *and* the original `style` attribute (so font / color / width / margins / etc. all snap back).
- **Click outside** the editing element auto-submits the edit (or exits cleanly if no changes).
- **Double-click a different element** while one is open swaps the target — the current edit commits first.
- **Toolbar** (row 1): Bold · Italic · UL · OL · ←/center/→ align · UPPER / lower / Title case · cancel · confirm (⌘↵).
- **Toolbar** (row 2): font family (curated list + page-detected web fonts) · numeric font-size · color · bg · reset.
- **Selection-aware** — selecting text inside the editing element repopulates the font / size / color controls from the element under the caret.
- **⌘B / ⌘I** keep working inside the editable.
- **Corner-handle resize** (4 handles, TL/TR/BL/BR). Snaps the dragged edges to nearby element edges within ~8 px (siblings + parent + grandparent).
- **Style-only diff** — the pending row shows `font-size: 13px → 22px`, `+ <b>`, etc., even when text didn't change.

### Drag and drop reorder
- Press **`M`** (or the panel's "↕ move element" button) to enter move mode. Cursor turns to grab.
- Click and drag any element with siblings. A ghost clone follows the cursor; a gold horizontal indicator marks the insertion point between siblings of the original parent.
- Release queues a `type: "move"` comment with the element, its parent, and from/to anchor info (compact structural refs of the prev/next siblings).
- Auto-generated description: `moved "X" above "Y"` / `to top of list` / `to end of list`.
- **Re-dragging** an already-queued element refines the existing entry in place — keeps original `from`, updates `to`, reuses the comment id.
- **Esc** cancels an in-progress drag; another Esc exits move mode.
- Page click handlers are suppressed during move mode so a click-without-drag doesn't toggle anything.
- Opt-out: `data-cf-no-move` on an element, or `data-cf-no-move-children` on a parent (use for render-managed containers).

### Region screenshots
- Hold **`Alt`** — cursor turns to crosshair on the page (our UI keeps normal cursors).
- Drag a rectangle. On release: html2canvas captures the document region, POSTs the PNG to `/snapshot/<id>.png`, and opens a comment editor with the thumbnail inlined.
- Captured elements (up to 15 whose bounding rects intersect the region) are included as structural anchors alongside the pixels.
- **html2canvas is bundled locally** at `lib/html2canvas.min.js` (~200 KB) and lazy-loaded from `/lib/` on first snapshot. No CDN fetch at use time; works fully offline once the skill is installed.
- Server endpoint: `POST /snapshot/<id>.png` validates the filename, caps at 10 MB, writes to `feedback/snapshots/<id>.png` so the agent can `Read` it directly.

### Pending list & history
- Per-row diff rendering for `text-edit` (red strikethrough / green added), `style edit` (prop-by-prop diff like `font-size: 13px → 22px`), `move` (`parent#id: position 3 → 0`), and `snapshot` (thumbnail + element count).
- **`clear all`** ghost button next to submit — confirms, then discards everything pending.
- Snapshot thumbnails persist into the editor on re-edit via `editPendingComment`.

### Launcher pill (free drag + keyboard)
- Pill is **draggable**. Click-and-hold past a 6 px threshold starts a drag; release snaps to the nearest viewport corner. Click without drag still toggles the panel.
- **Shift+arrow** snaps the pill along that axis while preserving the perpendicular one. From bottom-left → Shift+→ → bottom-right → Shift+↑ → top-right, etc.
- Persisted to `localStorage["cf-pill-corner"]` as `"tl" | "tr" | "bl" | "br"`. Survives reloads.
- Panel anchors to the same corner automatically (opens 60 px in from the pill).

### Keyboard shortcuts
| Key | Action |
|---|---|
| `F` | Toggle the panel |
| `P` | Open Pending tab |
| `H` | Open History tab |
| `E` | Toggle element-select mode |
| `M` | Toggle move (drag-reorder) mode |
| `Alt` (held) + drag | Capture a region snapshot |
| `G` | New general comment |
| `C` | Smart comment trigger (selection > element > general) |
| `T` | Start the change walkthrough |
| `R` | Reload (when "changes ready" banner is shown) |
| `Shift + arrow` | Snap the launcher pill to that edge |
| `⌘B` / `⌘I` | Bold / italic inside the inline editor |
| `⌘↵` | Confirm inline edit |
| `⌘S` | Submit pending batch |
| `Esc` | Cancel current mode / close panel |

### UI direction
- **Opaque-dark gold-accent skin** across every surface (launcher pill, panel, tabs, pending items, toolbar, comment editor, toast, tour bar, "changes ready" banner, resize handles, snapshot rectangle).
- Side panel gets a **2 px gold border + layered halo + heavy drop-shadow** so it visibly separates from a busy host page underneath.
- Primary action (launcher pill, submit, confirm, "reload now") is a solid **gold gradient** with dark text.
- Active toggles use **gold-tint fill + gold border + gold text** (no flash fill).
- All text is full-opacity white; dimmer tiers reserved for inactive / resting / meta.
- All scoped under `#claude-feedback-root` so it won't bleed into host-page CSS.

### Stability / DX
- Stale-batch threshold bumped from 90 s → 5 min (most agent batches take 1–3 min in practice; the 90 s warning was firing during normal work).
- Auto-tour on reload removed (the highlight outline was easy to mistake for element-selection mode). The tour is still reachable via `T` or the panel button.
- Comment textarea is `resize: both`.
- Confirm dialog removed — edits land in pending immediately; the per-row "edit" button reopens the original element for refinement.
- Cancel restores `style.cssText` (full inline-style snapshot) — not just `innerHTML`.

---

## How it works

```
                  ┌──────────────────┐
   user highlights│   feedback.js    │   POST /feedback
   / clicks / ───▶ │  (in every page) │ ───────────────┐
   drags / Alt-   └──────────────────┘                 ▼
   drags / etc.                                ┌────────────────┐
                  ┌──────────────────┐  poll  │   server.py    │
   page reloads ◀─│   feedback.js    │ ◀───── │  (stdlib HTTP) │
   with walkthru  └──────────────────┘history │  /lib · /feedback │
                                              │  /mark-seen      │
                                              │  /snapshot/*.png │
                                              └───────┬────────┘
                                                      │ append
                                          ┌───────────▼────────────┐
                                          │  feedback/inbox.jsonl  │
                                          │  feedback/snapshots/*  │
                                          └───────────┬────────────┘
                                                      │ Monitor
                                                      ▼
                                          ┌────────────────────────┐
                                          │  Claude (the agent)    │
                                          │  edits HTML, appends   │
                                          │  feedback/history.json │
                                          └────────────────────────┘
```

The skill is still **just three files in `lib/`**, plus glue:

| File | Role |
|------|------|
| `lib/feedback.js` | Client library injected into every page. Selection, element + move + snapshot modes, inline text editing, draggable launcher pill, pending list, history walkthrough. |
| `lib/feedback.css` | Styles for the comment UI (scoped under `#claude-feedback-root`). |
| `lib/html2canvas.min.js` | Bundled html2canvas 1.4.1, lazy-loaded by `feedback.js` only when a snapshot is first taken. |
| `lib/server.py` | ~300-line stdlib-only HTTP server. Serves the page directory, accepts comment POSTs at `/feedback`, snapshot PNG uploads at `/snapshot/<id>.png`, and routes `/lib/*` to the skill's own `lib/` directory. Auto-shuts-down on parent death or 10 min idle. |

Plus:

| File | Role |
|------|------|
| `SKILL.md` | Agent-facing spec — what Claude Code reads to know when and how to invoke. |
| `scripts/inject.py` | Idempotent `<link>`/`<script>` injection (or `--remove`) in every `*.html` in a directory. |
| `scripts/update.py` | `git pull --ff-only` inside the skill directory. |

---

## Install

```bash
git clone https://github.com/stargazersocialclub/make-pages-interactive-super \
  ~/.claude/skills/make-pages-interactive
```

That's it. Claude Code auto-discovers any folder under `~/.claude/skills/` that contains a `SKILL.md`.

Updates:

```bash
python ~/.claude/skills/make-pages-interactive/scripts/update.py
```

Or just say "update the make-pages-interactive skill" in Claude Code.

---

## Usage

Inside any Claude Code session, say:

> "Make these pages interactive."

(or any of: "make this page interactive", "let me comment on this page", "add feedback to these pages")

Claude will:

1. Inject the feedback library tags into every `*.html` in the current directory.
2. Create `feedback/inbox.jsonl` and `feedback/history.json`.
3. Pick a free port (5050 by default, falls back if taken).
4. Start the server in the background.
5. Tell you the URL to open.
6. Start monitoring the inbox so any comment you leave gets picked up immediately.

Open the URL. Comment, edit, drag, snapshot. Claude edits the source HTML in response.

### Removing the feedback layer

To get a clean static copy back (no `/lib/` dependencies in the HTML):

```bash
python ~/.claude/skills/make-pages-interactive/scripts/inject.py ./your-dir --remove
```

Or say "remove the feedback layer from these pages."

The `feedback/` directory (inbox / history / snapshots) is left alone — delete it manually if you want a fully clean directory.

---

## Comment types

| Type | When emitted | Payload (notable fields) |
|---|---|---|
| `selection` | Highlight text, click "comment on selection" | `quote`, `anchor` (element info), `comment` |
| `elements` | Click "select element", click any block, then comment | `elements[]`, `comment` |
| `general` | "+ general" button or `G` shortcut | `comment` |
| `text-edit` | Double-click, edit, ⌘↵ or click-out | `elements[0]`, `original_text` / `new_text`, `original_html` / `new_html`, `original_outer_html` / `new_outer_html` |
| `move` | Drag-and-drop reorder in move mode | `element`, `parent`, `from { index, prev_anchor, next_anchor }`, `to { ... }`, auto-generated `comment` |
| `snapshot` | Alt-drag a region | `region { x, y, w, h, viewport_x, viewport_y }`, `image_path` (`feedback/snapshots/<id>.png`), `elements[]` (intersecting), `comment` |

All comments carry a stable `id` (and a stable `cf_id` selector for the targeted element) and a timestamp. The library batches client-side and submits as a single POST per `submit batch` action so Claude responds to a coherent set rather than firing on every keystroke.

---

## How the server shuts down

The server is designed to never leak — three ways it goes away:

1. **Parent-process death** *(automatic, ~5–10 s)*. The server records its parent PID at startup and polls every 5 s. When the parent dies (e.g., you close the Claude Code window that launched it), the kernel reparents the server to PID 1 — the watchdog notices and calls `os._exit(0)`. Skipped if the server was started detached at launch.

2. **Idle timeout** *(automatic, default 10 min)*. The page polls `/feedback/history.json` every ~4 s, so any open browser tab keeps the server alive. When no client requests have arrived for `--idle-timeout` seconds (default `600`), the server exits. Pass `--idle-timeout 0` to disable.

3. **Manual stop**. Either say "stop the feedback server" in your Claude Code session, or hit `Ctrl-C` in the terminal where the server is logging.

---

## When Claude responds

When you submit a batch:

1. A "processing…" banner appears at the top of the page.
2. Your tab title changes to `🔔 …` so you can see progress in a backgrounded tab.
3. Claude edits the relevant HTML and appends an entry to `feedback/history.json` mapping your comment ids → the changes made.
4. The page polls `history.json` every ~4 seconds, notices the new entry, and shows a "changes ready, press R to reload" banner top-center (replacing the auto-reload behavior in the original).
5. Press `R` (or click the banner's button) → page reloads, scroll position preserved. The tour is reachable via `T` or the panel button.

If 5 minutes pass and no entry appears in history.json, a stale-batch banner suggests how to engage an agent. The threshold used to be 90 s but real batches with 5+ comments routinely take 1–3 minutes.

---

## Repo layout

```
make-pages-interactive-super/
├── SKILL.md                 # Agent-facing skill spec
├── README.md                # This file
├── screenshot.png           # README screenshot
├── LICENSE
├── lib/
│   ├── feedback.js          # Client library
│   ├── feedback.css         # Styles
│   ├── html2canvas.min.js   # Bundled for offline snapshot capture
│   └── server.py            # stdlib-only HTTP server (+ /snapshot endpoint)
└── scripts/
    ├── inject.py            # Idempotent tag injection / removal
    └── update.py            # git pull --ff-only
```

---

## Acknowledgments

Forked from [paraschopra/make-pages-interactive](https://github.com/paraschopra/make-pages-interactive). Original architecture (3-file lib + inject script + Claude-Code skill plumbing) is intact; everything additive lives in the same files. Most of the new behavior in `feedback.js` is gated on mode toggles or specific user actions, so the original simple-comment workflow still works exactly the way it did.

`lib/html2canvas.min.js` is a vendored copy of [html2canvas 1.4.1](https://html2canvas.hertzen.com/) by Niklas von Hertzen (MIT). Used for region snapshot capture; lazy-loaded only when first needed.

---

## License

MIT. See [LICENSE](LICENSE).
