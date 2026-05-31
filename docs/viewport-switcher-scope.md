# Viewport switcher — scope (v0.3 candidate)

Status: **proposed, not implemented**. Capture written before starting any code.

This is revision 2 of the scope after a second design pass — see the
"Revision history" section at the bottom for what changed from rev 1.

## Goal

Let the user iterate on a page for both desktop and mobile in the same
session. Some edits (typos, copy, brand colors) apply universally; others
(sizing, spacing, font-size, source order) apply only to the viewport they
were made in.

## Viewport mechanism — **iframe**, not CSS narrowing

The first cut considered narrowing `<html>` via inline CSS. That doesn't
fire real `@media (max-width: …)` queries — `window.innerWidth` doesn't
actually change — so any project with intentional mobile breakpoints
(navigation swaps, `display: none` rules, layout reflow) would still show
its desktop state in a narrow column. The user would be editing what they
*think* is the mobile view but is actually misrepresented.

**Revised approach**: load the host page in an `<iframe>` sized to the
chosen viewport (390 × 700 by default). The iframe's own `window.innerWidth`
*is* 390, so real `@media` rules fire, real scrollbars exist within the
device frame, hover-vs-touch isn't suddenly broken by a CSS hack.

The feedback chrome (launcher pill, panel, toolbar) stays in the **outer**
window. The inject script runs inside the iframe (it already does — the
iframe loads through the same server at `/<page>.html`). A small
`postMessage` bridge syncs:
- Outer → iframe: "switch viewport" notifications.
- Iframe → outer: comment submissions, pending state, marker positions.

### Iframe layout
- Default: full-window, no chrome — same as today.
- Desktop mode: full-window iframe (or its existing container width).
- Mobile mode: iframe shrinks to **390 px wide**, centered, with the page
  background dimmed around it (single `<div>` overlay in the outer doc).

### Implementation footprint
- Server: no changes needed (already serves the page and `/lib/*`).
- Inject script: detect `window !== window.top`; in that case, post events
  to parent instead of trying to render the panel inline.
- Outer wrapper: ~60 lines of HTML/JS to set up the iframe, the dim
  overlay, the viewport-toggle button, and the postMessage handlers.

## Per-viewport CSS storage — managed file

You can't put `@media` queries inside an element's `style` attribute, so
inline-style mutation (the current text-edit path for style) won't scale to
per-viewport edits.

**Approach**: a single managed CSS file at `feedback/viewport-overrides.css`,
loaded by the inject script. Each per-viewport edit becomes a rule in that
file:

```css
@media (max-width: 640px) {
  [data-cf-vp="m4k2"] { width: 280px !important; padding: 12px !important; }
}
```

Why this shape:
- One file is easy for the agent to maintain (append, edit, remove).
- Each rule is keyed off a stable `data-cf-vp` attribute (see next section),
  not a brittle selector.
- The user can inspect / hand-edit the file if they need to.
- On revert (marker → remove), the agent just deletes the rule.
- Survives reload (it's a real file).

## Stable element identity — `data-cf-vp` attribute

`cf_id` is session-scoped (assigned at page-load by the inject script). For
a persisted CSS rule it's useless after reload.

**Approach**: when the agent applies the *first* per-viewport edit to an
element, it adds `data-cf-vp="<short-hash>"` to the source HTML and uses
`[data-cf-vp="<hash>"]` as the selector in `viewport-overrides.css`. The
hash is stable across reloads.

Hash format: 4–6 char base36 (~21M collision space; sufficient for any
realistic page). Collision check: agent grep the source before assigning.

## Breakpoint — auto-detected

A hardcoded breakpoint (640 px) is brittle. Projects use 360, 480, 600, 640,
768, 800, 992, 1024, ….

**Approach**: at server startup or first-batch processing, scan the
project's CSS files for `@media (max-width: <N>px)` rules. Use the smallest
N less than 1024 as the "mobile" breakpoint. Fall back to 640 if nothing
found. Allow an explicit override via `feedback/config.json`:

```json
{ "viewports": { "mobile": { "width": 390, "breakpoint": 768 } } }
```

The agent uses the configured value when wrapping rules.

## Boundaries — what's shared vs per-viewport

| Category | Behavior | Reasoning |
|---|---|---|
| Text content (innerText, lists, bullets) | Shared | A typo fix is universal. |
| HTML structure (added `<li>`, broken paragraph) | Shared | Content structure is one source of truth. |
| font-family, color, background, border-color, italic / bold / case | Shared | Brand-level; same on both. |
| align-left/center/right | Shared | Usually a content decision, not a layout decision. |
| **width, height, max-width, min-width** | Per-viewport | Layout-level. |
| **margin, padding** | Per-viewport | Spacing changes with screen size. |
| **font-size** | Per-viewport | Most common per-vp tweak. |
| **border-width, border-radius** | Per-viewport | Often dialed down on mobile. |
| **display, position, flex / grid props** | Per-viewport | Rare but valid. |
| **move (drag-reorder)** | All viewports + note (v1 only) | True per-vp move is a v2 — see below. |
| snapshot | Tagged with active viewport | Just visual context; doesn't apply changes. |
| selection / elements / general comments | Shared | Don't mutate; agent decides per-comment. |

### Move comments

Per-viewport source-order changes need either duplicated markup (`display:
none` swaps) or `flex`/`grid` `order` overrides — both invasive. For v1:
**always apply moves universally**, but tag the comment with the viewport
it was captured in so the agent's history entry can note "captured in
mobile preview; flag if you want this mobile-only" and the user can ask
explicitly.

## Payload — `viewport` field on every comment

Every inbox comment gains:
```
viewport: "desktop" | "mobile"
```
The value is the active toggle at the moment the user clicks submit.

For `text-edit`, the agent diffs the style attribute prop-by-prop using
the boundary table above:
- **Per-viewport props**: append a rule to `feedback/viewport-overrides.css`
  scoped under the active viewport's `@media` block. If the element doesn't
  yet have a `data-cf-vp` attribute, generate one and add it to source.
- **Shared props**: apply directly to the element's `style` attribute in
  source HTML (today's behavior).

A single text-edit can produce both kinds — e.g. user changes `font-family`
(shared, goes to source `style`) and `font-size` (per-vp, goes to the
overrides file) in the same edit.

## UI surface

### Outer wrapper (added)
- A two-button toggle in the panel header: **Desktop** · **Mobile**. State
  persists to `localStorage["cf-viewport"]`.
- Active viewport label in the launcher pill: `Feedback · desktop` /
  `Feedback · mobile`.
- Dim overlay around the iframe when Mobile is active.

### Pending list
- Each pending row gets a viewport badge with **two distinct shapes**:
  - **`📱 mobile-only`** / **`🖥 desktop-only`** when the edit's diff
    contains per-viewport props only.
  - **`from 📱`** / **`from 🖥`** when the edit is shared (will apply
    universally) but was queued from a particular viewport.
- A filter bar at the top of the pending list: **`view: all · desktop ·
  mobile`** — hides rows whose target viewport doesn't match. "all"
  remains the default.

### Markers
- Per-element marker counts may now reach 2 (one desktop, one mobile edit
  on the same element). Show two markers side by side; both clickable;
  the marker menu indicates which viewport its comment is for.

### Inline edit toolbar
- A tiny `🖥/📱` toggle in the toolbar label area so the user can switch
  viewport mid-edit. Switching mid-edit cancels and re-enters the edit
  in the new viewport (with a confirmation if any changes are pending).

## Documented caveats (won't fix in v0.3)

- **Hover vs touch**: hover-revealed UI still works in the iframe because
  pointer device is desktop. True touch-only emulation is out of scope —
  Chrome DevTools is the right tool.
- **`vh` / `vw` units**: respect the iframe's viewport, so they update
  correctly. ✓ Better than the CSS-narrow approach would have been.
- **JS that reads `window.innerWidth` on load**: re-runs only on iframe
  reload, not on viewport switch (since the iframe document persists).
  Workaround: switching viewport optionally reloads the iframe. Add as a
  small toggle: "reload on viewport switch" (off by default).

## Implementation order

1. **Outer wrapper**: iframe + dim overlay + viewport toggle. Inject
   script detects iframe context and posts events upward instead of
   rendering inline.
2. **postMessage bridge**: state sync (pending list, history, viewport).
3. **`data-cf-vp` infrastructure**: auto-attribute on first per-vp edit;
   selector generation; collision check.
4. **`feedback/viewport-overrides.css`**: managed file, server-served,
   agent reads/writes.
5. **Breakpoint auto-detection** at server startup, with config.json
   override.
6. **Payload `viewport` field** on every comment.
7. **Pending UX**: viewport badge variants, filter bar.
8. **Inline-edit toolbar mini switcher**.
9. **SKILL.md update**: agent contract for shared vs per-vp routing,
   `viewport-overrides.css` schema, `data-cf-vp` lifecycle.

Each commit independently runnable. No big-bang.

## Estimated work

| Phase | Effort |
|---|---|
| Outer wrapper + iframe + dim overlay | ~1.5 h |
| postMessage bridge | ~1 h |
| `data-cf-vp` + viewport-overrides.css plumbing | ~1.5 h |
| Breakpoint auto-detection | ~30 min |
| Pending UX (badges + filter) | ~1 h |
| Toolbar mini switcher | ~30 min |
| SKILL.md update | ~30 min |
| **Total** | **~6 hours** |

Higher than the original 2 h estimate but produces something you can
actually trust the output of. Iframes + a managed override file are the
two non-negotiables.

## Items deferred to v0.4+

- **True per-viewport `move`** (DOM duplication or `order` swaps).
- **Tablet preset** (768 width).
- **Touch / pointer emulation** for true mobile testing.
- **Configurable third viewport** (custom widths from `config.json`).

---

## Revision history

**Rev 2** (current): switched mechanism from CSS-narrowing to iframe;
added managed `viewport-overrides.css`; added `data-cf-vp` for stable
selectors; auto-detected breakpoint; dual-badge pending UX with filter;
documented hover/touch + `vh`/`vw` + `innerWidth` caveats. Effort
estimate ~2 h → ~6 h.

**Rev 1**: CSS-narrowing approach via `html { max-width: 414px }`.
Discarded after second pass surfaced significant gaps (no real `@media`
queries, no place to store `@media`-wrapped rules, no stable selector,
hardcoded breakpoint, pending UX collision between "applies only to" and
"queued from").
