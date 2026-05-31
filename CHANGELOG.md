# Changelog

All notable changes to this fork. Versions before v0.2.0 inherit from the upstream
[paraschopra/make-pages-interactive](https://github.com/paraschopra/make-pages-interactive).
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project uses [semantic versioning](https://semver.org/).

## [v0.2.0] — 2026-05-31

The "super fork" cut. Brings the skill from a plain text-commenting surface to
a full in-page editing / reordering / screenshotting workbench, plus a refreshed
opaque-dark gold-accent skin.

### Added

#### Inline text editing
- Double-click any text-bearing element (`<p>`, `<h1>`–`<h6>`, `<li>`, `<td>`,
  `<div>` text-leaf, etc.) to edit it in place. The element becomes
  `contenteditable` with a floating two-row toolbar.
- Toolbar row 1: Bold · Italic · UL · OL · ←/center/→ align · UPPER / lower /
  Title case · cancel · confirm (⌘↵).
- Toolbar row 2: font family (curated list + page-detected web fonts) · numeric
  font-size · color · bg · reset.
- Font picker is closed-set — a `<select>` grouped via `<optgroup>` into
  "On this page", "Sans-serif", "Serif", "Monospace". 12 web-safe families
  (System sans, Helvetica, Arial, Verdana, Tahoma, Trebuchet MS, Georgia,
  Times New Roman, Palatino, Garamond, Menlo / SF Mono, Courier New) plus
  whatever the host page loads. No free-form input.
- Picker reflects the *current* font of the editing element on open, and
  updates as the selection moves to a styled span inside the element.
- ⌘B / ⌘I work inside the editable.
- Cancel restores both `innerHTML` *and* the original `style` attribute
  (full `style.cssText` snapshot), so font / color / width / margins / etc.
  all snap back cleanly.

#### Inline editing — special cases
- Double-click an `<li>` selects its enclosing `<ul>` / `<ol>` as the editing
  target. Enter inside an existing `<li>` natively adds a new bullet.
- Double-click an `<img>` / `<video>` / `<canvas>` / `<svg>` / `<picture>` /
  `<iframe>` opens a resize-only experience — no contenteditable, text-format
  controls hide, drag the corner handles.
- Double-clicking a *different* element while one is already being edited now
  commits the active edit (auto-submit if changes; clean exit otherwise) then
  opens the new target.
- Clicking outside the editing element commits-or-exits the same way.

#### All-corner resize handle
- Four corner handles (TL / TR / BL / BR) replace the single bottom-right
  handle. Each has the appropriate diagonal cursor (`nwse-resize` /
  `nesw-resize`).
- Per-corner math: right-side handles map +dx → grow width, left-side map +dx
  → shrink width. Same for top/bottom on dy. TL/TR/BL handles shift
  `margin-left`/`margin-top` (with `!important`) so the opposite corner stays
  glued visually — BR retains the original behavior.
- Snap-to-edges (~8 px) on every corner. Candidate edges come from siblings +
  parent + grandparent. BR snaps right + bottom, TR snaps right + top,
  BL snaps left + bottom, TL snaps left + top.

#### Drag-and-drop reorder
- New "move" mode: press `M` (or click the panel's "↕ move element" button).
  Mutually exclusive with element-select and inline-edit modes.
- Click + drag any element with siblings. A ghost clone follows the cursor;
  a gold horizontal indicator marks the insertion point.
- Release queues a `type: "move"` comment with `element`, `parent`, and
  `from` / `to` `{ index, prev_anchor, next_anchor }` structural anchors.
- Auto-generated description: `moved "X" above "Y"` / `to top of list` /
  `to end of list`.
- Re-dragging an already-queued element refines the existing entry in place
  (matches text-edit refinement).
- `Esc` cancels an in-progress drag; another `Esc` exits move mode.
- Page click handlers are suppressed during move mode.
- Per-element opt-outs: `data-cf-no-move` on an element, or
  `data-cf-no-move-children` on a parent (for render-managed containers).

#### Region snapshot
- Hold `Alt` — cursor turns to crosshair on the page (UI keeps normal cursors).
- Drag a rectangle. On release, html2canvas captures the document region,
  POSTs the PNG to `/snapshot/<id>.png`, and opens a comment editor with the
  thumbnail inlined.
- Captured elements (up to 15) whose bounding rects intersect the region are
  included as structural anchors alongside the pixels.
- html2canvas 1.4.1 is bundled at `lib/html2canvas.min.js` (~200 KB) and
  lazy-loaded from `/lib/` only on first snapshot — works fully offline.
- Server endpoint `POST /snapshot/<id>.png` validates the filename, caps the
  upload at 10 MB, and writes to `feedback/snapshots/<id>.png` so the agent
  can `Read` it directly.

#### Draggable launcher pill
- Pill is now free-draggable. Click-and-hold past a 6 px threshold starts a
  drag; release snaps to the nearest viewport corner. A pure click still
  toggles the panel.
- `Shift + arrow` snaps the pill along the chosen axis while preserving the
  perpendicular one (from bottom-left → `Shift + →` → bottom-right →
  `Shift + ↑` → top-right).
- Corner persisted to `localStorage["cf-pill-corner"]` as
  `"tl" | "tr" | "bl" | "br"`. Panel anchors automatically to the same corner.

#### Pending list polish
- `text-edit` rows show before/after blocks; `style edit` variant for edits
  with no text change — diff renders prop-by-prop
  (`font-size: 13px → 22px`, `+ <b>`, etc.).
- `move` rows show element label + `parent#id: position 3 → 0`.
- `snapshot` rows show the thumbnail + "N elements in region" caption.
- New "clear all" ghost button next to submit. Disabled when nothing's
  pending, confirms before discarding.
- Snapshot thumbnails persist into the editor on re-edit via
  `editPendingComment`.

#### Comment types (new)
- `move` — drag-and-drop reorder. Payload: `element`, `parent`,
  `from { index, prev_anchor, next_anchor }`, `to { … }`, auto comment.
- `snapshot` — Alt-drag region. Payload: `region`, `image_path`
  (`feedback/snapshots/<id>.png`), `elements[]` (intersecting), `comment`.

#### Keyboard shortcuts (additions)
- `M` toggle move mode
- `Alt` (held) + drag → region snapshot
- `Shift + arrow` → snap launcher pill to that edge
- `⌘B` / `⌘I` → bold / italic inside the inline editor
- `⌘↵` → confirm inline edit

### Changed

- **Skin**: opaque dark with gold accents (no more translucency). Surfaces
  use a slight tonal hierarchy — toolbar `#161618`, editor `#1A1A1D`, panel
  `#1E1E22`. Side panel gets a 2 px gold border + layered halo + heavy
  drop-shadow so it visibly sits over the host page. Launcher pill flipped
  to a solid gold gradient with dark text; active toggles use gold-tint
  fill + gold border + gold text.
- **Primary text** raised to pure white (`#fff`). Dimmer tiers
  (`--cf-text-2`, `--cf-text-3`) are reserved for inactive / resting / meta.
- **Stale-batch threshold** bumped from 90 s → 5 min. Real agent batches with
  5+ comments routinely take 1–3 minutes; the 90 s warning was firing during
  normal work.
- **Auto-tour on reload removed**. The orange highlight outline was easy to
  mistake for element-selection. Tour is still reachable via `T` or the
  panel button.
- **Cancel** in the inline editor now restores `style.cssText`, not just
  `innerHTML` — fixes overrides (font-size, color, width, height, margin)
  getting stuck after a cancel.
- **Comment textarea** is `resize: both`.
- **Confirm dialog** removed — edits land in pending immediately. The
  per-row "edit" button reopens the original element for refinement.
- **Pricing-page click restriction** (for the example app): card toggle
  restricted to checkbox + h4 clicks, with matching cursor behavior.

### Removed

- The previous border / radius style panel and its `<b>`-popover edge-detection
  trigger. Replaced by direct toolbar controls + the resize handles.

## [v0.1.x] — pre-fork

Initial fork of [paraschopra/make-pages-interactive](https://github.com/paraschopra/make-pages-interactive)
with light additions and a screenshot. See the upstream README for the
original feature set.
