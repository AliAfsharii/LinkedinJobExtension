// === Linkedin Job Helper: title coloring (VAS fallback) + click-to-send details with templated payload + sticky verdicts ===
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

  const DETAILS_ROOT_SEL =
    '.jobs-description.job-details-module, .jobs-box--full-width.job-details-module';
  const DETAILS_HTML_SEL = '#job-details, .jobs-description__content';

  // ----------------- Settings -----------------
  let SETTINGS = { apiUrl: '', apiKey: '', requestPayload: '' };
  chrome.storage.sync.get(['apiUrl', 'apiKey', 'requestPayload']).then((v) => {
    SETTINGS = {
      apiUrl: v.apiUrl || '',
      apiKey: v.apiKey || '',
      requestPayload: v.requestPayload || ''
    };
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    if (changes.apiUrl) SETTINGS.apiUrl = changes.apiUrl.newValue || '';
    if (changes.apiKey) SETTINGS.apiKey = changes.apiKey.newValue || '';
    if (changes.requestPayload) SETTINGS.requestPayload = changes.requestPayload.newValue || '';
  });

  // ----------------- Styles -----------------
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
  let VERDICT_CACHE = Object.create(null);
  let verdictWriteTimer = null;

  chrome.storage.local.get(['lvh_verdicts']).then((v) => {
    if (v && v.lvh_verdicts && typeof v.lvh_verdicts === 'object') {
      VERDICT_CACHE = { ...v.lvh_verdicts };
      scan();
    }
  });

  function scheduleVerdictPersist() {
    if (verdictWriteTimer) return;
    verdictWriteTimer = setTimeout(() => {
      verdictWriteTimer = null;
      chrome.storage.local.set({ lvh_verdicts: VERDICT_CACHE }).catch(() => {});
    }, 400);
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
    const footerItems = li.querySelectorAll(FOOTER_SEL);
    let viewed = false, applied = false, saved = false;
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
      titleEl.classList.add(verdict === true ? 'lvh-title-green' : 'lvh-title-red');
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
    cards.forEach((li) => paintTitle(li));
  }

  // ----------------- Details capture & send (on click) -----------------
  let inFlightById = new Map(); // jobId -> true while sending
  let lastSentId = null;

  function extractRightPaneHtml() {
    const root =
      document.querySelector(DETAILS_ROOT_SEL) ||
      document.querySelector('.jobs-description');
    if (!root) return { html: '', text: '' };

    const target =
      root.querySelector(DETAILS_HTML_SEL) ||
      root.querySelector('.jobs-description__content') ||
      root;

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
    const activeContainer = document.querySelector(
      '.jobs-search-results-list__list-item--active, [aria-current="page"]'
    );
    if (!activeContainer) return null;
    return getCardLI(activeContainer) || activeContainer.closest?.(CARD_SEL) || null;
  }

  function tryInjectUserContent(payloadObj, text) {
    // Replace the "content" of the "role": "user" message with job description
    if (!payloadObj || typeof payloadObj !== 'object') return false;

    if (Array.isArray(payloadObj.messages)) {
      const msg = payloadObj.messages.find(m => m && m.role === 'user');
      if (msg) { msg.content = text; return true; }
    }

    if (payloadObj.message && payloadObj.message.role === 'user') {
      payloadObj.message.content = text; return true;
    }

    if ('content' in payloadObj) {
      payloadObj.content = text; return true;
    }

    return false;
  }

  function parseJSONFromString(maybeJson) {
    if (typeof maybeJson !== 'string') return null;
    try {
      return JSON.parse(maybeJson);
    } catch {
      const first = maybeJson.indexOf('{');
      const last = maybeJson.lastIndexOf('}');
      if (first >= 0 && last > first) {
        try { return JSON.parse(maybeJson.slice(first, last + 1)); } catch {}
      }
      return null;
    }
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

    if (lastSentId === base.id || inFlightById.get(base.id)) return;

    const details = extractRightPaneHtml();
    const descriptionText = details.text || details.html || '';
    if (!descriptionText) return;

    // Build request body from user-provided JSON template
    let bodyObj = null;
    try {
      bodyObj = JSON.parse(SETTINGS.requestPayload || '{}');
    } catch {
      return;
    }
    const injected = tryInjectUserContent(bodyObj, descriptionText);
    if (!injected) return;

    // ---- LOG REQUEST BODY ----
    console.log('[LVH] Request body:', bodyObj);

    inFlightById.set(base.id, true);

    try {
      const res = await fetch(SETTINGS.apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(SETTINGS.apiKey ? { Authorization: `Bearer ${SETTINGS.apiKey}` } : {})
        },
        body: JSON.stringify(bodyObj)
      });

      // Read full response text so we can log it verbatim
      const respText = await res.text();
      // ---- LOG RESPONSE BODY ----
      console.log('[LVH] Response body (text):', respText);

      // Try to parse JSON from it (if any)
      let json = null;
      try { json = JSON.parse(respText); } catch {}

      const contentStr = json?.message?.content;
      const parsed = parseJSONFromString(contentStr);
      if (parsed && typeof parsed.suitable === 'boolean') {
        VERDICT_CACHE[base.id] = parsed.suitable;
        scheduleVerdictPersist();
        paintTitle(li);
      }

      lastSentId = base.id;
    } catch (e) {
      console.warn('[LVH] Send error:', e);
    } finally {
      inFlightById.delete(base.id);
    }
  }

  // ----------------- Observers & event hooks -----------------
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

  const detailsObserver = new MutationObserver(() => {
    if (detailsObserver._timer) clearTimeout(detailsObserver._timer);
    detailsObserver._timer = setTimeout(() => {
      detailsObserver._timer = null;
      sendDetailsForActive();
    }, 150);
  });

  function attachObservers() {
    listObserver.observe(document.documentElement, { childList: true, subtree: true });

    const detailsRoot =
      document.querySelector(DETAILS_ROOT_SEL) ||
      document.querySelector('.jobs-description');
    if (detailsRoot) {
      detailsObserver.observe(detailsRoot, { childList: true, subtree: true });
    } else {
      detailsObserver.observe(document.documentElement, { childList: true, subtree: true });
    }
  }

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

  document.addEventListener(
    'click',
    (e) => {
      const li = getCardLI(e.target);
      if (!li) return;
      setTimeout(sendDetailsForActive, 250);
    },
    true
  );

  // ----------------- Init -----------------
  scan();
  attachObservers();
  const repaintId = setInterval(scan, 3000);

  window.addEventListener('beforeunload', () => {
    try { listObserver.disconnect(); } catch {}
    try { detailsObserver.disconnect(); } catch {}
    try { clearInterval(repaintId); } catch {}
  });
})();
