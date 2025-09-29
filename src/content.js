// Hide job list items whose footer shows "Viewed" or "Applied",
// EXCEPT the currently selected/active card.
const STATE_RE = /\b(Viewed|Applied|Saved)\b/i;

// A job card <li>
const CARD_SEL = 'li[data-occludable-job-id], li.scaffold-layout__list-item, li.occludable-update';
// Footer bits that may contain the state text
const FOOTER_SEL = '.job-card-container__footer-wrapper li, .job-card-container__footer-item, .job-card-container__footer-job-state';
// Active marker lives inside the card container when selected
const ACTIVE_SEL = '.jobs-search-results-list__list-item--active, [aria-current="page"]';

function cardRoot(el) {
  return el.closest(CARD_SEL);
}

function isActive(li) {
  return !!li.querySelector(ACTIVE_SEL);
}

function hasHiddenState(li) {
  const footerItems = li.querySelectorAll(FOOTER_SEL);
  for (const f of footerItems) {
    const txt = (f.textContent || '').trim();
    if (STATE_RE.test(txt)) return true;
  }
  return false;
}

function applyVisibility(li) {
  // Never hide the currently selected/active card
  if (isActive(li)) {
    li.style.display = '';
    li.__lvh_hidden = false;
    return;
  }
  if (hasHiddenState(li)) {
    li.style.display = 'none';
    li.__lvh_hidden = true;
  } else {
    li.style.display = '';
    li.__lvh_hidden = false;
  }
}

function scan(root = document) {
  const cards = root.querySelectorAll(CARD_SEL);
  cards.forEach(li => {
    if (!li.__lvh_bound) {
      li.__lvh_bound = true;
    }
    applyVisibility(li);
  });
}

// Initial pass
scan();

// Observe dynamic loads & text changes
const mo = new MutationObserver(muts => {
  for (const m of muts) {
    // Attribute changes (e.g., active class toggled)
    if (m.type === 'attributes') {
      const li = cardRoot(m.target);
      if (li) applyVisibility(li);
      continue;
    }

    // New nodes
    for (const n of m.addedNodes) {
      if (!(n instanceof Element)) continue;

      // If a footer item with "Viewed/Applied" appears, (re)apply on its card
      if (n.matches?.(FOOTER_SEL) && STATE_RE.test((n.textContent || '').trim())) {
        const li = cardRoot(n);
        if (li) applyVisibility(li);
        continue;
      }

      // If an active marker appears inside a card, (re)apply
      if (n.matches?.(ACTIVE_SEL) || n.querySelector?.(ACTIVE_SEL)) {
        const li = cardRoot(n) || n.closest?.(CARD_SEL);
        if (li) applyVisibility(li);
      }

      // If subtree may contain cards, scan it
      if (
        n.matches?.(CARD_SEL) ||
        n.querySelector?.(CARD_SEL) ||
        n.matches?.('.job-card-container') ||
        n.querySelector?.('.job-card-container')
      ) {
        scan(n);
      }
    }
  }
});
mo.observe(document.documentElement, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['class', 'aria-current']
});

// Re-scan on SPA route changes + periodic safety net
['pushState', 'replaceState'].forEach(fn => {
  const orig = history[fn];
  history[fn] = function (...args) {
    const r = orig.apply(this, args);
    setTimeout(scan, 400);
    return r;
  };
});
window.addEventListener('popstate', () => setTimeout(scan, 400));
setInterval(() => scan(), 3000);

// Optional console helper
// window.__lvh_force = () => scan();
