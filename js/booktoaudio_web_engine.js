// BookToAudio WebView content engine. Publish this file unchanged; API version 1.
// Native popup/login policy and Flutter channels remain owned by the app.
(function () {
  'use strict';
  // Extension convention: edit this registry in the published JS; do not add
  // per-site rules in Dart. Entries are checked in order, before generic fallback.
  // No callback runs at installation. All hooks are synchronous, with context:
  // {document, window, root, adapter, url, readText(element, {signature:false})}.
  // Entry interface (only matches is required):
  // matches(hostname): boolean; rootSelectors: string[] (ordered alternatives);
  // getRoot(context): Element|null (overrides rootSelectors);
  // titleSelectors: string[] (relative to root); getTitle(context): string;
  // nextSelectors: string[]; getNext(context): Element[] (forward controls only);
  // isReady(context): boolean (additional gate; nonempty/stable still required);
  // getSignatureText(context): string (chapter body only, never URL/title);
  // getBlocks(context): {element:Element,text:string,type:string}[] (optional
  // replacement for generic DOM traversal, keeping real elements for selection);
  // autoSelect(block, context): boolean; format({blocks,rawText,text,...context}):
  // string. format must respect explicit rawText and selected:false (blocks passed
  // here are already filtered). Never use unrelated DOM titles for rawText.
  // Hooks own arbitrary site markup, not native permissions, I/O or navigation.
  // Null/missing host roots must wait, never treat a toolbar as chapter content.
  const siteAdapters = [
    {
      matches: hostname => hostname === 'truyendich.space' || hostname.endsWith('.truyendich.space'),
      rootSelectors: ['#original-content-tab'],
      getTitle: ({ root, readText }) => {
        const article = root && root.closest('article');
        return readText(article && article.querySelector('header h1[itemprop="name"], header h1'));
      },
      nextSelectors: ['a[aria-label="Chương sau"]', 'a[rel~="next"]'],
      isReady: ({ root }) => !!root && !root.closest('[aria-busy="true"]'),
      autoSelect: () => true,
    },
  ];
  const genericAdapter = { rootSelectors: ['article', 'main', '[role="main"]'], nextSelectors: ['a[rel~="next"]'] };
  let extractionOptions = { automation: false };
  let stableSignature = null;
  let stableSince = 0;
  let resetHeld = false;
  let previousKey = null;
  const contentNoise = 'script, style, noscript, iframe, svg, canvas, nav, aside, footer, button, select, input, textarea, [role="toolbar"], .toolbar, .adsbygoogle, [class*="ad-container"], [class*="advert"], [id*="google_ads"], #wte-overlay, #wte-styles, #wte-picker-style';
  const normalizeText = value => String(value == null ? '' : value).replace(/\r\n?/g, '\n')
    .split('\n').map(line => line.trim().replace(/[\t \u00a0]+/g, ' ')).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const firstLineTitle = text => (normalizeText(text).split('\n').find(line => line.trim()) || '').split(/\s+/).slice(0, 10).join(' ');
  function queryAll(root, selector) {
    try { return root ? Array.from(root.querySelectorAll(selector)) : []; } catch (_) { return []; }
  }
  function matchesSelector(element, selector) {
    try { return element.matches(selector); } catch (_) { return false; }
  }
  function visibleContent(element) {
    for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
      if (node.matches('[hidden], [inert], [aria-hidden="true"]')) return false;
      const style = window.getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0') return false;
    }
    return !!element;
  }
  function userRemoved(element) {
    return (window.wteRemoveSelectors || []).some(selector => {
      if (selector.startsWith('TEXT:')) {
        const text = selector.slice(5).trim();
        return !!text && Array.from(element.childNodes).some(node => node.nodeType === 3 && node.nodeValue.trim() === text);
      }
      return matchesSelector(element, selector);
    });
  }
  // Read live text without temporary attributes, innerHTML hashes or observers:
  // highlight classes, IDs and harmless wrapper rerenders cannot reset stability.
  function readContentText(element, options = {}) {
    function walk(node) {
      if (node.nodeType === 3) return node.nodeValue.replace(/\s+/g, ' ');
      if (node.nodeType !== 1 || !visibleContent(node) || userRemoved(node) || node.matches(contentNoise)) return '';
      const tag = node.tagName.toLowerCase();
      if (options.signature && (node.matches('header, h1, h2, h3, h4, h5, h6, [role="heading"]'))) return '';
      if (tag === 'br') return '\n';
      const text = Array.from(node.childNodes).map(walk).join('');
      return /^(p|div|section|article|main|li|blockquote|pre|h[1-6])$/.test(tag) ? '\n' + text + '\n' : text;
    }
    return normalizeText(element ? walk(element) : '');
  }
  function siteContext() {
    const adapter = siteAdapters.find(entry => entry.matches(window.location.hostname)) || genericAdapter;
    const context = { document, window, adapter, root: null, url: window.location.href, readText: readContentText };
    if (adapter.getRoot) context.root = adapter.getRoot(context);
    else {
      for (const selector of adapter.rootSelectors || []) {
        context.root = queryAll(document, selector).find(visibleContent) || null;
        if (context.root) break;
      }
    }
    if (!context.root && adapter === genericAdapter) context.root = document.body;
    return context;
  }
  function chapterTitle(context) {
    if (context.adapter.getTitle) return normalizeText(context.adapter.getTitle(context));
    for (const selector of context.adapter.titleSelectors || ['h1', 'h2', '[role="heading"]']) {
      const title = queryAll(context.root, selector).map(el => readContentText(el)).find(Boolean);
      if (title) return title;
    }
    return '';
  }
  function textSignature(text) {
    // FNV-1a over normalized chapter text; URL deliberately is not part of it.
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
    return text ? 'v1:' + text.length + ':' + (hash >>> 0).toString(16) : '';
  }
  return {
    apiVersion: 1,
    pollPage: function (options = {}) {
      if (options.extraction) this.configureExtraction(options.extraction);
      const { previous = null, reset = false } = options;
      const key = previous ? JSON.stringify([previous.url, previous.signature]) : '';
      if ((reset && !resetHeld) || key !== previousKey) stableSignature = null;
      resetHeld = !!reset;
      previousKey = key;
      const context = siteContext();
      const ready = visibleContent(context.root) && (!context.adapter.isReady || context.adapter.isReady(context));
      const body = ready ? normalizeText(context.adapter.getSignatureText
        ? context.adapter.getSignatureText(context) : readContentText(context.root, { signature: true })).replace(/\s+/g, ' ') : '';
      const signature = textSignature(body);
      const now = Date.now();
      if (!signature || signature !== stableSignature) {
        stableSignature = signature;
        stableSince = now;
      }
      return JSON.stringify({
        status: signature && now - stableSince >= 800 && (!previous || signature !== previous.signature) ? 'ready' : 'waiting',
        snapshot: { url: context.url, signature },
        title: chapterTitle(context) || firstLineTitle(body),
      });
    },
    getChapterContent: function (options = {}) {
      const { rawText = null, blocks = null } = options;
      const context = siteContext();
      const selected = (blocks == null ? JSON.parse(this.getSelectedBlocks()) : blocks)
        .filter(block => block.selected !== false && normalizeText(block.text));
      let text = rawText == null ? selected.map((block, index) => {
        const list = block.type === 'listItem' || block.type === 'li';
        return (index ? (list ? '\n' : '\n\n') : '') + (list ? '• ' : '') + normalizeText(block.text);
      }).join('') : /^(null|undefined)$/.test(normalizeText(rawText)) ? '' : normalizeText(rawText);
      if (context.adapter.format) text = context.adapter.format({ ...context, blocks: selected, rawText, text });
      text = normalizeText(text);
      const heading = rawText == null && selected.find(block => block.type === 'heading' || /^h[1-6]$/.test(block.type));
      const title = !text ? '' : rawText != null ? firstLineTitle(text)
        : (heading && normalizeText(heading.text)) || (blocks == null && chapterTitle(context)) || firstLineTitle(text);
      return JSON.stringify({ text, title, url: context.url });
    },
    configureExtraction: function ({ removeSelectors = [], automation = false } = {}) {
      window.wteRemoveSelectors = Array.isArray(removeSelectors) ? removeSelectors.filter(s => typeof s === 'string') : [];
      extractionOptions = { automation: automation === true };
    },
    toggleAll: function (selected) {
      if (window.wteToggleAll) window.wteToggleAll(!!selected);
    },
    extractAndHighlight: function () {
      return (function() {
        console.log("WTE: Starting extraction and highlighting...");

        // ── PHASE 1: CLEANUP ────────────────────────────────────────────────────────

        clearTimeout(window.wteExtractionTimer);
        delete window.wteExtractionTimer;
        if (window.wteStopBlockObserver) {
          window.wteStopBlockObserver();
          delete window.wteStopBlockObserver;
        }
        document.querySelectorAll('[data-wte-id]').forEach(el => el.removeAttribute('data-wte-id'));
        document.querySelectorAll('.wte-highlight').forEach(el => {
          el.classList.remove('wte-highlight', 'wte-deselected');
        });

        const existingOverlay = document.getElementById('wte-overlay');
        if (existingOverlay) existingOverlay.remove();

        if (window.wteGlobalClickHandler) {
          document.removeEventListener('click', window.wteGlobalClickHandler, true);
          delete window.wteGlobalClickHandler;
        }
        if (window.wteContextMenuHandler) {
          document.removeEventListener('contextmenu', window.wteContextMenuHandler, true);
          delete window.wteContextMenuHandler;
        }
        if (window.wteTouchStart) {
          document.removeEventListener('mousedown',   window.wteTouchStart, true);
          document.removeEventListener('mouseup',     window.wteTouchEnd,   true);
          document.removeEventListener('touchstart',  window.wteTouchStart, true);
          document.removeEventListener('touchend',    window.wteTouchEnd,   true);
          document.removeEventListener('touchmove',   window.wteTouchMove,  true);
          document.removeEventListener('touchcancel', window.wteTouchEnd,   true);
          delete window.wteTouchStart;
          delete window.wteTouchMove;
          delete window.wteTouchEnd;
        }
        if (window._wteObserver) {
          window._wteObserver.disconnect();
          delete window._wteObserver;
        }

        // ── PHASE 2: AGGRESSIVE NOISE REMOVAL ───────────────────────────────────────

        const noiseSelectors = [
          '.adsbygoogle', '.google-anno-skip', 'ins[class*="adsbygoogle"]',
          '[id*="aswift"]', '[id*="google_ads"]', '[id*="div-gpt-ad"]',
          'iframe[src*="ads"]', 'iframe[src*="doubleclick"]',
          '[class*="ads-"]', '[class*="ad-container"]', '[class*="ad_"]',
          '[class*="advert"]', '[id*="ad-"]', '[id*="ad_"]',
          '[class*="social"]', '[class*="share-"]', '[class*="sharing"]',
          '[class*="like-btn"]', '[class*="fb-"]', '[class*="twitter-"]',
          '[class*="comment"]', '#comments', '#respond', '[class*="respond"]',
          '[id*="comment"]',
          '[class*="related"]', '[class*="recommend"]', '[class*="suggestion"]',
          '[class*="you-may"]', '[class*="also-like"]',
          '[class*="login-form"]', '[class*="register-form"]',
          '[class*="modal"]', '[class*="popup"]', '[class*="overlay"][class*="ad"]',
          '[class*="breadcrumb"]',
          '[class*="copyright"]', '[class*="footer-widget"]', '[class*="footer-link"]',
          '[class*="rating"]', '[class*="vote"]', '[class*="star-rating"]',
          '[class*="subscribe"]', '[class*="newsletter"]', '[class*="notification-"]',
        ];

        let noiseRemoved = 0;
        noiseSelectors.forEach(sel => {
          try {
            document.querySelectorAll(sel).forEach(el => {
              const text    = (el.innerText || '').trim();
              const links   = el.querySelectorAll('a');
              const linkTxt = Array.from(links).reduce((s, a) => s + (a.innerText || '').length, 0);
              const isContentLike = text.length > 500 && (linkTxt / (text.length || 1)) < 0.3;
              if (!isContentLike) { el.remove(); noiseRemoved++; }
            });
          } catch(e) {}
        });
        console.log("WTE: Noise removed:", noiseRemoved, "elements");

        // User-defined remove selectors (from automation templates).
        if (window.wteRemoveSelectors) {
          window.wteRemoveSelectors.forEach(selector => {
            try {
              if (selector.startsWith('TEXT:')) {
                const textToFind = selector.substring(5).trim();
                if (!textToFind) return;
                const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
                let node;
                const toRemove = [];
                while ((node = walker.nextNode())) {
                  if (node.nodeValue.trim() === textToFind && node.parentElement) {
                    toRemove.push(node.parentElement);
                  }
                }
                toRemove.forEach(el => el.remove());
              } else {
                document.querySelectorAll(selector).forEach(el => el.remove());
              }
            } catch(e) { console.warn('WTE: remove selector error:', selector, e); }
          });
        }

        // Inject / refresh highlight styles.
        const existingStyle = document.getElementById('wte-styles');
        if (existingStyle) existingStyle.remove();
        const style = document.createElement('style');
        style.id = 'wte-styles';
        style.textContent = `
          *:not(input):not(textarea) {
            -webkit-touch-callout: none !important;
            -webkit-user-select: none !important;
            user-select: none !important;
          }
          .wte-highlight {
            background: rgba(0, 212, 170, 0.16) !important;
            border-left: 4px solid rgba(0, 212, 170, 0.8) !important;
            border-radius: 4px !important;
            cursor: pointer !important;
            -webkit-touch-callout: none !important;
            -webkit-user-select: none !important;
            user-select: none !important;
            transition: background 0.2s, border-color 0.2s !important;
            padding-left: 6px !important;
          }
          .wte-highlight:hover { background: rgba(0, 212, 170, 0.3) !important; }
          .wte-highlight.wte-deselected {
            background: rgba(255, 107, 107, 0.08) !important;
            border-left: 4px solid rgba(255, 107, 107, 0.6) !important;
          }
          .wte-highlight.wte-deselected:hover { background: rgba(255, 107, 107, 0.2) !important; }
        `;
        document.head.appendChild(style);

        // ── HELPERS ──────────────────────────────────────────────────────────────────

        // Reader containers often handle clicks to toggle their toolbar (including
        // React's DOM onclick shim). A handler alone does not make text a control.
        // Use the same semantic controls for ancestor exclusion and control density.
        const interactiveSelector = 'a, button, select, option, input, textarea, [href], [role="button"], [role="link"]';

        function getCleanText(el) {
          // Mark invisible elements in the live DOM temporarily
          const allLive = el.getElementsByTagName('*');
          const unmarked = [];
          for (let i = 0; i < allLive.length; i++) {
            const child = allLive[i];
            if (!isVisible(child)) {
              child.setAttribute('data-wte-hidden', 'true');
              unmarked.push(child);
            }
          }

          // Clone the element
          const clone = el.cloneNode(true);

          // Clean up temporary attributes immediately
          for (let i = 0; i < unmarked.length; i++) {
            unmarked[i].removeAttribute('data-wte-hidden');
          }

          // Remove script, style, noscript, form controls, and invisible elements from clone
          clone.querySelectorAll('script, style, noscript, select, option, input, textarea, button, [data-wte-hidden]').forEach(e => e.remove());

          function extractText(node) {
            if (node.nodeType === 3) { // Node.TEXT_NODE
              return node.nodeValue.replace(/\s+/g, ' ');
            }
            if (node.nodeType === 1) { // Node.ELEMENT_NODE
              const tag = node.tagName.toLowerCase();
              if (tag === 'br') return '\n';

              let text = '';
              for (const child of node.childNodes) {
                text += extractText(child);
              }
              if (['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote', 'section'].includes(tag)) {
                return '\n' + text + '\n';
              }
              return text;
            }
            return '';
          }

          return extractText(clone)
            .split('\n')
            .map(line => line.trim().replace(/ +/g, ' '))
            .join('\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
        }

        function isVisible(el) {
          if (!el) return false;
          const tag = el.tagName ? el.tagName.toLowerCase() : '';
          if (tag === 'br') return true;

          const s = window.getComputedStyle(el);
          if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
          if (parseFloat(s.maxHeight) === 0) return false;
          if (s.overflow === 'hidden' && parseFloat(s.height) === 0) return false;
          if (parseFloat(s.fontSize) < 2) return false;

          const r = el.getBoundingClientRect();
          const isStructural = ['p', 'div', 'pre', 'td', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote', 'section'].includes(tag);
          if (!isStructural) {
            if (r.width <= 0 || r.height <= 0) return false;
          }

          // Offscreen text still belongs to the article. Scrolling must not change
          // its extracted text or prevent a replaced block from being rebound.
          return true;
        }

        function captureBlockPath(el) {
          const path = [];
          let node = el;
          while (node && node !== document.body && node.parentElement) {
            path.unshift({
              node,
              index: Array.prototype.indexOf.call(node.parentElement.children, node),
            });
            node = node.parentElement;
          }
          return path;
        }

        function resolveBlockPath(path) {
          let parent = document.body;
          for (const step of path) {
            // Prefer surviving ancestors, even if siblings were inserted before them.
            const node = step.node.isConnected && step.node.parentElement === parent
              ? step.node : parent.children[step.index];
            if (!node) return null;
            parent = node;
          }
          return parent;
        }

        // ── PHASE 3: EXTRACTION ───────────────────────────────────────────────────────

        function runExtraction() {
          const context = siteContext();
          const bodyText = (document.body.innerText || '').trim();
          if (!bodyText) {
            console.log("WTE: body too short, deferring to MutationObserver");
            return false; // SPA not ready
          }

          const extractedElements = [];
          const allBlocks = [];
          let blockId = 0;

          function isLeafTextElement(el) {
            const tag = el.tagName.toLowerCase();

            // Discard interactive tags directly
            if (['script', 'style', 'noscript', 'iframe', 'canvas', 'svg', 'audio', 'video',
                 'select', 'option', 'input', 'textarea', 'button', 'a', 'nav', 'footer', 'header', 'aside'].includes(tag)) {
              return false;
            }

            if (!isVisible(el)) return false;

            // Exclude actual controls, but keep text inside clickable reader layouts.
            if (el.closest(interactiveSelector)) return false;

            const style = window.getComputedStyle(el);
            const fontSize = parseFloat(style.fontSize);
            if (isNaN(fontSize) || fontSize < 8) return false;

            const text = getCleanText(el);
            if (text.length === 0) return false;

            // Calculate the text length of control/interactive elements inside it
            let controlTextLen = 0;
            el.querySelectorAll(interactiveSelector).forEach(child => {
              let parent = child.parentElement;
              let isNested = false;
              while (parent && parent !== el) {
                if (parent.matches(interactiveSelector)) {
                  isNested = true;
                  break;
                }
                parent = parent.parentElement;
              }
              if (!isNested && isVisible(child)) {
                controlTextLen += getCleanText(child).length;
              }
            });

            // Discard element if it only contains control elements (remaining non-control text length is 0)
            if (text.length - controlTextLen <= 0) {
              return false;
            }

            // Skip if the element contains mostly control/clickable text
            if (controlTextLen / text.length > 0.5) {
              return false;
            }

            const children = el.querySelectorAll('h1, h2, h3, h4, h5, h6, p, li, pre, blockquote, td, div, span, section');
            for (const child of children) {
              if (child !== el && isVisible(child) && getCleanText(child).length > 0) {
                const childTag = child.tagName.toLowerCase();
                if (['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'pre', 'blockquote', 'td', 'section'].includes(childTag)) {
                  return false;
                }
              }
            }
            return true;
          }

          function isChildOfAlreadyExtracted(el) {
            let parent = el.parentElement;
            while (parent && parent !== document.body) {
              if (extractedElements.includes(parent)) return true;
              parent = parent.parentElement;
            }
            return false;
          }

          // Query all potential text elements
          const customBlocks = context.adapter.getBlocks ? context.adapter.getBlocks(context) : null;
          const customByElement = new Map((customBlocks || []).map(block => [block.element, block]));
          const tags = 'h1, h2, h3, h4, h5, h6, p, li, pre, blockquote, td, div, span, section';
          const scope = extractionOptions.automation && context.adapter !== genericAdapter
            ? context.root : document.body;
          let elements = customBlocks ? [...customByElement.keys()]
            : scope ? [scope, ...scope.querySelectorAll(tags)] : [];
          // Explicit user whitelist may include a heading outside the site's root.
          for (const selector of window.wteWhitelist || []) elements.push(...queryAll(document, selector));
          elements = [...new Set(elements)].filter(el => el && el.isConnected).sort((a, b) =>
            a === b ? 0 : a.compareDocumentPosition(b) & 2 ? 1 : -1);

          elements.forEach(el => {
            if (customByElement.has(el) || isLeafTextElement(el)) {
              if (!isChildOfAlreadyExtracted(el)) {
                extractedElements.push(el);

                const custom = customByElement.get(el);
                const text = custom ? normalizeText(custom.text) : getCleanText(el);
                const tag = el.tagName.toLowerCase();

                let type = 'paragraph';
                if (/^h[1-6]$/.test(tag)) {
                  type = 'heading';
                } else if (tag === 'li') {
                  type = 'listItem';
                } else if (tag === 'blockquote') {
                  type = 'quote';
                }
                if (custom && custom.type) type = custom.type;

                el.setAttribute('data-wte-id', `wte-${blockId}`);
                allBlocks.push({
                  id: `wte-${blockId++}`,
                  text: text,
                  type: type,
                  element: el,
                  domPath: captureBlockPath(el),
                  score: 1.0,
                  selected: !!(extractionOptions.automation && context.root &&
                    context.root.contains(el) && context.adapter.autoSelect &&
                    context.adapter.autoSelect({ element: el, text, type }, context))
                });
              }
            }
          });

          console.log("WTE: Extracted blocks:", allBlocks.length);

          window.wteBlocks = allBlocks;

          // ── PHASE 4: HIGHLIGHT ───────────────────────────────────────────────────────

          const blacklist = window.wteBlacklist || [];
          const whitelist = window.wteWhitelist || [];
          const matchesAny = (el, selectors) => {
            if (!selectors || !selectors.length) return false;
            for (const s of selectors) { try { if (el.matches(s)) return true; } catch(e) {} }
            return false;
          };

          allBlocks.forEach(block => {
            block.autoSelected = block.selected;
            if (matchesAny(block.element, blacklist)) block.selected = false;
            if (matchesAny(block.element, whitelist)) block.selected = true;
            block.element.classList.add('wte-highlight');
            if (!block.selected) block.element.classList.add('wte-deselected');
          });

          // ── PHASE 5: INTERACTIVITY ───────────────────────────────────────────────────

          function notifyFlutter() {
            const selected = allBlocks
              .filter(b => b.selected)
              .map(b => ({ id: b.id, text: b.text, type: b.type, score: b.score }));
            const jsonStr = JSON.stringify(selected);
            console.log("WTE: Notifying Flutter — selected:", selected.length);

            const channelNames = ['onBlocksUpdated', 'OnBlocksUpdated', 'flutter_onBlocksUpdated'];
            for (const name of channelNames) {
              try {
                if (typeof window[name] !== 'undefined' && window[name].postMessage) {
                  window[name].postMessage(jsonStr); return;
                }
              } catch(e) {}
              try {
                if (window.webkit?.messageHandlers?.[name]) {
                  window.webkit.messageHandlers[name].postMessage(jsonStr); return;
                }
              } catch(e) {}
            }

            try {
              window.__wteLastUpdate = jsonStr;
              window.dispatchEvent(new CustomEvent('wte-blocks-updated', { detail: jsonStr }));
            } catch(e) {}
          }

          // Expose window.wteUpdateRangeSelection globally for both click handler and Flutter channel
          window.wteUpdateRangeSelection = function() {
            const selectedIndices = [];
            allBlocks.forEach((b, idx) => {
              if (b.selected) selectedIndices.push(idx);
            });
            if (selectedIndices.length > 1) {
              const minIdx = Math.min(...selectedIndices);
              const maxIdx = Math.max(...selectedIndices);
              for (let i = minIdx; i <= maxIdx; i++) {
                const b = allBlocks[i];
                if (!b.selected) {
                  b.selected = true;
                  b.element.classList.remove('wte-deselected');
                }
              }
            }
          };

          let wtePressTimer   = null;
          let wteTouchStartPos = null;
          let wteTempElement  = null;
          const WTE_MOVE_THRESHOLD = 10;

          function wteTouchStart(e) {
            if (wtePressTimer) { clearTimeout(wtePressTimer); wtePressTimer = null; }
            if (wteTempElement) {
              if (wteTempElement.getAttribute('data-wte-id')?.startsWith('wte-temp-')) {
                wteTempElement.removeAttribute('data-wte-id');
              }
              wteTempElement = null;
            }

            let blockEl = e.target.closest('[data-wte-id]');
            if (blockEl) {
              while (blockEl && blockEl.getAttribute('data-wte-id') === 'wte-child') {
                blockEl = blockEl.parentElement ? blockEl.parentElement.closest('[data-wte-id]') : null;
              }
            }
            if (!blockEl) {
              blockEl = e.target;
              if (!blockEl || blockEl === document.body || blockEl === document.documentElement) return;
              if (!blockEl.hasAttribute('data-wte-id')) {
                blockEl.setAttribute('data-wte-id', 'wte-temp-' + Date.now());
                wteTempElement = blockEl;
              }
            }

            const id = blockEl.getAttribute('data-wte-id');
            wteTouchStartPos = e.touches && e.touches.length > 0
              ? { x: e.touches[0].clientX, y: e.touches[0].clientY }
              : { x: e.clientX, y: e.clientY };

            wtePressTimer = setTimeout(() => {
              wtePressTimer = null;
              wteTouchStartPos = null;
              wteTempElement = null;
              try {
                function getRobustSelector(el) {
                  if (!el || el.tagName.toLowerCase() === 'body') return 'body';
                  let sel = el.nodeName.toLowerCase();
                  let cls = (el.className && typeof el.className === 'string')
                    ? el.className.split(/\s+/).filter(c => c && !c.startsWith('wte-') && !c.includes(':'))
                    : [];
                  if (cls.length > 0) return sel + '.' + cls.join('.');
                  if (el.id && !el.id.match(/[0-9]{3,}/) && !el.id.includes('aswift')) return sel + '#' + el.id;
                  if (el.parentElement) {
                    const siblings = Array.from(el.parentElement.children).filter(c => c.nodeName === el.nodeName);
                    if (siblings.length > 1) sel += ':nth-of-type(' + (siblings.indexOf(el) + 1) + ')';
                    return getRobustSelector(el.parentElement) + ' > ' + sel;
                  }
                  return sel;
                }
                const selector  = getRobustSelector(blockEl);
                const rawText   = getCleanText(blockEl);
                const snippet   = rawText.length <= 60
                  ? rawText
                  : rawText.substring(0, 30) + ' ... ' + rawText.substring(rawText.length - 25);
                const msg = JSON.stringify({ id, selector, text: snippet });
                console.log("WTE: Long press:", id);
                const lpNames = ['onBlockLongPressed', 'OnBlockLongPressed'];
                let sent = false;
                for (const name of lpNames) {
                  if (!sent && typeof window[name] !== 'undefined' && window[name].postMessage) {
                    window[name].postMessage(msg); sent = true;
                  }
                  if (!sent && window.webkit?.messageHandlers?.[name]) {
                    window.webkit.messageHandlers[name].postMessage(msg); sent = true;
                  }
                }
              } catch(err) { console.warn("WTE: Long press handler error:", err); }
            }, 600);
          }

          function wteTouchMove(e) {
            if (!wtePressTimer) return;
            const cx = e.touches?.length > 0 ? e.touches[0].clientX : e.clientX;
            const cy = e.touches?.length > 0 ? e.touches[0].clientY : e.clientY;
            if (wteTouchStartPos) {
              const dx = cx - wteTouchStartPos.x;
              const dy = cy - wteTouchStartPos.y;
              if (Math.sqrt(dx * dx + dy * dy) > WTE_MOVE_THRESHOLD) {
                clearTimeout(wtePressTimer);
                wtePressTimer = null;
                wteTouchStartPos = null;
                if (wteTempElement) {
                  if (wteTempElement.getAttribute('data-wte-id')?.startsWith('wte-temp-')) {
                    wteTempElement.removeAttribute('data-wte-id');
                  }
                  wteTempElement = null;
                }
              }
            }
          }

          // click end
          function wteTouchEnd() {
            if (wtePressTimer) {
              clearTimeout(wtePressTimer);
              wtePressTimer = null;
              if (wteTempElement) {
                if (wteTempElement.getAttribute('data-wte-id')?.startsWith('wte-temp-')) {
                  wteTempElement.removeAttribute('data-wte-id');
                }
                wteTempElement = null;
              }
            }
            wteTouchStartPos = null;
          }

          function globalClickHandler(e) {
            e.preventDefault();
            e.stopPropagation();

            let blockEl = e.target.closest('[data-wte-id]');
            if (!blockEl) return;
            while (blockEl && blockEl.getAttribute('data-wte-id') === 'wte-child') {
              blockEl = blockEl.parentElement
                ? blockEl.parentElement.closest('[data-wte-id]')
                : null;
            }
            if (!blockEl) return;

            const block = allBlocks.find(b => b.id === blockEl.getAttribute('data-wte-id'));
            if (!block) return;

            block.selected = !block.selected;
            if (block.selected && window.wteUpdateRangeSelection) {
              window.wteUpdateRangeSelection();
            }
            blockEl.classList.toggle('wte-deselected', !block.selected);
            console.log("WTE: Block toggled:", block.id, "→", block.selected);
            notifyFlutter();
          }

          window.wteGlobalClickHandler = globalClickHandler;
          window.wteTouchStart = wteTouchStart;
          window.wteTouchMove  = wteTouchMove;
          window.wteTouchEnd   = wteTouchEnd;

          document.addEventListener('click',       window.wteGlobalClickHandler, true);
          document.addEventListener('mousedown',   window.wteTouchStart, true);
          document.addEventListener('mouseup',     window.wteTouchEnd,   true);
          document.addEventListener('touchstart',  window.wteTouchStart, { capture: true, passive: false });
          document.addEventListener('touchend',    window.wteTouchEnd,   true);
          document.addEventListener('touchmove',   window.wteTouchMove,  { capture: true, passive: true });
          document.addEventListener('touchcancel', window.wteTouchEnd,   true);

          window.wteContextMenuHandler = function(e) {
            e.preventDefault();
          };
          document.addEventListener('contextmenu', window.wteContextMenuHandler, true);

          window.wteToggleAll = function(selectAll) {
            allBlocks.forEach(block => {
              block.selected = selectAll;
              block.element.classList.toggle('wte-deselected', !selectAll);
            });
            notifyFlutter();
          };

          // SPA readers may rewrite their article HTML on scroll. Restore bindings
          // to matching replacement nodes without re-extracting or resetting choices.
          const extractionUrl = window.location.href;
          const boundElements = new WeakMap();
          allBlocks.forEach(block => boundElements.set(block.element, block));
          let observingBlocks = true;
          const observeBlocks = () => blockObserver.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class', 'data-wte-id'],
          });
          const blockObserver = new MutationObserver(records => {
            if (!observingBlocks) return;
            if (window.location.href !== extractionUrl) {
              window.wteStopBlockObserver();
              return;
            }
            const changedElements = new Set();
            let childrenChanged = false;
            for (const record of records) {
              if (record.type === 'childList') childrenChanged = true;
              else if (boundElements.has(record.target)) changedElements.add(record.target);
            }
            if (!childrenChanged && changedElements.size === 0) return;

            // Our attribute writes must not trigger an observer feedback loop.
            blockObserver.disconnect();
            try {
              const repairs = [];
              // removeBlockScript may have removed entries since extraction.
              for (const block of window.wteBlocks || []) {
                let el = block.element;
                if (!el.isConnected) {
                  if (!childrenChanged) continue;
                  const replacement = resolveBlockPath(block.domPath);
                  if (!replacement || replacement.tagName !== el.tagName ||
                      replacement.closest(interactiveSelector) ||
                      getCleanText(replacement) !== block.text) continue;
                  const existingId = replacement.getAttribute('data-wte-id');
                  if (existingId && existingId !== block.id) continue;
                  boundElements.delete(el);
                  el = replacement;
                  block.element = el;
                  block.domPath = captureBlockPath(el);
                  boundElements.set(el, block);
                } else if (!changedElements.has(el)) {
                  continue;
                }
                repairs.push(block);
              }
              // Finish text/layout reads before changing highlight styles.
              for (const block of repairs) {
                const el = block.element;
                if (el.getAttribute('data-wte-id') !== block.id) el.setAttribute('data-wte-id', block.id);
                el.classList.add('wte-highlight');
                el.classList.toggle('wte-deselected', !block.selected);
              }
            } finally {
              if (observingBlocks) observeBlocks();
            }
          });
          window.wteStopBlockObserver = () => {
            observingBlocks = false;
            blockObserver.disconnect();
          };
          observeBlocks();

          const result = {
            title:  chapterTitle(context) || document.title || '',
            url:    window.location.href,
            blocks: allBlocks.map(b => ({
              id:       b.id,
              text:     b.text,
              type:     b.type,
              score:    b.score,
              selected: b.selected,
            })),
          };

          console.log("WTE: Extraction complete.");

          notifyFlutter();

          return JSON.stringify(result);
        } // end runExtraction()

        // ── [FIX 1] MutationObserver retry loop ─────────────────────────────────────
        // If the page body is too sparse (SPA not rendered yet), install an observer
        // that waits for DOM mutations to stop for 800 ms (or 5 s max), then runs.
        const MAX_WAIT_MS   = 5000;
        const STABLE_MS     = 800;

        const immediateResult = runExtraction();
        if (immediateResult === false) {
          console.log("WTE: DOM not ready — installing MutationObserver");
          const startTime = Date.now();

          window._wteObserver = new MutationObserver(() => {
            clearTimeout(window.wteExtractionTimer);
            const elapsed = Date.now() - startTime;
            const wait = elapsed > MAX_WAIT_MS ? 0 : STABLE_MS;
            window.wteExtractionTimer = setTimeout(() => {
              delete window.wteExtractionTimer;
              if (window._wteObserver) { window._wteObserver.disconnect(); delete window._wteObserver; }
              const r = runExtraction();
              if (r === false) {
                // Body still too sparse after timeout — run anyway without the guard.
                console.warn("WTE: Forced run after timeout");
                runExtraction();
              }
            }, wait);
          });

          window._wteObserver.observe(document.body, { childList: true, subtree: true, characterData: true });

          // Return a placeholder so Flutter's runJavaScriptReturningResult doesn't hang.
          return JSON.stringify({ title: document.title || '', url: window.location.href, blocks: [], pending: true });
        }

        return immediateResult;
      })();
    },
    getSelectedBlocks: function () {
      return (function() {
        if (window.wteBlocks) {
          return JSON.stringify(
            window.wteBlocks
              .filter(b => b.selected)
              .map(b => ({ id: b.id, text: b.text, type: b.type }))
          );
        }

        // Secondary fallback: return the last Flutter-channel payload if available.
        if (window.__wteLastUpdate) {
          return window.__wteLastUpdate;
        }

        // DOM fallback: infer selection state from CSS classes.
        // Exclude 'wte-child' entries (<li> markers) — not real blocks.
        const results = [];
        document.querySelectorAll('[data-wte-id]').forEach(el => {
          const id = el.getAttribute('data-wte-id');
          if (id === 'wte-child') return;
          if (el.classList.contains('wte-highlight') && !el.classList.contains('wte-deselected')) {
            // [FIX 2] Use clean text here too so <br> sites return correct content.
            const clone = el.cloneNode(true);
            clone.querySelectorAll('script, style, noscript').forEach(e => e.remove());

            function extractText(node) {
              if (node.nodeType === 3) {
                return node.nodeValue.replace(/\s+/g, ' ');
              }
              if (node.nodeType === 1) {
                const tag = node.tagName.toLowerCase();
                if (tag === 'br') return '\n';

                let text = '';
                for (const child of node.childNodes) {
                  text += extractText(child);
                }
                if (['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote', 'section'].includes(tag)) {
                  return '\n' + text + '\n';
                }
                return text;
              }
              return '';
            }

            const text = extractText(clone)
              .split('\n')
              .map(line => line.trim().replace(/ +/g, ' '))
              .join('\n')
              .replace(/\n{3,}/g, '\n\n')
              .trim();

            results.push({ id, text, type: el.tagName.toLowerCase() });
          }
        });
        return JSON.stringify(results);
      })();
    },
    cleanup: function () {
      return (function() {
        clearTimeout(window.wteExtractionTimer);
        delete window.wteExtractionTimer;
        if (window.wteStopBlockObserver) {
          window.wteStopBlockObserver();
          delete window.wteStopBlockObserver;
        }
        if (window._wteObserver) {
          window._wteObserver.disconnect();
          delete window._wteObserver;
        }
        if (window.wteGlobalClickHandler) {
          document.removeEventListener('click', window.wteGlobalClickHandler, true);
          delete window.wteGlobalClickHandler;
        }
        if (window.wteTouchStart) {
          document.removeEventListener('mousedown',   window.wteTouchStart, true);
          document.removeEventListener('mouseup',     window.wteTouchEnd,   true);
          document.removeEventListener('touchstart',  window.wteTouchStart, true);
          document.removeEventListener('touchend',    window.wteTouchEnd,   true);
          document.removeEventListener('touchmove',   window.wteTouchMove,  true);
          document.removeEventListener('touchcancel', window.wteTouchEnd,   true);
          delete window.wteTouchStart;
          delete window.wteTouchMove;
          delete window.wteTouchEnd;
        }
        if (window.wteContextMenuHandler) {
          document.removeEventListener('contextmenu', window.wteContextMenuHandler, true);
          delete window.wteContextMenuHandler;
        }
        delete window.wteToggleAll;
        delete window.wteBlocks;
        delete window.__wteLastUpdate;

        document.querySelectorAll('.wte-highlight').forEach(el => {
          el.classList.remove('wte-highlight', 'wte-deselected');
        });
        document.querySelectorAll('[data-wte-id]').forEach(el => {
          el.removeAttribute('data-wte-id');
        });

        const styles = document.getElementById('wte-styles');
        if (styles) styles.remove();
      })();
    },
    scrollToFirstHighlight: function () {
      return (function() {
        const first = document.querySelector('.wte-highlight');
        if (first) first.scrollIntoView({ behavior: 'smooth', block: 'center' });
      })();
    },
    setAutomationTemplate: function (blacklist, whitelist, removeSelectors = []) {
      return (function() {
        window.wteBlacklist = blacklist;
        window.wteWhitelist = whitelist;
        window.wteRemoveSelectors = removeSelectors;

        const debugLogs = [];
        debugLogs.push("Bắt đầu xử lý " + window.wteRemoveSelectors.length + " selectors");

        window.wteRemoveSelectors.forEach(selector => {
          try {
            if (selector.startsWith('TEXT:')) {
              const textToFind = selector.substring(5).trim();
              if (!textToFind) return;
              const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
              let node;
              const toRemove = [];
              while ((node = walker.nextNode())) {
                if (node.nodeValue.trim() === textToFind && node.parentElement) {
                  toRemove.push(node.parentElement);
                }
              }
              debugLogs.push('Tìm thấy ' + toRemove.length + ' phần tử chứa: ' + textToFind);
              toRemove.forEach(el => el.remove());
            } else {
              const els = document.querySelectorAll(selector);
              debugLogs.push('Tìm thấy ' + els.length + ' phần tử: ' + selector);
              els.forEach(el => el.remove());
            }
          } catch(e) {
            debugLogs.push('Lỗi: ' + selector + ' — ' + e);
          }
        });
        return JSON.stringify(debugLogs);
      })();
    },
    getTemplateDiff: function () {
      return (function() {
        if (!window.wteBlocks) return '{}';

        // Utility classes may contain '/', '[', '.', ':' or quotes. Match each
        // complete class token as a CSS string instead of treating it as syntax.
        const cssString = value => String(value).replace(/[\x00-\x1f\x7f"\\]/g,
          char => '\\' + char.charCodeAt(0).toString(16) + ' ');
        const ownSelector = el => {
          if (el.id && !el.id.match(/\d+/) && !el.id.includes('aswift')) {
            return '[id="' + cssString(el.id) + '"]';
          }
          const classes = Array.from(el.classList).filter(c => !c.startsWith('wte-'));
          return classes.length ? el.tagName.toLowerCase() + classes.map(c =>
            '[class~="' + cssString(c) + '"]').join('') : '';
        };
        const getSafeSelector = (el) => {
          const own = ownSelector(el);
          if (own) return own;
          if (el.parentElement) {
            const parentSel = ownSelector(el.parentElement);
            if (parentSel) return parentSel + ' > ' + el.tagName.toLowerCase();
          }
          return el.tagName.toLowerCase();
        };

        const selectedBlocks   = window.wteBlocks.filter(b =>  b.selected);
        const unselectedBlocks = window.wteBlocks.filter(b => !b.selected);
        const proposedBlacklist = new Set();
        const proposedWhitelist = new Set();

        window.wteBlocks.forEach(b => {
          if (b.selected === false && b.autoSelected === true) {
            const sel = getSafeSelector(b.element);
            if (sel) proposedBlacklist.add(sel);
          }
          if (b.selected === true && b.autoSelected === false) {
            const sel = getSafeSelector(b.element);
            if (sel) proposedWhitelist.add(sel);
          }
        });

        const finalBlacklist = [];
        const finalWhitelist = [];

        proposedBlacklist.forEach(sel => {
          const hitsSelected = selectedBlocks.some(b => { try { return b.element.matches(sel); } catch(e) { return false; } });
          if (!hitsSelected) finalBlacklist.push(sel);
        });

        proposedWhitelist.forEach(sel => {
          const hitsUnselected = unselectedBlocks.some(b => { try { return b.element.matches(sel); } catch(e) { return false; } });
          if (!hitsUnselected) finalWhitelist.push(sel);
        });

        return JSON.stringify({ blacklist: finalBlacklist, whitelist: finalWhitelist });
      })();
    },
    enableButtonPicker: function () {
      return (function() {
        if (window.wtePickerMode) return;
        window.wtePickerMode = true;

        const style = document.createElement('style');
        style.id = 'wte-picker-style';
        style.innerHTML = `
          .wte-picker-hover {
            outline: 3px solid #00B894 !important;
            outline-offset: -3px !important;
            cursor: crosshair !important;
            background-color: rgba(0, 184, 148, 0.1) !important;
          }
        `;
        document.head.appendChild(style);

        let currentHover = null;

        window.wtePickerMouseOver = function(e) {
          if (currentHover) currentHover.classList.remove('wte-picker-hover');
          currentHover = e.target;
          currentHover.classList.add('wte-picker-hover');
        };
        window.wtePickerMouseOut = function(e) {
          if (currentHover) currentHover.classList.remove('wte-picker-hover');
          currentHover = null;
        };
        window.wtePickerClick = function(e) {
          e.preventDefault();
          e.stopPropagation();
          const tapped = e.target.nodeType === 1 ? e.target : e.target.parentElement;
          if (!tapped) return;
          // A tap often lands on an SVG/path/span inside the actual navigation link.
          const el = tapped.closest('a[href], button, [role="button"], [role="link"], input[type="button"], input[type="submit"]') || tapped;
          const cssString = value => String(value).replace(/[\x00-\x1f\x7f"\\]/g,
            char => '\\' + char.charCodeAt(0).toString(16) + ' ');
          const attributeSelector = (node, name) => node.tagName.toLowerCase() +
            '[' + name + '="' + cssString(node.getAttribute(name)) + '"]';
          let pickedSelector = '';
          // Stable accessible labels avoid transient layout/hover/Tailwind classes.
          for (const name of ['aria-label', 'rel', 'title']) {
            if (!el.getAttribute(name) || /\d/.test(el.getAttribute(name))) continue;
            const candidate = attributeSelector(el, name);
            if (document.querySelectorAll(candidate).length === 1) {
              pickedSelector = candidate;
              break;
            }
          }
          let path = [], curr = el;
          while (!pickedSelector && curr && curr.nodeType === Node.ELEMENT_NODE && curr !== document.body) {
            let selector = curr.nodeName.toLowerCase();
            if (curr.id && !curr.id.match(/\d+/) && !curr.id.includes('aswift')) {
              selector = attributeSelector(curr, 'id');
              path.unshift(selector);
              break;
            }
            let sib = curr, nth = 1;
            while ((sib = sib.previousElementSibling)) {
              if (sib.nodeName.toLowerCase() === curr.nodeName.toLowerCase()) nth++;
            }
            selector += ':nth-of-type(' + nth + ')';
            path.unshift(selector);
            curr = curr.parentNode;
          }
          if (!pickedSelector && curr === document.body) path.unshift('body');
          const result = JSON.stringify({
            selector: pickedSelector || path.join(' > '),
            text: (el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText || el.textContent || el.value || '').trim().replace(/\s+/g, ' ').substring(0, 200),
          });
          const names = ['onNextButtonPicked', 'OnNextButtonPicked'];
          let sent = false;
          for (const name of names) {
            if (!sent && typeof window[name] !== 'undefined' && window[name].postMessage) {
              window[name].postMessage(result); sent = true;
            }
            if (!sent && window.webkit?.messageHandlers?.[name]) {
              window.webkit.messageHandlers[name].postMessage(result); sent = true;
            }
          }
        };

        document.addEventListener('mouseover', window.wtePickerMouseOver, true);
        document.addEventListener('mouseout',  window.wtePickerMouseOut,  true);
        document.addEventListener('click',     window.wtePickerClick,     true);
      })();
    },
    disableButtonPicker: function () {
      return (function() {
        if (!window.wtePickerMode) return;
        window.wtePickerMode = false;
        const style = document.getElementById('wte-picker-style');
        if (style) style.remove();
        document.querySelectorAll('.wte-picker-hover').forEach(el => el.classList.remove('wte-picker-hover'));
        document.removeEventListener('mouseover', window.wtePickerMouseOver, true);
        document.removeEventListener('mouseout',  window.wtePickerMouseOut,  true);
        document.removeEventListener('click',     window.wtePickerClick,     true);
        delete window.wtePickerMouseOver;
        delete window.wtePickerMouseOut;
        delete window.wtePickerClick;
      })();
    },
    clickNextButton: function (selectorArg, textArg = '') {
      return (function() {
        const selector = selectorArg;
        const savedText = textArg;
        const controls = 'a[href], button, [role="button"], [role="link"], input[type="button"], input[type="submit"]';
        const normalize = value => (value || '').trim().replace(/\s+/g, ' ').toLowerCase();
        const targetText = normalize(savedText);
        const asControl = el => el && (el.closest(controls) || el);
        const labels = el => [el.getAttribute('aria-label'), el.getAttribute('title'),
          el.innerText || el.textContent, el.value].map(normalize).filter(Boolean);
        const isMatch = (el, exact = false) => !targetText || labels(el).some(t =>
          t === targetText || (!exact && (t.includes(targetText) || targetText.includes(t))));
        const numberedText = /\d/.test(targetText);
        const sameNumberedLabel = el => numberedText && labels(el).some(t =>
          t.replace(/\d+/g, '#') === targetText.replace(/\d+/g, '#'));
        const isUsable = el => {
          if (!el || !el.isConnected || typeof el.click !== 'function' ||
              el.matches(':disabled, [disabled], [aria-disabled="true"]')) return false;
          for (let node = el; node; node = node.parentElement) {
            if (node.matches('[hidden], [inert], [aria-hidden="true"], [aria-disabled="true"]')) return false;
            const style = window.getComputedStyle(node);
            if (style.display === 'none' || style.visibility === 'hidden' ||
                style.visibility === 'collapse' || style.opacity === '0') return false;
          }
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };
        let invalidSavedSelector = false;
        const queryTargets = value => {
          try {
            return [...new Set(Array.from(document.querySelectorAll(value)).map(asControl))].filter(isUsable);
          } catch (_) {
            // Older picker versions saved unescaped CSS utility classes.
            if (value === selector) invalidSavedSelector = true;
            return [];
          }
        };
        const matches = queryTargets(selector);
        let target = targetText
          ? matches.find(el => isMatch(el, true)) || matches.find(el => isMatch(el))
          : (matches.length === 1 ? matches[0] : null);
        // "Chapter 834" becomes "Chapter 835". Only relax numbers at the saved
        // structural position; searching that old label globally can find Previous.
        if (!target && matches.length === 1 &&
            / > |:nth-of-type\(|#|\[/.test(selector) && sameNumberedLabel(matches[0])) {
          target = matches[0];
        }
        if (!target && targetText && !numberedText) {
          const candidates = queryTargets(controls + ', .btn, .next, .chapter-next');
          target = candidates.find(el => isMatch(el, true)) || candidates.find(el => isMatch(el));
        }
        if (!target && invalidSavedSelector && selector.includes(' > ')) {
          // Recover legacy icon paths by keeping their exact sibling positions and
          // ending at the owning control. Never guess the last of several matches.
          const parts = selector.split(' > ');
          let controlIndex = -1;
          for (let i = 0; i < parts.length; i++) {
            if (/^(a|button|input)(?=[.#:\[]|$)/i.test(parts[i])) controlIndex = i;
          }
          if (controlIndex >= 0) {
            const structural = parts.slice(0, controlIndex + 1).map(part => {
              const tag = part.match(/^[a-z][\w-]*/i);
              if (!tag) return null;
              const nth = part.match(/:nth-of-type\((\d+)\)/);
              return tag[0] + ':nth-of-type(' + (nth ? nth[1] : '1') + ')';
            });
            if (structural.every(Boolean)) {
              const candidates = queryTargets(structural.join(' > ')).filter(el => isMatch(el) || sameNumberedLabel(el));
              if (candidates.length === 1) target = candidates[0];
            }
          }
        }
        if (!target && !selector && !savedText) {
          const context = siteContext();
          const candidates = context.adapter.getNext
            ? context.adapter.getNext(context)
            : (context.adapter.nextSelectors || []).flatMap(value => queryTargets(value));
          const usable = [...new Set(candidates.map(asControl))].filter(isUsable);
          // Two unrelated forward destinations are ambiguous, never guess.
          if (usable.length === 1) target = usable[0];
          else if (usable.length > 1 && usable.every(el => el.tagName === 'A' && el.href === usable[0].href)) target = usable[0];
        }
        if (target) {
          // Native click handles router listeners and normal links without scrolling
          // first (which can cause a reader to replace the target's DOM).
          target.click();
          return "SUCCESS";
        }
        return "NOT_FOUND";
      })();
    },
    setBlockSelected: function (id, selected) {
      return (function() {
        const el = Array.from(document.querySelectorAll('[data-wte-id]')).find(node => node.getAttribute('data-wte-id') === id);
        if (el) el.classList.toggle('wte-deselected', !selected);
        if (window.wteBlocks) {
          const block = window.wteBlocks.find(b => b.id === id);
          if (block) block.selected = selected;
          if (selected && window.wteUpdateRangeSelection) {
            window.wteUpdateRangeSelection();
          }
        }
        if (window.__wteLastUpdate) delete window.__wteLastUpdate;
      })();
    },
    removeBlock: function (id) {
      return (function() {
        const el = Array.from(document.querySelectorAll('[data-wte-id]')).find(node => node.getAttribute('data-wte-id') === id);
        if (el) el.remove();
        if (window.wteBlocks) {
          window.wteBlocks = window.wteBlocks.filter(b => b.id !== id);
        }
      })();
    },
  };
})()
