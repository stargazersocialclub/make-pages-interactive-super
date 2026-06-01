# Changelog

All notable changes to this fork. Versions before v0.2.0 inherit from the upstream
[paraschopra/make-pages-interactive](https://github.com/paraschopra/make-pages-interactive).
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project uses [semantic versioning](https://semver.org/).

## [Unreleased]

Post-v0.2.0 stability + doc pass before the v0.3 viewport-switcher fork.

### Removed

- **Container resize (Shift + double-click)** — parked alongside the move
  feature for the v0.3 heavy fork. Same suspected pointer-event
  entanglement (the dblclick dispatch + corner-resize handle pointermove
  + element-select click could all fire on the same gesture). Surgery
  scope: `findContainerForResize`, `startContainerEdit`, the
  `e.shiftKey` branch in `onDblClick`, the `cf-container-edit-mode`
  body class + `.cf-editing-container` outline rule, the
  `cf-editing-container` class strip in `exitEditMode` and
  `cleanOuterHtml`, the SESSION_CLASSES entry in `getCleanPageHtml`,
  the quick-guide overlay's "container" line, and the Shift+dblclick
  mention in the pending hint and README. Plain double-click still
  resizes images / videos / canvases / pictures; element mode (E) +
  delete still covers structural removal.
- **Drag-and-drop reorder (move mode)** — entire feature parked for the
  v0.3 heavy fork. User reported a suspected pointer-event collision
  with the element selector and the inline-editor resize handles, and
  asked to set it aside until that interaction can be redesigned
  without sharing the document-level capture-phase listeners. Surgery
  scope: `M` keyboard shortcut, the `↕ move` toolbar button, every
  `move*` state var, `toggleMoveMode`, `onMovePointer*`,
  `startMoveDrag` / `updateMoveDrag` / `endMoveDrag` / `cancelMoveDrag`,
  `findDropIndex` / `positionDropIndicator`, `moveSiblingAnchor` /
  `moveLabel` / `autoCommentForMove`, `revertMoveAndReplay`, the `move`
  branches in `revertCommentVisual` / `clearAllRevertOne` / pending-list
  rendering / `getCommentTarget` / `CF_MARKER_GLYPH`, the
  `body.cf-move-mode` / `.cf-move-source` / `.cf-move-ghost` /
  `.cf-move-drop-indicator` CSS, the SKILL.md `move` comment-type entry
  and Handling section, README's "Drag and drop reorder" section, and
  every `M` mention in the quick-guide overlay and pending-tab hint.
  Element-mode (`E`) + delete still cover the structural-change
  use case for now.

### Added

- **🔍 Squarespace audit button** in the panel header. Runs five checks
  against the live page targeting the most common Code Injection
  conflicts:
  1. **Global CSS selectors** — `body`, `html`, `*` rules in any
     `<style>` block bleed into the Squarespace page wrapper.
  2. **Naked tag selectors** — `h1` / `h2` / `h3` / `p` / `a` /
     `button` / `input` / etc. without an ancestor scope collide with
     Squarespace's site typography.
  3. **Inline styles missing `!important`** for cascade-loser props
     (`color`, `font-family`, `background`, `background-color`) —
     Squarespace's stylesheet wins without it.
  4. **Footer collision** — `position: fixed` elements with `bottom`
     within 60 px of the viewport bottom (where the Squarespace footer
     / branding bar sits in many templates).
  5. **Viewport units** — `100vw` / `100vh` overflow the constrained
     Squarespace container.
  Findings open in a modal with severity color-coding (rose / gold /
  leaf), per-item checkboxes, and a snippet of the offending selector
  / element. Two critical decisions surface as form inputs at the top:
  the **root id** (auto-detected from the page, e.g.
  `ssc-pricing-root`) used to scope global + naked-tag rewrites, and
  the **footer lift offset** (default 80 px) applied to fixed elements.
  Apply queues each accepted fix as a `text-edit` in pending — they go
  through the standard submit / revert flow, so the user can roll back
  any individual fix via the marker menu or ⌘Z.
- **Line-height control** in toolbar row 2 (labeled `line`). Numeric
  input with step 0.05 from 0.8 to 3.0; emits a unitless line-height so
  children scale with their own font-size. populateTextStyleControls
  reads the current value by dividing computed line-height by computed
  font-size on edit start. Added to CF_LIST_PROPAGATE_PROPS so it pushes
  to every `<li>` when the editing target is a list, and to
  CF_RESET_PROPS so the Reset button clears it. Also added
  `background-color` to the list-propagation set (was missing — page
  CSS like `.list li { background: var(--card) }` would beat an
  inherited value the same way font-size does).
- **`⌘Z` / Ctrl+Z to undo the most recent pending entry**. Pops the last
  item off the pending list, reverts its visual change via the same
  per-type revert path as the marker-menu remove (text-edits restore
  outerHTML, deletes re-insert). Bails inside contenteditable
  (`editingEl === document.activeElement`) and inside any
  `isTypingTarget` so the browser's native character-level undo still
  runs during text editing. Toast shows the dropped type and the
  remaining pending count.
- **Copy page HTML button** in the panel header (📋 copy HTML). Clones
  the live `<html>`, strips everything the feedback library injected —
  `#claude-feedback-root`, the `/lib/feedback.{css,js}` link/script tags,
  the html2canvas script, every `cf-*` session class, every `data-cf-*`
  attribute, lingering `contenteditable` / `spellcheck` / empty
  `style=""` artifacts, and any `.cf-edit-marker` / `.cf-snapshot-rect`
  overlays — then writes the result to the clipboard (Clipboard API
  with an execCommand fallback for blocked-permission cases) prefixed
  with `<!DOCTYPE html>`. Toast confirms the character count.
  Replaces the stale header-hint strip (which had `M` listed and other
  rotted shortcuts).
- **Underline button** (toolbar row 1) — adjacent to bold / italic, wires
  `document.execCommand("underline")` and the native `⌘U` keystroke.
- **Element delete action** — new "🗑 delete" button in the element-mode
  popup. Removes each selected element from the DOM immediately (siblings
  reflow naturally; no slot preservation) and queues one `type: "delete"`
  comment per top-level removed element with `parent`, `index`, and full
  untruncated `original_outer_html`. Nested selections are deduped so a
  shift-selected parent + child only queues the parent. The in-list
  trashcan on a `delete` row restores the element AND drops the entry —
  delete has no on-element marker (the element is gone) so the trashcan
  is the only undo path. Other comment types keep their existing trashcan-
  drops-without-reverting behavior.
- **Inline editor link / unlink buttons** (toolbar row 1). Link prompts for a
  URL; protocol-less inputs auto-prefix `https://`; an empty URL removes the
  link; `javascript:` / `data:` / `vbscript:` / `file:` schemes are rejected.
  If the caret sits inside an existing `<a>`, the prompt prefills the
  current href.
- **Padding control** in toolbar row 3 — single-value numeric input applies
  to all four sides via the standard custom ▲/▼ spinner.
- **List-li text-style propagation** — when the editing target is a
  `<ul>`/`<ol>`, text-scoped props (font-family / font-size / color / font-
  weight / font-style / letter-spacing / line-height / text-transform /
  text-align) are pushed directly onto every child `<li>` so child-level
  CSS like `.incl li { font-size: 14px }` can't beat the change. Element-
  scoped props (border / radius / padding / background) stay on the list.
- **Toolbar row wrap** — `.cf-edit-toolbar-row` now `flex-wrap`s with a
  6 px row-gap so the wider row 1 (with link/unlink added) doesn't overflow
  on narrow viewports.

### Fixed

- **Resize on a flex / grid child redistributes space across siblings** —
  setting inline `width: Xpx` on an element inside a flex row / grid track
  forced the layout to reallocate the remaining space to siblings, so
  dragging one image's corner shrank the others and the resize hit an
  invisible wall when a sibling reached its min-content. On the first
  resize-drag of an edit session, every constrained-layout sibling now
  gets its current rect snapshot and pinned via `width` / `height` /
  `flex: 0 0 auto` so the target's resize feels independent. Submit
  captures the pinned siblings as separate text-edits so the asymmetric
  layout persists on reload; cancel restores siblings to their pre-pin
  state. The target's max size is bounded by container width − sum of
  pinned sibling widths (overflow is clipped by the parent) — when the
  user wants to push past that, they can pin a sibling smaller first.
- **Snapshot drag drifts on scroll** — snapshot rect corners are now stored
  in document coords instead of viewport coords, so the rect tracks the
  content the user pointed at even if the page scrolls mid-drag.
- **First dblclick of a session swallowed** — the OS-dblclick guard checked
  an uninitialized previous-click timestamp and tripped on the first edit
  attempt; now skipped until the guard has real data.
- **Border / radius spinners snap back to 0** — `populateStyleControls` was
  re-reading the rounded-down computed border width on every selection
  change. Split into text-scoped and element-scoped halves; border + radius
  only populate once at edit start (or on explicit reset).
- **Submit batch double-fires** — fast double-click + ⌘S could POST two
  identical batches. Submit is now guarded by an in-flight flag.
- **Stale Alt-latch lingers across mode switches** — toggling element / move
  / inline-edit while Alt was held could leave snapshot armed; mode entries
  now clear the snapshot Alt state.
- **Multi-move revert scrambles siblings** — removing one of several pending
  moves on the same parent now unwinds and replays the full stack rather
  than relying on text-snippet anchors.
- **Text-edit revert misses attribute drift** — contenteditable can mutate
  `class`, `align`, `dir`, etc. on the host element. Revert now clones the
  pre-edit `outer_html` so every attribute snaps back, not just `innerHTML`.
- **Auto-opening panel after every comment add** — violated the "submit
  flows should toast only" UX. Removed.
- **Duplicate `@keyframes cf-pulse`** — the second definition was silently
  shadowing the first, so `[data-cf-change].cf-change-active` was animating
  the wrong keyframes. Renamed the change-highlight one to
  `cf-change-pulse`.
- **Photo dblclick fell through to text editor** — `findImageAncestor` now
  descends into `<picture>` wrappers and detects background-image divs
  without text content.

### Changed

- **Pending-list inline styles migrated to dark-skin tokens** — light-mode
  literals (rust-orange `#b14000`, beige diff cards, white `#ddd` image
  borders) replaced with `.cf-pq-*` classes scoped under the dark palette.
  No light-mode color leaks remain in the JS templates.
- **Image-edit mode keeps border + radius controls visible** — only the
  font/color/bg row hides now, so you can still frame the image.

### Removed

- The unused `/mark-seen` server endpoint and its `lastseen.json` write —
  never read by the client or the agent.
- Dead duplicate `case "?":` branch in the keydown handler (the live `?`
  case above it was already wired to `toggleHelp()`).
- The unused `cf-marker-{type}` class additions on each pending marker
  (placeholder hooks with no CSS rule).
- Dead standalone `.cf-style-row` / `.cf-style-lbl` / `.cf-style-num` /
  `.cf-style-row select` / `.cf-style-row .cf-btn` CSS rules — all overridden
  by the toolbar-scoped versions.
- The dead `cf-auto-tour` `sessionStorage` writes left over from the
  pre-banner auto-tour flow.
- Stale code comments referencing the removed confirm dialog and border
  popover.

## [v0.2.0] — 2026-05-31

The "super fork" cut. Brings the skill from a plain text-commenting surface to
a full in-page editing / reordering / screenshotting workbench, plus a refreshed
opaque-dark gold-accent skin.

### Added

#### Inline text editing
- Double-click any text-bearing element (`<p>`, `<h1>`–`<h6>`, `<li>`, `<td>`,
  `<div>` text-leaf, etc.) to edit it in place. The element becomes
  `contenteditable` with a floating three-row toolbar.
- Toolbar row 1: Bold · Italic · UL · OL · ←/center/→ align · UPPER / lower /
  Title case · cancel · confirm (⌘↵).
- Toolbar row 2: font family (curated list + page-detected web fonts) · numeric
  font-size · color · bg · reset.
- Toolbar row 3: border weight · border color · border radius · `?` quick
  guide launcher. Border weight/radius are numeric inputs; weight + color
  compose into the `border` shorthand on the element.
- Number inputs (font-size, border weight, border radius) get custom ▲/▼
  spinner buttons that match the dark-gold skin — the native browser
  spinners are hidden because they don't take a stylesheet.
- Font picker is closed-set — a `<select>` grouped via `<optgroup>` into
  "On this page", "Sans-serif", "Serif", "Monospace". 12 web-safe families
  (System sans, Helvetica, Arial, Verdana, Tahoma, Trebuchet MS, Georgia,
  Times New Roman, Palatino, Garamond, Menlo / SF Mono, Courier New) plus
  whatever the host page loads. No free-form input.
- Picker reflects the *current* font of the editing element on open. Font /
  size / color / bg update as the selection moves across styled ranges;
  border + radius are element-scoped and populate once at edit start.
- ⌘B / ⌘I work inside the editable.
- Cancel restores the element via an `outerHTML` clone — class, style,
  alignment attributes, every attribute snaps back, not just `innerHTML`.

#### Inline editing — special cases
- Double-click an `<li>` selects its enclosing `<ul>` / `<ol>` as the editing
  target. Enter inside an existing `<li>` natively adds a new bullet.
- Double-click an `<img>` / `<video>` / `<canvas>` / `<svg>` / `<picture>` /
  `<iframe>` (or a background-image div without text content) opens a
  resize-only experience — no contenteditable, text-format controls hide,
  drag the corner handles. The border/radius row stays visible so you can
  still frame the image. `<picture>` wrappers descend to the inner `<img>`.
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
- New "move" mode: press `M` (or click the panel's "↕ move" button).
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
  (`font-size: 13px → 22px`, `+ <b>`, etc.). Colors come from the dark-skin
  palette (rose for removed, leaf-green for added) — no light-mode literals.
- `move` rows show element label + `parent#id: position 3 → 0`.
- `snapshot` rows show the thumbnail + "N elements in region" caption.
- New "clear all" ghost button next to submit. Disabled when nothing's
  pending, confirms before discarding.
- Snapshot thumbnails persist into the editor on re-edit via
  `editPendingComment`.

#### Per-element pending markers + marker action menu
- Every pending comment with a single-element target gets a gold ✎ marker
  pinned to its corner (✎ for text/style edits, 💬 for selection / element
  comments, ↕ for moves). Hover the marker to outline the target.
- Void elements that can't host children (`<img>`, `<video>`, `<canvas>`,
  `<iframe>`, `<input>`, etc.) get a *floating* marker pinned to `<body>`
  in document coords so it scrolls with the page.
- Click a marker to open a refine / remove menu.
- **Remove from the marker menu reverts the visual edit**: text edits replay
  the captured `original_outer_html`, moves unwind and replay the parent's
  full pending-move stack so siblings stay in the right order even when one
  of several stacked moves is removed.
- Remove from the in-list trashcan discards the pending entry without
  reverting the visual (use it when you want to keep the visual change but
  not track it).

#### Grid overlay + snap-to-grid
- Two new toggles in the panel: `⊞ show grid` (24 px gold-tinted overlay
  over the page; click-through), `🧲 snap to grid` (snap inline-editor
  resize handles to the nearest 24 px line, in addition to the existing
  edge-snap to sibling/parent/grandparent rects).
- Toggles persist (`localStorage["cf-grid-shown"]` /
  `localStorage["cf-grid-snap"]`).

#### Quick guide overlay
- New `?` modal: lists the quick-start path, the editing toolbar reference,
  the keyboard table, and launcher tips. Reachable from a panel-header `?`
  button, an inline-edit-toolbar `?` button, and the `?` keyboard shortcut.
- The overlay is the source of truth for shortcuts; the panel-header strip
  and pending-tab hint are abbreviated.

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
- `⌘S` → submit pending batch (intercepts the browser Save-Page shortcut)
- `?` → open the quick guide overlay

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
