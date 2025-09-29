// === LinkedIn VAS (Viewed/Applied/Saved) highlighter – never hide ===
(() => {
  if (window.__LVH_RUNNING__) return;
  window.__LVH_RUNNING__ = true;

  const STATE_RE = /\b(Viewed|Applied|Saved)\b/i;

  const CARD_SEL =
    'li[data-occludable-job-id], li.scaffold-layout__list-item, li.occludable-update';
  const FOOTER_SEL =
    '.job-card-container__footer-wrapper li, .job-card-container__footer-item, .job-card-container__footer-job-state';
  const INNER_CARD_SEL = '.job-card-container';

  // ----- Styles -----
  (function ensureStyle() {
    if (document.getElementById('lvh-style')) return;
    const style = document.createElement('style');
    style.id = 'lvh-style';
    style.textContent = `
      /* Force show any card we mark, even if inline styles try to hide it */
      li[data-occludable-job-id].lvh-force-show,
      li.scaffold-layout__list-item.lvh-force-show,
      li.occludable-update.lvh-force-show {
        display: block !important;
        visibility: visible !important;
        opacity: 1 !important;
      }

      /* Full, even border on all sides using outline (not clipped by overflow) */
      .lvh-flagged-card {
        outline: 2px solid red !important;
        outline-offset: 0 !important;
        border-radius: 8px !important;
      }
    `;
    document.head.appendChild(style);
  })();

  // ----- Helpers -----
  const getCardLI = (el) => el.closest?.(CARD_SEL) || null;
  const getInnerCard = (li) => li.querySelector(INNER_CARD_SEL) || li;

  function hasFlagState(li) {
    const footerItems = li.querySelectorAll(FOOTER_SEL);
    for (const f of footerItems) {
      const txt = (f.textContent || '').trim();
      if (STATE_RE.test(txt)) return true;
    }
    return false;
  }

  function cleanseHiding(li) {
    // Remove common hiding mechanisms, but rely on CSS class to enforce visibility
    if (li.hasAttribute('hidden')) li.removeAttribute('hidden');
    li.style.removeProperty?.('display');
    li.style.removeProperty?.('visibility');
    li.style.removeProperty?.('opacity');
  }

  function applyHighlight(li) {
    const flagged = hasFlagState(li);
    const inner = getInnerCard(li);

    if (flagged) {
      // Make sure it's visible regardless of other scripts
      if (!li.classList.contains('lvh-force-show')) li.classList.add('lvh-force-show');
      cleanseHiding(li);

      if (!inner.classList.contains('lvh-flagged-card')) {
        inner.classList.add('lvh-flagged-card');
      }
    } else {
      // Remove our markers if state disappears
      if (li.classList.contains('lvh-force-show')) li.classList.remove('lvh-force-show');
      if (inner.classList.contains('lvh-flagged-card')) inner.classList.remove('lvh-flagged-card');
    }
  }

  function scan(root = document) {
    const cards = root.querySelectorAll(CARD_SEL);
    cards.forEach((li) => applyHighlight(li));
  }

  // Debounced rescans to avoid thrashing
  let scanPending = false;
  function scheduleScan(target) {
    if (scanPending) return;
    scanPending = true;
    setTimeout(() => {
      scanPending = false;
      scan(target || document);
    }, 120);
  }

  // Initial pass + unhide anything old scripts hid
  (function initial() {
    document.querySelectorAll(CARD_SEL).forEach((li) => cleanseHiding(li));
    scan();
  })();

  // Observe DOM additions only (no attribute watching to avoid loops)
  const mo = new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (!(n instanceof Element)) continue;
        if (
          n.matches?.(CARD_SEL) ||
          n.querySelector?.(CARD_SEL) ||
          n.matches?.('.job-card-container') ||
          n.querySelector?.('.job-card-container') ||
          n.matches?.(FOOTER_SEL) ||
          n.querySelector?.(FOOTER_SEL)
        ) {
          scheduleScan();
          return;
        }
      }
    }
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });

  // Re-scan on SPA route changes
  ['pushState', 'replaceState'].forEach((fn) => {
    const orig = history[fn];
    history[fn] = function (...args) {
      const r = orig.apply(this, args);
      scheduleScan();
      return r;
    };
  });
  window.addEventListener('popstate', () => scheduleScan());

  // Periodic safety net (lightweight)
  const intervalId = setInterval(() => scan(), 3000);

  // Cleanup on reload/navigation
  window.addEventListener('beforeunload', () => {
    try { mo.disconnect(); } catch {}
    try { clearInterval(intervalId); } catch {}
  });
})();
