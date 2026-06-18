// === LinkedIn Verdict Helper (content.js) — sharded storage ===
(() => {
  if (window.__LVH_RUNNING__) return;
  window.__LVH_RUNNING__ = true;

  // ---------- selectors ----------
  const STATE_RE = /\b(Viewed|Applied|Saved)\b/i;
  const CARD_SEL = 'div[componentkey^="job-card-component-ref-"], li[data-occludable-job-id], li.scaffold-layout__list-item, li.occludable-update';
  const FOOTER_SEL = ".job-card-container__footer-wrapper li, .job-card-container__footer-item, .job-card-container__footer-job-state";
  const INNER_CARD_SEL = ".job-card-container";
  const DETAILS_CONTAINER_SEL = 'div[data-sdui-screen="com.linkedin.sdui.flagshipnav.jobs.SemanticJobDetails"], .jobs-description, .jobs-description__content, #job-details';
  const ACTIVE_SEL = '.jobs-search-results-list__list-item--active, [aria-current="page"]';

  // ---------- settings ----------
  let SETTINGS = { apiUrl: "", apiKey: "", requestPayload: "" };
  chrome.storage.sync.get(["apiUrl", "apiKey", "requestPayload"]).then((v) => {
    SETTINGS = { apiUrl: v.apiUrl || "", apiKey: v.apiKey || "", requestPayload: v.requestPayload || "" };
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    if (changes.apiUrl) SETTINGS.apiUrl = changes.apiUrl.newValue || "";
    if (changes.apiKey) SETTINGS.apiKey = changes.apiKey.newValue || "";
    if (changes.requestPayload) SETTINGS.requestPayload = changes.requestPayload.newValue || "";
  });

  // ---------- style ----------
  (function ensureStyle() {
    if (document.getElementById("lvh-style")) return;
    const style = document.createElement("style");
    style.id = "lvh-style";
    style.textContent = `
      .lvh-title-red    { color: #d32f2f !important; }
      .lvh-title-green  { color: #2e7d32 !important; }
      .lvh-title-purple { color: #6a1b9a !important; }
      /* Fallback for new layout where we might color the whole card text */
      div[componentkey^="job-card-component-ref-"].lvh-title-red span    { color: #d32f2f !important; }
      div[componentkey^="job-card-component-ref-"].lvh-title-green span  { color: #2e7d32 !important; }
      div[componentkey^="job-card-component-ref-"].lvh-title-purple span { color: #6a1b9a !important; }
    `;
    document.head.appendChild(style);
  })();

  // ---------- verdict storage (sharded) ----------
  const SHARD_PREFIX = "lvhs:";
  const SHARD_SIZE = 300;
  const shards = new Map();
  const jobToShard = new Map();
  const verdicts = Object.create(null);
  let verdictsLoaded = false;

  function shardIndexFromKey(k) {
    const m = k.match(/^lvhs:(\d{4})$/);
    return m ? parseInt(m[1], 10) : null;
  }
  function nextShardKey() {
    let maxIdx = 0;
    for (const k of shards.keys()) {
      const idx = shardIndexFromKey(k);
      if (idx !== null) maxIdx = Math.max(maxIdx, idx);
    }
    const next = (maxIdx || 0) + 1;
    return `${SHARD_PREFIX}${String(next).padStart(4, "0")}`;
  }
  function chooseShardForNew() {
    let bestKey = null, bestSize = -1;
    for (const [k, obj] of shards) {
      const size = Object.keys(obj).length;
      if (size < SHARD_SIZE && size > bestSize) { bestKey = k; bestSize = size; }
    }
    return bestKey || nextShardKey();
  }

  async function loadVerdictsSharded() {
    const all = await chrome.storage.sync.get(null);
    for (const [k, v] of Object.entries(all || {})) {
      if (!k.startsWith(SHARD_PREFIX)) continue;
      if (!v || typeof v !== "object") continue;
      shards.set(k, v);
      for (const [jid, bit] of Object.entries(v)) {
        verdicts[jid] = !!bit;
        jobToShard.set(jid, k);
      }
    }
    verdictsLoaded = true;
    repaintAll();
  }

  async function saveVerdictSharded(jobId, suitable) {
    const bit = suitable ? 1 : 0;
    let key = jobToShard.get(jobId);
    if (!key) {
      key = chooseShardForNew();
      if (!shards.has(key)) shards.set(key, {});
      jobToShard.set(jobId, key);
    }
    const obj = shards.get(key) || {};
    obj[jobId] = bit;
    shards.set(key, obj);
    await chrome.storage.sync.set({ [key]: obj });
  }

  function watchShards() {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "sync") return;
      let touched = false;
      for (const [k, ch] of Object.entries(changes)) {
        if (!k.startsWith(SHARD_PREFIX)) continue;
        const newObj = ch.newValue || {};
        shards.set(k, newObj);
        for (const jid of Object.keys(verdicts)) {
          if (jobToShard.get(jid) === k && !(jid in newObj)) {
            delete verdicts[jid];
            jobToShard.delete(jid);
            touched = true;
          }
        }
        for (const [jid, bit] of Object.entries(newObj)) {
          verdicts[jid] = !!bit;
          jobToShard.set(jid, k);
          touched = true;
        }
      }
      if (touched) repaintAll();
    });
  }

  loadVerdictsSharded();
  watchShards();

  // ---------- dom helpers ----------
  const getCardLI = (el) => el.closest?.(CARD_SEL) || null;
  const getInnerCard = (li) => li.querySelector(INNER_CARD_SEL) || li;

  const getTitleEl = (li) => {
    if (li.hasAttribute("componentkey")) return li;
    return getInnerCard(li).querySelector('a.job-card-container__link, a[href*="/jobs/view/"]');
  };

  function getJobId(li) {
    const compKey = li.getAttribute("componentkey");
    if (compKey && compKey.startsWith("job-card-component-ref-")) {
      return compKey.replace("job-card-component-ref-", "");
    }
    const inner = getInnerCard(li);
    return inner.getAttribute("data-job-id") || li.getAttribute("data-occludable-job-id") || "";
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

  function repaintAll(root = document) { root.querySelectorAll(CARD_SEL).forEach(paintTitle); }
  function scan(root = document) { root.querySelectorAll(CARD_SEL).forEach(paintTitle); scheduleActiveCheck(); }

  // ---------- active tracking ----------
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
      let jobId = li ? getJobId(li) : getCurrentJobIdFromPane();

      if (!jobId || jobId === lastActiveJobId) return;
      lastActiveJobId = jobId;

      setTimeout(async () => {
        const desc = await getCurrentDescriptionTextAsync();
        if (desc) sendForJob(jobId, desc);
        if (li) paintTitle(li);
      }, 350);
    }, 120);
  }

  // ---------- request body ----------
  function buildRequestBody(descriptionText, jobId) {
    let body = {};
    try { body = JSON.parse(SETTINGS.requestPayload || "{}"); }
    catch { body = {}; }
    if (body && typeof body === "object") {
      const msgs = body.messages;
      if (Array.isArray(msgs)) {
        const userMsg = msgs.find((m) => m && m.role === "user");
        if (userMsg) userMsg.content = JSON.stringify({ jobId, description: descriptionText || "" });
      }
    }
    return body;
  }

  // ---------- save button helpers ----------
  // ---------- save button helpers ----------
  const saveClickCooldown = new Map();

  function getCurrentJobIdFromPane() {
    // 1. Safest method: LinkedIn always puts the current job ID in the URL
    const url = new URL(window.location.href);
    const currentJobId = url.searchParams.get("currentJobId");
    if (currentJobId) return currentJobId;

    // 2. Fallback for single job view pages
    const viewMatch = url.pathname.match(/\/jobs\/view\/(\d+)/);
    if (viewMatch) return viewMatch[1];

    // 3. Fallback to DOM if URL parsing fails
    const a = document.querySelector('.job-details-jobs-unified-top-card__job-title a[href*="/jobs/view/"], .job-details-jobs-unified-top-card__job-title-link');
    if (a && a.href) {
      const m = a.href.match(/\/jobs\/view\/(\d+)/);
      if (m) return m[1];
    }

    return null;
  }

  function findSaveButtonInPane() {
    // 1. Direct class match (LinkedIn's current standard class for this button)
    let btn = document.querySelector('button.jobs-save-button');
    if (btn) return btn;

    // 2. Fallback: Search all buttons in the top card area for "Save" text/aria-labels
    const paneRoot = document.querySelector(".job-details-jobs-unified-top-card__container--two-pane") ||
      document.querySelector(".jobs-details-top-card") ||
      document.querySelector(DETAILS_CONTAINER_SEL) ||
      document;

    const buttons = paneRoot.querySelectorAll('button');
    for (const b of buttons) {
      const text = (b.innerText || "").trim().toLowerCase();
      const aria = (b.getAttribute("aria-label") || "").toLowerCase();

      // Match exact "save" to avoid clicking other random buttons
      if (text === "save" || aria === "save" || aria.includes("save job")) {
        return b;
      }
    }
    return null;
  }

  function isSaveButtonPressed(btn) {
    const aria = btn.getAttribute("aria-pressed");
    const txt = (btn.innerText || "").trim();
    return aria === "true" || btn.classList.contains("artdeco-button--pressed") || /\bSaved|Unsave|Saved job/i.test(txt);
  }

  function tryAutoSave(jobId) {
    const current = getCurrentJobIdFromPane();
    if (!current || current !== jobId) return;
    const now = Date.now();
    const last = saveClickCooldown.get(jobId) || 0;
    if (now - last < 1500) return;
    saveClickCooldown.set(jobId, now);
    const btn = findSaveButtonInPane();
    if (!btn || isSaveButtonPressed(btn)) return;
    try { btn.click(); } catch { }
  }

  // ---------- api call ----------
  const pendingRequests = new Set();
  const perJobCooldown = new Map();
  const forcedJobChecks = new Set(); // Tracks jobs manually clicked by user

  async function sendForJob(jobId, descriptionText) {
    if (!SETTINGS.apiUrl || !/^https?:\/\//i.test(SETTINGS.apiUrl)) return;
    if (!jobId || !descriptionText) return;

    const isForced = forcedJobChecks.has(jobId);

    // Prevent requesting if we already know the verdict, UNLESS manually forced by a click
    if (!isForced && jobId in verdicts) return;

    // Consume the flag so we don't infinitely re-trigger
    if (isForced) forcedJobChecks.delete(jobId);

    // Prevent requesting if we are already waiting for OpenAI
    if (pendingRequests.has(jobId)) return;

    // Keep the minor cooldown for double-fire edge cases (bypass if forced)
    const now = Date.now();
    const last = perJobCooldown.get(jobId) || 0;
    if (!isForced && now - last < 1000) return;
    perJobCooldown.set(jobId, now);

    // Mark this job as currently processing
    pendingRequests.add(jobId);

    const body = buildRequestBody(descriptionText, jobId);
    console.log('[LVH] request body', body);

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
      console.log('[LVH] response body', text);
    } catch {
      pendingRequests.delete(jobId);
      return;
    }

    try {
      const parsed = JSON.parse(text);
      const contentStr =
        parsed?.choices?.[0]?.message?.content ??
        parsed?.message?.content ?? "";

      if (typeof contentStr === "string" && contentStr.trim()) {
        const verdictObj = JSON.parse(contentStr);
        const respJobId = verdictObj?.jobId || jobId;

        if (typeof verdictObj?.suitable === "boolean" && respJobId) {
          verdicts[respJobId] = verdictObj.suitable;
          await saveVerdictSharded(respJobId, verdictObj.suitable);

          const li =
            document.querySelector(`${CARD_SEL}[componentkey="job-card-component-ref-${respJobId}"]`) ||
            document.querySelector(`${CARD_SEL}[data-occludable-job-id="${respJobId}"]`) ||
            document.querySelector(`${CARD_SEL} .job-card-container[data-job-id="${respJobId}"]`)?.closest(CARD_SEL);

          if (li) paintTitle(li); else repaintAll();

          if (verdictObj.suitable === true) setTimeout(() => tryAutoSave(respJobId), 400);

          if (waitForVerdictResolvers.has(respJobId)) {
            waitForVerdictResolvers.get(respJobId)(verdictObj.suitable);
            waitForVerdictResolvers.delete(respJobId);
          }
        }
      }
    } catch (e) {
      console.error('[LVH] Error parsing response', e);
    } finally {
      // Always remove the job from pending once processing is totally done
      pendingRequests.delete(jobId);
    }
  }

  // ---------- async description picker ----------
  async function getCurrentDescriptionTextAsync() {
    const pane = document.querySelector(DETAILS_CONTAINER_SEL) || document;

    const moreBtn = pane.querySelector('button[data-testid="expandable-text-button"]');
    if (moreBtn && isVisible(moreBtn)) {
      try {
        moreBtn.click();
        await sleep(150);
      } catch (e) { }
    }

    const newTextBox = pane.querySelector('span[data-testid="expandable-text-box"]');
    if (newTextBox) return newTextBox.innerText.trim();

    const pickVisible = (nodes) =>
      Array.from(nodes).find((el) => {
        const cs = getComputedStyle(el);
        return el.offsetParent !== null && cs.display !== "none" && cs.visibility !== "hidden";
      });

    let el =
      pickVisible(document.querySelectorAll('#job-details')) ||
      pickVisible(document.querySelectorAll('.jobs-box__html-content#job-details')) ||
      pickVisible(document.querySelectorAll('.jobs-description-content__text--stretch')) ||
      pickVisible(document.querySelectorAll('[data-test-description]')) ||
      pickVisible(document.querySelectorAll('.jobs-description, .jobs-box__html-content, .jobs-description-content'));

    if (!el) {
      el =
        pickVisible(pane.querySelectorAll('#job-details, .jobs-box__html-content#job-details')) ||
        pickVisible(pane.querySelectorAll('[data-test-description], .jobs-description, .jobs-box__html-content, .jobs-description-content')) ||
        pane;
    }
    return (el?.innerText || "").trim();
  }

  // ---------- observers & manual click tracking ----------
  let scanPending = false;
  function scheduleScan(target) {
    if (scanPending) return;
    scanPending = true;
    setTimeout(() => { scanPending = false; scan(target || document); }, 120);
  }

  (function initial() { scan(); scheduleActiveCheck(); })();

  // Track explicit manual clicks by the human user
  document.addEventListener("click", (e) => {
    if (!e.isTrusted) return; // Ignore automated link.click() from script

    const li = getCardLI(e.target);
    if (li) {
      const jobId = getJobId(li);
      if (jobId) {
        forcedJobChecks.add(jobId);
        // Clear active ID so scheduleActiveCheck runs even if clicking the currently active job
        lastActiveJobId = null;
        scheduleActiveCheck();
      }
    }
  }, true);

  const mo = new MutationObserver((muts) => {
    let needScan = false, sawActive = false;
    for (const m of muts) {
      if (m.type === "attributes" && (m.attributeName === "class" || m.attributeName === "aria-current")) {
        if (m.target.matches?.(ACTIVE_SEL)) sawActive = true;
        if (getCardLI(m.target)) sawActive = true;
      }
      for (const n of m.addedNodes) {
        if (!(n instanceof Element)) continue;
        if (
          n.matches?.(CARD_SEL) || n.querySelector?.(CARD_SEL) ||
          n.matches?.(".job-card-container") || n.querySelector?.(".job-card-container") ||
          n.matches?.(FOOTER_SEL) || n.querySelector?.(FOOTER_SEL) ||
          n.matches?.(".job-details-jobs-unified-top-card__container--two-pane") ||
          n.querySelector?.(".job-details-jobs-unified-top-card__container--two-pane") ||
          n.matches?.(DETAILS_CONTAINER_SEL) || n.querySelector?.(DETAILS_CONTAINER_SEL)
        ) needScan = true;
      }
    }
    if (needScan) scheduleScan();
    if (sawActive) scheduleActiveCheck();
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
    try { mo.disconnect(); } catch { }
    try { clearInterval(intervalId); } catch { }
  });

  // ---------- automation ----------
  const waitForVerdictResolvers = new Map();

  function waitForVerdict(jobId, timeoutMs = 15000) {
    if (jobId in verdicts) {
      return Promise.resolve(verdicts[jobId]);
    }

    return new Promise((resolve) => {
      const t = setTimeout(() => {
        if (waitForVerdictResolvers.get(jobId) === resolve) waitForVerdictResolvers.delete(jobId);
        resolve(null);
      }, timeoutMs);
      waitForVerdictResolvers.set(jobId, (val) => { clearTimeout(t); resolve(val); });
    });
  }

  function getResultsScrollContainer() {
    const first = document.querySelector(CARD_SEL);
    let el = first ? first.parentElement : null;
    for (let i = 0; i < 6 && el; i++, el = el.parentElement) {
      const cs = getComputedStyle(el);
      if (/(auto|scroll)/.test(cs.overflowY)) return el;
    }
    return (
      document.querySelector('.left-column-results-container') ||
      document.querySelector('.jobs-search-results-list') ||
      document.querySelector('.jobs-search-results') ||
      document.scrollingElement || document.documentElement
    );
  }

  async function gradualFillAndHarvest(durationMs = 3000) {
    const scroller = getResultsScrollContainer();
    const map = new Map();
    function harvest() {
      document.querySelectorAll(CARD_SEL).forEach((li) => {
        const id = getJobId(li);
        if (id) map.set(id, li);
      });
    }
    harvest();
    const start = performance.now();
    let lastHeight = 0;
    while (true) {
      const now = performance.now();
      const t = Math.min(1, (now - start) / durationMs);
      const ease = t * (2 - t);
      const target = scroller.scrollHeight - scroller.clientHeight;
      scroller.scrollTop = target * ease;
      await sleep(60);
      harvest();
      const nearEnd = (target - scroller.scrollTop) < 8;
      const h = scroller.scrollHeight;
      if (nearEnd && Math.abs(h - lastHeight) < 2 && t >= 1) break;
      lastHeight = h;
      if (t >= 1 && !nearEnd) continue;
    }
    for (let i = 0; i < 6; i++) { scroller.scrollTop = scroller.scrollHeight; await sleep(120); harvest(); }
    scroller.scrollTop = 0; await sleep(200);
    const ordered = [];
    const ids = new Set(map.keys());
    document.querySelectorAll(CARD_SEL).forEach((li) => {
      const id = getJobId(li);
      if (ids.has(id)) ordered.push(li);
    });
    for (const [id, el] of map) {
      if (!ordered.some((li) => getJobId(li) === id)) ordered.push(el);
    }
    return ordered.filter((li) => getTitleEl(li));
  }

  function getJobCardsQuick() {
    const listRoot =
      document.querySelector('.left-column-results-container') ||
      document.querySelector('.jobs-search-results-list') ||
      document.querySelector('[data-test-reusables-search__result-container]') ||
      document;
    return Array.from(listRoot.querySelectorAll(CARD_SEL)).filter((li) => getTitleEl(li));
  }

  async function processSingleJob(li) {
    const jobId = getJobId(li);
    const link = getTitleEl(li);
    if (!jobId || !link) return;

    if (jobId in verdicts) return;

    link.click();
    await sleep(800);
    const desc = await getCurrentDescriptionTextAsync();
    if (desc) sendForJob(jobId, desc);

    const verdict = await waitForVerdict(jobId);
    if (verdict === true) { tryAutoSave(jobId); await sleep(300); }
  }

  async function automateJobProcessing(maxPages = 40) {
    let pageCount = 0;
    while (pageCount < maxPages) {
      pageCount++;
      await sleep(2000);
      const jobs = await gradualFillAndHarvest(2000);
      const jobsToProcess = jobs.filter((li) => {
        const id = getJobId(li);
        return id && !(id in verdicts);
      });
      for (let i = 0; i < jobsToProcess.length; i++) {
        try { await processSingleJob(jobsToProcess[i]); } catch { }
        await sleep(400);
      }
      const moved = await goToNextPage();
      if (!moved) break;
      await waitForJobListRefresh(2000);
    }
  }

  function findNextPageButton() {
    const candidates = [
      'button[data-testid="pagination-controls-next-button-visible"]',
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
    if (!btn) return false;
    const oldUrl = location.href;
    try { btn.click(); } catch { }
    await waitForUrlChange(oldUrl, 6000);
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
      if (afterIds && afterIds !== beforeIds) { await sleep(300); return true; }
    }
    return false;
  }

  // ---------- utils ----------
  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  // ---------- expose automation ----------
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