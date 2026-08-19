/* Characterization tests for the leave calc engine.
   These pin down the behaviour of index.html BEFORE the Google Sheets
   migration, so the backend swap cannot silently change the math.
   Run: node test/calc.test.js                                        */
"use strict";
const fs = require("fs");
const path = require("path");
const { loadEngine } = require("./engine.js");

let pass = 0;
const failures = [];
const FIXTURE = path.join(__dirname, "fixtures", "projection.json");

function check(name, fn) {
  try { fn(); pass++; }
  catch (err) { failures.push(`${name}\n    ${err.message}`); }
}
function eq(actual, expected, what) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what || "value"}: got ${a}, want ${b}`);
}
function ok(cond, what) { if (!cond) throw new Error(what || "expected true"); }
function near(actual, expected, what) {
  if (Math.abs(actual - expected) > 1e-9)
    throw new Error(`${what}: got ${actual}, want ${expected}`);
}

/* a projection over the default configuration, with a frozen "today" so the
   36-month horizon (and therefore the row count) is deterministic */
const TODAY = "2026-08-19";
const ANCHOR = "2026-07-26";
const ANCHOR_BAL = 135.92;
const HIRE = "2018-11-13";
const project = (entries, opts = {}) => {
  const e = loadEngine(null);
  return e.computeProjection(entries, opts.today || TODAY,
    opts.anchor || ANCHOR,
    opts.balance === undefined ? ANCHOR_BAL : opts.balance,
    opts.hire || HIRE, opts.birth || null);
};
const rowAt = (rows, date) => {
  const r = rows.find((x) => x.date === date);
  if (!r) throw new Error(`no projection row for ${date}`);
  return r;
};

/* ---------------------------------------------------- PTOB accrual */

check("anchor is the first row and carries the seeded balance", () => {
  const rows = project({});
  eq(rows[0].date, ANCHOR, "first row date");
  eq(rows[0].balance, ANCHOR_BAL, "anchor balance");
  eq(rows[0].accrued, 0, "anchor accrues nothing");
  eq(rows[0].used, 0, "anchor uses nothing");
});

check("the walk is forward-only -- nothing before the anchor is projected", () => {
  const rows = project({});
  ok(rows.every((r) => r.date >= ANCHOR), "found a row before the anchor");
});

check("periods step every 14 days on the Sunday grid", () => {
  const rows = project({});
  for (let i = 1; i < rows.length; i++) {
    const gap = (Date.parse(rows[i].date) - Date.parse(rows[i - 1].date)) / 86400000;
    eq(gap, 14, `gap before ${rows[i].date}`);
  }
  ok(rows.every((r) => new Date(r.date + "T00:00:00Z").getUTCDay() === 0),
     "a period row is not a Sunday");
});

check("base accrual is 6.7692 h per period before the nine-year mark", () => {
  const rows = project({});
  eq(rows[1].accrued, 6.7692, "first accrual");
  near(rows[1].balance, 142.69, "balance after one period");
  near(rows[2].balance, 149.46, "balance after two periods");
});

check("running balance keeps full precision, rows round only for display", () => {
  // three periods of 6.7692 on 135.92 is 156.2276 -- displayed 156.23, and
  // the fourth row must build on the unrounded value
  const rows = project({});
  near(rows[3].balance, 156.23, "third period rounds for display");
  near(rows[4].balance, 163.0, "fourth period built on full precision");
});

check("accrual and cap step up at the nine-year mark", () => {
  const rows = project({}, { today: "2028-01-15" });
  const nineYear = "2027-11-13";
  const before = rows.filter((r) => r.date < nineYear);
  const after = rows.filter((r) => r.date >= nineYear);
  ok(before.every((r) => r.cap === 240), "cap changed before the mark");
  ok(after.every((r) => r.cap === 320), "cap did not rise at the mark");
  ok(after.slice(1).every((r) => r.accrued === 8.0), "rate did not rise");
  // the step lands on the first period Sunday on or after the anniversary
  eq(after[0].date, "2027-11-14", "first senior period Sunday");
});

/* ---------------------------------------------------- cap and overdraw */

check("usage is subtracted before accrual, so leave frees cap headroom", () => {
  // seed just under the cap, then take 8 h inside one period
  const rows = project({ "2026-08-05": { b: 8, nr: 0, label: "" } },
                       { balance: 238 });
  const r = rowAt(rows, "2026-08-09");
  eq(r.used, 8, "usage in the window");
  // 238 - 8 = 230, + 6.7692 = 236.7692, under the 240 cap so nothing is lost
  near(r.balance, 236.77, "balance");
  eq(r.lost, 0, "nothing lost -- usage made room");
});

check("accrual above the cap is lost, not banked", () => {
  const rows = project({}, { balance: 238 });
  const r = rowAt(rows, "2026-08-09");
  near(r.balance, 240, "balance pins to the cap");
  near(r.lost, 4.77, "overflow is recorded as lost (rounded)");
});

check("the period window is the 14 days ending on the posting Sunday", () => {
  const rows = project({
    "2026-07-27": { b: 8, nr: 0, label: "" },   // day after the anchor
    "2026-08-07": { b: 8, nr: 0, label: "" },   // Friday inside the window
  });
  eq(rowAt(rows, "2026-08-09").used, 16, "both days land in one window");
  eq(rowAt(rows, "2026-08-23").used, 0, "next window is clean");
});

check("PTOB may go negative and is flagged overdrawn", () => {
  const entries = {};
  for (const d of ["2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06",
                   "2026-08-07"]) entries[d] = { b: 8, nr: 0, label: "" };
  const rows = project(entries, { balance: 10 });
  const r = rowAt(rows, "2026-08-09");
  eq(r.used, 40, "week of leave");
  ok(r.balance < 0, "balance should be negative");
  ok(r.overdrawn, "row should be flagged overdrawn");
});

/* ---------------------------------------------------- parental leave */

check("parental remaining is null before birth and zero at expiry", () => {
  const birth = "2026-08-01";
  const rows = project({}, { birth, today: "2027-10-01" });
  ok(rowAt(rows, "2026-07-26").nrRemaining === null, "null before birth");
  eq(rowAt(rows, "2026-08-09").nrRemaining, 480, "full pool after birth");
  eq(rowAt(rows, "2027-08-22").nrRemaining, 0, "zero on/after expiry");
});

check("parental expiry is exactly one year after birth, Feb 29 clamped", () => {
  const e = loadEngine(null);
  eq(e.addYearsIso("2026-08-01", 1), "2027-08-01", "ordinary date");
  eq(e.addYearsIso("2028-02-29", 1), "2029-02-28", "leap day clamps back");
});

check("parental draws down the 480 h pool and never goes negative", () => {
  const birth = "2026-08-01";
  const entries = { "2026-08-05": { b: 0, nr: 8, label: "" } };
  const rows = project(entries, { birth, today: "2026-09-01" });
  eq(rowAt(rows, "2026-08-09").nrRemaining, 472, "pool after 8 h");
  ok(rows.every((r) => r.nrRemaining === null || r.nrRemaining >= 0),
     "parental remaining went negative");
});

/* ---------------------------------------------------- save rules */

const save = (data, args) => {
  const e = loadEngine(data);
  const res = e.applyEntry(args);
  return { res, data: e.store.raw() };
};
const DAY = (b, nr, label) => ({ b, nr, label });

check("weekends and holidays never receive leave", () => {
  const sat = save(null, { dates: ["2026-08-22"], hours: 8, label: "", leaveType: "B" });
  ok(!sat.res.ok, "Saturday was accepted");
  const hol = save(null, { dates: ["2026-09-07"], hours: 8, label: "", leaveType: "B" });
  ok(!hol.res.ok, "Labor Day was accepted");
  // in a bulk range they are skipped, not fatal
  const bulk = save(null, {
    dates: ["2026-09-04", "2026-09-05", "2026-09-06", "2026-09-07", "2026-09-08"],
    hours: 8, label: "", leaveType: "B" });
  ok(bulk.res.ok, "bulk save should succeed");
  eq(Object.keys(bulk.data.entries).sort(), ["2026-09-04", "2026-09-08"],
     "only workdays booked");
  eq(bulk.res.holidaySkipped.length, 3, "weekend+holiday skips reported");
});

check("dates on or before the anchor are rejected", () => {
  const r = save(null, { dates: ["2026-07-20"], hours: 8, label: "", leaveType: "B" });
  ok(!r.res.ok, "pre-anchor date was accepted");
  ok(/already reflected/.test(r.res.error), "unexpected error: " + r.res.error);
});

check("a day holds at most 8 h combined across both types", () => {
  const seeded = { entries: { "2026-08-19": DAY(0, 6, "") } };
  const r = save(seeded, { dates: ["2026-08-19"], hours: 8, label: "", leaveType: "B" });
  ok(r.res.ok, "save should succeed with clamping");
  eq(r.data.entries["2026-08-19"].b, 2, "PTOB clamped to the remaining room");
  eq(r.res.clamped, 1, "clamp reported");
});

check("hours outside 0..8 are refused outright", () => {
  ok(!save(null, { dates: ["2026-08-19"], hours: 9, label: "", leaveType: "B" }).res.ok,
     "9 h accepted");
  ok(!save(null, { dates: ["2026-08-19"], hours: -1, label: "", leaveType: "B" }).res.ok,
     "negative accepted");
});

check("parental leave is whole hours only", () => {
  const seeded = { birthDate: "2026-08-01" };
  const r = save(seeded, { dates: ["2026-08-19"], hours: 4.5, label: "", leaveType: "NR" });
  ok(!r.res.ok, "half hour accepted");
  ok(/1-hour increments/.test(r.res.error), "unexpected error: " + r.res.error);
});

check("parental leave requires a birth date", () => {
  const r = save(null, { dates: ["2026-08-19"], hours: 8, label: "", leaveType: "NR" });
  ok(!r.res.ok, "booked parental with no birth date");
});

check("parental days outside the benefit window are skipped, not fatal", () => {
  const seeded = { birthDate: "2026-08-17" };
  const r = save(seeded, {
    dates: ["2026-08-14", "2026-08-19"],   // first is before birth
    hours: 8, label: "", leaveType: "NR" });
  ok(r.res.ok, "save should succeed");
  eq(Object.keys(r.data.entries), ["2026-08-19"], "only in-window day booked");
  eq(r.res.windowSkipped, ["2026-08-14"], "out-of-window skip reported");
});

check("bulk parental fills in date order until the pool runs dry", () => {
  // 476 h already used leaves room for 4 h only
  const entries = { "2026-08-19": DAY(0, 8, "") };
  let used = 8;
  const d = new Date(Date.UTC(2026, 7, 20));
  while (used < 476) {                    // pad with earlier in-window days
    const ds = d.toISOString().slice(0, 10);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) {
      const give = Math.min(8, 476 - used);   // land on 476 exactly
      entries[ds] = DAY(0, give, "");
      used += give;
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  eq(used, 476, "test setup should consume exactly 476 h");
  const seeded = { birthDate: "2026-08-01", entries };
  const target = ["2026-12-01", "2026-12-02", "2026-12-03"];
  const r = save(seeded, { dates: target, hours: 8, label: "", leaveType: "NR" });
  ok(r.res.ok, "save should succeed");
  const booked = target.filter((t) => r.data.entries[t]);
  eq(booked, ["2026-12-01"], "only the first day should be filled");
  eq(r.data.entries["2026-12-01"].nr, 4, "filled with what remained");
  const total = Object.values(r.data.entries).reduce((s, e) => s + e.nr, 0);
  ok(total <= 480, `parental total ${total} exceeded the 480 h pool`);
});

check("clear removes the whole day, both types and the label", () => {
  const seeded = { entries: { "2026-08-19": DAY(8, 0, "vacation") } };
  const r = save(seeded, { dates: ["2026-08-19"], hours: 0, label: "", clear: true });
  ok(r.res.ok, "clear failed");
  eq(r.data.entries["2026-08-19"], undefined, "day should be gone");
});

check("the label is shared per day across both leave types", () => {
  const seeded = { birthDate: "2026-08-01", entries: {} };
  const e = loadEngine(seeded);
  e.applyEntry({ dates: ["2026-08-19"], hours: 4, label: "half day", leaveType: "B" });
  e.applyEntry({ dates: ["2026-08-19"], hours: 4, label: "half day", leaveType: "NR" });
  const day = e.store.raw().entries["2026-08-19"];
  eq(day, { b: 4, nr: 4, label: "half day" }, "day should carry both types");
});

/* ---------------------------------------------------- re-anchoring */

check("re-anchoring must land on the 14-day grid and not in the future", () => {
  const e = loadEngine(null);
  ok(!e.applyAnchor({ balance: 100, date: "2026-08-05" }).ok, "off-grid accepted");
  ok(!e.applyAnchor({ balance: 100, date: "2030-08-09" }).ok, "future accepted");
  ok(e.applyAnchor({ balance: 100, date: "2026-08-09" }).ok, "valid Sunday refused");
  eq(e.store.raw().anchor, { date: "2026-08-09", balance: 100 }, "anchor stored");
});

/* ---------------------------------------------------- holidays */

check("built-in holidays can be removed and custom ones added", () => {
  const e = loadEngine(null);
  e.applyHoliday({ dates: ["2026-09-07"], remove: true });
  e.applyHoliday({ dates: ["2026-09-08"], name: "Company day" });
  const d = e.store.raw();
  eq(d.removedHolidays, ["2026-09-07"], "removal not tracked");
  eq(d.holidays["2026-09-08"], "Company day", "custom holiday not stored");
  // a removed built-in now accepts leave
  ok(e.applyEntry({ dates: ["2026-09-07"], hours: 8, label: "", leaveType: "B" }).ok,
     "removed holiday still blocks leave");
});

check("the 2030 calendar quirk is preserved as transcribed", () => {
  const e = loadEngine(null);
  // MLK 2030 is Jan 21, but the MITRE pay calendar prints Jan 14 -- keep it
  ok(e.BUILTIN_HOLIDAYS["2030-01-14"], "2030-01-14 missing");
  ok(!e.BUILTIN_HOLIDAYS["2030-01-21"], "2030-01-21 should not be a holiday");
});

/* ---------------------------------------------------- golden fixture */

/* A full projection over a realistic plan.  Any backend change must
   reproduce this byte for byte.  Regenerate deliberately:
       UPDATE_FIXTURES=1 node test/calc.test.js                        */
const GOLDEN_ENTRIES = {
  "2026-08-19": DAY(8, 0, "dentist"),
  "2026-08-20": DAY(4, 4, "half day"),
  "2026-09-08": DAY(0, 8, "parental"),
  "2026-09-09": DAY(0, 8, "parental"),
  "2026-11-27": DAY(8, 0, "long weekend"),
  "2027-01-04": DAY(8, 0, "new year"),
  "2027-11-15": DAY(8, 0, "after the step-up"),
};

check("golden projection fixture is unchanged", () => {
  const rows = project(GOLDEN_ENTRIES, {
    birth: "2026-08-17", today: TODAY, hire: HIRE });
  const actual = JSON.stringify(rows, null, 2) + "\n";
  if (process.env.UPDATE_FIXTURES) {
    fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
    fs.writeFileSync(FIXTURE, actual);
    return;
  }
  if (!fs.existsSync(FIXTURE))
    throw new Error("fixture missing -- run UPDATE_FIXTURES=1 node test/calc.test.js");
  const want = fs.readFileSync(FIXTURE, "utf8");
  if (actual !== want) {
    const a = actual.split("\n"), b = want.split("\n");
    const i = a.findIndex((l, k) => l !== b[k]);
    throw new Error(`projection drifted at line ${i + 1}:\n`
                    + `      got  ${a[i]}\n      want ${b[i]}`);
  }
});

/* ---------------------------------------------------- report */

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("\nFAILURES:");
  for (const f of failures) console.log("  - " + f);
  process.exit(1);
}
