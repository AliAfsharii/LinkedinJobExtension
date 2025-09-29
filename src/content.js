// === Linkedin Job Helper: Title colorizer + API verdicts + Auto-save on suitable + Auto loop with robust page preload ===
(() => {
  if (window.__LVH_RUNNING__) return;
  window.__LVH_RUNNING__ = true;
  console.log("[LVH] init");

  // Selectors
  const STATE_RE = /\b(Viewed|Applied|Saved)\b/i;
  const CARD_SEL =
    'li[data-occludable-job-id], li.scaffold-layout__list-item, li.occludable-update';
  const FOOTER_SEL =
    ".job-card-container__footer-wrapper li, .job-card-container__footer-item, .job-card-container__footer-job-state";
  const INNER_CARD_SEL = ".job-card-container";
  const TITLE_LINK_SEL = 'a.job-card-container__link, a[href*="/jobs/view/"]';
  const DETAILS_CONTAINER_SEL =
    ".jobs-description, .jobs-description__content, #job-details";
  const ACTIVE_SEL =
    '.jobs-search-results-list__list-item--active, [aria-current="page"]';

  // Settings
  let SETTINGS = { apiUrl: "", apiKey: "", requestPayload: "" };
  chrome.storage.sync.get(["apiUrl", "apiKey", "requestPayload"]).then((v) => {
    SETTINGS = {
      apiUrl: v.apiUrl || "",
      apiKey: v.apiKey || "",
      requestPayload: v.requestPayload || ""
    };
    console.log("[LVH] settings loaded", SETTINGS);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    if (changes.apiUrl) SETTINGS.apiUrl = changes.apiUrl.newValue || "";
    if (changes.apiKey) SETTINGS.apiKey = changes.apiKey.newValue || "";
    if (changes.requestPayload) SETTINGS.requestPayload = changes.requestPayload.newValue || "";
  });

  // Style
  (function ensureStyle() {
    if (document.getElementById("lvh-style")) return;
    const style = document.createElement("style");
    style.id = "lvh-style";
    style.textContent = `
      .lvh-title-red    { color: #d32f2f !important; }
      .lvh-title-green  { color: #2e7d32 !important; }
      .lvh-title-purple { color: #6a1b9a !important; }
    `;
    document.head.appendChild(style);
  })();

  // Verdict cache
  const verdicts = Object.create(null);
  let verdictsLoaded = false;
  chrome.storage.sync.get(["lvhVerdicts"]).then((v) => {
    const map = v.lvhVerdicts || {};
    Object.entries(map).forEach(([k, val]) => (verdicts[k] = !!val));
    verdictsLoaded = true;
    repaintAll();
  });
  function saveVerdictsDebounced() {
    if (saveVerdictsDebounced._t) return;
    saveVerdictsDebounced._t = setTimeout(() => {
      saveVerdictsDebounced._t = null;
      chrome.storage.sync.set({ lvhVerdicts: verdicts });
    }, 400);
  }

  // DOM helpers
  const getCardLI = (el) => el.closest?.(CARD_SEL) || null;
  const getInnerCard = (li) => li.querySelector(INNER_CARD_SEL) || li;
  const getTitleEl = (li) => getInnerCard(li).querySelector(TITLE_LINK_SEL);
  function getJobId(li) {
    const inner = getInnerCard(li);
    return (
      inner.getAttribute("data-job-id") ||
      li.getAttribute("data-occludable-job-id") ||
      ""
    );
  }
  function hasVAS(li) {
    for (const f of li.querySelectorAll(FOOTER_SEL)) {
      const txt = (f.textContent || "").trim();
      if (STATE_RE.test(txt)) return true;
    }
    return false;
  }
  function paintTitle(li) {
    const title = getTitleEl(li);
    if (!title) return;
    title.classList.remove("lvh-title-red", "lvh-title-green", "lvh-title-purple");
    const id = getJobId(li);
    if (id && id in verdicts) {
      if (verdicts[id] === true) title.classList.add("lvh-title-green");
      else title.classList.add("lvh-title-purple");
      return;
    }
    if (hasVAS(li)) title.classList.add("lvh-title-red");
  }
  function repaintAll(root = document) {
    root.querySelectorAll(CARD_SEL).forEach(paintTitle);
  }
  function scan(root = document) {
    const cards = root.querySelectorAll(CARD_SEL);
    cards.forEach((li) => paintTitle(li));
    scheduleActiveCheck();
  }

  // Active tracking -> API
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
      setTimeout(() => {
        const desc = getCurrentDescriptionText();
        if (desc) sendForJob(jobId, desc);
        if (li) paintTitle(li);
      }, 350);
    }, 120);
  }

  // Request body
  function buildRequestBody(descriptionText, jobId) {
    let body = {};
    try { body = JSON.parse(SETTINGS.requestPayload || "{}"); }
    catch { body = {}; }
    if (body && typeof body === "object") {
      const msgs = body.messages;
      if (Array.isArray(msgs)) {
        const userMsg = msgs.find((m) => m && m.role === "user");
        if (userMsg) {
          userMsg.content = JSON.stringify({ jobId, description: descriptionText || "" });
        }
      }
    }
    return body;
  }

  // Save button
  const saveClickCooldown = new Map();
  function getCurrentJobIdFromPane() {
    const li = getActiveCard();
    const idFromList = li ? getJobId(li) : null;
    if (idFromList) return idFromList;
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
    const paneRoot =
      document.querySelector(".job-details-jobs-unified-top-card__container--two-pane") ||
      document;
    const candidates = [
      "button.jobs-save-button",
      "button[data-test-global-save-job-button]",
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
    const aria = btn.getAttribute("aria-pressed");
    const pressedByAria = aria === "true";
    const pressedByClass = btn.classList.contains("artdeco-button--pressed");
    const txt = (btn.innerText || "").trim();
    const pressedByText = /\bSaved|Unsave|Saved job/i.test(txt);
    return pressedByAria || pressedByClass || pressedByText;
  }
  function tryAutoSave(jobId) {
    const current = getCurrentJobIdFromPane();
    if (!current || current !== jobId) {
      console.log("[LVH] skip autosave: pane not on jobId", jobId, "current=", current);
      return;
    }
    const now = Date.now();
    const last = saveClickCooldown.get(jobId) || 0;
    if (now - last < 1500) return;
    saveClickCooldown.set(jobId, now);
    const btn = findSaveButtonInPane();
    if (!btn) return console.log("[LVH] save button not found for jobId", jobId);
    if (isSaveButtonPressed(btn)) return console.log("[LVH] already saved", jobId);
    try { btn.click(); console.log("[LVH] clicked Save for jobId", jobId); }
    catch (e) { console.warn("[LVH] failed to click Save:", e); }
  }

  // API call
  const perJobCooldown = new Map();
  async function sendForJob(jobId, descriptionText) {
    if (!SETTINGS.apiUrl || !/^https?:\/\//i.test(SETTINGS.apiUrl)) {
      console.warn("[LVH] apiUrl not set or invalid");
      return;
    }
    if (!jobId || !descriptionText) return;
    const now = Date.now();
    const last = perJobCooldown.get(jobId) || 0;
    if (now - last < 1000) return;
    perJobCooldown.set(jobId, now);

    const body = buildRequestBody(descriptionText, jobId);
    try { console.log("[LVH] Request body:", JSON.stringify(body, null, 2)); }
    catch { console.log("[LVH] Request body (non-JSON):", body); }

    let text = "";
    try {
      const resp = await fetch(SETTINGS.apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(SETTINGS.apiKey ? { Authorization: `Bearer ${SETTINGS.apiKey}` } : {})
        },
        body: JSON.stringify(body)
      });
      text = await resp.text();
      console.log("[LVH] Response body (text):", text);
    } catch (e) {
      console.warn("[LVH] API call failed:", e);
      return;
    }

    try {
      const parsed = JSON.parse(text);
      const contentStr =
        parsed?.choices?.[0]?.message?.content ??
        parsed?.message?.content ??
        "";
      if (typeof contentStr === "string" && contentStr.trim()) {
        try {
          const verdictObj = JSON.parse(contentStr);
          const respJobId = verdictObj?.jobId || jobId;
          if (typeof verdictObj?.suitable === "boolean" && respJobId) {
            verdicts[respJobId] = verdictObj.suitable;
            saveVerdictsDebounced();
            const li =
              document.querySelector(
                `${CARD_SEL}[data-occludable-job-id="${respJobId}"]`
              ) ||
              document
                .querySelector(`${CARD_SEL} .job-card-container[data-job-id="${respJobId}"]`)
                ?.closest(CARD_SEL);
            if (li) paintTitle(li); else repaintAll();
            console.log("[LVH] verdict applied", respJobId, verdictObj.suitable);
            if (verdictObj.suitable === true) setTimeout(() => tryAutoSave(respJobId), 400);
            if (waitForVerdictResolvers.has(respJobId)) {
              waitForVerdictResolvers.get(respJobId)(verdictObj.suitable);
              waitForVerdictResolvers.delete(respJobId);
            }
          }
        } catch (e2) { console.warn("[LVH] message.content parse failed:", e2); }
      }
    } catch {}
  }

  // Description
  function getCurrentDescriptionText() {
    const pane =
      document.querySelector(".job-details-jobs-unified-top-card__container--two-pane") ||
      document.querySelector("#job-details") ||
      document.querySelector(".jobs-description-content") ||
      document.querySelector(DETAILS_CONTAINER_SEL);
    if (!pane) return "";
    const el =
      pane.querySelector(
        "[data-test-description], .jobs-description, .jobs-box__html-content, .jobs-description-content, #job-details"
      ) || pane;
    return (el.innerText || "").trim();
  }

  // Observers
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
  const mo = new MutationObserver((muts) => {
    let needScan = false;
    let sawActiveChange = false;
    for (const m of muts) {
      if (m.type === "attributes" && (m.attributeName === "class" || m.attributeName === "aria-current")) {
        if (m.target.matches?.(ACTIVE_SEL)) sawActiveChange = true;
        if (getCardLI(m.target)) sawActiveChange = true;
      }
      for (const n of m.addedNodes) {
        if (!(n instanceof Element)) continue;
        if (
          n.matches?.(CARD_SEL) || n.querySelector?.(CARD_SEL) ||
          n.matches?.(".job-card-container") || n.querySelector?.(".job-card-container") ||
          n.matches?.(FOOTER_SEL) || n.querySelector?.(FOOTER_SEL) ||
          n.matches?.(".job-details-jobs-unified-top-card__container--two-pane") ||
          n.querySelector?.(".job-details-jobs-unified-top-card__container--two-pane")
        ) needScan = true;
      }
    }
    if (needScan) scheduleScan();
    if (sawActiveChange) scheduleActiveCheck();
  });
  mo.observe(document.documentElement, {
    childList: true, subtree: true, attributes: true, attributeFilter: ["class", "aria-current"]
  });
  ["pushState", "replaceState"].forEach((fn) => {
    const orig = history[fn];
    history[fn] = function (...args) {
      const r = orig.apply(this, args);
      scheduleScan(); scheduleActiveCheck();
      return r;
    };
  });
  window.addEventListener("popstate", () => { scheduleScan(); scheduleActiveCheck(); });
  const intervalId = setInterval(() => {
    if (!verdictsLoaded) return;
    repaintAll();
    scheduleActiveCheck();
  }, 3000);
  window.addEventListener("beforeunload", () => {
    try { mo.disconnect(); } catch {}
    try { clearInterval(intervalId); } catch {}
  });

  // ======= Automation with virtualization-aware preload + next-page =======
  const waitForVerdictResolvers = new Map();
  function waitForVerdict(jobId, timeoutMs = 15000) {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        if (waitForVerdictResolvers.get(jobId) === resolve) {
          waitForVerdictResolvers.delete(jobId);
        }
        resolve(null);
      }, timeoutMs);
      waitForVerdictResolvers.set(jobId, (val) => { clearTimeout(t); resolve(val); });
    });
  }

  function getResultsScrollContainer() {
    // Find a scrollable ancestor of the first job card
    const first = document.querySelector('li[data-occludable-job-id]');
    let el = first ? first.parentElement : null;
    for (let i = 0; i < 6 && el; i++, el = el.parentElement) {
      const cs = getComputedStyle(el);
      if (/(auto|scroll)/.test(cs.overflowY)) return el;
    }
    // Fallback to a known container or document
    return (
      document.querySelector('.jobs-search-results-list') ||
      document.querySelector('.jobs-search-results') ||
      document.scrollingElement || document.documentElement
    );
  }

  async function collectAllJobsOnPage(maxScrolls = 30) {
    const map = new Map(); // id -> element
    let stableRounds = 0;
    let lastCount = 0;

    const scroller = getResultsScrollContainer();
    function harvest() {
      document.querySelectorAll(CARD_SEL).forEach((li) => {
        const id = getJobId(li);
        if (id) map.set(id, li);
      });
    }

    harvest();

    for (let i = 0; i < maxScrolls; i++) {
      // Scroll to bottom to force virtualization to load more
      scroller.scrollTop = scroller.scrollHeight;
      await sleep(350);
      harvest();

      if (map.size === lastCount) {
        stableRounds += 1;
        if (stableRounds >= 2) break; // no new items after two checks
      } else {
        stableRounds = 0;
        lastCount = map.size;
      }
    }

    // Scroll back to top to start in order
    scroller.scrollTop = 0;
    await sleep(150);

    // Return in DOM order using current NodeList but filter by collected IDs
    const order = [];
    const ids = new Set(map.keys());
    document.querySelectorAll(CARD_SEL).forEach((li) => {
      const id = getJobId(li);
      if (ids.has(id)) order.push(li);
    });
    // Append any left-over items not currently mounted
    for (const [id, el] of map) {
      if (!order.some((li) => getJobId(li) === id)) order.push(el);
    }
    console.log("[LVH] preload collected jobs:", map.size);
    return order.filter((li) => getTitleEl(li));
  }

  function getJobCardsQuick() {
    // Quick snapshot without preloading (used after page change)
    const listRoot =
      document.querySelector('.jobs-search-results-list') ||
      document.querySelector('[data-test-reusables-search__result-container]') ||
      document;
    return Array.from(listRoot.querySelectorAll(CARD_SEL)).filter((li) => getTitleEl(li));
  }

  async function processSingleJob(li) {
    const jobId = getJobId(li);
    const link = getTitleEl(li);
    if (!jobId || !link) return;
    link.click();
    console.log("[LVH] clicked job", jobId);
    await sleep(800);
    const desc = getCurrentDescriptionText();
    if (desc) sendForJob(jobId, desc);
    const verdict = await waitForVerdict(jobId);
    console.log("[LVH] verdict wait done", jobId, verdict);
    if (verdict === true) {
      tryAutoSave(jobId);
      await sleep(300);
    }
  }

  async function automateJobProcessing(maxPages = 40) {
    let pageCount = 0;
    while (pageCount < maxPages) {
      pageCount++;

      // Virtualization-aware preload on first pass of each page
      const jobs = await collectAllJobsOnPage();
      console.log("[LVH] automation: found", jobs.length, "jobs on page", pageCount);

      for (let i = 0; i < jobs.length; i++) {
        try { await processSingleJob(jobs[i]); }
        catch (e) { console.warn("[LVH] automation error on index", i, e); }
        await sleep(400);
      }

      console.log("[LVH] automation: page", pageCount, "done");
      const moved = await goToNextPage();
      if (!moved) break;
      await waitForJobListRefresh(10000);
    }
    console.log("[LVH] automation: finished");
  }

  // Next-page detection and navigation
  function findNextPageButton() {
    const candidates = [
      '.jobs-search-pagination__button.jobs-search-pagination__button--next',
      '.jobs-search-pagination__button--next',
      'button[aria-label="View next page"]',
      'button[aria-label*="Next"]',
      'a[aria-label*="Next"]',
      '.jobs-search-pagination button[aria-label="View next page"]',
      '.jobs-search-pagination button[aria-label*="Next"]',
      '.jobs-search-pagination a[aria-label*="Next"]',
      '.artdeco-pagination__button--next'
    ];
    for (const sel of candidates) {
      const btn = document.querySelector(sel);
      if (!btn) continue;
      const disabled = btn.disabled || btn.getAttribute("aria-disabled") === "true";
      if (!disabled && isVisible(btn)) return btn;
    }
    return null;
  }
  async function goToNextPage() {
    const btn = findNextPageButton();
    if (!btn) { console.log("[LVH] next page not found"); return false; }
    const oldUrl = location.href;
    try { btn.click(); } catch {}
    console.log("[LVH] next page clicked");
    const urlChanged = await waitForUrlChange(oldUrl, 6000);
    if (!urlChanged) console.log("[LVH] URL unchanged; waiting for list refresh");
    return true;
  }
  function waitForUrlChange(oldUrl, timeoutMs) {
    return new Promise((resolve) => {
      const start = Date.now();
      const id = setInterval(() => {
        if (location.href !== oldUrl) { clearInterval(id); resolve(true); }
        else if (Date.now() - start > timeoutMs) { clearInterval(id); resolve(false); }
      }, 120);
    });
  }
  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none" && el.offsetParent !== null;
  }
  async function waitForJobListRefresh(timeoutMs = 10000) {
    const beforeIds = getJobCardsQuick().map(getJobId).join(",");
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await sleep(300);
      const afterIds = getJobCardsQuick().map(getJobId).join(",");
      if (afterIds && afterIds !== beforeIds) {
        await sleep(300);
        return true;
      }
    }
    return false;
  }

  // Utils
  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  // Expose + popup trigger
  window.LVH_auto = automateJobProcessing;
  chrome.runtime?.onMessage?.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === "LVH_AUTO_START") {
      automateJobProcessing();
      sendResponse?.({ ok: true });
      return true;
    }
    return false;
  });
})();
