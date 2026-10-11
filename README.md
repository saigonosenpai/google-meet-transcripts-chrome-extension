# Meet Transcripts

A Chrome extension that records your Google Meet calls as text transcripts, so you can
read, search and summarize them later.

It works from Meet's own **live captions**, so there is no audio recording, no server and
no API key. Transcripts are saved only in your browser (`chrome.storage.local`).

## Install

1. Download or clone this repo.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick this folder.
4. Pin the extension so you can see its badge.

## Use it

Join a Meet call. The extension turns captions on for you (or press **c** / the CC button)
and starts recording. The toolbar badge shows the state:

| Badge | Meaning |
|-------|---------|
| `REC` (red) | Captions are on and being recorded |
| `CC` | You're in a call but captions are off, so nothing is being recorded |
| `II` | Recording is paused |

Click the icon to pause/resume, open the live transcript, or change settings:

- **Turn on captions automatically**: clicks Meet's caption button when you join.
- **Hide the caption overlay**: keeps recording but makes the captions on screen invisible.
- **Your name**: Meet labels your own speech "You"; this replaces it with your name.

### Reading transcripts

**All transcripts** opens the library:

- Meetings grouped by day, with full-text search across all of them.
- Each transcript is shown as speaker turns with timestamps (hover for clock time) and a
  talk-time bar per speaker.
- **Questions / Action items / Decisions** filters pull out the matching sentences
  (keyword-based, so skim them for context).
- **Copy for AI summary** copies the transcript with a prompt asking for a summary, key
  points, action items and open questions. Paste it into any AI chat.
- Export as Markdown, plain text or JSON. Click the title to rename the meeting.

The transcript page updates live while the meeting is still being recorded.

## Good to know

- Only what Meet captions is captured. Set the caption language in Meet to match the
  conversation, and expect normal speech-recognition errors.
- If you reload or rejoin the same meeting within 10 minutes, it continues the same
  transcript instead of starting a new one.
- Meet changes its page structure from time to time. The extension looks for captions by
  their accessible "Captions" label first and falls back to known class names. If
  recording stops working after a Meet update, the selectors at the top of `content.js`
  are the place to look.
- Captions in other people's meetings belong to them too. Tell people you're keeping a
  transcript.

## Development

No build step: plain Manifest V3 JavaScript.

| File | What it does |
|------|--------------|
| `content.js` | Runs on meet.google.com; watches the caption panel and saves entries |
| `shared.js` | Storage layout, grouping and export helpers (used everywhere) |
| `background.js` | Toolbar badge per tab |
| `popup.*` | Toolbar popup |
| `viewer.*` | Transcript library and reader |

`test/e2e.mjs` loads the extension in Chromium with Playwright, serves
`test/mock-meet.html` (a page that imitates Meet's caption DOM, including in-place
revisions and Meet trimming the front of long captions) at a meet.google.com URL, and
checks what got stored:

```bash
npm i -D playwright   # or use a global install
node test/e2e.mjs . /tmp   # screenshots land in /tmp
```
