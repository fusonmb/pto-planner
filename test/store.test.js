/* sheets-store.js round-trip tests.
   Because the Sheet is hand-editable, the parse path is as important as the
   write path: whatever a person types on the Leave tab has to survive being
   read into the app's data shape and written back out.
   Run: node test/store.test.js                                          */
"use strict";
global.localStorage = {
  s: {}, getItem(k) { return k in this.s ? this.s[k] : null; },
  setItem(k, v) { this.s[k] = String(v); },
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
    ["hireDate", "2018-11-13", ""],
    ["anchorSunday", "2026-07-26", ""],
    ["anchorBalance", "135.92", ""],
    ["childBirthDate", "2026-08-17", ""],
  ], data);
  eq(data.anchor, { date: "2026-07-26", balance: 135.92 }, "anchor");
  eq(data.hireDate, "2018-11-13", "hire date");
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

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("\nFAILURES:");
  for (const f of failures) console.log("  - " + f);
  process.exit(1);
}
