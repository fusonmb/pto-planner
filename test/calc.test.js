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
const ANCHOR_BAL = 100.00;
const HIRE = "2018-10-05";   // nine-year mark 2027-10-05, still ahead
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
  near(rows[1].balance, 106.77, "balance after one period");
  near(rows[2].balance, 113.54, "balance after two periods");
});

check("running balance keeps full precision, rows round only for display", () => {
  // The two chains only diverge at the seventh period: carrying the full
  // float gives 147.38, while re-rounding each row and accumulating that
  // gives 147.39.  Earlier rows agree, so asserting only those proves
  // nothing -- row 7 is what actually pins the behaviour.
  const rows = project({});
  near(rows[3].balance, 120.31, "third period rounds for display");
  near(rows[7].balance, 147.38, "seventh period built on the unrounded value");
});

check("accrual and cap step up at the nine-year mark", () => {
  const rows = project({}, { today: "2028-01-15" });
  const e = loadEngine(null);
  const nineYear = e.addYearsIso(HIRE, e.STEP_YEARS);
  const before = rows.filter((r) => r.date < nineYear);
  const after = rows.filter((r) => r.date >= nineYear);
  ok(before.every((r) => r.cap === 240), "cap changed before the mark");
  ok(after.every((r) => r.cap === 320), "cap did not rise at the mark");
  ok(after.slice(1).every((r) => r.accrued === 8.0), "rate did not rise");
  // the step lands on the first period Sunday on or after the anniversary
  const firstGridSunday = rows.find((r) => r.date >= nineYear).date;
  eq(after[0].date, firstGridSunday, "first senior period Sunday");
  ok(before[before.length - 1].date < nineYear, "last junior row precedes it");
});

/* ---------------------------------------------------- cap and overdraw */

check("usage is subtracted before accrual, so leave frees cap headroom", () => {
  // seed just under the cap, then take 8 h inside one period
  const rows = project({ "2026-08-05": { b: 8, nr: 0, f: 0, label: "" } },
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
    "2026-07-27": { b: 8, nr: 0, f: 0, label: "" },   // day after the anchor
    "2026-08-07": { b: 8, nr: 0, f: 0, label: "" },   // Friday inside the window
  });
  eq(rowAt(rows, "2026-08-09").used, 16, "both days land in one window");
  eq(rowAt(rows, "2026-08-23").used, 0, "next window is clean");
});

check("PTOB may go negative and is flagged overdrawn", () => {
  const entries = {};
  for (const d of ["2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06",
                   "2026-08-07"]) entries[d] = { b: 8, nr: 0, f: 0, label: "" };
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
  const entries = { "2026-08-05": { b: 0, nr: 8, f: 0, label: "" } };
  const rows = project(entries, { birth, today: "2026-09-01" });
  eq(rowAt(rows, "2026-08-09").nrRemaining, 472, "pool after 8 h");
  ok(rows.every((r) => r.nrRemaining === null || r.nrRemaining >= 0),
     "parental remaining went negative");
});

/* ---------------------------------------------------- save rules */

const ANCHOR_SEED = {date: ANCHOR, balance: ANCHOR_BAL};
const save = (data, args) => {
  // there is no default balance any more, so every save fixture needs one
  const seeded = Object.assign({anchor: ANCHOR_SEED}, data || {});
  const e = loadEngine(seeded);
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
  const seeded = { birthDate: "2026-08-01", entries: {}, anchor: ANCHOR_SEED };
  const e = loadEngine(seeded);
  e.applyEntry({ dates: ["2026-08-19"], hours: 4, label: "half day", leaveType: "B" });
  e.applyEntry({ dates: ["2026-08-19"], hours: 4, label: "half day", leaveType: "NR" });
  const day = e.store.raw().entries["2026-08-19"];
  eq(day, { b: 4, nr: 4, f: 0, label: "half day" }, "day should carry both types");
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
  const e = loadEngine({ anchor: ANCHOR_SEED });
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

/* ------------------------------------------- first-run setup */
/* The shipped app crashed here: with no anchor the projection is empty and
   STATE.anchor is null, so the balance tile's click handler called
   parseISO(null) and threw before it could open.  The tile was the only way
   to set a starting balance, which made a fresh browser unusable. */

check("latestPeriodSunday lands on the 14-day grid", () => {
  const E = loadEngine(null);
  const s = E.latestPeriodSunday("2026-08-20");
  eq(s, "2026-08-09", "latest period Sunday");
  const diff = (E.parseISO(s) - E.parseISO("2026-07-26")) / 86400000;
  eq(diff % 14, 0, "offset from the original anchor");
});

check("latestPeriodSunday never returns a future Sunday", () => {
  const E = loadEngine(null);
  for (const day of ["2026-07-26", "2026-08-08", "2026-08-09", "2026-08-22"])
    ok(E.latestPeriodSunday(day) <= day, `${day} -> ${E.latestPeriodSunday(day)}`);
});

check("a fresh browser can still seed the balance tile", () => {
  const E = loadEngine(null);
  const st = E.buildState();
  ok(st.needsSetup, "expected setup mode");
  eq(st.anchor, null, "anchor");
  eq(st.projection.length, 0, "projection rows");
  // the seed expression editBalance uses; this is what used to throw
  const latest = [...st.projection].filter(r => r.date <= st.today).pop();
  const seed = latest ? latest.date
                      : (st.anchor || E.latestPeriodSunday(st.today));
  ok(typeof seed === "string" && seed, "seed date");
});

check("every Sunday the setup tile offers is a valid anchor", () => {
  const E = loadEngine(null);
  const st = E.buildState();
  const d = E.parseISO(E.latestPeriodSunday(st.today));
  for (let i = 0; i < 27; i++) {
    const when = E.iso(d);
    const out = E.applyAnchor({balance: 100, date: when});
    ok(out.ok, `applyAnchor rejected offered date ${when}: ${out.error}`);
    d.setUTCDate(d.getUTCDate() - 14);
  }
});

check("setting the balance from setup mode leaves setup mode", () => {
  const E = loadEngine(null);
  const when = E.latestPeriodSunday(E.buildState().today);
  ok(E.applyAnchor({balance: 123.5, date: when}).ok, "applyAnchor");
  const after = E.buildState();
  ok(!after.needsSetup, "still in setup mode after anchoring");
  near(after.anchorBalance, 123.5, "anchor balance");
  ok(after.projection.length > 0, "projection stayed empty");
});

/* ------------------------------------------- flex holiday (F) */
/* Two days a calendar year, forfeited if unused. It is a separate bucket --
   it must not touch the PTOB balance -- but it shares the 8 h/day ceiling. */

const flexEngine = () => loadEngine({
  entries: {}, holidays: {}, removedHolidays: [],
  anchor: {date: "2026-08-09", balance: 150}, hireDate: null, birthDate: null,
});

check("two flex days a year, and no more", () => {
  const E = flexEngine();
  const left = () => E.flexLeft(E.loadData().entries, 2026);
  eq(left(), 16, "pool at the start");
  ok(E.applyEntry({dates: ["2026-11-23"], hours: 8, label: "", leaveType: "F"}).ok, "first day");
  eq(left(), 8, "after one day");
  ok(E.applyEntry({dates: ["2026-11-24"], hours: 8, label: "", leaveType: "F"}).ok, "second day");
  eq(left(), 0, "after two days");
  const third = E.applyEntry({dates: ["2026-11-25"], hours: 8, label: "", leaveType: "F"});
  ok(!third.ok, "a third day was allowed");
  ok(/flex holiday is left/i.test(third.error), "unhelpful refusal: " + third.error);
});

check("the pool resets each calendar year and never carries over", () => {
  const E = flexEngine();
  E.applyEntry({dates: ["2026-11-23"], hours: 8, label: "", leaveType: "F"});
  eq(E.flexLeft(E.loadData().entries, 2026), 8, "2026 after one day");
  eq(E.flexLeft(E.loadData().entries, 2027), 16, "2027 starts full");
  ok(E.applyEntry({dates: ["2027-01-04"], hours: 8, label: "", leaveType: "F"}).ok, "2027 booking");
  eq(E.flexLeft(E.loadData().entries, 2027), 8, "2027 after one day");
  // an unused 2026 day must not appear in 2027
  eq(E.flexLeft(E.loadData().entries, 2026), 8, "2026 changed by a 2027 booking");
});

check("flex does not touch the PTOB balance", () => {
  const E = flexEngine();
  const before = E.buildState().projection.map(r => r.balance).join(",");
  ok(E.applyEntry({dates: ["2026-11-23"], hours: 8, label: "", leaveType: "F"}).ok, "booking");
  const after = E.buildState().projection.map(r => r.balance).join(",");
  eq(after, before, "the accrual walk moved");
});

check("flex shares the 8 h a day ceiling", () => {
  const E = flexEngine();
  E.applyEntry({dates: ["2026-11-23"], hours: 4, label: "half", leaveType: "B"});
  E.applyEntry({dates: ["2026-11-23"], hours: 8, label: "flex", leaveType: "F"});
  const day = E.loadData().entries["2026-11-23"];
  eq(day.b + day.f, 8, "the day holds more than 8 h: " + JSON.stringify(day));
  eq(day.f, 4, "flex was not clamped to the room left");
});

check("flex never lands on a weekend or a holiday", () => {
  const E = flexEngine();
  const sat = E.applyEntry({dates: ["2026-11-21"], hours: 8, label: "", leaveType: "F"});
  ok(!sat.ok, "booked a Saturday");
  ok(/weekend/i.test(sat.error), "wrong refusal: " + sat.error);
});

check("a flex day survives being written and read back", () => {
  const E = flexEngine();
  E.applyEntry({dates: ["2026-11-23"], hours: 8, label: "flex", leaveType: "F"});
  const day = E.loadData().entries["2026-11-23"];
  eq(day.f, 8, "f did not persist — check normalizeData");
  eq(day.b, 0, "PTOB was charged for a flex day");
});

/* ------------------------------------- reconstructed history */
/* The walk is forward-only from the anchor by design, so balances before it
   are inferred: invert the accrual, add back recorded leave. The inversion
   is exact only while the cap never bound -- past that, over-cap accrual was
   discarded and more than one history produces the same anchor. */

check("history re-walked forward reproduces the projection", () => {
  const E = loadEngine(null);
  const entries = {"2026-05-04": {b: 8, nr: 0, f: 0, label: "x"}};
  const hist = E.computeHistory(entries, "2026-08-09", 150, null, null, 24);
  ok(hist.length > 0, "no history produced");
  const rw = E.computeProjection(entries, "2026-10-09", hist[0].date,
                                 hist[0].balance, null, null);
  const proj = E.computeProjection(entries, "2026-10-09", "2026-08-09", 150,
                                   null, null);
  near(rw.find(r => r.date === "2026-08-09").balance, 150, "lands on the anchor");
  // Rows are stored rounded to 2dp, and the re-walk is re-seeded from one of
  // those rounded values, so a row can land either side of a rounding
  // boundary. A cent of an hour is the honest tolerance here; the app itself
  // never re-seeds, it draws history and projection from the same pair.
  for (const r of proj) {
    const m = rw.find(x => x.date === r.date);
    if (m && Math.abs(m.balance - r.balance) > 0.011)
      throw new Error(`drift at ${r.date}: ${m.balance} vs ${r.balance}`);
  }
});

check("leave recorded before the anchor raises the earlier balance", () => {
  const E = loadEngine(null);
  const week = {};
  for (const d of ["2026-06-15", "2026-06-16", "2026-06-17",
                   "2026-06-18", "2026-06-19"]) week[d] = {b: 8, nr: 0, f: 0, label: ""};
  const bare = E.computeHistory({}, "2026-08-09", 150, null, null, 6);
  const took = E.computeHistory(week, "2026-08-09", 150, null, null, 6);
  const at = (rows, d) => (rows.find(r => r.date === d) || {}).balance;
  ok(at(bare, "2026-06-14") !== undefined, "fixture Sunday missing");
  near(at(took, "2026-06-14") - at(bare, "2026-06-14"), 40,
       "40 h of recorded leave not reflected before the anchor");
  eq(took.find(r => r.date === "2026-06-28").used, 40, "the week posts on its Sunday");
});

check("history is flagged, ordered and never negative", () => {
  const E = loadEngine(null);
  const hist = E.computeHistory({}, "2026-08-09", 150, null, null, 24);
  ok(hist.every(r => r.reconstructed === true), "a row is not flagged");
  ok(hist.every(r => r.date < "2026-08-09"), "a row is not before the anchor");
  ok(hist.every((r, i) => i === 0 || r.date > hist[i - 1].date), "out of order");
  ok(hist.every(r => r.balance >= 0), "reconstructed a negative balance");
});

check("a deeper anchor supports more history than a shallow one", () => {
  const E = loadEngine(null);
  const deep = E.computeHistory({}, "2026-08-09", 150, null, null, 24);
  const shallow = E.computeHistory({}, "2026-08-09", 40, null, null, 24);
  ok(deep.length > shallow.length,
     `deep ${deep.length} vs shallow ${shallow.length}`);
});

check("no anchor means no history", () => {
  const E = loadEngine(null);
  eq(E.computeHistory({}, null, null, null, null, 24).length, 0, "rows");
  eq(E.computeHistory({}, "2026-08-09", NaN, null, null, 24).length, 0, "rows");
});

/* ---------------------------------------------------- report */

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("\nFAILURES:");
  for (const f of failures) console.log("  - " + f);
  process.exit(1);
}
