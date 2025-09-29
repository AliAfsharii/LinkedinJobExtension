// === Linkedin Job Helper: VAS highlighter (title in red) + send clicked job details ===
(() => {
  if (window.__LVH_RUNNING__) return;
  window.__LVH_RUNNING__ = true;

  // --------- Config / Selectors ---------
  const STATE_RE = /\b(Viewed|Applied|Saved)\b/i;

  const CARD_SEL =
    'li[data-occludable-job-id], li.scaffold-layout__list-item, li.occludable-update';
  const FOOTER_SEL =
    '.job-card-container__footer-wrapper li, .job-card-container__footer-item, .job-card-container__footer-job-state';
  const INNER_CARD_SEL = '.job-card-container';

  const DETAILS_WRAP_SEL = '.job-details-module, .jobs-description.job-details-module';
  const DETAILS_MAIN_SEL = '#job-details';

  // --------- Settings (API) ---------
  let SETTINGS = { apiUrl: "", apiKey: "" };
  try {
    chrome.storage.sync.get(["apiUrl", "apiKey"]).then(v => {
      SETTINGS = { apiUrl: v.apiUrl || "", apiKey: v.apiKey || "" };
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "sync") return;
      if (changes.apiUrl) SETTINGS.apiUrl = changes.apiUrl.newValue || "";
      if (changes.apiKey) SETTINGS.apiKey = changes.apiKey.newValue || "";
    });
  } catch { /* non-extension context */ }

  // --------- Styles (title red; no border) ---------
  (function ensureStyle() {
    if (document.getElementById("lvh-style")) return;
    const style = document.createElement("style");
    style.id = "lvh-style";
    style.textContent = `
      /* Always show cards we touch (defensive) */
      li[data-occludable-job-id].lvh-force-show,
      li.scaffold-layout__list-item.lvh-force-show,
      li.occludable-update.lvh-force-show {
        display: block !important;
        visibility: visible !important;
        opacity: 1 !important;
      }
      /* Make the job title text red (and its descendants) */
      .lvh-title-red, .lvh-title-red * {
        color: #d32f2f !important;
      }
    `;
    document.head.appendChild(style);
  })();

  // --------- Helpers ---------
  const getCardLI = (el) => el?.closest?.(CARD_SEL) || null;
  const getInnerCard = (li) => li.querySelector(INNER_CARD_SEL) || li;
  const getTitleEl = (li) => {
    const inner = getInnerCard(li);
    return inner.querySelector('a.job-card-container__link, a[href*="/jobs/view/"]');
  };

  function getJobState(li) {
    const footerItems = li.querySelectorAll(FOOTER_SEL);
    for (const f of footerItems) {
      const txt = (f.textContent || "").trim();
      const m = txt.match(STATE_RE);
      if (m) return m[1]; // "Viewed" | "Applied" | "Saved"
    }
    return null;
  }

  function cleanseHiding(li) {
    if (li.hasAttribute("hidden")) li.removeAttribute("hidden");
    li.style.removeProperty?.("display");
    li.style.removeProperty?.("visibility");
    li.style.removeProperty?.("opacity");
  }

  function applyHighlight(li) {
    const state = getJobState(li);
    li.__lvh_state = state; // remember state

    const titleEl = getTitleEl(li);

    if (state) {
      // keep visible
      if (!li.classList.contains("lvh-force-show")) li.classList.add("lvh-force-show");
      cleanseHiding(li);

      // title in red
      if (titleEl && !titleEl.classList.contains("lvh-title-red")) {
        titleEl.classList.add("lvh-title-red");
      }
    } else {
      // remove red if not VAS
      if (titleEl && titleEl.classList.contains("lvh-title-red")) {
        titleEl.classList.remove("lvh-title-red");
      }
    }
  }

  function extractBasicFromLI(li) {
    try {
      const inner = getInnerCard(li);
      const id =
        inner.getAttribute("data-job-id") ||
        li.getAttribute("data-occludable-job-id") ||
        "";

      const titleA = getTitleEl(li);
      const title = titleA?.textContent?.trim() || "";
      const link = titleA?.href || "";

      const company = inner.querySelector('.artdeco-entity-lockup__subtitle, [class*="entity-lockup__subtitle"]')?.textContent?.trim() || "";
      const location = inner.querySelector('.job-card-container__metadata-wrapper li, [class*="metadata-wrapper"] li')?.textContent?.trim() || "";

      const posted = inner.querySelector('time')?.getAttribute('datetime') ||
                     inner.querySelector('time')?.textContent?.trim() || "";

      return { id, title, company, location, link, postedAt: posted };
    } catch {
      return { id: "" };
    }
  }

  // --------- Right-pane detail capture ---------
  function waitForDetails(timeoutMs = 5000) {
    const start = Date.now();
    return new Promise((resolve) => {
      function check() {
        const wrap = document.querySelector(DETAILS_WRAP_SEL);
        if (wrap) {
          const main = wrap.querySelector(DETAILS_MAIN_SEL);
          const html = (main || wrap).innerHTML || "";
          const text = (main || wrap).innerText || "";
          if (html.trim().length > 0 || text.trim().length > 0) {
            resolve({ html, text });
            return;
          }
        }
        if (Date.now() - start > timeoutMs) {
          resolve({ html: "", text: "" });
          return;
        }
        requestAnimationFrame(check);
      }
      check();
    });
  }

  // --------- Sending (clicked job only; allow Viewed, skip Applied/Saved) ---------
  const sentDetailJobs = new Set();
  const capturePending = new Set();
  let lastSend = { id: null, ts: 0 };
  const DEDUP_COOLDOWN_MS = 3500;

  function shouldSend() {
    return SETTINGS.apiUrl && /^https?:\/\//i.test(SETTINGS.apiUrl);
  }

  async function sendDetails(payload) {
    try {
      await fetch(SETTINGS.apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(SETTINGS.apiKey ? { "Authorization": `Bearer ${SETTINGS.apiKey}` } : {})
        },
        body: JSON.stringify(payload)
      });
    } catch { /* swallow */ }
  }

  async function captureAndSendFor(li) {
    if (!li) return;

    // Skip only for Applied or Saved; allow Viewed or no state
    if (li.__lvh_state === "Applied" || li.__lvh_state === "Saved") return;

    const basic = extractBasicFromLI(li);
    const id = basic.id;
    if (!id) return;
    if (!shouldSend()) return;

    if (capturePending.has(id) || sentDetailJobs.has(id)) return;

    const now = Date.now();
    if (lastSend.id === id && now - lastSend.ts < DEDUP_COOLDOWN_MS) return;
    lastSend = { id, ts: now };

    capturePending.add(id);
    const details = await waitForDetails(6000);
    capturePending.delete(id);

    if (sentDetailJobs.has(id)) return;

    const payload = {
      job: {
        ...basic,
        state: li.__lvh_state || null,
        detailsHtml: details.html,
        detailsText: details.text
      }
    };

    await sendDetails(payload);
    sentDetailJobs.add(id);
  }

  // --------- Scanning & Observers ---------
  function scan(root = document) {
    const cards = root.querySelectorAll(CARD_SEL);
    cards.forEach(li => applyHighlight(li));
  }

  let scanPending = false;
  function scheduleScan(target) {
    if (scanPending) return;
    scanPending = true;
    setTimeout(() => {
      scanPending = false;
      scan(target || document);
    }, 120);
  }

  // Initial pass
  (function initial() {
    document.querySelectorAll(CARD_SEL).forEach((li) => cleanseHiding(li));
    scan();
  })();

  // Observe DOM additions
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

  // SPA route changes
  ['pushState', 'replaceState'].forEach(fn => {
    const orig = history[fn];
    history[fn] = function (...args) {
      const r = orig.apply(this, args);
      scheduleScan();
      return r;
    };
  });
  window.addEventListener('popstate', () => scheduleScan());

  // Lightweight periodic rescan
  const intervalId = setInterval(() => scan(), 3000);

  // Click handler: capture for the clicked LI
  document.addEventListener('click', (ev) => {
    const li = getCardLI(ev.target);
    if (!li) return;
    setTimeout(() => captureAndSendFor(li), 50);
  }, true);

  // Cleanup on unload
  window.addEventListener('beforeunload', () => {
    try { mo.disconnect(); } catch {}
    try { clearInterval(intervalId); } catch {}
  });
})();
