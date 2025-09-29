// === Linkedin Job Helper: Title colorizer + API verdicts (green/purple) + Auto-save on suitable ===
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
      let jobId = li ? getJobId(li) : null;

      // Fallback: parse from right-pane H1 link
      if (!jobId) {
        const a = document.querySelector(
          '.job-details-jobs-unified-top-card__job-title a[href*="/jobs/view/"]'
        );
        if (a && a.href) {
          const m = a.href.match(/\/jobs\/view\/(\d+)/);
          if (m) jobId = m[1];
        }
      }

      if (!jobId || jobId === lastActiveJobId) return;
      lastActiveJobId = jobId;
      console.log('[LVH] active job changed:', jobId);
      // give the pane a moment to render
      setTimeout(() => {
        const desc = getCurrentDescriptionText();
        console.log('[LVH] captured description length:', desc.length);
        if (desc) sendForJob(jobId, desc);
        if (li) paintTitle(li);
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

    // Put jobId + description into the user's message content.
    if (body && typeof body === 'object') {
      const msgs = body.messages;
      if (Array.isArray(msgs)) {
        const userMsg = msgs.find(m => m && m.role === 'user');
        if (userMsg) {
          userMsg.content = JSON.stringify({
            jobId,
            description: descriptionText || ''
          });
        }
      }
    }
    return body;
  }

  // ---- Auto-save helpers ----
  const saveClickCooldown = new Map(); // jobId -> ts

  function getCurrentJobIdFromPane() {
    // 1) Active list item, if present
    const li = getActiveCard();
    const idFromList = li ? getJobId(li) : null;
    if (idFromList) return idFromList;

    // 2) Parse from the job header link in the right pane
    const a = document.querySelector(
      '.job-details-jobs-unified-top-card__job-title a[href*="/jobs/view/"]'
    );
    if (a && a.href) {
      const m = a.href.match(/\/jobs\/view\/(\d+)/);
      if (m) return m[1];
    }
    return null;
  }

  function findSaveButtonInPane() {
    // Prefer the two-pane top card container. Fallback to document.
    const paneRoot =
      document.querySelector('.job-details-jobs-unified-top-card__container--two-pane') ||
      document;

    const candidates = [
      'button.jobs-save-button', // exact class in provided DOM
      'button[data-test-global-save-job-button]',
      '#job-details button[aria-label*="Save"]',
      '#job-details button[aria-label*="Saved"]',
      'button[aria-label*="Save"]',
      'button[aria-label*="Saved"]'
    ];

    for (const sel of candidates) {
      const btn = paneRoot.querySelector(sel);
      if (btn) return btn;
    }
    return null;
  }

  function isSaveButtonPressed(btn) {
    const aria = btn.getAttribute('aria-pressed');
    const pressedByAria = aria === 'true';
    const pressedByClass = btn.classList.contains('artdeco-button--pressed');
    const txt = (btn.innerText || '').trim();
    const pressedByText = /\bSaved|Unsave|Saved job/i.test(txt);
    return pressedByAria || pressedByClass || pressedByText;
  }

  function tryAutoSave(jobId) {
    // Only save if the pane still shows this job
    const current = getCurrentJobIdFromPane();
    if (!current || current !== jobId) {
      console.log('[LVH] skip autosave: pane not on jobId', jobId, 'current=', current);
      return;
    }

    const now = Date.now();
    const last = saveClickCooldown.get(jobId) || 0;
    if (now - last < 1500) return; // throttle
    saveClickCooldown.set(jobId, now);

    const btn = findSaveButtonInPane();
    if (!btn) {
      console.log('[LVH] save button not found for jobId', jobId);
      return;
    }

    if (isSaveButtonPressed(btn)) {
      console.log('[LVH] job already saved, no click', jobId);
      return;
    }

    try {
      btn.click();
      console.log('[LVH] clicked Save for jobId', jobId);
    } catch (e) {
      console.warn('[LVH] failed to click Save:', e);
    }
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

            // Auto-click Save if suitable
            if (verdictObj.suitable === true) {
              setTimeout(() => tryAutoSave(respJobId), 400); // allow UI to settle
            }
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
    // Prefer new pane containers if present; fallback to legacy selectors
    const pane =
      document.querySelector('.job-details-jobs-unified-top-card__container--two-pane') ||
      document.querySelector('#job-details') ||
      document.querySelector('.jobs-description-content') ||
      document.querySelector(DETAILS_CONTAINER_SEL);

    if (!pane) return '';
    // Description can be elsewhere; capture visible text of the pane area
    const el =
      pane.querySelector('[data-test-description], .jobs-description, .jobs-box__html-content, .jobs-description-content, #job-details') ||
      pane;

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
          n.querySelector?.(FOOTER_SEL) ||
          n.matches?.('.job-details-jobs-unified-top-card__container--two-pane') ||
          n.querySelector?.('.job-details-jobs-unified-top-card__container--two-pane')
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
