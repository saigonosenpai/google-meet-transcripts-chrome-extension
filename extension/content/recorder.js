// Turns a meeting's live captions into a stored transcript. Everything specific to Google
// Meet, Teams or Zoom (where the captions are, who is speaking, how to turn captions on,
// whether you're still in the call) comes from MT_PLATFORM (content/platforms/*.js).
//
// Captions render as one block per utterance: a name and a line of text that is revised in
// place as speech recognition firms up (and, in Meet, trimmed at the front once it gets long).
// We keep one transcript entry per block, overwrite its text on every revision, stitch trimmed
// text back together, and split long monologues at sentence boundaries so the transcript
// keeps useful timestamps.

(() => {
  const P = MT_PLATFORM;
  const POLL_MS = 1000;
  const FAST_POLL_MS = 300;             // while waiting for captions to appear, so no first words are lost
  const SAVE_DEBOUNCE_MS = 1500;
  const RESUME_WINDOW_MS = 10 * 60_000; // a rejoin within this window continues the same transcript
  const SPLIT_AT = 400;                 // split an entry once it is this long...
  const STABLE_TAIL = 150;              // ...but never inside the still-changing last N chars
  const ENDED_AFTER_MS = 3000;          // call UI gone this long = the user left the call
  const GAP_MIN_MS = 20_000;            // shorter stretches without captions aren't worth marking
  const GENERIC_SPEAKER = /^(speaker|unknown)$/i;
  const SELF_KEY = P.id === "meet" ? "selfName" : "selfName:" + P.id;

  let settings = null;
  let alive = true;
  let code = null;      // the call this tab is in
  let missingSince = 0; // when the call id disappeared
  let region = null;
  let observer = null;
  let session = null;   // { meta, entries } once the first line arrives
  let sessionPromise = null;
  let blocks = new WeakMap();
  let lastSpeaker = "";
  let saveTimer = null;
  let autoTries = 0;
  let lastAutoTry = 0;
  let lastStatus = "";
  let participants = new Set();
  let outOfCallSince = 0;
  let selfName = "";
  let gap = null;       // { from, reason } while captions aren't being recorded mid-call

  const enabled = () => !settings.platforms || settings.platforms[P.id] !== false;
  const me = () => settings.myName || selfName;

  // "You" becomes your name; names you renamed in the viewer ("for future calls") are applied.
  function speakerName(raw) {
    let name = (raw || "").replace(/\s+/g, " ").trim() || "Unknown";
    if (me() && /^you$/i.test(name)) name = me();
    return MT.mapName(settings.nameMap, name);
  }

  function detectSelfName() {
    const name = P.selfName();
    if (name && name !== selfName) {
      selfName = name;
      chrome.storage.local.set({ [SELF_KEY]: selfName }); // e.g. Meet only shows it before you join
    }
  }

  function collectParticipants() {
    const add = (name) => {
      name = MT.dedupeName((name || "").trim());
      if (!name || name.length > 60 || /^\(?(you|me|unknown|speaker)\)?$/i.test(name) || MT.isIconName(name)) return;
      participants.add(MT.mapName(settings.nameMap, name));
    };
    for (const name of P.participants()) add(name);
    if (me()) add(me());
  }

  // --- text stitching -------------------------------------------------------------------

  const key = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const words = (s) => s.split(/\s+/).filter(Boolean);

  // Returns the combined text if `next` continues `prev` (a revision, an extension, or a
  // version whose front was trimmed off), or null if it looks like unrelated new speech.
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

  // A block we haven't seen can still be speech we already have: the page re-drew its caption
  // list, or Zoom's transcript panel repeats what the overlay showed. Finds that entry among
  // the last few, so the speech isn't recorded twice.
  function adopt(speaker, text) {
    if (words(text).length < 5) return null; // short phrases ("Yes, sure.") genuinely repeat
    for (const e of session.entries.slice(-12).reverse()) {
      const sameSpeaker = e.speaker === speaker || GENERIC_SPEAKER.test(e.speaker) || GENERIC_SPEAKER.test(speaker);
      if (!sameSpeaker || words(e.text).length < 5) continue;
      const later = mergeText(e.text, text); // the block repeats or extends the entry
      if (later !== null) return { entry: e, prefix: later.slice(0, later.length - text.length).trim() };
      const earlier = mergeText(text, e.text); // the entry was a later part of the block
      if (earlier !== null) return { entry: e, prefix: "" };
    }
    return null;
  }

  // --- caption parsing ------------------------------------------------------------------

  // `inferred`: the block doesn't name its speaker, so the adapter guessed (the previous
  // speaker, or Zoom's active-speaker tile). A block keeps the speaker it was first given.
  function parse(block, st) {
    const parsed = P.parseBlock(block, lastSpeaker);
    if (!parsed) return null;
    const text = (parsed.text || "").replace(/\s+/g, " ").trim();
    if (!text) return null;
    return { speaker: parsed.inferred && st ? st.speaker : speakerName(parsed.speaker), text };
  }

  function addEntry(speaker, text) {
    const entry = { speaker, text, ts: Date.now() };
    session.entries.push(entry);
    return entry;
  }

  function scan() {
    if (!region || !session || settings.paused || !enabled()) return;
    let changed = false;
    for (const block of P.blocks(region)) {
      let st = blocks.get(block);
      const parsed = parse(block, st);
      if (!parsed) continue;
      const { speaker, text } = parsed;
      lastSpeaker = speaker;
      let full = st && st.speaker === speaker ? mergeText(st.full, text) : null;
      if (full === null) {
        const known = !st && adopt(speaker, text);
        if (known) {
          if (GENERIC_SPEAKER.test(known.entry.speaker)) known.entry.speaker = speaker;
          st = { speaker, full: "", committed: 0, prefix: known.prefix, entry: known.entry };
          full = text;
          if (known.entry.text.length > (known.prefix ? known.prefix + " " : "").length + text.length) {
            blocks.set(block, { ...st, full: text }); // the entry already holds more than the block shows
            continue;
          }
          blocks.set(block, st);
        } else {
          st = { speaker, full: text, committed: 0, prefix: "", entry: addEntry(speaker, text) };
          blocks.set(block, st);
          changed = true;
          continue;
        }
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
      const lead = st.prefix ? st.prefix + " " : "";
      if (cut > 0) {
        st.entry.text = lead + rest.slice(0, cut).trim();
        st.committed = start + cut;
        st.prefix = "";
        st.entry = addEntry(speaker, rest.slice(cut).trim());
      } else {
        st.entry.text = lead + rest.trim();
      }
    }
    if (changed) scheduleSave();
  }

  // --- gaps: stretches of a call with nothing recorded ----------------------------------

  function trackGap() {
    if (!session) return;
    const recording = !!region && !settings.paused && enabled();
    if (!recording && !gap) gap = { from: Date.now(), reason: settings.paused ? "paused" : "captions" };
    if (recording && gap) closeGap();
  }

  function closeGap(to = Date.now()) {
    if (!gap) return;
    if (session && to - gap.from >= GAP_MIN_MS) {
      session.meta.gaps = [...(session.meta.gaps || []), { from: gap.from, to, reason: gap.reason }];
      scheduleSave();
    }
    gap = null;
  }

  // --- session + persistence ------------------------------------------------------------

  async function ensureSession() {
    if (session) return session;
    if (!sessionPromise) {
      sessionPromise = (async () => {
        const now = Date.now();
        const recent = (await MT.listMeetings()).find((m) => (m.platform || "meet") === P.id && m.code === code &&
          now - (m.endedAt || m.startedAt) < RESUME_WINDOW_MS && (P.resumeAfterLeave || !m.left));
        let meta;
        if (recent) {
          meta = { ...recent, left: false };
          if (now - recent.endedAt >= GAP_MIN_MS) meta.gaps = [...(recent.gaps || []), { from: recent.endedAt, to: now, reason: "left" }];
        } else {
          meta = { id: code + "-" + now, code, platform: P.id, eventTitle: P.eventTitle(), startedAt: now, endedAt: now };
        }
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
    meta.platform = P.id;
    meta.link = P.link(meta.code) || meta.link || "";
    meta.eventTitle = P.eventTitle() || meta.eventTitle || "";
    meta.self = me() || meta.self || "";
    meta.participants = [...participants];
    meta.endedAt = Math.max(meta.endedAt || 0, entries[entries.length - 1].ts);
    try {
      await MT.saveMeeting(meta, entries.filter((e) => e.text));
      chrome.runtime.sendMessage({ type: "meetingSaved", id: meta.id });
    } catch (err) {
      if (String(err).includes("context invalidated")) shutdown();
      else console.warn("[Meeting Transcripts] save failed", err);
    }
  }

  async function endSession() {
    if (!session) return;
    closeGap();
    session.meta.left = true;
    const id = session.meta.id; // resetSession clears `session` while we save
    await save();
    try { chrome.runtime.sendMessage({ type: "meetingEnded", id }); } catch {}
  }

  function resetSession() {
    endSession();
    session = null;
    sessionPromise = null;
    blocks = new WeakMap();
    autoTries = 0;
    participants = new Set();
    outOfCallSince = 0;
    gap = null;
  }

  // --- page integration -----------------------------------------------------------------

  function attach(el) {
    if (observer) observer.disconnect();
    region = el;
    if (!el) return;
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
    // Opacity (not display:none) so the page keeps rendering text we can read.
    const hide = settings.hideCaptions && enabled();
    region.style.opacity = hide ? "0" : "";
    region.style.pointerEvents = hide ? "none" : "";
  }

  async function tryEnableCaptions(force = false) {
    // Everything depends on captions, so they're always turned on; only not while paused,
    // which is how you keep a call out of your transcripts.
    if (!force && (settings.paused || autoTries >= 3 || Date.now() - lastAutoTry < 8000)) return;
    lastAutoTry = Date.now();
    autoTries++;
    try { await P.enableCaptions(); } catch (err) { console.warn("[Meeting Transcripts] couldn't turn on captions", err); }
  }

  function status() {
    return {
      platform: P.id,
      inMeeting: !!code && enabled(),
      disabled: !!code && !enabled(),
      captionsOn: !!region,
      paused: settings.paused,
      count: session ? session.entries.length : 0,
      title: session ? MT.title(session.meta) : code ? P.eventTitle() || "Call" : "",
      meetingId: session ? session.meta.id : null,
      captionHint: P.captionHint,
    };
  }

  // A call page can be split into frames (Zoom's web client may be); the frame showing the
  // call answers for the tab, and the others stay quiet.
  const isTop = window === window.top;
  const showsCall = () => !!region || P.inCall();

  function sendStatus() {
    const s = status();
    renderPill(s);
    if (!isTop && !showsCall()) return;
    const sig = JSON.stringify([s.inMeeting, s.captionsOn, s.paused, s.disabled]);
    if (sig === lastStatus) return;
    lastStatus = sig;
    try { chrome.runtime.sendMessage({ type: "status", ...s }); } catch { shutdown(); }
  }

  function tick() {
    if (!alive) return;
    const id = P.callId();
    if (id && id !== code) {
      if (code) resetSession();
      code = id;
      attach(null);
    }
    // Teams and Zoom only show a call id while the call UI is up; give it a few seconds.
    const now = Date.now();
    missingSince = id || !code ? 0 : missingSince || now;
    if (missingSince && now - missingSince >= ENDED_AFTER_MS) {
      resetSession();
      code = null;
      attach(null);
    }
    if (code && enabled()) {
      const el = P.captionRegion();
      if (el !== region) attach(el);
      if (!region && P.inCall()) tryEnableCaptions();
      detectSelfName();
      collectParticipants();
      const inCall = !!region || P.inCall();
      if (inCall) outOfCallSince = 0;
      else if (!outOfCallSince) outOfCallSince = now;
      else if (outOfCallSince > 0 && now - outOfCallSince >= ENDED_AFTER_MS) {
        outOfCallSince = -1; // ended; stays so until the call UI is back
        endSession();
      }
      if (inCall) trackGap();
    } else if (region) {
      attach(null);
    }
    sendStatus();
  }

  // --- the in-call indicator --------------------------------------------------------------
  //
  // A small pill in the corner of the call: red while recording, with one click to pause,
  // resume or turn captions on. Only you see it.

  let pill = null;
  let pillHidden = false;

  function makePill() {
    const host = document.createElement("div");
    host.id = "meeting-transcripts-indicator";
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `<style>
      :host { all: initial; position: fixed; left: 16px; bottom: 96px; z-index: 2147483000; }
      .pill { display: flex; align-items: center; gap: 6px; height: 28px; padding: 0 4px 0 10px; border-radius: 999px;
        font: 600 12px/1 system-ui, -apple-system, "Segoe UI", sans-serif; color: #fff; letter-spacing: 0.01em;
        background: rgba(28, 28, 30, 0.82); backdrop-filter: blur(16px) saturate(180%); -webkit-backdrop-filter: blur(16px) saturate(180%);
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25), inset 0 0 0 0.5px rgba(255, 255, 255, 0.18);
        transition: transform 100ms ease-out, opacity 200ms ease; user-select: none; }
      button { all: unset; cursor: pointer; display: flex; align-items: center; gap: 6px; height: 28px; }
      .main:active { transform: scale(0.97); }
      .dot { width: 8px; height: 8px; border-radius: 50%; background: #8e8e93; flex: none; }
      .rec .dot { background: #ff453a; animation: pulse 1.6s ease-in-out infinite; }
      .warn .dot { background: #ff9f0a; }
      .x { width: 20px; justify-content: center; border-radius: 50%; color: rgba(255, 255, 255, 0.6); font-size: 14px; }
      .x:hover { background: rgba(255, 255, 255, 0.14); color: #fff; }
      button:focus-visible { outline: 2px solid #0a84ff; outline-offset: 2px; border-radius: 999px; }
      @keyframes pulse { 50% { opacity: 0.35; } }
      @media (prefers-reduced-motion: reduce) { .rec .dot { animation: none; } .main:active { transform: none; } }
      @media (prefers-reduced-transparency: reduce) { .pill { background: #1c1c1e; backdrop-filter: none; } }
    </style><div class="pill" part="pill"><button class="main"><span class="dot"></span><span class="text"></span></button>` +
      `<button class="x" aria-label="Hide for this call" title="Hide for this call">×</button></div>`;
    const [main, x] = root.querySelectorAll("button");
    main.addEventListener("click", () => {
      if (settings.paused) MT.saveSettings({ paused: false });
      else if (region) MT.saveSettings({ paused: true });
      else tryEnableCaptions(true);
    });
    x.addEventListener("click", () => { pillHidden = true; host.remove(); pill = null; });
    return { host, box: root.querySelector(".pill"), main, text: root.querySelector(".text") };
  }

  function renderPill(s) {
    const show = s.inMeeting && settings.showIndicator !== false && !pillHidden && (!!region || P.inCall());
    if (!show) {
      if (pill) { pill.host.remove(); pill = null; }
      return;
    }
    if (!pill) pill = makePill();
    if (!pill.host.isConnected) document.documentElement.append(pill.host);
    const [cls, text, tip] = s.paused
      ? ["warn", "Paused", "Meeting Transcripts is paused. Click to resume recording."]
      : s.captionsOn
        ? ["rec", "Recording captions", "Meeting Transcripts is saving this call's captions. Click to pause."]
        : ["warn", "Captions off · not recording", "Click to turn on captions. " + P.captionHint];
    pill.box.className = "pill " + cls;
    pill.text.textContent = text;
    pill.main.title = tip;
  }

  // --- diagnostics ---------------------------------------------------------------------------
  //
  // When captions aren't picked up (most likely after Teams or Zoom changes its page), the
  // popup copies this report: the structure of the page around the captions, never the
  // caption text itself.

  function describe(el) {
    const attrs = ["data-tid", "role", "aria-live", "jsname"].map((a) => el.getAttribute(a) && `[${a}=${el.getAttribute(a)}]`).filter(Boolean);
    const aria = el.getAttribute("aria-label");
    if (aria) attrs.push(`[aria-label=${aria.slice(0, 40)}${aria.length > 40 ? "…" : ""}]`);
    const cls = typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\s+/).slice(0, 4).join(".") : "";
    return `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}${cls}${attrs.join("")} (${(el.textContent || "").length} chars)`;
  }

  function outline(el, depth, indent = "") {
    let out = indent + describe(el) + "\n";
    if (depth > 0) for (const c of [...el.children].slice(0, 6)) out += outline(c, depth - 1, indent + "  ");
    return out;
  }

  function diagnose() {
    const candidates = [...document.querySelectorAll("[id], [class], [data-tid], [aria-label]")].filter((el) =>
      /caption|subtitle|transcri/i.test([el.id, typeof el.className === "string" ? el.className : "",
        el.getAttribute("data-tid"), el.getAttribute("aria-label")].join(" "))).slice(0, 12);
    return {
      extension: chrome.runtime.getManifest().version,
      platform: P.id,
      page: location.hostname + location.pathname.replace(/\d{5,}/g, "<number>"),
      inCall: P.inCall(),
      captionsFound: !!region,
      blocks: region ? P.blocks(region).length : 0,
      linesRecorded: session ? session.entries.length : 0,
      captionArea: region ? outline(region, 3) : null,
      candidates: candidates.map((el) => outline(el, 2)),
    };
  }

  function shutdown() {
    alive = false;
    if (observer) observer.disconnect();
    if (pill) pill.host.remove();
  }

  async function init() {
    settings = await MT.getSettings();
    selfName = (await chrome.storage.local.get(SELF_KEY))[SELF_KEY] || "";
    chrome.storage.onChanged.addListener((changes) => {
      if (!changes.settings) return;
      settings = { ...settings, ...changes.settings.newValue };
      applyHide();
      lastStatus = "";
      trackGap();
      sendStatus();
    });
    chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
      if ((msg.type === "getStatus" || msg.type === "diagnose") && !showsCall()) {
        if (!isTop) return false;
        // Give a frame that shows the call the chance to answer first.
        setTimeout(() => reply(msg.type === "getStatus" ? status() : diagnose()), 200);
        return true;
      }
      if (msg.type === "getStatus") reply(status());
      if (msg.type === "diagnose") reply(diagnose());
      if (msg.type === "enableCaptions") tryEnableCaptions(true).then(() => reply(status()));
      if (msg.type === "flush") save().then(() => reply(status()));
      return msg.type === "flush" || msg.type === "enableCaptions";
    });
    window.addEventListener("pagehide", save);
    document.addEventListener("visibilitychange", () => document.hidden && save());
    const loop = () => {
      tick();
      if (alive) setTimeout(loop, code && !region && enabled() ? FAST_POLL_MS : POLL_MS);
    };
    loop();
  }

  init();
})();
