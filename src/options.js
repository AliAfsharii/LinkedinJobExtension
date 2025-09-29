// Load saved settings
(async function init() {
  const { apiUrl = "", apiKey = "" } = await chrome.storage.sync.get(["apiUrl", "apiKey"]);
  document.getElementById("apiUrl").value = apiUrl;
  document.getElementById("apiKey").value = apiKey;
})();

// Save settings
document.getElementById("save").addEventListener("click", async () => {
  const apiUrl = document.getElementById("apiUrl").value.trim();
  const apiKey = document.getElementById("apiKey").value.trim();
  await chrome.storage.sync.set({ apiUrl, apiKey });
  const status = document.getElementById("status");
  status.textContent = "Saved.";
  setTimeout(() => (status.textContent = ""), 1200);
});
