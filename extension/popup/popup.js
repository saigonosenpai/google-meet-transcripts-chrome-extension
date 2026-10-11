const $ = (id) => document.getElementById(id);
let tab = null;
let current = null;

// Pages the recorder runs on, matching the manifest's content scripts.
const CALL_PAGES = /^https:\/\/(meet\.google\.com|teams\.microsoft\.com|teams\.live\.com|teams\.cloud\.microsoft|([\w-]+\.)?zoom\.us\/wc)\//;

async function refresh() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  current = null;
  if (tab && CALL_PAGES.test(tab.url || "")) {
    try { current = await chrome.tabs.sendMessage(tab.id, { type: "getStatus" }); } catch {}
  }
  render();
}

function render() {
  const dot = $("dot"), state = $("state"), detail = $("detail");
  dot.className = "dot";
  $("meetActions").hidden = !current || !current.inMeeting;
  $("diagnose").hidden = !current || !current.inMeeting || current.paused || (current.captionsOn && current.count > 0);
  if (!current) {
    state.textContent = "Not in a call";
    detail.textContent = tab && CALL_PAGES.test(tab.url || "")
      ? "Reload this tab so the recorder can start."
      : "Join a Google Meet, Teams or Zoom call in Chrome and its captions are recorded automatically.";
    return;
  }
  const where = MT.PLATFORMS[current.platform].name;
  if (current.disabled) {
    state.textContent = "Not recording " + where;
    detail.textContent = "Turned off below, under Record calls in.";
    return;
  }
  if (!current.inMeeting) {
    state.textContent = "Waiting for a call";
    detail.textContent = "";
    return;
  }
  $("pause").textContent = current.paused ? "Resume" : "Pause";
  $("viewCurrent").disabled = !current.meetingId;
  if (current.paused) {
    dot.classList.add("warn");
    state.textContent = "Paused";
  } else if (current.captionsOn) {
    dot.classList.add("rec");
    state.textContent = "Recording · " + MT.PLATFORMS[current.platform].short;
  } else {
    dot.classList.add("warn");
    state.textContent = "Captions are off";
  }
  detail.textContent = current.captionsOn || current.count
    ? `${current.title} · ${current.count} line${current.count === 1 ? "" : "s"} captured`
    : current.captionHint + " The transcript comes from the call's live captions.";
}

async function fileRecords() {
  const all = await chrome.storage.local.get(null);
  return Object.entries(all).filter(([k]) => k.startsWith("f:")).map(([, v]) => v);
}

async function latestFile() {
  return (await fileRecords()).filter((f) => f.downloadId).sort((a, b) => b.savedAt - a.savedAt)[0] || null;
}

async function renderFiles() {
  const f = await latestFile();
  const name = f ? f.filename.split(/[\\/]/).pop().replace(/^\d{4}-\d{2}-\d{2} - /, "").replace(/\.docx$/, "") : "";
  $("lastSaved").textContent = name ? `Last saved: ${name}.` : "";
  const blocked = (await fileRecords()).some((r) => r.error && r.askSetting);
  $("askWarning").hidden = !blocked;
}

async function init() {
  const s = await MT.getSettings();
  $("hideCaptions").checked = s.hideCaptions;
  $("showIndicator").checked = s.showIndicator;
  $("myName").value = s.myName;
  for (const box of document.querySelectorAll(".platform")) {
    box.checked = s.platforms[box.dataset.platform] !== false;
    box.addEventListener("change", async () => {
      const { platforms } = await MT.getSettings();
      await MT.saveSettings({ platforms: { ...platforms, [box.dataset.platform]: box.checked } });
      setTimeout(refresh, 150);
    });
  }
  $("diagnose").addEventListener("click", async () => {
    let report;
    try { report = await chrome.tabs.sendMessage(tab.id, { type: "diagnose" }); } catch {}
    await navigator.clipboard.writeText(JSON.stringify(report || { error: "the page didn't answer" }, null, 2));
    $("diagnose").textContent = "Copied. Paste it into a GitHub issue (it has no transcript text).";
  });
  for (const id of ["hideCaptions", "showIndicator"]) {
    $(id).addEventListener("change", (e) => MT.saveSettings({ [id]: e.target.checked }));
  }
  $("myName").addEventListener("input", (e) => MT.saveSettings({ myName: e.target.value.trim() }));
  $("pause").addEventListener("click", async () => {
    await MT.saveSettings({ paused: !(await MT.getSettings()).paused });
    setTimeout(refresh, 100);
  });
  $("viewCurrent").addEventListener("click", async () => {
    try { await chrome.tabs.sendMessage(tab.id, { type: "flush" }); } catch {}
    chrome.tabs.create({ url: chrome.runtime.getURL("viewer/viewer.html#" + encodeURIComponent(current.meetingId)) });
  });
  $("openViewer").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("viewer/viewer.html") }));

  $("autoSave").checked = s.autoSave;
  $("autoSave").addEventListener("change", (e) => MT.saveSettings({ autoSave: e.target.checked }));
  $("showFolder").addEventListener("click", async () => {
    const f = await latestFile();
    chrome.runtime.sendMessage({ type: "showFile", downloadId: f && f.downloadId });
  });
  $("dlSettings").addEventListener("click", () => chrome.runtime.sendMessage({ type: "openDownloadSettings" }));
  renderFiles();
  await refresh();
  setInterval(refresh, 2000);
}

init();
