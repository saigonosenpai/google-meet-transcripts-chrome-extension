// Shows recording state on the toolbar icon for each Meet tab.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type !== "status" || !sender.tab) return;
  const tabId = sender.tab.id;
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
});
