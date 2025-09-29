// === Linkedin Job Helper: title coloring by API verdict + VAS fallback ===
(() => {
  if (window.__LVH_RUNNING__) return;
  window.__LVH_RUNNING__ = true;

  // --------- Selectors / Regex ----------
  const STATE_TOKENS = {
    viewed: /(^|\b)Viewed(\b|$)/i,
    applied: /(^|\b)Applied(\b|$)/i,
    saved: /(^|\b)Saved(\b|$)/i
  };
  const CARD_SEL = 'li[data-occludable-job-id], li.scaffold-layout__list-item, li.occludable-update';
  const FOOTER_SEL = '.job-card-container__footer-wrapper li, .job-card-container__footer-item, .job-card-container__footer-job-state';
  const INNER_CARD_SEL = '.job-card-container';
  const TITLE_SEL = 'a.job-card-container__link, a[href*="/jobs/view/"]';
  const RIGHT_PANE_HTML_SEL = '.jobs-description.job-details-module, .jobs-description__container, #job-details';

  // --------- Settings (API) ----------
  let SETTINGS = { apiUrl: '', apiKey: '', requestPayload: '' };
  chrome.storage.sync.get(['apiUrl', 'apiKey', 'requestPayload']).then(v => {
    SETTINGS.apiUrl = v.apiUrl || '';
    SETTINGS.apiKey = v.apiKey || '';
    SETTINGS.requestPayload = v.requestPayload || '';
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    if (changes.apiUrl) SETTINGS.apiUrl = changes.apiUrl.newValue || '';
    if (changes.apiKey) SETTINGS.apiKey = changes.apiKey.newValue || '';
    if (changes.requestPayload) SETTINGS.requestPayload = changes.requestPayload.newValue || '';
  });

  // --------- Verdict persistence ----------
  let VERDICTS = {};
  chrome.storage.local.get(['lvhVerdicts']).then(v => {
    VERDICTS = v.lvhVerdicts || {};
    scan();
  });
  function saveVerdicts() {
    chrome.storage.local.set({ lvhVerdicts: VERDICTS });
  }

  // --------- Helpers ----------
  const getCardLI = el => el.closest?.(CARD_SEL) || null;
  const getInnerCard = li => li.querySelector(INNER_CARD_SEL) || li;
  const getTitleEl = li => getInnerCard(li).querySelector(TITLE_SEL);

  function getJobId(li) {
    const inner = getInnerCard(li);
    return inner.getAttribute('data-job-id') ||
           li.getAttribute('data-occludable-job-id') || '';
  }

  function getJobState(li) {
    const res = { viewed: false, applied: false, saved: false };
    const items = li.querySelectorAll(FOOTER_SEL);
    for (const f of items) {
      const t = (f.textContent || '').trim();
      if (STATE_TOKENS.viewed.test(t)) res.viewed = true;
      if (STATE_TOKENS.applied.test(t)) res.applied = true;
      if (STATE_TOKENS.saved.test(t)) res.saved = true;
    }
    return res;
  }

  function setTitleColor(li, color /* '', 'red', 'green' */) {
    const a = getTitleEl(li);
    if (!a) return;
    if (color) {
      a.style.color = color;
      a.dataset.lvhTint = color;
    } else {
      if (a.dataset.lvhTint) delete a.dataset.lvhTint;
      a.style.removeProperty('color');
    }
  }

  function repaintCard(li) {
    const id = getJobId(li);
    const verdict = id ? VERDICTS[id] : undefined; // true/false/undefined
    const { viewed, applied, saved } = getJobState(li);

    if (verdict === true) {
      setTitleColor(li, 'green');
    } else if (verdict === false) {
      setTitleColor(li, 'red');
    } else {
      if (viewed || applied || saved) {
        setTitleColor(li, 'red');
      } else {
        setTitleColor(li, '');
      }
    }
  }

  function scan(root = document) {
    const cards = root.querySelectorAll(CARD_SEL);
    cards.forEach(li => repaintCard(li));
  }

  // --------- Detail extraction (right pane) ----------
  function getRightPaneDescription() {
    const pane = document.querySelector(RIGHT_PANE_HTML_SEL);
    if (!pane) return '';
    const jd = pane.querySelector('#job-details');
    const node = jd || pane;
    return (node.innerText || '').trim();
  }

  // --------- API call on click (skip Applied/Saved; allow Viewed) ----------
  const sentForThisSession = new Set(); // per job id
  let lastClickedLi = null;             // remember which card was clicked last

  async function maybeSendFor(li) {
    if (!li) return;
    if (!SETTINGS.apiUrl || !/^https?:\/\//i.test(SETTINGS.apiUrl)) return;

    const id = getJobId(li);
    if (!id) return;

    const { applied, saved } = getJobState(li);
    if (applied || saved) {
      console.log('[LVH] Skipping send (Applied/Saved):', id);
      return;
    }

    // dedupe per job id in this session
    if (sentForThisSession.has(id)) {
      // still color with stored verdict (if any)
      repaintCard(li);
      return;
    }

    const description = getRightPaneDescription();
    if (!description) {
      // details not yet rendered; try again shortly
      scheduleSend(li, 400);
      return;
    }

    // Build request payload from template or default
    let requestBody;
    try {
      if (SETTINGS.requestPayload) {
        const tpl = JSON.parse(SETTINGS.requestPayload);
        if (Array.isArray(tpl.messages)) {
          const idx = tpl.messages.findIndex(m => m && m.role === 'user');
          if (idx >= 0) tpl.messages[idx] = { ...tpl.messages[idx], content: description };
        }
        requestBody = tpl;
      }
    } catch { /* ignore template parse errors */ }
    if (!requestBody) requestBody = { message: { role: 'user', content: description } };

    // Log request body before sending
    try {
      console.log('[LVH] Request body:', JSON.stringify(requestBody, null, 2));
    } catch {
      console.log('[LVH] Request body (object):', requestBody);
    }

    try {
      const resp = await fetch(SETTINGS.apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(SETTINGS.apiKey ? { 'Authorization': `Bearer ${SETTINGS.apiKey}` } : {})
        },
        body: JSON.stringify(requestBody)
      });

      const text = await resp.text();
      console.log('[LVH] Response body (text):', text);

      // Parse envelope -> choices[0].message.content -> JSON string with { suitable: boolean }
      let verdictBool;
      try {
        const outer = JSON.parse(text);
        const contentStr =
          outer?.choices?.[0]?.message?.content ??
          outer?.message?.content ?? null;

        if (typeof contentStr === 'string') {
          const inner = JSON.parse(contentStr);
          if (typeof inner?.suitable === 'boolean') verdictBool = inner.suitable;
        }
      } catch { /* ignore parse errors */ }

      if (typeof verdictBool === 'boolean') {
        VERDICTS[id] = verdictBool;
        saveVerdicts();
        repaintCard(li);
      }

      sentForThisSession.add(id);
    } catch (e) {
      console.log('[LVH] Request failed:', e);
    }
  }

  // Debounced sender; tie to specific LI
  let clickTimer = null;
  function scheduleSend(li, delay = 500) {
    if (clickTimer) clearTimeout(clickTimer);
    clickTimer = setTimeout(() => {
      clickTimer = null;
      maybeSendFor(li || lastClickedLi);
    }, delay);
  }

  // --------- Wiring: click → send using clicked LI ----------
  document.addEventListener('click', (e) => {
    const li = getCardLI(e.target);
    if (li) {
      lastClickedLi = li;
      scheduleSend(li, 500);
    }
  }, true);

  // Also, when the right pane updates after a click, try again using last clicked LI
  const mo = new MutationObserver((muts) => {
    let needsScan = false;
    let rightPaneChanged = false;
    for (const m of muts) {
      if (m.type === 'childList') {
        for (const n of m.addedNodes) {
          if (!(n instanceof Element)) continue;
          if (n.matches?.(CARD_SEL) || n.querySelector?.(CARD_SEL)) needsScan = true;
          if (n.matches?.(RIGHT_PANE_HTML_SEL) || n.querySelector?.(RIGHT_PANE_HTML_SEL)) rightPaneChanged = true;
        }
      }
      if (m.type === 'attributes' && m.target instanceof Element) {
        if (m.target.matches?.(CARD_SEL) || m.target.closest?.(CARD_SEL)) needsScan = true;
      }
    }
    if (needsScan) scan();
    if (rightPaneChanged && lastClickedLi) scheduleSend(lastClickedLi, 300);
  });
  mo.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'aria-current']
  });

  // SPA navigations -> repaint
  ['pushState', 'replaceState'].forEach(fn => {
    const orig = history[fn];
    history[fn] = function (...args) {
      const r = orig.apply(this, args);
      setTimeout(() => scan(), 300);
      return r;
    };
  });
  window.addEventListener('popstate', () => setTimeout(() => scan(), 300));

  // Initial paint
  scan();
})();
