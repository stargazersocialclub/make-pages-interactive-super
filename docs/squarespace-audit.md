# Squarespace conflict audit

The editor ships a **🔍 sqs** button in the panel header. Clicking it
scans the current page for patterns that break when the HTML is embedded
in a Squarespace site via Settings → Advanced → Code Injection, and
surfaces fixes in a modal that queues each accepted item as a pending
text-edit.

## Why this exists

Pages built standalone (with `<style>` tags that use `body`,
`* { box-sizing }`, or naked `h1` selectors) work fine in isolation but
poison the Squarespace page wrapper when injected — Squarespace's own
header, footer, and content sections inherit the same rules. Inline
overrides without `!important` lose to Squarespace's stylesheet.
`position: fixed` elements near the viewport bottom collide with the
Squarespace footer bar.

The audit captures the rules we've learned the hard way over several
pricing-page + bar-calculator iterations and packages them as an
automated pass.

## The five checks

| # | Check                            | Severity | Decision needed                        |
|---|----------------------------------|----------|----------------------------------------|
| 1 | Global selectors (`body` / `html` / `*`) | critical | Root id to scope under |
| 2 | Naked tag selectors (`h1`, `p`, `a`, …)  | warning  | Root id to scope under |
| 3 | Inline styles missing `!important` for `color` / `font-family` / `background` / `background-color` | info     | (auto)                |
| 4 | `position: fixed` elements within 60 px of the viewport bottom | critical | Lift offset (default 80 px) |
| 5 | `100vw` / `100vh` sizing in CSS  | warning  | (auto — converts to `100%`)     |

## How fixes apply

Each accepted finding becomes a `text-edit` comment in pending:

- **Global / naked selectors** rewrite the `<style>` block's text:
  - `body { ... }` → `#<rootId> { ... }`
  - `h1 { ... }` → `#<rootId> h1 { ... }`
  - `* { ... }` → `#<rootId> * { ... }`
- **Inline `!important`** rewrites the element's `style` attribute,
  appending `!important` to the named declaration.
- **Footer collision** sets `bottom: <lift>px !important` on the
  element's inline style.
- **Viewport units** rewrites every `100vw` / `100vh` (and other
  >= 50vw/vh values) in the host `<style>` block to `100%`.

Because every fix routes through the standard pending → submit → revert
flow, the user can roll back any individual fix from the marker menu
or undo the whole batch with `⌘Z`.

## What the audit does NOT do

- Rewrite externally-linked stylesheets (`<link rel="stylesheet">`) —
  only inline `<style>` blocks. If a Squarespace conflict lives in an
  external CSS, the audit flags nothing.
- Detect Squarespace-class collisions (`.sqs-block`, `.sqs-row`) —
  rarely an issue for user-built code, and flagging every `.card` /
  `.button` would be too noisy.
- Validate image URLs (the page-clean export from copy-HTML already
  uses live src attributes).
- Touch the Squarespace footer / branding markup — the audit lifts
  *user* fixed elements above it, never reaches into Squarespace
  itself.

## Memory references

The audit's domain knowledge is anchored in two memory files:
- `project_squarespace_embedding.md` — user's embedding pipeline.
- `skill_make_pages_interactive_squarespace_audit.md` — pointer to
  the button and the apply path inside `feedback.js`.
