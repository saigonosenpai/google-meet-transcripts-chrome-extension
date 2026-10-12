# Changelog

Each version here becomes a release on GitHub, with the extension zip attached, as soon as
it's pushed to `main` with the matching `version` in `extension/manifest.json`.

## 2.2.2

- **Word documents are about 4 times smaller.** They're now compressed, as Word itself
  does; they open the same in Word, Google Docs and LibreOffice. Your existing documents
  are re-saved compressed once, automatically, after the update.
- **Fixed: doubled names in file names.** Meet can hold a hidden second copy of a name
  in a video tile, which gave files like *Marketo Catchup - Isuru IlangarathneIsuru
  Ilangarathne, …*. Only the visible name is read now, and names already recorded this
  way are cleaned up; the same automatic re-save renames those files, and the icon-name
  files from 2.2.1 too.

## 2.2.1

- **Fixed: icon names in file names.** In some Meet calls, the names of the pin and
  framing icons on video tiles (`keep_outline`, `frame_person`, `keep_off`) were taken
  for participants, giving files like *Weekly WIP - keep_outline, frame_person, …*. They're
  now ignored. For a call that already got such a name, open it in All Transcripts and
  click **Save again**: the file is saved under the right name and the old one removed.

## 2.2.0

- **A livelier popup.** The status card is now in colour and changes with what's happening:
  blue when you're not in a call, red while recording, orange when it needs you (paused,
  or captions are off), grey when recording is turned off for that site. The library
  tiles get their own colours and icons too.

## 2.1.0

- **Your library at a glance** in the popup: how many calls you've recorded, their total
  length, and the space your Word documents and `library.json` take on disk, with a
  Meet / Teams / Zoom breakdown and when the backup was last saved. Click *calls* to open
  the library, or *on disk* to open the folder.

## 2.0.1

- Captions are always turned on when you join a call: everything depends on them, so the
  *Turn on captions automatically* switch is gone. To keep a call out of your transcripts,
  **Pause** (in the popup or the in-call pill); while paused, captions aren't turned on.

## 2.0.0

### Now records Microsoft Teams and Zoom too, and is called Meeting Transcripts

- **Teams and Zoom in the browser.** Calls in Teams on the web (teams.microsoft.com,
  teams.live.com, teams.cloud.microsoft) and in Zoom's web client ("Join from your browser")
  are recorded like Google Meet calls: captions turned on for you, saved as a Word document
  per call, in the same library. Each meeting is labelled Meet, Teams or Zoom, and the
  document says which. Turn any platform off in the popup under *Record calls in*. The
  desktop apps can't be recorded by a browser extension.
- **Rename a speaker.** Click a name in the library to fix it (a phone number,
  "Presentation", a misspelling), in that meeting or, with *Also in future calls*, from
  then on. The Word document is updated too, as it now is when you rename a meeting.
- **Gaps are marked.** When captions were off, recording was paused or you'd left and
  rejoined, the transcript says so: "Captions were off 12:40–19:52 (7 min); nothing was
  recorded".
- **An indicator in the call.** A small *Recording captions* pill in the corner of the call;
  click it to pause, resume or turn captions on. Only you see it, and it can be turned off
  in the popup.
- **Copy a report** from the popup when a call's captions aren't being picked up: it
  describes the page's layout (never the captions) so a Teams or Zoom page change can be
  fixed quickly.
- Captions are picked up sooner after they appear, and a caption list the page re-draws is
  no longer recorded twice.

**Your files move.** The folder is now `Downloads/Meeting Transcripts`. On the first start,
saved documents and `library.json` move there from `Downloads/Meet Transcripts` by
themselves; delete the old folder afterwards. **Restore from folder…** accepts either.

## 1.4.0

### Your history now survives reinstalls

Meet Transcripts now keeps a `library.json` in `Downloads/Meet Transcripts`: every meeting,
transcript and setting, updated after each change. If you remove the extension, reinstall it,
or move to a new computer, click **Restore from folder…** on the tab that opens and pick the
`Meet Transcripts` folder. Everything comes back.

- `library.json` saved alongside your Word documents.
- **Restore from folder…** in the library rebuilds your history from `library.json`, and from
  any saved `.docx` files (including ones from older versions).
- After a fresh install the library opens itself and points you to Restore.

Updating from an earlier version? Click **Restore from folder…** once afterwards to bring in
anything that was saved only as `.docx`.

## 1.3.0

- Redesigned popup and library: Apple-style look, dark mode, segmented filters, export menu,
  undo for delete.

## 1.2.0

- Each call is saved as a `.docx` in Downloads (no Google sign-in), the same on Windows and Mac.
- Spontaneous calls are named after who joined (`Call with …`).
- A folder per day.

## 1.1.0

- Saved each call to Google Drive (replaced by local `.docx` files in 1.2.0).

## 1.0.0

- First release: records Meet captions into a searchable library.
