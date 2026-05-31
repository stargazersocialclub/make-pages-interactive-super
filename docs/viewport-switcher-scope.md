# Viewport switcher — scope (v0.3 candidate)

Status: **proposed, not implemented**. Capture written before starting any code.

## Goal

Let the user iterate on a page for both desktop and mobile in the same
session. Some edits (typos, copy, brand colors) should apply universally;
others (sizing, spacing, font-size, source order) should apply only to the
viewport they were made in.

## UI surface

- Two-button toggle in the panel header: **Desktop** (≥1024) · **Mobile**.
- Mobile width: **390 px** (iPhone 12/13). Skip Tablet for v1.
- When Mobile is active, inject a `<style>` block at runtime:
  ```
  html { max-width: 414px; margin: 0 auto;
         box-shadow: 0 0 0 9999px rgba(0,0,0,.5),
                     0 12px 32px rgba(0,0,0,.4); }
  ```
  Visual "device frame" feel. Inject removed when toggled back.
- Active viewport shows in the launcher pill (`Feedback · desktop` /
  `Feedback · mobile`) and in pending-row meta.
- A small switcher in the inline edit toolbar's label area so it's
  reachable mid-edit.

## Honest caveat

CSS max-width on `html` doesn't fire real `@media` queries because
`window.innerWidth` doesn't actually change. 90% of fluid responsive
layouts respond to container-width changes anyway, so this is useful for
most iteration. For sites with strict breakpoint behavior, document that
the user should use Chrome DevTools alongside.

## Boundaries: shared vs per-viewport

| Category | Behavior | Reasoning |
|---|---|---|
| Text content (innerText, lists, bullets) | Shared | A typo fix is universal. |
| HTML structure (added `<li>`, broken paragraph) | Shared | Content structure is conceptually one source of truth. |
| font-family, color, background, border-color, italic / bold / case | Shared | Brand-level; same on both. |
| align-left/center/right | Shared | Usually a content decision, not a layout decision. |
| **width, height, max-width, min-width** | Per-viewport | Layout-level; whole point of having two modes. |
| **margin, padding** | Per-viewport | Spacing changes with screen size. |
| **font-size** | Per-viewport | Most common per-vp tweak. |
| **border-width, border-radius** | Per-viewport | Often dialed down on mobile. |
| **display, position, flex / grid props** | Per-viewport | Rare today but valid. |
| **move (drag-reorder)** | Per-viewport | Source-order changes on mobile happen. |
| snapshot | Always tagged with active viewport | Just visual context; doesn't apply changes. |
| selection / elements / general comments | Shared | They don't mutate; the agent decides how to apply. |

## Payload

Every inbox comment gets a new field:
```
viewport: "desktop" | "mobile"   // current toggle when submitted
```

For `text-edit`, the agent diffs the style attribute prop-by-prop:
- **Per-viewport props**: wrap the change in a `@media (max-width: 640px)`
  block (mobile case) or apply outside any media query (desktop case).
  Inline `<style>` near the element, OR a project stylesheet, depending
  on what the project already does.
- **Shared props**: apply directly to the element's `style` attribute or
  base CSS rule.

For `move`: for v1, apply the move directly + note in history that it was
captured in <vp> mode and could be made vp-specific if needed. Source
reordering for mobile is rare and complex (would need either a media-
query class swap or duplicate markup).

## What NOT to restrict

Both modes allow every action. Tagging is enough. Restricting actions in
mobile mode would feel arbitrary (you might want to edit text while
previewing mobile).

## Open calls (decided)

- Mobile width: **390 px**.
- `align-left/center/right` stays **shared** (a content choice).
- `font-size` stays **per-viewport** (most common tweak).
- Element-mode + general comments **also carry the viewport tag** for
  context, even though they don't mutate.

## Estimated work

- Toggle UI + state persistence: ~30 lines.
- Mobile-frame CSS: ~25 lines.
- Tag every comment payload: ~10 lines.
- Pending-row + history-row viewport badge: ~15 lines.
- SKILL.md update for the agent (interpret `viewport` field, which props
  are shared vs per-vp): ~40 lines of docs.

About 2 hours. No major refactors.

## Implementation order

1. State + toggle UI (panel header).
2. Mobile-frame CSS injection.
3. Tag pending comments with viewport at queue-time.
4. Show viewport badge on pending + history rows.
5. Update launcher pill caption.
6. Inline-edit toolbar mini switcher.
7. SKILL.md doc update for the agent.

Each commit independently runnable; no big-bang refactor.
