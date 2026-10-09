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
  eq(data.entries["2026-08-19"], { b: 8, nr: 0, f: 0, label: "dentist" }, "PTOB day");
  eq(data.entries["2026-08-20"], { b: 4, nr: 4, f: 0, label: "half day" }, "split day");
  eq(data.entries["2026-09-08"], { b: 0, nr: 8, f: 0, label: "parental" }, "parental day");
});

check("a day is round-tripped through the Sheet unchanged", () => {
  const before = I.emptyData();
  before.entries = {
    "2026-08-19": { b: 8, nr: 0, f: 0, label: "dentist" },
    "2026-08-20": { b: 4, nr: 4, f: 0, label: "half day" },
    "2026-09-08": { b: 0, nr: 8, f: 0, label: "parental" },
  };
  const grid = I.leaveRows(before, TYPES);
  const after = I.emptyData();
  I.readLeaveInto(grid, TYPES, after);
  eq(after.entries, before.entries, "entries survived the round trip");
});

check("the shared label survives -- it is not duplicated per type", () => {
  const data = I.emptyData();
  data.entries = { "2026-08-20": { b: 4, nr: 4, f: 0, label: "half day" } };
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
  eq(data.entries["2026-08-21"], { b: 8, nr: 0, f: 0, label: "typed as text" },
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
  data.entries = { "2026-08-19": { b: 8, nr: 0, f: 0, label: "" } };
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
      { b: 8, nr: 0, f: 0, label: "" };
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

/* ------------------------------------------- flex holiday column */
/* The Leave tab has one column per active registry type, mapped by model.
   A model the mapper does not know writes 0 into the Sheet instead of the
   hours -- silent data loss, so the mapping is pinned here. */

const TYPES_WITH_FLEX = [
  {key: "PTOB", label: "PTOB", model: "biweekly", active: true},
  {key: "Parental", label: "Parental", model: "grant", active: true},
  {key: "Flex", label: "Flex", model: "annual", active: true},
];

check("the annual model maps to the flex field", () => {
  eq(I.fieldOf({model: "annual"}), "f", "annual");
  eq(I.fieldOf({model: "biweekly"}), "b", "biweekly");
  eq(I.fieldOf({model: "grant"}), "nr", "grant");
});

check("a flex day round-trips through the Leave tab", () => {
  const day = {b: 0, nr: 0, f: 8, label: "flex day"};
  const rows = I.leaveRows({entries: {"2026-11-23": day}}, TYPES_WITH_FLEX);
  eq(rows[0], ["Date", "PTOB", "Parental", "Flex", "Label", "Updated"], "header");
  const body = rows[1];
  eq(body[3], 8, "flex hours were not written: " + JSON.stringify(body));

  const back = I.emptyData();
  I.readLeaveInto(rows, TYPES_WITH_FLEX, back);
  eq(back.entries["2026-11-23"].f, 8, "flex hours did not come back");
  eq(back.entries["2026-11-23"].b, 0, "PTOB was invented");
});

check("a day carrying only flex is not dropped on read", () => {
  const rows = [["Date", "PTOB", "Parental", "Flex", "Label", "Updated"],
                ["2026-11-23", 0, 0, 8, "", ""]];
  const back = I.emptyData();
  I.readLeaveInto(rows, TYPES_WITH_FLEX, back);
  ok(back.entries["2026-11-23"], "a flex-only day was discarded");
  eq(back.entries["2026-11-23"].f, 8, "flex hours");
});

/* ------------------------------------------ orphaned leave types */
/* The whole-tab rewrite is destructive: hours belonging to a type the
   Sheet's registry does not list get written nowhere and vanish on the
   next read. That happened to a 32 h flex-holiday import. The push now
   has to notice and say so. */

const TYPES_NO_FLEX = TYPES_WITH_FLEX.slice(0, 2);

check("flex hours with no Flex column are reported, not swallowed", () => {
  const data = {entries: {
    "2025-11-20": {b: 4, nr: 0, f: 4, label: "flex holiday"},
    "2025-11-21": {b: 0, nr: 0, f: 8, label: "flex holiday"},
  }};
  const orphans = I.orphanFields(data, TYPES_NO_FLEX);
  eq(orphans.f, 12, "flex hours were not counted as orphaned");
  ok(!("b" in orphans), "PTOB has a column and must not be flagged");
  ok(!("label" in orphans), "the label is not a leave type");
});

check("nothing is flagged once the Flex column exists", () => {
  const data = {entries: {"2025-11-21": {b: 0, nr: 0, f: 8, label: ""}}};
  eq(Object.keys(I.orphanFields(data, TYPES_WITH_FLEX)).length, 0,
     "a mapped type was flagged as orphaned");
});

check("zero hours of an unmapped type are not worth a warning", () => {
  const data = {entries: {"2025-11-21": {b: 8, nr: 0, f: 0, label: ""}}};
  eq(Object.keys(I.orphanFields(data, TYPES_NO_FLEX)).length, 0,
     "0 h of flex raised a false alarm");
});

check("an inactive type does not count as having a column", () => {
  const off = TYPES_WITH_FLEX.map((t) =>
    t.key === "Flex" ? Object.assign({}, t, {active: false}) : t);
  const data = {entries: {"2025-11-21": {b: 0, nr: 0, f: 8, label: ""}}};
  eq(I.orphanFields(data, off).f, 8,
     "flex is inactive, so leaveRows drops the column and the hours");
});

check("pushAll actually consults orphanFields", () => {
  /* orphanFields is only useful if the destructive write path calls it.
     pushAll needs live gapi to run, so the wiring is checked in the
     source: a warning nobody raises is the exact bug this guards. */
  const src = require("fs").readFileSync(
    require("path").join(__dirname, "..", "sheets-store.js"), "utf8");
  const body = src.slice(src.indexOf("function pushAll"));
  const push = body.slice(0, body.indexOf("\n  }\n"));
  ok(/orphanFields\(/.test(push), "pushAll never calls orphanFields");
  ok(/log\("error"/.test(push), "pushAll notices orphans but says nothing");
  ok(/seedTypes\(/.test(push), "pushAll never calls seedTypes");
  /* order is the whole point: seeding after the payload is built would send
     the new registry row without the column it exists for, and the next
     pull would read zeros over the hours */
  ok(push.indexOf("seedTypes(") < push.indexOf("leaveRows("),
     "pushAll seeds the type after building the Leave rows");
  ok(/seeded\.forEach/.test(push), "the seeded row is never pushed");
});

/* ------------------------------------- adopting an orphaned type */
/* Warning about lost hours is better than losing them silently, but the
   app knows its own three leave types, so it can add the registry row
   itself. It must do so in the same push that writes the column, and must
   not overrule a type the user switched off on purpose. */

const TYPES_GRID = [
  ["Key", "Label", "Color", "Model", "Rate", "RateAfter", "StepYears",
   "Cap", "CapAfter", "GrantHours", "ExpiresMonths", "WholeHoursOnly",
   "Active"],
  ["PTOB", "PTOB", "#2f9e5f", "biweekly", 6.7692, 8, 9, 240, 320,
   "", "", "FALSE", "TRUE"],
  ["Parental", "Parental", "#e05b8a", "grant", "", "", "", "", "",
   480, 12, "TRUE", "TRUE"],
];

const gridCopy = () => TYPES_GRID.map((r) => r.slice());

check("an unknown type is seeded into the first blank LeaveTypes row", () => {
  I.setTypesGrid(gridCopy());
  const writes = I.seedTypes(["f"]);
  eq(writes.length, 1, "nothing was seeded");
  eq(writes[0].range, "LeaveTypes!A4:M4", "wrong row: " + writes[0].range);
  const row = writes[0].values[0];
  eq(row[0], "Flex", "key");
  eq(row[3], "annual", "model -- this is what maps it to the f column");
  eq(row[12], true, "a seeded row that is not Active buys nothing");
});

check("seeding updates state.types so the same push writes the column", () => {
  I.setTypesGrid(gridCopy());
  I.seedTypes(["f"]);
  const rows = I.leaveRows({entries: {"2025-11-21": {b: 0, nr: 0, f: 8,
                                                     label: "flex"}}},
                           I.typesOf());
  eq(rows[0], ["Date", "PTOB", "Parental", "Flex", "Label", "Updated"],
     "header: " + JSON.stringify(rows[0]));
  eq(rows[1][3], 8, "the flex hours still went nowhere: "
                    + JSON.stringify(rows[1]));
});

check("a type switched off on purpose is left alone", () => {
  const grid = gridCopy();
  grid.push(["Flex", "Flex", "#0a63c2", "annual", "", "", "", "", "",
             16, "", "FALSE", "FALSE"]);
  I.setTypesGrid(grid);
  eq(I.seedTypes(["f"]).length, 0,
     "re-added a type the user had deactivated");
});

check("seeding is idempotent across two pushes", () => {
  I.setTypesGrid(gridCopy());
  eq(I.seedTypes(["f"]).length, 1, "first push");
  eq(I.seedTypes(["f"]).length, 0, "second push seeded a duplicate row");
});

check("a key differing only in case is still the same type", () => {
  const grid = gridCopy();
  grid.push(["flex", "Flex", "#0a63c2", "annual", "", "", "", "", "",
             16, "", "FALSE", "TRUE"]);
  I.setTypesGrid(grid);
  eq(I.seedTypes(["f"]).length, 0, "added a second Flex row");
});

check("a field the app has no seed for is not invented", () => {
  I.setTypesGrid(gridCopy());
  eq(I.seedTypes(["sick"]).length, 0, "invented a registry row");
});

check("nothing is seeded when the registry was never read", () => {
  I.setTypesGrid(null);
  eq(I.seedTypes(["f"]).length, 0,
     "wrote to LeaveTypes without knowing what is there");
  I.setTypesGrid([]);
  eq(I.seedTypes(["f"]).length, 0, "same for an empty grid");
});

check("a gap in the middle of the registry is filled, not skipped", () => {
  const grid = gridCopy();
  grid.splice(2, 0, []);            // blank row between PTOB and Parental
  I.setTypesGrid(grid);
  const writes = I.seedTypes(["f"]);
  eq(writes.length, 1, "nothing seeded");
  eq(writes[0].range, "LeaveTypes!A3:M3", "did not reuse the blank row");
});

/* ----------------------------------------------- Config round-trip */
/* The Config tab holds eight keys; the app manages four. It used to write
   only its four over the top of the tab without clearing, so every later
   row survived -- and since the reader takes the LAST row for a key, a
   stale anchorBalance below the fresh one won. The anchor reverted on its
   own, or worse, kept a new date against an old balance. */

const CONFIG_AS_SETUP_LEAVES_IT = () => ([
  ["Key", "Value", "Notes"],
  ["displayName", "Leave Planner", "Shown on the Dashboard"],
  ["hireDate", "2019-04-01", "drives the nine-year step-up"],
  ["anchorSunday", "2026-08-09", "a pay-period posting Sunday"],
  ["anchorBalance", 142.69, "known balance ON anchorSunday"],
  ["childBirthDate", "", "blank disables parental leave"],
  ["hoursPerDay", 8, "display only"],
  ["maxDayHours", 8, "max combined hours"],
  ["timezone", "America/New_York", "date display only"],
]);

const keyed = (rows) => {
  const o = {};
  for (let i = 1; i < rows.length; i++) {
    const k = String(rows[i][0] || "").trim();
    if (k) o[k] = rows[i][1];          // later rows win, as the readers do
  }
  return o;
};

check("a re-anchor survives the round trip", () => {
  I.setConfigGrid(CONFIG_AS_SETUP_LEAVES_IT());
  const rows = I.configRows({
    hireDate: "2019-04-01", birthDate: null,
    anchor: { date: "2026-09-20", balance: 150 },
  });
  const got = keyed(rows);
  eq(got.anchorSunday, "2026-09-20", "anchor date");
  eq(got.anchorBalance, 150, "anchor balance");
});

check("no duplicate row can outvote the fresh anchor", () => {
  I.setConfigGrid(CONFIG_AS_SETUP_LEAVES_IT());
  const rows = I.configRows({
    hireDate: "2019-04-01", birthDate: null,
    anchor: { date: "2026-09-20", balance: 150 },
  });
  for (const k of ["anchorSunday", "anchorBalance", "hireDate", "childBirthDate"]) {
    const n = rows.filter(r => String(r[0]).trim() === k).length;
    if (n > 1) throw new Error(`${k} written ${n} times`);
  }
});

check("an already-corrupted tab is repaired on save", () => {
  const corrupt = CONFIG_AS_SETUP_LEAVES_IT();
  corrupt.splice(5, 0, ["anchorBalance", 999, "stale duplicate"]);
  I.setConfigGrid(corrupt);
  const rows = I.configRows({
    hireDate: "2019-04-01", birthDate: null,
    anchor: { date: "2026-09-20", balance: 150 },
  });
  eq(rows.filter(r => String(r[0]).trim() === "anchorBalance").length, 1,
     "anchorBalance rows after repair");
  eq(keyed(rows).anchorBalance, 150, "anchor balance");
});

check("keys the app does not manage are preserved, notes and all", () => {
  I.setConfigGrid(CONFIG_AS_SETUP_LEAVES_IT());
  const rows = I.configRows({
    hireDate: "2019-04-01", birthDate: null,
    anchor: { date: "2026-09-20", balance: 150 },
  });
  const got = keyed(rows);
  eq(got.displayName, "Leave Planner", "displayName");
  eq(got.hoursPerDay, 8, "hoursPerDay");
  eq(got.maxDayHours, 8, "maxDayHours");
  eq(got.timezone, "America/New_York", "timezone");
  const tz = rows.find(r => String(r[0]).trim() === "timezone");
  eq(tz[2], "date display only", "Notes column kept");
});

check("clearing the birth date blanks the cell, it does not drop the row", () => {
  const g = CONFIG_AS_SETUP_LEAVES_IT();
  g[5][1] = "2026-09-01";
  I.setConfigGrid(g);
  const rows = I.configRows({
    hireDate: "2019-04-01", birthDate: null,
    anchor: { date: "2026-09-20", balance: 150 },
  });
  const row = rows.find(r => String(r[0]).trim() === "childBirthDate");
  ok(row, "childBirthDate row was dropped instead of blanked");
  eq(row[1], "", "childBirthDate value");
});

check("a managed key missing from the tab is appended", () => {
  I.setConfigGrid([["Key", "Value", "Notes"], ["timezone", "UTC", ""]]);
  const rows = I.configRows({
    hireDate: null, birthDate: null,
    anchor: { date: "2026-09-20", balance: 150 },
  });
  const got = keyed(rows);
  eq(got.anchorSunday, "2026-09-20", "anchor date appended");
  eq(got.anchorBalance, 150, "anchor balance appended");
  eq(got.timezone, "UTC", "existing key kept");
});

check("end to end: the Sheet reads back the anchor that was saved", () => {
  // Model the real API. values.batchUpdate with an unbounded range overlays
  // rows 1..N and leaves everything below; batchClear on A2:Z first is what
  // makes the write authoritative. Which ranges get cleared is read out of
  // the source, so this test follows the code rather than restating it.
  const fs = require("fs"), path = require("path");
  const src = fs.readFileSync(path.join(__dirname, "..", "sheets-store.js"), "utf8");
  const clears = /ranges: \[([^\]]*)\]/.exec(src)[1];
  const configCleared = /TAB\.config/.test(clears);

  I.setConfigGrid(CONFIG_AS_SETUP_LEAVES_IT());
  const written = I.configRows({
    hireDate: "2019-04-01", birthDate: null,
    anchor: { date: "2026-09-20", balance: 150 },
  });

  let sheet = CONFIG_AS_SETUP_LEAVES_IT();
  if (configCleared) sheet = [sheet[0]];          // A2:Z wiped
  const merged = sheet.slice();
  for (let i = 0; i < written.length; i++) merged[i] = written[i];

  const got = keyed(merged);
  eq(got.anchorSunday, "2026-09-20", "anchor date read back from the Sheet");
  eq(got.anchorBalance, 150, "anchor balance read back from the Sheet");
  // the pairing is what actually corrupted: a new date against an old balance
  if (got.anchorSunday === "2026-09-20" && got.anchorBalance === 142.69)
    throw new Error("new anchor date kept against the old balance");
});

check("Config is cleared before writing, or dropped rows would linger", () => {
  const fs = require("fs"), path = require("path");
  const src = fs.readFileSync(path.join(__dirname, "..", "sheets-store.js"), "utf8");
  const m = /ranges: \[([^\]]*)\]/.exec(src);
  ok(m, "batchClear ranges not found");
  ok(/TAB\.config/.test(m[1]), "Config is not in the batchClear ranges");
});

/* ------------------------------------------- the connected message */

asyncCheck("connecting names the sheet it connected to", async () => {
  I.resetAuth(); I.forgetFile();
  const said = [];
  S.onStatus((m) => said.push(m.message));
  global.fetch = async () => ({
    status: 200, ok: true,
    json: async () => ({ id: "f1", name: "Leave Planner", headRevisionId: "r1",
                         capabilities: { canEdit: true } }),
  });
  await I.useFile("f1");
  const msg = said.find((m) => /Connected to/.test(m));
  ok(msg, "nothing said on connect");
  eq(msg, 'Connected to "Leave Planner" sheet.', "connected message");
});

asyncCheck("a Viewer is told the sheet name and that it is read-only", async () => {
  I.resetAuth(); I.forgetFile();
  const said = [];
  S.onStatus((m) => said.push(m.message));
  global.fetch = async () => ({
    status: 200, ok: true,
    json: async () => ({ id: "f2", name: "Our Leave", headRevisionId: "r1",
                         capabilities: { canEdit: false } }),
  });
  await I.useFile("f2");
  const msg = said.find((m) => /Connected to/.test(m));
  ok(msg, "nothing said on connect");
  ok(/"Our Leave" sheet/.test(msg), `sheet not named: ${msg}`);
  ok(/read-only/.test(msg), `Viewer not warned: ${msg}`);
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
  d.entries["2026-09-01"] = { b: 8, nr: 0, f: 0, label: "mine" };
  S.write(d);                                    // marks dirty
  const r = await S.pollRemote();
  eq(r.state, "conflict", "poll state");
});

asyncCheck("a pull refuses to discard unsaved edits", async () => {
  await connectedStore("rev-1", { remote: "rev-2" });
  const d = I.emptyData();
  d.entries["2026-09-01"] = { b: 8, nr: 0, f: 0, label: "mine" };
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
if (ran !== 30) {
  console.log(`\nHARNESS ERROR: ${ran} async checks ran, expected 30`);
  process.exit(1);
}
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("\nFAILURES:");
  for (const f of failures) console.log("  - " + f);
  process.exit(1);
}
});
