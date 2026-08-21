/* sheets-store.js round-trip tests.
   Because the Sheet is hand-editable, the parse path is as important as the
   write path: whatever a person types on the Leave tab has to survive being
   read into the app's data shape and written back out.
   Run: node test/store.test.js                                          */
"use strict";
global.localStorage = {
  s: {}, getItem(k) { return k in this.s ? this.s[k] : null; },
  setItem(k, v) { this.s[k] = String(v); },
  // Without removeItem the store's clean-up paths threw silently and every
  // "forget this" call was a no-op, so tests passed for the wrong reason.
  removeItem(k) { delete this.s[k]; },
  clear() { this.s = {}; },
};
global.window = {};
const S = require("../sheets-store.js");
const I = S._internals;

let pass = 0;
const failures = [];
const check = (name, fn) => {
  try { fn(); pass++; }
  catch (e) { failures.push(`${name}\n    ${e.message}`); }
};
const eq = (a, b, what) => {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x !== y) throw new Error(`${what}: got ${x}, want ${y}`);
};
const ok = (c, w) => { if (!c) throw new Error(w); };

const TYPES = [
  { key: "PTOB", label: "PTOB", model: "biweekly", active: true },
  { key: "Parental", label: "Parental", model: "grant", active: true },
];

check("leave rows parse into the per-day entry shape", () => {
  const data = I.emptyData();
  I.readLeaveInto([
    ["Date", "PTOB", "Parental", "Label", "Updated"],
    ["2026-08-19", 8, 0, "dentist", "x"],
    ["2026-08-20", 4, 4, "half day", "x"],
    ["2026-09-08", 0, 8, "parental", "x"],
  ], TYPES, data);
  eq(data.entries["2026-08-19"], { b: 8, nr: 0, label: "dentist" }, "PTOB day");
  eq(data.entries["2026-08-20"], { b: 4, nr: 4, label: "half day" }, "split day");
  eq(data.entries["2026-09-08"], { b: 0, nr: 8, label: "parental" }, "parental day");
});

check("a day is round-tripped through the Sheet unchanged", () => {
  const before = I.emptyData();
  before.entries = {
    "2026-08-19": { b: 8, nr: 0, label: "dentist" },
    "2026-08-20": { b: 4, nr: 4, label: "half day" },
    "2026-09-08": { b: 0, nr: 8, label: "parental" },
  };
  const grid = I.leaveRows(before, TYPES);
  const after = I.emptyData();
  I.readLeaveInto(grid, TYPES, after);
  eq(after.entries, before.entries, "entries survived the round trip");
});

check("the shared label survives -- it is not duplicated per type", () => {
  const data = I.emptyData();
  data.entries = { "2026-08-20": { b: 4, nr: 4, label: "half day" } };
  const grid = I.leaveRows(data, TYPES);
  eq(grid[0], ["Date", "PTOB", "Parental", "Label", "Updated"], "header");
  eq(grid[1].slice(0, 4), ["2026-08-20", 4, 4, "half day"], "one row, one label");
  ok(grid.length === 2, "a split day must be one row, not two");
});

check("holidays round-trip including removed built-ins", () => {
  const before = I.emptyData();
  before.holidays = { "2026-09-08": "Company day" };
  before.removedHolidays = ["2026-09-07"];
  const grid = I.holidayRows(before);
  const after = I.emptyData();
  I.readHolidaysInto(grid, after);
  eq(after.holidays, before.holidays, "custom holidays");
  eq(after.removedHolidays, before.removedHolidays, "removed built-ins");
});

check("a removed built-in is not resurrected by a builtin mirror row", () => {
  const data = I.emptyData();
  I.readHolidaysInto([
    ["Date", "Name", "Source"],
    ["2026-09-07", "Labor Day", "builtin"],
    ["2026-09-07", "", "removed"],
  ], data);
  eq(data.removedHolidays, ["2026-09-07"], "removal must win");
  ok(!data.holidays["2026-09-07"], "removed day must not be a custom holiday");
});

check("config carries the anchor balance, not just the anchor date", () => {
  const data = I.emptyData();
  I.readConfigInto([
    ["Key", "Value", "Notes"],
    ["hireDate", "2015-03-09", ""],
    ["anchorSunday", "2026-07-26", ""],
    ["anchorBalance", "100.00", ""],
    ["childBirthDate", "2026-08-17", ""],
  ], data);
  eq(data.anchor, { date: "2026-07-26", balance: 100.00 }, "anchor");
  eq(data.hireDate, "2015-03-09", "hire date");
  eq(data.birthDate, "2026-08-17", "birth date");
});

check("an anchor date with no balance is ignored rather than seeded at zero", () => {
  // this is the defect the drafted Code.gs shipped: anchoring at zero makes
  // every projected balance wrong by the starting balance
  const data = I.emptyData();
  I.readConfigInto([
    ["Key", "Value", "Notes"],
    ["anchorSunday", "2026-07-26", ""],
    ["anchorBalance", "", ""],
  ], data);
  eq(data.anchor, null, "incomplete anchor must not be used");
});

check("dates are read whether the cell is text or a Date", () => {
  eq(I.isoOf("2026-08-19"), "2026-08-19", "iso text");
  eq(I.isoOf(new Date(Date.UTC(2026, 7, 19))), "2026-08-19", "Date object");
  eq(I.isoOf(""), "", "blank");
});

check("blank and malformed leave rows are skipped, not crashed on", () => {
  const data = I.emptyData();
  I.readLeaveInto([
    ["Date", "PTOB", "Parental", "Label", "Updated"],
    ["", "", "", "", ""],
    ["not a date", 8, 0, "junk", ""],
    ["2026-08-19", "", "", "", ""],
    ["2026-08-21", "8", "0", "typed as text", ""],
  ], TYPES, data);
  ok(!data.entries[""], "blank row created an entry");
  eq(data.entries["2026-08-19"], undefined, "empty day should not be stored");
  eq(data.entries["2026-08-21"], { b: 8, nr: 0, label: "typed as text" },
     "numbers entered as text");
});

check("duplicate rows for one day are summed, not silently dropped", () => {
  // a hand-editor can easily add a second row for the same date
  const data = I.emptyData();
  I.readLeaveInto([
    ["Date", "PTOB", "Parental", "Label", "Updated"],
    ["2026-08-19", 4, 0, "morning", ""],
    ["2026-08-19", 4, 0, "afternoon", ""],
  ], TYPES, data);
  eq(data.entries["2026-08-19"].b, 8, "hours summed");
  eq(data.entries["2026-08-19"].label, "afternoon", "last label wins");
});

check("a type added to the registry gets its own column", () => {
  const types = TYPES.concat([
    { key: "Sick", label: "Sick", model: "none", active: true }]);
  const data = I.emptyData();
  data.entries = { "2026-08-19": { b: 8, nr: 0, label: "" } };
  const grid = I.leaveRows(data, types);
  eq(grid[0], ["Date", "PTOB", "Parental", "Sick", "Label", "Updated"],
     "new column appears with no deploy");
});

check("inactive types are excluded from the layout", () => {
  const types = TYPES.concat([
    { key: "Jury", label: "Jury", model: "none", active: false }]);
  const grid = I.leaveRows(I.emptyData(), types);
  ok(grid[0].indexOf("Jury") < 0, "inactive type should not get a column");
});

/* ---------------------------------------------------- first connection */

const withEntries = (n) => {
  const d = I.emptyData();
  for (let i = 0; i < n; i++) {
    d.entries[`2026-09-${String(i + 1).padStart(2, "0")}`] =
      { b: 8, nr: 0, label: "" };
  }
  return d;
};

check("an empty Sheet must not erase a plan held in the browser", () => {
  // the unrecoverable failure: hydrate() used to localWrite() the empty
  // Sheet straight over localStorage, destroying both copies at once
  ok(I.needsSeeding(I.emptyData(), withEntries(3)),
     "empty Sheet + local plan must be treated as a first connection");
});

check("a Sheet that already has leave is the source of truth", () => {
  ok(!I.needsSeeding(withEntries(2), withEntries(3)),
     "a populated Sheet must not be overwritten by the browser");
});

check("two empty sides need no migration", () => {
  ok(!I.needsSeeding(I.emptyData(), I.emptyData()), "nothing to migrate");
});

check("a cleared plan is not resurrected from a stale browser copy", () => {
  // deleting every day in the Sheet is legitimate; only a browser that
  // still holds days would trigger seeding, so this is the case to watch
  ok(!I.needsSeeding(I.emptyData(), I.emptyData()),
     "an intentionally emptied Sheet with an empty browser stays empty");
});

/* ------------------------------------------------------ config.js */
/* The deployed page loads config.js with onerror="__noSheetConfig = true",
   which only catches a 404 -- a syntax error or a renamed field fails
   silently and drops the live site back to localStorage with no warning.
   These assert the committed file really does configure the store. */

check("config.js exists and is committed", () => {
  const fs = require("fs"), path = require("path");
  const p = path.join(__dirname, "..", "config.js");
  ok(fs.existsSync(p), "config.js is missing — the deployed app stays local");
});

check("config.js configures the store", () => {
  const fs = require("fs"), path = require("path"), vm = require("vm");
  const src = fs.readFileSync(path.join(__dirname, "..", "config.js"), "utf8");
  let called = null;
  const sandbox = { LeaveStore: { configure: (o) => { called = o; } }, console };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: "config.js" });
  ok(called, "config.js never called LeaveStore.configure()");
  ok(called.clientId && /\.apps\.googleusercontent\.com$/.test(called.clientId),
     `clientId looks wrong: ${called.clientId}`);
  ok(called.apiKey && called.apiKey.length > 20,
     `apiKey looks wrong: ${called.apiKey}`);
  eq(called.fileName, "Leave Planner", "fileName");
});

check("config.js leaves the store reporting configured", () => {
  const fs = require("fs"), path = require("path"), vm = require("vm");
  const src = fs.readFileSync(path.join(__dirname, "..", "config.js"), "utf8");
  const sandbox = { LeaveStore: S, console };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: "config.js" });
  ok(S.configured(), "store still reports unconfigured after config.js ran");
});

check("no client secret was pasted into config.js", () => {
  const fs = require("fs"), path = require("path");
  const src = fs.readFileSync(path.join(__dirname, "..", "config.js"), "utf8");
  ok(!/client_?secret/i.test(src), "config.js mentions a client secret");
  ok(!/GOCSPX-/.test(src), "config.js contains a Google client secret");
});

/* ------------------------------------------------- Picker loading */
/* api.js defines gapi but NOT google.picker -- that module only appears after
   gapi.load("picker").  Nothing called it, so pickShared() rejected with
   "Google Picker is not loaded." every time and Pick a Sheet never opened. */

/* These share global.window, so they must run one at a time, not raced --
   and the runner has to start AFTER the queue is filled, or it silently
   reports success having executed nothing. */
const queued = [];
const asyncCheck = (name, fn) => queued.push([name, fn]);
const runQueued = async () => {
  for (const [name, fn] of queued) {
    try { await fn(); pass++; }
    catch (e) { failures.push(`${name}\n    ${e.message}`); }
  }
  return queued.length;
};

asyncCheck("loadPicker resolves when the picker is already there", async () => {
  global.window.google = { picker: {} };
  delete global.window.gapi;
  await I.loadPicker();
});

asyncCheck("loadPicker pulls in the picker module via gapi", async () => {
  delete global.window.google;
  let askedFor = null;
  global.window.gapi = {
    load: (name, cb) => {
      askedFor = name;
      global.window.google = { picker: {} };     // what gapi.load really does
      cb.callback();
    },
  };
  await I.loadPicker();
  if (askedFor !== "picker")
    throw new Error(`gapi.load("${askedFor}"), expected "picker"`);
  if (!global.window.google.picker)
    throw new Error("resolved without google.picker");
});

asyncCheck("pickShared loads the picker instead of giving up", async () => {
  // the regression itself: picker absent, but gapi can supply it
  delete global.window.google;
  global.window.gapi = {
    load: (n, cb) => {
      global.window.google = { picker: {} };   // present but not usable
      cb.callback();
    },
  };
  let msg = null;
  await I.pickShared().then(() => {}, (e) => { msg = e.message; });
  // it must get PAST the availability check -- whatever it fails on next,
  // it must not be "Google Picker is not loaded."
  if (msg && /picker is not loaded/i.test(msg))
    throw new Error("pickShared still bails instead of loading the picker");
});

/* ------------------------------- the UI's auto-pick trigger matches */
/* The Google Sync button falls through to the picker by matching the store's
   error text.  That coupling is invisible from either file, so if someone
   rewords a message the button quietly stops being able to recover. */

check("needsAPick matches the messages the store actually produces", () => {
  const fs = require("fs"), path = require("path");
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const src = /function needsAPick\(err\) \{[\s\S]*?\n\}/.exec(html);
  ok(src, "needsAPick not found in index.html");
  // eslint-disable-next-line no-eval
  const needsAPick = eval("(" + src[0].replace("function needsAPick", "function") + ")");

  const store = fs.readFileSync(path.join(__dirname, "..", "sheets-store.js"), "utf8");
  const noSheet = /'No Sheet named "' \+ FILE_NAME \+ '([^']*)'/.exec(store);
  ok(noSheet, "the 'No Sheet named' message has moved or been reworded");
  ok(needsAPick(new Error('No Sheet named "Leave Planner"' + noSheet[1])),
     "needsAPick no longer matches the not-found message");

  ok(/cannot open it yet/.test(store),
     "the 'cannot open it yet' message has moved or been reworded");
  ok(needsAPick(new Error('Found "Leave Planner" but this app cannot open '
                          + 'it yet. Click "Pick a Sheet" and select it once '
                          + 'to grant access.')),
     "needsAPick no longer matches the not-granted message");

  // and it must NOT fire on unrelated failures, or a popup problem would
  // silently turn into a picker
  ok(!needsAPick(new Error("Google's sign-in popup was blocked — allow "
                           + "popups for this site and try again.")),
     "needsAPick fires on an auth error");
  ok(!needsAPick(new Error("Google sign-in expired — sign in again.")),
     "needsAPick fires on an expired session");
});

/* ------------------------------------------------- token reuse */
/* Google gives an access token good for ~an hour and no refresh token. It
   used to live in memory only, so every page load had to ask again -- silent
   on a desktop with a live Google session, a popup every time on a phone. */

asyncCheck("a live token is reused without asking Google", async () => {
  I.resetAuth();
  I.saveToken("cached-tok", 3600);
  let asked = false;
  const g = { accounts: { oauth2: {
    initTokenClient: () => ({ requestAccessToken: () => { asked = true; } }),
    revoke: () => {},
  } } };
  global.window.google = g; global.google = g;
  const tok = await I.authenticate({});
  if (asked) throw new Error("asked Google despite holding a live token");
  eq(tok, "cached-tok", "token");
});

asyncCheck("an expired token is not reused", async () => {
  I.resetAuth();
  I.saveToken("stale-tok", -10);            // already past its expiry
  if (I.savedToken()) throw new Error("offered an expired token");
  const prompts = mockGisSeq([grant]);
  await I.authenticate({});
  eq(prompts, [""], "had to ask again, quietly");
});

asyncCheck("a token about to expire is not reused", async () => {
  I.resetAuth();
  I.saveToken("nearly-tok", 30);            // inside the safety margin
  if (I.savedToken())
    throw new Error("offered a token expiring inside the margin");
});

asyncCheck("a rejected token is discarded, not retried", async () => {
  I.resetAuth();
  I.saveToken("revoked-tok", 3600);
  global.fetch = async () => ({ status: 401, ok: false, text: async () => "" });
  await I.useFile("f1").then(() => {}, () => {});
  if (I.savedToken())
    throw new Error("kept a token Google had already rejected");
});

asyncCheck("signing out forgets the token", async () => {
  I.resetAuth();
  I.saveToken("tok", 3600);
  S.signOut();
  if (I.savedToken()) throw new Error("token survived sign-out");
});

/* --------------------------------------- knowing whether to expect a Sheet */

asyncCheck("no remembered Sheet before ever connecting", async () => {
  I.forgetFile();
  if (S.hasRememberedSheet())
    throw new Error("claims a Sheet with nothing remembered");
});

asyncCheck("a Sheet is remembered once one opens successfully", async () => {
  I.forgetFile();
  global.fetch = async () => ({
    status: 200, ok: true,
    json: async () => ({ id: "f9", name: "Leave Planner",
                         headRevisionId: "r1",
                         capabilities: { canEdit: true } }),
  });
  await I.useFile("f9");
  if (!S.hasRememberedSheet())
    throw new Error("did not remember a Sheet that opened fine");
});

/* ------------------------------------------------- pulling changes */
/* Drive cannot push to a static site, so the Sheet is polled when the tab is
   looked at.  The rule that matters: a pull must never overwrite edits that
   exist only in this browser. */

async function connectedStore(revision, opts) {
  opts = opts || {};
  I.resetAuth();
  mockGisSeq([grant]);
  I.forgetFile();
  global.fetch = async (url) => {
    const u = String(url);
    if (u.indexOf("/files/") >= 0 && u.indexOf("headRevisionId") >= 0
        && u.indexOf("capabilities") < 0) {
      return { status: 200, ok: true,
               json: async () => ({ headRevisionId: opts.remote || revision }) };
    }
    if (u.indexOf("/files/") >= 0 && u.indexOf("capabilities") >= 0) {
      return { status: 200, ok: true,
               json: async () => ({ id: "f1", name: "Leave Planner",
                                    headRevisionId: revision,
                                    capabilities: { canEdit: true } }) };
    }
    if (u.indexOf("/files?q=") >= 0) {
      return { status: 200, ok: true,
               json: async () => ({ files: [{ id: "f1", name: "Leave Planner" }] }) };
    }
    return { status: 200, ok: true, json: async () => ({ valueRanges: [] }) };
  };
  await I.useFile("f1");
  return S;
}

asyncCheck("an unmoved Sheet reports unchanged and does nothing", async () => {
  await connectedStore("rev-1");
  const r = await S.pollRemote();
  eq(r.state, "unchanged", "poll state");
  const p = await S.pull();
  eq(p.state, "unchanged", "pull state");
});

asyncCheck("a moved Sheet is reported as changed", async () => {
  await connectedStore("rev-1", { remote: "rev-2" });
  const r = await S.pollRemote();
  eq(r.state, "changed", "poll state");
});

asyncCheck("unsaved local edits turn a move into a conflict", async () => {
  await connectedStore("rev-1", { remote: "rev-2" });
  const d = I.emptyData();
  d.entries["2026-09-01"] = { b: 8, nr: 0, label: "mine" };
  S.write(d);                                    // marks dirty
  const r = await S.pollRemote();
  eq(r.state, "conflict", "poll state");
});

asyncCheck("a pull refuses to discard unsaved edits", async () => {
  await connectedStore("rev-1", { remote: "rev-2" });
  const d = I.emptyData();
  d.entries["2026-09-01"] = { b: 8, nr: 0, label: "mine" };
  S.write(d);
  const p = await S.pull();
  if (p.state === "pulled")
    throw new Error("pulled over unsaved local edits");
  eq(p.state, "conflict", "pull state");
});

asyncCheck("pollRemote is inert when not connected to a Sheet", async () => {
  I.resetAuth();
  S.signOut();
  const r = await S.pollRemote();
  eq(r.state, "local", "poll state");
});

/* ------------------------------------------ consent is not re-asked */

/* Records the prompt value of every requestAccessToken call. */
function mockGisSeq(outcomes) {
  I.resetAuth();
  const prompts = [];
  let cfg = null, n = 0;
  const g = { accounts: { oauth2: {
    initTokenClient: (c) => { cfg = c; return {
      requestAccessToken: (o) => {
        prompts.push(o && o.prompt);
        const out = outcomes[Math.min(n++, outcomes.length - 1)];
        out(cfg);
      },
    }; },
    revoke: () => {},
  } } };
  global.window.google = g; global.google = g;
  return prompts;
}
const grant = (cfg) => cfg.callback({ access_token: "tok" });
const needsUi = (cfg) => cfg.error_callback({ type: "unknown" });
const userClosed = (cfg) => cfg.error_callback({ type: "popup_closed" });

asyncCheck("an existing grant is reused without a consent screen", async () => {
  const prompts = mockGisSeq([grant]);
  await I.authenticate({});
  eq(prompts, [""], "prompts used");
  if (prompts.indexOf("consent") >= 0)
    throw new Error("re-asked for consent despite an existing grant");
});

asyncCheck("consent is asked for only when the quiet attempt fails", async () => {
  const prompts = mockGisSeq([needsUi, grant]);
  await I.authenticate({});
  eq(prompts, ["", "consent"], "prompts used");
});

asyncCheck("closing the popup does not reopen it", async () => {
  const prompts = mockGisSeq([userClosed]);
  await I.authenticate({}).then(() => { throw new Error("should have failed"); },
                                () => {});
  eq(prompts, [""], "prompts used");
});

asyncCheck("a silent reconnect never escalates", async () => {
  const prompts = mockGisSeq([needsUi]);
  await I.authenticate({ silent: true }).then(() => {}, () => {});
  eq(prompts, [""], "prompts used");
});

/* ------------------------------------------------ picker app id */
/* The Picker grants drive.file access to a picked file only when it knows
   the app id (the Cloud project number).  Without setAppId the pick looked
   fine and granted nothing, so files.get came back 404 -- indistinguishable
   from "you never picked it". */

check("the app id is derived from the client id", () => {
  eq(I.appId(), "831104318690", "app id");
});

asyncCheck("the picker is told the app id", async () => {
  const seen = { appId: null, token: null, key: null };
  const chain = {
    setOAuthToken: (t) => { seen.token = t; return chain; },
    setDeveloperKey: (k) => { seen.key = k; return chain; },
    addView: () => chain,
    setAppId: (a) => { seen.appId = a; return chain; },
    setCallback: (cb) => { chain._cb = cb; return chain; },
    build: () => ({ setVisible: () => { chain._cb({ action: "cancel" }); } }),
  };
  const view = { setIncludeFolders: () => view, setSelectFolderEnabled: () => view };
  global.window.google = { picker: {
    ViewId: { SPREADSHEETS: "ss" },
    DocsView: function () { return view; },
    Action: { PICKED: "picked", CANCEL: "cancel" },
    PickerBuilder: function () { return chain; },
  } };
  global.google = global.window.google;
  await I.pickFrom().then(() => {}, () => {});      // cancelled; we want the config
  if (!seen.appId)
    throw new Error("PickerBuilder.setAppId was never called");
  if (seen.appId !== "831104318690")
    throw new Error(`setAppId("${seen.appId}"), expected the project number`);
  if (!seen.key) throw new Error("developer key not set");
});

/* ---------------------------------------------- sign-in never hangs */
/* GIS reports a blocked or closed popup on error_callback, not callback.
   Only callback was wired, so a blocked popup left the promise forever
   pending: the UI showed nothing at all and no error reached the banner. */

function mockGis(behaviour) {
  I.resetAuth();                       // tokenClient is module-level state
  let cfg = null;
  const g = {
    accounts: { oauth2: {
      initTokenClient: (c) => { cfg = c; return {
        requestAccessToken: () => behaviour(cfg),
      }; },
      revoke: () => {},
    } },
  };
  // the store reads both `window.google` and bare `google`; in a browser
  // those are the same object, so the mock has to satisfy both
  global.window.google = g;
  global.google = g;
}

asyncCheck("a blocked popup rejects instead of hanging", async () => {
  mockGis((cfg) => cfg.error_callback({ type: "popup_failed_to_open" }));
  let msg = null;
  await S.connect({}).then(() => {}, (e) => { msg = e.message; });
  if (!msg) throw new Error("connect() never settled — the original hang");
  if (!/blocked/i.test(msg) || !/allow popups/i.test(msg))
    throw new Error(`unhelpful message: ${msg}`);
});

asyncCheck("a closed popup rejects with its own message", async () => {
  mockGis((cfg) => cfg.error_callback({ type: "popup_closed" }));
  let msg = null;
  await S.connect({}).then(() => {}, (e) => { msg = e.message; });
  if (!msg || !/closed before it finished/i.test(msg))
    throw new Error(`unhelpful message: ${msg}`);
});

asyncCheck("an unknown auth error still names itself", async () => {
  mockGis((cfg) => cfg.error_callback({ type: "something_new" }));
  let msg = null;
  await S.connect({}).then(() => {}, (e) => { msg = e.message; });
  if (!msg || !/something_new/.test(msg))
    throw new Error(`error type was swallowed: ${msg}`);
});

/* ------------------------------------------- remembered file id */

asyncCheck("a failed open does not leave a file id behind", async () => {
  global.localStorage.setItem("leavePlannerFileId", "");
  global.localStorage.s["leavePlannerFileId"] = undefined;
  delete global.localStorage.s["leavePlannerFileId"];
  global.fetch = async () => ({
    status: 404, ok: false, text: async () => '{"error":"File not found"}',
  });
  await I.useFile("bogus-id").then(() => {}, () => {});
  const left = I.rememberedFile();
  if (left) throw new Error(`stored a bad id anyway: ${left}`);
});

asyncCheck("a good open is remembered", async () => {
  global.fetch = async () => ({
    status: 200, ok: true,
    json: async () => ({ id: "good-id", name: "Leave Planner",
                         headRevisionId: "r1",
                         capabilities: { canEdit: true } }),
  });
  await I.useFile("good-id");
  if (I.rememberedFile() !== "good-id")
    throw new Error(`did not remember: ${I.rememberedFile()}`);
});

asyncCheck("a listed-but-unopenable Sheet says to use Pick a Sheet", async () => {
  I.forgetFile();
  global.fetch = async (url) => (String(url).indexOf("/files?q=") >= 0
    ? { status: 200, ok: true,
        json: async () => ({ files: [{ id: "x1", name: "Leave Planner" }] }) }
    : { status: 404, ok: false, text: async () => '{"error":"File not found"}' });
  let msg = null;
  await I.openOwn().then(() => {}, (e) => { msg = e.message; });
  if (!msg) throw new Error("expected a failure");
  if (!/Pick a Sheet/i.test(msg))
    throw new Error(`raw API error reached the user: ${msg}`);
});

asyncCheck("loadPicker surfaces a gapi.load failure", async () => {
  delete global.window.google;
  global.window.gapi = { load: (n, cb) => cb.onerror() };
  let msg = null;
  await I.loadPicker().then(() => {}, (e) => { msg = e.message; });
  if (!msg || !/failed to load/i.test(msg))
    throw new Error(`unhelpful error: ${msg}`);
});

asyncCheck("loadPicker gives up if gapi never arrives", async () => {
  delete global.window.google;
  delete global.window.gapi;
  const realTimeout = global.setTimeout;
  global.setTimeout = (fn) => realTimeout(fn, 0);   // collapse the wait
  let msg = null;
  await I.loadPicker().then(() => {}, (e) => { msg = e.message; });
  global.setTimeout = realTimeout;
  if (!msg || !/did not load/i.test(msg))
    throw new Error(`unhelpful timeout error: ${msg}`);
  if (!/script blocker/i.test(msg))
    throw new Error("timeout error does not suggest what to check");
});

runQueued().then((ran) => {
if (ran !== 28) {
  console.log(`\nHARNESS ERROR: ${ran} async checks ran, expected 28`);
  process.exit(1);
}
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("\nFAILURES:");
  for (const f of failures) console.log("  - " + f);
  process.exit(1);
}
});
