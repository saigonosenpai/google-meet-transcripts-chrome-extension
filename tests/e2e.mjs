// End-to-end test: loads the extension in Chromium, serves a fake Meet call, and checks
// the stored transcript and the .docx file it saves to Downloads/Meeting Transcripts. Teams and
// Zoom run the same way against their own mock pages.
//   node tests/e2e.mjs [extension dir] [screenshot dir]
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";

import { chromium } from "playwright";

const ext = path.resolve(process.argv[2] || new URL("../extension", import.meta.url).pathname);
const shots = process.argv[3] || ".";
const fixture = (name) => fs.readFileSync(new URL("./fixtures/" + name, import.meta.url), "utf8");
const mock = fixture("mock-meet.html");
// Launch Chromium ourselves and attach over CDP: Playwright's own launch intercepts
// downloads and renames them, and we want to see the files exactly as Chrome saves them.
async function launch({ askWhereToSave = false } = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "mt-profile-"));
  const downloads = fs.mkdtempSync(path.join(os.tmpdir(), "mt-downloads-"));
  fs.mkdirSync(path.join(profile, "Default"));
  fs.writeFileSync(path.join(profile, "Default", "Preferences"),
    JSON.stringify({ download: { default_directory: downloads, prompt_for_download: askWhereToSave } }));
  const port = 9300 + Math.floor(Math.random() * 500);
  const proc = spawn(chromium.executablePath(), [
    "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run",
    // Containers run as root, and CI runners' AppArmor blocks Chromium's sandbox.
    ...(process.env.CI || (process.getuid && process.getuid() === 0) ? ["--no-sandbox"] : []),
    `--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "about:blank",
  ], { stdio: "ignore" });
  let browser;
  for (let i = 0; i < 50 && !browser; i++) {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => null);
    if (!browser) await new Promise((r) => setTimeout(r, 200));
  }
  // Playwright redirects downloads to GUID-named files even when attached; restore Chrome's own behavior.
  await (await browser.newBrowserCDPSession()).send("Browser.setDownloadBehavior", { behavior: "default" });
  return { browser, ctx: browser.contexts()[0], downloads, close: async () => { await browser.close(); proc.kill(); } };
}

const { ctx, downloads, close } = await launch();
await ctx.route("https://meet.google.com/**", (r) => r.fulfill({ contentType: "text/html", body: mock }));

// The extension ID follows from the manifest key; any extension page can read its storage.
const key = Buffer.from(JSON.parse(fs.readFileSync(path.join(ext, "manifest.json"))).key, "base64");
const id = [...createHash("sha256").update(key).digest("hex").slice(0, 32)]
  .map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
const sw = await ctx.newPage();
await sw.goto(`chrome-extension://${id}/viewer/viewer.html`);
const today = new Date(); const pad = (n) => String(n).padStart(2, "0");
const date = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
const dayDir = path.join(downloads, "Meeting Transcripts", date);
const fileOf = (mid) => sw.evaluate((k) => chrome.storage.local.get(k).then((d) => d[k]), "f:" + mid);

// Names read together with a hidden copy of themselves are collapsed; real names are left alone.
const deduped = await sw.evaluate(() => [
  "Isuru IlangarathneIsuru Ilangarathne", "Chathuranga BalasooriyaChathuranga Bala", "AnnAnn",
  "McDonald", "Ann McAnn", "DeShawn De", "Mary-Jane O'Neil", "Lee Lee", "Ó SúilleabháinÓ Súil",
].map(MT.dedupeName));
assert.deepEqual(deduped, ["Isuru Ilangarathne", "Chathuranga Balasooriya", "Ann",
  "McDonald", "Ann McAnn", "DeShawn De", "Mary-Jane O'Neil", "Lee Lee", "Ó Súilleabháin"]);

// --- a scheduled call ("Weekly sync") ---------------------------------------------------------
// No name configured: "You" in captions must become the Google account name, "Sam Lee".
const page = await ctx.newPage();
await page.goto("https://meet.google.com/abc-defg-hij");
await page.waitForFunction(() => window.done, null, { timeout: 30000 });
await page.waitForTimeout(2500);
let data = await sw.evaluate(() => chrome.storage.local.get(null));
const meta = Object.values(data.meetings)[0];
const t = data["t:" + meta.id];
console.log("meeting:", JSON.stringify({ title: meta.title, participants: meta.participants, speakers: meta.speakers }));
const bob = t.filter((e) => e.speaker === "Bob").map((e) => e.text).join(" ");
for (let i = 1; i <= 30; i++) assert.equal(bob.split(`Sentence number ${i} `).length, 2, `sentence ${i} once`);
assert.deepEqual(meta.speakers, ["Alice", "Sam Lee", "Bob"]);
assert.equal(meta.title, "Weekly sync");
assert.equal(data["f:" + meta.id], undefined, "nothing saved mid-call");

// Leave the call -> the .docx is saved.
await page.evaluate(() => window.leave());
const fileState = () => fileOf(meta.id);
let file;
for (let i = 0; i < 40 && !(file = await fileState()); i++) await page.waitForTimeout(250);
assert.ok(file && !file.error, "saved after leaving: " + JSON.stringify(file));
const expected = `${date} - Weekly sync - Alice, Bob, Carol Diaz, Sam Lee.docx`;
console.log("saved:", file.filename);
assert.equal(path.basename(file.filename), expected);
assert.equal(path.dirname(file.filename), dayDir, "grouped in a folder per day");
assert.ok(fs.existsSync(file.filename));
fs.copyFileSync(file.filename, shots + "/saved.docx");

// --- viewer: rename, save again -> one file, new name -----------------------------------------
const v = await ctx.newPage();
await v.setViewportSize({ width: 1200, height: 900 });
await v.goto(`chrome-extension://${id}/viewer/viewer.html#` + encodeURIComponent(meta.id));
await v.waitForSelector("#showFile");
await v.click("#title");
await v.keyboard.press("End");
await v.keyboard.type(" (Q4)");
await v.keyboard.press("Enter");
await v.waitForTimeout(300);
await v.click("#saveNow");
await v.waitForFunction(() => document.querySelector("#file").textContent.includes("(Q4)"));
const renamed = await fileState();
console.log("renamed:", path.basename(renamed.filename));
assert.ok(path.basename(renamed.filename).includes("Weekly sync (Q4) - Alice"));
assert.ok(fs.existsSync(renamed.filename), "new file exists");
assert.ok(!fs.existsSync(file.filename), "old file removed");
assert.deepEqual(fs.readdirSync(path.dirname(renamed.filename)), [path.basename(renamed.filename)]);
await v.screenshot({ path: shots + "/viewer.png" });

// --- delete is immediate and undoable (no blocking confirm dialog) ---------------------------------
const before = await sw.evaluate((k) => chrome.storage.local.get(k), ["meetings", "t:" + meta.id, "f:" + meta.id]);
await v.click("#delete");
await v.waitForSelector("#toast.show");
assert.match(await v.textContent("#toastText"), /^Deleted “Weekly sync \(Q4\)”/);
assert.equal((await sw.evaluate(() => chrome.storage.local.get("meetings"))).meetings[meta.id], undefined, "deleted");
await v.click("#toastAction");
await v.waitForFunction((id) => location.hash.includes(encodeURIComponent(id)), meta.id);
await v.waitForSelector(".turn p");
const after = await sw.evaluate((k) => chrome.storage.local.get(k), ["meetings", "t:" + meta.id, "f:" + meta.id]);
assert.equal(after.meetings[meta.id].title, before.meetings[meta.id].title, "title restored");
assert.deepEqual(after["t:" + meta.id], before["t:" + meta.id], "transcript restored");
assert.deepEqual(after["f:" + meta.id], before["f:" + meta.id], "saved-file record restored");
assert.equal(await v.textContent("#title"), "Weekly sync (Q4)");
console.log("delete + undo: restored");

const p = await ctx.newPage();
await p.setViewportSize({ width: 340, height: 600 });
await p.goto(`chrome-extension://${id}/popup/popup.html`);
await p.waitForTimeout(500);
assert.ok((await p.textContent("#lastSaved")).includes("(Q4)"));
// The library at a glance: one call, its document (and library.json) on disk.
await p.waitForFunction(() => document.getElementById("size").textContent !== "–");
const stats = await p.evaluate(() => ["calls", "recorded", "size", "statsDetail"].map((id) => document.getElementById(id).textContent));
console.log("popup stats:", stats.join(" | "));
const manifestVersion = JSON.parse(fs.readFileSync(path.join(ext, "manifest.json"))).version;
assert.equal(await p.textContent("#version"), "v" + manifestVersion, "popup shows the installed version");
assert.equal(stats[0], "1");
assert.match(stats[2], /^\d+(\.\d)? (KB|MB)$/);
assert.match(stats[3], /^Meet 1 · 1 Word document/);
await p.screenshot({ path: shots + "/popup.png" });

// --- spontaneous calls: named after who else joined ---------------------------------------------
async function runCall(code) {
  const pg = await ctx.newPage();
  await pg.goto("https://meet.google.com/" + code);
  await pg.waitForFunction(() => window.done, null, { timeout: 30000 });
  await pg.waitForTimeout(2000);
  await pg.evaluate(() => window.leave());
  const { meetings } = await sw.evaluate(() => chrome.storage.local.get("meetings"));
  const m = Object.values(meetings).find((x) => x.code === code);
  let f;
  for (let i = 0; i < 40 && !(f = await fileOf(m.id)); i++) await pg.waitForTimeout(250);
  await pg.close();
  return { m, f };
}
const call1 = await runCall("xtk-wiod-gkq");
console.log("spontaneous:", call1.m.title, "->", path.basename(call1.f.filename));
assert.equal(call1.m.title, "Call with Alice, Bob, Carol Diaz");
assert.equal(call1.f.filename, path.join(dayDir, `${date} - Call with Alice, Bob, Carol Diaz.docx`));
// Same people again the same day: a second file, not an overwrite.
const call2 = await runCall("pqr-stuv-wxy");
console.log("second call, same people:", path.basename(call2.f.filename));
assert.equal(call2.f.filename, path.join(dayDir, `${date} - Call with Alice, Bob, Carol Diaz (2).docx`));
assert.equal(fs.readdirSync(dayDir).length, 3);

// Recordings from before this version stored "Meet <code>" for untitled calls.
assert.equal(await sw.evaluate(() => MT.title({ title: "Meet xtk-wiod-gkq", speakers: ["You"] })), "Solo call");
assert.equal(await sw.evaluate(() => MT.title({ title: "Meet xtk-wiod-gkq", speakers: ["Ann", "You"] })), "Call with Ann");
assert.equal(await sw.evaluate(() => MT.title({ title: "Weekly sync", speakers: ["Ann"] })), "Weekly sync");

await v.goto(`chrome-extension://${id}/viewer/viewer.html#` + encodeURIComponent(call1.m.id));
await v.waitForSelector("#showFile");
await v.screenshot({ path: shots + "/viewer-list.png" });

// --- reinstall: settings.json + .docx files bring everything back -------------------------------
await v.evaluate(() => MT.saveSettings({ myName: "Sam Lee", hideCaptions: true }));
// A fresh install that hasn't restored yet keeps its calls in an interim file, never library.json.
const libraryPath = path.join(downloads, "Meeting Transcripts", "library (since reinstall).json");
const readLibrary = () => { try { return JSON.parse(fs.readFileSync(libraryPath, "utf8")); } catch { return null; } };
for (let i = 0; i < 60 && readLibrary()?.settings?.myName !== "Sam Lee"; i++) await v.waitForTimeout(250);
const savedLib = readLibrary();
assert.deepEqual({ ...savedLib.settings, showIndicator: undefined, platforms: undefined, nameMap: undefined },
  { hideCaptions: true, myName: "Sam Lee", autoSave: true, showIndicator: undefined, platforms: undefined, nameMap: undefined });
assert.deepEqual(savedLib.settings.platforms, { meet: true, teams: true, zoom: true });
assert.equal(Object.keys(savedLib.meetings).length, 3);
console.log("library.json written:", Object.keys(savedLib.meetings).length, "meetings,", JSON.stringify(savedLib.settings));

const titlesBefore = (await v.evaluate(async () => (await MT.listMeetings()).map((m) => MT.title(m)))).sort();
const linesBefore = await v.evaluate(async () => Object.fromEntries(await Promise.all(
  (await MT.listMeetings()).map(async (m) => [MT.title(m), (await MT.getTranscript(m.id)).length]))));
await v.evaluate(() => chrome.storage.local.clear()); // what removing the extension does
await v.goto("about:blank");
await v.goto(`chrome-extension://${id}/viewer/viewer.html#welcome`);
await v.waitForSelector("#emptyLib:not([hidden])");
assert.ok(await v.$("#importBtn.pulse"), "restore button highlighted on a fresh library");
// What picking the folder hands the page: every file in it, day folders included.
const folderFiles = fs.readdirSync(path.join(downloads, "Meeting Transcripts"), { recursive: true })
  .map((f) => path.join(downloads, "Meeting Transcripts", f)).filter((f) => fs.statSync(f).isFile());
await v.evaluate(() => document.getElementById("importInput").removeAttribute("webkitdirectory"));
await v.setInputFiles("#importInput", folderFiles);
await v.waitForSelector("#toast.show");
console.log("restore:", await v.textContent("#toastText"));
const titlesAfter = (await v.evaluate(async () => (await MT.listMeetings()).map((m) => MT.title(m)))).sort();
assert.deepEqual(titlesAfter, titlesBefore, "every meeting restored");
const linesAfter = await v.evaluate(async () => Object.fromEntries(await Promise.all(
  (await MT.listMeetings()).map(async (m) => [MT.title(m), (await MT.getTranscript(m.id)).length]))));
assert.deepEqual(linesAfter, linesBefore, "every line restored, exactly as recorded");
// library.json comes first; the .docx files of the same calls are recognized, not added twice.
assert.equal(await v.textContent("#toastText"), "Restored 3 meetings · settings · 3 already here");
// After a restore, library.json holds everything and the interim file is gone.
const mainLib = path.join(downloads, "Meeting Transcripts", "library.json");
for (let i = 0; i < 60 && !(fs.existsSync(mainLib) && !fs.existsSync(libraryPath)); i++) await v.waitForTimeout(250);
assert.equal(Object.keys(JSON.parse(fs.readFileSync(mainLib, "utf8")).meetings).length, 3, "library.json has all 3");
assert.ok(!fs.existsSync(libraryPath), "interim file removed");
console.log("folder now:", fs.readdirSync(path.join(downloads, "Meeting Transcripts")).join(" | "));
const restored = await v.evaluate(() => MT.getSettings());
assert.equal(restored.myName, "Sam Lee");
assert.equal(restored.hideCaptions, true);
console.log("restored meetings:", titlesAfter.join(" | "));

// --- hiding captions: the caption strip gives its space back, and recording goes on ---------------
{
  // "Hide captions on screen" is on (restored above).
  const hp = await ctx.newPage();
  await hp.setViewportSize({ width: 1000, height: 700 });
  await hp.goto("https://meet.google.com/hid-ecap-tns");
  await hp.waitForFunction(() => window.done, null, { timeout: 30000 });
  await hp.waitForTimeout(800);
  const layout = () => hp.evaluate(() => ({
    stage: document.getElementById("stage").getBoundingClientRect().height,
    strip: document.getElementById("capbar").getBoundingClientRect().height,
    captionsLeft: document.querySelector('[role="region"]').getBoundingClientRect().left,
    controls: document.getElementById("controls").getBoundingClientRect().height,
  }));
  const hidden = await layout();
  console.log("captions hidden:", JSON.stringify(hidden));
  assert.equal(hidden.strip, 0, "caption strip collapsed");
  assert.equal(hidden.stage, 700 - 80, "video stage gets the space back");
  assert.equal(hidden.controls, 80, "controls untouched");
  assert.ok(hidden.captionsLeft < -5000, "captions moved off-screen");
  const recordedLines = () => sw.evaluate(async () => {
    const m = Object.values((await chrome.storage.local.get("meetings")).meetings || {}).find((x) => x.code === "hid-ecap-tns");
    return m ? (await chrome.storage.local.get("t:" + m.id))["t:" + m.id] || [] : [];
  });
  let lines = [];
  for (let i = 0; i < 40 && !lines.some((e) => e.text.includes("Great, thanks everyone.")); i++) {
    lines = await recordedLines();
    await hp.waitForTimeout(250);
  }
  assert.ok(lines.some((e) => e.text.includes("Great, thanks everyone.")), "still recording while hidden");
  // "Copy a report" includes the layout around the captions, never what was said.
  const report = await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: "https://meet.google.com/hid-ecap-tns" });
    return chrome.tabs.sendMessage(tab.id, { type: "diagnose" });
  });
  console.log("caption layout report:\n" + report.captionLayout);
  assert.match(report.captionLayout, /COLLAPSED/);
  assert.match(report.captionLayout, /call layout:[\s\S]*main#stage/);
  assert.ok(!/launch|Friday|thanks/i.test(JSON.stringify(report)), "no caption text in the report");
  // The in-call pill has a switch for it. The pill is in a closed shadow root, which only the
  // DevTools protocol reaches: find its "Show captions" button there and click it.
  const cdp = await hp.context().newCDPSession(hp);
  const pillButton = async () => {
    const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
    const cls = (n) => { const a = n.attributes || []; const i = a.indexOf("class"); return i >= 0 && i % 2 === 0 ? a[i + 1] : ""; };
    const find = (n) => n.nodeName === "BUTTON" && cls(n) === "cc" ? n
      : [...(n.children || []), ...(n.shadowRoots || [])].map(find).find(Boolean);
    const { object } = await cdp.send("DOM.resolveNode", { nodeId: find(root).nodeId });
    return object.objectId;
  };
  const pillCall = async (fn) => (await cdp.send("Runtime.callFunctionOn",
    { objectId: await pillButton(), functionDeclaration: fn, returnByValue: true })).result.value;
  assert.equal(await pillCall("function () { return this.textContent; }"), "Show captions");
  // Clicking it brings the strip back.
  await pillCall("function () { this.click(); }");
  await hp.waitForTimeout(600);
  assert.equal((await sw.evaluate(() => MT.getSettings())).hideCaptions, false, "pill switch turns hiding off");
  assert.equal(await pillCall("function () { return this.textContent; }"), "Hide captions");
  const shown = await layout();
  assert.ok(shown.strip >= 140 && shown.captionsLeft >= 0 && shown.stage < 700 - 80 - 140, "strip back: " + JSON.stringify(shown));
  await pillCall("function () { this.click(); }");
  await hp.waitForTimeout(600);
  // Now with a strip full of captions (taller than when the call began): still collapsed.
  assert.equal((await layout()).strip, 0, "collapsed again");
  await hp.close();
  console.log("hide captions: strip collapsed, stage", hidden.stage, "px, still recording; off again:", shown.strip, "px strip");
}

// --- Microsoft Teams ------------------------------------------------------------------------------
await v.evaluate(() => MT.saveSettings({ hideCaptions: false }));
await ctx.route("https://teams.microsoft.com/**", (r) => r.fulfill({ contentType: "text/html", body: fixture("mock-teams.html") }));
const meetingsOf = async (platform) => Object.values((await sw.evaluate(() => chrome.storage.local.get("meetings"))).meetings)
  .filter((m) => m.platform === platform);
const tp = await ctx.newPage();
await tp.goto("https://teams.microsoft.com/v2/");
// Captions are off: the recorder opens More › Language and speech › Turn on live captions itself.
await tp.waitForFunction(() => window.firstPart, null, { timeout: 30000 });
assert.ok(await tp.$("#meeting-transcripts-indicator"), "in-call indicator shown");
await tp.waitForTimeout(2000);
let [tm] = await meetingsOf("teams");
let tLines = await sw.evaluate((k) => chrome.storage.local.get(k).then((d) => d[k]), "t:" + tm.id);
console.log("teams lines:", tLines.map((e) => `${e.speaker}: ${e.text}`).join(" | "));
assert.deepEqual(tLines.map((e) => e.speaker), ["Dana Wu", "Eli Park", "Sam Lee"], "a re-drawn caption list isn't recorded twice");
assert.equal(tLines[1].text, "Thanks Dana. I will own the API work and send a plan by Friday.");
// The popup's "Copy a report": the page's layout, never what anyone said.
const report = await v.evaluate(async () => {
  const [tab] = await chrome.tabs.query({ url: "https://teams.microsoft.com/*" });
  return chrome.tabs.sendMessage(tab.id, { type: "diagnose" });
});
assert.equal(report.platform, "teams");
assert.equal(report.captionsFound, true);
assert.ok(report.captionArea.includes('[data-tid=closed-captions-renderer]'), report.captionArea);
assert.ok(!/API work|kickoff for the new portal|Dana Wu/.test(JSON.stringify(report)), "no caption text or names in the report");
console.log("diagnostics report:", report.blocks, "caption blocks found;", report.captionArea.split("\n")[0]);
// Pause for a while: the transcript shows the stretch with nothing recorded.
await v.evaluate(() => MT.saveSettings({ paused: true }));
await tp.waitForTimeout(22000);
await v.evaluate(() => MT.saveSettings({ paused: false }));
await tp.evaluate(() => window.continueCall());
await tp.waitForFunction(() => window.done, null, { timeout: 30000 });
await tp.waitForTimeout(2000);
await tp.evaluate(() => window.leave());
let tFile;
for (let i = 0; i < 40 && !(tFile = await fileOf(tm.id)); i++) await tp.waitForTimeout(250);
[tm] = await meetingsOf("teams");
console.log("teams:", tm.title, "->", path.basename(tFile.filename), "gaps:", JSON.stringify(tm.gaps.map((g) => [g.reason, Math.round((g.to - g.from) / 1000)])));
assert.equal(tm.title, "Project kickoff");
assert.equal(path.basename(tFile.filename), `${date} - Project kickoff - Sam Lee, Dana Wu, Eli Park.docx`);
assert.equal(tm.gaps.length, 1);
assert.equal(tm.gaps[0].reason, "paused");
// The saved document says where the call happened and reads back as a Teams call.
const tParsed = await v.evaluate(async (b64) => (await DOCX_IMPORT.parse(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer,
  "2026-10-11 - x.docx")).meta, fs.readFileSync(tFile.filename).toString("base64"));
assert.equal(tParsed.platform, "teams");
await v.goto(`chrome-extension://${id}/viewer/viewer.html#` + encodeURIComponent(tm.id));
await v.waitForSelector(".gap");
console.log("gap shown:", await v.textContent(".gap"));
assert.match(await v.textContent(".gap"), /^Recording was paused \d+:\d\d–\d+:\d\d \(1 min\); nothing was recorded$/);
assert.match(await v.textContent("#meta"), /^Microsoft Teams · /);
await v.screenshot({ path: shots + "/teams-viewer.png" });

// --- Zoom (web client) ------------------------------------------------------------------------------
await ctx.route("https://app.zoom.us/**", (r) => r.fulfill({ contentType: "text/html", body: fixture("mock-zoom.html") }));
const zp = await ctx.newPage();
await zp.goto("https://app.zoom.us/wc/9876543210/join");
await zp.waitForFunction(() => window.done, null, { timeout: 30000 });
await zp.waitForTimeout(2500);
let [zm] = await meetingsOf("zoom");
let zLines = await sw.evaluate((k) => chrome.storage.local.get(k).then((d) => d[k]), "t:" + zm.id);
console.log("zoom lines:", zLines.map((e) => `${e.speaker}: ${e.text}`).join(" | "));
assert.deepEqual(zLines.map((e) => e.speaker), ["Ann Lee", "Ben Cho", "Ann Lee"], "overlay lines keep their speaker; the transcript panel adds no duplicates");
await zp.evaluate(() => window.leave());
let zFile;
for (let i = 0; i < 40 && !(zFile = await fileOf(zm.id)); i++) await zp.waitForTimeout(250);
[zm] = await meetingsOf("zoom");
console.log("zoom:", zm.title, "->", path.basename(zFile.filename), zm.link);
assert.equal(zm.title, "Call with Ann Lee, Ben Cho");
assert.equal(zm.link, "https://zoom.us/j/9876543210");

// --- rename a speaker, here and in future calls; the file follows ------------------------------------
await v.goto(`chrome-extension://${id}/viewer/viewer.html#` + encodeURIComponent(zm.id));
await v.click('button.spk[data-name="Ben Cho"]');
await v.waitForSelector("#renameBox.open");
await v.fill("#renameInput", "Benjamin Cho");
await v.check("#renameFuture");
await v.screenshot({ path: shots + "/rename.png" });
await v.click('#renameBox button[type="submit"]');
await v.waitForSelector('button.spk[data-name="Benjamin Cho"]');
for (let i = 0; i < 40 && !(await fileOf(zm.id)).filename.includes("Benjamin"); i++) await v.waitForTimeout(250);
const zRenamed = await fileOf(zm.id);
console.log("speaker renamed:", path.basename(zRenamed.filename));
assert.equal(path.basename(zRenamed.filename), `${date} - Call with Ann Lee, Benjamin Cho.docx`);
assert.ok(!fs.existsSync(zFile.filename), "old file replaced");
assert.deepEqual((await v.evaluate(() => MT.getSettings())).nameMap, { "ben cho": "Benjamin Cho" });
zLines = await sw.evaluate((k) => chrome.storage.local.get(k).then((d) => d[k]), "t:" + zm.id);
assert.deepEqual(zLines.map((e) => e.speaker), ["Ann Lee", "Benjamin Cho", "Ann Lee"]);

// --- paused: captions aren't even turned on ----------------------------------------------------------
await v.evaluate(() => MT.saveSettings({ paused: true }));
const zp1 = await ctx.newPage();
await zp1.goto("https://app.zoom.us/wc/5556667778/join");
await zp1.waitForTimeout(5000);
assert.ok(!(await zp1.$('[role="menu"], #live-transcription-subtitle')), "captions left off while paused");
await zp1.close();
await v.evaluate(() => MT.saveSettings({ paused: false }));
console.log("paused: captions left off");

// --- turning a platform off: nothing is recorded there ------------------------------------------------
await v.evaluate(() => MT.getSettings().then((s) => MT.saveSettings({ platforms: { ...s.platforms, zoom: false } })));
const zp2 = await ctx.newPage();
await zp2.goto("https://app.zoom.us/wc/1112223334/join");
await zp2.waitForTimeout(5000);
assert.ok(!(await zp2.$('[role="menu"], #live-transcription-subtitle')), "captions not even turned on");
assert.equal((await meetingsOf("zoom")).length, 1, "no new Zoom meeting");
await zp2.close();
console.log("zoom turned off: nothing recorded");

await close();

// --- upgrading from "Meet Transcripts": files move to the new folder ---------------------------------
{
  const run = await launch();
  const v = await run.ctx.newPage();
  await v.goto(`chrome-extension://${id}/viewer/viewer.html`);
  const old = await v.evaluate(async () => {
    const done = (dl) => new Promise((r) => { const t = setInterval(async () => {
      const [it] = await chrome.downloads.search({ id: dl });
      if (it && it.state === "complete") { clearInterval(t); r(it); } }, 100); });
    const docx = await done(await chrome.downloads.download({ url: "data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==",
      filename: "Meet Transcripts/2026-10-01/2026-10-01 - Old call - Ann.docx" }));
    const lib = await done(await chrome.downloads.download({ url: "data:application/json,{}", filename: "Meet Transcripts/library.json" }));
    const m = { id: "abc-defg-hij-1", code: "abc-defg-hij", eventTitle: "Old call", startedAt: new Date(2026, 9, 1, 9).getTime(),
      endedAt: new Date(2026, 9, 1, 10).getTime(), speakers: ["Ann"] };
    await chrome.storage.local.set({ meetings: { [m.id]: m }, ["t:" + m.id]: [{ speaker: "Ann", text: "Hi.", ts: m.startedAt }],
      ["f:" + m.id]: { downloadId: docx.id, filename: docx.filename, savedAt: 1, hash: "x" },
      fileLayout: 2, libraryReady: true, libraryDownloadId: lib.id });
    return { docx: docx.filename, lib: lib.filename };
  });
  // Restart the background worker, as when Chrome loads a new version; it migrates on start.
  const cdp = await run.browser.newBrowserCDPSession();
  const { targetInfos } = await cdp.send("Target.getTargets");
  for (const t of targetInfos.filter((t) => t.type === "service_worker" && t.url.includes(id))) await cdp.send("Target.closeTarget", { targetId: t.targetId });
  await v.waitForTimeout(500);
  await v.evaluate(() => chrome.runtime.sendMessage({ type: "ping" }).catch(() => {}));
  const newDoc = path.join(run.downloads, "Meeting Transcripts", "2026-10-01", "2026-10-01 - Old call - Ann.docx");
  const newLib = path.join(run.downloads, "Meeting Transcripts", "library.json");
  for (let i = 0; i < 80 && !(fs.existsSync(newDoc) && fs.existsSync(newLib) && !fs.existsSync(old.lib)); i++) await new Promise((r) => setTimeout(r, 250));
  assert.ok(fs.existsSync(newDoc), "document moved to Meeting Transcripts");
  assert.ok(!fs.existsSync(old.docx), "old document removed");
  assert.ok(fs.existsSync(newLib) && !fs.existsSync(old.lib), "library.json moved");
  // Re-saved compressed: the first zip entry's method is deflate (8), not store (0).
  assert.equal(fs.readFileSync(newDoc).readUInt16LE(8), 8, "re-saved document is compressed");
  console.log("upgrade: moved to", path.relative(run.downloads, newDoc));
  await run.close();
}

// --- Chrome set to "Ask where to save each file": a clear warning, not a silent failure ----
{
  const run = await launch({ askWhereToSave: true });
  const v = await run.ctx.newPage();
  await v.goto(`chrome-extension://${id}/viewer/viewer.html`);
  await v.evaluate((m) => chrome.storage.local.set({ meetings: { [m.id]: m }, ["t:" + m.id]: [{ speaker: "Ann", text: "Hello.", ts: m.startedAt }] }),
    { id: "x-1", code: "abc-defg-hij", title: "Ask test", startedAt: Date.now(), endedAt: Date.now(), speakers: ["Ann"] });
  await v.goto(`chrome-extension://${id}/viewer/viewer.html#x-1`);
  await v.click("#saveNow");
  await v.waitForSelector("#dlSettings", { timeout: 15000 });
  console.log("ask-where-to-save warning:", (await v.textContent("#file .err")).slice(0, 70) + "…");
  const p = await run.ctx.newPage();
  await p.goto(`chrome-extension://${id}/popup/popup.html`);
  await p.waitForSelector("#askWarning:not([hidden])");
  await run.close();
}

console.log("ALL CHECKS PASSED");
