importScripts("shared.js");

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

// --- Google sign-in -----------------------------------------------------------------------
//
// OAuth implicit flow through chrome.identity.launchWebAuthFlow, using a "Web application"
// client ID the user creates and pastes into the popup. Scope drive.file only lets the
// extension see files it created itself.

const SCOPE = "https://www.googleapis.com/auth/drive.file";

async function getToken(interactive) {
  const { token } = await chrome.storage.session.get("token");
  if (token && token.expires > Date.now() + 60_000) return token.value;

  const { clientId } = await MT.getSettings();
  if (!clientId) throw new Error("Add your Google OAuth client ID in the extension popup.");
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: clientId,
    response_type: "token",
    redirect_uri: chrome.identity.getRedirectURL(),
    scope: SCOPE,
    include_granted_scopes: "true",
    ...(interactive ? {} : { prompt: "none" }),
  });
  let redirect;
  try {
    redirect = await chrome.identity.launchWebAuthFlow({ url: url.href, interactive });
  } catch {
    throw new Error(interactive ? "Google sign-in was cancelled or failed." : "SIGN_IN_NEEDED");
  }
  const params = new URLSearchParams(new URL(redirect).hash.slice(1));
  if (params.get("error") || !params.get("access_token")) {
    throw new Error(interactive ? "Google sign-in failed: " + (params.get("error") || "no token") : "SIGN_IN_NEEDED");
  }
  await chrome.storage.session.set({
    token: { value: params.get("access_token"), expires: Date.now() + Number(params.get("expires_in") || 3600) * 1000 },
  });
  await MT.saveSettings({ driveConnected: true });
  return params.get("access_token");
}

async function signOut() {
  const { token } = await chrome.storage.session.get("token");
  if (token) fetch("https://oauth2.googleapis.com/revoke?token=" + token.value, { method: "POST" }).catch(() => {});
  await chrome.storage.session.remove("token");
  await MT.saveSettings({ driveConnected: false });
}

// --- Drive --------------------------------------------------------------------------------

const DRIVE = "https://www.googleapis.com/drive/v3/files";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const FOLDER_NAME = "Meet Transcripts";

async function api(token, url, init = {}) {
  const res = await fetch(url, { ...init, headers: { Authorization: "Bearer " + token, ...(init.headers || {}) } });
  if (res.status === 401) {
    await chrome.storage.session.remove("token");
    throw new Error("SIGN_IN_NEEDED");
  }
  if (!res.ok) {
    const err = new Error(`Google Drive error ${res.status}: ${(await res.text()).slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function ensureFolder(token) {
  const { driveFolderId } = await chrome.storage.local.get("driveFolderId");
  if (driveFolderId) {
    try {
      const f = await api(token, `${DRIVE}/${driveFolderId}?fields=id,trashed`);
      if (!f.trashed) return f.id;
    } catch (err) {
      if (!err.status) throw err; // sign-in/network problems; a 404 means make a new folder
    }
  }
  const f = await api(token, `${DRIVE}?fields=id`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: FOLDER_NAME, mimeType: "application/vnd.google-apps.folder" }),
  });
  await chrome.storage.local.set({ driveFolderId: f.id });
  return f.id;
}

// Uploading HTML with a Google Docs mime type makes Drive convert it into a native Doc.
function multipart(metadata, html) {
  const boundary = "mt" + Math.random().toString(36).slice(2);
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n${html}\r\n--${boundary}--`;
  return { body, headers: { "Content-Type": "multipart/related; boundary=" + boundary } };
}

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return String(h);
}

const syncing = new Map(); // meeting id -> promise, so overlapping triggers share one upload

function syncMeeting(id, opts = {}) {
  if (!syncing.has(id)) syncing.set(id, doSync(id, opts).finally(() => syncing.delete(id)));
  return syncing.get(id);
}

async function doSync(id, { interactive = false, force = false } = {}) {
  const settings = await MT.getSettings();
  if (!force && (!settings.driveEnabled || !settings.clientId)) return null;
  const meta = (await MT.listMeetings()).find((m) => m.id === id);
  const entries = await MT.getTranscript(id);
  if (!meta || !entries.length) return null;

  const prev = (await MT.getDrive(id)) || {};
  const name = MT.docName(meta);
  const html = MT.toDocHtml(meta, entries);
  const h = hash(name + html);
  if (prev.fileId && prev.hash === h && !prev.error) return prev;

  try {
    const token = await getToken(interactive);
    let file = null;
    if (prev.fileId) {
      const { body, headers } = multipart({ name }, html);
      try {
        file = await api(token, `${UPLOAD}/${prev.fileId}?uploadType=multipart&fields=id,webViewLink,trashed`,
          { method: "PATCH", headers, body });
        if (file.trashed) file = null;
      } catch (err) {
        if (err.status !== 404 && err.status !== 403) throw err; // deleted, or no longer ours: make a new one
      }
    }
    if (!file) {
      const folder = await ensureFolder(token);
      const { body, headers } = multipart(
        { name, mimeType: "application/vnd.google-apps.document", parents: [folder] }, html);
      file = await api(token, `${UPLOAD}?uploadType=multipart&fields=id,webViewLink`, { method: "POST", headers, body });
    }
    const result = { fileId: file.id, url: file.webViewLink, name, syncedAt: Date.now(), hash: h, error: null };
    await MT.setDrive(id, result);
    return result;
  } catch (err) {
    const signIn = err.message === "SIGN_IN_NEEDED";
    const error = signIn ? "Not signed in to Google. Open the extension popup and click Connect Google Drive." : err.message;
    await MT.setDrive(id, { ...prev, error });
    if (signIn) await MT.saveSettings({ driveConnected: false });
    throw new Error(error);
  }
}

// --- when to sync -------------------------------------------------------------------------
//
// A meeting is uploaded when its tab closes, when the user leaves the call, or after
// IDLE_MIN minutes without new captions. Later captions update the same Doc.

const IDLE_MIN = 2;

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name.startsWith("sync:")) syncMeeting(alarm.name.slice(5)).catch(() => {});
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const key = "tab:" + tabId;
  const id = (await chrome.storage.session.get(key))[key];
  if (!id) return;
  await chrome.storage.session.remove(key);
  chrome.alarms.clear("sync:" + id);
  syncMeeting(id).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const tabId = sender.tab && sender.tab.id;
  switch (msg.type) {
    case "status":
      if (tabId) setBadge(tabId, msg);
      return false;
    case "meetingSaved":
      if (tabId) chrome.storage.session.set({ ["tab:" + tabId]: msg.id });
      chrome.alarms.create("sync:" + msg.id, { delayInMinutes: IDLE_MIN });
      return false;
    case "meetingEnded":
      chrome.alarms.clear("sync:" + msg.id);
      syncMeeting(msg.id).catch(() => {});
      return false;
    case "syncNow":
      syncMeeting(msg.id, { interactive: true, force: true })
        .then((r) => reply({ ok: true, result: r }), (e) => reply({ ok: false, error: e.message }));
      return true;
    case "connectDrive":
      chrome.storage.session.remove("token")
        .then(() => getToken(true))
        .then(() => reply({ ok: true }), (e) => reply({ ok: false, error: e.message }));
      return true;
    case "disconnectDrive":
      signOut().then(() => reply({ ok: true }));
      return true;
  }
  return false;
});
