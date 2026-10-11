# Changelog

Each version here becomes a release on GitHub, with the extension zip attached, as soon as
it's pushed to `main` with the matching `version` in `extension/manifest.json`.

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
