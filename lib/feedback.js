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
  // Anything whose class contains 'hint', 'help', 'caption', 'subtitle',
  // 'description', or 'meta' is treated as commentable on its own.
  const COMMENTABLE_CLASSES = new Set(["card", "tldr", "fig", "controls"]);
  const COMMENTABLE_CLASS_SUBSTRINGS = ["hint", "help", "caption", "subtitle",
    "description", "meta", "annotation", "note"];

  // ---------------- State ----------------
  let pending = [];
  let history = [];
  let lastHistoryString = "";
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

  // If a text-edit's change region (the part that's actually different between
  // original and new) is at most this many chars, skip the confirm dialog and
  // submit directly. Keeps the dialog as a safety net for substantive rewrites
  // but gets out of the way for typo fixes and one-word swaps.
  const SKIP_CONFIRM_DIFF_THRESHOLD = 40;

  // Browser dblclick honors the OS double-click setting (often 500ms+), so a
  // leisurely second click — reading, repositioning the caret on a text page —
  // can still register as a dblclick and yank the editor open. Require the two
  // underlying clicks to land within this window for the editor to activate.
  const MAX_DBLCLICK_INTERVAL_MS = 350;
  let prevClickTime = 0;
  let lastClickTime = 0;

  // Tags eligible for double-click text editing. Excludes A — single-click
  // navigation fires before dblclick can register, so anchors aren't reachable
  // this way. Form controls and media elements also excluded.
  const TEXT_EDITABLE_TAGS = new Set([
    "P", "H1", "H2", "H3", "H4", "H5", "H6",
    "SPAN", "LI", "TD", "TH",
    "BLOCKQUOTE", "FIGCAPTION", "DT", "DD",
    "LABEL", "BUTTON", "SUMMARY",
  ]);
  // Block-level tags that should be preferred over an enclosed SPAN when
  // hunting for an edit target — when you dbl-click inside a paragraph that
  // contains a styled span, you almost always want to edit the paragraph.
  const PRIMARY_EDITABLE_BLOCK_TAGS = new Set([
    "P", "H1", "H2", "H3", "H4", "H5", "H6",
    "LI", "TD", "TH", "BLOCKQUOTE", "FIGCAPTION", "DT", "DD",
    "BUTTON", "SUMMARY",
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

  // ---------------- LocalStorage ----------------
  function loadLS() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || "{}"); } catch { return {}; }
  }
  function saveLS() {
    const cur = loadLS();
    cur.pending = pending;
    cur.lastSubmittedBatch = lastSubmittedBatch;
    localStorage.setItem(LS_KEY, JSON.stringify(cur));
  }

  // ---------------- Anchors ----------------
  function assignAnchors() {
    let n = 0;
    document.querySelectorAll("body *").forEach((el) => {
      if (insideOurUI(el)) return;
      if (el.dataset.cfId) return;
      if (!isCommentable(el)) return;
      el.dataset.cfId = "el-" + (++n);
    });
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
    return !!el.closest("#claude-feedback-root, .cf-editor, .cf-selection-popup, .cf-tour-bar, .cf-toast, .cf-edit-toolbar, .cf-edit-marker");
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

  // Simple word-level diff: find the longest common prefix and suffix of
  // tokenized inputs (words + whitespace). Returns one removed + one added
  // segment in the middle. Handles localized edits (one phrase swap, one
  // sentence rewritten) well; multi-region edits collapse into one big region,
  // which is fine for the UX (the user sees what changed, just bundled).
  function tokenizeForDiff(s) {
    return s.match(/\s+|\S+/g) || [];
  }
  function simpleWordDiff(a, b) {
    const ta = tokenizeForDiff(a || "");
    const tb = tokenizeForDiff(b || "");
    let pi = 0;
    while (pi < ta.length && pi < tb.length && ta[pi] === tb[pi]) pi++;
    let si = 0;
    while (si < ta.length - pi && si < tb.length - pi
           && ta[ta.length - 1 - si] === tb[tb.length - 1 - si]) si++;
    return {
      prefix: ta.slice(0, pi).join(""),
      removed: ta.slice(pi, ta.length - si).join(""),
      added: tb.slice(pi, tb.length - si).join(""),
      suffix: ta.slice(ta.length - si).join(""),
    };
  }
  function renderInlineDiff(a, b) {
    const d = simpleWordDiff(a, b);
    let out = "";
    if (d.prefix) out += '<span class="cf-diff-eq">' + escapeHtml(d.prefix) + '</span>';
    if (d.removed) out += '<span class="cf-diff-del">' + escapeHtml(d.removed) + '</span>';
    if (d.added) out += '<span class="cf-diff-add">' + escapeHtml(d.added) + '</span>';
    if (d.suffix) out += '<span class="cf-diff-eq">' + escapeHtml(d.suffix) + '</span>';
    return out;
  }

  // ---------------- UI: build DOM ----------------
  function buildUI() {
    const root = document.createElement("div");
    root.id = "claude-feedback-root";
    root.innerHTML = [
      '<div class="cf-launcher">',
      '  <button id="cf-toggle" class="cf-btn-primary" title="Feedback (press F)">',
      '    <span>feedback</span> <span class="cf-kbd-hint">F</span> <span id="cf-badge"></span>',
      '  </button>',
      '</div>',
      '<div id="cf-panel" class="cf-panel" aria-hidden="true">',
      '  <div class="cf-panel-header">',
      '    <strong>Feedback</strong>',
      '    <span class="cf-header-hint">F · P · H · E · C · G · T · ? · Esc</span>',
      '    <button id="cf-close" class="cf-icon-btn" aria-label="Close">×</button>',
      '  </div>',
      '  <div class="cf-tabs">',
      '    <button data-tab="pending" class="cf-tab cf-tab-active" title="Pending (P)">Pending <span class="cf-kbd-hint">P</span></button>',
      '    <button data-tab="history" class="cf-tab" title="History (H)">History <span class="cf-kbd-hint">H</span></button>',
      '  </div>',
      '  <div id="cf-tab-pending" class="cf-tab-pane cf-tab-pane-active">',
      '    <div id="cf-pending-list" class="cf-list"></div>',
      '    <div class="cf-panel-actions">',
      '      <button id="cf-elem-toggle" class="cf-btn" title="Select element (E)">🎯 select element <span class="cf-kbd-hint">E</span></button>',
      '      <button id="cf-add-general" class="cf-btn" title="General comment (G)">+ general <span class="cf-kbd-hint">G</span></button>',
      '    </div>',
      '    <div class="cf-panel-actions" style="margin-top:6px;">',
      '      <button id="cf-submit" class="cf-btn-primary" disabled title="Submit pending batch (⌘S)">submit batch <span class="cf-kbd-hint">⌘S</span></button>',
      '    </div>',
      '    <p class="cf-hint">Highlight any text to comment on it. Or click <em>select element</em>, then click any block on the page (image, table, paragraph, section). Shift-click to add more elements. <strong>Double-click text to edit it in place</strong> and submit the rewrite as a comment. Esc cancels.</p>',
      '  </div>',
      '  <div id="cf-tab-history" class="cf-tab-pane">',
      '    <div id="cf-history-list" class="cf-list"></div>',
      '    <div class="cf-panel-actions">',
      '      <button id="cf-tour" class="cf-btn" disabled title="Start tour (T)">start tour <span class="cf-kbd-hint">T</span></button>',
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
      '<div id="cf-toast" class="cf-toast"></div>',
      // inline text-edit toolbar (floats near an element while it is being edited)
      '<div id="cf-resize-handle" class="cf-resize-handle" title="Drag to resize" aria-label="Resize editing element"></div>',
      // Border popover — appears when the user clicks within ~8px of an editing
      // element's edge. Contains thickness, color, and radius controls.
      '<div id="cf-border-popover" class="cf-border-popover" role="dialog" aria-label="Border attributes">',
      '  <div class="cf-border-popover-row">',
      '    <label class="cf-style-lbl">width</label>',
      '    <input type="range" id="cf-edit-border-w" min="0" max="10" value="0" class="cf-style-range" title="Border thickness">',
      '    <span class="cf-border-w-val">0</span>',
      '  </div>',
      '  <div class="cf-border-popover-row">',
      '    <label class="cf-style-lbl">color</label>',
      '    <input type="color" id="cf-edit-border-c" class="cf-color-input" title="Border color">',
      '    <label class="cf-style-lbl" style="margin-left:8px;">radius</label>',
      '    <input type="range" id="cf-edit-radius" min="0" max="40" value="0" class="cf-style-range" title="Border radius">',
      '  </div>',
      '  <div class="cf-border-popover-row" style="justify-content:space-between;">',
      '    <button id="cf-border-clear" class="cf-btn cf-btn-small">clear border</button>',
      '    <button id="cf-border-close" class="cf-btn cf-btn-small">done</button>',
      '  </div>',
      '</div>',
      '<div id="cf-edit-toolbar" class="cf-edit-toolbar" role="toolbar" aria-label="Edit text">',
      '  <div class="cf-edit-toolbar-row">',
      '    <span class="cf-edit-toolbar-label">editing text</span>',
      '    <button id="cf-edit-bold" class="cf-btn cf-btn-small cf-edit-fmt" title="Bold (⌘B)" aria-label="Bold"><b>B</b></button>',
      '    <button id="cf-edit-italic" class="cf-btn cf-btn-small cf-edit-fmt" title="Italic (⌘I)" aria-label="Italic"><i>I</i></button>',
      '    <button id="cf-edit-ul" class="cf-btn cf-btn-small cf-edit-fmt" title="Bulleted list" aria-label="Bulleted list"><svg width="14" height="12" viewBox="0 0 15 12" aria-hidden="true"><circle cx="1.5" cy="2" r="1.2" fill="currentColor"/><circle cx="1.5" cy="6" r="1.2" fill="currentColor"/><circle cx="1.5" cy="10" r="1.2" fill="currentColor"/><line x1="5" y1="2" x2="14" y2="2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><line x1="5" y1="6" x2="14" y2="6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><line x1="5" y1="10" x2="14" y2="10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></button>',
      '    <button id="cf-edit-ol" class="cf-btn cf-btn-small cf-edit-fmt" title="Numbered list" aria-label="Numbered list"><svg width="14" height="12" viewBox="0 0 15 12" aria-hidden="true"><text x="0" y="3.6" font-size="3.5" font-family="sans-serif" font-weight="700" fill="currentColor">1</text><text x="0" y="7.6" font-size="3.5" font-family="sans-serif" font-weight="700" fill="currentColor">2</text><text x="0" y="11.6" font-size="3.5" font-family="sans-serif" font-weight="700" fill="currentColor">3</text><line x1="5" y1="2" x2="14" y2="2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><line x1="5" y1="6" x2="14" y2="6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><line x1="5" y1="10" x2="14" y2="10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></button>',
      '    <button id="cf-edit-align-left" class="cf-btn cf-btn-small cf-edit-fmt" title="Align left" aria-label="Align left"><svg width="14" height="12" viewBox="0 0 14 12" aria-hidden="true"><line x1="1" y1="2" x2="13" y2="2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><line x1="1" y1="6" x2="9" y2="6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><line x1="1" y1="10" x2="11" y2="10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></button>',
      '    <button id="cf-edit-align-center" class="cf-btn cf-btn-small cf-edit-fmt" title="Align center" aria-label="Align center"><svg width="14" height="12" viewBox="0 0 14 12" aria-hidden="true"><line x1="1" y1="2" x2="13" y2="2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><line x1="3" y1="6" x2="11" y2="6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><line x1="2" y1="10" x2="12" y2="10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></button>',
      '    <button id="cf-edit-align-right" class="cf-btn cf-btn-small cf-edit-fmt" title="Align right" aria-label="Align right"><svg width="14" height="12" viewBox="0 0 14 12" aria-hidden="true"><line x1="1" y1="2" x2="13" y2="2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><line x1="5" y1="6" x2="13" y2="6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><line x1="3" y1="10" x2="13" y2="10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></button>',
      '    <button id="cf-edit-case-upper" class="cf-btn cf-btn-small cf-edit-fmt cf-edit-case" title="UPPERCASE selection" aria-label="UPPERCASE selection">AA</button>',
      '    <button id="cf-edit-case-lower" class="cf-btn cf-btn-small cf-edit-fmt cf-edit-case" title="lowercase selection" aria-label="lowercase selection">aa</button>',
      '    <button id="cf-edit-case-title" class="cf-btn cf-btn-small cf-edit-fmt cf-edit-case" title="Title Case selection" aria-label="Title Case selection">Aa</button>',
      '    <span class="cf-edit-toolbar-sep" aria-hidden="true"></span>',
      '    <button id="cf-edit-cancel" class="cf-btn cf-btn-small">cancel</button>',
      '    <button id="cf-edit-go" class="cf-btn-primary cf-btn-small">confirm (⌘↵)</button>',
      '  </div>',
      '  <div class="cf-edit-toolbar-row cf-style-row">',
      '    <label class="cf-style-lbl">font</label>',
      '    <select id="cf-edit-font-family"></select>',
      '    <input type="number" id="cf-edit-font-size" min="8" max="120" step="0.5" class="cf-style-num" title="Font size (px)">',
      '    <label class="cf-style-lbl">color</label>',
      '    <input type="color" id="cf-edit-color" class="cf-color-input">',
      '    <label class="cf-style-lbl">bg</label>',
      '    <input type="color" id="cf-edit-bg" class="cf-color-input">',
      '    <button id="cf-edit-style-reset" class="cf-btn cf-btn-small" title="Reset font/color/bg overrides">reset</button>',
      '  </div>',
      '</div>',
      // confirm-edit dialog — shows the inline word diff + optional note + submit
      '<div id="cf-edit-confirm-dialog" class="cf-editor" role="dialog" aria-label="Confirm text edit">',
      '  <div class="cf-editor-quote cf-comment-general">Confirm text edit</div>',
      '  <div class="cf-edit-diff-inline" id="cf-edit-diff-inline" aria-label="Diff"></div>',
      '  <textarea id="cf-edit-note" placeholder="optional note (why this edit)…" rows="2"></textarea>',
      '  <div class="cf-editor-actions">',
      '    <button id="cf-edit-back" class="cf-btn cf-btn-small">back to edit</button>',
      '    <button id="cf-edit-submit" class="cf-btn-primary cf-btn-small">submit edit (⌘↵)</button>',
      '  </div>',
      '</div>',
      // "Changes ready, reload to see" banner — persistent, top-center
      '<div id="cf-reload-banner" class="cf-reload-banner" role="status" aria-live="polite">',
      '  <span class="cf-reload-bell" aria-hidden="true">🔔</span>',
      '  <span id="cf-reload-msg" class="cf-reload-msg">Changes ready, reload to see</span>',
      '  <button id="cf-reload-now" class="cf-btn-primary cf-btn-small" title="Reload (R)">reload <span class="cf-kbd-hint">R</span></button>',
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
    if (editingEl) { hideTextPopup(); return; }
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

  // ---------------- Element selection ----------------
  function toggleElementMode() {
    // Edit mode and element mode are mutually exclusive — cancel any in-flight edit first
    if (editingEl) cancelTextEdit();
    elementMode = !elementMode;
    document.body.classList.toggle("cf-elem-mode", elementMode);
    const btn = $("cf-elem-toggle");
    btn.classList.toggle("cf-active", elementMode);
    btn.innerHTML = elementMode
      ? '✓ element mode (on) <span class="cf-kbd-hint">E</span>'
      : '🎯 select element <span class="cf-kbd-hint">E</span>';
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
  }

  function onElemMouseOver(e) {
    if (!elementMode) return;
    if (insideOurUI(e.target)) return;
    const el = findCommentableAncestor(e.target);
    document.querySelectorAll(".cf-elem-hover").forEach(x => x.classList.remove("cf-elem-hover"));
    if (el && !selectedElements.includes(el)) el.classList.add("cf-elem-hover");
  }

  function onElemMouseOut(e) {
    if (!elementMode) return;
    if (insideOurUI(e.target)) return;
    document.querySelectorAll(".cf-elem-hover").forEach(x => x.classList.remove("cf-elem-hover"));
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
      selectedElements.forEach(x => { if (x !== el) x.classList.remove("cf-elem-selected"); });
      selectedElements = [];
    }
    const idx = selectedElements.indexOf(el);
    if (idx === -1) {
      selectedElements.push(el);
      el.classList.add("cf-elem-selected");
      el.classList.remove("cf-elem-hover");
    } else {
      selectedElements.splice(idx, 1);
      el.classList.remove("cf-elem-selected");
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
        if (c.comment) $("cf-edit-note").value = c.comment;
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
        `<div style="font-size:10px;text-transform:uppercase;letter-spacing:.14em;color:#b14000;font-weight:600;margin-bottom:3px;">text edit · ${escapeHtml(tag)}</div>` +
        `<div style="opacity:0.75;">"${escapeHtml(shown)}${(c.new_text || "").length > 100 ? "…" : ""}"</div>`;
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
    openPanel();
    setActiveTab("pending");
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
    // Fall back to the nearest SPAN / DIV-text-leaf only if no block ancestor
    // matches.
    let el = node && node.nodeType === 3 ? node.parentElement : node;
    let fallback = null;
    while (el && el !== document.body && el !== document.documentElement) {
      if (insideOurUI(el)) return null;
      if (PRIMARY_EDITABLE_BLOCK_TAGS.has(el.tagName)) {
        const text = (el.innerText || el.textContent || "").trim();
        if (text.length > 0) return el;
      }
      if (!fallback && isTextEditable(el)) fallback = el;
      el = el.parentElement;
    }
    return fallback;
  }

  function startTextEdit(el) {
    if (editingEl) return;
    if (elementMode) return;
    editingEl = el;
    editingOriginalHtml = el.innerHTML;
    editingOriginalText = el.innerText || el.textContent || "";
    editingOriginalOuterHtml = el.outerHTML;
    editingOriginalCssText = el.style.cssText;
    populateStyleControls(el);
    buildFontFamilyOptions();
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
    showResizeHandle();
  }

  function positionEditToolbar() {
    if (!editingEl) return;
    const tb = $("cf-edit-toolbar");
    const r = editingEl.getBoundingClientRect();
    // Two-row toolbar — measure live since width is content-dependent
    const tbH = tb.offsetHeight || 78;
    const tbW = tb.offsetWidth || 480;
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
  function showResizeHandle() {
    const h = $("cf-resize-handle");
    if (!h) return;
    h.classList.add("cf-visible");
    positionResizeHandle();
  }
  function hideResizeHandle() {
    const h = $("cf-resize-handle");
    if (h) h.classList.remove("cf-visible");
  }
  function positionResizeHandle() {
    if (!editingEl) return;
    const h = $("cf-resize-handle");
    if (!h) return;
    const r = editingEl.getBoundingClientRect();
    h.style.top = (r.bottom - 8) + "px";
    h.style.left = (r.right - 8) + "px";
  }
  function onResizeStart(e) {
    if (!editingEl) return;
    e.preventDefault();
    e.stopPropagation();
    const r = editingEl.getBoundingClientRect();
    resizeStart = { x: e.clientX, y: e.clientY, w: r.width, h: r.height };
    document.addEventListener("pointermove", onResizeMove);
    document.addEventListener("pointerup", onResizeEnd, { once: true });
  }
  function onResizeMove(e) {
    if (!editingEl || !resizeStart) return;
    const newW = Math.max(40, resizeStart.w + (e.clientX - resizeStart.x));
    const newH = Math.max(20, resizeStart.h + (e.clientY - resizeStart.y));
    editingEl.style.setProperty("width", Math.round(newW) + "px", "important");
    editingEl.style.setProperty("height", Math.round(newH) + "px", "important");
    positionResizeHandle();
    positionEditToolbar();
  }
  function onResizeEnd() {
    resizeStart = null;
    document.removeEventListener("pointermove", onResizeMove);
  }

  function exitEditMode(keepVisualEdit) {
    if (!editingEl) return;
    hideResizeHandle();
    closeBorderPopover();
    if (!keepVisualEdit) {
      editingEl.innerHTML = editingOriginalHtml;
      // Also restore the inline style attribute — font-size, color, bg, width,
      // height, border, etc. set via the toolbar / resize handle / border
      // popover all live on .style. Without this, cancel only reverts content
      // but leaves visual style overrides stuck on the element.
      if (editingOriginalCssText != null) {
        editingEl.style.cssText = editingOriginalCssText;
      }
    }
    editingEl.removeAttribute("contenteditable");
    editingEl.removeAttribute("spellcheck");
    editingEl.classList.remove("cf-editing-target");
    editingEl = null;
    editingOriginalHtml = null;
    editingOriginalText = null;
    editingOriginalOuterHtml = null;
    editingOriginalCssText = null;
    refiningPendingId = null;
    $("cf-edit-toolbar").classList.remove("cf-visible");
    $("cf-edit-confirm-dialog").classList.remove("cf-visible");
    $("cf-edit-note").value = "";
    // Re-render markers now that the element isn't in edit mode (so any
    // pending edit on it gets its badge back).
    refreshPendingEditMarkers();
  }

  function cancelTextEdit() {
    exitEditMode(false);
  }

  function openEditConfirm() {
    if (!editingEl) return;
    const newText = editingEl.innerText || editingEl.textContent || "";
    const outerChanged = cleanOuterHtml(editingEl) !== editingOriginalOuterHtml;
    const textChanged = newText.trim() !== editingOriginalText.trim();
    if (!textChanged && !outerChanged) {
      showToast("no changes to submit", 2200);
      return;
    }
    if (textChanged) {
      $("cf-edit-diff-inline").innerHTML = renderInlineDiff(editingOriginalText, newText);
    } else {
      $("cf-edit-diff-inline").innerHTML =
        '<em style="color:#888;">No text changes; only styling was modified.</em>';
    }
    positionEditConfirm();
    $("cf-edit-confirm-dialog").classList.add("cf-visible");
    setTimeout(() => $("cf-edit-note").focus(), 50);
  }

  // Always submit directly — the confirm dialog (with diff preview + optional
  // note) was removed at user request to streamline the edit flow. Edits land
  // in the pending list immediately; notes can still be added there via the
  // per-row "edit" affordance if needed.
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

  function positionEditConfirm() {
    if (!editingEl) return;
    const dialog = $("cf-edit-confirm-dialog");
    const r = editingEl.getBoundingClientRect();
    const width = 380;
    const estH = 280;
    let top = r.bottom + 12;
    if (top + estH > window.innerHeight - 12) top = Math.max(12, r.top - estH - 12);
    top = Math.max(12, Math.min(top, window.innerHeight - estH - 12));
    let left = r.left + Math.min(r.width / 2, 200) - width / 2;
    left = Math.max(12, Math.min(left, window.innerWidth - width - 12));
    dialog.style.top = top + "px";
    dialog.style.left = left + "px";
  }

  function closeEditConfirm() {
    $("cf-edit-confirm-dialog").classList.remove("cf-visible");
    if (editingEl) editingEl.focus();
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
    const note = $("cf-edit-note").value.trim();
    if (refiningPendingId) {
      // Refining an already-pending text-edit — update in place, keep the
      // original_* fields from the first time so the agent sees the full diff
      // against the file (not just the diff against the previous refinement).
      const idx = pending.findIndex((x) => x.id === refiningPendingId);
      if (idx !== -1) {
        pending[idx].new_text = newText;
        pending[idx].new_html = newHtml;
        pending[idx].new_outer_html = newOuterHtml;
        if (note) pending[idx].comment = note;
        pending[idx].created_at = new Date().toISOString();
      }
    } else {
      pending.push({
        type: "text-edit",
        comment: note,
        elements: [anchorInfo(editingEl)],
        original_text: editingOriginalText,
        new_text: newText,
        original_html: editingOriginalHtml,
        new_html: newHtml,
        original_outer_html: editingOriginalOuterHtml,
        new_outer_html: newOuterHtml,
        id: "c-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
        created_at: new Date().toISOString(),
      });
    }
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
    clone.classList.remove("cf-elem-selected");
    clone.classList.remove("cf-elem-hover");
    clone.classList.remove("cf-has-pending-edit");
    clone.classList.remove("cf-change-active");
    clone.classList.remove("cf-pulse");
    if (clone.classList.length === 0) clone.removeAttribute("class");
    clone.removeAttribute("contenteditable");
    clone.removeAttribute("spellcheck");
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
  // Inline styles must be set !important so they win against page stylesheets
  // that use !important themselves (Squarespace overrides, design systems,
  // anything with high specificity). Without it the live preview is silently
  // no-op'd on those properties and the edit toolbar looks broken.
  function applyInlineStyle(prop, value) {
    if (!editingEl) return;
    if (value == null || value === "") editingEl.style.removeProperty(prop);
    else editingEl.style.setProperty(prop, value, "important");
  }
  function resetInlineStyles() {
    if (!editingEl) return;
    ["font-family", "font-size", "color", "background-color"]
      .forEach((p) => editingEl.style.removeProperty(p));
    populateStyleControls(editingEl);
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
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
      showToast("select some text first", 1800);
      return;
    }
    const range = sel.getRangeAt(0);
    if (!editingEl.contains(range.commonAncestorContainer)) {
      showToast("selection must be inside the editing element", 2200);
      return;
    }
    const original = range.toString();
    const transformed = transformCase(original, mode);
    if (transformed === original) return;
    range.deleteContents();
    const node = document.createTextNode(transformed);
    range.insertNode(node);
    // Re-select the transformed text so the user can chain operations
    const newRange = document.createRange();
    newRange.selectNode(node);
    sel.removeAllRanges();
    sel.addRange(newRange);
  }
  // Border popover — wired by clicking near the editing element's edge.
  // Re-applies border + radius inline with !important so they survive page
  // !important rules (Squarespace etc.) just like the other style edits.
  const BORDER_EDGE_TOLERANCE_PX = 8;
  function applyBorder() {
    if (!editingEl) return;
    const w = parseFloat($("cf-edit-border-w").value) || 0;
    const c = $("cf-edit-border-c").value || "#000000";
    const valEl = document.querySelector(".cf-border-w-val");
    if (valEl) valEl.textContent = w;
    if (w === 0) editingEl.style.removeProperty("border");
    else editingEl.style.setProperty("border", w + "px solid " + c, "important");
    positionResizeHandle();
    positionEditToolbar();
  }
  function applyRadius() {
    if (!editingEl) return;
    const r = parseFloat($("cf-edit-radius").value) || 0;
    if (r === 0) editingEl.style.removeProperty("border-radius");
    else editingEl.style.setProperty("border-radius", r + "px", "important");
  }
  function isNearEdge(clientX, clientY, rect) {
    const t = BORDER_EDGE_TOLERANCE_PX;
    const nearLeft   = Math.abs(clientX - rect.left)   <= t && clientY >= rect.top - t && clientY <= rect.bottom + t;
    const nearRight  = Math.abs(clientX - rect.right)  <= t && clientY >= rect.top - t && clientY <= rect.bottom + t;
    const nearTop    = Math.abs(clientY - rect.top)    <= t && clientX >= rect.left - t && clientX <= rect.right + t;
    const nearBottom = Math.abs(clientY - rect.bottom) <= t && clientX >= rect.left - t && clientX <= rect.right + t;
    return nearLeft || nearRight || nearTop || nearBottom;
  }
  function openBorderPopover(clientX, clientY) {
    if (!editingEl) return;
    const pop = $("cf-border-popover");
    if (!pop) return;
    // Sync controls to current computed values
    const cs = getComputedStyle(editingEl);
    const bw = Math.round(parseFloat(cs.borderTopWidth) || 0);
    $("cf-edit-border-w").value = Math.min(10, Math.max(0, bw));
    const valEl = document.querySelector(".cf-border-w-val");
    if (valEl) valEl.textContent = $("cf-edit-border-w").value;
    $("cf-edit-border-c").value = rgbToHex(cs.borderTopColor);
    const br = Math.round(parseFloat(cs.borderTopLeftRadius) || 0);
    $("cf-edit-radius").value = Math.min(40, Math.max(0, br));
    pop.classList.add("cf-visible");
    // Position popover below the click, clamped to viewport
    const popW = pop.offsetWidth || 280;
    const popH = pop.offsetHeight || 130;
    let left = Math.max(12, Math.min(clientX - popW / 2, window.innerWidth - popW - 12));
    let top = clientY + 14;
    if (top + popH > window.innerHeight - 12) top = Math.max(12, clientY - popH - 14);
    pop.style.left = left + "px";
    pop.style.top = top + "px";
  }
  function closeBorderPopover() {
    const pop = $("cf-border-popover");
    if (pop) pop.classList.remove("cf-visible");
  }
  function clearBorder() {
    if (!editingEl) return;
    editingEl.style.removeProperty("border");
    editingEl.style.removeProperty("border-radius");
    $("cf-edit-border-w").value = 0;
    $("cf-edit-radius").value = 0;
    const valEl = document.querySelector(".cf-border-w-val");
    if (valEl) valEl.textContent = "0";
  }
  function populateStyleControls(el) {
    const cs = getComputedStyle(el);
    $("cf-edit-color").value = rgbToHex(cs.color);
    // Background may be transparent; the picker can't represent that, default to a sensible color
    const bg = cs.backgroundColor;
    $("cf-edit-bg").value = (bg && !/rgba?\([^)]*,\s*0\s*\)$/.test(bg)) ? rgbToHex(bg) : "#ffffff";
    $("cf-edit-font-family").value = "";
    const fs = parseFloat(cs.fontSize) || 16;
    $("cf-edit-font-size").value = Math.round(fs * 10) / 10;
  }
  // Build the font dropdown from web-loaded fonts on the page (Marcellus,
  // Montserrat, etc.) plus generic families. Keeps the list relevant to
  // whatever the actual page uses without hardcoding.
  function buildFontFamilyOptions() {
    const select = $("cf-edit-font-family");
    if (!select) return;
    const detected = new Set();
    if (document.fonts && document.fonts.forEach) {
      document.fonts.forEach((f) => {
        const fam = (f.family || "").replace(/^['"]|['"]$/g, "").trim();
        if (fam) detected.add(fam);
      });
    }
    const opts = [['', '(inherit)']];
    detected.forEach((fam) => opts.push(['"' + fam + '", sans-serif', fam]));
    opts.push(['Georgia, "Times New Roman", serif', 'serif']);
    opts.push(['system-ui, -apple-system, "Segoe UI", sans-serif', 'sans']);
    opts.push(['ui-monospace, "SF Mono", Menlo, monospace', 'mono']);
    select.innerHTML = "";
    opts.forEach(([value, label]) => {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = label;
      select.appendChild(opt);
    });
  }

  function onDblClick(e) {
    if (insideOurUI(e.target)) return;
    if (elementMode) return;
    if (editingEl) return;
    // Reject pairs the OS counted as a dblclick but landed too far apart in time
    if (lastClickTime - prevClickTime > MAX_DBLCLICK_INTERVAL_MS) return;
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
  function parseStyleAttr(outerHtml) {
    if (!outerHtml) return {};
    const m = outerHtml.match(/<[^>]*\sstyle\s*=\s*"([^"]*)"/i) ||
              outerHtml.match(/<[^>]*\sstyle\s*=\s*'([^']*)'/i);
    if (!m) return {};
    const props = {};
    m[1].split(";").forEach((decl) => {
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
      } else if (c.type === "text-edit") {
        const tag = (c.elements && c.elements[0] && c.elements[0].tag) || "text";
        const before = (c.original_text || "").trim();
        const after = (c.new_text || "").trim();
        const textChanged = before !== after;
        const styleDiff = diffStyleAttr(c.original_outer_html || "", c.new_outer_html || "");
        const markupDiff = diffMarkup(c.original_html || "", c.new_html || "");
        const styleOnly = !textChanged && (styleDiff.length > 0 || markupDiff);
        const label = styleOnly ? "style edit" : "text edit";
        const parts = [`<div style="font-size:10px;text-transform:uppercase;letter-spacing:.14em;color:#b14000;font-weight:600;margin-bottom:3px;">${label} · ${escapeHtml(tag)}</div>`];
        if (textChanged) {
          const beforeShort = before.length > 80 ? before.slice(0, 80) + "…" : before;
          const afterShort = after.length > 80 ? after.slice(0, 80) + "…" : after;
          parts.push(`<div style="background:#f7e9e3;color:#6a2a1a;padding:3px 6px;border-radius:3px;margin-bottom:3px;font-style:normal;"><s>${escapeHtml(beforeShort)}</s></div>`);
          parts.push(`<div style="background:#e4f2e1;color:#1f5022;padding:3px 6px;border-radius:3px;font-style:normal;">${escapeHtml(afterShort)}</div>`);
        } else if (styleOnly) {
          // No text change — show the current text once as context so the row isn't empty
          const ctxShort = after.length > 60 ? after.slice(0, 60) + "…" : after;
          if (ctxShort) parts.push(`<div style="color:#555;font-size:11px;font-style:italic;margin-bottom:4px;">"${escapeHtml(ctxShort)}"</div>`);
        }
        if (styleDiff.length) {
          const rows = styleDiff.map(d =>
            `<div style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:#333;line-height:1.45;">` +
            `<span style="color:#666;">${escapeHtml(d.prop)}:</span> ` +
            `<s style="color:#9a4a30;">${escapeHtml(d.before || "—")}</s> ` +
            `<span style="color:#666;">→</span> ` +
            `<span style="color:#1f5022;font-weight:600;">${escapeHtml(d.after || "—")}</span>` +
            `</div>`
          ).join("");
          parts.push(`<div style="margin-top:4px;background:#f3f0eb;padding:5px 7px;border-radius:3px;">${rows}</div>`);
        }
        if (markupDiff) {
          parts.push(`<div style="margin-top:4px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:#555;">${escapeHtml(markupDiff)}</div>`);
        }
        quote.innerHTML = parts.join("");
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
    updateBadge();
    refreshPendingEditMarkers();
  }

  // Resolve a pending comment's target element so the row can scroll-to-it
  // and so we can drop a "pending edit" dot on text-edit targets.
  function getCommentTarget(c) {
    if (c.type === "general") return null;
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
    // Clear existing markers + classes
    document.querySelectorAll(".cf-edit-marker").forEach((m) => m.remove());
    document.querySelectorAll(".cf-has-pending-edit")
      .forEach((el) => el.classList.remove("cf-has-pending-edit"));
    document.querySelectorAll(".cf-pending-edit-hover")
      .forEach((el) => el.classList.remove("cf-pending-edit-hover"));
    pending.forEach((c) => {
      if (c.type !== "text-edit") return;
      const t = findElementByAnchorInfo(c.elements && c.elements[0]);
      if (!t || t === editingEl) return; // skip if currently being edited
      t.classList.add("cf-has-pending-edit");
      const marker = document.createElement("span");
      marker.className = "cf-edit-marker";
      marker.textContent = "✎";
      const preview = (c.new_text || "").slice(0, 80);
      marker.title = "pending text edit\n" +
                     (preview ? '"' + preview + (c.new_text.length > 80 ? "…" : "") + '"\n' : "") +
                     "click to refine · hover to highlight";
      marker.setAttribute("aria-label", "Pending text edit");
      marker.addEventListener("mouseenter", () => t.classList.add("cf-pending-edit-hover"));
      marker.addEventListener("mouseleave", () => t.classList.remove("cf-pending-edit-hover"));
      marker.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        editPendingComment(c);
      });
      // Don't trigger our document dblclick edit-mode if the user double-clicks the marker
      marker.addEventListener("dblclick", (e) => { e.stopPropagation(); e.preventDefault(); });
      t.appendChild(marker);
    });
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
  }

  // ---------------- Submit batch ----------------
  async function submitBatch() {
    if (!pending.length) return;
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
    sessionStorage.setItem("cf-auto-tour", "1");
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


  // ---------------- History / polling ----------------
  async function fetchHistory() {
    try {
      const resp = await fetch(HISTORY_URL + "?t=" + Date.now());
      if (!resp.ok) return;
      const text = await resp.text();
      if (text === lastHistoryString) return;
      lastHistoryString = text;
      // history.json changed → an agent is alive and writing. Push the stale
      // warning back so users don't see "no agent picked this up" while the
      // agent is actively working (just slower than the raw timeout).
      if (lastSubmittedBatch && !isBatchStale) {
        if (staleTimer) clearTimeout(staleTimer);
        staleTimer = setTimeout(() => {
          if (lastSubmittedBatch && !lastBatchProcessed()) {
            isBatchStale = true;
            renderPending();
          }
        }, STALE_AFTER_MS);
      }
      const parsed = JSON.parse(text);
      history = Array.isArray(parsed) ? parsed : [];
      onHistoryUpdated();
    } catch (e) { /* network glitch */ }
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
    return document.querySelector(`[data-cf-change~="${CSS.escape(anchor)}"]`);
  }

  function renderHistory() {
    const list = $("cf-history-list");
    list.innerHTML = "";
    // Newest batch first
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
  function openPanel() { $("cf-panel").classList.add("cf-open"); }
  function closePanel() { $("cf-panel").classList.remove("cf-open"); }
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
    $("cf-toggle").addEventListener("click", togglePanel);
    $("cf-close").addEventListener("click", closePanel);
    $("cf-add-general").addEventListener("click", openGeneralEditor);
    $("cf-submit").addEventListener("click", submitBatch);
    $("cf-elem-toggle").addEventListener("click", toggleElementMode);

    // CRITICAL FIX: mousedown.preventDefault keeps the text selection alive
    // through the click. Without it, the browser clears the selection on
    // mousedown, which causes our saved range to look invalid.
    const popupBtn = $("cf-popup-comment");
    popupBtn.addEventListener("mousedown", (e) => e.preventDefault());
    popupBtn.addEventListener("click", openTextCommentEditor);

    $("cf-elem-popup-comment").addEventListener("click", openElementCommentEditor);
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

    // Inline text-edit wiring (dblclick → contenteditable → confirm dialog)
    $("cf-edit-cancel").addEventListener("click", cancelTextEdit);
    $("cf-edit-go").addEventListener("click", confirmOrAutoSubmit);
    $("cf-edit-back").addEventListener("click", closeEditConfirm);
    $("cf-edit-submit").addEventListener("click", submitTextEdit);
    // Format buttons: preventDefault on mousedown so the editable doesn't lose
    // focus / selection between click and execCommand
    ["cf-edit-bold", "cf-edit-italic", "cf-edit-ul", "cf-edit-ol",
     "cf-edit-align-left", "cf-edit-align-center", "cf-edit-align-right"].forEach((id) => {
      $(id).addEventListener("mousedown", (e) => e.preventDefault());
    });
    $("cf-edit-bold").addEventListener("click", () => { if (editingEl) document.execCommand("bold"); });
    $("cf-edit-italic").addEventListener("click", () => { if (editingEl) document.execCommand("italic"); });
    // Toggle the selection (or the line containing the caret) in/out of a
    // <ul>/<ol>. execCommand handles the conversion both ways — single click
    // wraps non-list content into a list, click again to break out. Browsers
    // emit slightly different markup (Chrome wraps in <ul>, Firefox can leave
    // stray <span>s); the agent normalizes when persisting to source.
    $("cf-edit-ul").addEventListener("click", () => { if (editingEl) document.execCommand("insertUnorderedList"); });
    $("cf-edit-ol").addEventListener("click", () => { if (editingEl) document.execCommand("insertOrderedList"); });
    // Text alignment — sets text-align on the containing block. Toggling the
    // current alignment removes it. Browsers may wrap in a <div style="text-align:…">
    // or set the attribute directly on the parent; either way the diff capture
    // sees it in new_outer_html / new_html.
    $("cf-edit-align-left").addEventListener("click", () => { if (editingEl) document.execCommand("justifyLeft"); });
    $("cf-edit-align-center").addEventListener("click", () => { if (editingEl) document.execCommand("justifyCenter"); });
    $("cf-edit-align-right").addEventListener("click", () => { if (editingEl) document.execCommand("justifyRight"); });
    // Case transforms — operate on the current selection only (preserves inline
    // markup outside the selection). No-op + toast when nothing's selected.
    ["cf-edit-case-upper", "cf-edit-case-lower", "cf-edit-case-title"].forEach((id) => {
      $(id).addEventListener("mousedown", (e) => e.preventDefault());
    });
    $("cf-edit-case-upper").addEventListener("click", () => applyCaseTransform("upper"));
    $("cf-edit-case-lower").addEventListener("click", () => applyCaseTransform("lower"));
    $("cf-edit-case-title").addEventListener("click", () => applyCaseTransform("title"));
    // Style control wiring (row 2 of the toolbar — inline font/color/bg)
    $("cf-edit-font-family").addEventListener("mousedown", (e) => e.stopPropagation());
    $("cf-edit-font-family").addEventListener("change", (e) => applyInlineStyle("font-family", e.target.value));
    $("cf-edit-font-size").addEventListener("mousedown", (e) => e.stopPropagation());
    $("cf-edit-font-size").addEventListener("input", (e) => {
      const v = parseFloat(e.target.value);
      applyInlineStyle("font-size", v > 0 ? v + "px" : "");
    });
    $("cf-edit-color").addEventListener("mousedown", (e) => e.stopPropagation());
    $("cf-edit-color").addEventListener("input", (e) => applyInlineStyle("color", e.target.value));
    $("cf-edit-bg").addEventListener("mousedown", (e) => e.stopPropagation());
    $("cf-edit-bg").addEventListener("input", (e) => applyInlineStyle("background-color", e.target.value));
    $("cf-edit-style-reset").addEventListener("click", (e) => { e.stopPropagation(); resetInlineStyles(); });
    // Border popover wiring — capture-phase mousedown on the document so we can
    // intercept edge clicks on the editing element BEFORE contenteditable moves
    // the caret. Anywhere else just closes any open popover.
    document.addEventListener("mousedown", (e) => {
      const pop = $("cf-border-popover");
      if (pop && pop.contains(e.target)) return; // interacting with the popover
      if (!editingEl) return;
      const r = editingEl.getBoundingClientRect();
      if (isNearEdge(e.clientX, e.clientY, r)) {
        e.preventDefault();
        e.stopPropagation();
        openBorderPopover(e.clientX, e.clientY);
      } else if (pop && pop.classList.contains("cf-visible")) {
        if (!editingEl.contains(e.target)) closeBorderPopover();
      }
    }, true);
    $("cf-edit-border-w").addEventListener("input", applyBorder);
    $("cf-edit-border-c").addEventListener("input", applyBorder);
    $("cf-edit-radius").addEventListener("input", applyRadius);
    $("cf-border-clear").addEventListener("click", (e) => { e.stopPropagation(); clearBorder(); });
    $("cf-border-close").addEventListener("click", (e) => { e.stopPropagation(); closeBorderPopover(); });
    $("cf-edit-note").addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault(); e.stopPropagation(); submitTextEdit();
      }
      if (e.key === "Escape") {
        e.preventDefault(); e.stopPropagation(); closeEditConfirm();
      }
    });
    document.addEventListener("click", (e) => {
      if (insideOurUI(e.target)) return;
      prevClickTime = lastClickTime;
      lastClickTime = e.timeStamp;
    }, true);
    document.addEventListener("dblclick", onDblClick);
    $("cf-resize-handle").addEventListener("pointerdown", onResizeStart);
    // Keep the toolbar / confirm dialog / resize handle glued to the element as the user scrolls or resizes
    window.addEventListener("scroll", () => {
      if (editingEl) { positionEditToolbar(); positionResizeHandle(); }
      if ($("cf-edit-confirm-dialog").classList.contains("cf-visible")) positionEditConfirm();
    }, true);
    window.addEventListener("resize", () => {
      if (editingEl) { positionEditToolbar(); positionResizeHandle(); }
      if ($("cf-edit-confirm-dialog").classList.contains("cf-visible")) positionEditConfirm();
    });

    document.querySelectorAll(".cf-tab").forEach((t) => t.addEventListener("click", () => setActiveTab(t.dataset.tab)));
    $("cf-tour").addEventListener("click", startTour);
    $("cf-tour-prev").addEventListener("click", () => tourStep(-1));
    $("cf-tour-next").addEventListener("click", () => tourStep(1));
    $("cf-tour-exit").addEventListener("click", exitTour);
    $("cf-reload-now").addEventListener("click", doReload);

    // If the page is reloaded any other way (browser refresh, Cmd-R), still
    // carry the auto-tour flag forward so the user's mental model holds:
    // "changes ready" → reload → tour opens.
    window.addEventListener("beforeunload", () => {
      if (pendingReload) {
        sessionStorage.setItem("cf-auto-tour", "1");
        sessionStorage.setItem("cf-scroll-y", String(window.scrollY));
      }
    });

    document.addEventListener("selectionchange", debounce(onSelectionChange, 120));

    // Element-mode interactions
    document.addEventListener("mouseover", onElemMouseOver);
    document.addEventListener("mouseout", onElemMouseOut);
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
        if ($("cf-edit-confirm-dialog").classList.contains("cf-visible")) { e.preventDefault(); closeEditConfirm(); }
        else if (editingEl) { e.preventDefault(); cancelTextEdit(); }
        else if ($("cf-editor").classList.contains("cf-visible")) closeEditor();
        else if (elementMode) toggleElementMode();
        else if (tourState) exitTour();
        else closePanel();
        return;
      }
      // ⌘↵ inside the editable element: small diffs submit directly,
      // substantive ones open the confirm dialog
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
      // Tour arrows: only while tour is active
      if (tourState && !isTypingTarget(e.target) && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (e.key === "ArrowLeft")  { e.preventDefault(); tourStep(-1); return; }
        if (e.key === "ArrowRight") { e.preventDefault(); tourStep(1);  return; }
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
        case "?":
          e.preventDefault();
          showToast("F: feedback · P: pending · H: history · E: select element · C: comment selection · G: general comment · T: tour · R: reload when changes ready · double-click text: edit in place · ←/→: tour nav · Esc: close", 6500);
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

  // ---------------- Bootstrap ----------------
  function init() {
    originalTitle = document.title;
    assignAnchors();
    buildUI();
    bindEvents();
    const ls = loadLS();
    pending = ls.pending || [];
    lastSubmittedBatch = ls.lastSubmittedBatch || null;
    syncTitle();
    renderPending();
    // Clear any stale auto-tour flag from prior sessions; we no longer
    // auto-start the tour on reload — too easy to mistake the highlight
    // outline for the element-selection state. Tour is still reachable
    // from the panel button or the T keyboard shortcut.
    sessionStorage.removeItem("cf-auto-tour");
    fetchHistory();
    pollTimer = setInterval(fetchHistory, POLL_INTERVAL_MS);
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
