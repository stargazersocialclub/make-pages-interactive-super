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

  // Move-mode state — separate from element-mode; mutually exclusive
  let moveMode = false;
  const MOVE_DRAG_THRESHOLD_PX = 4;
  let movePointerDownEl = null;
  let movePointerDownXY = null;
  let moveDragging = false;
  let moveDragEl = null;
  let moveDragParent = null;
  let moveDragOriginIndex = null;
  let moveDropIndex = null;
  let moveGhostEl = null;
  let moveDropIndicatorEl = null;

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
  const HTML2CANVAS_LOCAL_URL = "/lib/html2canvas.min.js";
  const SNAPSHOT_UPLOAD_PREFIX = "/snapshot/";
  const MIN_SNAPSHOT_PX = 12;
  let snapshotAltHeld = false;
  let snapshotDragging = false;
  let snapshotStartXY = null;
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
      '    <span class="cf-header-hint">F · P · H · E · M · C · G · T · Esc</span>',
      '    <button id="cf-help-toggle" class="cf-icon-btn cf-help-btn" title="Quick guide (?)" aria-label="Quick guide">?</button>',
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
      '      <button id="cf-move-toggle" class="cf-btn" title="Move element (M)">↕ move element <span class="cf-kbd-hint">M</span></button>',
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
      '    <p class="cf-hint"><strong>Highlight text</strong> to comment on a selection. <strong>Double-click text</strong> to edit it in place — toolbar has bold/italic, lists, alignment, case, font, color. <strong>Double-click an image</strong> to drag its corners and resize. Press <kbd>E</kbd> to select elements, <kbd>M</kbd> to drag-reorder, <kbd>G</kbd> for a general note. Hold <kbd>Alt</kbd> + drag a rectangle to <strong>snapshot a region</strong>. Press <kbd>?</kbd> for the full guide. <kbd>Esc</kbd> cancels.</p>',
      '  </div>',
      '  <div id="cf-tab-history" class="cf-tab-pane">',
      '    <div id="cf-history-list" class="cf-list"></div>',
      '    <div class="cf-panel-actions">',
      '      <button id="cf-tour" class="cf-btn" disabled title="Start tour (T)">start tour <span class="cf-kbd-hint">T</span></button>',
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
      '          <li>Press <kbd>E</kbd>, then click any block (image, table, paragraph) to comment on it.</li>',
      '          <li>Press <kbd>M</kbd>, then <strong>drag any element</strong> to reorder it among its siblings.</li>',
      '          <li>Hold <kbd>Alt</kbd> and <strong>drag a rectangle</strong> to snapshot a region of the page.</li>',
      '          <li>Press <kbd>G</kbd> for a general page-level comment.</li>',
      '        </ul>',
      '      </section>',
      '      <section>',
      '        <h4>While editing text</h4>',
      '        <ul>',
      '          <li>Toolbar: <strong>B</strong> / <strong>I</strong> / bullet / numbered / align / case + font / size / color / bg.</li>',
      '          <li>Drag any of the four gold corner handles to <strong>resize</strong>. Edges snap to nearby elements within ~8 px.</li>',
      '          <li>Double-click a <strong>different</strong> element to commit and switch targets in one motion.</li>',
      '          <li><kbd>Esc</kbd> cancels and restores the element to its original state.</li>',
      '        </ul>',
      '      </section>',
      '      <section>',
      '        <h4>Keyboard</h4>',
      '        <table class="cf-help-keys">',
      '          <tr><td><kbd>F</kbd></td><td>toggle panel</td><td><kbd>⌘B</kbd> / <kbd>⌘I</kbd></td><td>bold / italic (in editor)</td></tr>',
      '          <tr><td><kbd>P</kbd></td><td>pending tab</td><td><kbd>⌘↵</kbd></td><td>confirm edit</td></tr>',
      '          <tr><td><kbd>H</kbd></td><td>history tab</td><td><kbd>⌘S</kbd></td><td>submit batch</td></tr>',
      '          <tr><td><kbd>E</kbd></td><td>element mode</td><td><kbd>Esc</kbd></td><td>cancel / close</td></tr>',
      '          <tr><td><kbd>M</kbd></td><td>move mode</td><td><kbd>R</kbd></td><td>reload (when banner shows)</td></tr>',
      '          <tr><td><kbd>G</kbd></td><td>general comment</td><td><kbd>T</kbd></td><td>walkthrough</td></tr>',
      '          <tr><td><kbd>C</kbd></td><td>smart comment</td><td><kbd>?</kbd></td><td>show this guide</td></tr>',
      '          <tr><td><kbd>Alt</kbd>+drag</td><td>snapshot region</td><td><kbd>⇧</kbd>+arrow</td><td>move launcher pill</td></tr>',
      '        </table>',
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
      '    <input type="number" id="cf-edit-font-size" min="8" max="120" step="0.5" class="cf-style-num cf-num-spin" title="Font size (px)">',
      '    <label class="cf-style-lbl">color</label>',
      '    <input type="color" id="cf-edit-color" class="cf-color-input">',
      '    <label class="cf-style-lbl">bg</label>',
      '    <input type="color" id="cf-edit-bg" class="cf-color-input">',
      '    <button id="cf-edit-style-reset" class="cf-btn cf-btn-small" title="Reset font/color/bg/border overrides">reset</button>',
      '  </div>',
      '  <div class="cf-edit-toolbar-row cf-style-row">',
      '    <label class="cf-style-lbl">border</label>',
      '    <input type="number" id="cf-edit-border-w" min="0" max="20" step="0.5" value="0" class="cf-style-num cf-num-spin" title="Border weight (px)">',
      '    <input type="color" id="cf-edit-border-c" class="cf-color-input" title="Border color">',
      '    <label class="cf-style-lbl">radius</label>',
      '    <input type="number" id="cf-edit-radius" min="0" max="80" step="1" value="0" class="cf-style-num cf-num-spin" title="Border radius (px)">',
      '    <button id="cf-edit-help" class="cf-btn cf-btn-small cf-edit-help-btn" title="Quick guide (?)" aria-label="Quick guide">?</button>',
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
    populateStyleControls(node);
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

  // ---------------- Move mode (drag-and-drop reorder) ----------------
  function toggleMoveMode() {
    if (editingEl) cancelTextEdit();
    if (elementMode) toggleElementMode();
    moveMode = !moveMode;
    document.body.classList.toggle("cf-move-mode", moveMode);
    const btn = $("cf-move-toggle");
    if (btn) {
      btn.classList.toggle("cf-active", moveMode);
      btn.innerHTML = moveMode
        ? '✓ move mode (on) <span class="cf-kbd-hint">M</span>'
        : '↕ move element <span class="cf-kbd-hint">M</span>';
    }
    if (!moveMode) cancelMoveDrag();
    else showToast("Drag any element to reorder it among siblings. Esc cancels.", 3500);
  }

  function isMoveEligible(el) {
    if (!el || el.nodeType !== 1) return false;
    if (insideOurUI(el)) return false;
    if (el === document.body || el === document.documentElement || el.tagName === "HEAD") return false;
    const parent = el.parentElement;
    if (!parent || parent === document.body || parent === document.documentElement) return false;
    if (parent.children.length < 2) return false;       // nothing to reorder among
    if (el.hasAttribute("data-cf-no-move")) return false;
    if (parent.hasAttribute("data-cf-no-move-children")) return false;
    return true;
  }

  function onMovePointerDown(e) {
    if (!moveMode) return;
    if (insideOurUI(e.target)) return;
    // Walk up to find the closest move-eligible ancestor
    let el = e.target;
    while (el && el !== document.body && !isMoveEligible(el)) el = el.parentElement;
    if (!isMoveEligible(el)) return;
    e.preventDefault();
    e.stopPropagation();
    movePointerDownEl = el;
    movePointerDownXY = { x: e.clientX, y: e.clientY };
  }

  function onMovePointerMove(e) {
    if (!moveMode) return;
    if (movePointerDownEl && !moveDragging) {
      const dx = e.clientX - movePointerDownXY.x;
      const dy = e.clientY - movePointerDownXY.y;
      if (Math.sqrt(dx * dx + dy * dy) >= MOVE_DRAG_THRESHOLD_PX) startMoveDrag(e);
    }
    if (moveDragging) updateMoveDrag(e);
  }

  function onMovePointerUp(e) {
    if (!moveMode) return;
    if (moveDragging) { endMoveDrag(e); }
    movePointerDownEl = null;
    movePointerDownXY = null;
  }

  function startMoveDrag(e) {
    moveDragging = true;
    moveDragEl = movePointerDownEl;
    moveDragParent = moveDragEl.parentElement;
    moveDragOriginIndex = Array.from(moveDragParent.children).indexOf(moveDragEl);
    const rect = moveDragEl.getBoundingClientRect();
    moveGhostEl = moveDragEl.cloneNode(true);
    moveGhostEl.removeAttribute("id"); // avoid duplicate id
    Object.assign(moveGhostEl.style, {
      position: "fixed",
      top: rect.top + "px",
      left: rect.left + "px",
      width: rect.width + "px",
      height: rect.height + "px",
      margin: "0",
      opacity: "0.75",
      pointerEvents: "none",
      zIndex: "2147483646",
      transition: "none",
    });
    moveGhostEl.classList.add("cf-move-ghost");
    document.body.appendChild(moveGhostEl);
    moveDragEl.classList.add("cf-move-source");
    moveDropIndicatorEl = document.createElement("div");
    moveDropIndicatorEl.className = "cf-move-drop-indicator";
    document.body.appendChild(moveDropIndicatorEl);
    updateMoveDrag(e);
  }

  function updateMoveDrag(e) {
    if (!moveGhostEl) return;
    const offsetX = e.clientX - movePointerDownXY.x;
    const offsetY = e.clientY - movePointerDownXY.y;
    moveGhostEl.style.transform = `translate(${offsetX}px, ${offsetY}px) rotate(1.5deg)`;
    moveDropIndex = findDropIndex(e.clientY);
    positionDropIndicator(moveDropIndex);
  }

  function findDropIndex(clientY) {
    const siblings = Array.from(moveDragParent.children).filter(c => c !== moveDragEl);
    for (let i = 0; i < siblings.length; i++) {
      const r = siblings[i].getBoundingClientRect();
      if (clientY < r.top + r.height / 2) return i;
    }
    return siblings.length;
  }

  function positionDropIndicator(idx) {
    if (!moveDropIndicatorEl) return;
    const siblings = Array.from(moveDragParent.children).filter(c => c !== moveDragEl);
    let top, left, width;
    if (siblings.length === 0) {
      const r = moveDragParent.getBoundingClientRect();
      top = r.top + 2; left = r.left; width = r.width;
    } else if (idx >= siblings.length) {
      const r = siblings[siblings.length - 1].getBoundingClientRect();
      top = r.bottom; left = r.left; width = r.width;
    } else {
      const r = siblings[idx].getBoundingClientRect();
      top = r.top - 1; left = r.left; width = r.width;
    }
    moveDropIndicatorEl.style.top = top + "px";
    moveDropIndicatorEl.style.left = left + "px";
    moveDropIndicatorEl.style.width = width + "px";
  }

  // Compact sibling anchor info — enough for the agent to locate the drop
  // position in source even when cf_id isn't persisted there.
  function moveSiblingAnchor(el) {
    if (!el) return null;
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      cf_id: (el.dataset && el.dataset.cfId) || null,
      data_svc: (el.dataset && el.dataset.svc) || null,
      data_cf_change: el.getAttribute("data-cf-change") || null,
      text_snippet: (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60),
    };
  }

  function moveLabel(el, fallback) {
    const t = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
    if (t) return t.slice(0, 40);
    if (el.id) return "#" + el.id;
    return fallback || el.tagName.toLowerCase();
  }

  function autoCommentForMove(el, toPrev, toNext, atEnd, atStart) {
    const me = moveLabel(el);
    if (atStart) return `moved "${me}" to top of list`;
    if (atEnd)   return `moved "${me}" to end of list`;
    if (toNext)  return `moved "${me}" above "${moveLabel(toNext)}"`;
    if (toPrev)  return `moved "${me}" below "${moveLabel(toPrev)}"`;
    return `moved "${me}"`;
  }

  function endMoveDrag(e) {
    if (moveDropIndex == null || moveDropIndex === moveDragOriginIndex) {
      cancelMoveDrag();
      return;
    }
    const allOriginal = Array.from(moveDragParent.children);
    const fromIndex = moveDragOriginIndex;
    const toIndex = moveDropIndex;
    const fromPrev = allOriginal[fromIndex - 1] || null;
    const fromNext = allOriginal[fromIndex + 1] || null;
    const siblings = allOriginal.filter(c => c !== moveDragEl);
    const toPrev = siblings[toIndex - 1] || null;
    const toNext = siblings[toIndex] || null;
    const atEnd = toIndex >= siblings.length;
    const atStart = toIndex === 0;

    // Perform the visual move
    if (atEnd) moveDragParent.appendChild(moveDragEl);
    else moveDragParent.insertBefore(moveDragEl, siblings[toIndex]);

    const payload = {
      id: "c-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
      type: "move",
      created_at: new Date().toISOString(),
      element: anchorInfo(moveDragEl),
      parent: {
        tag: moveDragParent.tagName.toLowerCase(),
        id: moveDragParent.id || null,
        selector: stableSelector(moveDragParent),
      },
      from: { index: fromIndex, prev_anchor: moveSiblingAnchor(fromPrev), next_anchor: moveSiblingAnchor(fromNext) },
      to:   { index: toIndex,   prev_anchor: moveSiblingAnchor(toPrev),   next_anchor: moveSiblingAnchor(toNext)   },
      comment: autoCommentForMove(moveDragEl, toPrev, toNext, atEnd, atStart),
    };

    // Refining a previous move on the same element — keep original `from`, update `to`.
    const cfId = payload.element && payload.element.cf_id;
    const existingIdx = pending.findIndex(c => c.type === "move" && c.element && cfId && c.element.cf_id === cfId);
    if (existingIdx >= 0) {
      payload.from = pending[existingIdx].from;
      payload.id = pending[existingIdx].id;
      pending[existingIdx] = payload;
    } else {
      pending.push(payload);
    }
    saveLS();
    renderPending();
    showToast("move queued");
    cancelMoveDrag();
  }

  function cancelMoveDrag() {
    if (moveGhostEl) { moveGhostEl.remove(); moveGhostEl = null; }
    if (moveDropIndicatorEl) { moveDropIndicatorEl.remove(); moveDropIndicatorEl = null; }
    if (moveDragEl) moveDragEl.classList.remove("cf-move-source");
    moveDragEl = null;
    moveDragParent = null;
    moveDragOriginIndex = null;
    moveDropIndex = null;
    movePointerDownEl = null;
    movePointerDownXY = null;
    moveDragging = false;
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
    if (editingEl || elementMode || moveMode || moveDragging) return;
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
    if (insideOurUI(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    snapshotDragging = true;
    snapshotStartXY = { x: e.clientX, y: e.clientY };
    snapshotRectEl = document.createElement("div");
    snapshotRectEl.className = "cf-snapshot-rect";
    document.body.appendChild(snapshotRectEl);
    updateSnapshotRect(e.clientX, e.clientY);
  }
  function onSnapshotPointerMove(e) {
    if (!snapshotDragging) return;
    updateSnapshotRect(e.clientX, e.clientY);
  }
  function onSnapshotPointerUp(e) {
    if (!snapshotDragging) return;
    const x1 = snapshotStartXY.x, y1 = snapshotStartXY.y;
    const x2 = e.clientX, y2 = e.clientY;
    const left = Math.min(x1, x2), top = Math.min(y1, y2);
    const w = Math.abs(x2 - x1), h = Math.abs(y2 - y1);
    if (w < MIN_SNAPSHOT_PX || h < MIN_SNAPSHOT_PX) { cancelSnapshotDrag(); return; }
    if (snapshotRectEl) snapshotRectEl.remove();
    snapshotRectEl = null;
    snapshotDragging = false;
    snapshotStartXY = null;
    captureSnapshotRegion(left, top, w, h);
  }
  function updateSnapshotRect(x, y) {
    if (!snapshotRectEl) return;
    const left = Math.min(snapshotStartXY.x, x);
    const top = Math.min(snapshotStartXY.y, y);
    snapshotRectEl.style.left = left + "px";
    snapshotRectEl.style.top = top + "px";
    snapshotRectEl.style.width = Math.abs(x - snapshotStartXY.x) + "px";
    snapshotRectEl.style.height = Math.abs(y - snapshotStartXY.y) + "px";
  }
  function cancelSnapshotDrag() {
    if (snapshotRectEl) { snapshotRectEl.remove(); snapshotRectEl = null; }
    snapshotDragging = false;
    snapshotStartXY = null;
  }

  async function captureSnapshotRegion(vpLeft, vpTop, w, h) {
    let html2canvas, blob, uploadedPath;
    const root = $("claude-feedback-root");
    const prevVis = root ? root.style.visibility : "";
    try {
      showToast("capturing…", 1200);
      html2canvas = await ensureHtml2Canvas();
      if (root) root.style.visibility = "hidden";
      const docX = vpLeft + window.scrollX;
      const docY = vpTop + window.scrollY;
      const canvas = await html2canvas(document.body, {
        x: docX,
        y: docY,
        width: w,
        height: h,
        scrollX: 0,
        scrollY: -window.scrollY,
        windowWidth: document.documentElement.clientWidth,
        windowHeight: document.documentElement.clientHeight,
        backgroundColor: null,
        useCORS: true,
        allowTaint: true,
        logging: false,
      });
      if (root) root.style.visibility = prevVis;
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
      console.error("snapshot capture failed", err);
      showToast("snapshot failed: " + err.message, 4000);
      return;
    }
    // Build payload + open the comment editor
    const elementsInRegion = findElementsInRegion(vpLeft, vpTop, w, h);
    openSnapshotEditor({
      type: "snapshot",
      region: { x: vpLeft + window.scrollX, y: vpTop + window.scrollY, w, h, viewport_x: vpLeft, viewport_y: vpTop },
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
      `<div style="font-size:10px;text-transform:uppercase;letter-spacing:.14em;color:#b14000;font-weight:600;margin-bottom:6px;">snapshot</div>` +
      `<img src="${payload.image_url}" alt="captured region" style="display:block;max-width:100%;max-height:200px;border-radius:4px;border:1px solid #ddd;">`;
    editor._payload = payload;
    editor.style.top = Math.max(12, window.innerHeight / 2 - 200) + "px";
    editor.style.left = Math.max(12, window.innerWidth / 2 - 160) + "px";
    editor.classList.add("cf-visible");
    setTimeout(() => $("cf-editor-text").focus(), 50);
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
    } else if (c.type === "snapshot") {
      quoteEl.innerHTML =
        `<div style="font-size:10px;text-transform:uppercase;letter-spacing:.14em;color:#b14000;font-weight:600;margin-bottom:6px;">snapshot</div>` +
        (c.image_url ? `<img src="${escapeHtml(c.image_url)}" alt="snapshot" style="display:block;max-width:100%;max-height:200px;border-radius:4px;border:1px solid #ddd;">` : "");
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
      el = el.parentElement;
    }
    return null;
  }

  function startTextEdit(el) {
    if (editingEl) return;
    if (elementMode) return;
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
    editingEl = el;
    editingOriginalHtml = el.innerHTML;
    editingOriginalText = "";
    editingOriginalOuterHtml = el.outerHTML;
    editingOriginalCssText = el.style.cssText;
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
    CF_RESIZE_HANDLES.forEach((id) => {
      const h = $(id);
      if (h) h.classList.remove("cf-visible");
    });
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
      snapEdges: collectSnapEdges(editingEl),
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
      // height, border, etc. set via the toolbar / resize handle / border
      // popover all live on .style. Without this, cancel only reverts content
      // but leaves visual style overrides stuck on the element.
      if (editingOriginalCssText != null) {
        editingEl.style.cssText = editingOriginalCssText;
      }
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
      pending.push({
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
    ["font-family", "font-size", "color", "background-color", "border", "border-radius"]
      .forEach((p) => editingEl.style.removeProperty(p));
    populateStyleControls(editingEl);
  }
  // Border weight + color compose into a single `border: <w>px solid <c>`
  // shorthand. Setting w to 0 removes the border entirely.
  function applyBorder() {
    if (!editingEl) return;
    const w = parseFloat($("cf-edit-border-w").value) || 0;
    const c = $("cf-edit-border-c").value || "#000000";
    if (w <= 0) editingEl.style.removeProperty("border");
    else editingEl.style.setProperty("border", w + "px solid " + c, "important");
  }
  function applyRadius() {
    if (!editingEl) return;
    const r = parseFloat($("cf-edit-radius").value) || 0;
    if (r <= 0) editingEl.style.removeProperty("border-radius");
    else editingEl.style.setProperty("border-radius", r + "px", "important");
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
  function populateStyleControls(el) {
    const cs = getComputedStyle(el);
    $("cf-edit-color").value = rgbToHex(cs.color);
    // Background may be transparent; the picker can't represent that, default to a sensible color
    const bg = cs.backgroundColor;
    $("cf-edit-bg").value = (bg && !/rgba?\([^)]*,\s*0\s*\)$/.test(bg)) ? rgbToHex(bg) : "#ffffff";
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
    // Border weight / color / radius — read top-side as the representative
    // value (browsers split shorthand into per-side computed values).
    const bw = parseFloat(cs.borderTopWidth) || 0;
    $("cf-edit-border-w").value = Math.round(bw * 10) / 10;
    $("cf-edit-border-c").value = rgbToHex(cs.borderTopColor) || "#000000";
    const br = parseFloat(cs.borderTopLeftRadius) || 0;
    $("cf-edit-radius").value = Math.round(br);
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
    // Reject pairs the OS counted as a dblclick but landed too far apart in time
    if (lastClickTime - prevClickTime > MAX_DBLCLICK_INTERVAL_MS) return;
    // If another element is already being edited, allow swapping: dblclicks
    // INSIDE the current target keep the existing edit (so contenteditable
    // can handle word-selection); dblclicks elsewhere commit-then-start.
    if (editingEl) {
      if (editingEl.contains(e.target)) return;
      commitOrExitCurrentEdit();
    }
    // Image path: if the dblclick landed on / inside an <img>/<video>/<svg>/etc.,
    // open the resize-only experience instead of looking for text.
    const img = findImageAncestor(e.target);
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
      } else if (c.type === "move") {
        const meTag = (c.element && c.element.tag) || "element";
        const meText = (c.element && c.element.text_snippet) || "";
        const meShort = meText.length > 60 ? meText.slice(0, 60) + "…" : meText;
        const parentLabel = c.parent ? (c.parent.id ? "#" + c.parent.id : c.parent.tag) : "(root)";
        const fromIdx = c.from && c.from.index != null ? c.from.index : "?";
        const toIdx   = c.to   && c.to.index   != null ? c.to.index   : "?";
        quote.innerHTML =
          `<div style="font-size:10px;text-transform:uppercase;letter-spacing:.14em;color:#b14000;font-weight:600;margin-bottom:3px;">move · ${escapeHtml(meTag)}</div>` +
          (meShort ? `<div style="color:#333;font-size:12px;margin-bottom:3px;">${escapeHtml(meShort)}</div>` : "") +
          `<div style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:#555;">` +
          `${escapeHtml(parentLabel)}: position ${escapeHtml(String(fromIdx))} → ${escapeHtml(String(toIdx))}` +
          `</div>`;
      } else if (c.type === "snapshot") {
        const r = c.region || {};
        const dims = (r.w && r.h) ? `${Math.round(r.w)} × ${Math.round(r.h)}` : "";
        const n = (c.elements && c.elements.length) || 0;
        quote.innerHTML =
          `<div style="font-size:10px;text-transform:uppercase;letter-spacing:.14em;color:#b14000;font-weight:600;margin-bottom:4px;">snapshot${dims ? " · " + escapeHtml(dims) : ""}</div>` +
          (c.image_url ? `<img src="${escapeHtml(c.image_url)}" alt="snapshot" style="display:block;max-width:100%;max-height:140px;border-radius:4px;border:1px solid #ddd;margin-bottom:4px;">` : "") +
          (n > 0 ? `<div style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:#555;">${n} element${n === 1 ? "" : "s"} in region</div>` : "");
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
    $("cf-clear-all").disabled = pending.length === 0;
    updateBadge();
    refreshPendingEditMarkers();
  }

  // Resolve a pending comment's target element so the row can scroll-to-it
  // and so we can drop a "pending edit" dot on text-edit targets.
  function getCommentTarget(c) {
    if (c.type === "general") return null;
    if (c.type === "snapshot") return null;
    if (c.type === "move") return findElementByAnchorInfo(c.element);
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
    "move":      "↕",
  };
  function placeEditMarker(target, c) {
    target.classList.add("cf-has-pending-edit");
    const marker = document.createElement("span");
    marker.className = "cf-edit-marker cf-marker-" + c.type;
    marker.textContent = CF_MARKER_GLYPH[c.type] || "✎";
    const label = c.type === "text-edit" ? "pending text edit"
                : c.type === "selection" ? "pending selection comment"
                : c.type === "elements"  ? "pending element comment"
                : c.type === "move"      ? "pending move"
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
    target.appendChild(marker);
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
    pending = pending.filter((x) => x.id !== c.id);
    saveLS();
    renderPending();
    showToast("pending edit removed");
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
    $("cf-clear-all").addEventListener("click", () => {
      if (pending.length === 0) return;
      const n = pending.length;
      const ok = window.confirm(`Discard ${n} pending comment${n === 1 ? "" : "s"}? This can't be undone.`);
      if (!ok) return;
      pending = [];
      saveLS();
      renderPending();
      showToast("pending cleared");
    });
    $("cf-elem-toggle").addEventListener("click", toggleElementMode);
    $("cf-move-toggle").addEventListener("click", toggleMoveMode);
    // Move mode — pointer-event capture phase so we run before the dragged
    // element's own click handlers (toggles, links, etc.). preventDefault on
    // pointerdown also short-circuits text selection while move-mode is on.
    document.addEventListener("pointerdown", onMovePointerDown, true);
    document.addEventListener("pointermove", onMovePointerMove, true);
    document.addEventListener("pointerup", onMovePointerUp, true);
    // Snapshot mode — Alt + drag. Capture phase so we run before the page's
    // own pointer handlers and can intercept the drag.
    document.addEventListener("keydown", onSnapshotKeyDown);
    document.addEventListener("keyup", onSnapshotKeyUp);
    window.addEventListener("blur", onSnapshotBlur);
    document.addEventListener("pointerdown", onSnapshotPointerDown, true);
    document.addEventListener("pointermove", onSnapshotPointerMove, true);
    document.addEventListener("pointerup", onSnapshotPointerUp, true);
    // Suppress click handlers on the page while move-mode is on, so clicking
    // an element (without dragging) doesn't fire its own toggles/navigations.
    // Our own UI (panel buttons, etc.) is exempt via insideOurUI().
    document.addEventListener("click", (e) => {
      if (!moveMode) return;
      if (insideOurUI(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
    }, true);

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
    $("cf-edit-border-w").addEventListener("mousedown", (e) => e.stopPropagation());
    $("cf-edit-border-w").addEventListener("input", applyBorder);
    $("cf-edit-border-c").addEventListener("mousedown", (e) => e.stopPropagation());
    $("cf-edit-border-c").addEventListener("input", applyBorder);
    $("cf-edit-radius").addEventListener("mousedown", (e) => e.stopPropagation());
    $("cf-edit-radius").addEventListener("input", applyRadius);
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
      // Marker menu: close when click lands outside it (regardless of where).
      const menu = $("cf-marker-menu");
      if (menu && menu.classList.contains("cf-visible") && !menu.contains(e.target) && !e.target.classList.contains("cf-edit-marker")) {
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
        if ($("cf-help").classList.contains("cf-visible")) { e.preventDefault(); closeHelp(); }
        else if (editingEl) { e.preventDefault(); cancelTextEdit(); }
        else if ($("cf-editor").classList.contains("cf-visible")) closeEditor();
        else if (snapshotDragging) { e.preventDefault(); cancelSnapshotDrag(); }
        else if (moveDragging) { e.preventDefault(); cancelMoveDrag(); }
        else if (moveMode) { e.preventDefault(); toggleMoveMode(); }
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
        case "m": case "M":
          e.preventDefault(); toggleMoveMode(); break;
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
    setPillCorner(loadPillCorner());
    loadGridState();
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
