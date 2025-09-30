const btn = document.getElementById("startAuto");
const statusEl = document.getElementById("status");

function setStatus(text, ok = true) {
  statusEl.textContent = text;
  statusEl.className = ok ? "ok" : "err";
}

btn.onclick = async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return setStatus("No active tab.", false);
    if (!/^https:\/\/(www\.)?linkedin\.com\/jobs/.test(tab.url || "")) {
      return setStatus("Open a LinkedIn Jobs tab.", false);
    }

    await chrome.tabs.sendMessage(tab.id, { type: "LVH_AUTO_START" });
    setStatus("Automation started.");
  } catch (err) {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
      await chrome.tabs.sendMessage(tab.id, { type: "LVH_AUTO_START" });
      setStatus("Automation started.");
    } catch (e2) {
      console.error(e2);
      setStatus("Failed to start. Reload the tab.", false);
    }
  }
};
