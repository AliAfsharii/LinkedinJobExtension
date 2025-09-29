(async function () {
  const apiUrlEl = document.getElementById('apiUrl');
  const apiKeyEl = document.getElementById('apiKey');
  const payloadEl = document.getElementById('requestPayload');
  const statusEl = document.getElementById('status');
  const saveBtn = document.getElementById('save');
  const resetBtn = document.getElementById('reset');

  function examplePayload() {
    return JSON.stringify(
      {
        messages: [
          { role: "system", content: "You are a job screener. Reply ONLY with a JSON object as a single line string in the assistant message content. Shape: {\"jobId\": string, \"suitable\": true|false }" },
          { role: "user", content: "(job description will be injected here)" }
        ]
      },
      null,
      2
    );
  }

  // Load current settings
  const saved = await chrome.storage.sync.get(["apiUrl", "apiKey", "requestPayload"]);
  apiUrlEl.value = saved.apiUrl || "";
  apiKeyEl.value = saved.apiKey || "";
  payloadEl.value = saved.requestPayload || examplePayload();

  saveBtn.addEventListener('click', async () => {
    const apiUrl = apiUrlEl.value.trim();
    const apiKey = apiKeyEl.value.trim();
    const requestPayload = payloadEl.value.trim();

    // Light validation
    try { JSON.parse(requestPayload); }
    catch {
      statusEl.textContent = "Payload must be valid JSON.";
      statusEl.style.color = "#d32f2f";
      return;
    }

    await chrome.storage.sync.set({ apiUrl, apiKey, requestPayload });
    statusEl.textContent = "Saved.";
    statusEl.style.color = "#2e7d32";
    setTimeout(() => (statusEl.textContent = ""), 1500);
  });

  resetBtn.addEventListener('click', () => {
    payloadEl.value = examplePayload();
  });
})();
