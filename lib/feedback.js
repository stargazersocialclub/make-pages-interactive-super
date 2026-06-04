/*
 * Claude Feedback — drop-in in-page review library.
 *
 * Two modes for attaching a comment to a region of the page:
 *
 *   (1) Text-selection mode (always on): highlight any text. A "💬 comment"
 *       pill appears below the selection. Click it to open the editor.
 *
 *   (2) Element-selection mode (toggle): click the "select element" button in
 *       the panel. Hover any commentable element (images, tables, figures,
 *       paragraphs, sections, list items) to outline it. Click to select.
 *       Shift-click to add more elements to the selection. A floating popup
 *       gives you "comment" and "clear" buttons. Press Esc or toggle off to exit.
 *
 *   (3) General questions: "+ general" in the panel adds a comment that isn't
 *       tied to any region.
 *
 * Each comment carries rich anchor info so the agent can find the exact
 * region later: stable CSS selector, auto-assigned data-cf-id, element tag,
 * text snippet, and truncated outerHTML.
 *
 * The page polls feedback/history.json. New entries appear as inline
 * highlights and in the History tab; the agent attaches data-cf-change="ch-N"
 * markers in the HTML which the library uses for the "tour" walkthrough.
 */
(function () {
  if (window.__claudeFeedbackInit) return;
  window.__claudeFeedbackInit = true;

  // ---------------- Constants ----------------
  const LS_KEY = "cf-state-v1";
  const HISTORY_URL = "feedback/history.json";
  const PROMPTS_URL = "feedback/prompts.jsonl";
  const FEEDBACK_URL = "/feedback";
  const POLL_INTERVAL_MS = 4000;
  const OUTER_HTML_MAX = 600;
  const TEXT_SNIPPET_MAX = 220;

  // Selectors that we consider "commentable" — i.e. you can click them in
  // element-selection mode. Anything that's a meaningful block of content.
  const COMMENTABLE_TAGS = new Set([
    "P", "H1", "H2", "H3", "H4", "H5", "H6",
    "UL", "OL", "LI", "DL", "DT", "DD",
    "TABLE", "TR", "TD", "TH",
    "FIGURE", "IMG", "SVG", "CANVAS", "VIDEO",
    "BLOCKQUOTE", "PRE", "CODE",
    "SECTION", "ARTICLE", "ASIDE", "HEADER", "FOOTER", "NAV", "MAIN",
    "LABEL", "BUTTON", "A",
    "INPUT", "SELECT", "TEXTAREA",
    "FIELDSET", "LEGEND",
    // SPAN included so hint / chip / inline text spans get caught as their own
    // selection target instead of walking up to a less-specific ancestor.
    "SPAN",
  ]);
  // Classes that any framework uses for inline hints / captions / annotations.
  // Anything whose class contains one of the substrings below is treated as
  // commentable on its own. The "stat-unit" patterns (metric, stat, tile,
  // item, panel, cell, field, row) were added after a bar-calc feedback
  // session where users couldn't drill into individual metric cards inside
  // a metric grid — they kept selecting the whole grid.
  const COMMENTABLE_CLASSES = new Set(["card", "tldr", "fig", "controls"]);
  const COMMENTABLE_CLASS_SUBSTRINGS = ["hint", "help", "caption", "subtitle",
    "description", "meta", "annotation", "note",
    "metric", "stat", "tile", "item", "panel", "cell", "field", "row",
    "aside", "price", "label", "value", "summary", "head", "foot", "body"];

  // ---------------- State ----------------
  let pending = [];
  let history = [];
  let lastHistoryString = "";
  let lastPromptsString = "";
  let answeredPromptIds = new Set();   // hydrated from LS — persists across reloads
  let activePromptId = null;            // id of the prompt currently shown in the card
  let pollTimer = null;
  // Track which change ids we've already observed in history.json. A change is
  // only "new" if it appears in a fetch that's not the FIRST one — i.e., it
  // arrived while the page was open. Plain refreshes never surface a "new"
  // toast.
  let isFirstHistoryFetch = true;
  let knownChangeIds = new Set();

  // Selection-mode state
  let savedTextSelection = null;   // {range, quote, anchor}

  // Element-mode state
  let elementMode = false;
  let selectedElements = [];        // ordered

  // Drag-and-drop reorder (move mode) was stripped here — parked for the
  // v0.3 heavy fork. The element-mode flow (E key, click to select, then
  // comment / delete) covers the structural-change use cases for now.

  // Tour state
  let tourState = null;

  // Inline text-edit state (dblclick on a text-bearing element)
  let editingEl = null;
  let editingOriginalHtml = null;
  let editingOriginalText = null;
  let editingOriginalOuterHtml = null;
  // Snapshot of the element's inline style attribute at edit start, so we can
  // fully restore font/color/bg/width/height/etc. on cancel — not just innerHTML.
  let editingOriginalCssText = null;
  // When non-null, the current edit is refining an existing pending text-edit
  // rather than creating a new one. On submit we replace the existing entry.
  let refiningPendingId = null;

  // Browser dblclick honors the OS double-click setting (often 500ms+), so a
  // leisurely second click — reading, repositioning the caret on a text page —
  // can still register as a dblclick and yank the editor open. Require the two
  // underlying clicks to land within this window for the editor to activate.
  const MAX_DBLCLICK_INTERVAL_MS = 350;
  let prevClickTime = 0;
  let lastClickTime = 0;

  // Grid overlay + snap-to-grid (24 px). Toggles persist to localStorage.
  const GRID_SIZE_PX = 24;
  let gridShown = false;
  let gridSnap = false;

  // Debounce timer for re-positioning floating markers after window resize.
  // Module-scoped so a hot-reloaded init can't strand the old timer on window.
  let markerResizeTimer = null;

  // When the editing target is a flex / grid child, its siblings react to
  // inline width / height changes (container reallocates space). On the first
  // resize-drag of an edit session, snapshot each sibling's current rect and
  // pin it via inline width/height + flex: 0 0 auto so the target's resize
  // feels independent. Submit captures the pins as additional text-edits so
  // the asymmetric layout persists on reload; cancel restores siblings to
  // their pre-pin state. Cleared on every exitEditMode.
  let pinnedSiblingsForEdit = [];

  // Pill placement — the launcher (and panel) live in one of four viewport
  // corners. User can free-drag the pill, which snaps to the nearest corner
  // on release; Shift+arrow nudges along the perpendicular axis. Persisted
  // to localStorage so it survives reloads.
  const PILL_CORNERS = ["tl", "tr", "bl", "br"];
  const PILL_DRAG_THRESHOLD_PX = 6;
  let pillCorner = "bl";
  let pillDragStartXY = null;
  let pillDragging = false;
  let pillJustDragged = false;

  // Snapshot mode — hold Alt and drag a rectangle. On release, html2canvas
  // captures the region, the PNG is POSTed to /snapshot/<id>.png, and a
  // snapshot comment opens with the image attached. html2canvas is bundled
  // in /lib/ rather than CDN-loaded so the skill works fully offline.
  //
  // Drag corners are stored in DOCUMENT coords (clientX + scrollX). If the
  // page scrolls during a drag, the rect stays anchored to the content the
  // user was actually pointing at instead of drifting with the viewport.
  const HTML2CANVAS_LOCAL_URL = "/lib/html2canvas.min.js";
  const SNAPSHOT_UPLOAD_PREFIX = "/snapshot/";
  const MIN_SNAPSHOT_PX = 12;
  let snapshotAltHeld = false;
  let snapshotDragging = false;
  let snapshotStartDocXY = null;     // {x, y} in document coords (scroll-anchored)
  let snapshotEndDocXY = null;       // {x, y} in document coords; updated on pointermove + scroll
  let snapshotRectEl = null;
  let html2canvasLoadPromise = null;

  // Tags eligible for double-click text editing. Excludes A — single-click
  // navigation fires before dblclick can register, so anchors aren't reachable
  // this way. Form controls and media elements also excluded.
  const TEXT_EDITABLE_TAGS = new Set([
    "P", "H1", "H2", "H3", "H4", "H5", "H6",
    "SPAN", "LI", "TD", "TH", "UL", "OL",
    "BLOCKQUOTE", "FIGCAPTION", "DT", "DD",
    "LABEL", "BUTTON", "SUMMARY",
  ]);
  // Block-level tags that should be preferred over an enclosed SPAN when
  // hunting for an edit target — when you dbl-click inside a paragraph that
  // contains a styled span, you almost always want to edit the paragraph.
  const PRIMARY_EDITABLE_BLOCK_TAGS = new Set([
    "P", "H1", "H2", "H3", "H4", "H5", "H6",
    "LI", "TD", "TH", "BLOCKQUOTE", "FIGCAPTION", "DT", "DD",
    "BUTTON", "SUMMARY", "UL", "OL",
  ]);
  // Visual elements that get a resize-only edit experience (no contenteditable,
  // just the drag handle to set width/height inline).
  const IMAGE_EDITABLE_TAGS = new Set([
    "IMG", "VIDEO", "CANVAS", "PICTURE", "SVG", "IFRAME",
  ]);
  // Inline tags that don't disqualify a DIV from being a "text leaf" (a div
  // whose only children are text + inline markup is still effectively a
  // paragraph-shaped block for editing purposes).
  const INLINE_TAGS_FOR_DIV_LEAF = new Set([
    "SPAN", "A", "B", "I", "U", "EM", "STRONG", "BR", "CODE",
    "SMALL", "SUB", "SUP", "MARK", "ABBR", "CITE", "DFN", "Q",
  ]);

  // "I just submitted a batch" state — persists across reloads via localStorage.
  // Cleared when history.json has a change.in_response_to matching any of these ids.
  // Shape: { comment_ids: [], submitted_at: ISO, pending_snapshot: [comments] }
  let lastSubmittedBatch = null;
  let staleTimer = null;
  let isBatchStale = false;
  // A realistic agent batch (5–7 comments, file reads, multiple edits, history
  // append) often runs 1–3 minutes; complex batches can hit 5. The "proof of
  // life" reset only fires when history.json actually changes — and the agent
  // typically only touches that file at the END of a batch — so this timer
  // mostly runs to completion regardless of intermediate progress. Set it long
  // enough that legitimate slow work doesn't trigger the warning; only fire
  // when the inbox has genuinely been ignored.
  const STALE_AFTER_MS = 300000;

  // "Changes ready, reload to see" state. Activated when truly-new changes
  // arrive (the user has likely switched tabs to do other work). Surfaces a
  // 🔔 prefix in the tab title and a top-center banner; press R to reload.
  // Reload persists an auto-tour flag so the walkthrough opens automatically
  // on the next page load.
  let originalTitle = "";
  let pendingReload = false;
  let pendingReloadCount = 0;

  // ---------------- Squarespace conflict audit ----------------
  // Scans the page for patterns that break when the HTML is embedded inside
  // a Squarespace site via Code Injection. Five checks:
  //   1. Global selectors      — `body`, `html`, `*` rules bleed into the
  //                               Squarespace page wrapper
  //   2. Naked tag selectors   — `h1`, `p`, `a`, `button`, `input` without
  //                               an ancestor scope collide with Squarespace
  //                               typography
  //   3. Inline-style overrides
  //                            — color / font-family / background without
  //                               `!important` lose to Squarespace's stylesheet
  //   4. Footer collision      — `position: fixed` within ~60 px of the
  //                               viewport bottom overlaps the Squarespace
  //                               footer bar
  //   5. Viewport units        — `100vw` / `100vh` overflow the constrained
  //                               Squarespace container
  // Findings open in a modal; per-item checkbox controls whether each fix
  // queues as a pending text-edit. Two findings prompt for input (root id,
  // lift offset).
  // Selectors that bleed past a custom scoped embed into Squarespace's own
  // page chrome. Naked tag selectors + SQ-chrome class/id selectors live
  // here; the global trio (body/html/*) is its own bucket since the apply
  // path for those is slightly different (the `*` case wraps as
  // `#<root> *` rather than prepending).
  const SQS_NAKED_TAGS = new Set([
    "body", "html", "*",
    "h1", "h2", "h3", "h4", "h5", "h6",
    "p", "a", "img", "section", "header", "footer",
    "button", "input", "select", "textarea", "form",
    "ul", "ol", "li", "table", "tr", "td", "th",
  ]);
  const SQS_GLOBAL_TAGS = new Set(["body", "html", "*"]);
  const SQS_CHROME_SELECTORS = new Set([
    ".site-header", ".site-footer", "#header", "#footer", "#site-wrapper",
  ]);
  const SQS_CASCADE_LOSER_PROPS = new Set([
    "color", "font-family", "background", "background-color",
  ]);
  // Fonts the user's Squarespace 7.1 site is known to load globally.
  // Re-importing these inside an embed adds redundant HTTP requests and
  // can cause FOUT when the @import races with the SQ-loaded copy.
  const SQS_SITE_FONTS = [
    "cormorant garamond", "josefin sans", "josefin slab", "sanchez",
    "marcellus", "montserrat", "alegreya sans sc",  // also used by these pages in practice
  ];

  function sqsCollectStyleBlocks() {
    return Array.from(document.querySelectorAll("style"))
      .filter((s) => !s.closest("#claude-feedback-root"));
  }

  function sqsParseSelectors(cssText) {
    // Light-weight selector extractor: pull selector lists from rule openings.
    // Ignores @media / @keyframes bodies for the leading rule but the
    // selectors INSIDE @media still get caught when the regex sees them.
    const out = [];
    const re = /([^{}@]+)\{/g;
    let m;
    while ((m = re.exec(cssText)) !== null) {
      const sels = m[1].split(",").map((s) => s.trim()).filter(Boolean);
      sels.forEach((s) => out.push({ selector: s, index: m.index }));
    }
    return out;
  }

  function sqsDetectGlobalSelectors(blocks) {
    const found = [];
    blocks.forEach((block, blockIdx) => {
      const sels = sqsParseSelectors(block.textContent);
      sels.forEach(({ selector }) => {
        const head = selector.split(/[\s>+~]/)[0].trim();
        if (SQS_GLOBAL_TAGS.has(head)) {
          found.push({ blockIdx, selector, head });
        }
      });
    });
    return found;
  }

  function sqsDetectNakedTags(blocks) {
    const found = [];
    blocks.forEach((block, blockIdx) => {
      const sels = sqsParseSelectors(block.textContent);
      sels.forEach(({ selector }) => {
        // Top-level token only — `.foo h1` doesn't count, `h1` does
        const head = selector.split(/[\s>+~]/)[0].trim();
        if (SQS_GLOBAL_TAGS.has(head)) return;
        if (SQS_NAKED_TAGS.has(head) || SQS_CHROME_SELECTORS.has(head)) {
          found.push({ blockIdx, selector, head });
        }
      });
    });
    return found;
  }

  function sqsDetectInlineNoImportant() {
    const found = [];
    document.querySelectorAll("[style]").forEach((el) => {
      if (el.closest("#claude-feedback-root")) return;
      const styleAttr = el.getAttribute("style") || "";
      const decls = styleAttr.split(";").map((s) => s.trim()).filter(Boolean);
      decls.forEach((d) => {
        const i = d.indexOf(":");
        if (i < 0) return;
        const prop = d.slice(0, i).trim().toLowerCase();
        const val = d.slice(i + 1).trim();
        if (SQS_CASCADE_LOSER_PROPS.has(prop) && !/!important/i.test(val)) {
          found.push({ el, prop, val, originalDecl: d });
        }
      });
    });
    return found;
  }

  // ---- The five additions from the consolidated audit ----

  // Multiple H1 — Squarespace 7.1 SEO + accessibility rules want exactly
  // one H1 per page. Anything inside our feedback chrome doesn't count.
  function sqsDetectMultipleH1() {
    const h1s = Array.from(document.querySelectorAll("h1"))
      .filter((el) => !el.closest("#claude-feedback-root"));
    if (h1s.length <= 1) return [];
    // Flag every H1 after the first
    return h1s.slice(1).map((el) => ({ el, snippet: (el.innerText || el.textContent || "").trim().slice(0, 60) }));
  }

  // Z-index in the 100–1000 range — collides with Squarespace's header /
  // mobile-nav stack. Parse the static CSS for `z-index: N` declarations.
  function sqsDetectNavZIndex(blocks) {
    const found = [];
    blocks.forEach((block, blockIdx) => {
      const re = /z-index\s*:\s*(\d{2,5})\b/gi;
      let m;
      while ((m = re.exec(block.textContent)) !== null) {
        const v = parseInt(m[1], 10);
        if (v >= 100 && v <= 1000) {
          found.push({ blockIdx, match: m[0], value: v, offset: m.index });
        }
      }
    });
    return found;
  }

  // `--tweak-*` custom-property declarations clash with Squarespace's
  // internal style tokens. Custom code should namespace under `--ssc-*`
  // or `--fb-*`.
  function sqsDetectTweakVars(blocks) {
    const found = [];
    blocks.forEach((block, blockIdx) => {
      const re = /--tweak-[\w-]+\s*:/g;
      let m;
      while ((m = re.exec(block.textContent)) !== null) {
        found.push({ blockIdx, match: m[0].replace(/\s*:$/, ""), offset: m.index });
      }
    });
    return found;
  }

  // Re-imported site fonts via `@import` of fonts.googleapis.com /
  // fonts.adobe.com / use.typekit.net referencing a family the SQ site
  // already loads. Flag the @import line for review.
  function sqsDetectReimportedFonts(blocks) {
    const found = [];
    blocks.forEach((block, blockIdx) => {
      const re = /@import\s+(?:url\()?["']?([^"')\s]+)["']?\)?\s*;/gi;
      let m;
      while ((m = re.exec(block.textContent)) !== null) {
        const url = m[1] || "";
        if (!/fonts\.googleapis|fonts\.adobe|use\.typekit/i.test(url)) continue;
        const lowered = url.toLowerCase();
        const familyHit = SQS_SITE_FONTS.find((f) => lowered.includes(f.replace(/\s+/g, "+")) || lowered.includes(f.replace(/\s+/g, "_")));
        // Conservative: if URL looks like a font import, flag it regardless of family match,
        // since the user's Squarespace site loads ALL their fonts globally
        found.push({ blockIdx, match: m[0], url, family: familyHit || null });
      }
    });
    return found;
  }

  // Detect scoped roots and flag any that lack a `box-sizing: border-box`
  // reset on themselves or descendants — without it, padding can widen
  // children past the embed and trigger horizontal overflow.
  function sqsDetectScopedRoots(blocks) {
    const ids = new Set();
    blocks.forEach((block) => {
      const re = /#(ssc-[\w-]+)\b/g;
      let m;
      while ((m = re.exec(block.textContent)) !== null) {
        ids.add(m[1]);
      }
    });
    return Array.from(ids);
  }
  function sqsDetectMissingBoxReset(blocks) {
    const roots = sqsDetectScopedRoots(blocks);
    if (roots.length === 0) return [];
    const found = [];
    roots.forEach((rootId) => {
      // Look for `#<rootId>` with box-sizing within ~120 chars (rough proximity)
      let resetFound = false;
      blocks.forEach((block) => {
        const re = new RegExp("#" + rootId + "[^{]{0,120}\\{[^}]*box-sizing\\s*:\\s*border-box", "i");
        if (re.test(block.textContent)) resetFound = true;
      });
      if (!resetFound) found.push({ rootId });
    });
    return found;
  }

  // Inline `!important` becomes contextual: only flag when the page lacks a
  // scoped root that owns the conflicting property. If `#ssc-*` rules exist
  // in any block, the user's stylesheet already wins inside the embed and
  // adding `!important` is noise.
  function sqsHasScopedRoot(blocks) {
    // DOM check — any direct child of <body> with id="ssc-*". Catches pages
    // whose CSS is in a linked stylesheet (the inline <style> blocks won't
    // mention #ssc-* but the wrapper still exists).
    for (const el of Array.from(document.body.children)) {
      if (el.closest("#claude-feedback-root")) continue;
      if (el.id && el.id.startsWith("ssc-")) return true;
    }
    // Inline-style check — covers pages with no DOM wrapper yet where the
    // CSS references a #ssc-* selector (unusual but possible).
    return blocks.some((b) => /#ssc-[\w-]+/.test(b.textContent));
  }

  // Fixed full-viewport backdrops — decorative full-screen elements pinned
  // with `position: fixed; inset: 0` (or equivalent) inside a scoped embed.
  // In standalone-page context they look right; in Squarespace they tile
  // across the host footer and obscure it because viewport-fixed positioning
  // ignores the embed wrapper's bounds. Standard fix: change `position:
  // fixed` to `position: absolute` so the backdrop is contained by the
  // scoped root (the root must be `position: relative` for absolute children
  // to anchor to it). Modals are intentionally fixed — skip selectors that
  // mention modal/overlay/drawer/popup, and skip rules whose z-index is in
  // the SQ-nav range or above (≥100), which signals "intentionally on top
  // of page chrome."
  function sqsDetectFixedBackdrops(blocks) {
    const found = [];
    blocks.forEach((block, blockIdx) => {
      const css = block.textContent;
      // Walk rule blocks. Skip @-rule preludes (but recurse into @media /
      // @supports bodies), capture each rule's selector + decls.
      const ruleRegex = /([^{}@]+)\{([^{}]*)\}/g;
      let m;
      while ((m = ruleRegex.exec(css)) !== null) {
        const selector = m[1].trim();
        const decls = m[2];
        if (!selector) continue;
        if (!/position\s*:\s*fixed\b/i.test(decls)) continue;
        // Full-viewport coverage signals: `inset: 0`, full sides, or 100vw/100%
        const hasInset = /inset\s*:\s*0\b/i.test(decls);
        const hasFullSides = /top\s*:\s*0\b/i.test(decls) && /(bottom|right|left)\s*:\s*0\b/i.test(decls);
        const hasFullSize = /width\s*:\s*100(?:vw|%)/i.test(decls) && /height\s*:\s*100(?:vh|%)/i.test(decls);
        if (!hasInset && !hasFullSides && !hasFullSize) continue;
        // Skip intentional overlays — modals, drawers, popups
        if (/(modal|overlay|drawer|popup|dialog|toast|tooltip)/i.test(selector)) continue;
        // Skip high-z fixed elements (≥100) — those are deliberately on top
        const zMatch = decls.match(/z-index\s*:\s*(-?\d+)/i);
        const zIndex = zMatch ? parseInt(zMatch[1], 10) : 0;
        if (zIndex >= 100) continue;
        found.push({ blockIdx, selector, ruleText: m[0], decls });
      }
    });
    return found;
  }

  // Image edge-bleed without max-width:none — flag any rule that targets an
  // <img> (selector ends in `img` or a known image class) and uses the
  // `width: calc(... + ...px)` bleed-to-edge pattern but doesn't include
  // `max-width: none`. Squarespace's site-wide `img { max-width: 100% }`
  // will silently override the calc and cap the image at parent content
  // width, producing the visible-gap-on-right symptom documented in the
  // consolidated audit skill pattern 11.
  const SQS_IMAGE_CLASS_HINTS = /\.(cimg|fcimg|card-img|hero-img|featured-photo|product-img|cover-img|gallery-img|cust-img)\b/i;
  function sqsDetectImageBleedNoMaxWidth(blocks) {
    const found = [];
    blocks.forEach((block, blockIdx) => {
      const css = block.textContent;
      const ruleRegex = /([^{}@]+)\{([^{}]*)\}/g;
      let m;
      while ((m = ruleRegex.exec(css)) !== null) {
        const selector = m[1].trim();
        const decls = m[2];
        if (!selector) continue;
        // Selector must target an <img> — either ends in `img` as the last
        // simple selector token, or matches a known image-class hint.
        const lastToken = selector.split(/[\s>+~,]/).filter(Boolean).pop() || "";
        const targetsImg = /\bimg\b/i.test(lastToken) || SQS_IMAGE_CLASS_HINTS.test(selector);
        if (!targetsImg) continue;
        // Must use the bleed-to-edge calc() pattern on width
        if (!/width\s*:\s*calc\(/i.test(decls)) continue;
        // Must NOT already declare max-width: none
        if (/max-width\s*:\s*none/i.test(decls)) continue;
        found.push({ blockIdx, selector, ruleText: m[0], decls });
      }
    });
    return found;
  }

  function sqsCollectFindings() {
    const blocks = sqsCollectStyleBlocks();
    const scoped = sqsHasScopedRoot(blocks);
    return {
      global: sqsDetectGlobalSelectors(blocks),
      naked: sqsDetectNakedTags(blocks),
      h1: sqsDetectMultipleH1(),
      zindex: sqsDetectNavZIndex(blocks),
      tweakvars: sqsDetectTweakVars(blocks),
      fonts: sqsDetectReimportedFonts(blocks),
      boxreset: sqsDetectMissingBoxReset(blocks),
      fixedBackdrop: sqsDetectFixedBackdrops(blocks),
      imgBleed: sqsDetectImageBleedNoMaxWidth(blocks),
      // Skipped when the page already has a scoped root — proven over-eager
      // (the Bar Calculator audit produced 38 false positives on JS-generated
      // stars inside the user's scoped root because the !important wasn't
      // actually needed).
      inline: scoped ? [] : sqsDetectInlineNoImportant(),
      _scoped: scoped,
    };
  }

  // Pick a default root id without guessing. Prefer the outermost `id="ssc-*"`
  // directly under `<body>`. If none exists, return empty string so the
  // modal asks the user explicitly — the prior heuristic matched substrings
  // like "wrap" and ended up picking a 50-px-wide nested wrapper on the
  // Bar Calculator (#sig1wrap), which would have killed every styled rule.
  function sqsGuessRootId() {
    for (const el of Array.from(document.body.children)) {
      if (el.closest("#claude-feedback-root")) continue;
      if (el.id && el.id.startsWith("ssc-")) return el.id;
    }
    return "";
  }

  function runSquarespaceAudit() {
    const ok = window.confirm(
      "Run the Squarespace conflict audit on this page?\n\n" +
      "It scans <style> blocks + the live DOM for the eight known SQ 7.1 Code-Injection conflicts, " +
      "then opens a modal where you pick which fixes to apply. Applied fixes POST directly to the inbox — " +
      "they bypass the pending list, so ⌘Z / clear-all will NOT undo them. To revert: refresh the page (loses the live preview) " +
      "and ask me to roll back the source-side changes."
    );
    if (!ok) return;

    // Scope-root pre-check. Without a #ssc-* root, checks 1, 2, and 7 either
    // fire exhaustively against JS-generated DOM (Bar Calc: 55 false-positive
    // inline-!important findings) or can't anchor their fixes. Ask the user
    // to wrap first before running the eight-check pass.
    const blocks = sqsCollectStyleBlocks();
    if (!sqsHasScopedRoot(blocks)) {
      sqsOpenScopeGateModal();
      return;
    }

    const findings = sqsCollectFindings();
    const total =
      findings.global.length + findings.naked.length +
      findings.h1.length + findings.zindex.length +
      findings.tweakvars.length + findings.fonts.length +
      findings.boxreset.length + findings.fixedBackdrop.length +
      findings.imgBleed.length + findings.inline.length;
    if (total === 0) {
      showToast("Squarespace audit: no issues detected", 4000);
      return;
    }
    openSqsModal(findings);
  }

  // Gate modal: shown when the audit is invoked on a page with no #ssc-*
  // root. Lets the user pick a wrapper id (queues a scope-wrap request) or
  // proceed with an unscoped audit. Reuses the cf-sqs-modal shell with a
  // gate-specific body and its own button row (the default Apply footer is
  // hidden so the choices read top-to-bottom).
  function sqsOpenScopeGateModal() {
    const suggested = sqsSuggestScopeId();
    const pageLabel = escapeHtml(document.title || location.pathname);
    const pagePath = escapeHtml(location.pathname);
    const body = $("cf-sqs-body");
    body.innerHTML = [
      '<div class="cf-sqs-gate">',
      '  <p class="cf-sqs-gate-page">',
      '    <strong>' + pageLabel + '</strong><br>',
      '    <small>' + pagePath + '</small>',
      '  </p>',
      '  <p class="cf-sqs-gate-intro">',
      '    No scoped root detected on this page (no <code>#ssc-*</code> id under <code>&lt;body&gt;</code>). ',
      '    Without one, the audit fires noisy — the selector-scope and inline-<code>!important</code> checks have no anchor and can\'t run cleanly.',
      '  </p>',
      '  <p class="cf-sqs-gate-label">Wrapper id to scope under:</p>',
      '  <input type="text" id="cf-sqs-gate-id" value="' + escapeHtml(suggested) + '" class="cf-sqs-input">',
      '  <p class="cf-sqs-gate-hint"><small>Suggested from the page title. Convention: <code>ssc-&lt;page&gt;-embed</code>.</small></p>',
      '  <div class="cf-sqs-gate-actions">',
      '    <button id="cf-sqs-gate-wrap" class="cf-btn-primary cf-btn-small">Wrap &amp; re-audit (recommended)</button>',
      '    <button id="cf-sqs-gate-unscoped" class="cf-btn cf-btn-small">Audit unscoped anyway (noisy)</button>',
      '    <button id="cf-sqs-gate-cancel" class="cf-btn cf-btn-small">Cancel</button>',
      '  </div>',
      '</div>',
    ].join("\n");
    // Hide the default Apply footer in gate mode (the gate has its own buttons).
    const modal = $("cf-sqs-modal");
    modal.classList.add("cf-visible");
    modal.classList.add("cf-sqs-gate-mode");
    $("cf-sqs-gate-wrap").addEventListener("click", () => {
      const id = ($("cf-sqs-gate-id").value || "").trim();
      if (!id) { $("cf-sqs-gate-id").focus(); return; }
      sqsRequestScopeWrap(id);
      modal.classList.remove("cf-sqs-gate-mode");
    });
    $("cf-sqs-gate-unscoped").addEventListener("click", () => {
      modal.classList.remove("cf-sqs-gate-mode");
      const findings = sqsCollectFindings();
      const total =
        findings.global.length + findings.naked.length +
        findings.h1.length + findings.zindex.length +
        findings.tweakvars.length + findings.fonts.length +
        findings.boxreset.length + findings.fixedBackdrop.length +
      findings.imgBleed.length + findings.inline.length;
      if (total === 0) {
        closeSqsModal();
        showToast("Squarespace audit: no issues detected", 4000);
        return;
      }
      openSqsModal(findings);
    });
    $("cf-sqs-gate-cancel").addEventListener("click", () => {
      modal.classList.remove("cf-sqs-gate-mode");
      closeSqsModal();
    });
  }

  // Suggest a scope id. Prefers the page title (most descriptive) over the
  // URL filename (often a generic "index"). Falls back to "ssc-page-embed".
  function sqsSuggestScopeId() {
    const slugify = (s) => (s || "")
      .toLowerCase()
      .replace(/\.[a-z0-9]+$/, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
    const fromTitle = slugify((document.title || "").split(/[|—–-]/)[0]);
    if (fromTitle && fromTitle !== "untitled") return "ssc-" + fromTitle + "-embed";
    const fromPath = slugify(location.pathname.split("/").pop());
    if (fromPath && fromPath !== "index") return "ssc-" + fromPath + "-embed";
    return "ssc-page-embed";
  }

  // POST a scoping request to the inbox. Marked source "sqs-audit-scope-request"
  // so the agent recognizes it as a structural rewrite, not a single edit.
  function sqsRequestScopeWrap(rootId) {
    const safeId = rootId.replace(/[^a-z0-9_-]/gi, "").toLowerCase();
    postFeedback([{
      id: "c-sqs-scope-" + Date.now(),
      type: "general",
      created_at: new Date().toISOString(),
      comment:
        "[sqsp-audit] Scope this page under #" + safeId + ". " +
        "Wrap everything between <body> and </body> in <div id=\"" + safeId + "\">…</div>, " +
        "then rewrite every selector in the host <style> block to scope under #" + safeId + " " +
        "(body{…} → #" + safeId + "{…}; *{…} → #" + safeId + " *{…}; naked tags + ids + classes → prepend #" + safeId + " ; " +
        "leave :root, @keyframes, @font-face, @import alone; recurse into @media). " +
        "Insert a box-model reset at the top of <style>: #" + safeId + ", #" + safeId + " * { box-sizing: border-box }. " +
        "After scoping, the inline-!important check will skip cleanly and the audit can re-run.",
    }], { source: "sqs-audit-scope-request" }).then((r) => {
      if (r.ok) {
        closeSqsModal();
        showToast("Scope-wrap request queued for #" + safeId, 5000);
      } else {
        showToast("Scope-wrap request failed (" + r.status + ")", 5000);
      }
    }).catch((err) => {
      showToast("Scope-wrap request failed: " + err.message, 5000);
    });
  }

  function openSqsModal(findings) {
    const body = $("cf-sqs-body");
    const guess = sqsGuessRootId();
    const parts = [];
    parts.push(`<p class="cf-sqs-intro">Eight checks ran against this page. Tick a finding to queue its fix as a pending text-edit; leave it unticked to skip. The root id is required for the selector-scope fixes — leave empty to skip those.${findings._scoped ? " Inline-<code>!important</code> check skipped because a scoped <code>#ssc-*</code> root was detected." : ""}</p>`);

    // Single critical decision — root id. Footer-collision / viewport-units
    // checks are gone from the audit, so no lift-offset input needed.
    parts.push(`<div class="cf-sqs-decision">`);
    parts.push(`  <label class="cf-sqs-decision-label">Root id to scope under <small>(used by global + naked-tag + box-reset fixes; prefer the outermost <code>#ssc-*</code> id under &lt;body&gt;)</small></label>`);
    parts.push(`  <input type="text" id="cf-sqs-root" value="${escapeHtml(guess)}" placeholder="e.g. ssc-pricing-embed" class="cf-sqs-input">`);
    parts.push(`</div>`);

    const section = (name, label, sev, items, render) => {
      if (items.length === 0) return;
      parts.push(`<div class="cf-sqs-section cf-sqs-sev-${sev}">`);
      parts.push(`  <h4>${label} <span class="cf-sqs-count">${items.length}</span></h4>`);
      items.forEach((item, i) => {
        const id = `cf-sqs-${name}-${i}`;
        parts.push(`  <label class="cf-sqs-item">`);
        parts.push(`    <input type="checkbox" id="${id}" data-finding="${name}" data-idx="${i}" checked>`);
        parts.push(`    <div class="cf-sqs-item-text">${render(item, i)}</div>`);
        parts.push(`  </label>`);
      });
      parts.push(`</div>`);
    };
    section("global", "Global CSS selectors — bleed into Squarespace's page wrapper", "critical", findings.global, (f) =>
      `<code>${escapeHtml(f.selector)}</code> &mdash; scope under <code>#&lt;rootId&gt;</code>`
    );
    section("naked", "Naked tag / SQ-chrome selectors — collide with Squarespace typography or chrome", "critical", findings.naked, (f) =>
      `<code>${escapeHtml(f.selector)}</code> &mdash; prepend <code>#&lt;rootId&gt; </code>`
    );
    section("h1", "Multiple <code>&lt;h1&gt;</code> elements — SEO + accessibility", "critical", findings.h1, (f, i) => {
      const choices = ["h2", "h3", "p"].map((t) =>
        `<option value="${t}">${t}</option>`
      ).join("");
      return `<code>&lt;h1&gt;</code> "${escapeHtml(f.snippet)}" &mdash; rewrite as <select id="cf-sqs-h1-${i}" class="cf-sqs-inline-select">${choices}</select>`;
    });
    section("zindex", "<code>z-index</code> in the 100–1000 nav range — under Squarespace's header / mobile-nav stack", "warning", findings.zindex, (f) =>
      `<code>${escapeHtml(f.match)}</code> &mdash; rewrite to <code>99</code> (passive) or <code>9999</code> (intentional overlay; defaulting to 99)`
    );
    section("tweakvars", "<code>--tweak-*</code> CSS variables — collide with Squarespace's internal style tokens", "warning", findings.tweakvars, (f) =>
      `<code>${escapeHtml(f.match)}</code> &mdash; rename to <code>--ssc-${escapeHtml(f.match.replace(/^--tweak-/, ""))}</code>`
    );
    section("fonts", "Re-imported fonts — Squarespace likely loads these already", "warning", findings.fonts, (f) =>
      `<code>${escapeHtml(f.match)}</code> &mdash; delete the <code>@import</code>; SQ provides the font${f.family ? " (<em>" + escapeHtml(f.family) + "</em>)" : ""}`
    );
    section("boxreset", "Missing <code>box-sizing: border-box</code> reset on a declared scoped root", "info", findings.boxreset, (f) =>
      `<code>#${escapeHtml(f.rootId)}</code> &mdash; insert <code>#${escapeHtml(f.rootId)}, #${escapeHtml(f.rootId)} * { box-sizing: border-box }</code>`
    );
    section("fixedBackdrop", "<code>position: fixed</code> full-viewport backdrop — will tile across Squarespace's footer and obscure it", "warning", findings.fixedBackdrop, (f) =>
      `<code>${escapeHtml(f.selector)}</code> &mdash; change to <code>position: absolute</code> (scoped root needs <code>position: relative</code> too)`
    );
    section("imgBleed", "Image edge-bleed without <code>max-width: none</code> — Squarespace's <code>img { max-width: 100% }</code> will cap the <code>calc()</code> and leave a gap on the right", "warning", findings.imgBleed, (f) =>
      `<code>${escapeHtml(f.selector)}</code> &mdash; add <code>max-width: none !important</code> and <code>!important</code> on the <code>width: calc(...)</code>`
    );
    section("inline", "Inline styles missing <code>!important</code> (no scoped root detected — Squarespace's stylesheet may win)", "info", findings.inline, (f) =>
      `<code>&lt;${escapeHtml(f.el.tagName.toLowerCase())}&gt;</code>: <code>${escapeHtml(f.prop)}: ${escapeHtml(f.val)}</code>`
    );

    body.innerHTML = parts.join("\n");
    body._findings = findings;
    $("cf-sqs-modal").classList.add("cf-visible");
  }

  function closeSqsModal() {
    $("cf-sqs-modal").classList.remove("cf-visible");
    const body = $("cf-sqs-body");
    if (body) { body.innerHTML = ""; body._findings = null; }
  }

  // Apply the user's selections. Audit fixes do NOT enter `pending` and do
  // NOT route through submitBatch — they're systemic cleanups, not feedback
  // comments. The fix entries are batched into a single POST to /feedback
  // marked `source: "sqs-audit"` so the agent can recognize them as a
  // distinct apply path. Live DOM still gets the changes for immediate
  // preview; revert means refresh the page + ask the agent to roll back
  // the source-side edits.
  function sqsApplySelected() {
    const body = $("cf-sqs-body");
    const findings = body && body._findings;
    if (!findings) { closeSqsModal(); return; }
    const rootId = ($("cf-sqs-root").value || "").trim();
    const blocks = sqsCollectStyleBlocks();
    const auditComments = [];
    const mkId = () => "c-sqs-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);
    const pushAuditEdit = (el, oldOuter, newOuter, comment, oldHtml, newHtml, oldText, newText) => {
      auditComments.push({
        id: mkId(),
        type: "text-edit",
        created_at: new Date().toISOString(),
        comment: comment,
        elements: [anchorInfo(el)],
        original_text: oldText != null ? oldText : (el.innerText || ""),
        new_text: newText != null ? newText : (el.innerText || ""),
        original_html: oldHtml != null ? oldHtml : el.innerHTML,
        new_html: newHtml != null ? newHtml : el.innerHTML,
        original_outer_html: oldOuter,
        new_outer_html: newOuter,
      });
    };

    // Group style-block changes per block so multiple rewrites in the same
    // <style> share one audit entry.
    const blockEdits = new Map(); // blockIdx → new textContent
    const getBlockText = (idx) => blockEdits.has(idx)
      ? blockEdits.get(idx)
      : blocks[idx].textContent;
    const setBlockText = (idx, txt) => blockEdits.set(idx, txt);

    const checked = (name, i) => {
      const cb = document.getElementById(`cf-sqs-${name}-${i}`);
      return cb && cb.checked;
    };

    // CHECK 1 + 2 — selector scoping in <style> blocks
    const scopeFixes = [];
    if (rootId) {
      findings.global.forEach((f, i) => { if (checked("global", i)) scopeFixes.push(f); });
      findings.naked.forEach((f, i) => { if (checked("naked", i)) scopeFixes.push(f); });
    }
    scopeFixes.forEach((f) => {
      const head = f.head;
      const cur = getBlockText(f.blockIdx);
      const escHead = head.replace(/[*.#]/g, "\\$&");
      let next;
      if (head === "body" || head === "html") {
        next = cur.replace(new RegExp("(^|[\\s\\},;])" + escHead + "(?=[\\s\\{,.\\[#:>+~])", "gm"), "$1#" + rootId);
      } else if (head === "*") {
        next = cur.replace(/(^|[\s\},;])\*(?=[\s\{,])/gm, "$1#" + rootId + " *");
      } else {
        next = cur.replace(new RegExp("(^|[\\s\\},;])" + escHead + "(?=[\\s\\{,.\\[#:>+~])", "gm"), "$1#" + rootId + " " + head);
      }
      setBlockText(f.blockIdx, next);
    });

    // CHECK 3 — multiple H1: rewrite the tag in the live DOM
    findings.h1.forEach((f, i) => {
      if (!checked("h1", i)) return;
      const sel = document.getElementById("cf-sqs-h1-" + i);
      const newTag = (sel && sel.value) || "h2";
      const oldEl = f.el;
      const original_outer_html = oldEl.outerHTML;
      const fresh = document.createElement(newTag);
      for (const attr of Array.from(oldEl.attributes)) fresh.setAttribute(attr.name, attr.value);
      while (oldEl.firstChild) fresh.appendChild(oldEl.firstChild);
      oldEl.replaceWith(fresh);
      pushAuditEdit(fresh, original_outer_html, fresh.outerHTML,
        "Squarespace audit: rewrote a duplicate <h1> as <" + newTag + ">");
    });

    // CHECK 4 — z-index in nav range
    findings.zindex.forEach((f, i) => {
      if (!checked("zindex", i)) return;
      const cur = getBlockText(f.blockIdx);
      const before = cur.slice(0, f.offset);
      const after = cur.slice(f.offset + f.match.length);
      setBlockText(f.blockIdx, before + "z-index: 99" + after);
    });

    // CHECK 5 — --tweak-* vars: rename to --ssc-*
    findings.tweakvars.forEach((f, i) => {
      if (!checked("tweakvars", i)) return;
      const cur = getBlockText(f.blockIdx);
      const oldName = f.match;
      const newName = oldName.replace(/^--tweak-/, "--ssc-");
      const re = new RegExp(oldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
      setBlockText(f.blockIdx, cur.replace(re, newName));
    });

    // CHECK 6 — re-imported fonts: delete the @import line
    findings.fonts.forEach((f, i) => {
      if (!checked("fonts", i)) return;
      const cur = getBlockText(f.blockIdx);
      const re = new RegExp("\\s*" + f.match.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
      setBlockText(f.blockIdx, cur.replace(re, ""));
    });

    // CHECK 7 — missing box-model reset on a declared scope
    findings.boxreset.forEach((f, i) => {
      if (!checked("boxreset", i)) return;
      let targetIdx = 0;
      for (let j = 0; j < blocks.length; j++) {
        if (getBlockText(j).indexOf("#" + f.rootId) !== -1) { targetIdx = j; break; }
      }
      const cur = getBlockText(targetIdx);
      const reset = "#" + f.rootId + ", #" + f.rootId + " * { box-sizing: border-box; }\n";
      setBlockText(targetIdx, reset + cur);
    });

    // CHECK 9 — fixed-backdrop → absolute. Match the captured ruleText in the
    // current block text and rewrite the first `position: fixed` inside it.
    findings.fixedBackdrop.forEach((f, i) => {
      if (!checked("fixedBackdrop", i)) return;
      const cur = getBlockText(f.blockIdx);
      const idx = cur.indexOf(f.ruleText);
      if (idx === -1) return;
      const fixed = f.ruleText.replace(/position\s*:\s*fixed/i, "position: absolute");
      setBlockText(f.blockIdx, cur.slice(0, idx) + fixed + cur.slice(idx + f.ruleText.length));
    });

    // CHECK 10 — image bleed without max-width:none. Inject `max-width: none
    // !important;` immediately before the `width: calc(...)` declaration AND
    // append `!important` to the calc width so SQ's `img { max-width: 100% }`
    // can't override it.
    findings.imgBleed.forEach((f, i) => {
      if (!checked("imgBleed", i)) return;
      const cur = getBlockText(f.blockIdx);
      const idx = cur.indexOf(f.ruleText);
      if (idx === -1) return;
      let fixed = f.ruleText;
      // Append !important to the calc width if not already present
      fixed = fixed.replace(/(width\s*:\s*calc\([^)]*\))(?!\s*!important)/i, "$1 !important");
      // Insert max-width: none !important before the width declaration
      fixed = fixed.replace(/(width\s*:\s*calc\()/i, "max-width: none !important; $1");
      setBlockText(f.blockIdx, cur.slice(0, idx) + fixed + cur.slice(idx + f.ruleText.length));
    });

    // CHECK 8 — inline missing !important (contextual)
    findings.inline.forEach((f, i) => {
      if (!checked("inline", i)) return;
      const styleAttr = f.el.getAttribute("style") || "";
      const newAttr = styleAttr.replace(f.originalDecl, f.prop + ": " + f.val + " !important");
      const original_outer_html = f.el.outerHTML;
      f.el.setAttribute("style", newAttr);
      pushAuditEdit(f.el, original_outer_html, f.el.outerHTML,
        "Squarespace audit: add !important to inline " + f.prop);
    });

    // Commit style-block edits — one audit entry per <style> block touched
    blockEdits.forEach((newText, idx) => {
      const styleEl = blocks[idx];
      const original_outer_html = styleEl.outerHTML;
      const oldText = styleEl.textContent;
      styleEl.textContent = newText;
      pushAuditEdit(styleEl, original_outer_html, styleEl.outerHTML,
        "Squarespace audit: rewrote CSS in <style> block #" + (idx + 1),
        oldText, newText, oldText, newText);
    });

    closeSqsModal();
    if (auditComments.length === 0) {
      showToast("no fixes applied", 3000);
      return;
    }

    showToast("Squarespace audit: posting " + auditComments.length + " fix" + (auditComments.length === 1 ? "" : "es") + "…", 2000);
    postFeedback(auditComments, { source: "sqs-audit" }).then((resp) => {
      if (!resp.ok) throw new Error("server returned " + resp.status);
      showToast("Squarespace audit: posted " + auditComments.length + " fix" + (auditComments.length === 1 ? "" : "es") + " to inbox", 4000);
    }).catch((err) => {
      console.error("audit post failed", err);
      showToast("audit post failed: " + err.message, 5000);
    });
  }

  // ---------------- Copy page HTML ----------------
  // Clone the live <html>, strip everything the feedback library injected
  // (root div, /lib/* link + script tags, cf-* classes / IDs / attributes,
  // contenteditable / spellcheck leftovers, empty style="" artifacts) and
  // return a clipboard-ready string the user can drop into a code block.
  function getCleanPageHtml() {
    const clone = document.documentElement.cloneNode(true);
    clone.querySelectorAll(
      "#claude-feedback-root, " +
      "link[href*='/lib/feedback.css'], " +
      "script[src*='/lib/feedback.js'], " +
      "script[src*='/lib/html2canvas']"
    ).forEach((n) => n.remove());
    clone.querySelectorAll(".cf-edit-marker, .cf-snapshot-rect").forEach((n) => n.remove());
    const SESSION_CLASSES = [
      "cf-editing-target", "cf-editing-image",
      "cf-elem-selected", "cf-elem-hover", "cf-elem-mode",
      "cf-has-pending-edit", "cf-pending-edit-hover",
      "cf-change-active", "cf-pulse", "cf-snapshot-armed",
    ];
    clone.querySelectorAll("*").forEach((el) => {
      SESSION_CLASSES.forEach((c) => el.classList.remove(c));
      if (el.classList.length === 0) el.removeAttribute("class");
      if (el.dataset && el.dataset.cfId !== undefined) delete el.dataset.cfId;
      if (el.dataset && el.dataset.cfChange !== undefined) delete el.dataset.cfChange;
      el.removeAttribute("contenteditable");
      el.removeAttribute("spellcheck");
      if (el.getAttribute("style") === "") el.removeAttribute("style");
    });
    return "<!DOCTYPE html>\n" + clone.outerHTML;
  }
  function copyPageHtml() {
    const html = getCleanPageHtml();
    const n = html.length;
    const fmt = (x) => x.toLocaleString();
    const done = () => showToast("page HTML copied — " + fmt(n) + " characters", 3000);
    const fail = (err) => {
      console.error("clipboard write failed", err);
      // Fallback: a hidden textarea + execCommand("copy") works in older
      // contexts and when clipboard-write permission is denied.
      const ta = document.createElement("textarea");
      ta.value = html;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        const ok = document.execCommand("copy");
        if (ok) done(); else showToast("clipboard write failed", 4000);
      } catch (e) {
        showToast("clipboard write failed: " + e.message, 4000);
      }
      ta.remove();
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(html).then(done).catch(fail);
    } else {
      fail(new Error("Clipboard API unavailable"));
    }
  }

  // ---------------- ID + POST helpers ----------------
  function newCommentId(suffix) {
    const base = "c-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);
    return suffix ? base + "-" + suffix : base;
  }
  // Single source of truth for the batch envelope. submitBatch handles the
  // pending-list flow (and its own state bookkeeping); use this for non-pending
  // posts (audit fixes, scope-wrap request, undo, agent-prompt replies).
  function postFeedback(comments, opts) {
    const batch = {
      submitted_at: new Date().toISOString(),
      page_url: window.location.pathname,
      comments: comments,
    };
    if (opts && opts.source) batch.source = opts.source;
    return fetch(FEEDBACK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(batch),
    });
  }

  // ---------------- LocalStorage ----------------
  function loadLS() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || "{}"); } catch { return {}; }
  }
  let _saveLSWarned = false;
  function saveLS() {
    const cur = loadLS();
    cur.pending = pending;
    cur.lastSubmittedBatch = lastSubmittedBatch;
    cur.answeredPromptIds = Array.from(answeredPromptIds);
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(cur));
    } catch (e) {
      // QuotaExceededError most commonly. Don't propagate — the UI calls
      // saveLS on every action and an uncaught throw locks input handlers.
      if (!_saveLSWarned) {
        _saveLSWarned = true;
        try { showToast("storage full — submit your batch to clear pending", 5000); } catch {}
      }
    }
  }

  // ---------------- Anchors ----------------
  // Running anchor counter — used by both the initial assignAnchors pass
  // and the MutationObserver below so dynamically-added elements continue
  // the same numbering rather than restarting at 1 (which would collide
  // with the static-DOM anchors).
  let _cfAnchorCounter = 0;
  let _cfAnchorObserver = null;

  function assignAnchors() {
    document.querySelectorAll("body *").forEach((el) => {
      if (insideOurUI(el)) return;
      if (el.dataset.cfId) return;
      if (!isCommentable(el)) return;
      el.dataset.cfId = "el-" + (++_cfAnchorCounter);
    });
    // Watch the body for dynamically added elements (JS that builds DOM via
    // innerHTML, e.g. the bar calc's calculate() rebuilds #metricGrid after
    // every press). Without this, the static-DOM .metric children only
    // commentable target is their parent #metricGrid — too coarse.
    if (!_cfAnchorObserver) {
      _cfAnchorObserver = new MutationObserver((mutations) => {
        for (const m of mutations) {
          // Every renderPending/renderHistory re-render fires mutations whose
          // target is inside #claude-feedback-root — a frequent and noisy
          // source. Short-circuit on the target before walking added nodes.
          if (m.target && m.target.nodeType === 1 && insideOurUI(m.target)) continue;
          for (const node of m.addedNodes) {
            if (!node || node.nodeType !== 1) continue;
            if (insideOurUI(node)) continue;
            const queue = [node];
            while (queue.length) {
              const el = queue.shift();
              if (!el || el.nodeType !== 1) continue;
              if (insideOurUI(el)) continue;
              if (!el.dataset.cfId && isCommentable(el)) {
                el.dataset.cfId = "el-" + (++_cfAnchorCounter);
              }
              for (const child of el.children) queue.push(child);
            }
          }
        }
      });
      _cfAnchorObserver.observe(document.body, { childList: true, subtree: true });
    }
  }

  function isCommentable(el) {
    if (!el || el.nodeType !== 1) return false;
    if (insideOurUI(el)) return false;
    if (COMMENTABLE_TAGS.has(el.tagName)) return true;
    for (const c of el.classList) if (COMMENTABLE_CLASSES.has(c)) return true;
    // Substring match — catches anything classed as a hint / caption / help
    // / description / meta / annotation / note across BEM / utility-class /
    // ad-hoc naming. Lower-cased once to avoid per-class case work.
    for (const c of el.classList) {
      const lc = c.toLowerCase();
      for (const needle of COMMENTABLE_CLASS_SUBSTRINGS) {
        if (lc.indexOf(needle) !== -1) return true;
      }
    }
    // Also consider any element with an id (likely a meaningful section)
    if (el.id && el.id.length > 0 && !el.id.startsWith("cf-")) return true;
    return false;
  }

  function findCommentableAncestor(node) {
    let el = node && node.nodeType === 3 ? node.parentElement : node;
    while (el && el !== document.body && el !== document.documentElement) {
      if (insideOurUI(el)) return null;
      if (el.dataset && el.dataset.cfId) return el;
      if (isCommentable(el)) return el;
      el = el.parentElement;
    }
    return null;
  }

  function insideOurUI(el) {
    if (!el || !el.closest) return false;
    // [data-cf-ignore] is the host-page opt-out: any element marked with that
    // attribute (or its descendants) becomes invisible to feedback handlers.
    return !!el.closest("#claude-feedback-root, .cf-editor, .cf-selection-popup, .cf-tour-bar, .cf-toast, .cf-edit-toolbar, .cf-edit-marker, [data-cf-ignore]");
  }

  function stableSelector(el) {
    if (!el) return "";
    if (el.id) return "#" + CSS.escape(el.id);
    if (el.dataset && el.dataset.cfId) return '[data-cf-id="' + el.dataset.cfId + '"]';
    // walk up for an id or data-cf-id
    let cur = el.parentElement;
    let suffix = " > " + el.tagName.toLowerCase();
    let path = el.tagName.toLowerCase();
    while (cur && cur !== document.body) {
      if (cur.id) return "#" + CSS.escape(cur.id) + " " + path;
      if (cur.dataset && cur.dataset.cfId) return '[data-cf-id="' + cur.dataset.cfId + '"] ' + path;
      const idx = Array.prototype.indexOf.call(cur.children, el) + 1;
      path = cur.tagName.toLowerCase() + ":nth-child(" + idx + ") > " + path;
      el = cur;
      cur = cur.parentElement;
    }
    return path;
  }

  function anchorInfo(el) {
    if (!el) return null;
    return {
      cf_id: el.dataset.cfId || null,
      selector: stableSelector(el),
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      text_snippet: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, TEXT_SNIPPET_MAX),
      outer_html: truncate(el.outerHTML, OUTER_HTML_MAX),
    };
  }

  function truncate(s, n) {
    if (!s) return "";
    if (s.length <= n) return s;
    return s.slice(0, n) + "…";
  }

  // Look up a live element by the anchor info captured at comment-time.
  // Prefers cf_id (stable), falls back to the captured selector.
  function findElementByAnchorInfo(anchor) {
    if (!anchor) return null;
    if (anchor.cf_id) {
      const el = document.querySelector('[data-cf-id="' + anchor.cf_id + '"]');
      if (el) return el;
    }
    if (anchor.selector) {
      try { return document.querySelector(anchor.selector); } catch (e) { /* invalid */ }
    }
    return null;
  }


  // ---------------- UI: build DOM ----------------
  function buildUI() {
    const root = document.createElement("div");
    root.id = "claude-feedback-root";
    root.innerHTML = [
      '<div class="cf-launcher">',
      '  <button id="cf-clear-all-float" class="cf-clear-all-float" title="Discard all pending comments">',
      '    <span class="cf-clear-all-label">clear all</span>',
      '    <span class="cf-clear-all-count" id="cf-clear-all-count"></span>',
      '  </button>',
      '  <button id="cf-toggle" class="cf-btn-primary" title="Feedback (press F)">',
      '    <span>feedback</span> <span class="cf-kbd-hint">F</span> <span id="cf-badge"></span>',
      '  </button>',
      '</div>',
      '<div id="cf-panel" class="cf-panel" aria-hidden="true">',
      '  <div class="cf-panel-header">',
      '    <strong>Feedback</strong>',
      '    <button id="cf-help-toggle" class="cf-icon-btn cf-help-btn" title="Quick guide (?)" aria-label="Quick guide">?</button>',
      '    <button id="cf-close" class="cf-icon-btn" aria-label="Close">×</button>',
      '  </div>',
      '  <div class="cf-panel-tools">',
      '    <button id="cf-copy-html" class="cf-btn cf-btn-small cf-copy-html-btn" title="Copy current page HTML to clipboard (clean — no feedback-library injection)" aria-label="Copy page HTML">📋 copy HTML</button>',
      '    <button id="cf-sqs-audit" class="cf-btn cf-btn-small cf-sqs-audit-btn" title="Squarespace conflict audit — scans CSS + layout for Code-Injection issues and queues fixes" aria-label="Squarespace review">🔍 sqsp review</button>',
      '  </div>',
      '  <div class="cf-tabs">',
      '    <button data-tab="pending" class="cf-tab cf-tab-active" title="Pending (P)">Pending <span class="cf-kbd-hint">P</span></button>',
      '    <button data-tab="history" class="cf-tab" title="History (H)">History <span class="cf-kbd-hint">H</span></button>',
      '  </div>',
      '  <div id="cf-tab-pending" class="cf-tab-pane cf-tab-pane-active">',
      '    <div id="cf-pending-list" class="cf-list"></div>',
      '    <div class="cf-panel-actions">',
      '      <button id="cf-elem-toggle" class="cf-btn" title="Select element (E)">🎯 select <span class="cf-kbd-hint">E</span></button>',
      '      <button id="cf-add-general" class="cf-btn" title="General comment (G)">+ general <span class="cf-kbd-hint">G</span></button>',
      '    </div>',
      '    <div class="cf-panel-actions cf-grid-actions">',
      '      <button id="cf-grid-show" class="cf-btn cf-btn-small" title="Show 24px grid overlay">⊞ show grid</button>',
      '      <button id="cf-grid-snap" class="cf-btn cf-btn-small" title="Snap resize to 24px grid">🧲 snap to grid</button>',
      '    </div>',
      '    <div class="cf-panel-actions" style="margin-top:6px;">',
      '      <button id="cf-submit" class="cf-btn-primary" disabled title="Submit pending batch (⌘S)">submit batch <span class="cf-kbd-hint">⌘S</span></button>',
      '      <button id="cf-clear-all" class="cf-btn cf-btn-ghost" disabled title="Discard all pending comments">clear all</button>',
      '    </div>',
      '    <p class="cf-hint"><strong>Highlight text</strong> to comment on a selection. <strong>Double-click text</strong> to edit it in place — toolbar has bold/italic/underline, lists, links, alignment, case, font, color, border, radius, padding. <strong>Double-click an image</strong> to drag its corners and resize (border + radius stay available). Press <kbd>E</kbd> to select elements (then comment or <strong>delete</strong>), <kbd>G</kbd> for a general note. Hold <kbd>Alt</kbd> + drag a rectangle to <strong>snapshot a region</strong>. Toggle a 24 px grid + snap from the panel. Press <kbd>?</kbd> for the full guide. <kbd>Esc</kbd> cancels.</p>',
      '  </div>',
      '  <div id="cf-tab-history" class="cf-tab-pane">',
      '    <div id="cf-history-list" class="cf-list"></div>',
      '    <div class="cf-panel-actions">',
      '      <button id="cf-tour" class="cf-btn" disabled title="Start tour (T)">start tour <span class="cf-kbd-hint">T</span></button>',
      '    </div>',
      '  </div>',
      '</div>',
      // Squarespace audit modal — opened by the 🔍 sqs button. Renders
      // findings + per-item apply/skip checkboxes + an optional root-id input
      // for the global-selector fix. Lives outside .cf-panel so it's modal.
      '<div id="cf-sqs-modal" class="cf-sqs-modal" role="dialog" aria-label="Squarespace audit" aria-hidden="true">',
      '  <div class="cf-sqs-inner">',
      '    <div class="cf-sqs-header">',
      '      <strong>🔍 Squarespace conflict audit</strong>',
      '      <button id="cf-sqs-close" class="cf-icon-btn" aria-label="Close">×</button>',
      '    </div>',
      '    <div id="cf-sqs-body" class="cf-sqs-body"></div>',
      '    <div class="cf-sqs-actions">',
      '      <button id="cf-sqs-cancel" class="cf-btn cf-btn-small">cancel</button>',
      '      <button id="cf-sqs-apply" class="cf-btn-primary cf-btn-small">apply selected</button>',
      '    </div>',
      '  </div>',
      '</div>',
      // quick guide overlay (? key or panel-header ? button)
      '<div id="cf-help" class="cf-help" role="dialog" aria-label="Quick guide" aria-hidden="true">',
      '  <div class="cf-help-inner">',
      '    <div class="cf-help-header">',
      '      <strong>Quick guide</strong>',
      '      <button id="cf-help-close" class="cf-icon-btn" aria-label="Close">×</button>',
      '    </div>',
      '    <div class="cf-help-body">',
      '      <section>',
      '        <h4>Quick start</h4>',
      '        <ul>',
      '          <li><strong>Highlight any text</strong> on the page → click <em>comment</em>.</li>',
      '          <li><strong>Double-click text</strong> to edit it in place. Hit <kbd>⌘↵</kbd> or click outside to submit.</li>',
      '          <li>Press <kbd>E</kbd>, then click any block (image, table, paragraph) to comment on it. Or hit <strong>delete</strong> in the popup to remove it from source — the in-list trashcan restores it if you change your mind.</li>',
      '          <li>Hold <kbd>Alt</kbd> and <strong>drag a rectangle</strong> to snapshot a region of the page.</li>',
      '          <li>Press <kbd>G</kbd> for a general page-level comment.</li>',
      '        </ul>',
      '      </section>',
      '      <section>',
      '        <h4>While editing text</h4>',
      '        <ul>',
      '          <li>Row 1: <strong>B</strong> / <strong>I</strong> / <strong>U</strong> / bullet / numbered / <strong>link</strong> / unlink / align / case.</li>',
      '          <li>Row 2: font family / size / <strong>line height</strong> / color / background / reset.</li>',
      '          <li>Row 3: border weight / border color / border radius / <strong>padding</strong> — number inputs have custom <kbd>▲</kbd>/<kbd>▼</kbd> spinners.</li>',
      '          <li>Editing a <strong>list</strong>? Font / size / color / weight / align push to every <kbd>&lt;li&gt;</kbd> directly so child-level CSS like <code>.list li { font-size: 14px }</code> can\'t beat the change.</li>',
      '          <li><strong>Link</strong> prompts for a URL — protocol-less inputs become <code>https://</code> automatically. Empty URL removes the link; <code>javascript:</code> / <code>data:</code> schemes are rejected.</li>',
      '          <li>Drag any of the four gold corner handles to <strong>resize</strong>. Edges snap to nearby elements within ~8 px (and to the 24 px grid when <em>snap to grid</em> is on).</li>',
      '          <li>Double-click a <strong>different</strong> element to commit and switch targets in one motion.</li>',
      '          <li><kbd>Esc</kbd> cancels and restores the element to its original state.</li>',
      '        </ul>',
      '      </section>',
      '      <section>',
      '        <h4>Pending list & markers</h4>',
      '        <ul>',
      '          <li>Every queued change drops a gold marker on its element — <strong>✎</strong> for text/style edits, <strong>💬</strong> for comments. Hover to outline the target.</li>',
      '          <li>Click a marker for <em>refine</em> (reopen the original editor) or <em>remove</em> (revert the visual change and drop the entry). The in-list <em>remove</em> link only drops the entry — it does not revert.</li>',
      '          <li>Toggle <strong>⊞ show grid</strong> for a 24 px overlay; <strong>🧲 snap to grid</strong> adds grid lines as resize-snap candidates. Both persist.</li>',
      '        </ul>',
      '      </section>',
      '      <section>',
      '        <h4>Keyboard</h4>',
      '        <table class="cf-help-keys">',
      '          <tr><td><kbd>F</kbd></td><td>toggle panel</td><td><kbd>⌘B</kbd> / <kbd>⌘I</kbd> / <kbd>⌘U</kbd></td><td>bold / italic / underline (in editor)</td></tr>',
      '          <tr><td><kbd>P</kbd></td><td>pending tab</td><td><kbd>⌘↵</kbd></td><td>confirm edit</td></tr>',
      '          <tr><td><kbd>H</kbd></td><td>history tab</td><td><kbd>⌘S</kbd></td><td>submit batch</td></tr>',
      '          <tr><td colspan="2"></td><td><kbd>⌘Z</kbd></td><td>undo last pending entry</td></tr>',
      '          <tr><td><kbd>E</kbd></td><td>element mode</td><td><kbd>Esc</kbd></td><td>cancel / close</td></tr>',
      '          <tr><td><kbd>?</kbd></td><td>quick guide</td><td><kbd>R</kbd></td><td>reload (when banner shows)</td></tr>',
      '          <tr><td><kbd>G</kbd></td><td>general comment</td><td><kbd>T</kbd></td><td>walkthrough</td></tr>',
      '          <tr><td><kbd>C</kbd></td><td>smart comment</td><td></td><td></td></tr>',
      '          <tr><td><kbd>Alt</kbd>+drag</td><td>snapshot region</td><td><kbd>⇧</kbd>+arrow</td><td>move launcher pill</td></tr>',
      '        </table>',
      '      </section>',
      '      <section>',
      '        <h4>Copy page HTML</h4>',
      '        <ul>',
      '          <li>The <strong>📋 copy HTML</strong> button in the panel header copies the current page\'s rendered HTML to your clipboard — clean (no <code>cf-*</code> classes, no <code>data-cf-*</code> attributes, no <code>/lib/</code> injection). Drop it straight into a code block, Squarespace injection, or anywhere else you need the source.</li>',
      '        </ul>',
      '      </section>',
      '      <section>',
      '        <h4>Squarespace audit</h4>',
      '        <ul>',
      '          <li>The <strong>🔍 sqsp review</strong> button in the panel tools row runs an eight-check audit for Squarespace 7.1 Code-Injection conflicts: global selectors (<code>body</code> / <code>html</code> / <code>*</code>), naked tag + SQ-chrome selectors (<code>h1</code> … <code>.site-footer</code> etc.), multiple <code>&lt;h1&gt;</code> elements, <code>z-index</code> in the 100–1000 nav range, <code>--tweak-*</code> CSS variables, re-imported site fonts, missing <code>box-sizing</code> reset on declared scopes, and inline styles missing <code>!important</code> (contextual — skipped when a <code>#ssc-*</code> scoped root is detected).</li>',
      '          <li>The modal asks for a <strong>root id</strong> to scope selectors under (auto-detected: outermost <code>#ssc-*</code> directly under <code>&lt;body&gt;</code>; you fill it in if missing). Per-item checkboxes let you skip any finding; H1 findings include a per-element dropdown for the rewrite target tag. Apply queues each fix as a pending text-edit — they go through the standard submit / ⌘Z / marker-menu revert flow.</li>',
      '        </ul>',
      '      </section>',
      '      <section>',
      '        <h4>Launcher</h4>',
      '        <ul>',
      '          <li><strong>Drag the gold pill</strong> to any viewport corner — it snaps on release. Or <kbd>⇧</kbd> + an arrow key.</li>',
      '          <li>Click the pill to open this panel.</li>',
      '        </ul>',
      '      </section>',
      '    </div>',
      '  </div>',
      '</div>',
      // text-selection popup
      '<div id="cf-selection-popup" class="cf-selection-popup">',
      '  <button id="cf-popup-comment" class="cf-btn-primary cf-btn-small">💬 comment</button>',
      '</div>',
      // element-selection popup
      '<div id="cf-elem-popup" class="cf-selection-popup">',
      '  <button id="cf-elem-popup-comment" class="cf-btn-primary cf-btn-small">💬 comment</button>',
      '  <button id="cf-elem-popup-delete"  class="cf-btn cf-btn-small cf-btn-danger" title="Remove from source (queues a delete; reflow happens immediately)">🗑 delete</button>',
      '  <button id="cf-elem-popup-clear"   class="cf-btn cf-btn-small">clear</button>',
      '</div>',
      // editor
      '<div id="cf-editor" class="cf-editor" role="dialog" aria-label="Comment editor">',
      '  <div class="cf-editor-quote" id="cf-editor-quote"></div>',
      '  <textarea id="cf-editor-text" placeholder="your comment or question…" rows="3"></textarea>',
      '  <div class="cf-editor-actions">',
      '    <button id="cf-editor-cancel" class="cf-btn cf-btn-small">cancel</button>',
      '    <button id="cf-editor-save" class="cf-btn-primary cf-btn-small">add (⌘↵)</button>',
      '  </div>',
      '</div>',
      // tour bar
      '<div id="cf-tour-bar" class="cf-tour-bar">',
      '  <button id="cf-tour-prev" class="cf-btn cf-btn-small" title="Prev (←)">← prev</button>',
      '  <span id="cf-tour-label" class="cf-tour-label"></span>',
      '  <button id="cf-tour-next" class="cf-btn cf-btn-small" title="Next (→)">next →</button>',
      '  <button id="cf-tour-exit" class="cf-btn cf-btn-small" title="Exit (Esc)">exit</button>',
      '</div>',
      // grid overlay — appears under our chrome but over the page when toggled on
      '<div id="cf-grid-overlay" class="cf-grid-overlay" aria-hidden="true"></div>',
      // pending-marker action menu (shown when user clicks a ✎ marker)
      '<div id="cf-marker-menu" class="cf-marker-menu" role="menu">',
      '  <button id="cf-marker-refine" class="cf-btn cf-btn-small">refine</button>',
      '  <button id="cf-marker-remove" class="cf-btn cf-btn-small cf-btn-ghost">remove</button>',
      '</div>',
      '<div id="cf-toast" class="cf-toast"></div>',
      // inline text-edit toolbar (floats near an element while it is being edited)
      '<div id="cf-resize-tl" class="cf-resize-handle cf-resize-tl" data-corner="tl" title="Drag to resize" aria-label="Resize from top-left"></div>',
      '<div id="cf-resize-tr" class="cf-resize-handle cf-resize-tr" data-corner="tr" title="Drag to resize" aria-label="Resize from top-right"></div>',
      '<div id="cf-resize-bl" class="cf-resize-handle cf-resize-bl" data-corner="bl" title="Drag to resize" aria-label="Resize from bottom-left"></div>',
      '<div id="cf-resize-br" class="cf-resize-handle cf-resize-br" data-corner="br" title="Drag to resize" aria-label="Resize from bottom-right"></div>',
      '<div id="cf-edit-toolbar" class="cf-edit-toolbar" role="toolbar" aria-label="Edit text">',
      '  <div class="cf-edit-toolbar-row">',
      '    <span class="cf-edit-toolbar-label">editing text</span>',
      '    <span id="cf-resize-conflict-chip" class="cf-resize-conflict-chip" role="status" aria-live="polite"></span>',
      '    <button id="cf-edit-img-url" class="cf-btn cf-btn-small cf-img-only" title="Change image URL" aria-label="Change image URL">📷 url</button>',
      '    <button id="cf-edit-bold" class="cf-btn cf-btn-small cf-edit-fmt" title="Bold (⌘B)" aria-label="Bold"><b>B</b></button>',
      '    <button id="cf-edit-italic" class="cf-btn cf-btn-small cf-edit-fmt" title="Italic (⌘I)" aria-label="Italic"><i>I</i></button>',
      '    <button id="cf-edit-underline" class="cf-btn cf-btn-small cf-edit-fmt" title="Underline (⌘U)" aria-label="Underline"><u>U</u></button>',
      '    <button id="cf-edit-ul" class="cf-btn cf-btn-small cf-edit-fmt" title="Bulleted list" aria-label="Bulleted list"><svg width="14" height="12" viewBox="0 0 15 12" aria-hidden="true"><circle cx="1.5" cy="2" r="1.2" fill="currentColor"/><circle cx="1.5" cy="6" r="1.2" fill="currentColor"/><circle cx="1.5" cy="10" r="1.2" fill="currentColor"/><line x1="5" y1="2" x2="14" y2="2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><line x1="5" y1="6" x2="14" y2="6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><line x1="5" y1="10" x2="14" y2="10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></button>',
      '    <button id="cf-edit-ol" class="cf-btn cf-btn-small cf-edit-fmt" title="Numbered list" aria-label="Numbered list"><svg width="14" height="12" viewBox="0 0 15 12" aria-hidden="true"><text x="0" y="3.6" font-size="3.5" font-family="sans-serif" font-weight="700" fill="currentColor">1</text><text x="0" y="7.6" font-size="3.5" font-family="sans-serif" font-weight="700" fill="currentColor">2</text><text x="0" y="11.6" font-size="3.5" font-family="sans-serif" font-weight="700" fill="currentColor">3</text><line x1="5" y1="2" x2="14" y2="2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><line x1="5" y1="6" x2="14" y2="6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><line x1="5" y1="10" x2="14" y2="10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></button>',
      '    <button id="cf-edit-link" class="cf-btn cf-btn-small cf-edit-fmt" title="Link selection (creates &lt;a href&gt;)" aria-label="Link selection"><svg width="14" height="12" viewBox="0 0 14 12" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 6 L8.5 6"/><path d="M6 4 L4 4 a2 2 0 0 0 0 4 L6 8"/><path d="M8 4 L10 4 a2 2 0 0 1 0 4 L8 8"/></svg></button>',
      // Text alignment — single cycle button. Click advances left → center →
      // right → left. The active state is read on editor-open from computed
      // text-align. Reset clears the inline override. Hidden in image-edit
      // mode via .cf-edit-fmt.
      '    <button id="cf-edit-halign-cycle" class="cf-btn cf-btn-small cf-edit-fmt cf-edit-align-cycle" data-cf-align="left" title="Cycle text alignment: left → center → right" aria-label="Cycle text alignment">',
      '      <span class="cf-align-glyph cf-align-left" aria-hidden="true"><svg width="14" height="12" viewBox="0 0 14 12"><line x1="1" y1="2" x2="13" y2="2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><line x1="1" y1="6" x2="9" y2="6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><line x1="1" y1="10" x2="11" y2="10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></span>',
      '      <span class="cf-align-glyph cf-align-center" aria-hidden="true"><svg width="14" height="12" viewBox="0 0 14 12"><line x1="1" y1="2" x2="13" y2="2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><line x1="3" y1="6" x2="11" y2="6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><line x1="2" y1="10" x2="12" y2="10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></span>',
      '      <span class="cf-align-glyph cf-align-right" aria-hidden="true"><svg width="14" height="12" viewBox="0 0 14 12"><line x1="1" y1="2" x2="13" y2="2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><line x1="5" y1="6" x2="13" y2="6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><line x1="3" y1="10" x2="13" y2="10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></span>',
      '    </button>',
      // Vertical alignment — single cycle button. Click advances top → middle →
      // bottom → top. Sets align-self (flex/grid parents) AND vertical-align
      // (inline / table-cell). Reset clears.
      '    <button id="cf-edit-valign-cycle" class="cf-btn cf-btn-small cf-edit-fmt cf-edit-valign-cycle" data-cf-valign="top" title="Cycle vertical alignment: top → middle → bottom" aria-label="Cycle vertical alignment">',
      '      <span class="cf-valign-glyph cf-valign-top" aria-hidden="true"><svg width="14" height="12" viewBox="0 0 14 12"><rect x="1.5" y="1.5" width="11" height="2.5" fill="currentColor" rx="0.4"/><line x1="1" y1="10.5" x2="13" y2="10.5" stroke="currentColor" stroke-width="1" stroke-linecap="round" opacity="0.35"/></svg></span>',
      '      <span class="cf-valign-glyph cf-valign-middle" aria-hidden="true"><svg width="14" height="12" viewBox="0 0 14 12"><line x1="1" y1="1.5" x2="13" y2="1.5" stroke="currentColor" stroke-width="1" stroke-linecap="round" opacity="0.35"/><rect x="1.5" y="4.75" width="11" height="2.5" fill="currentColor" rx="0.4"/><line x1="1" y1="10.5" x2="13" y2="10.5" stroke="currentColor" stroke-width="1" stroke-linecap="round" opacity="0.35"/></svg></span>',
      '      <span class="cf-valign-glyph cf-valign-bottom" aria-hidden="true"><svg width="14" height="12" viewBox="0 0 14 12"><line x1="1" y1="1.5" x2="13" y2="1.5" stroke="currentColor" stroke-width="1" stroke-linecap="round" opacity="0.35"/><rect x="1.5" y="8" width="11" height="2.5" fill="currentColor" rx="0.4"/></svg></span>',
      '    </button>',
      // Case cycle — click applies the displayed transform AND advances to the
      // next. Order: UPPERCASE → lowercase → Title Case. The glyph shows what
      // the next click will apply (selection-or-whole-element semantics from
      // applyCaseTransform).
      '    <button id="cf-edit-case-cycle" class="cf-btn cf-btn-small cf-edit-fmt cf-edit-case cf-edit-case-cycle" data-cf-case="upper" title="Cycle case: UPPERCASE → lowercase → Title Case (applies to selection or whole element)" aria-label="Cycle case">',
      '      <span class="cf-case-glyph cf-case-upper" aria-hidden="true">AA</span>',
      '      <span class="cf-case-glyph cf-case-lower" aria-hidden="true">aa</span>',
      '      <span class="cf-case-glyph cf-case-title" aria-hidden="true">Aa</span>',
      '    </button>',
      '    <span class="cf-edit-toolbar-sep" aria-hidden="true"></span>',
      '    <button id="cf-edit-comment" class="cf-btn cf-btn-small" title="Add a comment about this element" aria-label="Add a comment">💬</button>',
      '    <button id="cf-edit-cancel" class="cf-btn cf-btn-small">cancel</button>',
      '    <button id="cf-edit-go" class="cf-btn-primary cf-btn-small">confirm (⌘↵)</button>',
      '  </div>',
      '  <div class="cf-edit-toolbar-row cf-style-row cf-style-row-text">',
      '    <label class="cf-style-lbl">font</label>',
      '    <select id="cf-edit-font-family"></select>',
      '    <input type="number" id="cf-edit-font-size" min="8" max="120" step="0.5" class="cf-style-num cf-num-spin" title="Font size (px)">',
      '    <label class="cf-style-lbl cf-style-lbl-stack">line<br>spc</label>',
      '    <input type="number" id="cf-edit-line-height" min="0.8" max="3" step="0.05" class="cf-style-num cf-num-spin" title="Line height (unitless multiplier)">',
      '    <label class="cf-style-lbl">color</label>',
      '    <button type="button" id="cf-edit-color-btn" class="cf-color-swatch-btn" title="Text color — click for palette" aria-label="Text color"></button>',
      '    <input type="color" id="cf-edit-color" class="cf-hidden-color-input" tabindex="-1" aria-hidden="true">',
      '    <label class="cf-style-lbl">bg</label>',
      '    <button type="button" id="cf-edit-bg-btn" class="cf-color-swatch-btn" title="Background color — click for palette" aria-label="Background color"></button>',
      '    <input type="color" id="cf-edit-bg" class="cf-hidden-color-input" tabindex="-1" aria-hidden="true">',
      '    <button id="cf-edit-style-reset" class="cf-btn cf-btn-small" title="Reset font/color/bg/border overrides">reset</button>',
      '  </div>',
      '  <div class="cf-edit-toolbar-row cf-style-row cf-style-row-border">',
      '    <label class="cf-style-lbl">border</label>',
      '    <input type="number" id="cf-edit-border-w" min="0" max="20" step="0.5" value="0" class="cf-style-num cf-num-spin" title="Border weight (px)">',
      '    <input type="color" id="cf-edit-border-c" class="cf-color-input" title="Border color">',
      '    <label class="cf-style-lbl">radius</label>',
      '    <input type="number" id="cf-edit-radius" min="0" max="80" step="1" value="0" class="cf-style-num cf-num-spin" title="Border radius (px)">',
      '    <label class="cf-style-lbl">pad</label>',
      '    <input type="number" id="cf-edit-padding" min="0" max="200" step="1" value="0" class="cf-style-num cf-num-spin" title="Padding (px, all sides)">',
      '    <label class="cf-style-lbl">opacity</label>',
      '    <input type="number" id="cf-edit-opacity" min="0" max="100" step="5" value="100" class="cf-style-num cf-num-spin" title="Opacity (0–100%). Applies to both text and images.">',
      '    <button id="cf-edit-paintbrush" class="cf-btn cf-btn-small cf-paintbrush-btn" title="Capture this element\'s styles and paste them onto another (Esc to cancel)" aria-label="Style paintbrush">🖌</button>',
      '    <button id="cf-edit-help" class="cf-btn cf-btn-small cf-edit-help-btn" title="Quick guide (?)" aria-label="Quick guide">?</button>',
      '  </div>',
      '</div>',
      // Color popover — opens when the user clicks either color-swatch button.
      // Shows the 3-slot page palette + a "custom color" escape hatch that
      // triggers the hidden native picker. Replaces both the inline swatch
      // row and the direct native-picker open behavior; palette now lives
      // alongside the color controls instead of as a separate inline strip.
      '<div id="cf-color-popover" class="cf-color-popover" role="dialog" aria-label="Color picker" aria-hidden="true">',
      '  <div class="cf-color-popover-label">page palette <span class="cf-color-popover-target" id="cf-color-popover-target">text</span></div>',
      '  <div id="cf-palette" class="cf-palette"></div>',
      '  <button type="button" id="cf-color-popover-custom" class="cf-btn cf-btn-small">custom color…</button>',
      '</div>',
      // "Changes ready, reload to see" banner — persistent, top-center
      '<div id="cf-reload-banner" class="cf-reload-banner" role="status" aria-live="polite">',
      '  <span class="cf-reload-bell" aria-hidden="true">🔔</span>',
      '  <span id="cf-reload-msg" class="cf-reload-msg">Changes ready, reload to see</span>',
      '  <button id="cf-reload-now" class="cf-btn-primary cf-btn-small" title="Reload (R)">reload <span class="cf-kbd-hint">R</span></button>',
      '</div>',
      // Agent-prompt card — shown when Claude needs input mid-session. The agent
      // appends a JSON line to feedback/prompts.jsonl; this card polls for the
      // newest unanswered prompt and renders it. Quick-reply buttons (when the
      // prompt supplies `options`) post the chosen value back through the
      // existing /feedback endpoint as type:"agent-response". Freeform replies
      // use the textarea + send button.
      '<div id="cf-agent-prompt" class="cf-agent-prompt" role="dialog" aria-live="polite" aria-hidden="true" aria-label="Claude is asking">',
      '  <div class="cf-agent-prompt-head">',
      '    <span class="cf-agent-prompt-label">💬 Claude is asking</span>',
      '    <button id="cf-agent-prompt-close" class="cf-agent-prompt-close" title="Dismiss (Claude keeps waiting)" aria-label="Dismiss">×</button>',
      '  </div>',
      '  <div id="cf-agent-prompt-text" class="cf-agent-prompt-text"></div>',
      '  <div id="cf-agent-prompt-options" class="cf-agent-prompt-options"></div>',
      '  <textarea id="cf-agent-prompt-input" class="cf-agent-prompt-input" placeholder="Your reply…" rows="2"></textarea>',
      '  <div class="cf-agent-prompt-actions">',
      '    <button id="cf-agent-prompt-send" class="cf-btn-primary cf-btn-small">send (⌘↵)</button>',
      '  </div>',
      '</div>'
    ].join("");
    document.body.appendChild(root);
  }

  const $ = (id) => document.getElementById(id);

  function showToast(msg, ms = 2500) {
    const t = $("cf-toast");
    t.textContent = msg;
    t.classList.add("cf-visible");
    clearTimeout(t._timeout);
    t._timeout = setTimeout(() => t.classList.remove("cf-visible"), ms);
  }

  // ---------------- Text selection ----------------
  function onSelectionChange() {
    if (elementMode) { hideTextPopup(); return; }
    if (editingEl) {
      // While editing, repopulate the style controls from the element under
      // the caret / selection so the font picker, size, color, and bg reflect
      // whatever's actually styled in the selected range.
      hideTextPopup();
      updateStyleControlsFromSelection();
      return;
    }
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) { hideTextPopup(); return; }
    const txt = sel.toString().trim();
    if (txt.length < 2) { hideTextPopup(); return; }
    const node = sel.anchorNode;
    if (node && insideOurUI(node.nodeType === 3 ? node.parentElement : node)) {
      hideTextPopup();
      return;
    }
    showTextPopup(sel);
  }

  function updateStyleControlsFromSelection() {
    if (!editingEl) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    let node = sel.getRangeAt(0).startContainer;
    if (node && node.nodeType === 3) node = node.parentElement;
    if (!node || !editingEl.contains(node)) return;
    // Selection moved: refresh font/size/color/bg only (those can vary per
    // text range). Skip border/radius — those are element-scoped, and re-reading
    // the rounded-down computed border width on every selection change snaps
    // the spinner back to 0.
    populateTextStyleControls(node);
  }

  function showTextPopup(selection) {
    const popup = $("cf-selection-popup");
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    popup.style.top = (window.scrollY + rect.bottom + 6) + "px";
    popup.style.left = (window.scrollX + rect.left + rect.width / 2 - 50) + "px";
    popup.classList.add("cf-visible");
    // SNAPSHOT the relevant state immediately — don't rely on live selection later
    const anchorEl = findCommentableAncestor(range.startContainer);
    savedTextSelection = {
      range: range.cloneRange(),
      quote: selection.toString().trim(),
      anchor: anchorInfo(anchorEl),
    };
  }

  function hideTextPopup() {
    $("cf-selection-popup").classList.remove("cf-visible");
  }

  // Drop a stuck-armed snapshot state. Called from every mode entry so an
  // unreleased Alt from a focus / blur dance can't leave snapshot armed
  // while the user is also entering element / edit mode.
  function clearSnapshotArm() {
    if (snapshotAltHeld) {
      snapshotAltHeld = false;
      setSnapshotArmed(false);
    }
    if (snapshotDragging) cancelSnapshotDrag();
  }

  // ---------------- Element selection ----------------
  function toggleElementMode() {
    // Edit mode and element mode are mutually exclusive — cancel any in-flight edit first
    if (editingEl) cancelTextEdit();
    clearSnapshotArm();
    elementMode = !elementMode;
    document.body.classList.toggle("cf-elem-mode", elementMode);
    const btn = $("cf-elem-toggle");
    btn.classList.toggle("cf-active", elementMode);
    btn.innerHTML = elementMode
      ? '✓ selecting <span class="cf-kbd-hint">E</span>'
      : '🎯 select <span class="cf-kbd-hint">E</span>';
    if (!elementMode) {
      clearElementSelection();
      hideElemPopup();
    } else {
      hideTextPopup();
      showToast("Click anything (image, table, paragraph). Shift-click adds. Esc exits.", 3500);
    }
  }

  function clearElementSelection() {
    selectedElements.forEach(el => el.classList.remove("cf-elem-selected"));
    selectedElements = [];
    document.querySelectorAll(".cf-elem-hover").forEach(el => el.classList.remove("cf-elem-hover"));
    clearAllSelectionFrames();
    setHoverFrame(null);
  }

  // Queue a delete for each top-level element in the current selection.
  // Drops descendants of any other selected element so we don't double-queue
  // (the parent's removal already takes its children with it). Each delete
  // captures parent + sibling index + original outerHTML so the in-list
  // trashcan can re-insert if the user changes their mind.
  function deleteSelectedElements() {
    if (selectedElements.length === 0) return;
    const targets = selectedElements.filter(el =>
      !selectedElements.some(other => other !== el && other.contains(el))
    );
    let queued = 0;
    for (const el of targets) {
      const parent = el.parentElement;
      if (!parent) continue;
      const index = Array.from(parent.children).indexOf(el);
      pending.push({
        id: "c-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6) + "-" + queued,
        type: "delete",
        created_at: new Date().toISOString(),
        element: anchorInfo(el),
        parent: {
          tag: parent.tagName.toLowerCase(),
          id: parent.id || null,
          selector: stableSelector(parent),
        },
        index,
        original_outer_html: el.outerHTML,
        comment: "",
      });
      el.remove();
      queued++;
    }
    if (queued === 0) return;
    saveLS();
    clearElementSelection();
    hideElemPopup();
    if (elementMode) toggleElementMode();
    renderPending();
    showToast(queued === 1 ? "element deleted" : queued + " elements deleted");
  }

  // ---------------- Snapshot mode (Alt + drag) ----------------
  function ensureHtml2Canvas() {
    if (window.html2canvas) return Promise.resolve(window.html2canvas);
    if (html2canvasLoadPromise) return html2canvasLoadPromise;
    html2canvasLoadPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = HTML2CANVAS_LOCAL_URL;
      s.onload = () => {
        if (window.html2canvas) resolve(window.html2canvas);
        else reject(new Error("html2canvas didn't expose window.html2canvas"));
      };
      s.onerror = () => reject(new Error("failed to load " + HTML2CANVAS_LOCAL_URL));
      document.head.appendChild(s);
    });
    return html2canvasLoadPromise;
  }

  function setSnapshotArmed(on) {
    document.body.classList.toggle("cf-snapshot-armed", on);
  }

  function onSnapshotKeyDown(e) {
    if (e.key !== "Alt") return;
    // Only arm when nothing else is going on
    if (editingEl || elementMode) return;
    if (snapshotAltHeld) return;
    snapshotAltHeld = true;
    setSnapshotArmed(true);
  }
  function onSnapshotKeyUp(e) {
    if (e.key !== "Alt") return;
    snapshotAltHeld = false;
    setSnapshotArmed(false);
    if (snapshotDragging) cancelSnapshotDrag();
  }
  function onSnapshotBlur() {
    if (!snapshotAltHeld && !snapshotDragging) return;
    snapshotAltHeld = false;
    setSnapshotArmed(false);
    if (snapshotDragging) cancelSnapshotDrag();
  }

  function onSnapshotPointerDown(e) {
    if (!snapshotAltHeld) return;
    // Bail if another mode latched between Alt-keydown and pointerdown.
    if (editingEl || elementMode) return;
    if (insideOurUI(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    snapshotDragging = true;
    snapshotStartDocXY = { x: e.clientX + window.scrollX, y: e.clientY + window.scrollY };
    snapshotEndDocXY   = { x: snapshotStartDocXY.x, y: snapshotStartDocXY.y };
    snapshotRectEl = document.createElement("div");
    snapshotRectEl.className = "cf-snapshot-rect";
    document.body.appendChild(snapshotRectEl);
    updateSnapshotRect();
  }
  function onSnapshotPointerMove(e) {
    if (!snapshotDragging) return;
    snapshotEndDocXY = { x: e.clientX + window.scrollX, y: e.clientY + window.scrollY };
    updateSnapshotRect();
  }
  function onSnapshotPointerUp(e) {
    if (!snapshotDragging) return;
    const endDocX = e.clientX + window.scrollX;
    const endDocY = e.clientY + window.scrollY;
    const x1 = snapshotStartDocXY.x, y1 = snapshotStartDocXY.y;
    const left = Math.min(x1, endDocX), top = Math.min(y1, endDocY);
    const w = Math.abs(endDocX - x1), h = Math.abs(endDocY - y1);
    if (w < MIN_SNAPSHOT_PX || h < MIN_SNAPSHOT_PX) { cancelSnapshotDrag(); return; }
    if (snapshotRectEl) snapshotRectEl.remove();
    snapshotRectEl = null;
    snapshotDragging = false;
    snapshotStartDocXY = null;
    snapshotEndDocXY = null;
    captureSnapshotRegion(left, top, w, h);
  }
  // Reposition the rect each frame. Coordinates are stored in document space
  // and converted to viewport space here since the rect itself is position:fixed.
  // No arguments — reads from snapshotStartDocXY / snapshotEndDocXY.
  function updateSnapshotRect() {
    if (!snapshotRectEl || !snapshotStartDocXY || !snapshotEndDocXY) return;
    const sx = window.scrollX, sy = window.scrollY;
    const x1 = snapshotStartDocXY.x - sx, y1 = snapshotStartDocXY.y - sy;
    const x2 = snapshotEndDocXY.x   - sx, y2 = snapshotEndDocXY.y   - sy;
    const left = Math.min(x1, x2), top = Math.min(y1, y2);
    snapshotRectEl.style.left   = left + "px";
    snapshotRectEl.style.top    = top + "px";
    snapshotRectEl.style.width  = Math.abs(x2 - x1) + "px";
    snapshotRectEl.style.height = Math.abs(y2 - y1) + "px";
  }
  function cancelSnapshotDrag() {
    if (snapshotRectEl) { snapshotRectEl.remove(); snapshotRectEl = null; }
    snapshotDragging = false;
    snapshotStartDocXY = null;
    snapshotEndDocXY = null;
  }

  // Find every element currently rendered transparent (opacity < 1, possibly
  // via CSS class state) and NOT also display:none / visibility:hidden, and
  // force them visible for the duration of the snapshot. Fixes the
  // "snapshot came back blank" failure mode caused by IntersectionObserver-
  // driven fade-up patterns (e.g. .reveal { opacity:0 } → .reveal.in
  // { opacity:1 }) AND any other intentional-but-currently-faded element
  // that html2canvas would otherwise render as transparent. Skips elements
  // that are deliberately hidden via display:none / visibility:hidden since
  // unhiding those would leak UI chrome that the user can't see.
  function _forceVisibleForSnapshot() {
    const overrides = [];
    const candidates = document.querySelectorAll("body *");
    for (const el of candidates) {
      if (insideOurUI(el)) continue;
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      const op = parseFloat(cs.opacity);
      const fade = !isNaN(op) && op < 1;
      // Inline the COMPUTED color value when the rule uses a `var()` —
      // html2canvas 1.4.1 has known cases where var() doesn't resolve in
      // its DOM clone, leaving text at the default (transparent / inherit)
      // and rendering invisible. Pulling the already-resolved rgb() value
      // into an inline declaration bypasses that. Also do this for
      // background-color (same root cause when card backgrounds use vars).
      const inlineColor = el.style.color;
      const inlineBg = el.style.backgroundColor;
      const usesVarColor = !inlineColor && cs.color && /^rgb/.test(cs.color);
      const usesVarBg = !inlineBg && cs.backgroundColor && /^rgb/.test(cs.backgroundColor)
        && cs.backgroundColor !== "rgba(0, 0, 0, 0)" && cs.backgroundColor !== "transparent";
      if (!fade && !usesVarColor && !usesVarBg) continue;
      overrides.push({ el, cssText: el.style.cssText });
      if (fade) {
        // Defeat fade-in animations. Leave transform alone — translate(-50%)
        // and similar layout-centering tricks would shift content off-screen
        // if we reset them. Fade-in elements that pair opacity + transform
        // render at their pre-animation position (slightly offset) but visible.
        el.style.setProperty("opacity", "1", "important");
        el.style.setProperty("transition", "none", "important");
        el.style.setProperty("animation", "none", "important");
      }
      if (usesVarColor) el.style.setProperty("color", cs.color, "important");
      if (usesVarBg) el.style.setProperty("background-color", cs.backgroundColor, "important");
    }
    return overrides;
  }
  function _restoreAfterSnapshot(overrides) {
    for (const { el, cssText } of overrides) {
      el.style.cssText = cssText;
    }
  }

  // Inputs are in DOCUMENT coords. html2canvas takes a document-space (x, y);
  // findElementsInRegion compares against bounding-rect viewport coords so we
  // also derive viewport coords here for that single use.
  async function captureSnapshotRegion(docLeft, docTop, w, h) {
    let html2canvas, blob, uploadedPath;
    const root = $("claude-feedback-root");
    const prevVis = root ? root.style.visibility : "";
    let revealOverrides = [];
    try {
      showToast("capturing…", 1200);
      html2canvas = await ensureHtml2Canvas();
      if (root) root.style.visibility = "hidden";
      // Defeat fade-in animations BEFORE html2canvas walks the DOM. Wait two
      // rAFs after applying the inline-style overrides so the browser flushes
      // the new computed styles AND any pending layout/paint that would
      // otherwise still be at the original opacity. Without the rAF wait,
      // html2canvas can still snapshot the pre-flush frame on fast machines.
      revealOverrides = _forceVisibleForSnapshot();
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      // When the page has been scope-wrapped under a #ssc-* root, the
      // page background usually lives on the WRAPPER rather than on
      // <body> (since body{bg} would bleed in SQ context). html2canvas
      // captures document.body — so for these pages, body's own bg is
      // transparent, the snapshot canvas is transparent, and any text
      // rendered directly against the wrapper bg (rather than over a
      // card with its own bg) appears as text-on-transparent → white-
      // on-white when PNG flattens. Detect that case and pass the
      // wrapper's bg as html2canvas's backgroundColor so the snapshot
      // renders against the same color the user sees.
      const _bodyBg = getComputedStyle(document.body).backgroundColor;
      const _isTransparent = (c) => !c || c === "transparent" || /^rgba?\([^)]*,\s*0\s*\)$/.test(c);
      let _effectiveBg = _isTransparent(_bodyBg) ? null : _bodyBg;
      if (!_effectiveBg) {
        for (const child of document.body.children) {
          if (child.id && child.id.startsWith("ssc-")) {
            const bg = getComputedStyle(child).backgroundColor;
            if (!_isTransparent(bg)) { _effectiveBg = bg; break; }
          }
        }
      }
      // Render the FULL body, then crop client-side to the requested region.
      // The previous approach (passing x/y/width/height + scroll offsets to
      // html2canvas to crop server-side) had a confusing coordinate-system
      // contract — for long scrolled pages the captured region didn't match
      // what the user dragged. By rendering everything and cropping the
      // resulting canvas ourselves, we sidestep html2canvas's scroll math
      // entirely: docLeft/docTop are document coords, and document(0,0)
      // is the canvas top-left after a full-body render, so the crop is
      // a straight slice. Slower on tall pages (full-body canvas), but
      // coordinate-correct.
      const fullCanvas = await html2canvas(document.body, {
        scrollX: 0,
        scrollY: 0,
        backgroundColor: _effectiveBg,
        useCORS: true,
        allowTaint: true,
        logging: false,
      });
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(w));
      canvas.height = Math.max(1, Math.round(h));
      const ctx = canvas.getContext("2d");
      if (_effectiveBg) {
        ctx.fillStyle = _effectiveBg;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      // html2canvas may render at device pixel ratio; account for that when
      // sampling from the full canvas.
      const dpr = fullCanvas.width / document.documentElement.scrollWidth;
      ctx.drawImage(
        fullCanvas,
        Math.round(docLeft * dpr), Math.round(docTop * dpr),
        Math.round(w * dpr), Math.round(h * dpr),
        0, 0, canvas.width, canvas.height
      );
      if (root) root.style.visibility = prevVis;
      _restoreAfterSnapshot(revealOverrides);
      revealOverrides = [];
      blob = await new Promise((resolve, reject) => {
        canvas.toBlob((b) => b ? resolve(b) : reject(new Error("toBlob returned null")), "image/png");
      });
      const id = "snap-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);
      const filename = id + ".png";
      const resp = await fetch(SNAPSHOT_UPLOAD_PREFIX + filename, {
        method: "POST",
        headers: { "Content-Type": "image/png" },
        body: blob,
      });
      if (!resp.ok) throw new Error("upload failed (" + resp.status + ")");
      const json = await resp.json();
      uploadedPath = json.path;
    } catch (err) {
      if (root) root.style.visibility = prevVis;
      _restoreAfterSnapshot(revealOverrides);
      console.error("snapshot capture failed", err);
      const raw = String(err && err.message || err);
      const friendly = /createPattern.*width or height of 0/i.test(raw)
        ? "snapshot couldn't capture an element on the page (one of the backgrounds rendered at 0×0). Try the snapshot again or scroll slightly and retry."
        : "snapshot failed: " + raw;
      showToast(friendly, 5000);
      return;
    }
    // findElementsInRegion uses viewport bounding rects, so feed it viewport coords
    const vpLeft = docLeft - window.scrollX;
    const vpTop = docTop - window.scrollY;
    const elementsInRegion = findElementsInRegion(vpLeft, vpTop, w, h);
    openSnapshotEditor({
      type: "snapshot",
      region: { x: docLeft, y: docTop, w, h, viewport_x: vpLeft, viewport_y: vpTop },
      image_path: uploadedPath,
      image_url: uploadedPath,
      elements: elementsInRegion,
    });
  }

  function findElementsInRegion(vpX, vpY, w, h) {
    const out = [];
    const right = vpX + w, bottom = vpY + h;
    // Walk only labeled/identifiable elements to keep the list tight
    const candidates = document.querySelectorAll("[data-cf-id], [id], [data-cf-change]");
    for (const el of candidates) {
      if (insideOurUI(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.right < vpX || r.left > right || r.bottom < vpY || r.top > bottom) continue;
      out.push({
        cf_id: el.dataset && el.dataset.cfId ? el.dataset.cfId : null,
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        data_cf_change: el.getAttribute("data-cf-change") || null,
        text_snippet: (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60),
      });
      if (out.length >= 15) break;
    }
    return out;
  }

  // ---------------- Pill placement ----------------
  function loadPillCorner() {
    try {
      const c = localStorage.getItem("cf-pill-corner");
      if (c && PILL_CORNERS.indexOf(c) >= 0) return c;
    } catch (e) { /* localStorage blocked */ }
    return "bl";
  }
  function setPillCorner(corner) {
    if (PILL_CORNERS.indexOf(corner) < 0) corner = "bl";
    pillCorner = corner;
    const root = $("claude-feedback-root");
    if (root) root.setAttribute("data-corner", corner);
    try { localStorage.setItem("cf-pill-corner", corner); } catch (e) {}
  }
  function nearestCorner(cx, cy) {
    const w = window.innerWidth, h = window.innerHeight;
    const targets = {
      tl: { x: 0, y: 0 }, tr: { x: w, y: 0 },
      bl: { x: 0, y: h }, br: { x: w, y: h },
    };
    let best = "bl", bestD = Infinity;
    for (const k in targets) {
      const dx = targets[k].x - cx, dy = targets[k].y - cy;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = k; }
    }
    return best;
  }
  function pillCornerAfterArrow(current, arrow) {
    let v = current[0], h = current[1];
    if (arrow === "ArrowUp") v = "t";
    else if (arrow === "ArrowDown") v = "b";
    else if (arrow === "ArrowLeft") h = "l";
    else if (arrow === "ArrowRight") h = "r";
    return v + h;
  }
  function onPillPointerDown(e) {
    if (e.button !== 0) return; // left-click only
    pillDragStartXY = { x: e.clientX, y: e.clientY };
    pillJustDragged = false;
  }
  function onPillPointerMove(e) {
    if (!pillDragStartXY) return;
    const dx = e.clientX - pillDragStartXY.x;
    const dy = e.clientY - pillDragStartXY.y;
    if (!pillDragging && Math.sqrt(dx * dx + dy * dy) < PILL_DRAG_THRESHOLD_PX) return;
    if (!pillDragging) {
      pillDragging = true;
      pillJustDragged = true;
      $("cf-toggle").parentElement.classList.add("cf-dragging");
      // Hide panel during drag so it doesn't visually trail behind
      closePanel();
    }
    const launcher = $("cf-toggle").parentElement;
    launcher.style.transform = `translate(${dx}px, ${dy}px)`;
  }
  function onPillPointerUp(e) {
    if (!pillDragStartXY) return;
    const launcher = $("cf-toggle").parentElement;
    if (pillDragging) {
      const rect = $("cf-toggle").getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const corner = nearestCorner(cx, cy);
      launcher.style.transform = "";
      launcher.classList.remove("cf-dragging");
      setPillCorner(corner);
      pillDragging = false;
    }
    pillDragStartXY = null;
  }

  function openSnapshotEditor(payload) {
    const editor = $("cf-editor");
    const quoteEl = $("cf-editor-quote");
    quoteEl.classList.remove("cf-comment-general");
    quoteEl.innerHTML =
      `<div class="cf-pq-label">snapshot</div>` +
      `<img src="${payload.image_url}" alt="captured region" class="cf-pq-image">`;
    editor._payload = payload;
    editor.style.top = Math.max(12, window.innerHeight / 2 - 200) + "px";
    editor.style.left = Math.max(12, window.innerWidth / 2 - 160) + "px";
    editor.classList.add("cf-visible");
    setTimeout(() => $("cf-editor-text").focus(), 50);
  }

  // ---------------- Selection-frame overlay system ----------------
  // Draws hover + select indicators as position:fixed overlay <div>s inside
  // #cf-overlays rather than mutating the target element's CSS (no border,
  // outline, or box-shadow on the element itself). Solves three problems
  // the class-based approach had:
  //   - outline/border on an inside element gets clipped by overflow:hidden
  //     ancestors (.card-featured on the pricing page does this);
  //   - mutating border reflows the page mid-select;
  //   - a selection class that paints a border can visually conflict with
  //     the element's own border styling.
  // Each selected element gets its own frame, so multi-select reads as a
  // set of independent boxes the user can comment on as a group.
  const cfFrames = new Map(); // element -> frame div
  let cfHoverFrame = null;
  let cfHoverFrameTarget = null;
  let cfFrameLoopActive = false;

  function ensureOverlayContainer() {
    let c = document.getElementById("cf-overlays");
    if (c) return c;
    c = document.createElement("div");
    c.id = "cf-overlays";
    const host = document.getElementById("claude-feedback-root") || document.body;
    host.appendChild(c);
    return c;
  }

  function addSelectionFrame(el) {
    if (!el || cfFrames.has(el)) return;
    const container = ensureOverlayContainer();
    const frame = document.createElement("div");
    frame.className = "cf-selection-frame";
    const label = document.createElement("span");
    label.className = "cf-selection-frame-label";
    label.textContent = "selected";
    frame.appendChild(label);
    container.appendChild(frame);
    cfFrames.set(el, frame);
    startFrameLoop();
  }

  function removeSelectionFrame(el) {
    const frame = cfFrames.get(el);
    if (frame) { frame.remove(); cfFrames.delete(el); }
  }

  function clearAllSelectionFrames() {
    cfFrames.forEach((frame) => frame.remove());
    cfFrames.clear();
  }

  function setHoverFrame(el) {
    if (el === cfHoverFrameTarget) return;
    cfHoverFrameTarget = el;
    if (!el) {
      if (cfHoverFrame) cfHoverFrame.style.display = "none";
      return;
    }
    if (!cfHoverFrame) {
      const container = ensureOverlayContainer();
      cfHoverFrame = document.createElement("div");
      cfHoverFrame.className = "cf-selection-frame cf-selection-frame--hover";
      container.appendChild(cfHoverFrame);
    }
    cfHoverFrame.style.display = "";
    startFrameLoop();
  }

  function positionFrame(frame, el) {
    if (!el.isConnected) {
      frame.style.display = "none";
      return false;
    }
    const r = el.getBoundingClientRect();
    frame.style.display = "";
    frame.style.left = r.left + "px";
    frame.style.top = r.top + "px";
    frame.style.width = r.width + "px";
    frame.style.height = r.height + "px";
    return true;
  }

  function repositionFrames() {
    for (const [el, frame] of cfFrames) {
      if (!positionFrame(frame, el)) {
        frame.remove();
        cfFrames.delete(el);
      }
    }
    if (cfHoverFrame && cfHoverFrameTarget) positionFrame(cfHoverFrame, cfHoverFrameTarget);
  }

  // Cheap rAF loop while there are any active frames. Stops itself when
  // none remain, so it isn't a permanent background cost. Per-frame cost
  // is one getBoundingClientRect + style assign per active frame.
  function startFrameLoop() {
    if (cfFrameLoopActive) return;
    cfFrameLoopActive = true;
    const tick = () => {
      if (cfFrames.size === 0 && !cfHoverFrameTarget) {
        cfFrameLoopActive = false;
        return;
      }
      repositionFrames();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  function onElemMouseOver(e) {
    if (!elementMode) return;
    if (insideOurUI(e.target)) return;
    const el = findCommentableAncestor(e.target);
    document.querySelectorAll(".cf-elem-hover").forEach(x => x.classList.remove("cf-elem-hover"));
    if (el && !selectedElements.includes(el)) {
      el.classList.add("cf-elem-hover");
      setHoverFrame(el);
    } else {
      setHoverFrame(null);
    }
  }

  function onElemMouseOut(e) {
    if (!elementMode) return;
    if (insideOurUI(e.target)) return;
    document.querySelectorAll(".cf-elem-hover").forEach(x => x.classList.remove("cf-elem-hover"));
    setHoverFrame(null);
  }

  function onElemClick(e) {
    if (!elementMode) return;
    if (insideOurUI(e.target)) return;
    // If no commentable ancestor matches, fall back to the literal click
    // target — trust the user's pointer over the heuristic.
    const el = findCommentableAncestor(e.target) || e.target;
    if (!el || el === document.body || el === document.documentElement) return;
    e.preventDefault();
    e.stopPropagation();
    if (!e.shiftKey) {
      // single select: clear others
      selectedElements.forEach(x => {
        if (x !== el) {
          x.classList.remove("cf-elem-selected");
          removeSelectionFrame(x);
        }
      });
      selectedElements = [];
    }
    const idx = selectedElements.indexOf(el);
    if (idx === -1) {
      selectedElements.push(el);
      el.classList.add("cf-elem-selected");
      el.classList.remove("cf-elem-hover");
      addSelectionFrame(el);
      setHoverFrame(null);
    } else {
      selectedElements.splice(idx, 1);
      el.classList.remove("cf-elem-selected");
      removeSelectionFrame(el);
    }
    if (selectedElements.length > 0) {
      showElemPopup(selectedElements[selectedElements.length - 1]);
    } else {
      hideElemPopup();
    }
  }

  function showElemPopup(nearEl) {
    const popup = $("cf-elem-popup");
    const r = nearEl.getBoundingClientRect();
    popup.style.top = (window.scrollY + r.bottom + 6) + "px";
    popup.style.left = (window.scrollX + r.left + Math.min(r.width / 2, 120)) + "px";
    popup.classList.add("cf-visible");
  }
  function hideElemPopup() {
    $("cf-elem-popup").classList.remove("cf-visible");
  }

  // ---------------- Comment editor ----------------
  function openTextCommentEditor() {
    if (!savedTextSelection) return;
    const editor = $("cf-editor");
    const quoteEl = $("cf-editor-quote");
    quoteEl.classList.remove("cf-comment-general");
    quoteEl.textContent = '"' + savedTextSelection.quote + '"';
    editor._payload = {
      type: "selection",
      comment: "",
      quote: savedTextSelection.quote,
      anchor: savedTextSelection.anchor,
    };
    positionEditor(savedTextSelection.range.getBoundingClientRect());
    editor.classList.add("cf-visible");
    hideTextPopup();
    setTimeout(() => $("cf-editor-text").focus(), 50);
  }

  function openElementCommentEditor() {
    if (selectedElements.length === 0) return;
    const editor = $("cf-editor");
    const quoteEl = $("cf-editor-quote");
    quoteEl.classList.remove("cf-comment-general");
    const elements = selectedElements.map(el => anchorInfo(el));
    // Build a compact summary for the quote display
    quoteEl.innerHTML = elements.map(e => `<div>${escapeHtml(e.tag)}${e.id ? "#" + escapeHtml(e.id) : ""}${e.cf_id ? " <span style='opacity:0.5'>(" + e.cf_id + ")</span>" : ""} — <span style="opacity:0.7">${escapeHtml(e.text_snippet.slice(0, 80))}${e.text_snippet.length > 80 ? "…" : ""}</span></div>`).join("");
    editor._payload = {
      type: "elements",
      comment: "",
      elements,
    };
    positionEditor(selectedElements[selectedElements.length - 1].getBoundingClientRect());
    editor.classList.add("cf-visible");
    hideElemPopup();
    setTimeout(() => $("cf-editor-text").focus(), 50);
  }

  function openGeneralEditor() {
    const editor = $("cf-editor");
    const quoteEl = $("cf-editor-quote");
    quoteEl.classList.add("cf-comment-general");
    quoteEl.textContent = "General question";
    editor._payload = { type: "general", comment: "" };
    // The editor is position: fixed → viewport coords, NO scrollY
    editor.style.top = Math.max(12, window.innerHeight / 2 - 100) + "px";
    editor.style.left = Math.max(12, window.innerWidth / 2 - 160) + "px";
    editor.classList.add("cf-visible");
    setTimeout(() => $("cf-editor-text").focus(), 50);
  }

  function positionEditor(rect) {
    // CRITICAL: .cf-editor is position:fixed → coords are VIEWPORT coords, no scroll offset.
    const editor = $("cf-editor");
    const width = 320;
    const estimatedHeight = 200;
    let top = rect.bottom + 12;
    // If that pushes the editor off the bottom, flip above the selection
    if (top + estimatedHeight > window.innerHeight - 12) {
      top = rect.top - estimatedHeight - 12;
    }
    top = Math.max(12, Math.min(top, window.innerHeight - estimatedHeight - 12));
    let left = rect.left + Math.min(rect.width / 2, 200) - width / 2;
    left = Math.max(12, Math.min(left, window.innerWidth - width - 12));
    editor.style.top = top + "px";
    editor.style.left = left + "px";
  }

  function closeEditor() {
    const editor = $("cf-editor");
    editor.classList.remove("cf-visible");
    $("cf-editor-text").value = "";
    editor._payload = null;
    editor._editingPendingId = null;
  }

  function editPendingComment(c) {
    // Text-edits get the full inline re-edit experience: locate the element,
    // restore its pending new_html as the editable content, and remember we're
    // refining an existing entry. Falls through to the comment-only editor if
    // the element can't be found (page rebuilt, anchor gone).
    if (c.type === "text-edit") {
      const target = findElementByAnchorInfo(c.elements && c.elements[0]);
      if (target) {
        if (editingEl) cancelTextEdit();
        // Route image-shaped targets back through startImageEdit instead of
        // the text editor — images have no inner text and the text toolbar
        // (font/color/etc) doesn't apply. Without this, dblclicking an image
        // that already has a queued edit re-opens the WRONG editor.
        if (IMAGE_EDITABLE_TAGS.has(target.tagName)) {
          startImageEdit(target);
          if (editingEl) {
            // Diff continuity: keep the pre-first-edit outerHTML/cssText so
            // the next confirm captures the cumulative delta against the
            // file, not against this intermediate refinement.
            editingOriginalOuterHtml = c.original_outer_html || editingOriginalOuterHtml;
          }
          refiningPendingId = c.id;
          return;
        }
        target.innerHTML = c.new_html || c.new_text || target.innerHTML;
        startTextEdit(target);
        if (editingEl) {
          // Preserve the user's original_* fields from the first edit so the
          // agent always sees the diff against the file, not against an
          // intermediate refinement.
          editingOriginalHtml = c.original_html;
          editingOriginalText = c.original_text;
        }
        refiningPendingId = c.id;
        return;
      }
      // Element gone — fall through to comment-only edit
    }
    const editor = $("cf-editor");
    const quoteEl = $("cf-editor-quote");
    quoteEl.classList.remove("cf-comment-general");
    if (c.type === "general") {
      quoteEl.classList.add("cf-comment-general");
      quoteEl.textContent = "General question";
    } else if (c.type === "elements") {
      quoteEl.innerHTML = c.elements.map(e =>
        `<div>${escapeHtml(e.tag)}${e.id ? "#" + escapeHtml(e.id) : ""}${e.cf_id ? " <span style='opacity:0.5'>(" + e.cf_id + ")</span>" : ""} — <span style="opacity:0.7">${escapeHtml(e.text_snippet.slice(0, 80))}${e.text_snippet.length > 80 ? "…" : ""}</span></div>`
      ).join("");
    } else if (c.type === "text-edit") {
      const tag = (c.elements && c.elements[0] && c.elements[0].tag) || "text";
      const shown = (c.new_text || "").slice(0, 100);
      quoteEl.innerHTML =
        `<div class="cf-pq-label">text edit · ${escapeHtml(tag)}</div>` +
        `<div class="cf-pq-text-faint">"${escapeHtml(shown)}${(c.new_text || "").length > 100 ? "…" : ""}"</div>`;
    } else if (c.type === "snapshot") {
      quoteEl.innerHTML =
        `<div class="cf-pq-label">snapshot</div>` +
        (c.image_url ? `<img src="${escapeHtml(c.image_url)}" alt="snapshot" class="cf-pq-image">` : "");
    } else {
      quoteEl.textContent = '"' + (c.quote || "") + '"';
    }
    editor._payload = c;
    editor._editingPendingId = c.id;
    $("cf-editor-text").value = c.comment || "";
    editor.style.top = Math.max(12, window.innerHeight / 2 - 100) + "px";
    editor.style.left = Math.max(12, window.innerWidth / 2 - 160) + "px";
    editor.classList.add("cf-visible");
    setTimeout(() => $("cf-editor-text").focus(), 50);
  }

  function saveEditorComment() {
    const editor = $("cf-editor");
    const text = $("cf-editor-text").value.trim();
    if (!editor._payload) return;
    const payload = editor._payload;
    // Editing an existing pending comment: replace its `comment` field in-place
    if (editor._editingPendingId) {
      const idx = pending.findIndex((x) => x.id === editor._editingPendingId);
      if (idx !== -1) {
        pending[idx].comment = text;
        saveLS();
        renderPending();
      }
      closeEditor();
      showToast("comment updated");
      return;
    }
    if (!text) return;
    payload.id = "c-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);
    payload.comment = text;
    payload.created_at = new Date().toISOString();
    pending.push(payload);
    saveLS();
    renderPending();
    closeEditor();
    // Exit element mode after committing (less surprising than staying in)
    if (payload.type === "elements") {
      clearElementSelection();
      if (elementMode) toggleElementMode();
    } else if (payload.type === "selection") {
      window.getSelection().removeAllRanges();
      savedTextSelection = null;
    }
    showToast("comment added");
  }

  // ---------------- Inline text edit (dblclick) ----------------
  function isDivTextLeaf(el) {
    // A <div> with only text + inline markup inside is editable as if it were
    // a paragraph. Anything block-level inside means it's a container — skip.
    if (el.tagName !== "DIV") return false;
    for (const child of el.children) {
      if (!INLINE_TAGS_FOR_DIV_LEAF.has(child.tagName)) return false;
    }
    const text = (el.innerText || el.textContent || "").trim();
    return text.length > 0;
  }

  function isTextEditable(el) {
    if (!el || el.nodeType !== 1) return false;
    if (insideOurUI(el)) return false;
    if (TEXT_EDITABLE_TAGS.has(el.tagName)) {
      const text = (el.innerText || el.textContent || "").trim();
      return text.length > 0;
    }
    return isDivTextLeaf(el);
  }

  function findEditableAncestor(node) {
    // Walk up looking for the best edit target. Prefer block-level elements
    // (P, H1-H6, LI, TD, etc.) over a contained SPAN — dbl-clicking a styled
    // span inside a paragraph almost always means "edit the paragraph".
    // Special case: when we land on an <li>, prefer its <ul>/<ol> parent so
    // the whole list becomes editable — Enter inside an existing <li> then
    // adds another bullet natively via contenteditable.
    // Fall back to the nearest SPAN / DIV-text-leaf only if no block ancestor
    // matches.
    let el = node && node.nodeType === 3 ? node.parentElement : node;
    let fallback = null;
    while (el && el !== document.body && el !== document.documentElement) {
      if (insideOurUI(el)) return null;
      if (PRIMARY_EDITABLE_BLOCK_TAGS.has(el.tagName)) {
        if (el.tagName === "LI") {
          const list = el.closest("ul, ol");
          if (list && !insideOurUI(list)) {
            const t = (list.innerText || list.textContent || "").trim();
            if (t.length > 0) return list;
          }
        }
        const text = (el.innerText || el.textContent || "").trim();
        if (text.length > 0) return el;
      }
      if (!fallback && isTextEditable(el)) fallback = el;
      el = el.parentElement;
    }
    return fallback;
  }

  function findImageAncestor(node) {
    let el = node && node.nodeType === 3 ? node.parentElement : node;
    while (el && el !== document.body && el !== document.documentElement) {
      if (insideOurUI(el)) return null;
      if (IMAGE_EDITABLE_TAGS.has(el.tagName)) return el;
      // <picture> wraps an <img> and a set of <source>s. Click usually lands
      // on the inner <img> already — but Safari sometimes reports the picture
      // as e.target. Descend to the real image.
      if (el.tagName === "PICTURE") {
        const inner = el.querySelector("img");
        if (inner) return inner;
      }
      // Background-image div with no text inside it. CSS backgrounds aren't
      // hosted by an actual element we can resize, but the wrapping div IS,
      // so treat it as the image target. The text-content check avoids
      // mis-catching content sections that happen to have a backdrop.
      if (el.tagName !== "BODY") {
        const bg = getComputedStyle(el).backgroundImage;
        if (bg && bg !== "none" && /url\(/.test(bg)) {
          const text = (el.innerText || el.textContent || "").trim();
          if (!text) return el;
        }
      }
      el = el.parentElement;
    }
    return null;
  }

  function startTextEdit(el) {
    if (editingEl) return;
    if (elementMode) return;
    clearSnapshotArm();
    editingEl = el;
    editingOriginalHtml = el.innerHTML;
    editingOriginalText = el.innerText || el.textContent || "";
    editingOriginalOuterHtml = el.outerHTML;
    editingOriginalCssText = el.style.cssText;
    // Order matters: build the dropdown FIRST so populateStyleControls has
    // options to match against when picking the current font.
    buildFontFamilyOptions();
    populateStyleControls(el);
    el.classList.add("cf-editing-target");
    el.setAttribute("contenteditable", "true");
    el.setAttribute("spellcheck", "true");
    // Clear any prior selection so the selection popup doesn't latch on
    window.getSelection().removeAllRanges();
    savedTextSelection = null;
    hideTextPopup();
    el.focus();
    // Place caret at end so the user can start typing immediately
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    positionEditToolbar();
    $("cf-edit-toolbar").classList.add("cf-visible");
    // After visibility flips, offsetHeight finally reports the real toolbar
    // size — reposition so it doesn't overlap the editing element.
    requestAnimationFrame(positionEditToolbar);
    showResizeHandle();
  }

  // Resize-only edit for <img>/<video>/etc. — same toolbar shell, but no
  // contenteditable (images don't take text), and we hide the text-format
  // controls via a body class. The user drags the corner handle and submits;
  // the inline width/height land in new_outer_html so the agent picks them up.
  function startImageEdit(el) {
    if (editingEl) return;
    if (elementMode) return;
    clearSnapshotArm();
    editingEl = el;
    editingOriginalHtml = el.innerHTML;
    editingOriginalText = "";
    editingOriginalOuterHtml = el.outerHTML;
    editingOriginalCssText = el.style.cssText;
    buildFontFamilyOptions();
    populateStyleControls(el);
    el.classList.add("cf-editing-target", "cf-editing-image");
    document.body.classList.add("cf-image-edit-mode");
    // Swap the toolbar label so it reads "editing image"
    const label = document.querySelector(".cf-edit-toolbar-label");
    if (label) {
      if (!label.dataset.cfDefaultLabel) label.dataset.cfDefaultLabel = label.textContent;
      label.textContent = "editing image";
    }
    hideTextPopup();
    positionEditToolbar();
    $("cf-edit-toolbar").classList.add("cf-visible");
    requestAnimationFrame(positionEditToolbar);
    showResizeHandle();
  }

  function positionEditToolbar() {
    if (!editingEl) return;
    const tb = $("cf-edit-toolbar");
    const r = editingEl.getBoundingClientRect();
    // Three-row toolbar — measure live since width is content-dependent.
    // Fallbacks match the realistic worst-case size so the first paint (when
    // offsetHeight is still 0 because cf-visible hasn't been applied yet)
    // doesn't place the toolbar overlapping the element.
    const tbH = tb.offsetHeight || 140;
    const tbW = tb.offsetWidth || 540;
    let top = r.top - tbH - 8;
    if (top < 12) top = Math.min(r.bottom + 8, window.innerHeight - tbH - 12);
    let left = Math.max(12, Math.min(r.left, window.innerWidth - tbW - 12));
    tb.style.top = top + "px";
    tb.style.left = left + "px";
  }

  // Resize handle: a small gold square pinned to the bottom-right of the
  // currently-editing element. Drag to set inline width/height (with
  // !important so it beats stylesheet rules). Persists into new_outer_html
  // when the edit is submitted, so the style diff shows up in the pending row.
  let resizeStart = null;
  const CF_RESIZE_HANDLES = ["cf-resize-tl", "cf-resize-tr", "cf-resize-bl", "cf-resize-br"];
  function showResizeHandle() {
    CF_RESIZE_HANDLES.forEach((id) => {
      const h = $(id);
      if (h) h.classList.add("cf-visible");
    });
    positionResizeHandle();
  }
  function hideResizeHandle() {
    setHandleClass("cf-visible", false);
    clearResizeConflict();
  }
  function setHandleClass(cls, on) {
    CF_RESIZE_HANDLES.forEach((id) => {
      const h = $(id);
      if (!h) return;
      if (on) h.classList.add(cls);
      else h.classList.remove(cls);
    });
  }

  // Conflict state survives past onResizeEnd (which nulls resizeStart) so the
  // submit path can read it before exitEditMode clears it.
  let currentResizeConflict = null;
  function clearResizeConflict() {
    currentResizeConflict = null;
    const chip = $("cf-resize-conflict-chip");
    if (chip) { chip.classList.remove("cf-visible"); chip.textContent = ""; }
    if (editingEl) editingEl.classList.remove("cf-resize-conflict-target");
    setHandleClass("cf-resize-conflict", false);
  }

  function makeConflict(kind, source, constraint, valuePx, actualPx, description) {
    return {
      kind, source, constraint,
      constraint_value_px: Math.round(valuePx),
      actual_px: Math.round(actualPx),
      description,
    };
  }
  // Short label for the chip: #id > .first-non-cf-class > tag.
  function parentLabel(parent) {
    if (parent.id) return "#" + parent.id;
    const cls = [...parent.classList].find((c) => !c.startsWith("cf-"));
    return cls ? "." + cls : parent.tagName.toLowerCase();
  }
  // Cheap to call every frame; style-derived parent props are cached on
  // resizeStart.parentMeta, but the parent rect is re-read each call because
  // the parent can re-flow as the child grows.
  function detectResizeConflict(el) {
    if (!el || !resizeStart) return null;
    const r = el.getBoundingClientRect();
    const parent = el.parentElement;
    const isTopLevel = !parent || parent === document.body || parent === document.documentElement;
    if (!isTopLevel && !resizeStart.parentMeta) {
      const pcs = getComputedStyle(parent);
      const mw = pcs.maxWidth;
      resizeStart.parentMeta = {
        display: pcs.display,
        maxWidthPx: (mw && mw !== "none" && mw.endsWith("px")) ? parseFloat(mw) : null,
        paddingLeft: parseFloat(pcs.paddingLeft) || 0,
        paddingRight: parseFloat(pcs.paddingRight) || 0,
        label: parentLabel(parent),
        anchor: anchorInfo(parent),
      };
    }
    let found = null;
    if (!isTopLevel) {
      const pm = resizeStart.parentMeta;
      const pr = parent.getBoundingClientRect();
      if (pm.maxWidthPx !== null) {
        const innerCap = pm.maxWidthPx - pm.paddingLeft - pm.paddingRight;
        if (r.width > innerCap + 0.5) {
          found = makeConflict("parent-max-width", pm.label, "max-width",
            pm.maxWidthPx, r.width,
            "exceeds " + pm.label + " max-width " + Math.round(pm.maxWidthPx) + "px");
        }
      }
      if (!found) {
        const isGridFlex = /grid|flex/.test(pm.display);
        if (!isGridFlex) {
          const innerW = pr.width - pm.paddingLeft - pm.paddingRight;
          if (r.width > innerW + 0.5) {
            found = makeConflict("parent-overflow", pm.label, "content-width",
              innerW, r.width,
              "overflows " + pm.label + " (" + Math.round(innerW) + "px content area)");
          }
        } else if (r.right > pr.right - pm.paddingRight + 0.5) {
          const isGrid = pm.display.includes("grid");
          found = makeConflict("track-overflow", pm.label,
            isGrid ? "grid-track" : "flex-slot",
            (pr.right - pm.paddingRight) - (pr.left + pm.paddingLeft), r.width,
            "overflows " + pm.label + " " + (isGrid ? "grid track" : "flex slot"));
        }
      }
      if (found) found.source_anchor = pm.anchor;
    }
    if (!found && r.right > window.innerWidth + 0.5) {
      found = makeConflict("viewport-overflow", "viewport", "width",
        window.innerWidth, r.width,
        isTopLevel ? "exceeds viewport width " + Math.round(window.innerWidth) + "px"
                   : "extends past viewport edge");
    }
    return found;
  }
  function applyResizeConflict(next) {
    if (!editingEl) return;
    if (!next) return clearResizeConflict();
    const same = currentResizeConflict
      && currentResizeConflict.kind === next.kind
      && currentResizeConflict.actual_px === next.actual_px
      && currentResizeConflict.constraint_value_px === next.constraint_value_px;
    if (same) return;
    currentResizeConflict = next;
    const chip = $("cf-resize-conflict-chip");
    if (chip) {
      chip.textContent = "⚠ " + next.description;
      chip.classList.add("cf-visible");
    }
    editingEl.classList.add("cf-resize-conflict-target");
    setHandleClass("cf-resize-conflict", true);
  }
  function positionResizeHandle() {
    if (!editingEl) return;
    const r = editingEl.getBoundingClientRect();
    const pos = {
      "cf-resize-tl": { left: r.left - 8,  top: r.top - 8 },
      "cf-resize-tr": { left: r.right - 8, top: r.top - 8 },
      "cf-resize-bl": { left: r.left - 8,  top: r.bottom - 8 },
      "cf-resize-br": { left: r.right - 8, top: r.bottom - 8 },
    };
    Object.keys(pos).forEach((id) => {
      const h = $(id);
      if (!h) return;
      h.style.left = pos[id].left + "px";
      h.style.top = pos[id].top + "px";
    });
  }
  const RESIZE_SNAP_PX = 8;
  // Snapshot every flex/grid sibling's current rect and pin it via inline
  // width/height/flex so the target's resize doesn't redistribute space
  // across the row. Also lock the target's own flex-shrink/grow — without
  // that the flex layout would re-shrink the target's authoritative inline
  // width back down to fit container minus pinned siblings, so the resize
  // visibly "sticks" and the target reads as a slave to its sibling.
  // Idempotent — running with siblings already pinned is a no-op.
  function pinFlexGridSiblings(el) {
    if (!el || pinnedSiblingsForEdit.length > 0) return;
    const parent = el.parentElement;
    if (!parent) return;
    const pcs = getComputedStyle(parent);
    if (!/flex|grid/.test(pcs.display)) return;
    el.style.setProperty("flex-shrink", "0", "important");
    el.style.setProperty("flex-grow",   "0", "important");
    Array.from(parent.children).forEach((c) => {
      if (c === el || c.nodeType !== 1 || insideOurUI(c)) return;
      const cr = c.getBoundingClientRect();
      pinnedSiblingsForEdit.push({
        el: c,
        originalCssText: c.style.cssText,
        originalOuterHtml: c.outerHTML,
        originalHtml: c.innerHTML,
        originalText: c.innerText || c.textContent || "",
      });
      c.style.setProperty("width",  Math.round(cr.width)  + "px", "important");
      c.style.setProperty("height", Math.round(cr.height) + "px", "important");
      c.style.setProperty("flex-shrink", "0", "important");
      c.style.setProperty("flex-grow",   "0", "important");
    });
  }
  function unpinFlexGridSiblings() {
    pinnedSiblingsForEdit.forEach((p) => { p.el.style.cssText = p.originalCssText; });
    pinnedSiblingsForEdit = [];
  }
  // Pointer must travel this far from pointer-down before we commit any
  // width/height. Keeps a click-without-drag on a corner handle (which is easy
  // to trigger when the handles overlap a short text element) from leaving
  // accidental inline width/height !important styles on the element.
  const RESIZE_DRAG_THRESHOLD_PX = 4;
  function onResizeStart(e) {
    if (!editingEl) return;
    e.preventDefault();
    e.stopPropagation();
    const corner = (e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.corner) || "br";
    const r = editingEl.getBoundingClientRect();
    const cs = getComputedStyle(editingEl);
    resizeStart = {
      x: e.clientX, y: e.clientY,
      w: r.width, h: r.height,
      left: r.left, top: r.top,
      mlStart: parseFloat(cs.marginLeft) || 0,
      mtStart: parseFloat(cs.marginTop) || 0,
      corner,
      cornerX: corner[1],   // 'l' or 'r'
      cornerY: corner[0],   // 't' or 'b'
      snapEdges: null,      // computed lazily on first move past threshold
      dragArmed: false,     // flips true once the threshold is crossed
    };
    document.addEventListener("pointermove", onResizeMove);
    document.addEventListener("pointerup", onResizeEnd, { once: true });
  }
  // Collect candidate edges (in viewport coords) the user might want their
  // resized element to align to. Limited to nearby kin to keep it cheap:
  // siblings of the editing element, its parent, and the grandparent. Right
  // and bottom edges are what we snap to (we resize from the bottom-right).
  function collectSnapEdges(el) {
    const xs = new Set();
    const ys = new Set();
    const parent = el.parentElement;
    if (!parent) return { xs: [], ys: [] };
    const candidates = new Set();
    Array.from(parent.children).forEach((c) => { if (c !== el) candidates.add(c); });
    candidates.add(parent);
    if (parent.parentElement) candidates.add(parent.parentElement);
    candidates.forEach((c) => {
      if (insideOurUI(c)) return;
      const r = c.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return;
      xs.add(r.left); xs.add(r.right);
      ys.add(r.top); ys.add(r.bottom);
    });
    return { xs: Array.from(xs), ys: Array.from(ys) };
  }
  function snapToward(value, candidates) {
    let best = value;
    let bestDist = RESIZE_SNAP_PX + 1;
    for (const c of candidates) {
      const d = Math.abs(value - c);
      if (d < bestDist) { bestDist = d; best = c; }
    }
    return best;
  }
  // Two nearest grid lines around `value` — enough to let snapToward pick
  // whichever side is closer without enumerating every grid line on the page.
  function nearestGridLines(value, gridSize) {
    const k = Math.round(value / gridSize);
    return [(k - 1) * gridSize, k * gridSize, (k + 1) * gridSize];
  }
  function onResizeMove(e) {
    if (!editingEl || !resizeStart) return;
    let dx = e.clientX - resizeStart.x;
    let dy = e.clientY - resizeStart.y;
    // Threshold gate: pure clicks on a handle (no real cursor travel) must not
    // commit any width/height. Defer pinning siblings and gathering snap edges
    // until the user has actually started dragging.
    if (!resizeStart.dragArmed) {
      if (Math.abs(dx) < RESIZE_DRAG_THRESHOLD_PX && Math.abs(dy) < RESIZE_DRAG_THRESHOLD_PX) return;
      resizeStart.dragArmed = true;
      pinFlexGridSiblings(editingEl);
      resizeStart.snapEdges = collectSnapEdges(editingEl);
    }
    // Per-corner snap: BR/TR snap right edge → xs; BL/TL snap left edge → xs.
    // BR/BL snap bottom edge → ys; TR/TL snap top edge → ys. Adjusting dx/dy
    // before computing width/height keeps the visual corner glued to the
    // snapped position (the opposite corner stays anchored). When snap-to-grid
    // is on, the grid lines are added to the candidate set.
    if (resizeStart.snapEdges) {
      // Grid candidates must be generated around the edge that's actually
      // moving — left for L corners, right for R corners. Same for Y.
      const targetX = resizeStart.cornerX === "r"
        ? resizeStart.left + resizeStart.w + dx
        : resizeStart.left + dx;
      const targetY = resizeStart.cornerY === "b"
        ? resizeStart.top + resizeStart.h + dy
        : resizeStart.top + dy;
      const xs = gridSnap
        ? resizeStart.snapEdges.xs.concat(nearestGridLines(targetX, GRID_SIZE_PX))
        : resizeStart.snapEdges.xs;
      const ys = gridSnap
        ? resizeStart.snapEdges.ys.concat(nearestGridLines(targetY, GRID_SIZE_PX))
        : resizeStart.snapEdges.ys;
      const snappedX = snapToward(targetX, xs);
      const snappedY = snapToward(targetY, ys);
      if (resizeStart.cornerX === "r") dx = snappedX - resizeStart.left - resizeStart.w;
      else                              dx = snappedX - resizeStart.left;
      if (resizeStart.cornerY === "b") dy = snappedY - resizeStart.top - resizeStart.h;
      else                              dy = snappedY - resizeStart.top;
    }
    // Each corner has its own sign rule. Right/Bottom corners grow with
    // positive cursor delta; Left/Top corners shrink with positive delta and
    // need a compensating margin shift so the opposite corner appears glued.
    const dW = resizeStart.cornerX === "r" ? dx : -dx;
    const dH = resizeStart.cornerY === "b" ? dy : -dy;
    const newW = Math.max(40, resizeStart.w + dW);
    const newH = Math.max(20, resizeStart.h + dH);
    // If width was clamped at 40, recompute the effective dx so margin shift
    // doesn't drag the element past its minimum size.
    const effDw = newW - resizeStart.w;
    const effDh = newH - resizeStart.h;
    const effDx = resizeStart.cornerX === "r" ? effDw : -effDw;
    const effDy = resizeStart.cornerY === "b" ? effDh : -effDh;
    const newML = resizeStart.cornerX === "l" ? (resizeStart.mlStart + effDx) : resizeStart.mlStart;
    const newMT = resizeStart.cornerY === "t" ? (resizeStart.mtStart + effDy) : resizeStart.mtStart;
    editingEl.style.setProperty("width", Math.round(newW) + "px", "important");
    editingEl.style.setProperty("height", Math.round(newH) + "px", "important");
    if (resizeStart.cornerX === "l") {
      editingEl.style.setProperty("margin-left", Math.round(newML) + "px", "important");
    }
    if (resizeStart.cornerY === "t") {
      editingEl.style.setProperty("margin-top", Math.round(newMT) + "px", "important");
    }
    positionResizeHandle();
    positionEditToolbar();
    applyResizeConflict(detectResizeConflict(editingEl));
  }
  function onResizeEnd() {
    resizeStart = null;
    document.removeEventListener("pointermove", onResizeMove);
  }

  // Auto-submit if the current edit has actual changes, else exit cleanly.
  // Used by click-outside and the dblclick-target-swap path so the user
  // doesn't lose meaningful changes by clicking away.
  function commitOrExitCurrentEdit() {
    if (!editingEl) return;
    const newText = editingEl.innerText || editingEl.textContent || "";
    const outerChanged = cleanOuterHtml(editingEl) !== editingOriginalOuterHtml;
    const textChanged = newText.trim() !== (editingOriginalText || "").trim();
    if (textChanged || outerChanged) submitTextEdit();
    else exitEditMode(false);
  }

  function exitEditMode(keepVisualEdit) {
    if (!editingEl) return;
    hideResizeHandle();
    if (!keepVisualEdit) {
      editingEl.innerHTML = editingOriginalHtml;
      // Also restore the inline style attribute — font-size, color, bg, width,
      // height, border, etc. set via the toolbar and resize handle all live on
      // .style. Without this, cancel only reverts content but leaves visual
      // style overrides stuck on the element.
      if (editingOriginalCssText != null) {
        editingEl.style.cssText = editingOriginalCssText;
      }
      // Cancel: also unpin flex/grid siblings back to their pre-edit cssText.
      unpinFlexGridSiblings();
    } else {
      // Submit kept the visual edit; the sibling pins are intentional and
      // were captured as separate text-edits by submitTextEdit. Just clear
      // our tracking so the next edit starts fresh.
      pinnedSiblingsForEdit = [];
    }
    editingEl.removeAttribute("contenteditable");
    editingEl.removeAttribute("spellcheck");
    editingEl.classList.remove("cf-editing-target", "cf-editing-image");
    document.body.classList.remove("cf-image-edit-mode");
    // Restore the toolbar label if we'd swapped it for image edit
    const label = document.querySelector(".cf-edit-toolbar-label");
    if (label && label.dataset.cfDefaultLabel) {
      label.textContent = label.dataset.cfDefaultLabel;
    }
    editingEl = null;
    editingOriginalHtml = null;
    editingOriginalText = null;
    editingOriginalOuterHtml = null;
    editingOriginalCssText = null;
    refiningPendingId = null;
    $("cf-edit-toolbar").classList.remove("cf-visible");
    refreshPendingEditMarkers();
  }

  function cancelTextEdit() {
    exitEditMode(false);
  }

  // Direct submit — clicking confirm (⌘↵) flushes the edit into the pending
  // list. Per-row "edit" in the pending UI lets the user add a note afterwards.
  function confirmOrAutoSubmit() {
    if (!editingEl) return;
    const newText = editingEl.innerText || editingEl.textContent || "";
    const outerChanged = cleanOuterHtml(editingEl) !== editingOriginalOuterHtml;
    const textChanged = newText.trim() !== editingOriginalText.trim();
    if (!textChanged && !outerChanged) {
      showToast("no changes to submit", 2200);
      return;
    }
    submitTextEdit();
  }

  function submitTextEdit() {
    if (!editingEl) return;
    const newText = editingEl.innerText || editingEl.textContent || "";
    const newHtml = editingEl.innerHTML;
    const newOuterHtml = cleanOuterHtml(editingEl);
    // Submit if EITHER the visible text changed OR the element's own
    // attributes (e.g. style) changed. Style-only edits are valid edits.
    const textChanged = newText.trim() !== editingOriginalText.trim();
    const outerChanged = newOuterHtml !== editingOriginalOuterHtml;
    if (!textChanged && !outerChanged) {
      showToast("no changes to submit", 2200);
      return;
    }
    if (refiningPendingId) {
      // Refining an already-pending text-edit — update in place, keep the
      // original_* fields from the first time so the agent sees the full diff
      // against the file (not just the diff against the previous refinement).
      const idx = pending.findIndex((x) => x.id === refiningPendingId);
      if (idx !== -1) {
        pending[idx].new_text = newText;
        pending[idx].new_html = newHtml;
        pending[idx].new_outer_html = newOuterHtml;
        pending[idx].created_at = new Date().toISOString();
      }
    } else {
      const entry = {
        type: "text-edit",
        comment: "",
        elements: [anchorInfo(editingEl)],
        original_text: editingOriginalText,
        new_text: newText,
        original_html: editingOriginalHtml,
        new_html: newHtml,
        original_outer_html: editingOriginalOuterHtml,
        new_outer_html: newOuterHtml,
        id: "c-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
        created_at: new Date().toISOString(),
      };
      if (currentResizeConflict) entry.dimensional_conflict = currentResizeConflict;
      pending.push(entry);
    }
    // If the target was resized and we pinned flex/grid siblings, persist the
    // pins as separate text-edits so the asymmetric layout survives reload.
    // Skip siblings whose outerHTML is unchanged (no actual pin landed).
    pinnedSiblingsForEdit.forEach((p) => {
      const sNewOuter = cleanOuterHtml(p.el);
      if (sNewOuter === p.originalOuterHtml) return;
      pending.push({
        type: "text-edit",
        comment: "",
        elements: [anchorInfo(p.el)],
        original_text: p.originalText,
        new_text: p.el.innerText || p.el.textContent || "",
        original_html: p.originalHtml,
        new_html: p.el.innerHTML,
        original_outer_html: p.originalOuterHtml,
        new_outer_html: sNewOuter,
        id: "c-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6) + "-sib",
        created_at: new Date().toISOString(),
      });
    });
    saveLS();
    renderPending();
    // Keep the visual change so the user sees their edit until the agent reloads
    exitEditMode(true);
    showToast(refiningPendingId ? "text edit updated" : "text edit queued");
  }

  // Strip our own UI cruft (contenteditable, cf-editing-target, etc.) from a
  // serialized outerHTML so it represents what the agent should write to the file.
  function cleanOuterHtml(el) {
    const clone = el.cloneNode(true);
    clone.classList.remove("cf-editing-target");
    clone.classList.remove("cf-editing-image");
    clone.classList.remove("cf-elem-selected");
    clone.classList.remove("cf-elem-hover");
    clone.classList.remove("cf-has-pending-edit");
    clone.classList.remove("cf-change-active");
    clone.classList.remove("cf-pulse");
    if (clone.classList.length === 0) clone.removeAttribute("class");
    clone.removeAttribute("contenteditable");
    clone.removeAttribute("spellcheck");
    // contenteditable + execCommand can leave an empty style="" behind on
    // some elements even when the user didn't touch a style control. Strip
    // it so the diff stays clean and no-op edits don't ride into the inbox.
    if (clone.getAttribute("style") === "") clone.removeAttribute("style");
    return clone.outerHTML;
  }

  // ---------------- Style panel (element-level CSS) ----------------
  function rgbToHex(rgb) {
    if (!rgb) return "#000000";
    const m = rgb.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (!m) return "#000000";
    return "#" + [m[1], m[2], m[3]]
      .map((n) => parseInt(n, 10).toString(16).padStart(2, "0")).join("");
  }

  // ---------- Page palette ----------
  // 3-slot quick-access color palette next to the color picker. Default
  // values are detected from the page (3 most common text colors of
  // commentable elements at load time); the user can override any slot
  // via right-click → native color picker. Overrides persist per pathname
  // in localStorage, so the palette survives reloads and travels with the
  // page rather than leaking across sites.
  const PALETTE_LS_KEY = "cf:palette:" + location.pathname;

  // Detect the 3 most common visible colors across the WHOLE page — not
  // just one element type. Counts:
  //   - text color (computed `color`) on every visible element
  //   - background-color when not transparent
  //   - background-image gradient stops: parsed for color tokens, then
  //     averaged into a single "gradient color" per element (so a 4-stop
  //     dark-blue → black gradient counts as one dark blue, not four
  //     separately-weighted stops)
  // Excludes pure white (#ffffff) and pure black (#000000) since those
  // tend to be CSS defaults / fallbacks rather than intentional palette
  // colors. Returns up to 3 hex strings, ranked by occurrence count.
  const _CF_PALETTE_EXCLUDED = new Set(["#ffffff", "#000000"]);

  function _parseRGBA(str) {
    if (!str) return null;
    const m = str.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)/);
    if (!m) return null;
    const a = m[4] === undefined ? 1 : parseFloat(m[4]);
    return { r: +m[1], g: +m[2], b: +m[3], a: isNaN(a) ? 1 : a };
  }
  function _rgbaToHex(c) {
    if (!c) return "#000000";
    const h = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
    return "#" + h(c.r) + h(c.g) + h(c.b);
  }
  function _averageGradient(bgImage) {
    if (!bgImage || bgImage === "none") return null;
    // Pull every rgb(a) token out of the background-image; if there are
    // any, average them (ignoring fully transparent ones since those are
    // visual no-ops). Handles linear-gradient / radial-gradient / mixed.
    const tokens = bgImage.match(/rgba?\([^)]+\)/g);
    if (!tokens || !tokens.length) return null;
    let r = 0, g = 0, b = 0, n = 0;
    for (const t of tokens) {
      const c = _parseRGBA(t);
      if (!c || c.a === 0) continue;
      // Weight by alpha so a 0.2-alpha stop counts less than a 1.0-alpha stop
      r += c.r * c.a; g += c.g * c.a; b += c.b * c.a; n += c.a;
    }
    if (n === 0) return null;
    return _rgbaToHex({ r: r / n, g: g / n, b: b / n });
  }

  function detectPageColors() {
    const counts = new Map();
    const tick = (hex) => {
      if (!hex) return;
      const lc = hex.toLowerCase();
      if (_CF_PALETTE_EXCLUDED.has(lc)) return;
      counts.set(lc, (counts.get(lc) || 0) + 1);
    };
    document.querySelectorAll("body *").forEach((el) => {
      if (el.closest("#claude-feedback-root")) return;
      const cs = getComputedStyle(el);
      // 1. Text color — only count it for elements that actually contain
      //    direct text (avoids inheriting a single color thousands of times
      //    across a layout-only div tree).
      let hasDirectText = false;
      for (const node of el.childNodes) {
        if (node.nodeType === 3 && node.textContent.trim()) { hasDirectText = true; break; }
      }
      if (hasDirectText) tick(_rgbaToHex(_parseRGBA(cs.color)));
      // 2. Background-color (skip fully transparent)
      const bg = _parseRGBA(cs.backgroundColor);
      if (bg && bg.a > 0) tick(_rgbaToHex(bg));
      // 3. Background-image gradients — averaged to a single color per element
      const gradHex = _averageGradient(cs.backgroundImage);
      if (gradHex) tick(gradHex);
    });
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([color]) => color);
  }

  function loadPalette() {
    try {
      const stored = localStorage.getItem(PALETTE_LS_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed) && parsed.length >= 1) {
          const padded = parsed.slice(0, 3);
          while (padded.length < 3) padded.push("#888888");
          return padded;
        }
      }
    } catch (e) { /* fall through to detection */ }
    const detected = detectPageColors();
    while (detected.length < 3) detected.push("#888888");
    return detected.slice(0, 3);
  }

  function savePalette(colors) {
    try { localStorage.setItem(PALETTE_LS_KEY, JSON.stringify(colors)); } catch (e) { /* quota / private mode */ }
  }

  // Which color the popover currently targets — "color" (text) or
  // "background-color" (bg). Set when the popover opens via the swatch
  // button click handlers; null when popover is closed.
  let _popoverTarget = null;

  function openColorPopover(targetProp, anchorEl) {
    const pop = $("cf-color-popover");
    if (!pop) return;
    _popoverTarget = targetProp;
    $("cf-color-popover-target").textContent =
      targetProp === "background-color" ? "background" : "text";
    renderPalette();
    const r = anchorEl.getBoundingClientRect();
    // Position below the anchor; clamp into viewport horizontally
    const popW = 220;
    let left = Math.max(8, Math.min(r.left, window.innerWidth - popW - 8));
    pop.style.top = (r.bottom + 6) + "px";
    pop.style.left = left + "px";
    pop.classList.add("cf-visible");
    pop.setAttribute("aria-hidden", "false");
    // Defer the outside-click listener so the opening click doesn't close it
    setTimeout(() => document.addEventListener("mousedown", _onPopoverOutside, true), 0);
  }

  function closeColorPopover() {
    const pop = $("cf-color-popover");
    if (!pop) return;
    pop.classList.remove("cf-visible");
    pop.setAttribute("aria-hidden", "true");
    _popoverTarget = null;
    document.removeEventListener("mousedown", _onPopoverOutside, true);
  }

  function _onPopoverOutside(e) {
    const pop = $("cf-color-popover");
    if (!pop) return;
    if (pop.contains(e.target)) return;
    if (e.target.id === "cf-edit-color-btn" || e.target.id === "cf-edit-bg-btn") return;
    closeColorPopover();
  }

  function renderPalette() {
    const container = $("cf-palette");
    if (!container) return;
    container.innerHTML = "";
    const colors = loadPalette();
    colors.forEach((hex, i) => {
      const swatch = document.createElement("button");
      swatch.type = "button";
      swatch.className = "cf-palette-swatch";
      swatch.style.background = hex;
      swatch.title = hex + " · click to apply · right-click to change slot";
      swatch.dataset.slot = String(i);
      swatch.addEventListener("mousedown", (e) => e.preventDefault());
      swatch.addEventListener("click", () => {
        // Use the popover's current target if open; otherwise fall back to
        // text color (for any future inline / programmatic invocation).
        const target = _popoverTarget || "color";
        applyInlineStyle(target, hex);
        if (target === "background-color") {
          $("cf-edit-bg").value = hex;
          syncColorSwatchButtons();
        } else {
          $("cf-edit-color").value = hex;
          syncColorSwatchButtons();
        }
        closeColorPopover();
      });
      swatch.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        const picker = document.createElement("input");
        picker.type = "color";
        picker.value = hex;
        picker.style.cssText = "position:fixed;left:-9999px;top:-9999px;";
        document.body.appendChild(picker);
        const cleanup = () => { if (picker.parentNode) picker.remove(); };
        picker.addEventListener("change", () => {
          const newColors = colors.slice();
          newColors[i] = picker.value;
          savePalette(newColors);
          renderPalette();
          const target = _popoverTarget || "color";
          applyInlineStyle(target, picker.value);
          if (target === "background-color") $("cf-edit-bg").value = picker.value;
          else $("cf-edit-color").value = picker.value;
          syncColorSwatchButtons();
          cleanup();
        });
        picker.addEventListener("blur", cleanup, { once: true });
        picker.click();
      });
      container.appendChild(swatch);
    });
  }

  // Keep the two visible color-swatch buttons in sync with the current
  // values of the hidden <input type="color"> elements. Called whenever a
  // color changes (palette apply, native picker change, populateStyleControls).
  function syncColorSwatchButtons() {
    const colorBtn = $("cf-edit-color-btn");
    const bgBtn = $("cf-edit-bg-btn");
    if (colorBtn) colorBtn.style.background = $("cf-edit-color").value || "#000000";
    if (bgBtn) bgBtn.style.background = $("cf-edit-bg").value || "#ffffff";
  }

  // ---------- Style paintbrush ----------
  // Capture the editing element's resolved styles, exit edit mode, and
  // arm "paint mode" — the next click on a commentable element pastes
  // those styles as inline !important declarations and queues the result
  // as a text-edit pending entry. Paint mode is sticky: each click pastes
  // and stays armed until Esc or the paintbrush button is clicked again.
  // Captured prop set matches the toolbar's controls.
  const CF_PAINT_PROPS_BASE = [
    "font-family", "font-size", "line-height",
    "color", "background-color",
    "border-width", "border-style", "border-color", "border-radius",
    "padding",
  ];
  // Border subset — applied when either the source or the target is an
  // <img>. Image painting is intentionally restricted to borders for now:
  // width / height / object-fit / margins all behave quirkily across
  // CDN-served photos and tend to cause more "why did my photo distort"
  // bugs than they solve. Until we have a clearer per-prop story for
  // image painting, paint only border treatments to and from images.
  const CF_PAINT_PROPS_BORDER_ONLY = [
    "border-width", "border-style", "border-color", "border-radius",
  ];
  let _paintbrushStyles = null;
  let _paintbrushSourceTag = null;

  function capturePaintbrush() {
    if (!editingEl) {
      showToast("double-click an element to load its styles first, then click 🖌", 4000);
      return;
    }
    const cs = getComputedStyle(editingEl);
    // Capture only what we'll actually transfer for this source: images
    // restrict to border props; everything else gets the base set.
    const props = editingEl.tagName === "IMG"
      ? CF_PAINT_PROPS_BORDER_ONLY
      : CF_PAINT_PROPS_BASE;
    _paintbrushStyles = {};
    _paintbrushSourceTag = editingEl.tagName;
    props.forEach((p) => {
      const v = cs.getPropertyValue(p);
      if (v) _paintbrushStyles[p] = v;
    });
    // Exit edit mode but keep the source element's current visual state
    exitEditMode(true);
    document.body.classList.add("cf-paintbrush-mode");
    showToast("🖌 paintbrush armed — click an element to paste styles. Esc to cancel.", 5000);
  }

  function deactivatePaintbrush() {
    _paintbrushStyles = null;
    document.body.classList.remove("cf-paintbrush-mode");
  }

  function paintbrushTryApply(target) {
    if (!_paintbrushStyles || !target) return false;
    if (insideOurUI(target)) return false;
    const original_outer_html = target.outerHTML;
    const original_html = target.innerHTML;
    const original_text = target.innerText || target.textContent || "";
    // Cross-kind painting is rejected: an image's props don't map cleanly
    // onto a text element and vice versa. img → img uses the border-only
    // set; text → text uses the full base set. Mismatches no-op with a
    // toast so the user sees the click was acknowledged but skipped.
    const targetIsImg = target.tagName === "IMG";
    const sourceWasImg = _paintbrushSourceTag === "IMG";
    if (targetIsImg !== sourceWasImg) {
      showToast(sourceWasImg
        ? "🖌 source is an image — can't paint onto a text element"
        : "🖌 source is text — can't paint onto an image",
        3500);
      return false;
    }
    Object.entries(_paintbrushStyles).forEach(([prop, val]) => {
      target.style.setProperty(prop, val, "important");
    });
    pending.push({
      type: "text-edit",
      comment: "[paintbrush] applied captured styles",
      elements: [anchorInfo(target)],
      original_text,
      new_text: target.innerText || target.textContent || "",
      original_html,
      new_html: target.innerHTML,
      original_outer_html,
      new_outer_html: cleanOuterHtml(target),
      id: "c-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
      created_at: new Date().toISOString(),
    });
    saveLS();
    renderPending();
    showToast("🖌 styles pasted — paint another or Esc to exit", 2200);
    return true;
  }
  // ---------- Inline style application rules ----------
  // The editor writes ALL inline style declarations with !important. Page
  // stylesheets routinely use !important (design systems, Squarespace, etc.)
  // and a non-!important inline declaration silently loses. With !important,
  // inline wins by being inline (CSS spec: inline + !important is the
  // highest cascade origin short of user-agent rules).
  //
  // **When to force-set vs removeProperty when zeroing a control.** The
  // user's expectation differs by property kind:
  //   - "Visual structure" props — border, border-radius, padding, margin,
  //     text-transform, font-variant — going to 0 / none means "I want
  //     nothing here, override whatever CSS says." For those we force
  //     `0` / `none` with !important so any class-level CSS rule (e.g.
  //     `.card { border: 1px solid }`) is overridden too. removeProperty
  //     alone would let the CSS leak back through and the control would
  //     look dead.
  //   - "Text appearance" props — font-family, font-size, color,
  //     background-color — the reset button means "revert to whatever CSS
  //     was already saying." For those we removeProperty so the CSS
  //     default re-asserts itself.
  // applyBorder / applyRadius / applyCaseTransform follow rule 1.
  // resetInlineStyles below removes the rule-2 props plus the rule-1 props
  // that the user might have force-set via the spinners.
  //
  // When the editing target is a UL/OL, also push text-style props directly
  // onto each LI. Page stylesheets like `.incl li { font-size: 14px }` win
  // against an inherited value from the list — even with !important — so
  // the user-visible change only sticks if we hit the li node directly.
  // Element-level props (border/radius/padding/background) stay on the list.
  const CF_LIST_PROPAGATE_PROPS = new Set([
    "font-family", "font-size", "color", "font-weight", "font-style",
    "letter-spacing", "line-height", "text-transform", "text-align",
    "background-color",
  ]);
  function applyInlineStyle(prop, value) {
    if (!editingEl) return;
    // If a non-collapsed text selection sits INSIDE the editing element,
    // scope the style to the selection instead of the whole element. Without
    // this, picking a color for a selected word ends up coloring the
    // surrounding unwrapped text — the existing inline-color spans win, but
    // any plain runs adopt the element-level color.
    if (value != null && value !== "") {
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
        const range = sel.getRangeAt(0);
        if (editingEl.contains(range.commonAncestorContainer)) {
          // execCommand for color/background-color — it understands selections
          // and will update or wrap existing inline-color spans correctly.
          if (prop === "color") {
            document.execCommand("foreColor", false, value);
            return;
          }
          if (prop === "background-color") {
            document.execCommand("hiliteColor", false, value);
            return;
          }
          // For other text props (font-family, font-size, line-height, etc.),
          // wrap the selection in a span. surroundContents throws when the
          // range partially selects a non-text node; in that case fall
          // through to the element-level apply below.
          try {
            const span = document.createElement("span");
            span.style.setProperty(prop, value, "important");
            range.surroundContents(span);
            return;
          } catch (e) { /* fall through */ }
        }
      }
    }
    const set = (el) => {
      if (value == null || value === "") el.style.removeProperty(prop);
      else el.style.setProperty(prop, value, "important");
    };
    set(editingEl);
    if (CF_LIST_PROPAGATE_PROPS.has(prop) &&
        (editingEl.tagName === "UL" || editingEl.tagName === "OL")) {
      Array.from(editingEl.children).forEach((c) => { if (c.tagName === "LI") set(c); });
    }
  }
  // Reset = "undo every style override the editor wrote during this session".
  // Includes the rule-2 text-appearance props (font/color/bg → revert to CSS)
  // AND the rule-1 visual-structure props (border/radius/padding/margin/
  // text-transform/font-variant) we may have force-set so the user can dial
  // those back to "CSS default" too. Margin sub-props are listed individually
  // because the resize handle sets `margin-left` / `margin-top` directly,
  // not the shorthand — removeProperty("margin") wouldn't match.
  const CF_RESET_PROPS = [
    "font-family", "font-size", "line-height", "color", "background-color",
    "border", "border-width", "border-style", "border-color",
    "border-radius", "padding",
    "margin", "margin-left", "margin-right", "margin-top", "margin-bottom",
    "text-transform", "font-variant",
    "opacity", "align-self", "vertical-align",
  ];
  function resetInlineStyles() {
    if (!editingEl) return;
    CF_RESET_PROPS.forEach((p) => {
      editingEl.style.removeProperty(p);
      if (editingEl.tagName === "UL" || editingEl.tagName === "OL") {
        Array.from(editingEl.children).forEach((c) => { if (c.tagName === "LI") c.style.removeProperty(p); });
      }
    });
    populateStyleControls(editingEl);
  }
  // Border weight + color compose into a single `border: <w>px solid <c>`
  // shorthand. Setting w to 0 forces `border: 0 none` with !important so it
  // wins against CSS rules that put a border on the element (e.g. a parent
  // stylesheet's `border-top: 1px solid`) — removeProperty alone only clears
  // the inline declaration and lets CSS leak through.
  function applyBorder() {
    if (!editingEl) return;
    const w = parseFloat($("cf-edit-border-w").value) || 0;
    const c = $("cf-edit-border-c").value || "#000000";
    if (w <= 0) {
      editingEl.style.setProperty("border", "0 none", "important");
      ["border-width", "border-style", "border-color"].forEach((p) => editingEl.style.removeProperty(p));
    } else {
      editingEl.style.setProperty("border", w + "px solid " + c, "important");
    }
  }
  function applyRadius() {
    if (!editingEl) return;
    const r = parseFloat($("cf-edit-radius").value) || 0;
    if (r <= 0) editingEl.style.setProperty("border-radius", "0", "important");
    else editingEl.style.setProperty("border-radius", r + "px", "important");
  }
  // Single-value padding — applies to all four sides. Element-scoped, no
  // propagation to children. Padding 0 forces `padding: 0 !important` so any
  // CSS-defined padding is overridden.
  function applyPadding() {
    if (!editingEl) return;
    const p = parseFloat($("cf-edit-padding").value);
    if (!isFinite(p) || p < 0) editingEl.style.removeProperty("padding");
    else editingEl.style.setProperty("padding", p + "px", "important");
  }
  // Opacity — 0–100 in the UI maps to 0.00–1.00 on the element. 100 removes
  // the inline override so CSS-defined opacity (if any) takes over.
  function applyOpacity() {
    if (!editingEl) return;
    const v = parseFloat($("cf-edit-opacity").value);
    if (!isFinite(v) || v >= 100) {
      editingEl.style.removeProperty("opacity");
    } else {
      const clamped = Math.max(0, Math.min(100, v));
      editingEl.style.setProperty("opacity", (clamped / 100).toFixed(2), "important");
    }
  }
  // Alignment cycles — one button per axis, click advances through three
  // states. cycleHAlign sets text-align directly on editingEl (no execCommand
  // wrapping) so the diff in new_outer_html is predictable. cycleVAlign sets
  // both align-self (flex/grid parents) and vertical-align (inline / table-cell)
  // so it lands the layout intent under either CSS context.
  const HALIGN_CYCLE = ["left", "center", "right"];
  const VALIGN_CYCLE = ["top", "middle", "bottom"];
  const VALIGN_ALIGN_SELF_MAP = { top: "flex-start", middle: "center", bottom: "flex-end" };
  // Read computed text-align into one of the 3 cycle tokens (default "left").
  function readHAlignToken(el) {
    const ta = (getComputedStyle(el).textAlign || "").toLowerCase();
    if (ta === "center") return "center";
    if (ta === "right" || ta === "end") return "right";
    return "left";
  }
  // Read computed align-self into one of the 3 cycle tokens (default "top").
  function readVAlignToken(el) {
    const as = (getComputedStyle(el).alignSelf || "").toLowerCase();
    if (as === "center") return "middle";
    if (as === "flex-end" || as === "end") return "bottom";
    return "top";
  }
  function cycleHAlign() {
    if (!editingEl) return;
    const btn = $("cf-edit-halign-cycle");
    const cur = btn.dataset.cfAlign || "left";
    const next = HALIGN_CYCLE[(HALIGN_CYCLE.indexOf(cur) + 1) % HALIGN_CYCLE.length];
    btn.dataset.cfAlign = next;
    editingEl.style.setProperty("text-align", next, "important");
  }
  function cycleVAlign() {
    if (!editingEl) return;
    const btn = $("cf-edit-valign-cycle");
    const cur = btn.dataset.cfValign || "top";
    const next = VALIGN_CYCLE[(VALIGN_CYCLE.indexOf(cur) + 1) % VALIGN_CYCLE.length];
    btn.dataset.cfValign = next;
    editingEl.style.setProperty("align-self", VALIGN_ALIGN_SELF_MAP[next], "important");
    editingEl.style.setProperty("vertical-align", next, "important");
  }
  // Link / unlink — wraps the current selection (must be non-collapsed) in
  // an <a href>. execCommand is deprecated but still the cheapest path for
  // contenteditable link insertion; the persisted source is normal HTML
  // either way. We sanitize the URL to http(s):/mailto:/tel: so a paste-in
  // can't smuggle javascript: through.
  function isSafeLinkHref(raw) {
    if (!raw) return false;
    const trimmed = raw.trim();
    if (!trimmed) return false;
    // Allow protocol-less URLs by prefixing https://. Reject javascript:/data: schemes.
    const lower = trimmed.toLowerCase();
    if (/^(javascript|data|vbscript|file):/i.test(lower)) return false;
    return true;
  }
  function normalizeLinkHref(raw) {
    const trimmed = raw.trim();
    if (/^(https?:|mailto:|tel:|#|\/|\.)/i.test(trimmed)) return trimmed;
    return "https://" + trimmed;
  }
  function applyLink() {
    if (!editingEl) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
      showToast("select text first to link it", 2200);
      return;
    }
    const range = sel.getRangeAt(0);
    if (!editingEl.contains(range.commonAncestorContainer)) {
      showToast("selection must be inside the editing element", 2200);
      return;
    }
    // Suggest the existing href if the selection sits inside a link already.
    let existingHref = "";
    let node = range.startContainer;
    if (node && node.nodeType === 3) node = node.parentElement;
    const existingA = node && node.closest && node.closest("a");
    if (existingA && editingEl.contains(existingA)) existingHref = existingA.getAttribute("href") || "";
    const raw = window.prompt("Link URL:", existingHref || "https://");
    if (raw == null) return;                          // cancelled
    if (raw.trim() === "")     { applyUnlink(); return; }
    if (!isSafeLinkHref(raw))  { showToast("unsafe URL scheme — ignored", 2800); return; }
    document.execCommand("createLink", false, normalizeLinkHref(raw));
  }
  function applyUnlink() {
    if (!editingEl) return;
    document.execCommand("unlink");
  }
  // Case transforms — operate on the current text selection. Replaces selected
  // text with its transformed version. No-op (with toast) when nothing's selected.
  function transformCase(text, mode) {
    if (mode === "upper") return text.toUpperCase();
    if (mode === "lower") return text.toLowerCase();
    if (mode === "title") return text.replace(/\w[^\s]*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
    return text;
  }
  function applyCaseTransform(mode) {
    if (!editingEl) return;
    // Neutralize CSS text-transform AND font-variant on the editing element
    // so the new case is actually visible — without this, a class like
    // `.card-min { text-transform: uppercase }` or `font-variant: small-caps`
    // keeps rendering the prior case even after the source has been switched
    // to lower/title, and the button looks dead. Both overrides land inline
    // + !important so they beat any selector. See the rule-1 comment above
    // applyInlineStyle for why this is the correct pattern.
    const cs = getComputedStyle(editingEl);
    if (cs.textTransform && cs.textTransform !== "none") {
      editingEl.style.setProperty("text-transform", "none", "important");
    }
    if (cs.fontVariant && cs.fontVariant !== "normal") {
      editingEl.style.setProperty("font-variant", "normal", "important");
    }
    const sel = window.getSelection();
    const hasSelection = sel && sel.rangeCount > 0 && !sel.isCollapsed
      && editingEl.contains(sel.getRangeAt(0).commonAncestorContainer);
    if (hasSelection) {
      // Selection branch — operate on the highlighted range only.
      const range = sel.getRangeAt(0);
      const original = range.toString();
      const transformed = transformCase(original, mode);
      if (transformed === original) return;
      range.deleteContents();
      const node = document.createTextNode(transformed);
      range.insertNode(node);
      const newRange = document.createRange();
      newRange.selectNode(node);
      sel.removeAllRanges();
      sel.addRange(newRange);
      return;
    }
    // No selection — apply to every text node in the editing element so the
    // common "click into the element, hit AA" flow just works. Preserves the
    // surrounding inline markup (<b>, <i>, <a>, etc.) since we mutate node
    // values in place instead of replacing the subtree.
    const walker = document.createTreeWalker(editingEl, NodeFilter.SHOW_TEXT);
    let changed = false;
    while (walker.nextNode()) {
      const tn = walker.currentNode;
      const next = transformCase(tn.nodeValue, mode);
      if (next !== tn.nodeValue) { tn.nodeValue = next; changed = true; }
    }
    if (!changed) return;
  }
  // Text-scoped style controls (font/size/color/bg) — repopulate as the caret
  // moves across ranges with different styling.
  function populateTextStyleControls(el) {
    const cs = getComputedStyle(el);
    $("cf-edit-color").value = rgbToHex(cs.color);
    // Background may be transparent; the picker can't represent that, default to a sensible color
    const bg = cs.backgroundColor;
    $("cf-edit-bg").value = (bg && !/rgba?\([^)]*,\s*0\s*\)$/.test(bg)) ? rgbToHex(bg) : "#ffffff";
    syncColorSwatchButtons();
    // Match the dropdown to the element's current font family. Computed style
    // returns the resolved stack ('"Marcellus", Georgia, serif'); we match by
    // the first family name in either side's stack.
    const select = $("cf-edit-font-family");
    if (select) {
      const currentFirst = primaryFontFamily(cs.fontFamily);
      let matched = false;
      for (const opt of select.options) {
        if (primaryFontFamily(opt.value) === currentFirst) {
          select.value = opt.value;
          matched = true;
          break;
        }
      }
      if (!matched) select.value = "";
    }
    const fs = parseFloat(cs.fontSize) || 16;
    $("cf-edit-font-size").value = Math.round(fs * 10) / 10;
    // Line height — computed style returns a px value; convert back to a
    // unitless multiplier (line-height / font-size). Browsers report "normal"
    // as a small font-size-derived value, which rounds nicely to ~1.2.
    const lhPx = parseFloat(cs.lineHeight);
    const lh = (isFinite(lhPx) && fs > 0) ? lhPx / fs : 1.4;
    $("cf-edit-line-height").value = Math.round(lh * 100) / 100;
  }
  // Full populate — text controls plus border/radius. Called once at edit
  // start and on explicit reset; NOT on every selection change.
  function populateStyleControls(el) {
    populateTextStyleControls(el);
    const cs = getComputedStyle(el);
    // Border weight / color / radius — read top-side as the representative
    // value (browsers split shorthand into per-side computed values).
    const bw = parseFloat(cs.borderTopWidth) || 0;
    $("cf-edit-border-w").value = Math.round(bw * 10) / 10;
    $("cf-edit-border-c").value = rgbToHex(cs.borderTopColor) || "#000000";
    const br = parseFloat(cs.borderTopLeftRadius) || 0;
    $("cf-edit-radius").value = Math.round(br);
    // Padding — use the top-side value as representative (matches how we
    // read border). When sides differ, the spinner shows the top value and
    // applying a new value resets all four sides to that.
    const pd = parseFloat(cs.paddingTop) || 0;
    $("cf-edit-padding").value = Math.round(pd);
    // Opacity — store as 0–100 percent. Computed `opacity` is a number in
    // [0,1]; 1 (or non-finite) shows as 100 in the spinner.
    const op = parseFloat(cs.opacity);
    $("cf-edit-opacity").value = Math.round(isFinite(op) ? Math.max(0, Math.min(1, op)) * 100 : 100);
    // Sync the alignment cycle buttons to the element's current alignment.
    // Case has no "current state" (it's a one-shot transform) so we always
    // reset to "upper" on editor-open — the user can cycle from there.
    $("cf-edit-halign-cycle").dataset.cfAlign = readHAlignToken(el);
    $("cf-edit-valign-cycle").dataset.cfValign = readVAlignToken(el);
    $("cf-edit-case-cycle").dataset.cfCase = "upper";
  }
  // Extract the first (primary) family name from a font-family stack string.
  // Lowercases, strips quotes and trailing fallback families. Returns "" for
  // the (inherit) sentinel so it matches itself but nothing else.
  function primaryFontFamily(stack) {
    if (!stack) return "";
    const first = stack.split(",")[0].trim().toLowerCase();
    return first.replace(/^['"]|['"]$/g, "");
  }
  // Curated font list — page-detected web fonts on top, then a small set of
  // web-safe families grouped by category. Restricted to known options on
  // purpose; users can't type a free-form family string.
  const CF_CURATED_FONTS = [
    // [css value, display label, category]
    ['system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif', 'System sans', 'sans'],
    ['"Helvetica Neue", Helvetica, Arial, sans-serif',                     'Helvetica',   'sans'],
    ['Arial, Helvetica, sans-serif',                                       'Arial',       'sans'],
    ['Verdana, Geneva, sans-serif',                                        'Verdana',     'sans'],
    ['Tahoma, Geneva, sans-serif',                                         'Tahoma',      'sans'],
    ['"Trebuchet MS", "Lucida Grande", sans-serif',                        'Trebuchet MS','sans'],
    ['Georgia, "Times New Roman", Times, serif',                           'Georgia',     'serif'],
    ['"Times New Roman", Times, serif',                                    'Times New Roman', 'serif'],
    ['Palatino, "Palatino Linotype", "Book Antiqua", serif',               'Palatino',    'serif'],
    ['Garamond, "EB Garamond", "Apple Garamond", serif',                   'Garamond',    'serif'],
    ['ui-monospace, "SF Mono", Menlo, Consolas, "Courier New", monospace', 'Menlo / SF Mono', 'mono'],
    ['"Courier New", Courier, monospace',                                  'Courier New', 'mono'],
  ];
  function buildFontFamilyOptions() {
    const select = $("cf-edit-font-family");
    if (!select) return;
    const detected = [];
    const seen = new Set();
    if (document.fonts && document.fonts.forEach) {
      document.fonts.forEach((f) => {
        const fam = (f.family || "").replace(/^['"]|['"]$/g, "").trim();
        if (!fam) return;
        const key = fam.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        detected.push(fam);
      });
    }
    select.innerHTML = "";
    // (inherit) — first, no group
    const inheritOpt = document.createElement("option");
    inheritOpt.value = "";
    inheritOpt.textContent = "(inherit)";
    select.appendChild(inheritOpt);
    // Page-detected
    if (detected.length > 0) {
      const grp = document.createElement("optgroup");
      grp.label = "On this page";
      detected.forEach((fam) => {
        const opt = document.createElement("option");
        opt.value = '"' + fam + '", sans-serif';
        opt.textContent = fam;
        grp.appendChild(opt);
      });
      select.appendChild(grp);
    }
    // Curated by category
    const groups = { sans: "Sans-serif", serif: "Serif", mono: "Monospace" };
    Object.keys(groups).forEach((cat) => {
      const grp = document.createElement("optgroup");
      grp.label = groups[cat];
      CF_CURATED_FONTS.filter((f) => f[2] === cat).forEach(([value, label]) => {
        const opt = document.createElement("option");
        opt.value = value;
        opt.textContent = label;
        grp.appendChild(opt);
      });
      select.appendChild(grp);
    });
  }

  function onDblClick(e) {
    if (insideOurUI(e.target)) return;
    if (elementMode) return;
    // Reject pairs the OS counted as a dblclick but landed too far apart in
    // time. Skip the check on the very first dblclick of a session
    // (prevClickTime === 0), otherwise the uninitialized timer trips the guard
    // and the editor never opens on attempt 1.
    if (prevClickTime !== 0 && lastClickTime - prevClickTime > MAX_DBLCLICK_INTERVAL_MS) return;
    // If another element is already being edited, allow swapping: dblclicks
    // INSIDE the current target keep the existing edit (so contenteditable
    // can handle word-selection); dblclicks elsewhere commit-then-start.
    if (editingEl) {
      if (editingEl.contains(e.target)) return;
      commitOrExitCurrentEdit();
    }
    // Image path: if the dblclick landed on / inside an <img>/<video>/<svg>/etc.,
    // open the resize-only experience instead of looking for text.
    let img = findImageAncestor(e.target);
    // Fallback A: walk-up missed it (e.g. a wrapper div with text intercepted
    // the click but an image sits at the same pixel). Ask the browser for
    // every element at the click point and prefer any visible image-editable
    // node in that stack. Handles <a> wrapping <img>, overlapping flex siblings,
    // wrappers with their own text content.
    if (!img && typeof document.elementsFromPoint === "function") {
      const stack = document.elementsFromPoint(e.clientX, e.clientY);
      for (const cand of stack) {
        if (insideOurUI(cand)) continue;
        if (IMAGE_EDITABLE_TAGS.has(cand.tagName)) { img = cand; break; }
        if (cand.tagName === "PICTURE") {
          const inner = cand.querySelector("img");
          if (inner) { img = inner; break; }
        }
      }
    }
    // Fallback B: container-descendant scan. The two checks above MISS when
    // the dblclick lands on a card border, rounded-corner gap (overflow:hidden
    // clips the corner area inside the card but outside the image), or a thin
    // padding band between an image and a sibling text body — the click pixel
    // genuinely has no image at it, but the user "meant" the image inside the
    // card they clicked. Walk up to 3 container levels and check for image
    // descendants whose bounding rect contains (or is within ~10px of) the
    // click point. Tight tolerance + small walk-up depth keeps text clicks
    // from being steered to the wrong image.
    if (!img) {
      const IMG_SEL = "img,video,canvas,picture,svg,iframe";
      const TOLERANCE_PX = 10;
      let scope = e.target;
      for (let depth = 0; scope && scope !== document.body && depth < 3; depth++, scope = scope.parentElement) {
        if (insideOurUI(scope)) break;
        if (!scope.querySelectorAll) continue;
        const candidates = scope.querySelectorAll(IMG_SEL);
        let nearest = null;
        let nearestDist = Infinity;
        for (const cand of candidates) {
          if (insideOurUI(cand)) continue;
          const r = cand.getBoundingClientRect();
          if (r.width < 8 || r.height < 8) continue;  // skip tiny icons
          // Inside the image rect — definite match, short-circuit.
          if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
            nearest = cand; nearestDist = 0; break;
          }
          // Distance from click to the nearest point on the image rect.
          const dx = Math.max(r.left - e.clientX, 0, e.clientX - r.right);
          const dy = Math.max(r.top - e.clientY, 0, e.clientY - r.bottom);
          const d = Math.hypot(dx, dy);
          if (d <= TOLERANCE_PX && d < nearestDist) { nearest = cand; nearestDist = d; }
        }
        if (nearest) {
          img = nearest.tagName === "PICTURE" ? (nearest.querySelector("img") || nearest) : nearest;
          break;
        }
      }
    }
    if (img) {
      e.preventDefault();
      const existingImg = pending.find((c) => {
        if (c.type !== "text-edit") return false;
        const t = findElementByAnchorInfo(c.elements && c.elements[0]);
        return t === img;
      });
      if (existingImg) { editPendingComment(existingImg); return; }
      startImageEdit(img);
      return;
    }
    const el = findEditableAncestor(e.target);
    if (!el) return;
    e.preventDefault();
    // If this element already has a pending text-edit queued, refine it
    // instead of starting fresh — matches the marker-click behavior.
    const existing = pending.find((c) => {
      if (c.type !== "text-edit") return false;
      const t = findElementByAnchorInfo(c.elements && c.elements[0]);
      return t === el;
    });
    if (existing) { editPendingComment(existing); return; }
    startTextEdit(el);
  }

  // ---------------- Pending list ----------------
  // Style-attr + markup diffing for the pending list. Pulls the style="…"
  // declaration off the outer_html, splits into prop:value pairs, and returns
  // the props that differ. Lets the pending row show "font-size: 13px → 22px"
  // when a text-edit was style-only.
  // Pulls the raw style="…" string out of an outer_html snapshot. Returns
  // null if no style attribute was present (vs an empty string for an
  // explicitly empty one).
  function extractStyleAttrRaw(outerHtml) {
    if (!outerHtml) return null;
    const m = outerHtml.match(/<[^>]*\sstyle\s*=\s*"([^"]*)"/i) ||
              outerHtml.match(/<[^>]*\sstyle\s*=\s*'([^']*)'/i);
    return m ? m[1] : null;
  }
  function parseStyleAttr(outerHtml) {
    const raw = extractStyleAttrRaw(outerHtml);
    if (raw == null) return {};
    const props = {};
    raw.split(";").forEach((decl) => {
      const i = decl.indexOf(":");
      if (i < 0) return;
      const k = decl.slice(0, i).trim().toLowerCase();
      const v = decl.slice(i + 1).trim();
      if (k && v) props[k] = v;
    });
    return props;
  }
  function diffStyleAttr(beforeOuter, afterOuter) {
    const a = parseStyleAttr(beforeOuter);
    const b = parseStyleAttr(afterOuter);
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    const out = [];
    keys.forEach((k) => {
      if (a[k] !== b[k]) out.push({ prop: k, before: a[k] || "", after: b[k] || "" });
    });
    return out;
  }
  // Detect simple inline-markup changes the toolbar can apply: <b>, <i>, <u>,
  // <s>, <br>, <small>, etc. Returns a compact "+ <b> · − <i>" summary or "".
  function diffMarkup(beforeHtml, afterHtml) {
    const tagRe = /<\/?(b|strong|i|em|u|s|del|mark|br|small|sup|sub|ul|ol|li)\b[^>]*>/gi;
    const collect = (html) => {
      const s = new Set();
      let m;
      while ((m = tagRe.exec(html)) !== null) {
        if (m[0][1] === "/") continue;
        s.add(m[1].toLowerCase());
      }
      tagRe.lastIndex = 0;
      return s;
    };
    const a = collect(beforeHtml || "");
    const b = collect(afterHtml || "");
    const added = [...b].filter((t) => !a.has(t));
    const removed = [...a].filter((t) => !b.has(t));
    const parts = [];
    if (added.length) parts.push("+ " + added.map((t) => "<" + t + ">").join(" "));
    if (removed.length) parts.push("− " + removed.map((t) => "<" + t + ">").join(" "));
    return parts.join(" · ");
  }

  function renderPending() {
    const list = $("cf-pending-list");
    list.innerHTML = "";

    // Show a "Claude is processing…" banner while we wait for the agent to
    // respond to the most recent batch. Cleared when history.json has an
    // in_response_to matching any of our submitted comment ids.
    if (lastSubmittedBatch) {
      const banner = document.createElement("div");
      banner.className = "cf-processing-banner" + (isBatchStale ? " cf-processing-stale" : "");
      const submittedAgo = relTime(lastSubmittedBatch.submitted_at);
      const n = lastSubmittedBatch.comment_ids.length;
      const submittedList = lastSubmittedBatch.pending_snapshot.map(c =>
        `<div class="cf-comment-quote" style="margin-top:4px;">${escapeHtml(c.comment)}</div>`
      ).join("");

      if (isBatchStale) {
        banner.innerHTML = `
          <div class="cf-processing-row">
            <div class="cf-stale-icon" aria-hidden="true">⚠</div>
            <div class="cf-processing-body">
              <strong>No agent picked this up yet</strong>
              <span class="cf-processing-meta">${n} comment${n === 1 ? "" : "s"} · submitted ${submittedAgo}</span>
            </div>
          </div>
          <div class="cf-processing-status">
            Your batch is saved in <code>feedback/inbox.jsonl</code> but no Claude Code session appears to be watching this directory. To process it: open a terminal here, run <code>claude</code>, and ask it to <em>"process pending feedback in this directory"</em>. Claude will scan the inbox and pick up your comments.
          </div>
          <details class="cf-processing-details">
            <summary>show what you submitted</summary>
            ${submittedList}
          </details>
          <div style="margin-top:8px; display:flex; gap:6px;">
            <button class="cf-btn cf-btn-small" id="cf-dismiss-stale">dismiss</button>
            <button class="cf-btn cf-btn-small" id="cf-keep-waiting">keep waiting</button>
          </div>
        `;
      } else {
        banner.innerHTML = `
          <div class="cf-processing-row">
            <div class="cf-spinner" aria-hidden="true"></div>
            <div class="cf-processing-body">
              <strong>Claude is processing…</strong>
              <span class="cf-processing-meta">${n} comment${n === 1 ? "" : "s"} · submitted ${submittedAgo}</span>
            </div>
          </div>
          <details class="cf-processing-details">
            <summary>show what you submitted</summary>
            ${submittedList}
          </details>
        `;
      }
      list.appendChild(banner);
      // Wire dismiss/keep-waiting after the banner is in the DOM
      if (isBatchStale) {
        const dis = document.getElementById("cf-dismiss-stale");
        const wait = document.getElementById("cf-keep-waiting");
        if (dis) dis.addEventListener("click", () => {
          // Drop the banner; the inbox entry remains for the agent to pick up later
          lastSubmittedBatch = null;
          isBatchStale = false;
          if (staleTimer) { clearTimeout(staleTimer); staleTimer = null; }
          saveLS();
          syncTitle();
          renderPending();
        });
        if (wait) wait.addEventListener("click", () => {
          // Reset the staleness flag; restart the timer
          isBatchStale = false;
          if (staleTimer) clearTimeout(staleTimer);
          staleTimer = setTimeout(() => {
            if (lastSubmittedBatch && !lastBatchProcessed()) {
              isBatchStale = true;
              renderPending();
            }
          }, STALE_AFTER_MS);
          renderPending();
        });
      }
    }

    pending.forEach((c) => {
      const item = document.createElement("div");
      item.className = "cf-comment-item";
      const quote = document.createElement("div");
      quote.className = "cf-comment-quote";
      if (c.type === "general") {
        quote.classList.add("cf-comment-general");
        quote.textContent = "general question";
      } else if (c.type === "elements") {
        quote.innerHTML = c.elements.map(e =>
          `<div>${escapeHtml(e.tag)}${e.id ? "#" + escapeHtml(e.id) : ""} — <span style="opacity:0.7">${escapeHtml(e.text_snippet.slice(0, 60))}${e.text_snippet.length > 60 ? "…" : ""}</span></div>`
        ).join("");
      } else if (c.type === "snapshot") {
        const r = c.region || {};
        const dims = (r.w && r.h) ? `${Math.round(r.w)} × ${Math.round(r.h)}` : "";
        const n = (c.elements && c.elements.length) || 0;
        quote.innerHTML =
          `<div class="cf-pq-label">snapshot${dims ? " · " + escapeHtml(dims) : ""}</div>` +
          (c.image_url ? `<img src="${escapeHtml(c.image_url)}" alt="snapshot" class="cf-pq-image cf-pq-image-small">` : "") +
          (n > 0 ? `<div class="cf-pq-meta">${n} element${n === 1 ? "" : "s"} in region</div>` : "");
      } else if (c.type === "delete") {
        const tag = (c.element && c.element.tag) || "element";
        const txt = (c.element && c.element.text_snippet) || "";
        const txtShort = txt.length > 80 ? txt.slice(0, 80) + "…" : txt;
        const parentLabel = c.parent ? (c.parent.id ? "#" + c.parent.id : c.parent.tag) : "(root)";
        quote.innerHTML =
          `<div class="cf-pq-label">delete · ${escapeHtml(tag)}</div>` +
          (txtShort ? `<div class="cf-pq-text-faint">"${escapeHtml(txtShort)}"</div>` : "") +
          `<div class="cf-pq-meta">from ${escapeHtml(parentLabel)} at position ${escapeHtml(String(c.index != null ? c.index : "?"))}</div>`;
      } else if (c.type === "text-edit") {
        const tag = (c.elements && c.elements[0] && c.elements[0].tag) || "text";
        const before = (c.original_text || "").trim();
        const after = (c.new_text || "").trim();
        const textChanged = before !== after;
        const styleDiff = diffStyleAttr(c.original_outer_html || "", c.new_outer_html || "");
        const markupDiff = diffMarkup(c.original_html || "", c.new_html || "");
        const styleOnly = !textChanged && (styleDiff.length > 0 || markupDiff);
        const label = styleOnly ? "style edit" : "text edit";
        const parts = [`<div class="cf-pq-label">${label} · ${escapeHtml(tag)}</div>`];
        if (textChanged) {
          const beforeShort = before.length > 80 ? before.slice(0, 80) + "…" : before;
          const afterShort = after.length > 80 ? after.slice(0, 80) + "…" : after;
          parts.push(`<div class="cf-pq-before"><s>${escapeHtml(beforeShort)}</s></div>`);
          parts.push(`<div class="cf-pq-after">${escapeHtml(afterShort)}</div>`);
        } else if (styleOnly) {
          // No text change — show the current text once as context so the row isn't empty
          const ctxShort = after.length > 60 ? after.slice(0, 60) + "…" : after;
          if (ctxShort) parts.push(`<div class="cf-pq-text-faint">"${escapeHtml(ctxShort)}"</div>`);
        }
        if (styleDiff.length) {
          const rows = styleDiff.map(d =>
            `<div class="cf-pq-style-row">` +
            `<span class="cf-pq-style-prop">${escapeHtml(d.prop)}:</span> ` +
            `<s class="cf-pq-style-before">${escapeHtml(d.before || "—")}</s> ` +
            `<span class="cf-pq-style-arrow">→</span> ` +
            `<span class="cf-pq-style-after">${escapeHtml(d.after || "—")}</span>` +
            `</div>`
          ).join("");
          parts.push(`<div class="cf-pq-style-card">${rows}</div>`);
        }
        if (markupDiff) {
          parts.push(`<div class="cf-pq-markup">${escapeHtml(markupDiff)}</div>`);
        }
        quote.innerHTML = parts.join("");
      } else if (c.type === "gallery-update") {
        const slides = c.slides || [];
        const n = slides.length;
        const targetLabel = c.target ? " · " + c.target : "";
        const thumbs = slides.slice(0, 4).map(s =>
          `<img class="cf-pq-gallery-thumb" loading="lazy" src="${escapeHtml(s.src || "")}" alt="">`
        ).join("");
        const captions = slides
          .map(s => (s.caption || "").trim())
          .filter(Boolean)
          .slice(0, 3)
          .map(t => t.length > 40 ? t.slice(0, 40) + "…" : t);
        quote.innerHTML =
          `<div class="cf-pq-label">gallery update · ${n} slide${n === 1 ? "" : "s"}${escapeHtml(targetLabel)}</div>` +
          (thumbs ? `<div class="cf-pq-gallery-thumbs">${thumbs}${n > 4 ? `<span class="cf-pq-gallery-more">+${n - 4}</span>` : ""}</div>` : "") +
          (captions.length ? `<div class="cf-pq-meta">${escapeHtml(captions.join(" · "))}</div>` : "");
      } else {
        quote.textContent = '"' + (c.quote || "") + '"';
      }
      const body = document.createElement("div");
      body.className = "cf-comment-body";
      body.textContent = c.comment;
      const meta = document.createElement("div");
      meta.className = "cf-comment-meta";
      const ts = document.createElement("span");
      ts.textContent = relTime(c.created_at);
      const actions = document.createElement("span");
      actions.className = "cf-comment-actions";
      const editBtn = document.createElement("button");
      editBtn.className = "cf-comment-edit";
      editBtn.textContent = "edit";
      editBtn.addEventListener("click", (e) => { e.stopPropagation(); editPendingComment(c); });
      const del = document.createElement("button");
      del.className = "cf-comment-delete";
      del.textContent = "remove";
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        // For comment types that mutated the page (text-edit, delete), revert
        // the visual change here too — users expect "remove" in the pending
        // list to fully undo the pending edit, not just clear the row and
        // leave the page-level change behind.
        if (c.type === "text-edit" || c.type === "delete") revertCommentVisual(c);
        pending = pending.filter((x) => x.id !== c.id);
        saveLS();
        renderPending();
      });
      actions.appendChild(editBtn);
      actions.appendChild(del);
      meta.appendChild(ts);
      meta.appendChild(actions);
      // Click anywhere on the item (except buttons) to scroll to the target
      const target = getCommentTarget(c);
      if (target) {
        item.classList.add("cf-comment-clickable");
        item.title = "click to scroll to target";
        item.addEventListener("click", () => scrollToAndPulse(target));
      }
      item.appendChild(quote);
      item.appendChild(body);
      item.appendChild(meta);
      list.appendChild(item);
    });
    $("cf-submit").disabled = pending.length === 0;
    $("cf-clear-all").disabled = pending.length === 0;
    updateBadge();
    refreshPendingEditMarkers();
  }

  // Resolve a pending comment's target element so the row can scroll-to-it
  // and so we can drop a "pending edit" dot on text-edit targets.
  function getCommentTarget(c) {
    if (c.type === "general") return null;
    if (c.type === "snapshot") return null;
    const a = c.type === "selection" ? c.anchor : (c.elements && c.elements[0]);
    return findElementByAnchorInfo(a);
  }

  function scrollToAndPulse(el) {
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("cf-pulse");
    setTimeout(() => el.classList.remove("cf-pulse"), 1600);
  }

  // Drop a real pencil-marker badge on any element that has a pending text-edit
  // so the user can see at a glance which parts of the page have queued changes.
  // Hovering the marker outlines the element; clicking it opens refinement.
  function refreshPendingEditMarkers() {
    document.querySelectorAll(".cf-edit-marker").forEach((m) => m.remove());
    document.querySelectorAll(".cf-has-pending-edit")
      .forEach((el) => el.classList.remove("cf-has-pending-edit"));
    document.querySelectorAll(".cf-pending-edit-hover")
      .forEach((el) => el.classList.remove("cf-pending-edit-hover"));
    // Place a marker on every pending comment's target, including selection,
    // elements, move. General + snapshot have no single target element.
    pending.forEach((c) => {
      const targets = [];
      if (c.type === "elements" && c.elements) {
        c.elements.forEach((info) => {
          const t = findElementByAnchorInfo(info);
          if (t && t !== editingEl) targets.push(t);
        });
      } else {
        const t = getCommentTarget(c);
        if (t && t !== editingEl) targets.push(t);
      }
      targets.forEach((t) => placeEditMarker(t, c));
    });
  }
  const CF_MARKER_GLYPH = {
    "text-edit": "✎",
    "selection": "💬",
    "elements":  "💬",
  };
  // Tags that can't host children (void / replaced elements) — markers for
  // these get appended to <body> with absolute document-coord positioning
  // so they ride along with the page on scroll.
  const CF_MARKER_FLOATING_TAGS = new Set([
    "IMG", "VIDEO", "CANVAS", "IFRAME", "EMBED", "OBJECT", "INPUT",
    "BR", "HR", "AREA", "PICTURE",
  ]);
  function placeEditMarker(target, c) {
    target.classList.add("cf-has-pending-edit");
    const marker = document.createElement("span");
    marker.className = "cf-edit-marker";
    marker.textContent = CF_MARKER_GLYPH[c.type] || "✎";
    const label = c.type === "text-edit" ? "pending text edit"
                : c.type === "selection" ? "pending selection comment"
                : c.type === "elements"  ? "pending element comment"
                : "pending edit";
    const preview = c.type === "text-edit"
      ? (c.new_text || "").slice(0, 80)
      : (c.comment || "").slice(0, 80);
    marker.title = label + "\n" +
                   (preview ? '"' + preview + (preview.length === 80 ? "…" : "") + '"\n' : "") +
                   "click for options";
    marker.setAttribute("aria-label", label);
    marker.addEventListener("mouseenter", () => target.classList.add("cf-pending-edit-hover"));
    marker.addEventListener("mouseleave", () => target.classList.remove("cf-pending-edit-hover"));
    marker.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      openMarkerMenu(marker, c);
    });
    marker.addEventListener("dblclick", (e) => { e.stopPropagation(); e.preventDefault(); });
    if (CF_MARKER_FLOATING_TAGS.has(target.tagName)) {
      // Void element — can't accept children. Float beside it instead.
      marker.classList.add("cf-marker-floating");
      const r = target.getBoundingClientRect();
      marker.style.position = "absolute";
      marker.style.top  = (r.top  + window.scrollY + 4) + "px";
      marker.style.left = (r.right + window.scrollX - 22) + "px";
      document.body.appendChild(marker);
    } else {
      target.appendChild(marker);
    }
  }
  function openMarkerMenu(marker, c) {
    const menu = $("cf-marker-menu");
    if (!menu) return;
    const r = marker.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 220)) + "px";
    menu.style.top  = (r.bottom + 6) + "px";
    menu._comment = c;
    menu.classList.add("cf-visible");
  }
  function closeMarkerMenu() {
    const menu = $("cf-marker-menu");
    if (menu) { menu.classList.remove("cf-visible"); menu._comment = null; }
  }
  function markerMenuRefine() {
    const menu = $("cf-marker-menu");
    const c = menu && menu._comment;
    closeMarkerMenu();
    if (c) editPendingComment(c);
  }
  function markerMenuRemove() {
    const menu = $("cf-marker-menu");
    const c = menu && menu._comment;
    closeMarkerMenu();
    if (!c) return;
    revertCommentVisual(c);
    pending = pending.filter((x) => x.id !== c.id);
    saveLS();
    renderPending();
    showToast("pending edit removed");
  }

  // Snap the page back to the pre-edit state for the comment about to be
  // removed. text-edit replaces the live element with a clone of its captured
  // outer_html so every attribute (class, align, dir, style) snaps back, not
  // just innerHTML. move unwinds and replays the parent's full move stack so
  // sibling order stays correct when the user removes one of several pending
  // moves on the same parent. selection / elements / general / snapshot don't
  // mutate the page, so they need no revert.
  function revertCommentVisual(c) {
    if (c.type === "text-edit") {
      const t = findElementByAnchorInfo(c.elements && c.elements[0]);
      if (!t) return;
      if (c.original_outer_html) {
        const template = document.createElement("template");
        template.innerHTML = c.original_outer_html;
        const fresh = template.content.firstElementChild;
        if (fresh) { t.replaceWith(fresh); return; }
      }
      // Fallback for very old pending entries that pre-date original_outer_html.
      if (c.original_html != null) t.innerHTML = c.original_html;
    } else if (c.type === "delete") {
      if (!c.parent || !c.original_outer_html) return;
      let parent = null;
      if (c.parent.id) parent = document.getElementById(c.parent.id);
      if (!parent && c.parent.selector) {
        try { parent = document.querySelector(c.parent.selector); } catch (e) {}
      }
      if (!parent) return;
      const template = document.createElement("template");
      template.innerHTML = c.original_outer_html;
      const fresh = template.content.firstElementChild;
      if (!fresh) return;
      const others = Array.from(parent.children);
      const idx = Math.max(0, Math.min(c.index != null ? c.index : others.length, others.length));
      if (idx >= others.length) parent.appendChild(fresh);
      else parent.insertBefore(fresh, others[idx]);
    }
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function relTime(iso) {
    const d = new Date(iso);
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return "just now";
    if (diff < 3600) return Math.floor(diff / 60) + "m ago";
    return d.toLocaleTimeString();
  }

  function updateBadge() {
    const badge = $("cf-badge");
    // Badge counts only pending comments. Once submitted, the processing
    // banner is the visible state — no need to also bump the badge.
    badge.textContent = pending.length > 0 ? String(pending.length) : "";
    updateClearAllFloat();
  }
  // Floating "clear all" button — sits above (or below, when the pill is in
  // a top corner) the launcher pill. Visible only when there are pending
  // comments AND the panel is closed (it'd otherwise overlap the panel).
  function updateClearAllFloat() {
    const btn = $("cf-clear-all-float");
    if (!btn) return;
    const cnt = $("cf-clear-all-count");
    const panelOpen = $("cf-panel") && $("cf-panel").classList.contains("cf-open");
    const show = pending.length > 0 && !panelOpen;
    btn.classList.toggle("cf-visible", show);
    if (cnt) cnt.textContent = pending.length > 0 ? String(pending.length) : "";
  }
  // Shared clear-all handler — both the panel's footer button and the
  // floating button above the pill route through here so the confirmation
  // and the cleanup are consistent. Clear-all REVERTS each pending edit's
  // visual change before emptying the queue — without that, the user would
  // see the page still carrying every edit but the queue would say "0,"
  // and a fresh submit would capture nothing.
  function clearAllPending() {
    // Cancel any in-flight edit first so its uncommitted DOM mutations
    // (toolbar style changes, mid-drag resize, flex/grid sibling pins,
    // contenteditable text changes) revert too. Without this step the
    // in-progress edit isn't in `pending` yet and the user sees "clear all"
    // miss the very change they were just looking at.
    const hadInFlightEdit = !!editingEl;
    if (editingEl) cancelTextEdit();
    if (pending.length === 0) {
      if (hadInFlightEdit) showToast("in-flight edit cancelled");
      return;
    }
    const n = pending.length;
    const ok = window.confirm(`Discard ${n} pending comment${n === 1 ? "" : "s"}? This can't be undone.`);
    if (!ok) return;
    const toRevert = pending.slice();
    pending = [];
    // Reverse-creation order: each revert restores the element/parent to its
    // state RIGHT BEFORE the latest edit, so after all reverts run the page
    // matches the original. Single pass across types (move / text-edit /
    // delete) keeps chained-edit interactions correct — e.g. a delete whose
    // index was captured between two moves on the same parent ends up
    // re-inserted at the right spot because the later move has already been
    // unwound by the time the delete revert runs.
    toRevert.sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
    toRevert.forEach((c) => {
      try { clearAllRevertOne(c); } catch (e) { console.warn("revert failed for", c.id, e); }
    });
    saveLS();
    renderPending();
    showToast(n === 1 ? "pending cleared — edit reverted" : "pending cleared — " + n + " edits reverted");
  }
  // Per-comment revert for clearAllPending. text-edit and delete route
  // through revertCommentVisual. selection / elements / general / snapshot
  // don't mutate the page, so they're no-ops here.
  function clearAllRevertOne(c) {
    if (c.type === "text-edit" || c.type === "delete") {
      revertCommentVisual(c);
    }
  }

  // ---------------- Submit batch ----------------
  let submittingBatch = false;
  async function submitBatch() {
    if (!pending.length) return;
    // Guard against double-submit (fast double-click on submit button, or
    // ⌘S + click landing back-to-back). Without it, two POSTs land with the
    // same comment ids and the inbox gets duplicate entries.
    if (submittingBatch) return;
    submittingBatch = true;
    const snapshot = pending.slice();
    const commentIds = snapshot.map(c => c.id);
    const batch = {
      submitted_at: new Date().toISOString(),
      page_url: location.pathname,
      comments: snapshot,
    };
    try {
      const resp = await fetch(FEEDBACK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(batch),
      });
      if (!resp.ok) throw new Error("server returned " + resp.status);
      lastSubmittedBatch = {
        comment_ids: commentIds,
        submitted_at: batch.submitted_at,
        pending_snapshot: snapshot,
      };
      isBatchStale = false;
      pending = [];
      saveLS();
      syncTitle();
      renderPending();
      showToast("batch sent — Claude is processing", 3500);
      // Warn the user if no agent picks up the batch within STALE_AFTER_MS
      if (staleTimer) clearTimeout(staleTimer);
      staleTimer = setTimeout(() => {
        if (lastSubmittedBatch && !lastBatchProcessed()) {
          isBatchStale = true;
          renderPending();
        }
      }, STALE_AFTER_MS);
    } catch (e) {
      console.error(e);
      showToast("failed to send: " + e.message, 4500);
    } finally {
      submittingBatch = false;
    }
  }

  // ---------------- Title sync ----------------
  // The tab title reflects what state the batch is in, so the user can tell
  // at a glance from another tab. Precedence (highest first):
  //   🔔  changes ready (pendingReload active)
  //   ⏳  agent is processing a submitted batch
  //   (no prefix) — idle
  function syncTitle() {
    if (!originalTitle) return;
    let prefix = "";
    if (pendingReload) prefix = "🔔 ";
    else if (lastSubmittedBatch) prefix = "⏳ ";
    document.title = prefix + originalTitle;
  }

  // ---------------- Pending-reload state ----------------
  function setPendingReload(addCount) {
    pendingReloadCount += addCount;
    const n = pendingReloadCount;
    const msg = `${n} change${n === 1 ? "" : "s"} ready, reload to see`;
    $("cf-reload-msg").textContent = msg;
    $("cf-reload-banner").classList.add("cf-visible");
    if (!pendingReload) {
      pendingReload = true;
      if (!originalTitle) originalTitle = document.title;
    }
    syncTitle();
  }

  function doReload() {
    if (!pendingReload) return;
    sessionStorage.setItem("cf-scroll-y", String(window.scrollY));
    // Restore the title before unload so the OS tab-list briefly sees the
    // clean version (mostly cosmetic; the new page sets its own title anyway).
    if (originalTitle) document.title = originalTitle;
    location.reload();
  }

  function lastBatchProcessed() {
    if (!lastSubmittedBatch) return true;
    const mine = new Set(lastSubmittedBatch.comment_ids);
    for (const b of history) {
      for (const ch of (b.changes || [])) {
        for (const cid of (ch.in_response_to || [])) {
          if (mine.has(cid)) return true;
        }
      }
    }
    return false;
  }


  // ---------------- Agent-prompt polling ----------------
  // The agent appends JSON lines to feedback/prompts.jsonl when it needs input
  // from the user mid-session (a decision, a missing URL, confirmation on an
  // ambiguous edit). We poll the file alongside history, surface the newest
  // unanswered prompt in the cf-agent-prompt card, and post the reply back
  // through /feedback so it lands in the inbox monitor.
  async function fetchPrompts() {
    try {
      const resp = await fetch(PROMPTS_URL + "?t=" + Date.now());
      if (!resp.ok) {
        // 404 is expected before the agent has written any prompt; treat as no-op.
        if (resp.status === 404) hidePromptCard();
        return;
      }
      const text = await resp.text();
      if (text === lastPromptsString) return;
      lastPromptsString = text;
      const prompts = text.split("\n")
        .map(l => l.trim())
        .filter(Boolean)
        .map(l => { try { return JSON.parse(l); } catch { return null; } })
        .filter(p => p && p.id && p.prompt);
      // Pick the newest unanswered prompt; older unanswered ones stay queued
      // (the card cycles to the next when the current is answered or dismissed).
      const next = [...prompts].reverse().find(p => !answeredPromptIds.has(p.id));
      if (next) showPromptCard(next);
      else hidePromptCard();
    } catch (e) { /* network glitch or mid-write parse */ }
  }

  function showPromptCard(p) {
    if (activePromptId === p.id) return;  // already showing this one
    activePromptId = p.id;
    const card = $("cf-agent-prompt");
    $("cf-agent-prompt-text").textContent = p.prompt;
    const optsBox = $("cf-agent-prompt-options");
    optsBox.innerHTML = "";
    const input = $("cf-agent-prompt-input");
    if (Array.isArray(p.options) && p.options.length > 0) {
      // Quick-reply buttons. Each click submits immediately with the chosen value.
      for (const opt of p.options) {
        const value = typeof opt === "string" ? opt : opt.value;
        const label = typeof opt === "string" ? opt : (opt.label || opt.value);
        const btn = document.createElement("button");
        btn.className = "cf-btn cf-btn-small cf-agent-prompt-option";
        btn.textContent = label;
        btn.addEventListener("click", () => submitPromptResponse(p.id, value));
        optsBox.appendChild(btn);
      }
      // Hide the textarea when there are quick options — keep the UI compact.
      input.style.display = "none";
    } else {
      input.style.display = "";
      input.value = "";
    }
    card.classList.add("cf-visible");
    card.setAttribute("aria-hidden", "false");
    if (input.style.display !== "none") {
      setTimeout(() => input.focus(), 80);
    }
  }

  function hidePromptCard() {
    if (!activePromptId) return;
    activePromptId = null;
    const card = $("cf-agent-prompt");
    card.classList.remove("cf-visible");
    card.setAttribute("aria-hidden", "true");
  }

  function submitPromptResponse(promptId, answer) {
    if (!promptId) return;
    // Mark answered immediately so a slow round-trip doesn't re-show it.
    answeredPromptIds.add(promptId);
    saveLS();
    postFeedback([{
      type: "agent-response",
      prompt_id: promptId,
      answer: answer,
      id: newCommentId(),
      created_at: new Date().toISOString(),
    }]).catch((e) => console.warn("[cf] prompt response failed:", e));
    showToast("reply sent");
    hidePromptCard();
    fetchPrompts();
  }

  // ---------------- History / polling ----------------
  async function fetchHistory() {
    try {
      const resp = await fetch(HISTORY_URL + "?t=" + Date.now());
      if (!resp.ok) return;
      const text = await resp.text();
      if (text === lastHistoryString) return;
      // Parse BEFORE caching the string. If the agent is mid-write and we
      // catch malformed JSON, the throw must not poison `lastHistoryString` —
      // otherwise the next poll sees `text === lastHistoryString` and returns
      // without retrying, silently freezing the page until the file changes
      // again. The stale-deadline set at submit time stands on its own; we no
      // longer push it back here, because unrelated history changes (other
      // pages, other batches) shouldn't extend our user's wait.
      const parsed = JSON.parse(text);
      lastHistoryString = text;
      history = Array.isArray(parsed) ? parsed : [];
      onHistoryUpdated();
    } catch (e) { /* network glitch or mid-write parse */ }
  }

  function onHistoryUpdated() {
    renderHistory();
    updateBadge();
    // If we were waiting on a batch and history has now caught up, clear banner.
    // (The "Changes ready" UI takes over from the processing-banner; no toast.)
    if (lastSubmittedBatch && lastBatchProcessed()) {
      lastSubmittedBatch = null;
      isBatchStale = false;
      if (staleTimer) { clearTimeout(staleTimer); staleTimer = null; }
      saveLS();
      renderPending();
    }

    // Identify genuinely-new changes (arrived since the previous poll).
    const all = flattenChanges();
    const trulyNew = all.filter(ch => !knownChangeIds.has(ch.id));
    knownChangeIds = new Set(all.map(ch => ch.id));

    if (isFirstHistoryFetch) {
      // First fetch on page load — establish baseline silently. No toast,
      // no reload. Any changes already in history are already on the page.
      isFirstHistoryFetch = false;
      // If we just reloaded in response to a "Changes ready" banner, verify
      // the expected anchors actually materialized. Any still missing means
      // the agent's history.json doesn't match the HTML — surface that loudly
      // instead of letting the user trigger reload after reload.
      const expected = sessionStorage.getItem("cf-last-reload-anchors");
      if (expected) {
        sessionStorage.removeItem("cf-last-reload-anchors");
        const stillMissing = expected.split("|").filter(a => a && !findAnchorNode(a));
        if (stillMissing.length > 0) {
          console.error("[cf] anchor still missing after reload:", stillMissing);
          showToast(`⚠ anchor${stillMissing.length === 1 ? "" : "s"} not found: ${stillMissing.join(", ")}. Likely a typo in history.json or the HTML.`, 10000);
        }
      }
      return;
    }
    if (trulyNew.length === 0) {
      syncTitle();
      return;
    }

    // Live update — content arrived while the page was open. The user has
    // likely switched tabs, so surface a 🔔 + persistent banner instead of
    // hijacking the page with an auto-reload. Stash the expected anchors so
    // the post-reload first-fetch can detect a stale history.json.
    const missing = trulyNew.filter(ch => !findAnchorNode(ch.anchor || ch.id));
    if (missing.length > 0) {
      const missingIds = missing.map(ch => ch.anchor || ch.id).sort().join("|");
      sessionStorage.setItem("cf-last-reload-anchors", missingIds);
    } else {
      sessionStorage.removeItem("cf-last-reload-anchors");
    }
    setPendingReload(trulyNew.length);
  }

  function flattenChanges() {
    const out = [];
    for (const b of history) {
      for (const ch of (b.changes || [])) {
        out.push(Object.assign({ batch_id: b.batch_id, batch_ts: b.timestamp, comments: b.comments || [] }, ch));
      }
    }
    return out;
  }

  function findAnchorNode(anchor) {
    // Use ~= (whitespace-separated word match) so an element can carry multiple
    // anchors at once, e.g. data-cf-change="ch-foo ch-bar".
    // Falsy anchor → return null instead of letting CSS.escape stringify
    // `undefined`/`null`/`""` into a selector that matches `data-cf-change="undefined"`.
    if (!anchor || typeof anchor !== "string") return null;
    // ~= requires the value to be a single whitespace-free token. An anchor
    // with spaces silently matches nothing; surface that instead of looping
    // "missing anchor" toasts on every poll.
    if (/\s/.test(anchor)) {
      console.warn("[cf] findAnchorNode: anchor contains whitespace, will not match:", anchor);
      return null;
    }
    // Scope to body so UI internals can't ever shadow a host-page anchor.
    return document.body.querySelector(`[data-cf-change~="${CSS.escape(anchor)}"]`);
  }

  function renderHistory() {
    const list = $("cf-history-list");
    list.innerHTML = "";
    // Newest batch first
    // Show an "↺ undo" button on the 5 most recent changes (across batches,
    // walking newest-first). Click POSTs a `history-undo-request` to the
    // inbox so the agent can reverse the source edit. Older changes are
    // still listed but read-only — the undo affordance is intentionally
    // limited so it doesn't tempt rolling back deep history that other
    // edits may have built on top of.
    let undoRemaining = 5;
    for (let i = history.length - 1; i >= 0; i--) {
      const b = history[i];
      const item = document.createElement("div");
      item.className = "cf-history-batch";

      // Compact batch header (just timestamp, very small)
      const header = document.createElement("div");
      header.className = "cf-history-batch-header";
      header.textContent = (b.timestamp || ("Batch #" + (i + 1))).replace("T", " ");
      item.appendChild(header);

      (b.changes || []).forEach((ch) => {
        const row = document.createElement("div");
        row.className = "cf-history-change";
        row.dataset.changeId = ch.id;
        const t = document.createElement("div");
        t.className = "cf-history-change-title";
        t.textContent = ch.title || ch.id;
        row.appendChild(t);
        // "asked: <comment>" — the user's prompts (description omitted; the
        // page content itself shows what changed).
        const responded = (ch.in_response_to || []).map((cid) => (b.comments || []).find((c) => c.id === cid)).filter(Boolean);
        responded.forEach((c) => {
          const q = document.createElement("div");
          q.className = "cf-history-change-quote";
          q.textContent = "asked: " + c.comment;
          row.appendChild(q);
        });
        if (undoRemaining > 0) {
          undoRemaining--;
          const undoBtn = document.createElement("button");
          undoBtn.className = "cf-history-undo-btn";
          undoBtn.textContent = "↺ undo";
          undoBtn.title = "Request a reverse of this change (agent will edit source + reload)";
          undoBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            requestHistoryUndo(ch, b);
          });
          row.appendChild(undoBtn);
        }
        row.addEventListener("click", () => focusChange(ch));
        item.appendChild(row);
      });

      list.appendChild(item);
    }
    $("cf-tour").disabled = flattenChanges().length === 0;
  }

  function focusChange(ch) {
    const anchor = ch.anchor || ch.id;
    const node = findAnchorNode(anchor);
    if (!node) {
      showToast(`couldn't find region for change "${anchor}"`, 3500);
      return;
    }
    document.querySelectorAll(".cf-change-active").forEach((el) => el.classList.remove("cf-change-active"));
    node.classList.add("cf-change-active");
    node.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  // POST a history-undo request to the inbox. The agent watches the inbox
  // for `source: "history-undo-request"` batches and reverses the named
  // source edit, then appends a new history batch documenting the revert.
  // The page reloads on the next history.json poll and the user sees the
  // undo as a normal history entry.
  function requestHistoryUndo(ch, batch) {
    const label = ch.title || ch.id;
    const ok = window.confirm(
      'Request undo of:\n\n"' + label + '"\n\n' +
      "This sends a request to the agent to reverse the source edit. The page will reload once the revert lands in history.json. If later edits touched the same elements the agent may ask before unwinding those too."
    );
    if (!ok) return;
    postFeedback([{
      id: "c-undo-" + Date.now(),
      type: "general",
      created_at: new Date().toISOString(),
      comment:
        "[undo-request] Reverse change `" + ch.id + "` (" + label + "). " +
        "From batch `" + (batch.batch_id || batch.timestamp || "?") + "`. " +
        "Restore the source to its state before this change landed. " +
        "If later edits touched the same element(s), surface that and ask before unwinding them too.",
    }], { source: "history-undo-request" }).then((r) => {
      if (r.ok) showToast("Undo request queued — agent will reverse + reload", 5000);
      else showToast("Undo request failed (" + r.status + ")", 5000);
    }).catch((err) => {
      showToast("Undo request failed: " + err.message, 5000);
    });
  }

  // ---------------- Tour ----------------
  // Tour walks the FULL change history (all batches). The label shows N/M
  // absolute position. Start position is always the FIRST change of the
  // LATEST batch — so after a fresh batch the tour drops you straight onto
  // the newest content (e.g. 4/4 if the last batch added a single change).
  function startTour() {
    const all = flattenChanges();
    if (!all.length) return;
    let startIdx = 0;
    if (history.length > 0) {
      // Find the last batch that actually has changes
      for (let i = history.length - 1; i >= 0; i--) {
        const b = history[i];
        if (b.changes && b.changes.length > 0) {
          const firstOfLast = b.changes[0];
          const idx = all.findIndex(c => c.id === firstOfLast.id);
          if (idx >= 0) startIdx = idx;
          break;
        }
      }
    }
    tourState = { changes: all, index: startIdx };
    $("cf-tour-bar").classList.add("cf-visible");
    closePanel();
    tourStep(0);
  }
  function tourStep(delta) {
    if (!tourState) return;
    tourState.index = Math.max(0, Math.min(tourState.changes.length - 1, tourState.index + delta));
    const ch = tourState.changes[tourState.index];
    focusChange(ch);
    $("cf-tour-label").textContent = `${tourState.index + 1} / ${tourState.changes.length}`;
    $("cf-tour-prev").disabled = tourState.index === 0;
    $("cf-tour-next").disabled = tourState.index === tourState.changes.length - 1;
  }
  function exitTour() {
    tourState = null;
    $("cf-tour-bar").classList.remove("cf-visible");
    document.querySelectorAll(".cf-change-active").forEach((el) => el.classList.remove("cf-change-active"));
  }

  // ---------------- Panel ----------------
  function openPanel() { $("cf-panel").classList.add("cf-open"); updateClearAllFloat(); }
  function closePanel() { $("cf-panel").classList.remove("cf-open"); updateClearAllFloat(); }
  function openHelp()  { $("cf-help").classList.add("cf-visible"); }
  function closeHelp() { $("cf-help").classList.remove("cf-visible"); }
  function setGridShown(on) {
    gridShown = on;
    document.body.classList.toggle("cf-grid-on", on);
    const btn = $("cf-grid-show");
    if (btn) btn.classList.toggle("cf-active", on);
    try { localStorage.setItem("cf-grid-shown", on ? "1" : "0"); } catch (e) {}
  }
  function setGridSnap(on) {
    gridSnap = on;
    const btn = $("cf-grid-snap");
    if (btn) btn.classList.toggle("cf-active", on);
    try { localStorage.setItem("cf-grid-snap", on ? "1" : "0"); } catch (e) {}
  }
  // Wrap each .cf-num-spin number input with custom ▲ / ▼ buttons. The
  // native browser spinners are dark-mode-unfriendly; this gives us a gold-
  // accented variant that matches the rest of the toolbar.
  function decorateNumberSpinners() {
    document.querySelectorAll(".cf-num-spin").forEach((input) => {
      if (input.parentElement && input.parentElement.classList.contains("cf-num-group")) return;
      const group = document.createElement("span");
      group.className = "cf-num-group";
      input.parentElement.insertBefore(group, input);
      group.appendChild(input);
      ["up", "down"].forEach((dir) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "cf-num-step cf-num-" + dir;
        btn.textContent = dir === "up" ? "▲" : "▼";
        btn.tabIndex = -1;
        btn.addEventListener("mousedown", (e) => e.preventDefault());
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          if (dir === "up") input.stepUp(); else input.stepDown();
          input.dispatchEvent(new Event("input", { bubbles: true }));
        });
        group.appendChild(btn);
      });
    });
  }

  function loadGridState() {
    try {
      if (localStorage.getItem("cf-grid-shown") === "1") setGridShown(true);
      if (localStorage.getItem("cf-grid-snap")  === "1") setGridSnap(true);
    } catch (e) {}
  }
  function toggleHelp() {
    if ($("cf-help").classList.contains("cf-visible")) closeHelp();
    else openHelp();
  }
  function togglePanel() {
    const p = $("cf-panel");
    if (p.classList.contains("cf-open")) closePanel(); else openPanel();
  }
  function setActiveTab(name) {
    document.querySelectorAll(".cf-tab").forEach((t) => t.classList.toggle("cf-tab-active", t.dataset.tab === name));
    document.querySelectorAll(".cf-tab-pane").forEach((p) => p.classList.toggle("cf-tab-pane-active", p.id === "cf-tab-" + name));
  }

  // ---------------- Event wiring ----------------
  function bindEvents() {
    $("cf-toggle").addEventListener("click", (e) => {
      // Suppress click that follows a drag — only treat it as a toggle
      // when no movement happened past the drag threshold.
      if (pillJustDragged) {
        pillJustDragged = false;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      togglePanel();
    });
    // Free-drag with snap-to-corner on release
    $("cf-toggle").addEventListener("pointerdown", onPillPointerDown);
    document.addEventListener("pointermove", onPillPointerMove);
    document.addEventListener("pointerup", onPillPointerUp);
    $("cf-close").addEventListener("click", closePanel);
    $("cf-help-toggle").addEventListener("click", toggleHelp);
    $("cf-copy-html").addEventListener("click", copyPageHtml);
    $("cf-sqs-audit").addEventListener("click", runSquarespaceAudit);
    $("cf-sqs-close").addEventListener("click", closeSqsModal);
    $("cf-sqs-cancel").addEventListener("click", closeSqsModal);
    $("cf-sqs-apply").addEventListener("click", sqsApplySelected);
    $("cf-sqs-modal").addEventListener("click", (e) => {
      if (e.target.id === "cf-sqs-modal") closeSqsModal();
    });
    $("cf-help-close").addEventListener("click", closeHelp);
    $("cf-edit-help").addEventListener("mousedown", (e) => e.preventDefault());
    $("cf-edit-help").addEventListener("click", toggleHelp);
    $("cf-grid-show").addEventListener("click", () => setGridShown(!gridShown));
    $("cf-grid-snap").addEventListener("click", () => setGridSnap(!gridSnap));
    $("cf-marker-refine").addEventListener("click", markerMenuRefine);
    $("cf-marker-remove").addEventListener("click", markerMenuRemove);
    decorateNumberSpinners();
    // Click outside the help inner card closes the overlay
    $("cf-help").addEventListener("click", (e) => {
      if (e.target.id === "cf-help") closeHelp();
    });
    $("cf-add-general").addEventListener("click", openGeneralEditor);
    $("cf-submit").addEventListener("click", submitBatch);
    $("cf-clear-all").addEventListener("click", clearAllPending);
    $("cf-clear-all-float").addEventListener("click", clearAllPending);
    // Suppress the float button's mousedown from triggering the pill drag
    // — they share .cf-launcher so the document-level pill pointermove
    // would otherwise treat the click as the start of a drag.
    $("cf-clear-all-float").addEventListener("pointerdown", (e) => e.stopPropagation());
    $("cf-elem-toggle").addEventListener("click", toggleElementMode);
    // Snapshot mode — Alt + drag. Capture phase so we run before the page's
    // own pointer handlers and can intercept the drag.
    document.addEventListener("keydown", onSnapshotKeyDown);
    document.addEventListener("keyup", onSnapshotKeyUp);
    window.addEventListener("blur", onSnapshotBlur);
    document.addEventListener("pointerdown", onSnapshotPointerDown, true);
    document.addEventListener("pointermove", onSnapshotPointerMove, true);
    document.addEventListener("pointerup", onSnapshotPointerUp, true);

    // CRITICAL FIX: mousedown.preventDefault keeps the text selection alive
    // through the click. Without it, the browser clears the selection on
    // mousedown, which causes our saved range to look invalid.
    const popupBtn = $("cf-popup-comment");
    popupBtn.addEventListener("mousedown", (e) => e.preventDefault());
    popupBtn.addEventListener("click", openTextCommentEditor);

    $("cf-elem-popup-comment").addEventListener("click", openElementCommentEditor);
    $("cf-elem-popup-delete").addEventListener("click", deleteSelectedElements);
    $("cf-elem-popup-clear").addEventListener("click", () => {
      clearElementSelection();
      hideElemPopup();
    });

    $("cf-editor-cancel").addEventListener("click", closeEditor);
    $("cf-editor-save").addEventListener("click", saveEditorComment);
    $("cf-editor-text").addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) saveEditorComment();
      if (e.key === "Escape") closeEditor();
    });

    // Inline text-edit wiring (dblclick → contenteditable → ⌘↵ submits)
    $("cf-edit-cancel").addEventListener("click", cancelTextEdit);
    $("cf-edit-go").addEventListener("click", confirmOrAutoSubmit);
    // Comment-while-editing — captures any in-flight edit (auto-submits if
    // text or styles changed) before opening the element-comment editor
    // pointing at the same element. Lets the user leave a note in addition
    // to the visual edit they just made. Works for both text-edit and
    // image-edit modes (the button stays visible in both via the same row
    // 1 placement as cancel / confirm).
    $("cf-edit-comment").addEventListener("mousedown", (e) => e.preventDefault());
    $("cf-edit-comment").addEventListener("click", () => {
      if (!editingEl) return;
      const targetEl = editingEl;
      // Auto-commit any in-flight changes so the comment attaches to the
      // post-edit state rather than the pre-edit one
      commitOrExitCurrentEdit();
      // Route through the existing element-comment editor by setting
      // selectedElements first — same pipeline as the element-popup's
      // "💬 comment" button.
      selectedElements = [targetEl];
      openElementCommentEditor();
    });
    // Photo-URL swap — only meaningful for img elements. Prompts for a new
    // URL, sets `src`, and lets the existing text-edit pipeline pick up the
    // change as an outer-html diff on confirm. The button is CSS-hidden in
    // text-edit mode and shown only when body.cf-image-edit-mode is on.
    $("cf-edit-img-url").addEventListener("click", () => {
      if (!editingEl || editingEl.tagName !== "IMG") return;
      const next = window.prompt("Image URL:", editingEl.src);
      if (next === null) return;
      const trimmed = next.trim();
      if (!trimmed || trimmed === editingEl.src) return;
      editingEl.src = trimmed;
      requestAnimationFrame(positionEditToolbar);
    });
    // Format buttons: preventDefault on mousedown so the editable doesn't lose
    // focus / selection between click and execCommand. The 3 cycle buttons
    // (halign, valign, case) are in the same list since they share the same
    // selection-preservation need.
    ["cf-edit-bold", "cf-edit-italic", "cf-edit-underline", "cf-edit-ul", "cf-edit-ol", "cf-edit-link",
     "cf-edit-halign-cycle", "cf-edit-valign-cycle", "cf-edit-case-cycle"].forEach((id) => {
      $(id).addEventListener("mousedown", (e) => e.preventDefault());
    });
    $("cf-edit-bold").addEventListener("click", () => { if (editingEl) document.execCommand("bold"); });
    $("cf-edit-italic").addEventListener("click", () => { if (editingEl) document.execCommand("italic"); });
    $("cf-edit-underline").addEventListener("click", () => { if (editingEl) document.execCommand("underline"); });
    $("cf-edit-link").addEventListener("click", applyLink);
    // Toggle the selection (or the line containing the caret) in/out of a
    // <ul>/<ol>. execCommand handles the conversion both ways — single click
    // wraps non-list content into a list, click again to break out. Browsers
    // emit slightly different markup (Chrome wraps in <ul>, Firefox can leave
    // stray <span>s); the agent normalizes when persisting to source.
    $("cf-edit-ul").addEventListener("click", () => { if (editingEl) document.execCommand("insertUnorderedList"); });
    $("cf-edit-ol").addEventListener("click", () => { if (editingEl) document.execCommand("insertOrderedList"); });
    $("cf-edit-halign-cycle").addEventListener("click", cycleHAlign);
    $("cf-edit-valign-cycle").addEventListener("click", cycleVAlign);
    // Case cycle — glyph shows what the next click applies; click both applies
    // the displayed transform AND advances the cycle. Selection-or-whole-element
    // semantics come from applyCaseTransform.
    $("cf-edit-case-cycle").addEventListener("click", () => {
      const btn = $("cf-edit-case-cycle");
      const cur = btn.dataset.cfCase || "upper";
      applyCaseTransform(cur);
      const order = ["upper", "lower", "title"];
      btn.dataset.cfCase = order[(order.indexOf(cur) + 1) % order.length];
    });
    // Style control wiring (row 2 of the toolbar — inline font/color/bg)
    $("cf-edit-font-family").addEventListener("mousedown", (e) => e.stopPropagation());
    $("cf-edit-font-family").addEventListener("change", (e) => applyInlineStyle("font-family", e.target.value));
    $("cf-edit-font-size").addEventListener("mousedown", (e) => e.stopPropagation());
    $("cf-edit-font-size").addEventListener("input", (e) => {
      const v = parseFloat(e.target.value);
      applyInlineStyle("font-size", v > 0 ? v + "px" : "");
    });
    $("cf-edit-line-height").addEventListener("mousedown", (e) => e.stopPropagation());
    $("cf-edit-line-height").addEventListener("input", (e) => {
      const v = parseFloat(e.target.value);
      // Unitless line-height — inherited by children proportionally to their
      // own font-size, which is the standard typographic behavior.
      applyInlineStyle("line-height", v > 0 ? String(v) : "");
    });
    $("cf-edit-color").addEventListener("mousedown", (e) => e.stopPropagation());
    $("cf-edit-color").addEventListener("input", (e) => { applyInlineStyle("color", e.target.value); syncColorSwatchButtons(); });
    // Color-swatch buttons replace the inline native <input type="color">.
    // Clicking opens the popover (palette + native-picker escape hatch).
    $("cf-edit-color-btn").addEventListener("mousedown", (e) => e.preventDefault());
    $("cf-edit-color-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      if ($("cf-color-popover").classList.contains("cf-visible") && _popoverTarget === "color") {
        closeColorPopover();
      } else {
        openColorPopover("color", $("cf-edit-color-btn"));
      }
    });
    $("cf-edit-bg-btn").addEventListener("mousedown", (e) => e.preventDefault());
    $("cf-edit-bg-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      if ($("cf-color-popover").classList.contains("cf-visible") && _popoverTarget === "background-color") {
        closeColorPopover();
      } else {
        openColorPopover("background-color", $("cf-edit-bg-btn"));
      }
    });
    // "Custom color..." inside the popover triggers the hidden native <input>
    // for the current target, so users can still pick any color via the OS
    // picker when none of the 3 swatches fit.
    $("cf-color-popover-custom").addEventListener("mousedown", (e) => e.preventDefault());
    $("cf-color-popover-custom").addEventListener("click", () => {
      const id = _popoverTarget === "background-color" ? "cf-edit-bg" : "cf-edit-color";
      const input = $(id);
      closeColorPopover();
      input.click();
    });
    // Paintbrush — captures the current edit's styles, exits edit mode, and
    // arms a sticky paint mode where the next clicks paste those styles.
    $("cf-edit-paintbrush").addEventListener("mousedown", (e) => e.preventDefault());
    $("cf-edit-paintbrush").addEventListener("click", () => {
      if (document.body.classList.contains("cf-paintbrush-mode")) {
        deactivatePaintbrush();
        showToast("paintbrush off");
      } else {
        capturePaintbrush();
      }
    });
    $("cf-edit-bg").addEventListener("mousedown", (e) => e.stopPropagation());
    $("cf-edit-bg").addEventListener("input", (e) => { applyInlineStyle("background-color", e.target.value); syncColorSwatchButtons(); });
    $("cf-edit-style-reset").addEventListener("click", (e) => { e.stopPropagation(); resetInlineStyles(); });
    $("cf-edit-border-w").addEventListener("mousedown", (e) => e.stopPropagation());
    $("cf-edit-border-w").addEventListener("input", applyBorder);
    $("cf-edit-border-c").addEventListener("mousedown", (e) => e.stopPropagation());
    $("cf-edit-border-c").addEventListener("input", applyBorder);
    $("cf-edit-radius").addEventListener("mousedown", (e) => e.stopPropagation());
    $("cf-edit-radius").addEventListener("input", applyRadius);
    $("cf-edit-padding").addEventListener("mousedown", (e) => e.stopPropagation());
    $("cf-edit-padding").addEventListener("input", applyPadding);
    $("cf-edit-opacity").addEventListener("mousedown", (e) => e.stopPropagation());
    $("cf-edit-opacity").addEventListener("input", applyOpacity);
    document.addEventListener("click", (e) => {
      if (insideOurUI(e.target)) return;
      prevClickTime = lastClickTime;
      lastClickTime = e.timeStamp;
    }, true);
    document.addEventListener("dblclick", onDblClick);
    CF_RESIZE_HANDLES.forEach((id) => {
      const h = $(id);
      if (h) h.addEventListener("pointerdown", onResizeStart);
    });
    // Click-outside: closes the panel if open and commits/exits any in-flight
    // edit. Clicks inside our own UI (panel, toolbar, resize handles, etc.)
    // and inside the active editing element are exempt.
    document.addEventListener("mousedown", (e) => {
      // Marker menu: only do the close-check when it's actually open.
      // Mousedown fires on every page click; bailing here keeps the hot path lean.
      const menu = $("cf-marker-menu");
      if (menu && menu.classList.contains("cf-visible")
          && !menu.contains(e.target)
          && !e.target.classList.contains("cf-edit-marker")) {
        closeMarkerMenu();
      }
      if (insideOurUI(e.target)) return;
      // Close panel if open
      const panel = $("cf-panel");
      if (panel && panel.classList.contains("cf-open")) {
        closePanel();
      }
      // Commit-or-exit any active edit when click lands outside the target
      if (editingEl && !editingEl.contains(e.target)) {
        commitOrExitCurrentEdit();
      }
    }, true);
    // Keep the toolbar + resize handles glued to the element as the user scrolls or resizes
    window.addEventListener("scroll", () => {
      if (editingEl) { positionEditToolbar(); positionResizeHandle(); }
    }, true);
    window.addEventListener("resize", () => {
      if (editingEl) { positionEditToolbar(); positionResizeHandle(); }
      // Floating markers (on <img> etc.) are placed at document-coord positions
      // that go stale when the page reflows. Re-place after resize settles.
      clearTimeout(markerResizeTimer);
      markerResizeTimer = setTimeout(refreshPendingEditMarkers, 120);
    });
    // Snapshot rect is position:fixed but its corners are document-anchored.
    // Reposition on scroll so the rect tracks the content the user pointed at
    // rather than drifting with the viewport.
    window.addEventListener("scroll", () => {
      if (snapshotDragging) updateSnapshotRect();
    }, { passive: true });

    document.querySelectorAll(".cf-tab").forEach((t) => t.addEventListener("click", () => setActiveTab(t.dataset.tab)));
    $("cf-tour").addEventListener("click", startTour);
    $("cf-tour-prev").addEventListener("click", () => tourStep(-1));
    $("cf-tour-next").addEventListener("click", () => tourStep(1));
    $("cf-tour-exit").addEventListener("click", exitTour);
    $("cf-reload-now").addEventListener("click", doReload);

    // Agent-prompt card wiring
    $("cf-agent-prompt-close").addEventListener("click", () => {
      // Dismiss without answering — keep the prompt id in pending, surface it
      // again on the next poll cycle. The agent doesn't know it was dismissed.
      hidePromptCard();
    });
    $("cf-agent-prompt-send").addEventListener("click", () => {
      const text = $("cf-agent-prompt-input").value.trim();
      if (!text || !activePromptId) return;
      submitPromptResponse(activePromptId, text);
    });
    // ⌘↵ sends the reply; Esc dismisses (matches the text-editor convention)
    $("cf-agent-prompt-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        $("cf-agent-prompt-send").click();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        hidePromptCard();
      }
    });

    // Preserve scroll position across any reload while a "changes ready"
    // banner is up — browser-refresh / Cmd-R included, not just our R hotkey.
    window.addEventListener("beforeunload", () => {
      if (pendingReload) {
        sessionStorage.setItem("cf-scroll-y", String(window.scrollY));
      }
    });

    document.addEventListener("selectionchange", debounce(onSelectionChange, 120));

    // Element-mode interactions
    document.addEventListener("mouseover", onElemMouseOver);
    document.addEventListener("mouseout", onElemMouseOut);
    // Paintbrush intercepts clicks BEFORE element-mode so it can paste
    // styles without dropping into selection logic.
    document.addEventListener("click", (e) => {
      if (!document.body.classList.contains("cf-paintbrush-mode")) return;
      if (insideOurUI(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      const target = findCommentableAncestor(e.target) || e.target;
      paintbrushTryApply(target);
    }, true);
    document.addEventListener("click", onElemClick, true);  // capture phase
    // Suppress native interactions on form fields (focus, select dropdown,
    // link navigation) while element mode is on. Has to be mousedown — for
    // <select>, the dropdown opens on mousedown so a click-phase preventDefault
    // is too late.
    document.addEventListener("mousedown", (e) => {
      if (!elementMode) return;
      if (insideOurUI(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
    }, true);

    document.addEventListener("keydown", (e) => {
      // Esc is always-on (works inside text inputs too)
      if (e.key === "Escape") {
        if ($("cf-help").classList.contains("cf-visible")) { e.preventDefault(); closeHelp(); }
        else if (editingEl) { e.preventDefault(); cancelTextEdit(); }
        else if (document.body.classList.contains("cf-paintbrush-mode")) { e.preventDefault(); deactivatePaintbrush(); showToast("paintbrush off"); }
        else if ($("cf-editor").classList.contains("cf-visible")) closeEditor();
        else if (snapshotDragging) { e.preventDefault(); cancelSnapshotDrag(); }
        else if (elementMode) toggleElementMode();
        else if (tourState) exitTour();
        else closePanel();
        return;
      }
      // ⌘↵ inside the editable element submits the in-flight edit directly.
      if (editingEl && e.key === "Enter" && (e.metaKey || e.ctrlKey) && document.activeElement === editingEl) {
        e.preventDefault();
        confirmOrAutoSubmit();
        return;
      }
      // ⌘S anywhere submits the pending batch (intercept browser's Save Page)
      if ((e.key === "s" || e.key === "S") && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
        if (pending.length > 0) {
          e.preventDefault();
          submitBatch();
          return;
        }
      }
      // ⌘Z / Ctrl+Z anywhere — pop the most recent pending entry and revert
      // its visual change. Inside a contenteditable we let the browser's
      // native undo run so character-level typing edits stay snappy.
      if ((e.key === "z" || e.key === "Z") && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
        if (editingEl && document.activeElement === editingEl) return;
        if (isTypingTarget(e.target)) return;
        if (pending.length === 0) return;
        e.preventDefault();
        const last = pending[pending.length - 1];
        try { clearAllRevertOne(last); } catch (err) { console.warn("undo revert failed", err); }
        pending = pending.filter((c) => c.id !== last.id);
        saveLS();
        renderPending();
        const label = last.type === "text-edit" ? "text edit"
                    : last.type === "delete"    ? "delete"
                    : last.type === "selection" ? "selection comment"
                    : last.type === "elements"  ? "element comment"
                    : last.type === "general"   ? "general comment"
                    : last.type === "snapshot"  ? "snapshot"
                    : last.type;
        showToast("undid " + label + " — " + pending.length + " pending");
        return;
      }
      // Image-edit arrow keys. Plain arrow = pan the photo within its frame
      // (the box stays put; image content slides under the clipping window —
      // Photoshop-style: ArrowUp shifts the image up, exposing the bottom).
      // Shift+arrow = move the element itself via margin (the original "frame
      // moves" behavior). 1px steps; hold the key for auto-repeat. Active only
      // when an image is currently being edited.
      if (editingEl && document.body.classList.contains("cf-image-edit-mode") &&
          !e.metaKey && !e.ctrlKey && !e.altKey && !isTypingTarget(e.target)) {
        // Zoom: + (or = for unshifted access) zooms in, - zooms out. 0.1 step,
        // clamped to [0.5, 5]. Uses transform: scale on the image — the scaled
        // image visually overflows its layout slot; pan with arrow keys after
        // zooming to recenter the part you care about.
        if (e.key === "+" || e.key === "=" || e.key === "-") {
          e.preventDefault();
          const cur = editingEl.style.getPropertyValue("transform");
          const m = cur.match(/scale\(\s*([\d.]+)\s*\)/);
          let scale = m ? parseFloat(m[1]) : 1;
          if (e.key === "-") scale = Math.max(0.5, +(scale - 0.1).toFixed(2));
          else               scale = Math.min(5,   +(scale + 0.1).toFixed(2));
          if (scale === 1) editingEl.style.removeProperty("transform");
          else             editingEl.style.setProperty("transform", `scale(${scale})`, "important");
          editingEl.style.setProperty("transform-origin", "center", "important");
          positionResizeHandle();
          positionEditToolbar();
          return;
        }
        if (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault();
          if (e.shiftKey) {
            // Shift+arrow: nudge the element's layout position.
            const cur = (axis) => parseFloat(editingEl.style.getPropertyValue("margin-" + axis)) || 0;
            if (e.key === "ArrowLeft")  editingEl.style.setProperty("margin-left", (cur("left") - 1) + "px", "important");
            if (e.key === "ArrowRight") editingEl.style.setProperty("margin-left", (cur("left") + 1) + "px", "important");
            if (e.key === "ArrowUp")    editingEl.style.setProperty("margin-top",  (cur("top")  - 1) + "px", "important");
            if (e.key === "ArrowDown")  editingEl.style.setProperty("margin-top",  (cur("top")  + 1) + "px", "important");
          } else {
            // Plain arrow: pan via object-position. Requires object-fit:cover
            // so the image overflows the frame and the excess can be clipped —
            // auto-set on first nudge if the image didn't already have it.
            if (getComputedStyle(editingEl).objectFit !== "cover") {
              editingEl.style.setProperty("object-fit", "cover", "important");
            }
            // Cumulative pan stored as `calc(50% ± Xpx) calc(50% ± Ypx)`. The
            // 50% base keeps the image centered when X=Y=0 regardless of the
            // image's natural dimensions; pixel offsets accumulate predictably.
            const op = editingEl.style.getPropertyValue("object-position");
            let x = 0, y = 0;
            const m = op.match(/calc\(50%\s*([+-])\s*(\d+(?:\.\d+)?)px\)\s*calc\(50%\s*([+-])\s*(\d+(?:\.\d+)?)px\)/);
            if (m) {
              x = parseFloat(m[2]) * (m[1] === "-" ? -1 : 1);
              y = parseFloat(m[4]) * (m[3] === "-" ? -1 : 1);
            }
            if (e.key === "ArrowLeft")  x -= 1;
            if (e.key === "ArrowRight") x += 1;
            if (e.key === "ArrowUp")    y -= 1;
            if (e.key === "ArrowDown")  y += 1;
            editingEl.style.setProperty(
              "object-position",
              `calc(50% ${x >= 0 ? "+" : "-"} ${Math.abs(x)}px) calc(50% ${y >= 0 ? "+" : "-"} ${Math.abs(y)}px)`,
              "important"
            );
          }
          positionResizeHandle();
          positionEditToolbar();
          return;
        }
      }
      // Tour arrows: only while tour is active
      if (tourState && !isTypingTarget(e.target) && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (e.key === "ArrowLeft")  { e.preventDefault(); tourStep(-1); return; }
        if (e.key === "ArrowRight") { e.preventDefault(); tourStep(1);  return; }
      }
      // Shift+arrow snaps the pill to the chosen edge while keeping the
      // perpendicular axis. Skipped inside text inputs so it doesn't fight
      // with native shift-select.
      if (e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && !isTypingTarget(e.target)) {
        if (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "ArrowLeft" || e.key === "ArrowRight") {
          const next = pillCornerAfterArrow(pillCorner, e.key);
          if (next !== pillCorner) {
            e.preventDefault();
            setPillCorner(next);
            return;
          }
        }
      }
      // Single-letter shortcuts only when not typing and no modifiers held
      if (isTypingTarget(e.target)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      switch (e.key) {
        case "f": case "F":
          e.preventDefault(); togglePanel(); break;
        case "p": case "P":
          e.preventDefault(); openPanel(); setActiveTab("pending"); break;
        case "h": case "H":
          e.preventDefault(); openPanel(); setActiveTab("history"); break;
        case "e": case "E":
          e.preventDefault(); toggleElementMode(); break;
        case "?":
          e.preventDefault(); toggleHelp(); break;
        case "g": case "G":
          e.preventDefault(); openPanel(); openGeneralEditor(); break;
        case "c": case "C":
          // Smart comment trigger — opens the right editor for whatever's
          // currently selected. Text selection wins, then element selection,
          // then falls back to general (same as G) if nothing's selected.
          e.preventDefault();
          if (savedTextSelection) {
            openTextCommentEditor();
          } else if (selectedElements.length > 0) {
            openElementCommentEditor();
          } else {
            openPanel();
            openGeneralEditor();
          }
          break;
        case "t": case "T":
          e.preventDefault();
          if (!$("cf-tour").disabled) startTour();
          break;
        case "r": case "R":
          if (pendingReload) { e.preventDefault(); doReload(); }
          break;
      }
    });
  }

  function isTypingTarget(el) {
    if (!el) return false;
    const tag = (el.tagName || "").toLowerCase();
    return tag === "input" || tag === "textarea" || el.isContentEditable;
  }

  function debounce(fn, ms) {
    let t = null;
    return function (...args) { clearTimeout(t); t = setTimeout(() => fn.apply(this, args), ms); };
  }

  // ---------------- Public host-page API ----------------
  // Host pages (the brochure's gallery admin, future custom editors, etc.)
  // can queue their own comments into the feedback pending list instead of
  // POSTing to /feedback directly. The comment lands in the same UI the user
  // already trusts to review + submit feedback; nothing ships until they hit
  // submit. Accepts any object with a `type` (the agent's switch reads it);
  // `id` and `created_at` are auto-filled if missing.
  window.cfFeedback = window.cfFeedback || {};
  window.cfFeedback.queueComment = function (comment) {
    if (!comment || typeof comment !== "object" || !comment.type) {
      throw new Error("cfFeedback.queueComment: comment must be an object with a 'type'");
    }
    const entry = Object.assign({
      id: "c-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
      created_at: new Date().toISOString(),
      comment: "",
    }, comment);
    pending.push(entry);
    saveLS();
    renderPending();
    showToast(entry.type.replace(/-/g, " ") + " queued — submit when ready");
    return entry.id;
  };

  // ---------------- Bootstrap ----------------
  function init() {
    originalTitle = document.title;
    assignAnchors();
    buildUI();
    bindEvents();
    setPillCorner(loadPillCorner());
    loadGridState();
    const ls = loadLS();
    pending = ls.pending || [];
    lastSubmittedBatch = ls.lastSubmittedBatch || null;
    answeredPromptIds = new Set(ls.answeredPromptIds || []);
    syncTitle();
    renderPending();
    renderPalette();
    fetchHistory();
    fetchPrompts();
    pollTimer = setInterval(() => { fetchHistory(); fetchPrompts(); }, POLL_INTERVAL_MS);
    // Restore scroll position after a reload triggered by the "changes ready" flow
    const sy = sessionStorage.getItem("cf-scroll-y");
    if (sy) {
      sessionStorage.removeItem("cf-scroll-y");
      setTimeout(() => window.scrollTo(0, parseInt(sy, 10)), 0);
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
