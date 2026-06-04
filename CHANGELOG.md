# Changelog

All notable changes to this fork. Versions before v0.2.0 inherit from the upstream
[paraschopra/make-pages-interactive](https://github.com/paraschopra/make-pages-interactive).
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project uses [semantic versioning](https://semver.org/).

## [Unreleased]

Holding ground for the next batch.

## [v0.3.1] — 2026-06-04

Docs-only patch. Lifts three agent-behavior rules from personal session notes
into SKILL.md so any agent invoking the skill picks them up on first read.

### Added

- **"Two cross-cutting rules — non-negotiable" block** in the "Responding to
  a feedback batch" section: (1) **No second-guessing user input** — apply
  every commit verbatim; byte-identical `original_outer_html === new_outer_html`
  is the only no-op; dimensional-pin patterns called out as a previously-bitten
  heuristic to avoid; the typo-QC carve-out preserved as the one user-approved
  silent fix. (2) **Sibling-group dimensions propagate** — a dimensional
  commit on one `.fc` / `.pcard` / `.step` / `.ccard` / `<li>` sibling
  propagates to all matching slots in the group; non-dimensional edits (text,
  color, URL) stay single-element; ambiguous grouping → use the agent-prompt
  card to confirm. Both rules came from user feedback after sessions where
  the agent filtered submissions and the user had to manually re-instruct.
- **Plain-language phrasing rules** in the "Asking the user mid-session"
  section: prompt text and option labels must read as plain language for a
  designer / business owner, not a developer — no `cf_id` / `el-N`,
  no CSS terms (`px`, `!important`, `flex-shrink`), no editor jargon (`pin`,
  `backfill`, `dimensional`); refer to elements by what the user sees,
  describe outcomes not operations, target ≤ 25 words on the prompt and
  ≤ 6 per option label. Includes a before/after rewrite example.

## [v0.3.0] — 2026-06-04

Adds an in-tool way for the agent to ask the user a question mid-session — no
more bouncing back to Claude Code to answer a clarifying prompt. Plus a
selection-aware color fix in the inline editor, a panning + zoom layer on top
of the image-edit experience, a broader commentable-class net for nested card
regions, and a stability pass on the polling + concurrency paths driven by an
audit of the live module.

### Added

- **Agent-prompt card.** New `feedback/prompts.jsonl` channel: the agent
  appends a JSON line with prompt text, optional quick-reply options, and an
  optional `in_response_to` link. The client polls the file alongside
  `history.json`, surfaces the newest unanswered prompt in a top-center card
  (`cf-agent-prompt`), and posts the reply through the existing `/feedback`
  endpoint as `type: "agent-response"` so the agent's Monitor catches it like
  any other comment. Quick-reply options render as buttons that submit
  instantly; absent options the card shows a freeform textarea with ⌘↵ to
  send and Esc to dismiss. Answered prompt ids persist in localStorage so a
  page reload doesn't re-show resolved questions. `inject.py` now pre-creates
  `prompts.jsonl` next to the existing `inbox.jsonl` / `history.json` to
  avoid 404 spam on every poll tick. Schema documented in SKILL.md under
  "Asking the user mid-session."
- **Image-edit pan via `object-position`.** During image-edit mode, plain
  arrow keys now pan the photo content within its frame (Photoshop-style:
  arrow direction = where the image shifts; ↑ shifts up, exposing the
  bottom). Stored as `object-position: calc(50% ± Xpx) calc(50% ± Ypx)` so
  nudges accumulate predictably regardless of natural image dimensions.
  `object-fit: cover` is auto-applied on first pan so the overflow can be
  clipped. Shift + arrow falls back to the prior element-nudge (margin-based
  layout shift). +/- (or = unshifted) zoom in / out via `transform: scale`,
  clamped to [0.5x, 5x]; at exactly 1x the transform is removed so the
  source stays clean.
- **`window.cfFeedback.queueComment(comment)`** — host-page queue API.
  Lets a host page push its own comment object into the pending list instead
  of POSTing to `/feedback` directly; the comment shows up in the same panel
  the user already trusts to review + submit feedback, and nothing ships
  until they hit submit. Useful for host-side editors / admin panels (e.g.
  a gallery content manager). The `comment` must have a `type`; `id` and
  `created_at` auto-fill. Custom types render with a generic row in the
  pending list — add a branch in `renderPending()` for a nicer preview.
- **`data-cf-ignore` host-page opt-out.** Any element marked with the
  attribute (or its descendants) is invisible to feedback handlers — no
  selection popup, no double-click-to-edit, no element-mode hover, no
  snapshot arming. Use on host-side admin panels, modals, or custom editors
  that need to swallow their own input without triggering the feedback
  layer.
- **`dimensional_conflict` on text-edit commits.** When the user commits a
  resize drag that pushes the element past a parent constraint (e.g. a
  text container's `max-width`), the comment carries a structured
  `dimensional_conflict` field with `kind` / `source` / `constraint` /
  `constraint_value_px` / `actual_px` / `description`. The user saw a
  warning chip in the editor toolbar at commit time and chose to submit
  anyway, so this is an explicit ask for resolution. Documented decision
  guidance in SKILL.md: default to raising the constraint for text
  containers; pin literal pixels for elements where the explicit size is
  the point.

### Changed

- **`applyInlineStyle` is now selection-aware.** Picking a color (or
  background-color / font-family / font-size / line-height) with a
  non-collapsed text selection inside the editing element now scopes the
  style to the selection instead of writing it on the whole element. Colors
  route through `document.execCommand("foreColor" / "hiliteColor")`; other
  text props wrap the selected range in a `<span style="prop:value">` via
  `range.surroundContents`. Falls back to the element-level apply if the
  range crosses element boundaries (`surroundContents` throws). Fixes the
  long-standing bug where colouring the selected word `florals` re-coloured
  the un-spanned `Exquisite` and `&` around it instead.
- **`editPendingComment` routes image-shaped pending edits back through
  `startImageEdit`.** Previously, double-clicking an image with a queued
  edit re-opened the text editor (because `editPendingComment`
  unconditionally called `startTextEdit`); now it checks
  `IMAGE_EDITABLE_TAGS.has(target.tagName)` and dispatches accordingly,
  preserving the cumulative `original_outer_html` for diff continuity.
- **`COMMENTABLE_CLASS_SUBSTRINGS` expanded.** Added `aside`, `price`,
  `label`, `value`, `summary`, `head`, `foot`, `body` to the substring set
  so the element-mode selector picks up semantic card regions like
  `pcard-aside`, `pcard-aside-head`, `fc-body`, `.price`, `.label` that
  previously fell through to the catch-all id-only rule.
- **Image dblclick descendant-search fallback.** `onDblClick` now walks up
  to 3 container levels from the click target and checks image descendants
  whose bounding rect contains (or is within 10px of) the click point.
  Fixes the "I clicked the photo but got the text editor" report when the
  click landed on a rounded-corner card edge or a padding band between
  image and text body.

### Fixed

- **History polling no longer freezes on a mid-write parse error.**
  `fetchHistory` previously cached `lastHistoryString = text` *before*
  `JSON.parse(text)`, so a malformed read from the agent writing
  mid-fetch poisoned the cache and the next poll's `text ===
  lastHistoryString` short-circuit would skip retries forever. The cache
  write now lands only after a successful parse.
- **Stale-batch timer no longer resets on unrelated history changes.**
  Removed the `staleTimer` push-back inside `fetchHistory`. Any
  `history.json` delta used to extend the user's "Claude is processing…"
  deadline indefinitely, even when the change wasn't on their batch. The
  deadline set at submit time now stands on its own.
- **`saveLS` quota-exceeded no longer locks the UI.** Wrapped the
  `localStorage.setItem` in a try/catch with a one-time toast so a session
  with ~10 pending entries × ~600-char `outer_html` payloads can fill the
  5 MB LS quota without an uncaught throw freezing every saveLS-touching
  handler.
- **`findAnchorNode` hardened.** Early-returns on falsy / whitespace-
  containing anchors (no more `CSS.escape(undefined)` matching `data-cf-
  change="undefined"`; no more silent `~=` token mismatches that loop
  "missing anchor" toasts on every poll). Query scoped to `document.body`
  so UI internals never shadow a host-page anchor.
- **MutationObserver short-circuit on UI re-renders.** The
  `_cfAnchorObserver` now bails when the mutation target is inside
  `#claude-feedback-root`. Every `renderPending` / `renderHistory` was
  firing the observer and triggering hundreds of `closest()` calls per
  re-render; the short-circuit drops that to ~zero.

### Server

- **Inbox append is now concurrency-safe.** `server.py` wraps the
  `inbox.jsonl` append in a process-wide `threading.Lock`. Without it,
  `ThreadingTCPServer` + two simultaneous submits + a batch larger than
  `PIPE_BUF` (~4 KB) interleaved bytes mid-line and corrupted the JSONL
  the agent reads. Realistic with multi-comment batches containing
  truncated `outer_html` payloads.

### Refactor

- **`postFeedback(comments, opts)` helper.** Four sites that built the
  `{ submitted_at, page_url, comments, source? }` envelope and POSTed to
  `/feedback` (the Squarespace scope-wrap request, the audit-fix
  submission, the history-undo request, and the new agent-prompt reply)
  now go through a single helper. `submitBatch` stays separate — it owns
  the pending-list state path and isn't a thin POST. Also added a
  `newCommentId(suffix?)` helper for the canonical `c-${ts}-${rand}`
  shape (only the new prompt path uses it so far; remaining call sites
  still inline the same expression).

## [v0.2.1] — 2026-06-02

Post-v0.2.0 stability + feature pass before the v0.3 viewport-switcher fork. Adds the Squarespace audit (with a scope-root gate), a palette-aware color popover, a style paintbrush, the comment-while-editing button, history-undo on the last 5 changes, the image-URL swap, and a refactored selection-frame overlay system. Also lands a feature backlog (BACKLOG.md) for what's next.

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

- **🔍 Squarespace audit scope-root gate** — before running the eight
  checks, the audit walks `document.body.children` for any `id="ssc-*"`
  wrapper. If none is present, the audit pauses and asks the user (in a
  modal with the page title + path) whether to wrap content under a
  suggested `ssc-<slug>-embed` id (auto-derived from the page title or
  filename) and re-audit, or run unscoped anyway, or cancel. Picking
  wrap POSTs a `source: "sqs-audit-scope-request"` comment so the agent
  performs the structural rewrite. Reason: the Bar Calculator audit
  without this gate produced 55 false-positive inline-`!important`
  findings — all targeting JS-generated DOM that source edits couldn't
  reach. `sqsHasScopedRoot()` checks the live DOM first (catches pages
  whose CSS is in a linked stylesheet so the inline-`<style>` scan
  would miss the wrapper) and only falls back to inline-style
  textContent scanning if the DOM walk turns up nothing.
- **9th audit check: fixed-position full-viewport backdrops** — rules
  under a `#ssc-*` root with `position: fixed` + full-viewport coverage
  (`inset: 0`, four-sided zero, or `100vw × 100vh`) + low z-index
  (< 100) + non-modal selector get flagged. These tile across the SQ
  footer at deploy time. Apply rewrites `position: fixed` →
  `position: absolute` so the backdrop is anchored to the scoped
  wrapper (`position: relative` on the root is the manual partner step
  the audit notes but doesn't auto-apply). Modals are skipped via
  selector substring (`modal`/`overlay`/`drawer`/`popup`/`dialog`/
  `toast`/`tooltip`) and z-index threshold.
- **Selection-frame overlay system** — `.cf-elem-hover` and
  `.cf-elem-selected` no longer mutate the target element's `border` /
  `outline` / `box-shadow`. Instead, a position-fixed overlay layer
  (`#cf-overlays` inside `#claude-feedback-root`) draws one frame
  per state. Frames mirror their target's bounding box via an rAF loop
  that auto-stops when no frames are active. Solves three problems
  the prior class-based approach had: outline / border getting clipped
  by `overflow: hidden` ancestors (`.card-featured` did this); paint
  conflict with the element's own border styling; layout shift when
  border-box-sizing was enforced for the class swap. Multi-select shows
  multiple frames at once; each carries a "selected" label inside its
  top-left corner. `.cf-editing-target` (the inline-text-edit affordance)
  is intentionally still class-based — single-element edit mode doesn't
  benefit from the overlay layer.
- **`MutationObserver` for dynamic anchor assignment** — `assignAnchors`
  installs a body-subtree observer that assigns `data-cf-id` to any
  newly-added commentable element. Solves the JS-rebuilt-DOM problem:
  Bar Calculator's `calculate()` rewrites `#metricGrid` via `innerHTML`
  every press, so `.metric` children were anchorless and the only
  selectable target was the parent grid. The observer catches them.
  Counter is shared between the initial pass and the observer so dynamic
  anchors keep counting from where the static pass stopped.
- **Expanded `COMMENTABLE_CLASS_SUBSTRINGS`** — added
  `metric`/`stat`/`tile`/`item`/`panel`/`cell`/`field`/`row` to the
  substring list so stat-unit cards are commentable on their own
  instead of getting walked-past in `findCommentableAncestor`. Pairs
  with the MutationObserver above to fix the metric-grid drill-down
  complaint.
- **↺ undo on the last 5 history changes** — each of the most recent 5
  rendered history rows gets a small undo pill in the top-right. Click
  prompts a confirm, then POSTs a `source: "history-undo-request"`
  comment so the agent reverses the source edit and appends a new
  history batch documenting the revert. Older entries stay
  click-to-focus only — capped at 5 to avoid tempting deep-history
  rollbacks that later edits may have built on top of. The undo
  request asks the agent to surface conflicts when later edits touched
  the same elements.
- **📷 url button on the image edit toolbar** — shown only when
  `body.cf-image-edit-mode` is on (via the new `.cf-img-only` class).
  Click prompts for a new URL pre-filled with the current `src`, sets
  `editingEl.src`, and reflows the toolbar position. The src change
  flows through the existing text-edit outer-html diff pipeline so it
  becomes a pending entry on confirm.
- **Color picker popover with embedded 3-slot palette** — the two
  native `<input type="color">` elements in the toolbar were replaced
  with custom color-swatch buttons (`#cf-edit-color-btn` /
  `#cf-edit-bg-btn`) that open a custom popover when clicked. The
  popover shows three page-detected swatches at the top + a
  `custom color…` button that triggers the hidden native picker.
  Swatch click applies to whichever target the popover was opened from
  (text color or background); right-click on a swatch opens a hidden
  color input to edit that slot's value (persisted per-pathname in
  `localStorage` under `cf:palette:${location.pathname}`). Swatch
  detection counts text color, background-color, AND average color of
  background-image gradients (weighted by alpha), all across the whole
  page, excluding pure `#ffffff` and `#000000` as likely defaults.
- **🖌 style paintbrush button** in toolbar row 3 (border row, so it
  stays visible in both text- and image-edit modes). Click captures the
  current edit element's computed styles via the
  `CF_PAINT_PROPS_BASE` set (font-family, font-size, line-height,
  color, background-color, border-width / style / color, border-radius,
  padding), exits edit mode, and arms `body.cf-paintbrush-mode`. Next
  click on a commentable element pastes the captured styles as inline
  `!important` declarations and queues a `text-edit` pending entry with
  `comment: "[paintbrush] applied captured styles"`. Sticky: stays armed
  after each paste until Esc or the button is clicked again. Img sources
  capture a restricted border-only set (`border-width` / `border-style` /
  `border-color` / `border-radius`); cross-kind paints (img → text or
  text → img) no-op with a toast.
- **💬 comment button on the edit toolbar** — sits next to cancel /
  confirm in row 1, visible in both text- and image-edit modes (doesn't
  carry the `.cf-edit-fmt` / `.cf-edit-case` classes that get hidden in
  image mode). Click auto-commits any in-flight changes via
  `commitOrExitCurrentEdit()`, then opens the existing element-comment
  editor pointing at the same element. Lets the user leave a note about
  an element in addition to the visual edit they just made, without
  needing to enter element-select mode first.
- **BACKLOG.md** — feature design notes for what's next: ✨ generate
  more text (LLM-assisted authoring with server-side proxy + preview
  panel), ⇅ drag-and-drop reorder (grip-handle-only redesign to avoid
  the pointer-event collisions that killed the parked v0.2 version),
  ➕ +element (curated palette + reference-element + position picker
  + new `add` comment type), 🗂 layer manager (read-only DOM tree
  panel filtered to commentable elements, live-updating via the same
  MutationObserver as the anchor system). Each entry follows the same
  shape: what it does, non-negotiable constraints, options worth
  exposing, recommended MVP cut, open questions. Closes with a
  suggested implementation order.
- **🔍 Squarespace audit button** in the panel header — eight-check pass
  aligned with the consolidated `squarespace-collision-audit` skill:
  1. **Global CSS selectors** — `body`, `html`, `*` rules bleed into
     the Squarespace page wrapper.
  2. **Naked tag + SQ-chrome selectors** — `h1` / `p` / `img` /
     `header` / `footer` / `section` etc. PLUS `.site-header`,
     `.site-footer`, `#header`, `#footer`, `#site-wrapper`.
  3. **Multiple `<h1>` elements** — SEO + accessibility; one H1 per
     page is the rule, the modal offers a per-H1 dropdown to rewrite
     the duplicate(s) as `<h2>`, `<h3>`, or `<p>`.
  4. **`z-index` in the 100–1000 nav range** — collides with
     Squarespace's header / mobile-nav stack; rewritten to `99`.
  5. **`--tweak-*` CSS variables** — clash with Squarespace's
     internal style tokens; renamed to `--ssc-*`.
  6. **Re-imported site fonts** (`@import` of `fonts.googleapis.com`
     / `fonts.adobe.com` / `use.typekit.net`) — the SQ site loads
     fonts globally; the `@import` line is removed.
  7. **Missing `box-sizing: border-box` reset** on any declared
     `#ssc-*` scope — without it, padding widens children past the
     embed and triggers overflow. Reset prepended to the host
     `<style>` block.
  8. **Inline styles missing `!important`** — contextual, only flagged
     when no scoped root is detected (the prior auto-flag produced 38
     false positives on JS-generated descendants of a `#ssc-*` root in
     a single Bar Calculator audit run).
  Critical decisions: **root id** (auto-detected by looking for the
  outermost `#ssc-*` id directly under `<body>`; empty = ask), and
  per-H1 rewrite-target tag.
  Findings open in a severity-color-coded modal (rose critical /
  gold warning / leaf info). Apply queues each accepted fix as a
  `text-edit` in pending — they go through the standard submit /
  marker-menu revert / ⌘Z flow.
  Dropped from the prior version: footer-collision and viewport-units
  checks. Footer collision was misdiagnosed (backdrops like full-page
  starfield containers got flagged as UI overlaps with the SQ footer);
  footer issues actually come from SQ editor content deletion or
  `display: none` on `footer`/`.site-footer` selectors, both caught
  by check 2 + the documented knowledge base. Viewport units don't
  cause Squarespace overflow on this site — `body { overflow-x: hidden }`
  in Custom CSS absorbs them, and `100vh` is often desired for hero
  sections.
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

- **Per-pending "remove" button now reverts text-edits, not just deletes** —
  the in-list `✗` button previously only called `revertCommentVisual()`
  when `c.type === "delete"`, leaving text-edit visuals stuck on the
  page after their pending row was dropped. The intent was "use the
  on-element marker menu's remove for text-edits" but the marker isn't
  an obvious affordance; the trashcan now reverts both types so ⌘Z,
  marker menu, in-list ✗, and clear-all all behave the same way.
- **Element selector now drills into JS-rendered DOM** — combination of
  the expanded `COMMENTABLE_CLASS_SUBSTRINGS` and the new
  `MutationObserver` (see Added). Before: clicking inside a JS-rebuilt
  metric grid selected the whole `#metricGrid` because the inner
  `.metric` divs had no `data-cf-id` AND `.metric` wasn't in the
  commentable predicate. Now: each metric card is its own selectable
  target with its own cf-id assigned the moment the JS inserts it.
- **Audit root-id auto-detect no longer matches substrings** —
  `sqsGuessRootId()` walks `document.body.children` for `id="ssc-*"`
  and returns the outermost match (or empty if none). The prior
  heuristic matched substrings like "wrap" / "page" / "main" and
  picked `#sig1wrap` (a 50-px-wide dropdown wrapper) on Bar Calculator
  — would have killed every styled rule.
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

- **Audit scope-pass: `html { … }` now rewrites to `#<rootId>`** instead
  of being left alone. The prior guidance said html-level rules
  (`scroll-behavior`, etc.) should stay at html level, but the audit's
  runtime detector flags them as global anyway, and in SQ Code Block
  context any `html {}` rule does bleed into the host site's html
  element. Updated in both the in-editor JS audit and the consolidated
  `squarespace-collision-audit` SKILL.md.
- **Palette swatch detection rewritten** — `detectPageColors()` now
  scans the whole page, not just elements with direct text. Counts:
  text color (when the element has direct text), background-color
  (when not transparent), and the average color of any background-image
  gradient (weighted by alpha across rgb/rgba tokens). Excludes pure
  white (`#ffffff`) and pure black (`#000000`) from candidates since
  those tend to be CSS defaults. Returns top 3 by occurrence.
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
