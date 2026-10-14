// Syncing the library across devices, for the extension's pages (library and popup).
//
// Each device writes its whole library to Meeting Transcripts/devices/<device id>.json
// (background.js does that through Chrome's downloads, like every file it saves). The folder is
// kept in sync between the devices by the user's own cloud app: Google Drive, OneDrive, Dropbox
// or iCloud. Here, each device reads the other devices' files and merges them in (MT.mergeLibrary).
// The extension itself still never connects to anything.
//
// Reading needs access to the folder: the user picks it once (showDirectoryPicker) and the
// handle is kept in IndexedDB. Chrome may ask again for permission in a later session ("Allow
// on every visit" stops that); asking needs a click, so syncNow({ ask: true }) is for buttons.

const SYNC = (() => {
  const DB = "meeting-transcripts", STORE = "handles", KEY = "syncFolder";

  function db() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idb(mode, fn) {
    const d = await db();
    try {
      return await new Promise((resolve, reject) => {
        const req = fn(d.transaction(STORE, mode).objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    } finally {
      d.close();
    }
  }

  const getFolder = () => idb("readonly", (s) => s.get(KEY)).catch(() => null);
  const setFolder = (handle) => idb("readwrite", (s) => s.put(handle, KEY));
  const clearFolder = () => idb("readwrite", (s) => s.delete(KEY)).catch(() => {});

  async function permitted(handle, ask) {
    const opts = { mode: "read" };
    if (!handle.queryPermission || (await handle.queryPermission(opts)) === "granted") return true;
    return ask ? (await handle.requestPermission(opts)) === "granted" : false;
  }

  async function state() {
    const { sync = {} } = await chrome.storage.local.get("sync");
    return sync;
  }

  // Reads every other device's file and merges it in. Returns what happened, or why it didn't.
  async function syncNow({ ask = false } = {}) {
    const sync = await state();
    if (!sync.on) return { ok: false, reason: "off" };
    const folder = await getFolder();
    if (!folder) return { ok: false, reason: "no-folder" };
    if (!(await permitted(folder, ask).catch(() => false))) return { ok: false, reason: "permission" };
    const me = await MT.getDevice();
    const result = { ok: true, added: 0, updated: 0, removed: 0, read: 0, devices: [] };
    // Files already merged, by size and time: only a file that changed since is read again.
    const before = sync.seen || {}, seen = {};
    let dir = null;
    try { dir = await folder.getDirectoryHandle("devices"); } catch { /* no device has written yet */ }
    if (dir) {
      for await (const [name, entry] of dir.entries()) {
        if (entry.kind !== "file" || !/\.json$/i.test(name) || name === me.id + ".json") continue;
        let file;
        try { file = await entry.getFile(); } catch { continue; } // being synced right now
        const sig = file.lastModified + ":" + file.size;
        if (before[name] && before[name].sig === sig) {
          seen[name] = before[name];
          result.devices.push(before[name].device);
          continue;
        }
        let lib = null;
        try { lib = DOCX_IMPORT.parseLibrary(await file.text()); } catch { /* half-written; next time */ }
        if (!lib || (lib.device && lib.device.id === me.id)) continue;
        const from = (lib.device && lib.device.name) || name.replace(/\.json$/i, "");
        const r = await MT.mergeLibrary(lib, from);
        result.read++;
        result.added += r.added; result.updated += r.updated; result.removed += r.removed;
        result.devices.push(from);
        seen[name] = { sig, device: from };
      }
    }
    await chrome.storage.local.set({ sync: { ...(await state()), lastSync: Date.now(), devices: result.devices, seen } });
    return result;
  }

  // Turns sync on with the folder the user picked: this device writes its file right away, and
  // it must then show up in that folder, or the folder isn't where this device saves.
  async function turnOn(folder) {
    await chrome.storage.local.set({ sync: { ...(await state()), on: true, seen: {} } });
    const { filename } = await chrome.runtime.sendMessage({ type: "writeLibrary" });
    const me = await MT.getDevice();
    let found = false;
    for (let i = 0; i < 20 && !found; i++) {
      try {
        await (await folder.getDirectoryHandle("devices")).getFileHandle(me.id + ".json");
        found = true;
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    if (!found) {
      await chrome.storage.local.set({ sync: { ...(await state()), on: false } });
      return { ok: false, savesTo: filename ? filename.replace(/[\\/]devices[\\/][^\\/]+$/, "") : null };
    }
    await setFolder(folder);
    return { ok: true, ...(await syncNow()) };
  }

  async function turnOff() {
    await chrome.storage.local.set({ sync: { ...(await state()), on: false } });
    await clearFolder();
  }

  return { state, syncNow, turnOn, turnOff, getFolder, setFolder };
})();
