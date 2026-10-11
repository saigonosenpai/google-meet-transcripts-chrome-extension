# Meet Transcripts

A Chrome extension that records your Google Meet calls as text transcripts and saves each
call as a **Google Doc** in your Drive, so you can read, search and reference them later.

It works from Meet's own **live captions**, so there is no audio recording and no server.
Transcripts are kept in your browser and, once you connect Google Drive, also saved as one
Doc per call:

```
Meet Transcripts/                                        (folder in your Drive)
  2026-10-11 - Weekly sync - Alice, Bob, Carol, Sam
  2026-10-12 - Design review - Dana, Eli, Sam +3
```

The name is `Date - Event name - Participants`. The event name is the Meet / Calendar event
title (rename it in the transcript viewer and the Doc follows). Participants are everyone
seen in the call plus everyone who spoke; more than four are shortened to `+N`.

Each Doc has the date, duration, participants and meeting link, speaking time per person,
highlights (possible action items, decisions and questions), and the full transcript with
timestamps.

## Install

1. Download or clone this repo.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick this folder.
4. Pin the extension so you can see its badge.

The extension's ID is always `kddloncdbcaidcdjcjpehapfbgnmicne` (the manifest has a fixed
`key`), which the Google setup below relies on.

## Google sign-in

Using it is one click: open the popup, click **Sign in with Google**, pick your account.
The popup then shows *Signed in as you@example.com*.

For that button to work, the extension needs a Google OAuth client ID built into
`config.js`. Google requires one per app; it's created once by whoever builds the
extension (about 5 minutes), not by each user:

1. Go to [console.cloud.google.com](https://console.cloud.google.com/), create a project
   (any name), then **APIs & Services → Library → Google Drive API → Enable**.
2. **APIs & Services → OAuth consent screen**: choose *External* (or *Internal* on a
   Google Workspace account) and fill in the app name and your email. Then either add the
   accounts that will use it under *Test users*, or click **Publish app** so any Google
   account can sign in. `drive.file` is a non-sensitive scope, so publishing doesn't need
   Google's review.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**
   - Authorized redirect URI: `https://kddloncdbcaidcdjcjpehapfbgnmicne.chromiumapp.org/`
4. Put the client ID in `config.js`:
   ```js
   const GOOGLE_CLIENT_ID = "1234-abcd.apps.googleusercontent.com";
   ```
   and reload the extension in `chrome://extensions`. Client IDs aren't secret, so it's
   fine to commit.

(A build without a client ID shows a *Developer setup* box in the popup where one can be
pasted instead.)

The extension only asks for the `drive.file` permission: it can see and edit the files it
creates, and nothing else in your Drive.

**When Docs are saved:** when you leave the call or close the tab, and also after 2
minutes without new captions (so a crashed browser loses little). If the call carries on,
the same Doc is updated rather than duplicated. You can also click **Save to Google Docs /
Update Doc** on any transcript in the viewer, including ones recorded before you connected
Drive. Deleting a transcript in the extension leaves its Doc in Drive.

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
- **Your name**: Meet labels your own speech "You"; this replaces it with your name, in
  the transcript and in Doc names.
- **Save each call as a Doc in Drive**: turn automatic Drive saving on or off.

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
- The Google Doc link, when it was last saved, and any save error appear under the title.

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
| `config.js` | The built-in Google OAuth client ID |
| `shared.js` | Storage layout, grouping and export helpers (used everywhere) |
| `background.js` | Toolbar badge, Google sign-in, and saving Docs to Drive |
| `popup.*` | Toolbar popup |
| `viewer.*` | Transcript library and reader |

`test/e2e.mjs` loads the extension in Chromium with Playwright, serves
`test/mock-meet.html` (a page that imitates Meet's caption DOM, including in-place
revisions, Meet trimming the front of long captions, participant tiles and leaving the
call) at a meet.google.com URL, fakes Google sign-in and the Drive API (using a copy of
the extension with a test client ID in `config.js`), and checks the
stored transcript, the Doc's name, folder and content, and that later saves update the
same Doc:

```bash
npm i -D playwright   # or use a global install
node test/e2e.mjs . /tmp   # screenshots and the Doc's HTML land in /tmp
```
