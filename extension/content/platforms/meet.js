// Google Meet. Captions are one block per speaker turn: a name and a line of text that is
// revised in place (and trimmed at the front once it gets long).

const MT_PLATFORM = (() => {
  const { first, cleanName } = MT_DOM;
  // Meet's class names are obfuscated and change between releases, so every lookup has a
  // structural fallback.
  const REGION_SEL = ['[role="region"][aria-label*="aption" i]', '[role="region"][aria-label*="ubtit" i]',
    'div[jsname="dsyhDe"]', 'div[jsname="tgaKEf"]'];
  const BLOCK_SEL = ".nMcdL, .TBMuR";
  const SPEAKER_SEL = ".NWpY1d, .zs7s8d, .KcIKyf";
  const TEXT_SEL = ".ygicle, .bh44bd, .iTTPOb";
  // Participant names: video tiles, then the People panel.
  const TILE_SEL = "[data-participant-id]";
  const TILE_NAME_SEL = "[data-self-name], .zWGUib, .XEazBc, .dwSJ2e, .notranslate";
  const PEOPLE_SEL = '[role="list"][aria-label*="articipant" i] [role="listitem"][aria-label]';
  // Your own name: the account button on Meet's "Ready to join?" screen is labelled
  // "Google Account: Jane Doe (jane@example.com)".
  const ACCOUNT_SEL = '[aria-label^="Google Account:"]';

  const callId = () => (location.pathname.match(/^\/([a-z]{3,4}-[a-z]{4}-[a-z]{3,4})\b/) || [])[1] || null;

  const captionButtons = () =>
    [...document.querySelectorAll("button[aria-label]")].filter((b) => /caption/i.test(b.getAttribute("aria-label")));

  function blocks(region) {
    const found = region.querySelectorAll(BLOCK_SEL);
    if (found.length) return [...found];
    let el = region;
    while (el.children.length === 1) el = el.children[0];
    return [...el.children].filter((c) => c.tagName !== "BUTTON" && !c.querySelector("button"));
  }

  function parseBlock(block, lastSpeaker) {
    const textEl = block.querySelector(TEXT_SEL);
    const speakerEl = block.querySelector(SPEAKER_SEL);
    if (textEl) return { speaker: speakerEl ? speakerEl.innerText : lastSpeaker, text: textEl.innerText, inferred: !speakerEl };
    const lines = block.innerText.split("\n").map((l) => l.trim()).filter(Boolean);
    return lines.length < 2 ? null : { speaker: lines[0], text: lines.slice(1).join(" ") };
  }

  // The calendar event's title, or "" for a spontaneous call (Meet then shows just the code).
  function eventTitle() {
    const code = callId();
    const el = document.querySelector("[data-meeting-title]");
    let t = el ? el.getAttribute("data-meeting-title") : "";
    if (!t) t = document.title.replace(/^\s*(Google\s+)?Meet\s*[-–—:|]\s*/i, "").trim();
    return t && t !== code && !/^(google )?meet$/i.test(t) ? t : "";
  }

  function participants() {
    const names = [];
    for (const tile of document.querySelectorAll(TILE_SEL)) {
      const el = tile.querySelector(TILE_NAME_SEL);
      // Your own tile is often labelled "You"; the recorder adds your real name.
      if (el && !tile.querySelector("[data-self-name]")) names.push(el.textContent);
    }
    for (const item of document.querySelectorAll(PEOPLE_SEL)) names.push(item.getAttribute("aria-label"));
    return names.map(cleanName);
  }

  function selfName() {
    const el = document.querySelector(ACCOUNT_SEL);
    return el ? el.getAttribute("aria-label").replace(/^Google Account:\s*/i, "").split(/\s*[(\n]/)[0].trim() : "";
  }

  function enableCaptions() {
    const btn = captionButtons().find((b) =>
      /turn on|show/i.test(b.getAttribute("aria-label")) || b.getAttribute("aria-pressed") === "false");
    if (btn) btn.click();
  }

  return {
    id: "meet",
    callId,
    // The caption button only exists inside a call; once it is gone the user has left.
    inCall: () => !!first(REGION_SEL) || captionButtons().length > 0,
    captionRegion: () => first(REGION_SEL),
    blocks,
    parseBlock,
    eventTitle,
    participants,
    selfName,
    enableCaptions,
    captionHint: "Turn on captions (CC button, or press c).",
    link: (code) => "https://meet.google.com/" + code,
    // A meeting code is unique, so rejoining it soon after continues the same transcript.
    resumeAfterLeave: true,
  };
})();
