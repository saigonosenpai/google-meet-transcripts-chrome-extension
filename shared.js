// Storage layout and helpers shared by the content script, popup and viewer.
//
//   meetings         -> { [id]: { id, code, title, startedAt, endedAt, entryCount, speakers } }
//   t:<id>           -> [ { speaker, text, ts } ]   (ts = epoch ms when the line started)
//   d:<id>           -> { fileId, url, syncedAt, hash, error }   (Google Drive copy)
//   settings         -> { autoCaptions, hideCaptions, myName, paused, driveEnabled, clientId }

const MT = (() => {
  const DEFAULT_SETTINGS = {
    autoCaptions: true, hideCaptions: false, myName: "", paused: false, driveEnabled: true, clientId: "",
  };

  const get = (keys) => chrome.storage.local.get(keys);
  const set = (obj) => chrome.storage.local.set(obj);

  async function getSettings() {
    const { settings } = await get("settings");
    return { ...DEFAULT_SETTINGS, ...(settings || {}) };
  }

  async function saveSettings(patch) {
    const settings = { ...(await getSettings()), ...patch };
    await set({ settings });
    return settings;
  }

  async function listMeetings() {
    const { meetings } = await get("meetings");
    return Object.values(meetings || {}).sort((a, b) => b.startedAt - a.startedAt);
  }

  async function getTranscript(id) {
    const key = "t:" + id;
    return (await get(key))[key] || [];
  }

  async function saveMeeting(meta, entries) {
    const { meetings = {} } = await get("meetings");
    const existing = meetings[meta.id] || {};
    // Keep a title the user renamed in the viewer.
    const title = existing.renamed ? existing.title : meta.title;
    meetings[meta.id] = {
      ...existing,
      ...meta,
      title,
      entryCount: entries.length,
      speakers: [...new Set(entries.map((e) => e.speaker))],
      participants: [...new Set([...(existing.participants || []), ...(meta.participants || [])])],
    };
    await set({ meetings, ["t:" + meta.id]: entries });
  }

  async function updateMeeting(id, patch) {
    const { meetings = {} } = await get("meetings");
    if (!meetings[id]) return;
    meetings[id] = { ...meetings[id], ...patch };
    await set({ meetings });
  }

  async function deleteMeeting(id) {
    const { meetings = {} } = await get("meetings");
    delete meetings[id];
    await set({ meetings });
    await chrome.storage.local.remove(["t:" + id, "d:" + id]);
  }

  async function getDrive(id) {
    const key = "d:" + id;
    return (await get(key))[key] || null;
  }

  const setDrive = (id, value) => set({ ["d:" + id]: value });

  // Consecutive lines from the same speaker read better as one paragraph.
  function groupTurns(entries) {
    const turns = [];
    for (const e of entries) {
      const last = turns[turns.length - 1];
      if (last && last.speaker === e.speaker && e.ts - last.endTs < 60_000) {
        last.lines.push(e);
        last.endTs = e.ts;
      } else {
        turns.push({ speaker: e.speaker, ts: e.ts, endTs: e.ts, lines: [e] });
      }
    }
    return turns;
  }

  const pad = (n) => String(n).padStart(2, "0");

  function clock(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600);
    return (h ? h + ":" + pad(Math.floor(s / 60) % 60) : Math.floor(s / 60)) + ":" + pad(s % 60);
  }

  function dateTime(ts) {
    return new Date(ts).toLocaleString(undefined, {
      weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    });
  }

  function duration(meta) {
    const mins = Math.round(((meta.endedAt || meta.startedAt) - meta.startedAt) / 60000);
    if (mins < 1) return "<1 min";
    return mins < 60 ? mins + " min" : Math.floor(mins / 60) + " h " + (mins % 60) + " min";
  }

  // Sentence-level highlight filters, used by the viewer and the Google Doc.
  const FILTERS = {
    questions: { label: "Questions", test: (s) => /\?\s*$/.test(s) },
    actions: {
      label: "Possible action items",
      test: (s) => /\b(action items?|follow[- ]?up|to-?do|next steps?|deadline|due|i'll|i will|we'll|we will|we need to|we should|you need to|can you|could you|let's|assign|owner|by (mon|tues|wednes|thurs|fri|satur|sun)day|by (tomorrow|tonight|eod|end of)|next week)\b/i.test(s),
    },
    decisions: {
      label: "Possible decisions",
      test: (s) => /\b(decided|decision|agreed|agree|let's go with|we'll go with|going with|final(ize|ized)?|approved?|settled|conclusion)\b/i.test(s),
    },
  };

  function highlights(entries, filter) {
    const out = [];
    for (const e of entries) {
      const hits = (e.text.match(/[^.?!]+[.?!]*/g) || []).map((s) => s.trim()).filter(FILTERS[filter].test);
      if (hits.length) out.push({ speaker: e.speaker, ts: e.ts, text: hits.join(" … ") });
    }
    return out;
  }

  // Everyone seen in the call (tiles / people panel) plus everyone who spoke.
  function people(meta) {
    const all = [...(meta.participants || []), ...(meta.speakers || [])]
      .filter((n) => n && !/^(you|unknown)$/i.test(n));
    const seen = new Map();
    for (const n of all) if (!seen.has(n.toLowerCase())) seen.set(n.toLowerCase(), n);
    return [...seen.values()];
  }

  function isoDate(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  // "2026-10-11 - Weekly sync - Alice, Bob, Sam +2"
  function docName(meta) {
    const names = people(meta);
    const shown = names.slice(0, 4).join(", ") + (names.length > 4 ? ` +${names.length - 4}` : "");
    return [isoDate(meta.startedAt), meta.title, shown].filter(Boolean).join(" - ")
      .replace(/[\\/:*?"<>|\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
  }

  function toDocHtml(meta, entries) {
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
    const grey = 'style="color:#80868b"';
    const when = (ts) => `<span ${grey}>[${clock(ts - meta.startedAt)}]</span>`;
    let html = `<html><head><meta charset="utf-8"></head><body style="font-family:Arial">`;
    html += `<h1>${esc(meta.title)}</h1>`;
    html += `<p><b>Date:</b> ${esc(dateTime(meta.startedAt))} (${esc(duration(meta))})<br>`;
    html += `<b>Participants:</b> ${esc(people(meta).join(", ") || "—")}<br>`;
    html += `<b>Meeting link:</b> <a href="https://meet.google.com/${esc(meta.code)}">meet.google.com/${esc(meta.code)}</a></p>`;

    const words = {};
    let total = 0;
    for (const e of entries) {
      const n = e.text.split(/\s+/).length;
      words[e.speaker] = (words[e.speaker] || 0) + n;
      total += n;
    }
    html += `<h2>Speaking time</h2><ul>` + Object.entries(words).sort((a, b) => b[1] - a[1])
      .map(([s, n]) => `<li>${esc(s)}: ${Math.round((n / total) * 100)}%</li>`).join("") + `</ul>`;

    html += `<h2>Highlights</h2><p ${grey}><i>Picked out by keywords from the captions; check the transcript for context.</i></p>`;
    for (const f of ["actions", "decisions", "questions"]) {
      const hits = highlights(entries, f);
      if (!hits.length) continue;
      html += `<h3>${FILTERS[f].label}</h3><ul>` +
        hits.map((h) => `<li>${when(h.ts)} <b>${esc(h.speaker)}:</b> ${esc(h.text)}</li>`).join("") + `</ul>`;
    }

    html += `<h2>Transcript</h2>`;
    html += groupTurns(entries).map((t) =>
      `<p><b>${esc(t.speaker)}</b> ${when(t.ts)}<br>${esc(t.lines.map((l) => l.text).join(" "))}</p>`).join("");
    html += `<p ${grey}><i>Recorded from Google Meet live captions by Meet Transcripts; expect some recognition errors.</i></p>`;
    return html + `</body></html>`;
  }

  function toText(meta, entries) {
    const head = `${meta.title}\n${dateTime(meta.startedAt)} · ${duration(meta)}\n\n`;
    return head + groupTurns(entries)
      .map((t) => `[${clock(t.ts - meta.startedAt)}] ${t.speaker}: ${t.lines.map((l) => l.text).join(" ")}`)
      .join("\n\n") + "\n";
  }

  function toMarkdown(meta, entries) {
    const head = `# ${meta.title}\n\n*${dateTime(meta.startedAt)} · ${duration(meta)} · ` +
      `${people(meta).join(", ")}*\n\n`;
    return head + groupTurns(entries)
      .map((t) => `**${t.speaker}** \`${clock(t.ts - meta.startedAt)}\`  \n${t.lines.map((l) => l.text).join(" ")}`)
      .join("\n\n") + "\n";
  }

  return {
    getSettings, saveSettings, listMeetings, getTranscript, saveMeeting, updateMeeting, deleteMeeting,
    getDrive, setDrive, groupTurns, clock, dateTime, duration, toText, toMarkdown,
    FILTERS, highlights, people, docName, toDocHtml,
  };
})();
