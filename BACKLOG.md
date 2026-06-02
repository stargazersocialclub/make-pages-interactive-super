# make-pages-interactive — Feature Backlog

Design notes for features deferred or under discussion. Each entry has the same shape: what it does, constraints we'd hold non-negotiable, options worth exposing, recommended MVP cut, open questions that block implementation. Items are unordered — pick whichever fits the next iteration.

---

## ✨ Generate more text (LLM-assisted authoring)

A toolbar button (sparkle icon) on the inline text editor. Reads the text in the currently-edited element, sends it to a language model, returns generated content that continues / expands / varies the existing copy, and offers an inline preview before the user accepts it into the contenteditable.

### Constraints (non-negotiable)

1. **Server-side proxy.** The API key lives in `server.py` env (`ANTHROPIC_API_KEY` or `OPENAI_API_KEY`); the browser never sees it. Otherwise the key ends up pasted into Squarespace source and gets scraped. A new `POST /generate` endpoint accepts `{text, mode, instruction, element_tag, context}` and returns generated text.
2. **Preview before insertion.** Generated text appears in a result panel inside the toolbar with `Insert at cursor`, `Replace`, `Try again`, `Discard`. Never auto-replaces what the user typed. Insertion routes through the normal pending pipeline so ⌘Z / clear-all revert it.
3. **Max output cap** of ~300 words / 500 tokens. Stops runaway completions on vague prompts.
4. **Element-type awareness.** `<h2>` → "suggest 3 short headings in the same voice." `<li>` → "add 2–3 more bullets matching tone and structure." `<p>` → "continue this paragraph naturally." Generic `continue this text` loses on short or formatted elements.
5. **Existing text as voice anchor.** System prompt always includes: *Match the rhythm, sentence length, and tone of the existing copy. Don't restate what's already there.*

### Options worth exposing

| Control | Values | Default |
|---|---|---|
| Mode | Continue · Expand · Alternatives (3 variants) · Rewrite · Add more bullets | element-type-dependent |
| Length | Short / Match / Long | Match |
| Custom note | free-text input | empty |

Custom note is the killer — *"make it more playful"*, *"drop the second-person"*, *"fewer adjectives"* is where the value beyond plain continuation lives.

### Recommended MVP cut

```
Click ✨ → tiny inline popover anchored to the button:
  [autofocused custom-note input]
  [▸ options]   ← reveals mode + length
  [Generate]  [Cancel]

After generation:
  result panel with the generated text rendered as preview
  [✓ Insert at cursor]  [↻ Try again]  [✕ Discard]
```

Default mode = element-type-dependent. Length = Match. Custom note empty. Three controls under the disclosure for power users.

### What NOT to expose
- Page-wide context selection. Auto-include the nearest 3 commentable ancestors' text as background context invisibly.
- Tone toggles ("more casual / formal") — subsumed into the custom note.
- Model choice. Pin to Anthropic Haiku 4.5 (or `gpt-4o-mini` if OpenAI). Reduces decision fatigue.
- Token count / cost. Surface only if BYO-key.

### Open questions

- **Server-side vs bring-your-own-key.** Server-side requires the user to drop an API key into the shell env where `python server.py` runs. BYO-key is faster to ship but the key needs to be excluded from the SQ paste bundle.
- **One result vs three alternatives.** Three is good UX for headings/short copy; for long paragraphs it's overkill on cost + UX. Default to one, switch to three when mode = Alternatives.
- **Sparkle for image alt text.** When editing an `<img>`, ✨ could generate alt text from the src URL filename + nearby text. Nice-to-have, separate code path.

---

## ⇅ Drag-and-drop reorder

Previously implemented and parked in this session (was ~253 lines in `lib/feedback.js`). Pointer-event collisions with the border-weight spinner and the element-select picker made the affordance unreliable; multiple unrelated bug reports traced back to the move-mode pointer state. The feature is wanted; the prior implementation has to be redone from a different architecture.

### Constraints (non-negotiable)

1. **Drag handle, not whole element.** A small grip icon appears in element-select mode at the top-left of selected elements. Drag from the grip only — never from the element body. Eliminates the entire class of "I tried to click X and instead the page moved Y" reports.
2. **Mode-gated.** Drag only fires when element-select mode is on (`E` key). In edit-text mode and normal browsing, the page behaves normally. Removes collision with text selection and contenteditable interaction.
3. **Visible drop indicator** between siblings (a horizontal/vertical gold line for vertical/horizontal layouts), computed from the parent's `flex-direction` / `display`. No drop allowed across parents in v1 — keeps the move scoped to siblings.
4. **Persists as a `move` comment type** in pending, same shape as before: `{type: "move", source_anchor, target_parent, target_index, original_index}`. Revert restores the element to its original index. Submitting POSTs to inbox; agent applies the source reorder.
5. **Flex/grid sibling-pin still applies.** When the moved element has flex-grow or grid placement, neighbors' computed widths/heights get pinned as separate pending edits so the asymmetric layout survives reload — same machinery as the existing resize handle.

### Options worth exposing

- **Single drop zone vs free reorder.** v1 = single drop zone between siblings only. v2 could allow drag-into-parent (re-parenting).
- **Multi-select drag.** Shift-click multiple, then drag all together. Skip in v1.

### Recommended MVP cut

- Enter element-select mode (`E`)
- Hover an element → 4-px grip icon appears in top-left corner
- Mouse-down on the grip → enter drag mode (cursor `grabbing`, element gets a `cf-move-source` class with opacity 0.5)
- During drag, walk siblings, place a gold drop-indicator line at the closest gap
- Drop → commit move + push pending entry
- Esc during drag → cancel back to original index

### Open questions

- **Drag handle visibility on touch.** Touch devices don't hover. Show grip on tap-and-hold? Different gesture entirely?
- **Containers with `overflow: hidden`.** Drop indicator outside parent bounds gets clipped (the same problem as the selection outline we fixed earlier). Probably need to use the overlay layer pattern from selection frames.
- **Conflict with the audit's `position: fixed` backdrop pattern.** A starfield with `position: absolute; inset: 0` could intercept mouse events. Make sure the drop logic respects `pointer-events: none` ancestors.

---

## ➕ +element (add new DOM nodes)

A "+" button somewhere prominent (panel header? floating?) that lets users insert a new element onto the page without leaving the browser. Currently the editor only mutates existing elements; structural additions require asking the agent.

### Constraints (non-negotiable)

1. **Limited element palette.** Not arbitrary HTML. A curated list — paragraph, heading (H2 / H3), bullet list, image, link, button, divider. Custom HTML invites broken markup and Squarespace-collision surprises.
2. **Target + position picker.** User picks: (a) reference element (click it after pressing `+`, like element-select), (b) position (`before` / `after` / `inside as last child`). No drag-to-place in v1 — keep the gesture explicit.
3. **Pre-fill with placeholder copy** so the inserted element is visible immediately. Paragraph → "Lorem ipsum…", heading → "Untitled heading", image → a 600×400 placeholder URL, etc.
4. **Auto-enters edit mode** on the new element so the user can immediately type / pick an image. Reduces the "I added it, now what?" beat.
5. **New pending `add` comment type.** `{type: "add", element_template, parent_anchor, position, generated_html}`. Revert removes the node. Submitting POSTs; agent inserts the corresponding source markup.

### Options worth exposing

| Choice | UI | Default |
|---|---|---|
| Element type | grid of icon tiles (paragraph / heading / list / image / link / button / divider) | none — must pick |
| Position | radio: before / after / inside | after |
| Heading level | only when type = heading | H2 |
| Image source | URL input (reuses the image-URL flow) | empty |

### Recommended MVP cut

- Floating `+` button next to the launcher pill (bottom-right area)
- Click → small picker drops up with the 7 icons
- Pick → element-select cursor mode activates ("click a reference element")
- Click reference → small popover near the cursor: position radio + (for image) URL field + `Insert` button
- On insert: element appears, auto-enters edit mode if it's text/heading/list, image opens its URL flow

### Open questions

- **Templates beyond singletons.** Should "card" / "section divider" / "stargazer-pricing-card" be in the palette? Useful but page-specific. Could ship per-page templates via a config in the artifact directory.
- **Where the markup comes from for richer types.** A simple `<p>` is one line; an image with proper alt + lazy loading + the painted gold border is more. Probably a small `templates.js` constant per element type.
- **Validation against Squarespace conventions.** Should `+` warn if the user is about to add an `<h1>` and the page already has one (the audit's multi-H1 rule)? Probably yes — preempt the next audit complaint.

---

## 🗂 Layer manager (DOM tree panel)

A toggleable side panel showing the page's commentable element tree, like the Elements panel in DevTools but filtered to what the editor cares about. Click a node → select / scroll-to. Click a marker on a node → indicates pending edit. Goal: make it possible to find and select elements that are visually hard to click (very small, covered by another element, off-screen below).

### Constraints (non-negotiable)

1. **Filter to commentable.** Same `isCommentable` predicate the rest of the editor uses. Avoids drowning the user in layout div noise.
2. **Live-updating.** Tied to the same `MutationObserver` that the anchor system uses. When `calculate()` rebuilds the bar-calc metric grid, the layer manager re-renders the affected subtree.
3. **Selection sync with the page.** Clicking a node in the panel triggers the same selection path as element-select click (highlights with the overlay frame, opens the element popup). Clicking on the page updates which node is highlighted in the panel.
4. **Pending-edit markers.** A small `✎` dot next to any node that has a pending text-edit / delete / move. Lets the user see at a glance how many changes are queued and where.
5. **No write actions in v1.** Read-only navigation. No drag-to-reorder, no delete from the panel, no inline rename. Those come later (and the drag-to-reorder overlaps with the drag-drop feature above — should land first there).

### Options worth exposing

- **Filter input** at the top to grep the tree by tag / class / text content.
- **Collapse / expand all** buttons.
- **Show / hide UI chrome** toggle (default hide — `#claude-feedback-root` and its descendants are excluded by default).
- **Pinning** — pin one node so it stays highlighted while you scroll/navigate elsewhere in the tree.

### Recommended MVP cut

- New side panel docked to the right of the existing feedback panel (or as a tab inside it — `Pending` / `History` / `Layers`)
- Tree rendered as nested `<details>` for cheap collapse/expand
- Each row: tag + first class + first 30 chars of text content
- Click row → page scrolls to element + overlay frame appears
- Filter input at top — string match against `tag.class#id text-snippet`
- `✎` marker on rows with pending edits

### Open questions

- **Where it lives.** Side panel competes for screen real estate with the existing feedback panel. Tab inside (cleaner) vs. separate panel (more discoverable but cluttered).
- **Performance on large pages.** Form-builder pages with thousands of commentable elements would lag if we render the full tree at once. Probably need virtualization (only render visible nodes + a buffer).
- **Overlap with the drag-and-drop feature.** Drag-in-panel-to-reorder is a natural extension but should wait until drag-and-drop ships and the move-mode architecture is stable.
- **Highlighting density.** When the user has a pending edit, the row shows `✎`. When they hover, the page element highlights. Multi-select state from the page should reflect in the panel — which means selectedElements has to be a shared piece of state already (it is, via `selectedElements` array).

---

## Implementation order (suggested)

1. **✨ Generate more text** — highest user-value, smallest code surface (server endpoint + popover + result panel). Self-contained, no overlap with the other three.
2. **➕ +element** — depends on a new pending comment type but otherwise standalone. Good MVP candidate.
3. **🗂 Layer manager (read-only)** — depends on nothing, gives navigation wins immediately, sets up the data structure that drag-and-drop in-panel would later need.
4. **⇅ Drag-and-drop reorder** — biggest scope, most likely to regress neighbor features. Land last so the layer manager can absorb some of its UX (panel-driven reorder is often easier than canvas drag).
