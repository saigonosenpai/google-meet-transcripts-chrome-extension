const $ = (id) => document.getElementById(id);
// Apple system colors, readable behind white initials in light and dark.
const COLORS = ["#007aff", "#ff9500", "#34c759", "#af52de", "#ff2d55", "#5ac8fa", "#a2845e", "#5856d6"];

let meetings = [];
let current = null;   // meeting meta
let entries = [];
let filter = "all";
let query = "";
let libQuery = "";
let libIndex = null;  // id -> lowercased transcript text, built on first library search

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function highlight(text) {
  const safe = esc(text);
  if (!query) return safe;
  const re = new RegExp(esc(query).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  return safe.replace(re, (m) => `<mark>${m}</mark>`);
}

const initials = (name) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";

const avatar = (name, color) => `<span class="avatar" style="--c:${color}">${esc(initials(name))}</span>`;

// A toast that rises from the bottom; with `action`, it offers one button (e.g. Undo) and stays longer.
function toast(msg, action) {
  const t = $("toast"), btn = $("toastAction");
  $("toastText").textContent = msg;
  btn.hidden = !action;
  btn.onclick = null;
  if (action) {
    btn.textContent = action.label;
    btn.onclick = () => { hideToast(); action.run(); };
  }
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(hideToast, action ? 6000 : 2200);
}

function hideToast() {
  clearTimeout(toast.timer);
  $("toast").classList.remove("show");
}

// --- library ------------------------------------------------------------------------------

async function loadLibrary() {
  meetings = await MT.listMeetings();
  renderList();
}

async function buildIndex() {
  const all = await chrome.storage.local.get(null);
  libIndex = {};
  for (const m of meetings) {
    libIndex[m.id] = (MT.title(m) + " " + (m.speakers || []).join(" ") + " " +
      (all["t:" + m.id] || []).map((e) => e.text).join(" ")).toLowerCase();
  }
}

function renderList() {
  const list = $("list");
  const q = libQuery.toLowerCase();
  const shown = meetings.filter((m) => !q || (libIndex && libIndex[m.id]
    ? libIndex[m.id].includes(q)
    : (MT.title(m) + " " + (m.speakers || []).join(" ")).toLowerCase().includes(q)));
  $("emptyLib").hidden = meetings.length > 0;
  let lastDay = "";
  list.innerHTML = "";
  for (const m of shown) {
    const day = new Date(m.startedAt).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
    if (day !== lastDay) {
      const d = document.createElement("li");
      d.className = "day";
      d.textContent = day;
      list.append(d);
      lastDay = day;
    }
    const li = document.createElement("li");
    li.className = current && current.id === m.id ? "on" : "";
    const time = new Date(m.startedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    li.tabIndex = 0;
    li.innerHTML = `<div class="t"></div><div class="s"></div>`;
    li.querySelector(".t").textContent = MT.title(m);
    li.querySelector(".s").textContent = `${time} · ${MT.PLATFORMS[MT.platformOf(m)].short} · ${MT.duration(m)} · ` +
      `${(m.speakers || []).length} speaker${(m.speakers || []).length === 1 ? "" : "s"}`;
    li.addEventListener("click", () => { location.hash = encodeURIComponent(m.id); });
    li.addEventListener("keydown", (e) => { if (e.key === "Enter") location.hash = encodeURIComponent(m.id); });
    list.append(li);
  }
  if (q && !shown.length) list.innerHTML = `<li class="day">No meetings match</li>`;
}

// --- one meeting --------------------------------------------------------------------------

async function openMeeting(id) {
  current = meetings.find((m) => m.id === id) || null;
  $("placeholder").hidden = !!current;
  $("meeting").hidden = !current;
  renderList();
  if (!current) return;
  entries = await MT.getTranscript(id);
  document.title = MT.title(current) + " · " + MT.APP;
  // Turns rise in when a meeting opens, not on every live update.
  const list = $("transcript");
  list.classList.add("entering");
  setTimeout(() => list.classList.remove("entering"), 400);
  renderMeeting();
  document.querySelector("main").scrollTo(0, 0);
  requestAnimationFrame(placeThumb);
}

function speakerColors() {
  const map = {};
  (current.speakers || []).forEach((s, i) => (map[s] = COLORS[i % COLORS.length]));
  return map;
}

function renderMeeting() {
  const colors = speakerColors();
  $("title").textContent = MT.title(current);
  $("meta").textContent = `${MT.platformName(current)} · ${MT.dateTime(current.startedAt)} · ${MT.duration(current)}`;

  // Talk share by word count.
  const wordsBy = {};
  let total = 0;
  for (const e of entries) {
    const n = e.text.split(/\s+/).length;
    wordsBy[e.speaker] = (wordsBy[e.speaker] || 0) + n;
    total += n;
  }
  $("speakers").innerHTML = Object.entries(wordsBy).sort((a, b) => b[1] - a[1]).map(([s, n]) => {
    const pct = Math.round((n / total) * 100);
    return `<button class="spk" data-name="${esc(s)}" aria-haspopup="dialog" aria-expanded="false" ` +
      `title="${esc(s)} spoke ${pct}% of the words. Click to rename.">${avatar(s, colors[s] || COLORS[0])}` +
      `${esc(s)}<span class="pct">${pct}%</span></button>`;
  }).join("");

  renderTranscript();
  renderFile();
}

const DOC_ICON = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 1.5h-5a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V4.5z"/><path d="M9.5 1.5v3h3M5.5 8.5h5M5.5 11h5"/></svg>`;

function savedWhen(ts) {
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  return new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

async function renderFile() {
  const f = await MT.getFile(current.id);
  let html = "";
  if (f && f.downloadId) {
    const name = f.filename.split(/[\\/]/).pop();
    html += `<span class="doc" title="${esc(f.filename)}">${DOC_ICON}<span>Saved as <b>${esc(name)}</b></span></span>` +
      `<span class="sep">·</span><span>${esc(savedWhen(f.savedAt))}</span>` +
      `<button id="showFile" class="btn link">Show in folder</button>`;
  } else if (current.syncedFrom) {
    html += `<span class="doc" title="Its Word document is in your synced Meeting Transcripts folder">${DOC_ICON}` +
      `<span>Recorded on <b>${esc(current.syncedFrom)}</b></span></span>`;
  } else if (current.importedFrom) {
    html += `<span class="doc" title="${esc(current.importedFrom)}">${DOC_ICON}<span>Restored from <b>${esc(current.importedFrom)}</b></span></span>`;
  } else {
    html += `<span class="doc">${DOC_ICON}<span>Not saved as a Word document yet</span></span>`;
  }
  html += `<button id="saveNow" class="btn link">${f && f.downloadId ? "Save again" : "Save .docx"}</button>`;
  if (f && f.error) html += `<span class="err">${esc(f.error)}</span>`;
  if (f && f.error && f.askSetting) html += `<button id="dlSettings" class="btn link">Open Chrome download settings</button>`;
  $("file").innerHTML = html;
  if ($("dlSettings")) $("dlSettings").addEventListener("click", () =>
    chrome.runtime.sendMessage({ type: "openDownloadSettings" }));
  if ($("showFile")) $("showFile").addEventListener("click", () =>
    chrome.runtime.sendMessage({ type: "showFile", downloadId: f.downloadId }));
  const btn = $("saveNow");
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = "Saving…";
    const r = await chrome.runtime.sendMessage({ type: "saveNow", id: current.id });
    toast(r.ok ? "Saved to Downloads/Meeting Transcripts" : "Couldn't save: " + r.error);
    renderFile();
  });
}

function renderTranscript() {
  const colors = speakerColors();
  const q = query.toLowerCase();
  let turns;
  if (filter === "all") {
    turns = q ? MT.groupTurns(entries) : MT.timeline(current, entries); // gaps only in the full transcript
  } else {
    // Sentence-level filters: each matching sentence stands on its own.
    turns = MT.highlights(entries, filter).map((h) => ({ speaker: h.speaker, ts: h.ts, lines: [{ text: h.text }] }));
  }
  if (q) turns = turns.filter((t) => t.lines.some((l) => l.text.toLowerCase().includes(q)) || t.speaker.toLowerCase().includes(q));
  const count = turns.filter((t) => t.kind !== "gap").length;

  const note = $("filterNote");
  note.hidden = filter === "all" && !q;
  note.textContent = filter === "all"
    ? `${count} matching turn${count === 1 ? "" : "s"}`
    : `${count} ${MT.FILTERS[filter].label.toLowerCase()} · picked out by keywords, so skim them in context`;

  const recent = Date.now() - current.endedAt < 15_000;
  $("transcript").innerHTML = turns.map((t, i) => {
    if (t.kind === "gap") return `<div class="gap" role="separator">${esc(MT.gapText(current, t))}</div>`;
    const isLive = recent && i === turns.length - 1 && filter === "all" && !q;
    return `<div class="turn">${avatar(t.speaker, colors[t.speaker] || COLORS[0])}<div>` +
      `<div class="head"><span class="who">${esc(t.speaker)}</span>` +
      `<time title="${esc(new Date(t.ts).toLocaleTimeString())}">${MT.clock(t.ts - current.startedAt)}</time>` +
      `${isLive ? '<span class="live-pill">Live</span>' : ""}</div>` +
      `<p>${highlight(t.lines.map((l) => l.text).join(" "))}</p></div></div>`;
  }).join("") || `<div class="empty-state"><strong>Nothing here</strong>${
    q ? "No lines match your search." : "No sentences matched this filter."}</div>`;
}

// --- actions ------------------------------------------------------------------------------

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const fileBase = () => MT.docName(current);

async function copy(text, msg) {
  await navigator.clipboard.writeText(text);
  toast(msg);
}

const aiPrompt = (meta) => `Below is a transcript of a ${MT.platformName(meta)} call, generated from live captions (expect some recognition errors). Please give me:
1. A 3–5 sentence summary
2. Key points and decisions
3. Action items, with owners and deadlines where mentioned
4. Open questions or unresolved issues

---

`;

// Slides the segmented control's thumb under the selected option.
function placeThumb() {
  const on = $("filters").querySelector("button.on");
  const thumb = $("filters").querySelector(".thumb");
  if (!on || !on.offsetWidth) return;
  thumb.style.width = on.offsetWidth + "px";
  thumb.style.transform = `translateX(${on.offsetLeft}px)`;
}

function setMenu(open) {
  $("exportMenu").classList.toggle("open", open);
  $("exportBtn").setAttribute("aria-expanded", String(open));
}

function bindActions() {
  $("search").addEventListener("input", (e) => { query = e.target.value.trim(); renderTranscript(); });
  $("filters").addEventListener("pointerdown", (e) => {
    // Select on press: the thumb starts moving the moment the finger lands.
    const b = e.target.closest("button");
    if (!b || b.classList.contains("on")) return;
    filter = b.dataset.filter;
    for (const x of $("filters").querySelectorAll("button")) {
      x.classList.toggle("on", x === b);
      x.setAttribute("aria-pressed", String(x === b));
    }
    placeThumb();
    renderTranscript();
  });
  $("filters").addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") e.target.closest("button")?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  });
  window.addEventListener("resize", placeThumb);
  document.querySelector("main").addEventListener("scroll", (e) =>
    e.target.classList.toggle("scrolled", e.target.scrollTop > 8), { passive: true });

  $("title").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); e.target.blur(); } });
  $("title").addEventListener("blur", async (e) => {
    const title = e.target.textContent.trim();
    if (!title || title === MT.title(current)) { e.target.textContent = MT.title(current); return; }
    current.renamed = true;
    current.title = title;
    await MT.updateMeeting(current.id, { title, renamed: true });
    chrome.runtime.sendMessage({ type: "resave", id: current.id });
    toast("Renamed");
  });

  $("copyAI").addEventListener("click", () => copy(aiPrompt(current) + MT.toText(current, entries), "Copied — paste into your AI chat"));

  // Rename a speaker: click their chip.
  let renaming = null;
  const closeRename = () => {
    $("renameBox").classList.remove("open");
    if (renaming) renaming.setAttribute("aria-expanded", "false");
    renaming = null;
  };
  $("speakers").addEventListener("click", (e) => {
    const chip = e.target.closest("button.spk");
    if (!chip) return;
    e.stopPropagation();
    if (renaming === chip) return closeRename();
    closeRename();
    renaming = chip;
    chip.setAttribute("aria-expanded", "true");
    const box = $("renameBox");
    box.style.left = chip.offsetLeft + "px";
    box.style.top = chip.offsetTop + chip.offsetHeight + 6 + "px";
    $("renameFrom").textContent = chip.dataset.name;
    $("renameInput").value = chip.dataset.name;
    $("renameFuture").checked = false;
    box.classList.add("open");
    $("renameInput").focus();
    $("renameInput").select();
  });
  $("renameBox").addEventListener("click", (e) => e.stopPropagation());
  $("renameCancel").addEventListener("click", closeRename);
  $("renameBox").addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); closeRename(); } });
  $("renameBox").addEventListener("submit", async (e) => {
    e.preventDefault();
    const from = renaming && renaming.dataset.name, to = $("renameInput").value.trim(), future = $("renameFuture").checked;
    closeRename();
    if (!from || !to || to === from) return;
    await MT.renameSpeaker(current.id, from, to, future);
    chrome.runtime.sendMessage({ type: "resave", id: current.id });
    toast(future ? `Renamed to “${to}”, here and in future calls` : `Renamed to “${to}”`);
  });
  document.addEventListener("click", closeRename);

  $("exportBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    setMenu(!$("exportMenu").classList.contains("open"));
  });
  document.addEventListener("click", () => setMenu(false));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") setMenu(false); });
  $("exportMenu").addEventListener("click", async (e) => {
    const kind = e.target.closest("button")?.dataset.export;
    setMenu(false);
    if (kind === "docx") download(fileBase() + ".docx", await DOCX.build(MT.docBlocks(current, entries)), DOCX.MIME);
    if (kind === "md") download(fileBase() + ".md", MT.toMarkdown(current, entries), "text/markdown");
    if (kind === "txt") download(fileBase() + ".txt", MT.toText(current, entries), "text/plain");
    if (kind === "json") download(fileBase() + ".json", JSON.stringify({ ...current, entries }, null, 2), "application/json");
    if (kind === "copy") copy(MT.toText(current, entries), "Transcript copied");
  });

  // Delete at once, with Undo, instead of a blocking "are you sure?" dialog.
  $("delete").addEventListener("click", async () => {
    const meta = current, lines = entries, file = await MT.getFile(meta.id);
    await MT.deleteMeeting(meta.id);
    location.hash = "";
    toast(`Deleted “${MT.title(meta)}”`, {
      label: "Undo",
      run: async () => {
        await MT.saveMeeting(meta, lines);
        if (meta.renamed) await MT.updateMeeting(meta.id, { title: meta.title, renamed: true });
        if (file) await MT.setFile(meta.id, file);
        location.hash = encodeURIComponent(meta.id);
      },
    });
  });

  // Rebuild meetings from saved .docx files (pick the "Meeting Transcripts" folder, or files).
  $("importBtn").addEventListener("click", () => { $("importBtn").classList.remove("pulse"); $("importInput").click(); });
  $("importInput").addEventListener("change", async (e) => {
    const picked = [...e.target.files];
    e.target.value = "";
    const btn = $("importBtn");
    btn.disabled = true;
    const result = await restoreFrom(picked, (text) => (btn.lastChild.textContent = ` ${text}`));
    btn.disabled = false;
    btn.lastChild.textContent = " Restore from folder…";
    libIndex = null;
    await loadLibrary();
    toast(result);
  });

  $("startFresh").addEventListener("click", async () => {
    await chrome.storage.local.set({ libraryReady: true });
    $("importBtn").classList.remove("pulse");
    $("welcomeChoice").hidden = true;
    toast("Starting a new library");
  });

  let libTimer;
  $("libSearch").addEventListener("input", async (e) => {
    libQuery = e.target.value.trim();
    if (libQuery.length >= 3 && !libIndex) await buildIndex();
    clearTimeout(libTimer);
    libTimer = setTimeout(renderList, 120);
  });
}

// Live updates while a meeting is being recorded in another tab.
chrome.storage.onChanged.addListener(async (changes) => {
  if (changes.meetings) {
    libIndex = null;
    meetings = await MT.listMeetings();
    const fresh = current && meetings.find((m) => m.id === current.id);
    if (current && !fresh) return openMeeting(null);
    if (fresh) current = fresh;
    renderList();
  }
  if (current && changes["f:" + current.id]) renderFile();
  if (current && changes["t:" + current.id]) {
    entries = changes["t:" + current.id].newValue || [];
    const main = document.querySelector("main");
    const atBottom = main.scrollHeight - main.scrollTop - main.clientHeight < 80;
    renderMeeting();
    if (atBottom && filter === "all" && !query) main.scrollTop = main.scrollHeight;
  }
});

// Restores from the picked folder: library.json (everything, settings included), then any
// .docx it doesn't cover (calls saved after the last library.json, or files from before it).
async function restoreFrom(picked, progress) {
  let added = 0, already = 0, failed = 0, settingsRestored = false;
  const isKnown = (meta, title) => meetings.some((m) => m.id === meta.id ||
    (Math.abs(m.startedAt - meta.startedAt) < 120_000 && MT.title(m) === title));

  // library.json, "library (since reinstall).json" from an install that wasn't restored, and
  // the devices' files when sync across devices is in use (devices/<id>.json).
  const libs = [];
  const isLibrary = (f) => /^library.*\.json$/i.test(f.name) || /(^|[\\/])devices[\\/][^\\/]+\.json$/i.test(f.webkitRelativePath || "");
  for (const f of picked.filter(isLibrary)) {
    const parsed = DOCX_IMPORT.parseLibrary(await f.text());
    if (parsed) libs.push(parsed);
  }
  for (const lib of libs) {
    progress("Restoring library…");
    if (Object.keys(lib.settings).length) { await MT.saveSettings(lib.settings); settingsRestored = true; }
    const store = {};
    const { meetings: stored = {} } = await chrome.storage.local.get("meetings");
    for (const m of lib.meetings) {
      if (isKnown(m, MT.title(m))) { already++; continue; }
      stored[m.id] = m;
      store["t:" + m.id] = lib.transcripts[m.id];
      if (lib.files[m.id]) store["f:" + m.id] = lib.files[m.id];
      added++;
    }
    await chrome.storage.local.set({ ...store, meetings: stored });
    meetings = await MT.listMeetings();
  }

  const docs = picked.filter((f) => /\.docx$/i.test(f.name) && !f.name.startsWith("~$"));
  for (const [i, file] of docs.entries()) {
    progress(`Reading ${i + 1} of ${docs.length}…`);
    try {
      const { meta, entries: lines } = await DOCX_IMPORT.parse(await file.arrayBuffer(), file.name);
      if (isKnown(meta, MT.title({ ...meta, speakers: [] }))) { already++; continue; }
      await MT.saveMeeting(meta, lines);
      meetings = await MT.listMeetings();
      added++;
    } catch {
      failed++;
    }
  }
  if (!libs.length && !docs.length) return "No library.json or .docx files in that folder";
  await chrome.storage.local.set({ libraryReady: true }); // from now on, keep library.json up to date
  return [`Restored ${added} meeting${added === 1 ? "" : "s"}`, settingsRestored && "settings",
    already && `${already} already here`, failed && `${failed} couldn't be read`].filter(Boolean).join(" · ");
}

// --- sync across devices (lib/sync.js) -------------------------------------------------------

async function syncAllowed(folder) {
  return !!folder && (!folder.queryPermission || (await folder.queryPermission({ mode: "read" })) === "granted");
}

// The sidebar button says how sync stands: off, on (with whom, when), or waiting for permission.
async function renderSync() {
  const sync = await SYNC.state();
  let label = "Sync across devices…", attention = false;
  if (sync.on) {
    if (!(await syncAllowed(await SYNC.getFolder()))) {
      label = "Allow sync…";
      attention = true;
    } else {
      const n = (sync.devices || []).length;
      label = n === 1 ? `Synced with ${sync.devices[0]}` : n ? `Synced with ${n} devices` : "Sync on · no other devices yet";
      if (sync.lastSync) label += " · " + savedWhen(sync.lastSync);
    }
  }
  $("syncLabel").textContent = label;
  $("syncBtn").classList.toggle("attention", attention);
  $("syncBtn").title = attention ? "Chrome needs your OK to read the synced folder again" : "Keep this library in step with your other computers";
}

let syncing = false;
async function runSync(ask) {
  if (syncing) return null;
  syncing = true;
  try {
    const r = await SYNC.syncNow({ ask });
    const n = r.ok ? r.added + r.updated + r.removed : 0;
    if (n) toast([r.added && `${r.added} new`, r.updated && `${r.updated} updated`, r.removed && `${r.removed} removed`]
      .filter(Boolean).join(", ") + ` from ${r.devices.join(", ")}`);
    return r;
  } catch {
    return null;
  } finally {
    syncing = false;
    renderSync();
  }
}

async function renderSyncDialog() {
  const sync = await SYNC.state();
  const on = !!sync.on;
  $("syncOff").hidden = on;
  $("syncOn").hidden = !on;
  $("syncPick").hidden = on;
  $("syncNowBtn").hidden = !on;
  $("syncOffBtn").hidden = !on;
  $("deviceName").value = (await MT.getDevice()).name;
  if (on) {
    const devices = sync.devices || [];
    $("syncStatus").textContent = (devices.length
      ? `Synced with ${devices.join(", ")}.`
      : "On. No other computer has synced yet: set it up there too, with the same folder.") +
      (sync.lastSync ? ` Last checked ${savedWhen(sync.lastSync)}.` : "");
  }
}

function bindSync() {
  const dialog = $("syncDialog"), error = $("syncError");
  const fail = (msg) => { error.textContent = msg; error.hidden = !msg; };
  $("syncBtn").addEventListener("click", async () => {
    const sync = await SYNC.state();
    // Waiting for permission: this click is the user gesture Chrome needs to ask.
    if (sync.on && !(await syncAllowed(await SYNC.getFolder())) && (await SYNC.getFolder())) {
      const r = await runSync(true);
      if (r && r.ok) return toast(r.devices.length ? `Synced with ${r.devices.join(", ")}` : "Sync on");
    }
    fail("");
    await renderSyncDialog();
    dialog.showModal();
  });
  $("deviceName").addEventListener("change", async (e) => {
    const name = e.target.value.replace(/\s+/g, " ").trim();
    if (!name) return renderSyncDialog();
    await chrome.storage.local.set({ device: { ...(await MT.getDevice()), name } });
  });
  $("syncPick").addEventListener("click", async () => {
    fail("");
    let folder;
    try {
      folder = await window.showDirectoryPicker({ id: "meeting-transcripts", mode: "read", startIn: "downloads" });
    } catch {
      return; // cancelled
    }
    $("syncPick").disabled = true;
    try {
      const r = await SYNC.turnOn(folder);
      if (!r.ok) {
        return fail("That isn't the folder this computer saves its transcripts in" +
          (r.savesTo ? `: pick ${r.savesTo}` : ": pick Downloads › Meeting Transcripts") + ".");
      }
      dialog.close();
      toast(r.devices.length ? `Sync on: ${r.added} calls from ${r.devices.join(", ")}` : "Sync on. Now set it up on your other computer.");
    } finally {
      $("syncPick").disabled = false;
      renderSync();
    }
  });
  $("syncNowBtn").addEventListener("click", async () => {
    const r = await runSync(true);
    if (r && !r.ok && r.reason === "permission") fail("Chrome didn't allow reading the folder. Try again, or choose it again.");
    renderSyncDialog();
  });
  $("syncOffBtn").addEventListener("click", async () => {
    await SYNC.turnOff();
    dialog.close();
    toast("Sync off. Calls synced so far stay in this library.");
    renderSync();
  });
  // Sync when the page opens, when it's shown again, and every minute while it's open.
  window.addEventListener("focus", () => runSync(false));
  setInterval(() => { if (!document.hidden) runSync(false); }, 60_000);
}

// "#<meeting id>" opens a meeting; "#welcome" (after a fresh install) points at Restore.
async function route() {
  const id = decodeURIComponent(location.hash.slice(1));
  if (id === "welcome") {
    history.replaceState(null, "", location.pathname);
    meetings = await MT.listMeetings();
    const { libraryReady } = await chrome.storage.local.get("libraryReady");
    const isFresh = !meetings.length && !libraryReady;
    $("importBtn").classList.toggle("pulse", isFresh);
    $("welcomeChoice").hidden = !isFresh;
    renderList();
    return openMeeting(null);
  }
  openMeeting(id || null);
}

window.addEventListener("hashchange", route);

(async () => {
  bindActions();
  bindSync();
  await loadLibrary();
  route();
  await renderSync();
  runSync(false);
})();
