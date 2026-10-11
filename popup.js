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

function driveMsg(text, isError) {
  $("driveMsg").textContent = text;
  $("driveMsg").classList.toggle("err", !!isError);
}

async function renderDrive() {
  const s = await MT.getSettings();
  const connected = !!s.driveConnected;
  $("driveState").textContent = connected ? "Connected" : s.clientId ? "Not connected" : "Needs setup";
  $("driveState").classList.toggle("ok", connected);
  $("connect").hidden = connected;
  $("connect").disabled = !s.clientId;
  $("disconnect").hidden = !connected;
  if (!s.clientId) $("setup").open = true;
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

  $("driveEnabled").checked = s.driveEnabled;
  $("driveEnabled").addEventListener("change", (e) => MT.saveSettings({ driveEnabled: e.target.checked }));
  $("clientId").value = s.clientId;
  $("clientId").addEventListener("input", (e) => { MT.saveSettings({ clientId: e.target.value.trim() }); renderDrive(); });
  $("redirect").value = chrome.identity.getRedirectURL();
  $("redirect").addEventListener("focus", (e) => e.target.select());
  $("connect").addEventListener("click", async () => {
    driveMsg("Opening Google sign-in…");
    const r = await chrome.runtime.sendMessage({ type: "connectDrive" });
    driveMsg(r.ok ? "Connected. New calls will be saved to Drive." : r.error, !r.ok);
    renderDrive();
  });
  $("disconnect").addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "disconnectDrive" });
    driveMsg("");
    renderDrive();
  });
  renderDrive();
  await refresh();
  setInterval(refresh, 2000);
}

init();
