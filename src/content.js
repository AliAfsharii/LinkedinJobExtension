// === LinkedIn VAS (Viewed/Applied/Saved) highlighter – no hiding, no selection logic ===
(() => {
  if (window.__LVH_RUNNING__) return;
  window.__LVH_RUNNING__ = true;

  const STATE_RE = /\b(Viewed|Applied|Saved)\b/i;

  // A job card <li>
  const CARD_SEL =
    'li[data-occludable-job-id], li.scaffold-layout__list-item, li.occludable-update';
  // Footer bits that may contain the state text
  const FOOTER_SEL =
    '.job-card-container__footer-wrapper li, .job-card-container__footer-item, .job-card-container__footer-job-state';
  // Inner visual container to draw the outline on
  const INNER_CARD_SEL = '.job-card-container';

  // ----- Styles (uniform red outline on all sides) -----
  (function ensureStyle() {
    if (document.getElementById('lvh-style')) return;
    const style = document.createElement('style');
    style.id = 'lvh-style';
    style.textContent = `
      .lvh-flagged-card {
        outline: 2px solid red !important;
        outline-offset: 0 !important;
        border-left: 0 !important; /* neutralize LinkedIn's left rule */
      }
    `;
    document.head.appendChild(style);
  })();

  const getInnerCard = (li) => li.querySelector(INNER_CARD_SEL) || li;

  function hasVAS(li) {
    const footerItems = li.querySelectorAll(FOOTER_SEL);
    for (const f of footerItems) {
      const txt = (f.textContent || '').trim();
      if (STATE_RE.test(txt)) return true;
    }
    return false;
  }

  function apply(li) {
    const inner = getInnerCard(li);
    if (!inner) return;
    if (hasVAS(li)) {
      inner.classList.add('lvh-flagged-card');
    } else {
      inner.classList.remove('lvh-flagged-card');
    }
  }

  function scan(root = document) {
    root.querySelectorAll(CARD_SEL).forEach(apply);
  }

  // Debounced rescans to avoid thrashing
  let t = null;
  const scheduleScan = () => {
    if (t) return;
    t = setTimeout(() => {
      t = null;
      scan();
    }, 200);
  };

  // Initial pass
  scan();

  // Observe DOM additions/changes; do not watch attributes to avoid loops on selection changes
  const mo = new MutationObserver((muts) => {
    for (const m of muts) {
      // New nodes or footer text changes can affect VAS state
      if (m.type === 'childList') {
        for (const n of m.addedNodes) {
          if (!(n instanceof Element)) continue;
          if (
            n.matches?.(CARD_SEL) ||
            n.querySelector?.(CARD_SEL) ||
            n.matches?.(FOOTER_SEL) ||
            n.querySelector?.(FOOTER_SEL)
          ) {
            scheduleScan();
            break;
          }
        }
      } else if (m.type === 'characterData') {
        // Footer text updated
        if (m.target?.parentElement?.matches?.(FOOTER_SEL)) {
          scheduleScan();
        }
      }
    }
  });
  mo.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true
  });

  // Re-scan on SPA route changes
  ['pushState', 'replaceState'].forEach((fn) => {
    const orig = history[fn];
    history[fn] = function (...args) {
      const r = orig.apply(this, args);
      scheduleScan();
      return r;
    };
  });
  window.addEventListener('popstate', scheduleScan);

  // Light periodic safety net
  const intervalId = setInterval(scan, 3000);

  // Cleanup on unload
  window.addEventListener('beforeunload', () => {
    try { mo.disconnect(); } catch {}
    try { clearInterval(intervalId); } catch {}
  });
})();
