# Meet Transcripts

A Chrome extension that records your Google Meet calls as text transcripts and saves each
call as a **Word document (.docx)**, grouped in a folder per day, so you can read, search
and reference them later.
Works on **macOS and Windows** (and Linux): anywhere desktop Chrome runs.

It works from Meet's own **live captions**: no audio recording, no account, no sign-in,
nothing sent anywhere. Each call is saved to your Downloads folder:

```
Downloads/Meet Transcripts/
  2026-10-11/
    2026-10-11 - Weekly sync - Alice, Bob, Carol, Sam Lee.docx
    2026-10-11 - Call with Alice, Bob.docx
    2026-10-11 - Call with Alice, Bob (2).docx
  2026-10-12/
    2026-10-12 - Design review - Dana, Eli, Sam Lee +3.docx
    2026-10-12 - Call with Dana.docx
```

On a Mac that's `~/Downloads/Meet Transcripts/`, on Windows
`C:\Users\<you>\Downloads\Meet Transcripts\`. The files open in Word, Pages, Google Docs
or LibreOffice.

How a call is named depends on what kind of call it was:

- **Scheduled meetings** (a Calendar event with a title):
  `Date - Event name - Participants`, e.g. `2026-10-11 - Weekly sync - Alice, Bob, Sam Lee`.
- **Spontaneous calls** (a link someone shared, "Start an instant meeting", no title):
  `Date - Call with <everyone else who joined>`, e.g. `2026-10-11 - Call with Alice, Bob`.
  The name updates as people join. If nobody else joins it's `Solo call`.

Details:

- **Date**: the day the call started (`YYYY-MM-DD`, so files sort by date). Each day gets
  its own folder.
- **Participants**: everyone seen in the call plus everyone who spoke; more than four
  are shortened to `+N`.
- **You**: Meet labels your own speech "You". The extension uses the name on your Google
  account instead (read from Meet's "Ready to join?" screen), or the name you set in the
  popup.
- Two calls that would get the same name on the same day (say, two calls with the same
  people) are kept apart as `… (2)`, `… (3)`.
- Renaming a meeting in the transcript viewer renames its file too.

Characters that aren't allowed in file names on macOS or Windows (`: / \ * ? " < > |`)
are replaced with spaces.

Each document has the date, duration, participants and meeting link, speaking time per
person, highlights (possible action items, decisions and questions), and the full
transcript with timestamps.

## Install

1. Download or clone this repo.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick this folder.
4. Pin the extension (puzzle-piece icon → pin) so you can see its badge.

Same steps on Mac and Windows. Other Chromium browsers (Edge, Brave, Arc) work too.

**Updating to a new version:** replace the folder's files and click the reload arrow (↻) on
the extension in `chrome://extensions`. Don't remove the extension first: removing it
deletes your recorded transcripts from Chrome (the saved .docx files stay). Existing files
are renamed and moved to the current layout automatically.

## Use it

Join a Meet call. The extension turns captions on for you (or press **c** / the CC button)
and starts recording. The toolbar badge shows the state:

| Badge | Meaning |
|-------|---------|
| `REC` (red) | Captions are on and being recorded |
| `CC` | You're in a call but captions are off, so nothing is being recorded |
| `II` | Recording is paused |

**When the .docx is saved:** when you leave the call or close the tab, and also after 2
minutes without new captions (so a crash loses little). If the call carries on, the same
file is overwritten with the fuller transcript; you get one file per call, never
duplicates. Saving is silent: no download pop-up mid-call.

Click the icon to pause/resume, open the live transcript, open the folder, or change
settings:

- **Turn on captions automatically**: clicks Meet's caption button when you join.
- **Hide the caption overlay**: keeps recording but makes the captions on screen invisible.
- **Your name**: normally taken from your Google account; set it here to override.
- **Save each call as a .docx**: turn automatic saving on or off.

Chrome's **Ask where to save each file before downloading** setting (off by default)
applies to the extension too: with it on, every save opens a Save dialog. The extension
warns you if that's blocking saves, with a button to the setting.

### Reading transcripts

**All transcripts** opens the library:

- Meetings grouped by day, with full-text search across all of them.
- Each transcript is shown as speaker turns with timestamps (hover for clock time) and a
  talk-time bar per speaker.
- **Questions / Action items / Decisions** filters pull out the matching sentences
  (keyword-based, so skim them for context).
- **Copy for AI summary** copies the transcript with a prompt asking for a summary, key
  points, action items and open questions. Paste it into any AI chat.
- Under the title: the saved file's name, **Show in folder** (Finder / Explorer) and
  **Save again**. Older transcripts can be saved as .docx from here too.
- **Export** as Word, Markdown, plain text or JSON. Click the title to rename the meeting.

The transcript page updates live while the meeting is still being recorded.

### Want them in Google Drive or OneDrive?

Install the Google Drive (or OneDrive / Dropbox) desktop app and have it sync
`Downloads/Meet Transcripts`. In Google Drive for desktop: **Settings → My Computer →
Add folder**. The extension needs no changes for this.

## Good to know

- Only what Meet captions is captured. Set the caption language in Meet to match the
  conversation, and expect normal speech-recognition errors.
- If you reload or rejoin the same meeting within 10 minutes, it continues the same
  transcript instead of starting a new one.
- Moving a saved file out of `Meet Transcripts` is fine. A later save of that same call
  writes a fresh copy back to the folder.
- Deleting a transcript in the extension doesn't delete its .docx.
- Meet changes its page structure from time to time. The extension looks for captions by
  their accessible "Captions" label first and falls back to known class names. If
  recording stops working after a Meet update, the selectors at the top of `content.js`
  are the place to look.
- Captions in other people's meetings belong to them too. Tell people you're keeping a
  transcript.

## Development

No build step and no dependencies: plain Manifest V3 JavaScript. The manifest has a
fixed `key`, so the extension ID (`kddloncdbcaidcdjcjpehapfbgnmicne`) and its stored
transcripts stay the same wherever the folder lives.

| File | What it does |
|------|--------------|
| `content.js` | Runs on meet.google.com; watches the caption panel and saves entries |
| `shared.js` | Storage layout, grouping, file naming, and the document layout |
| `docx.js` | Tiny dependency-free .docx (Word) writer |
| `background.js` | Toolbar badge, and saving each call's .docx via `chrome.downloads` |
| `popup.*` | Toolbar popup |
| `viewer.*` | Transcript library and reader |

`test/e2e.mjs` launches Chromium with the extension, serves `test/mock-meet.html` (a page
that imitates Meet's caption DOM, including in-place revisions, Meet trimming the front of
long captions, participant tiles and leaving the call) at a meet.google.com URL, and
checks the stored transcript, the .docx's name and folder in a real Downloads directory,
and that renaming replaces the file rather than adding a second one:

```bash
npm i -D playwright   # or use a global install
node test/e2e.mjs . /tmp   # screenshots and a copy of the saved .docx land in /tmp
```
