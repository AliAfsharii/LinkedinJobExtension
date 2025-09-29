const runBtn = document.getElementById("run");
const out = document.getElementById("out");

runBtn.onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  // Inject and run content.js on the active tab
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["content.js"],
  });

  // Ask the page for results
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => window.__JOB_SCRAPER__?.() || null,
  });

  out.textContent = JSON.stringify(result, null, 2) || "No result";
};
