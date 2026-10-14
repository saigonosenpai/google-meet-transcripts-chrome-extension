// Microsoft Teams on the web (teams.microsoft.com, teams.live.com, teams.cloud.microsoft).
//
// Live captions are a list of items, one per utterance, each with an author and a text that
// is revised until it settles. Teams marks its UI with data-tid attributes, which are more
// stable than its class names; text-based fallbacks cover renamed attributes.

const MT_PLATFORM = (() => {
  const { first, all, visible, control, clickWhenShown, closeMenus, sleep, cleanName } = MT_DOM;

  const REGION_SEL = ['[data-tid="closed-caption-v2-window-wrapper"]', '[data-tid="closed-captions-renderer"]',
    '[data-tid="closed-caption-renderer-wrapper"]', '[data-tid*="closed-caption" i][role="log"]',
    '[aria-label*="live caption" i][role="log"]', '[aria-label*="captions" i][role="log"]'];
  const AUTHOR_SEL = '[data-tid="author"], [data-tid="closed-caption-author"], .ui-chat__message__author';
  const TEXT_SEL = '[data-tid="closed-caption-text"], [data-tid="closed-caption-message"]';
  const HANGUP_SEL = ['#hangup-button', '[data-tid="hangup-main-btn"]', '[data-tid="call-hangup"]',
    '[data-tid="hangup-button"]', 'button[aria-label^="Leave" i]', 'button[aria-label*="hang up" i]'];
  const TITLE_SEL = ['[data-tid="call-title"]', '[data-tid="meeting-title"]', '[data-tid="call-status-title"]'];
  const ROSTER_SEL = ['[data-tid^="participantsInCall"] [data-tid="roster-participant"] [title]',
    '[data-tid="roster-participant"] [data-tid="roster-participant-name"]', '[data-tid="participant-name"]',
    '[data-tid="calling-participant-stream"] [data-tid="display-name"]'];
  const GENERIC = /^(microsoft teams|teams|meeting|meetings|calendar|chat|calls?|activity|meet|meet now|meeting compact view|main window|compact meeting view|untitled)$/i;

  const inCall = () => !!first(HANGUP_SEL);

  function blocks(region) {
    // One item per utterance: the nearest ancestor of each caption text that also holds its author.
    const out = [];
    for (const textEl of region.querySelectorAll(TEXT_SEL)) {
      let item = textEl.parentElement;
      while (item && item !== region && !item.querySelector(AUTHOR_SEL)) item = item.parentElement;
      out.push(item && item !== region ? item : textEl);
    }
    return [...new Set(out)];
  }

  function parseBlock(block, lastSpeaker) {
    const textEl = block.matches(TEXT_SEL) ? block : block.querySelector(TEXT_SEL);
    const authorEl = block.querySelector(AUTHOR_SEL);
    return textEl ? { speaker: authorEl ? authorEl.innerText : lastSpeaker, text: textEl.innerText, inferred: !authorEl } : null;
  }

  // The meeting's subject. Teams titles the window "<subject> | Microsoft Teams" (with view names
  // like "Calendar" or "Meeting" mixed in); instant meetings are "Meet now" or "Meeting with …".
  function eventTitle() {
    const el = first(TITLE_SEL);
    const parts = el ? [el.textContent] : document.title.split(/\s+[|–—]\s+/);
    const t = parts.map((p) => p.replace(/\(\d+\)\s*/, "").trim()).find((p) => p && !GENERIC.test(p)) || "";
    return /^(meet now|meeting with |meeting in |call with |chat with )/i.test(t) ? "" : t;
  }

  const participants = () => all(ROSTER_SEL).map((el) => cleanName(el.getAttribute("title") || el.textContent));

  // Live captions live under More (…) › Language and speech › Turn on live captions; newer
  // builds name the menu "Captions and transcripts" or put a Captions button in the bar.
  async function enableCaptions() {
    if (await clickWhenShown(/^(turn on live captions|show live captions|turn on captions|live captions)$/i, 0)) return;
    const more = first(['#callingButtons-showMoreBtn', '[data-tid="more-button"]', '[data-tid="callingButtons-showMoreBtn"]']) ||
      control(/^(more|more actions|more options)$/i);
    if (!more) return;
    more.click();
    await sleep(300);
    if (!(await clickWhenShown(/^(turn on live captions|show live captions|turn on captions)$/i, 300))) {
      await clickWhenShown(/^(language and speech|captions and transcripts|captions and transcript|captions)$/i, 1200);
      await clickWhenShown(/^(turn on live captions|show live captions|turn on captions|live captions)$/i, 1200);
    }
    await sleep(200);
    if (visible(document.querySelector('[role="menu"]'))) closeMenus();
  }

  return {
    id: "teams",
    // Teams' URL doesn't name the meeting, so a call is "the call this tab is in": its call
    // controls, or failing that its captions, are on screen.
    callId: () => (inCall() || first(REGION_SEL) ? "teams" : null),
    inCall,
    captionRegion: () => first(REGION_SEL),
    blocks,
    parseBlock,
    eventTitle,
    participants,
    selfName: () => "",
    enableCaptions,
    captionHint: "Turn on live captions: More (…) › Language and speech › Turn on live captions.",
    link: () => "",
    // Every Teams call has the same id here, so only a reload or crash continues a transcript.
    resumeAfterLeave: false,
  };
})();
