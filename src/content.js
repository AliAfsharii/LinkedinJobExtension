// === LinkedIn VAS (Viewed/Applied/Saved) highlighter — no hiding, just border ===
(() => {
  if (window.__LVH_RUNNING__) return;
  window.__LVH_RUNNING__ = true;

  const STATE_RE = /\b(Viewed|Applied|Saved)\b/i;

  const CARD_SEL =
    'li[data-occludable-job-id], li.scaffold-layout__list-item, li.occludable-update';
  const FOOTER_SEL =
    '.job-card-container__footer-wrapper li, .job-card-container__footer-item, .job-card-container__footer-job-state';
  const INNER_CARD_SEL = '.job-card-container';

  // ----- Styles (inner border using a pseudo-element) -----
  (function ensureStyle() {
    let style = document.getElementById('lvh-style');
    if (!style) {
      style = document.createElement('style');
      style.id = 'lvh-style';
      document.head.appendChild(style);
    }
    style.textContent = `
      .lvh-flagged-card {
        /* Add space so the inner border doesn't sit under neighbors */
        padding: 10px !important;
        border-radius: 10px !important;
        position: relative !important;
        z-index: 0 !important;
      }
      .lvh-flagged-card::after {
        content: "";
        position: absolute;
        /* Pull the border further INSIDE the card */
        inset: 6px;
        border: 2px solid red;
        border-radius: 8px;
        pointer-events: none;
        z-index: 1;
      }
    `;
  })();

  // ----- Helpers -----
  const getInnerCard = (li) => (li ? li.querySelector(INNER_CARD_SEL) || li : null);

  function hasVAS(li) {
    const footerItems = li.querySelectorAll(FOOTER_SEL);
    for (const f of footerItems) {
      const txt = (f.textContent || '').trim();
      if (STATE_RE.test(txt)) return true;
    }
    return false;
  }

  function applyHighlight(li) {
    const inner = getInnerCard(li);
    if (!inner) return;
    if (hasVAS(li)) inner.classList.add('lvh-flagged-card');
    else inner.classList.remove('lvh-flagged-card');
  }

  function scan(root = document) {
    const cards = root.querySelectorAll(CARD_SEL);
    cards.forEach((li) => applyHighlight(li));
  }

  // Debounced rescans
  let scanTimer = null;
  function scheduleScan(delay = 120) {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scan();
    }, delay);
  }

  // Initial pass
  scan();

  // Observe DOM changes
  const mo = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'childList') {
        for (const n of m.addedNodes) {
          if (!(n instanceof Element)) continue;
          if (
            n.matches?.(CARD_SEL) ||
            n.querySelector?.(CARD_SEL) ||
            n.matches?.(FOOTER_SEL) ||
            n.querySelector?.(FOOTER_SEL) ||
            n.matches?.('.job-card-container') ||
            n.querySelector?.('.job-card-container')
          ) {
            scheduleScan();
            return;
          }
        }
      } else if (m.type === 'characterData') {
        const p = m.target.parentElement;
        if (p && (p.matches(FOOTER_SEL) || p.closest(FOOTER_SEL))) {
          scheduleScan();
          return;
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
      scheduleScan(200);
      return r;
    };
  });
  window.addEventListener('popstate', () => scheduleScan(200));

  window.addEventListener('beforeunload', () => {
    try { mo.disconnect(); } catch {}
  });
})();
