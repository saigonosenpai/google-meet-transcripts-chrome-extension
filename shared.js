// Storage layout and helpers shared by the content script, popup and viewer.
//
//   meetings         -> { [id]: { id, code, title, startedAt, endedAt, entryCount, speakers } }
//   t:<id>           -> [ { speaker, text, ts } ]   (ts = epoch ms when the line started)
//   settings         -> { autoCaptions, hideCaptions, myName, paused }

const MT = (() => {
  const DEFAULT_SETTINGS = { autoCaptions: true, hideCaptions: false, myName: "", paused: false };

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
    await chrome.storage.local.remove("t:" + id);
  }

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

  function toText(meta, entries) {
    const head = `${meta.title}\n${dateTime(meta.startedAt)} · ${duration(meta)}\n\n`;
    return head + groupTurns(entries)
      .map((t) => `[${clock(t.ts - meta.startedAt)}] ${t.speaker}: ${t.lines.map((l) => l.text).join(" ")}`)
      .join("\n\n") + "\n";
  }

  function toMarkdown(meta, entries) {
    const head = `# ${meta.title}\n\n*${dateTime(meta.startedAt)} · ${duration(meta)} · ` +
      `${(meta.speakers || []).join(", ")}*\n\n`;
    return head + groupTurns(entries)
      .map((t) => `**${t.speaker}** \`${clock(t.ts - meta.startedAt)}\`  \n${t.lines.map((l) => l.text).join(" ")}`)
      .join("\n\n") + "\n";
  }

  return {
    getSettings, saveSettings, listMeetings, getTranscript, saveMeeting, updateMeeting, deleteMeeting,
    groupTurns, clock, dateTime, duration, toText, toMarkdown,
  };
})();
