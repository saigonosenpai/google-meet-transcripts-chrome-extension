importScripts("shared.js", "docx.js");

// --- toolbar badge ------------------------------------------------------------------------

function setBadge(tabId, msg) {
  let text = "", color = "#5f6368", title = "Meet Transcripts";
  if (msg.inMeeting && msg.paused) {
    text = "II"; title = "Meet Transcripts: paused";
  } else if (msg.inMeeting && msg.captionsOn) {
    text = "REC"; color = "#d93025"; title = "Meet Transcripts: recording captions";
  } else if (msg.inMeeting) {
    text = "CC"; title = "Meet Transcripts: turn on captions (CC) to record";
  }
  chrome.action.setBadgeText({ tabId, text });
  chrome.action.setBadgeBackgroundColor({ tabId, color });
  chrome.action.setTitle({ tabId, title });
}

// --- saving .docx files -------------------------------------------------------------------
//
// Files go to <Downloads>/Meet Transcripts/ through chrome.downloads, which needs no folder
// permission and works from this service worker. A later save of the same meeting
// overwrites its file; if the name changed (renamed, more participants), the old file is
// deleted so each meeting has exactly one document.

const FOLDER = "Meet Transcripts";

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return String(h);
}

function waitForDownload(downloadId) {
  return new Promise((resolve, reject) => {
    const done = (item) => {
      chrome.downloads.onChanged.removeListener(onChanged);
      if (item.state === "complete") resolve(item);
      else reject(new Error("Couldn't save the file" + (item.error ? ": " + item.error : "")));
    };
    const onChanged = async (delta) => {
      if (delta.id !== downloadId || !delta.state || delta.state.current === "in_progress") return;
      done((await chrome.downloads.search({ id: downloadId }))[0]);
    };
    chrome.downloads.onChanged.addListener(onChanged);
    chrome.downloads.search({ id: downloadId }).then(([item]) => item && item.state !== "in_progress" && done(item));
  });
}

const saving = new Map(); // meeting id -> promise, so overlapping triggers share one save

function saveDoc(id, opts = {}) {
  if (!saving.has(id)) saving.set(id, doSave(id, opts).finally(() => saving.delete(id)));
  return saving.get(id);
}

async function doSave(id, { manual = false } = {}) {
  if (!manual && !(await MT.getSettings()).autoSave) return null;
  const meta = (await MT.listMeetings()).find((m) => m.id === id);
  const entries = await MT.getTranscript(id);
  if (!meta || !entries.length) return null;

  const prev = (await MT.getFile(id)) || {};
  const name = MT.docName(meta) + ".docx";
  const blocks = MT.docBlocks(meta, entries);
  const h = hash(name + JSON.stringify(blocks));
  if (prev.downloadId && prev.hash === h && !prev.error && !manual) return prev;

  try {
    if (prev.downloadId) {
      const [old] = await chrome.downloads.search({ id: prev.downloadId });
      if (old && old.exists && !old.filename.endsWith(name)) await chrome.downloads.removeFile(old.id).catch(() => {});
      await chrome.downloads.erase({ id: prev.downloadId });
    }
    // Automatic saves happen mid-call; keep Chrome's download bubble out of the way.
    if (!manual) await chrome.downloads.setUiOptions({ enabled: false }).catch(() => {});
    let item;
    try {
      const downloadId = await chrome.downloads.download({
        url: DOCX.dataUrl(DOCX.build(blocks)),
        filename: FOLDER + "/" + name,
        conflictAction: "overwrite",
        saveAs: false,
      });
      item = await waitForDownload(downloadId);
    } finally {
      if (!manual) await chrome.downloads.setUiOptions({ enabled: true }).catch(() => {});
    }
    const result = { downloadId: item.id, filename: item.filename, savedAt: Date.now(), hash: h, error: null };
    await MT.setFile(id, result);
    return result;
  } catch (err) {
    // With Chrome's "Ask where to save each file" on, every save opens a dialog; closing it
    // (or saving while nobody is at the screen) cancels the download.
    const askSetting = /USER_CANCELED/.test(err.message);
    const error = askSetting
      ? "Chrome asked where to save the file and the dialog was closed. To save automatically, turn off " +
        "\u201cAsk where to save each file before downloading\u201d in Chrome\u2019s download settings."
      : err.message;
    await MT.setFile(id, { ...prev, error, askSetting });
    throw new Error(error);
  }
}

// --- when to save -------------------------------------------------------------------------
//
// A meeting is saved when its tab closes, when the user leaves the call, or after IDLE_MIN
// minutes without new captions (so a crash loses little). Later captions update the file.

const IDLE_MIN = 2;

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name.startsWith("save:")) saveDoc(alarm.name.slice(5)).catch(() => {});
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const key = "tab:" + tabId;
  const id = (await chrome.storage.session.get(key))[key];
  if (!id) return;
  await chrome.storage.session.remove(key);
  chrome.alarms.clear("save:" + id);
  saveDoc(id).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const tabId = sender.tab && sender.tab.id;
  switch (msg.type) {
    case "status":
      if (tabId) setBadge(tabId, msg);
      return false;
    case "meetingSaved":
      if (tabId) chrome.storage.session.set({ ["tab:" + tabId]: msg.id });
      chrome.alarms.create("save:" + msg.id, { delayInMinutes: IDLE_MIN });
      return false;
    case "meetingEnded":
      chrome.alarms.clear("save:" + msg.id);
      saveDoc(msg.id).catch(() => {});
      return false;
    case "saveNow":
      saveDoc(msg.id, { manual: true })
        .then((r) => reply({ ok: true, result: r }), (e) => reply({ ok: false, error: e.message }));
      return true;
    case "openDownloadSettings":
      chrome.tabs.create({ url: "chrome://settings/downloads" });
      return false;
    case "showFile":
      chrome.downloads.search({ id: msg.downloadId || -1 }).then(([item]) => {
        if (item && item.exists) chrome.downloads.show(item.id);
        else chrome.downloads.showDefaultFolder();
      });
      return false;
  }
  return false;
});
