// === Linkedin Job Helper: VAS (Viewed/Applied/Saved) highlighter + exporter ===
(() => {
  if (window.__LVH_RUNNING__) return;
  window.__LVH_RUNNING__ = true;

  const STATE_RE = /\b(Viewed|Applied|Saved)\b/i;

  const CARD_SEL =
    'li[data-occludable-job-id], li.scaffold-layout__list-item, li.occludable-update';
  const FOOTER_SEL =
    '.job-card-container__footer-wrapper li, .job-card-container__footer-item, .job-card-container__footer-job-state';
  const INNER_CARD_SEL = '.job-card-container';

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
      /* Always show cards we touch */
      li[data-occludable-job-id].lvh-force-show,
      li.scaffold-layout__list-item.lvh-force-show,
      li.occludable-update.lvh-force-show {
        display: block !important;
        visibility: visible !important;
        opacity: 1 !important;
      }
      /* Internal-looking border without shifting layout */
      .lvh-flagged-card { position: relative !important; }
      .lvh-flagged-card::after {
        content: "";
        position: absolute;
        inset: 8px;              /* increase to pull border further inward */
        border: 2px solid red;
        border-radius: 12px;
        pointer-events: none;
        box-sizing: border-box;
      }
    `;
    document.head.appendChild(style);
  })();

  // ------------- Helpers -------------
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
    cards.forEach((li) => {
      applyHighlight(li);
      queueForExport(li);
    });
  }

  // ------------- Exporter (non-VAS jobs only) -------------
  const sentJobs = new Set();         // session-only de-duplication
  let exportTimer = null;
  const exportQueue = new Map();      // jobId -> payload

  function extractJobData(li) {
    try {
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

      const posted = inner.querySelector('time')?.getAttribute('datetime') ||
                     inner.querySelector('time')?.textContent?.trim() || "";

      return { id, title, company, location, link, postedAt: posted };
    } catch {
      return null;
    }
  }

  function queueForExport(li) {
    if (!SETTINGS.apiUrl || !/^https?:\/\//i.test(SETTINGS.apiUrl)) return;
    if (li.__lvh_isVAS) return;

    const data = extractJobData(li);
    if (!data || !data.id) return;
    if (sentJobs.has(data.id)) return;

    exportQueue.set(data.id, data);
    scheduleExport();
  }

  function scheduleExport() {
    if (exportTimer) return;
    exportTimer = setTimeout(flushExport, 800);
  }

  async function flushExport() {
    const batch = Array.from(exportQueue.values());
    exportQueue.clear();
    exportTimer = null;
    if (!batch.length) return;

    try {
      await fetch(SETTINGS.apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(SETTINGS.apiKey ? { "Authorization": `Bearer ${SETTINGS.apiKey}` } : {})
        },
        body: JSON.stringify({ jobs: batch })
      });
      batch.forEach(j => sentJobs.add(j.id));
    } catch {
      // Leave silent; items will re-queue on next DOM mutation/scan.
    }
  }

  // ------------- Observers & timers -------------
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

  ["pushState", "replaceState"].forEach((fn) => {
    const orig = history[fn];
    history[fn] = function (...args) {
      const r = orig.apply(this, args);
      scheduleScan();
      return r;
    };
  });
  window.addEventListener("popstate", () => scheduleScan());

  const intervalId = setInterval(() => scan(), 3000);

  window.addEventListener("beforeunload", () => {
    try { mo.disconnect(); } catch {}
    try { clearInterval(intervalId); } catch {}
  });
})();
