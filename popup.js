const $ = (id) => document.getElementById(id);
let tab = null;
let current = null;

async function refresh() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  current = null;
  if (tab && /^https:\/\/meet\.google\.com\//.test(tab.url || "")) {
    try { current = await chrome.tabs.sendMessage(tab.id, { type: "getStatus" }); } catch {}
  }
  render();
}

function render() {
  const dot = $("dot"), state = $("state"), detail = $("detail");
  dot.className = "dot";
  $("meetActions").hidden = !current || !current.inMeeting;
  if (!current) {
    state.textContent = "Not on a Google Meet call";
    detail.textContent = tab && /meet\.google\.com/.test(tab.url || "")
      ? "Reload the Meet tab so the recorder can start."
      : "Join a meeting and captions will be recorded automatically.";
    return;
  }
  if (!current.inMeeting) {
    state.textContent = "Waiting for a meeting";
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
    state.textContent = "Recording";
  } else {
    dot.classList.add("warn");
    state.textContent = "Captions are off";
  }
  detail.textContent = current.captionsOn || current.count
    ? `${current.title} · ${current.count} line${current.count === 1 ? "" : "s"} captured`
    : "Turn on captions (CC button, or press c) — the transcript comes from Meet's live captions.";
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
  $("autoCaptions").checked = s.autoCaptions;
  $("hideCaptions").checked = s.hideCaptions;
  $("myName").value = s.myName;
  for (const id of ["autoCaptions", "hideCaptions"]) {
    $(id).addEventListener("change", (e) => MT.saveSettings({ [id]: e.target.checked }));
  }
  $("myName").addEventListener("input", (e) => MT.saveSettings({ myName: e.target.value.trim() }));
  $("pause").addEventListener("click", async () => {
    await MT.saveSettings({ paused: !(await MT.getSettings()).paused });
    setTimeout(refresh, 100);
  });
  $("viewCurrent").addEventListener("click", async () => {
    try { await chrome.tabs.sendMessage(tab.id, { type: "flush" }); } catch {}
    chrome.tabs.create({ url: "viewer.html#" + encodeURIComponent(current.meetingId) });
  });
  $("openViewer").addEventListener("click", () => chrome.tabs.create({ url: "viewer.html" }));

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
