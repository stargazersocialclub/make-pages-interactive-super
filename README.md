# make-pages-interactive-super

A heavier fork of [paraschopra/make-pages-interactive](https://github.com/paraschopra/make-pages-interactive) — a Claude Code skill that turns any folder of static HTML pages into a **live commenting surface**.

Highlight text, click an element, double-click to edit in place, drag to reorder, hold `Alt` + drag to snapshot a region — every comment lands in a local JSONL inbox that Claude reads and responds to by editing the source pages. The page surfaces a "changes ready" banner; press `R` to reload and see a walkthrough of what changed.

This fork keeps the original 3-file shape (`feedback.js` / `feedback.css` / `server.py`) and adds inline text editing, region screenshots, a grid overlay + snap-to-grid, per-element pending markers with a refine/remove action menu, element-mode delete, a quick-guide overlay, a draggable corner-anchored launcher, an opaque-dark gold-accent skin, and a lot of editor polish. All commenting goes through the same inbox.

---

## What's new vs the original

### Inline text editing
- **Double-click any text-bearing element** (`<p>`, `<h1-h6>`, `<li>`, `<td>`, `<div>` text-leaf, etc.) to edit it in place. The element becomes `contenteditable` with a floating three-row toolbar.
- **Double-click any `<li>`** to edit the whole `<ul>`/`<ol>` — Enter inside an existing bullet natively adds a new one.
- **Double-click any `<img>`/`<video>`/`<canvas>`/`<svg>`/`<picture>`/`<iframe>`** (or any background-image div without text content) to enter a resize-only experience — text-format controls hide, drag the corner handles, but the border/radius row stays so you can still frame the image.
- **Cancel** restores the original element (full outer HTML — class, style, alignment attributes, everything snaps back).
- **Click outside** the editing element auto-submits the edit (or exits cleanly if no changes).
- **Double-click a different element** while one is open swaps the target — the current edit commits first.
- **Toolbar** (row 1): Bold · Italic · UL · OL · **link / unlink** · ←/center/→ align · UPPER / lower / Title case · cancel · confirm (⌘↵).
- **Toolbar** (row 2): font family (curated list + page-detected web fonts) · numeric font-size · color · bg · reset.
- **Toolbar** (row 3): border weight · border color · border radius · **padding** · `?` quick guide. Number inputs have custom ▲/▼ spinners that match the dark-gold skin.
- **Link** prompts for a URL — protocol-less inputs auto-prefix `https://`; an empty URL removes the link; `javascript:` / `data:` / `vbscript:` / `file:` schemes are rejected. If the caret sits inside an existing `<a>`, the prompt prefills the current href.
- **Selection-aware** — selecting text inside the editing element repopulates the font / size / color controls from the element under the caret. Border, radius, and padding are element-scoped and only populate at edit start.
- **List propagation** — when the editing target is a `<ul>` / `<ol>`, text props (font-family / size / color / weight / style / letter-spacing / line-height / text-transform / text-align) push directly to each `<li>` so child-level CSS like `.list li { font-size: 14px }` doesn't beat the change.
- **⌘B / ⌘I** keep working inside the editable.
- **Corner-handle resize** (4 handles, TL/TR/BL/BR). Snaps the dragged edges to nearby element edges within ~8 px (siblings + parent + grandparent). When **snap-to-grid** is on, snaps to the nearest 24 px grid line as well.
- **Style-only diff** — the pending row shows `font-size: 13px → 22px`, `+ <b>`, etc., even when text didn't change.

### Region screenshots
- Hold **`Alt`** — cursor turns to crosshair on the page (our UI keeps normal cursors).
- Drag a rectangle. On release: html2canvas captures the document region, POSTs the PNG to `/snapshot/<id>.png`, and opens a comment editor with the thumbnail inlined.
- Captured elements (up to 15 whose bounding rects intersect the region) are included as structural anchors alongside the pixels.
- **html2canvas is bundled locally** at `lib/html2canvas.min.js` (~200 KB) and lazy-loaded from `/lib/` on first snapshot. No CDN fetch at use time; works fully offline once the skill is installed.
- Server endpoint: `POST /snapshot/<id>.png` validates the filename, caps at 10 MB, writes to `feedback/snapshots/<id>.png` so the agent can `Read` it directly.

### Element delete
- Press **`E`** to enter element mode, click any block (or shift-click several), then hit the rose **🗑 delete** button in the popup. Each selected element is immediately removed from the live DOM — surrounding siblings reflow naturally; we don't try to preserve the slot.
- Nested selections are deduped: if you shift-selected a parent and its child, only the parent gets queued. The child would've disappeared with the parent anyway.
- Queues one `type: "delete"` comment per top-level removed element, carrying `parent`, `index`, and `original_outer_html` so the source-side removal can find the right span and the undo path can re-insert.
- **Undo**: the in-list trashcan on a `delete` row restores the element AND drops the entry. (For other types the trashcan only drops the entry; revert lives in the marker menu. Delete has no marker — the element is gone — so the trashcan does double duty.)
- Layout cascade (`:nth-child` rules, fixed grid columns) is whatever the host page's CSS already encodes; we don't try to fix it. If the deletion produces an obviously broken layout the user can comment again.

### Pending list & history
- Per-row diff rendering for `text-edit` (rose strikethrough / leaf-green added), `style edit` (prop-by-prop diff like `font-size: 13px → 22px`), and `snapshot` (thumbnail + element count). All in the dark-skin palette — no light-mode color leaks.
- **Per-element pending markers** — a gold ✎ badge floats on every element with a queued change (✎ for text/style edits, 💬 for selection/element comments). Hover the marker to outline its target. Click for a refine/remove menu. Void elements (`<img>`, `<video>`, etc.) get a floating marker pinned to the page in document coords so it scrolls with the content.
- **`remove` from the marker menu reverts the visual edit** — text edits restore the full original outer HTML.
- **`remove` from the in-list trashcan** discards the pending entry without reverting the visual (use it when the visual is already where you want it but you don't want it tracked).
- **`clear all`** ghost button next to submit — confirms, then discards everything pending.
- Snapshot thumbnails persist into the editor on re-edit via `editPendingComment`.

### Grid overlay + snap-to-grid
- Two toggles in the panel: **`⊞ show grid`** displays a 24 px gold-tinted grid overlay over the page (does not block clicks). **`🧲 snap to grid`** adds the nearest grid lines as snap candidates when you drag a resize handle.
- Toggles persist across reloads (`localStorage["cf-grid-shown"]` / `"cf-grid-snap"`).
- Snap is currently scoped to the inline-editor resize handles (it doesn't affect drag-reorder; the toolbar copy reads "snap resize to 24 px grid").

### Quick guide overlay
- Two launchers — **`?` in the panel header** and **`?` in the inline-edit toolbar** — plus the **`?` hotkey** open a modal that lists the quick-start path, the editing toolbar reference, the keyboard table, and launcher tips.
- The overlay is the source of truth for shortcuts; the panel header strip and the pending-tab hint are abbreviated.

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
| `Alt` (held) + drag | Capture a region snapshot |
| `G` | New general comment |
| `C` | Smart comment trigger (selection > element > general) |
| `T` | Start the change walkthrough |
| `R` | Reload (when "changes ready" banner is shown) |
| `Shift + arrow` | Snap the launcher pill to that edge |
| `⌘B` / `⌘I` | Bold / italic inside the inline editor |
| `⌘↵` | Confirm inline edit |
| `⌘S` | Submit pending batch |
| `?` | Open the quick guide overlay |
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
- Auto-reload on history change removed — replaced with a top-center "changes ready, press R" banner so users in another tab don't lose state to a surprise reload. Tab title gets a 🔔 prefix.
- Submit batch is guarded against double-fire (a fast double-click + ⌘S no longer produces two identical inbox entries).
- Comment textarea is `resize: both`.
- Confirm dialog removed — edits land in pending immediately; the per-row "edit" button reopens the original element for refinement.
- Cancel restores the element via `outerHTML` clone — class, style, alignment attributes, everything snaps back, not just `innerHTML`.

---

## How it works

```
                  ┌──────────────────┐
   user highlights│   feedback.js    │   POST /feedback
   / clicks / ───▶│  (in every page) │ ────────────────┐
   drags / Alt-   └──────────────────┘                 ▼
   drags / edits                              ┌────────────────────┐
                  ┌──────────────────┐  poll  │     server.py      │
   "changes      ◀│   feedback.js    │◀────── │   (stdlib HTTP)    │
    ready"       │                  │history │  /lib · /info      │
    banner       └──────────────────┘        │  /feedback         │
                                             │  /snapshot/*.png   │
                                             └─────────┬──────────┘
                                                       │ append
                                          ┌────────────▼───────────┐
                                          │  feedback/inbox.jsonl  │
                                          │  feedback/snapshots/*  │
                                          └────────────┬───────────┘
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
| `lib/feedback.js` | Client library injected into every page. Selection, element + snapshot modes, inline text editing (text + image), draggable launcher pill, pending list, history walkthrough. |
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
| `snapshot` | Alt-drag a region | `region { x, y, w, h, viewport_x, viewport_y }`, `image_path` (`feedback/snapshots/<id>.png`), `elements[]` (intersecting), `comment` |
| `delete` | "🗑 delete" in the element-mode popup | `element` (anchor), `parent { tag, id, selector }`, `index` (position in parent at deletion), `original_outer_html` (full untruncated) |

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
├── CHANGELOG.md             # Keep-a-Changelog versioned changes
├── screenshot.png           # README screenshot
├── docs/                    # Design / scope notes (e.g. viewport-switcher v0.3)
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
