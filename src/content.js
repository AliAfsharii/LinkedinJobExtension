// === Linkedin Job Helper: Title colorizer + API verdicts (green/purple) ===
(() => {
  if (window.__LVH_RUNNING__) return;
  window.__LVH_RUNNING__ = true;
  console.log('[LVH] init');

  // ---- Constants / selectors ----
  const STATE_RE = /\b(Viewed|Applied|Saved)\b/i; // VAS
  const CARD_SEL =
    'li[data-occludable-job-id], li.scaffold-layout__list-item, li.occludable-update';
  const FOOTER_SEL =
    '.job-card-container__footer-wrapper li, .job-card-container__footer-item, .job-card-container__footer-job-state';
  const INNER_CARD_SEL = '.job-card-container';
  const TITLE_LINK_SEL = 'a.job-card-container__link, a[href*="/jobs/view/"]';
  const DETAILS_CONTAINER_SEL =
    '.jobs-description, .jobs-description__content, #job-details';
  const ACTIVE_SEL =
    '.jobs-search-results-list__list-item--active, [aria-current="page"]';

  // ---- Options (API) ----
  let SETTINGS = { apiUrl: '', apiKey: '', requestPayload: '' };
  chrome.storage.sync.get(['apiUrl', 'apiKey', 'requestPayload']).then(v => {
    SETTINGS = {
      apiUrl: v.apiUrl || '',
      apiKey: v.apiKey || '',
      requestPayload: v.requestPayload || ''
    };
    console.log('[LVH] settings loaded', SETTINGS);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    if (changes.apiUrl) SETTINGS.apiUrl = changes.apiUrl.newValue || '';
    if (changes.apiKey) SETTINGS.apiKey = changes.apiKey.newValue || '';
    if (changes.requestPayload) SETTINGS.requestPayload = changes.requestPayload.newValue || '';
  });

  // ---- Styles (title colors) ----
  (function ensureStyle() {
    if (document.getElementById('lvh-style')) return;
    const style = document.createElement('style');
    style.id = 'lvh-style';
    style.textContent = `
      .lvh-title-red    { color: #d32f2f !important; }
      .lvh-title-green  { color: #2e7d32 !important; }
      .lvh-title-purple { color: #6a1b9a !important; }
    `;
    document.head.appendChild(style);
  })();

  // ---- State: verdicts per jobId ----
  const verdicts = Object.create(null); // verdicts[jobId] = true|false
  let verdictsLoaded = false;

  chrome.storage.sync.get(['lvhVerdicts']).then(v => {
    const map = v.lvhVerdicts || {};
    Object.entries(map).forEach(([k, val]) => (verdicts[k] = !!val));
    verdictsLoaded = true;
    console.log('[LVH] verdicts loaded', verdicts);
    repaintAll();
  });

  function saveVerdictsDebounced() {
    if (saveVerdictsDebounced._t) return;
    saveVerdictsDebounced._t = setTimeout(() => {
      saveVerdictsDebounced._t = null;
      chrome.storage.sync.set({ lvhVerdicts: verdicts });
    }, 400);
  }

  // ---- Helpers ----
  const getCardLI = el => el.closest?.(CARD_SEL) || null;
  const getInnerCard = li => li.querySelector(INNER_CARD_SEL) || li;
  const getTitleEl = li => getInnerCard(li).querySelector(TITLE_LINK_SEL);

  function getJobId(li) {
    const inner = getInnerCard(li);
    return (
      inner.getAttribute('data-job-id') ||
      li.getAttribute('data-occludable-job-id') ||
      ''
    );
  }

  function hasVAS(li) {
    for (const f of li.querySelectorAll(FOOTER_SEL)) {
      const txt = (f.textContent || '').trim();
      if (STATE_RE.test(txt)) return true;
    }
    return false;
  }

  function paintTitle(li) {
    const title = getTitleEl(li);
    if (!title) return;

    title.classList.remove('lvh-title-red', 'lvh-title-green', 'lvh-title-purple');

    const id = getJobId(li);
    if (id && id in verdicts) {
      if (verdicts[id] === true) title.classList.add('lvh-title-green');
      else title.classList.add('lvh-title-purple');
      return;
    }

    if (hasVAS(li)) {
      title.classList.add('lvh-title-red');
    }
  }

  function repaintAll(root = document) {
    root.querySelectorAll(CARD_SEL).forEach(paintTitle);
  }

  function scan(root = document) {
    const cards = root.querySelectorAll(CARD_SEL);
    console.log('[LVH] scan cards:', cards.length);
    cards.forEach(li => paintTitle(li));
    scheduleActiveCheck();
  }

  // ---- Active card detection -> send description to API ----
  function getActiveCard() {
    const marker = document.querySelector(ACTIVE_SEL);
    if (!marker) return null;
    return getCardLI(marker) || marker.closest?.(CARD_SEL) || null;
  }

  let lastActiveJobId = null;
  let activeCheckTimer = null;

  function scheduleActiveCheck() {
    if (activeCheckTimer) return;
    activeCheckTimer = setTimeout(() => {
      activeCheckTimer = null;
      const li = getActiveCard();
      if (!li) return;
      const jobId = getJobId(li);
      if (!jobId || jobId === lastActiveJobId) return;
      lastActiveJobId = jobId;
      console.log('[LVH] active job changed:', jobId);
      // give the pane a moment to render
      setTimeout(() => {
        const desc = getCurrentDescriptionText();
        console.log('[LVH] captured description length:', desc.length);
        if (desc) sendForJob(jobId, desc);
        paintTitle(li);
      }, 350);
    }, 120);
  }

  // ---- Build request body (inject description + jobId INSIDE user message content) ----
  function buildRequestBody(descriptionText, jobId) {
    let body = {};
    try {
      body = JSON.parse(SETTINGS.requestPayload || '{}');
    } catch {
      body = {};
    }

    // Do NOT add jobId at top level anymore.
    // Instead, put it into the user's message content as a JSON string.
    if (body && typeof body === 'object') {
      const msgs = body.messages;
      if (Array.isArray(msgs)) {
        const userMsg = msgs.find(m => m && m.role === 'user');
        if (userMsg) {
          // content becomes a JSON string with both jobId and description
          userMsg.content = JSON.stringify({
            jobId,
            description: descriptionText || ''
          });
        }
      }
    }
    return body;
  }

  // ---- API call / parse response ----
  const perJobCooldown = new Map(); // jobId -> ts

  async function sendForJob(jobId, descriptionText) {
    if (!SETTINGS.apiUrl || !/^https?:\/\//i.test(SETTINGS.apiUrl)) {
      console.warn('[LVH] apiUrl not set or invalid');
      return;
    }
    if (!jobId || !descriptionText) return;

    const now = Date.now();
    const last = perJobCooldown.get(jobId) || 0;
    if (now - last < 1000) return; // prevent rapid dupes
    perJobCooldown.set(jobId, now);

    const body = buildRequestBody(descriptionText, jobId);

    // Log request body before sending
    try {
      console.log('[LVH] Request body:', JSON.stringify(body, null, 2));
    } catch {
      console.log('[LVH] Request body (non-JSON):', body);
    }

    let text = '';
    try {
      const resp = await fetch(SETTINGS.apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(SETTINGS.apiKey ? { Authorization: `Bearer ${SETTINGS.apiKey}` } : {})
        },
        body: JSON.stringify(body)
      });
      text = await resp.text();
      console.log('[LVH] Response body (text):', text);
    } catch (e) {
      console.warn('[LVH] API call failed:', e);
      return;
    }

    try {
      const parsed = JSON.parse(text);
      const contentStr =
        parsed?.choices?.[0]?.message?.content ??
        parsed?.message?.content ??
        '';
      if (typeof contentStr === 'string' && contentStr.trim()) {
        try {
          const verdictObj = JSON.parse(contentStr);
          const respJobId = verdictObj?.jobId || jobId;
          if (typeof verdictObj?.suitable === 'boolean' && respJobId) {
            verdicts[respJobId] = verdictObj.suitable; // true => green, false => purple
            saveVerdictsDebounced();
            // repaint only the job returned by API
            const li =
              document.querySelector(
                `${CARD_SEL}[data-occludable-job-id="${respJobId}"]`
              ) ||
              document.querySelector(
                `${CARD_SEL} .job-card-container[data-job-id="${respJobId}"]`
              )?.closest(CARD_SEL);
            if (li) paintTitle(li);
            else repaintAll(); // fallback
            console.log('[LVH] verdict applied', respJobId, verdictObj.suitable);
          }
        } catch (e2) {
          console.warn('[LVH] Could not parse message.content as JSON:', e2);
        }
      }
    } catch {
      /* ignore */
    }
  }

  // ---- Extract description from right pane ----
  function getCurrentDescriptionText() {
    const el =
      document.querySelector('#job-details') ||
      document.querySelector('.jobs-description-content') ||
      document.querySelector(DETAILS_CONTAINER_SEL);
    if (!el) return '';
    return (el.innerText || '').trim();
  }

  // ---- Observe DOM for new cards / active changes ----
  let scanPending = false;
  function scheduleScan(target) {
    if (scanPending) return;
    scanPending = true;
    setTimeout(() => {
      scanPending = false;
      scan(target || document);
    }, 120);
  }

  (function initial() {
    scan();
    scheduleActiveCheck();
  })();

  const mo = new MutationObserver(muts => {
    let needScan = false;
    let sawActiveChange = false;

    for (const m of muts) {
      if (m.type === 'attributes' && (m.attributeName === 'class' || m.attributeName === 'aria-current')) {
        if (m.target.matches?.(ACTIVE_SEL)) {
          sawActiveChange = true;
        }
        if (getCardLI(m.target)) {
          sawActiveChange = true;
        }
      }
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
          needScan = true;
        }
      }
    }

    if (needScan) scheduleScan();
    if (sawActiveChange) scheduleActiveCheck();
  });
  mo.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'aria-current']
  });

  ['pushState', 'replaceState'].forEach(fn => {
    const orig = history[fn];
    history[fn] = function (...args) {
      const r = orig.apply(this, args);
      scheduleScan();
      scheduleActiveCheck();
      return r;
    };
  });
  window.addEventListener('popstate', () => {
    scheduleScan();
    scheduleActiveCheck();
  });

  const intervalId = setInterval(() => {
    if (!verdictsLoaded) return;
    repaintAll();
    scheduleActiveCheck();
  }, 3000);

  window.addEventListener('beforeunload', () => {
    try { mo.disconnect(); } catch {}
    try { clearInterval(intervalId); } catch {}
  });
})();
