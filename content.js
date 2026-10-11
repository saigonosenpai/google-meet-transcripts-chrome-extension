// Watches Google Meet's live-caption panel and turns it into a stored transcript.
//
// Meet renders captions as one block per speaker turn: a name and a growing line of text
// that is revised in place as speech recognition firms up (and trimmed at the front once it
// gets long). We keep one transcript entry per block, overwrite its text on every revision,
// stitch trimmed text back together, and split long monologues at sentence boundaries so
// the transcript keeps useful timestamps.

(() => {
  const POLL_MS = 1000;
  const SAVE_DEBOUNCE_MS = 1500;
  const RESUME_WINDOW_MS = 10 * 60_000; // a rejoin within this window continues the same transcript
  const SPLIT_AT = 400;                 // split an entry once it is this long...
  const STABLE_TAIL = 150;              // ...but never inside the still-changing last N chars

  // Meet's class names are obfuscated and change between releases, so every lookup has a
  // structural fallback.
  const REGION_SEL = '[role="region"][aria-label*="aption" i], [role="region"][aria-label*="ubtit" i], ' +
    'div[jsname="dsyhDe"], div[jsname="tgaKEf"]';
  const BLOCK_SEL = ".nMcdL, .TBMuR";
  const SPEAKER_SEL = ".NWpY1d, .zs7s8d, .KcIKyf";
  const TEXT_SEL = ".ygicle, .bh44bd, .iTTPOb";
  // Participant names: video tiles, then the People panel.
  const TILE_SEL = "[data-participant-id]";
  const TILE_NAME_SEL = "[data-self-name], .zWGUib, .XEazBc, .dwSJ2e";
  const PEOPLE_SEL = '[role="list"][aria-label*="articipant" i] [role="listitem"][aria-label]';
  const ENDED_AFTER_TICKS = 3; // call UI gone this many polls in a row = user left the call

  let settings = null;
  let region = null;
  let observer = null;
  let code = null;
  let session = null;   // { meta, entries } once the first line arrives
  let sessionPromise = null;
  let blocks = new WeakMap();
  let lastSpeaker = "";
  let saveTimer = null;
  let captionsSeen = false;
  let autoTries = 0;
  let lastAutoTry = 0;
  let lastStatus = "";
  let alive = true;
  let participants = new Set();
  let outOfCallTicks = 0;

  const meetingCode = () => (location.pathname.match(/^\/([a-z]{3,4}-[a-z]{4}-[a-z]{3,4})\b/) || [])[1] || null;

  function meetingTitle() {
    const el = document.querySelector("[data-meeting-title]");
    let t = el ? el.getAttribute("data-meeting-title") : "";
    if (!t) t = document.title.replace(/^\s*(Google\s+)?Meet\s*[-–—:|]\s*/i, "").trim();
    return t && t !== code && !/^(google )?meet$/i.test(t) ? t : "Meet " + code;
  }

  function collectParticipants() {
    const add = (name) => {
      name = (name || "").split("\n")[0].trim();
      if (!name || name.length > 60 || /^(you|unknown)$/i.test(name)) return;
      participants.add(name);
    };
    for (const tile of document.querySelectorAll(TILE_SEL)) {
      const el = tile.querySelector(TILE_NAME_SEL);
      if (el) add(el.getAttribute("data-self-name") || el.textContent);
    }
    for (const item of document.querySelectorAll(PEOPLE_SEL)) add(item.getAttribute("aria-label"));
    if (settings.myName) add(settings.myName);
  }

  // --- text stitching -------------------------------------------------------------------

  const key = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const words = (s) => s.split(/\s+/).filter(Boolean);

  // Returns the combined text if `next` continues `prev` (a revision, an extension, or a
  // version whose front Meet trimmed off), or null if it looks like unrelated new speech.
  // Tries every offset at which `next` could start inside `prev` and keeps the best word
  // alignment; offset 0 is a plain revision/extension.
  function mergeText(prev, next) {
    if (!prev) return next;
    const pw = words(prev), nw = words(next);
    const pk = pw.map(key), nk = nw.map(key);
    let best = -1, bestScore = 0;
    for (let i = 0; i < pk.length; i++) {
      const len = Math.min(nk.length, pk.length - i);
      if (len < Math.max(1, nk.length / 2) && i > 0) break;
      let same = 0;
      for (let j = 0; j < len; j++) if (pk[i + j] === nk[j]) same++;
      const score = same / len;
      if (score > bestScore) { best = i; bestScore = score; }
      if (score === 1) break;
    }
    if (best < 0 || bestScore < 0.6) return null;
    return best === 0 ? next : pw.slice(0, best).concat(nw).join(" ");
  }

  // --- caption parsing ------------------------------------------------------------------

  function captionBlocks(root) {
    let found = root.querySelectorAll(BLOCK_SEL);
    if (found.length) return [...found];
    let el = root;
    while (el.children.length === 1) el = el.children[0];
    return [...el.children].filter((c) => c.tagName !== "BUTTON" && !c.querySelector("button"));
  }

  function parseBlock(block) {
    const textEl = block.querySelector(TEXT_SEL);
    const speakerEl = block.querySelector(SPEAKER_SEL);
    let speaker, text;
    if (textEl) {
      text = textEl.innerText;
      speaker = speakerEl ? speakerEl.innerText : lastSpeaker;
    } else {
      const lines = block.innerText.split("\n").map((l) => l.trim()).filter(Boolean);
      if (lines.length < 2) return null;
      speaker = lines[0];
      text = lines.slice(1).join(" ");
    }
    text = (text || "").replace(/\s+/g, " ").trim();
    speaker = (speaker || "").trim() || "Unknown";
    if (!text) return null;
    if (settings.myName && /^you$/i.test(speaker)) speaker = settings.myName;
    return { speaker, text };
  }

  function addEntry(speaker, text) {
    const entry = { speaker, text, ts: Date.now() };
    session.entries.push(entry);
    return entry;
  }

  function scan() {
    if (!region || !session || settings.paused) return;
    let changed = false;
    for (const block of captionBlocks(region)) {
      const parsed = parseBlock(block);
      if (!parsed) continue;
      const { speaker, text } = parsed;
      lastSpeaker = speaker;
      let st = blocks.get(block);
      let full = st && st.speaker === speaker ? mergeText(st.full, text) : null;
      if (full === null) {
        st = { speaker, full: text, committed: 0, entry: addEntry(speaker, text) };
        blocks.set(block, st);
        changed = true;
        continue;
      }
      if (full === st.full) continue;
      st.full = full;
      changed = true;

      let start = st.committed;
      while (start > 0 && start < full.length && !/\s/.test(full[start - 1])) start++; // snap to a word
      let rest = full.slice(start);
      // Split long monologues at a sentence end that is old enough not to be revised.
      let cut = -1;
      if (rest.length > SPLIT_AT) {
        const re = /[.?!]\s/g;
        let m;
        while ((m = re.exec(rest)) && m.index < rest.length - STABLE_TAIL) if (m.index > 100) cut = m.index + 1;
      }
      if (cut > 0) {
        st.entry.text = rest.slice(0, cut).trim();
        st.committed = start + cut;
        st.entry = addEntry(speaker, rest.slice(cut).trim());
      } else {
        st.entry.text = rest.trim();
      }
    }
    if (changed) scheduleSave();
  }

  // --- session + persistence ------------------------------------------------------------

  async function ensureSession() {
    if (session) return session;
    if (!sessionPromise) {
      sessionPromise = (async () => {
        const now = Date.now();
        const recent = (await MT.listMeetings()).find(
          (m) => m.code === code && now - (m.endedAt || m.startedAt) < RESUME_WINDOW_MS);
        const meta = recent
          ? { ...recent }
          : { id: code + "-" + now, code, title: meetingTitle(), startedAt: now, endedAt: now };
        const entries = recent ? await MT.getTranscript(recent.id) : [];
        session = { meta, entries };
        return session;
      })();
    }
    return sessionPromise;
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, SAVE_DEBOUNCE_MS);
    sendStatus();
  }

  async function save() {
    clearTimeout(saveTimer);
    if (!session || !session.entries.length || !alive) return;
    const { meta, entries } = session;
    meta.title = meetingTitle();
    meta.participants = [...participants];
    meta.endedAt = Math.max(meta.endedAt || 0, entries[entries.length - 1].ts);
    try {
      await MT.saveMeeting(meta, entries.filter((e) => e.text));
      chrome.runtime.sendMessage({ type: "meetingSaved", id: meta.id });
    } catch (err) {
      if (String(err).includes("context invalidated")) shutdown();
      else console.warn("[Meet Transcripts] save failed", err);
    }
  }

  async function endSession() {
    if (!session) return;
    const id = session.meta.id; // resetSession clears `session` while we save
    await save();
    try { chrome.runtime.sendMessage({ type: "meetingEnded", id }); } catch {}
  }

  function resetSession() {
    endSession();
    session = null;
    sessionPromise = null;
    blocks = new WeakMap();
    captionsSeen = false;
    autoTries = 0;
    participants = new Set();
    outOfCallTicks = 0;
  }

  // --- page integration -----------------------------------------------------------------

  function attach(el) {
    if (observer) observer.disconnect();
    region = el;
    if (!el) return;
    captionsSeen = true;
    applyHide();
    let pending = false;
    observer = new MutationObserver(() => {
      if (pending) return;
      pending = true;
      setTimeout(() => { pending = false; scan(); }, 250);
    });
    observer.observe(el, { childList: true, subtree: true, characterData: true });
    ensureSession().then(scan);
  }

  function applyHide() {
    if (!region) return;
    // Opacity (not display:none) so Meet keeps rendering text we can read.
    region.style.opacity = settings.hideCaptions ? "0" : "";
    region.style.pointerEvents = settings.hideCaptions ? "none" : "";
  }

  const captionButtons = () =>
    [...document.querySelectorAll("button[aria-label]")].filter((b) => /caption/i.test(b.getAttribute("aria-label")));

  function tryEnableCaptions() {
    if (!settings.autoCaptions || captionsSeen || autoTries >= 5 || Date.now() - lastAutoTry < 4000) return;
    const btn = captionButtons().find((b) =>
      /turn on|show/i.test(b.getAttribute("aria-label")) || b.getAttribute("aria-pressed") === "false");
    if (!btn) return;
    lastAutoTry = Date.now();
    autoTries++;
    btn.click();
  }

  function status() {
    return {
      inMeeting: !!code,
      captionsOn: !!region,
      paused: settings.paused,
      count: session ? session.entries.length : 0,
      title: code ? meetingTitle() : "",
      meetingId: session ? session.meta.id : null,
    };
  }

  function sendStatus() {
    const s = status();
    const sig = JSON.stringify([s.inMeeting, s.captionsOn, s.paused]);
    if (sig === lastStatus) return;
    lastStatus = sig;
    try { chrome.runtime.sendMessage({ type: "status", ...s }); } catch { shutdown(); }
  }

  function tick() {
    if (!alive) return;
    const c = meetingCode();
    if (c !== code) {
      if (code) resetSession();
      code = c;
      attach(null);
    }
    if (code) {
      const el = document.querySelector(REGION_SEL);
      if (el !== region) attach(el);
      if (!region) tryEnableCaptions();
      collectParticipants();
      // The caption button only exists inside a call; once it is gone the user has left.
      const inCall = !!region || captionButtons().length > 0;
      outOfCallTicks = inCall ? 0 : outOfCallTicks + 1;
      if (outOfCallTicks === ENDED_AFTER_TICKS) endSession();
    }
    sendStatus();
  }

  function shutdown() {
    alive = false;
    if (observer) observer.disconnect();
  }

  async function init() {
    settings = await MT.getSettings();
    chrome.storage.onChanged.addListener((changes) => {
      if (!changes.settings) return;
      settings = { ...settings, ...changes.settings.newValue };
      applyHide();
      lastStatus = "";
      sendStatus();
    });
    chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
      if (msg.type === "getStatus") reply(status());
      if (msg.type === "flush") save().then(() => reply(status()));
      return msg.type === "flush";
    });
    window.addEventListener("pagehide", save);
    document.addEventListener("visibilitychange", () => document.hidden && save());
    setInterval(tick, POLL_MS);
    tick();
  }

  init();
})();
