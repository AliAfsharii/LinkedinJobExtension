// === Linkedin Job Helper: VAS (Viewed/Applied/Saved) highlighter + details sender (de-duped) ===
(() => {
  if (window.__LVH_RUNNING__) return;
  window.__LVH_RUNNING__ = true;

  const STATE_RE = /\b(Viewed|Applied|Saved)\b/i;

  const CARD_SEL =
    'li[data-occludable-job-id], li.scaffold-layout__list-item, li.occludable-update';
  const FOOTER_SEL =
    '.job-card-container__footer-wrapper li, .job-card-container__footer-item, .job-card-container__footer-job-state';
  const INNER_CARD_SEL = '.job-card-container';
  const ACTIVE_MARKER_SEL = '.jobs-search-results-list__list-item--active, [aria-current="page"]';

  // ------------- Settings (API) -------------
  let SETTINGS = { apiUrl: "", apiKey: "" };
  chrome.storage.sync.get(["apiUrl", "apiKey"]).then(v => {
    SETTINGS = { apiUrl: v.apiUrl || "", apiKey: v.apiKey || "" };
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    if (changes.apiUrl) SETTINGS.apiUrl = changes.apiUrl.newValue || "";
    if (changes.apiKey) SETTINGS.apiKey = changes.apiKey.newValue || "";
  });

  // ------------- Styles -------------
  (function ensureStyle() {
    if (document.getElementById("lvh-style")) return;
    const style = document.createElement("style");
    style.id = "lvh-style";
    style.textContent = `
      li[data-occludable-job-id].lvh-force-show,
      li.scaffold-layout__list-item.lvh-force-show,
      li.occludable-update.lvh-force-show {
        display: block !important;
        visibility: visible !important;
        opacity: 1 !important;
      }
      .lvh-flagged-card { position: relative !important; }
      .lvh-flagged-card::after {
        content: "";
        position: absolute;
        inset: 10px;              /* inward border (padding look) */
        border: 2px solid red;
        border-radius: 12px;
        pointer-events: none;
        box-sizing: border-box;
      }
    `;
    document.head.appendChild(style);
  })();

  // ------------- Helpers (highlighting) -------------
  const getCardLI = (el) => el.closest?.(CARD_SEL) || null;
  const getInnerCard = (li) => li.querySelector(INNER_CARD_SEL) || li;

  function hasFlagState(li) {
    const footerItems = li.querySelectorAll(FOOTER_SEL);
    for (const f of footerItems) {
      const txt = (f.textContent || "").trim();
      if (STATE_RE.test(txt)) return true;
    }
    return false;
  }

  function cleanseHiding(li) {
    if (li.hasAttribute("hidden")) li.removeAttribute("hidden");
    li.style.removeProperty?.("display");
    li.style.removeProperty?.("visibility");
    li.style.removeProperty?.("opacity");
  }

  function applyHighlight(li) {
    const flagged = hasFlagState(li);
    const inner = getInnerCard(li);

    if (flagged) {
      if (!li.classList.contains("lvh-force-show")) li.classList.add("lvh-force-show");
      cleanseHiding(li);
      if (!inner.classList.contains("lvh-flagged-card")) inner.classList.add("lvh-flagged-card");
      li.__lvh_isVAS = true;
    } else {
      if (li.classList.contains("lvh-force-show")) li.classList.remove("lvh-force-show");
      if (inner.classList.contains("lvh-flagged-card")) inner.classList.remove("lvh-flagged-card");
      li.__lvh_isVAS = false;
    }
  }

  function scan(root = document) {
    const cards = root.querySelectorAll(CARD_SEL);
    cards.forEach((li) => applyHighlight(li));
  }

  // ------------- Details sender (fires on open) -------------
  const sentDetailJobs = new Set();   // sent already this session
  const capturePending = new Set();   // capture in progress per job id

  function activeCardLI() {
    const activeInner =
      document.querySelector(`${INNER_CARD_SEL}${ACTIVE_MARKER_SEL ? ACTIVE_MARKER_SEL.replace(/^/, '') : ''}`) ||
      document.querySelector(ACTIVE_MARKER_SEL)?.closest(INNER_CARD_SEL);
    const li = activeInner ? activeInner.closest(CARD_SEL) : null;
    return li || null;
  }

  function extractBasicFromLI(li) {
    const inner = getInnerCard(li);
    const id =
      inner.getAttribute("data-job-id") ||
      li.getAttribute("data-occludable-job-id") ||
      "";

    const titleA = inner.querySelector('a.job-card-container__link, a[href*="/jobs/view/"]');
    const title = titleA?.textContent?.trim() || "";
    const link = titleA?.href || "";

    const company = inner.querySelector('.artdeco-entity-lockup__subtitle, [class*="entity-lockup__subtitle"]')?.textContent?.trim() || "";
    const location = inner.querySelector('.job-card-container__metadata-wrapper li, [class*="metadata-wrapper"] li')?.textContent?.trim() || "";
    const postedAt = inner.querySelector('time')?.getAttribute('datetime') ||
                     inner.querySelector('time')?.textContent?.trim() || "";

    return { id, title, company, location, link, postedAt };
  }

  function grabDetailsHTML() {
    const container =
      document.querySelector('div.jobs-description.job-details-module') ||
      document.querySelector('div.job-details-module') ||
      document.querySelector('#job-details')?.closest('.jobs-description') ||
      null;

    if (!container) return null;

    const htmlNode =
      container.querySelector('#job-details') ||
      container.querySelector('.jobs-box__html-content') ||
      container;

    const detailsHtml = htmlNode.innerHTML || "";
    const detailsText = htmlNode.textContent?.trim() || "";

    return { detailsHtml, detailsText };
  }

  function shouldSend() {
    return SETTINGS.apiUrl && /^https?:\/\//i.test(SETTINGS.apiUrl);
  }

  async function sendDetails(payload) {
    try {
      await fetch(SETTINGS.apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(SETTINGS.apiKey ? { "Authorization": `Bearer ${SETTINGS.apiKey}` } : {}),
        },
        body: JSON.stringify({ job: payload }),
      });
    } catch {
      // silent
    }
  }

  // De-duped capture: one interval per job id; skip if pending or sent
  function captureAndSendFor(li) {
    if (!li || li.__lvh_isVAS) return; // only non-VAS
    const basic = extractBasicFromLI(li);
    const id = basic.id;
    if (!id) return;
    if (!shouldSend()) return;
    if (sentDetailJobs.has(id) || capturePending.has(id)) return;

    capturePending.add(id);

    let tries = 0;
    const maxTries = 40; // ~4s at 100ms
    const t = setInterval(() => {
      tries++;
      const details = grabDetailsHTML();
      if (details && details.detailsHtml && details.detailsHtml.length > 40) {
        clearInterval(t);
        sentDetailJobs.add(id);
        capturePending.delete(id);
        sendDetails({ ...basic, ...details });
      } else if (tries >= maxTries) {
        clearInterval(t);
        capturePending.delete(id);
      }
    }, 100);
  }

  // Clicks on job cards/links
  document.addEventListener('click', (e) => {
    const li = getCardLI(e.target);
    if (li) setTimeout(() => captureAndSendFor(li), 150);
  }, true);

  // When active job changes via keyboard/programmatic navigation
  const activeWatcher = new MutationObserver(() => {
    const li = activeCardLI();
    if (li) captureAndSendFor(li);
  });
  activeWatcher.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['class', 'aria-current']
  });

  // Also fire on history changes (SPA route to a job)
  ['pushState', 'replaceState'].forEach(fn => {
    const orig = history[fn];
    history[fn] = function (...args) {
      const r = orig.apply(this, args);
      setTimeout(() => {
        const li = activeCardLI();
        if (li) captureAndSendFor(li);
      }, 200);
      return r;
    };
  });
  window.addEventListener('popstate', () => {
    setTimeout(() => {
      const li = activeCardLI();
      if (li) captureAndSendFor(li);
    }, 200);
  });

  // ------------- Boot: highlight once -------------
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
    document.querySelectorAll(CARD_SEL).forEach((li) => cleanseHiding(li));
    scan();
  })();

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

  // Periodic safety net (lightweight)
  const intervalId = setInterval(() => scan(), 3000);

  window.addEventListener("beforeunload", () => {
    try { mo.disconnect(); } catch {}
    try { activeWatcher.disconnect(); } catch {}
    try { clearInterval(intervalId); } catch {}
  });
})();
