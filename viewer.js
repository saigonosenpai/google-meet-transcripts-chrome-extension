const $ = (id) => document.getElementById(id);
const COLORS = ["#1a73e8", "#d93025", "#188038", "#e37400", "#9334e6", "#007b83", "#c5221f", "#b06000"];

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

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 1800);
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
    li.innerHTML = `<div class="t"></div><div class="s"></div>`;
    li.querySelector(".t").textContent = MT.title(m);
    li.querySelector(".s").textContent = `${time} · ${MT.duration(m)} · ${(m.speakers || []).length} speaker${(m.speakers || []).length === 1 ? "" : "s"}`;
    li.addEventListener("click", () => { location.hash = encodeURIComponent(m.id); });
    list.append(li);
  }
  if (q && !shown.length) list.innerHTML = `<li class="day">No matches</li>`;
}

// --- one meeting --------------------------------------------------------------------------

async function openMeeting(id) {
  current = meetings.find((m) => m.id === id) || null;
  $("placeholder").hidden = !!current;
  $("meeting").hidden = !current;
  renderList();
  if (!current) return;
  entries = await MT.getTranscript(id);
  document.title = MT.title(current) + " · Meet Transcripts";
  renderMeeting();
  document.querySelector("main").scrollTo(0, 0);
}

function speakerColors() {
  const map = {};
  (current.speakers || []).forEach((s, i) => (map[s] = COLORS[i % COLORS.length]));
  return map;
}

function renderMeeting() {
  const colors = speakerColors();
  $("title").textContent = MT.title(current);
  $("meta").textContent = `${MT.dateTime(current.startedAt)} · ${MT.duration(current)} · ${entries.length} lines`;

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
    return `<span class="spk"><b style="color:${colors[s] || COLORS[0]}">${esc(s)}</b>` +
      `<span class="bar"><i style="width:${pct}%;background:${colors[s] || COLORS[0]}"></i></span>` +
      `<span class="pct">${pct}%</span></span>`;
  }).join("");

  renderTranscript();
  renderFile();
}

async function renderFile() {
  const f = await MT.getFile(current.id);
  let html = "";
  if (f && f.downloadId) {
    html += `<span>Saved as <b>${esc(f.filename.split(/[\\/]/).pop())}</b></span>` +
      `<span class="muted">${esc(new Date(f.savedAt).toLocaleString())}</span>` +
      `<button id="showFile">Show in folder</button>`;
  } else {
    html += `<span class="muted">Not saved as a Word file yet</span>`;
  }
  html += `<button id="saveNow">${f && f.downloadId ? "Save again" : "Save .docx"}</button>`;
  if (f && f.error) html += `<span class="err">${esc(f.error)}</span>`;
  if (f && f.error && f.askSetting) html += `<button id="dlSettings">Open Chrome download settings</button>`;
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
    toast(r.ok ? "Saved to Downloads/Meet Transcripts" : "Couldn't save: " + r.error);
    renderFile();
  });
}

function renderTranscript() {
  const colors = speakerColors();
  const q = query.toLowerCase();
  let turns;
  if (filter === "all") {
    turns = MT.groupTurns(entries);
  } else {
    // Sentence-level filters: each matching sentence stands on its own.
    turns = MT.highlights(entries, filter).map((h) => ({ speaker: h.speaker, ts: h.ts, lines: [{ text: h.text }] }));
  }
  if (q) turns = turns.filter((t) => t.lines.some((l) => l.text.toLowerCase().includes(q)) || t.speaker.toLowerCase().includes(q));

  const note = $("filterNote");
  note.hidden = filter === "all" && !q;
  note.textContent = `${turns.length} ${filter === "all" ? "matching turn" + (turns.length === 1 ? "" : "s") : MT.FILTERS[filter].label.toLowerCase()}` +
    (filter !== "all" ? " (found by keywords — skim for context)" : "");

  const recent = Date.now() - current.endedAt < 15_000;
  $("transcript").innerHTML = turns.map((t, i) => {
    const live = recent && i === turns.length - 1 && filter === "all" && !q ? " live" : "";
    return `<div class="turn${live}"><time title="${esc(new Date(t.ts).toLocaleTimeString())}">${MT.clock(t.ts - current.startedAt)}</time>` +
      `<div><div class="who" style="color:${colors[t.speaker] || COLORS[0]}">${esc(t.speaker)}</div>` +
      `<p>${highlight(t.lines.map((l) => l.text).join(" "))}</p></div></div>`;
  }).join("") || `<p class="empty">Nothing here.</p>`;
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

const AI_PROMPT = `Below is a transcript of a Google Meet call, generated from live captions (expect some recognition errors). Please give me:
1. A 3–5 sentence summary
2. Key points and decisions
3. Action items, with owners and deadlines where mentioned
4. Open questions or unresolved issues

---

`;

function bindActions() {
  $("search").addEventListener("input", (e) => { query = e.target.value.trim(); renderTranscript(); });
  $("filters").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    filter = b.dataset.filter;
    for (const x of $("filters").children) x.classList.toggle("on", x === b);
    renderTranscript();
  });

  $("title").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); e.target.blur(); } });
  $("title").addEventListener("blur", async (e) => {
    const title = e.target.textContent.trim();
    if (!title || title === MT.title(current)) { e.target.textContent = MT.title(current); return; }
    current.renamed = true;
    current.title = title;
    await MT.updateMeeting(current.id, { title, renamed: true });
    toast("Renamed");
  });

  $("copyAI").addEventListener("click", () => copy(AI_PROMPT + MT.toText(current, entries), "Copied — paste into your AI chat"));

  $("exportBtn").addEventListener("click", (e) => { e.stopPropagation(); $("exportMenu").hidden = !$("exportMenu").hidden; });
  document.addEventListener("click", () => ($("exportMenu").hidden = true));
  $("exportMenu").addEventListener("click", (e) => {
    const kind = e.target.dataset.export;
    if (kind === "docx") download(fileBase() + ".docx", DOCX.build(MT.docBlocks(current, entries)), DOCX.MIME);
    if (kind === "md") download(fileBase() + ".md", MT.toMarkdown(current, entries), "text/markdown");
    if (kind === "txt") download(fileBase() + ".txt", MT.toText(current, entries), "text/plain");
    if (kind === "json") download(fileBase() + ".json", JSON.stringify({ ...current, entries }, null, 2), "application/json");
    if (kind === "copy") copy(MT.toText(current, entries), "Transcript copied");
  });

  $("delete").addEventListener("click", async () => {
    if (!confirm(`Delete “${MT.title(current)}”? This can't be undone.`)) return;
    await MT.deleteMeeting(current.id);
    location.hash = "";
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

window.addEventListener("hashchange", () => openMeeting(decodeURIComponent(location.hash.slice(1))));

(async () => {
  bindActions();
  await loadLibrary();
  const id = decodeURIComponent(location.hash.slice(1));
  openMeeting(id || null);
})();
