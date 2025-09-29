// === Linkedin Job Helper: title coloring (VAS fallback) + click-to-send details + sticky verdicts ===
(() => {
  if (window.__LVH_RUNNING__) return;
  window.__LVH_RUNNING__ = true;

  // ----------------- Constants & selectors -----------------
  const STATE_RE = /\b(Viewed|Applied|Saved)\b/i; // detect V/A/S in footer text
  const CARD_SEL =
    'li[data-occludable-job-id], li.scaffold-layout__list-item, li.occludable-update';
  const FOOTER_SEL =
    '.job-card-container__footer-wrapper li, .job-card-container__footer-item, .job-card-container__footer-job-state';
  const INNER_CARD_SEL = '.job-card-container';
  const TITLE_SEL = 'a.job-card-container__link, a[href*="/jobs/view/"]';

  // Job details pane (right side) container; LinkedIn classes are quite stable around these:
  const DETAILS_ROOT_SEL =
    '.jobs-description.job-details-module, .jobs-box--full-width.job-details-module';
  const DETAILS_HTML_SEL = '#job-details, .jobs-description__content';

  // ----------------- User-configured settings -----------------
  // In Options page, user sets:
  //  - apiUrl       : endpoint that accepts POST of job details and returns { suitable: true/false }
  //  - apiKey       : optional Bearer token
  let SETTINGS = { apiUrl: '', apiKey: '' };
  chrome.storage.sync.get(['apiUrl', 'apiKey']).then((v) => {
    SETTINGS = { apiUrl: v.apiUrl || '', apiKey: v.apiKey || '' };
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    if (changes.apiUrl) SETTINGS.apiUrl = changes.apiUrl.newValue || '';
    if (changes.apiKey) SETTINGS.apiKey = changes.apiKey.newValue || '';
  });

  // ----------------- Styles (title coloring) -----------------
  (function ensureStyle() {
    if (document.getElementById('lvh-style')) return;
    const style = document.createElement('style');
    style.id = 'lvh-style';
    style.textContent = `
      .lvh-title-red   { color: #d32f2f !important; }
      .lvh-title-green { color: #2e7d32 !important; }
    `;
    document.head.appendChild(style);
  })();

  // ----------------- Verdict cache (sticky across refresh) -----------------
  // We persist a small { [jobId]: true|false } map in chrome.storage.local
  let VERDICT_CACHE = Object.create(null);
  let verdictWriteTimer = null;

  chrome.storage.local.get(['lvh_verdicts']).then((v) => {
    if (v && v.lvh_verdicts && typeof v.lvh_verdicts === 'object') {
      VERDICT_CACHE = { ...v.lvh_verdicts };
      // Paint what's in the DOM now using cached verdicts
      scan();
    }
  });

  function scheduleVerdictPersist() {
    if (verdictWriteTimer) return;
    verdictWriteTimer = setTimeout(() => {
      verdictWriteTimer = null;
      chrome.storage.local.set({ lvh_verdicts: VERDICT_CACHE }).catch(() => {});
    }, 500);
  }

  // ----------------- Helpers -----------------
  const getCardLI = (el) => el.closest?.(CARD_SEL) || null;
  const getInnerCard = (li) => li.querySelector(INNER_CARD_SEL) || li;
  const getTitleEl = (li) => getInnerCard(li).querySelector(TITLE_SEL);

  function getJobId(el) {
    const li = getCardLI(el) || el.closest?.(CARD_SEL) || el;
    const inner = li?.querySelector?.(INNER_CARD_SEL) || li;
    return (
      inner?.getAttribute?.('data-job-id') ||
      li?.getAttribute?.('data-occludable-job-id') ||
      ''
    );
  }

  function vasState(li) {
    // Look at footer items for View/Applied/Saved
    const footerItems = li.querySelectorAll(FOOTER_SEL);
    let viewed = false,
      applied = false,
      saved = false;
    for (const f of footerItems) {
      const txt = (f.textContent || '').trim();
      if (/Viewed/i.test(txt)) viewed = true;
      if (/Applied/i.test(txt)) applied = true;
      if (/Saved/i.test(txt)) saved = true;
    }
    return { viewed, applied, saved };
  }

  function paintTitle(li) {
    const id = getJobId(li);
    if (!id) return;

    const titleEl = getTitleEl(li);
    if (!titleEl) return;

    titleEl.classList.remove('lvh-title-red', 'lvh-title-green');

    const verdictKnown = Object.prototype.hasOwnProperty.call(VERDICT_CACHE, id);
    const verdict = VERDICT_CACHE[id];

    if (verdictKnown) {
      if (verdict === true) {
        titleEl.classList.add('lvh-title-green');
      } else if (verdict === false) {
        titleEl.classList.add('lvh-title-red');
      }
    } else {
      // No verdict yet → fallback to VAS coloring (any of V/A/S = red)
      const { viewed, applied, saved } = vasState(li);
      if (viewed || applied || saved) {
        titleEl.classList.add('lvh-title-red');
      }
    }
  }

  function scan(root = document) {
    const cards = root.querySelectorAll(CARD_SEL);
    cards.forEach((li) => {
      paintTitle(li);
    });
  }

  // ----------------- Details capture & send (on click) -----------------
  // Rule per user: send details for clicked jobs EXCEPT when Applied or Saved (Viewed is allowed).
  let inFlightById = new Map(); // jobId -> true while sending
  let lastSentId = null;

  // When a card is clicked, LinkedIn marks it active and loads/updates the details pane.
  // We'll observe the details pane and when it has content, send it once per jobId.
  function extractRightPaneHtml() {
    const root =
      document.querySelector(DETAILS_ROOT_SEL) ||
      document.querySelector('.jobs-description');
    if (!root) return { html: '', text: '' };

    const target =
      root.querySelector(DETAILS_HTML_SEL) ||
      root.querySelector('.jobs-description__content') ||
      root;

    // Grab full innerHTML for fidelity, plus a text alternative
    const html = target?.innerHTML?.trim() || '';
    const text = target?.innerText?.trim() || '';
    return { html, text };
  }

  function extractBasicFromCard(li) {
    const inner = getInnerCard(li);
    const id =
      inner.getAttribute('data-job-id') ||
      li.getAttribute('data-occludable-job-id') ||
      '';
    const titleA = inner.querySelector(TITLE_SEL);
    const title = titleA?.textContent?.trim() || '';
    const link = titleA?.href || '';
    const company =
      inner.querySelector(
        '.artdeco-entity-lockup__subtitle, [class*="entity-lockup__subtitle"]'
      )?.textContent?.trim() || '';
    const location =
      inner.querySelector(
        '.job-card-container__metadata-wrapper li, [class*="metadata-wrapper"] li'
      )?.textContent?.trim() || '';
    return { id, title, link, company, location };
  }

  function findActiveCard() {
    // Active marker lives on container inside the LI
    const activeContainer = document.querySelector(
      '.jobs-search-results-list__list-item--active, [aria-current="page"]'
    );
    if (!activeContainer) return null;
    return getCardLI(activeContainer) || activeContainer.closest?.(CARD_SEL) || null;
  }

  async function sendDetailsForActive() {
    if (!SETTINGS.apiUrl || !/^https?:\/\//i.test(SETTINGS.apiUrl)) return;

    const li = findActiveCard();
    if (!li) return;

    const { applied, saved } = vasState(li);
    // Skip if Applied or Saved; send even if Viewed
    if (applied || saved) return;

    const base = extractBasicFromCard(li);
    if (!base.id) return;

    // De-dupe: avoid re-sending same job while details are visible
    if (lastSentId === base.id || inFlightById.get(base.id)) return;

    const details = extractRightPaneHtml();
    if (!details.html && !details.text) {
      // No content yet; will be retried by observer updates
      return;
    }

    inFlightById.set(base.id, true);

    try {
      const payload = {
        id: base.id,
        title: base.title,
        company: base.company,
        location: base.location,
        link: base.link,
        detailsHtml: details.html,
        detailsText: details.text
      };

      const res = await fetch(SETTINGS.apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(SETTINGS.apiKey ? { Authorization: `Bearer ${SETTINGS.apiKey}` } : {})
        },
        body: JSON.stringify(payload)
      });

      // Expecting { suitable: true|false } optionally
      let verdictResp = null;
      try {
        verdictResp = await res.json();
      } catch (_) {
        verdictResp = null;
      }

      if (verdictResp && typeof verdictResp.suitable === 'boolean') {
        VERDICT_CACHE[base.id] = verdictResp.suitable;
        scheduleVerdictPersist();
        // Paint immediately
        paintTitle(li);
      }

      lastSentId = base.id;
    } catch (_) {
      // Silent fail; allow future retries when DOM changes
    } finally {
      inFlightById.delete(base.id);
    }
  }

  // ----------------- Observers & event hooks -----------------
  // 1) Observe list area to paint titles (and repaint when VAS footer appears)
  const listObserver = new MutationObserver((muts) => {
    let needsScan = false;
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (!(n instanceof Element)) continue;
        if (
          n.matches?.(CARD_SEL) ||
          n.querySelector?.(CARD_SEL) ||
          n.matches?.(FOOTER_SEL) ||
          n.querySelector?.(FOOTER_SEL)
        ) {
          needsScan = true;
          break;
        }
      }
      if (needsScan) break;
    }
    if (needsScan) scan();
  });

  // 2) Observe details pane to know when content is loaded/changed after a click
  const detailsObserver = new MutationObserver(() => {
    // Debounce a tiny bit to let LinkedIn finish DOM updates
    if (detailsObserver._timer) clearTimeout(detailsObserver._timer);
    detailsObserver._timer = setTimeout(() => {
      detailsObserver._timer = null;
      sendDetailsForActive();
    }, 150);
  });

  function attachObservers() {
    listObserver.observe(document.documentElement, {
      childList: true,
      subtree: true
    });

    // Attach a dedicated observer to the details root if present
    const detailsRoot =
      document.querySelector(DETAILS_ROOT_SEL) ||
      document.querySelector('.jobs-description');
    if (detailsRoot) {
      detailsObserver.observe(detailsRoot, {
        childList: true,
        subtree: true
      });
    } else {
      // Fallback: observe the whole doc; sendDetailsForActive will guard
      detailsObserver.observe(document.documentElement, {
        childList: true,
        subtree: true
      });
    }
  }

  // Intercept SPA navigations to repaint & rewire observers
  ['pushState', 'replaceState'].forEach((fn) => {
    const orig = history[fn];
    history[fn] = function (...args) {
      const r = orig.apply(this, args);
      setTimeout(() => {
        scan();
        sendDetailsForActive();
      }, 200);
      return r;
    };
  });
  window.addEventListener('popstate', () => {
    setTimeout(() => {
      scan();
      sendDetailsForActive();
    }, 200);
  });

  // Click handler: when the user clicks a job card, attempt a send after the pane updates
  document.addEventListener(
    'click',
    (e) => {
      const li = getCardLI(e.target);
      if (!li) return;
      // Wait a bit for LinkedIn to update the details pane, then try to send
      setTimeout(sendDetailsForActive, 250);
    },
    true
  );

  // ----------------- Init -----------------
  scan();
  attachObservers();

  // Periodic light repaint to catch any missed cards
  const repaintId = setInterval(scan, 3000);

  window.addEventListener('beforeunload', () => {
    try {
      listObserver.disconnect();
    } catch {}
    try {
      detailsObserver.disconnect();
    } catch {}
    try {
      clearInterval(repaintId);
    } catch {}
  });
})();
