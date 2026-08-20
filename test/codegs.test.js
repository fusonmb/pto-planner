/* The accrual walk now exists twice: in index.html (authoritative) and in
   apps-script/Code.gs (so the Sheet's Dashboard can show balances).  The
   handoff flagged that these will drift.  This is the test that catches it.
   Run: node test/codegs.test.js                                        */
"use strict";
const fs = require("fs");
const path = require("path");
const { loadEngine } = require("./engine.js");
const gas = require("../apps-script/Code.gs");

let pass = 0;
const failures = [];
const check = (name, fn) => {
  try { fn(); pass++; }
  catch (err) { failures.push(`${name}\n    ${err.message}`); }
};

const app = loadEngine(null);
const DAY = (b, nr, label) => ({ b, nr, label });

/* Every scenario is run through both engines and compared row for row. */
const SCENARIOS = [
  { name: "empty plan", entries: {}, birth: null },
  { name: "PTOB only", birth: null, entries: {
      "2026-08-19": DAY(8, 0, "dentist"),
      "2026-11-27": DAY(8, 0, "long weekend") } },
  { name: "at the cap", balance: 238, birth: null, entries: {} },
  { name: "usage frees cap headroom", balance: 238, birth: null, entries: {
      "2026-08-05": DAY(8, 0, "") } },
  { name: "overdrawn", balance: 4, birth: null, entries: {
      "2026-08-03": DAY(8, 0, ""), "2026-08-04": DAY(8, 0, ""),
      "2026-08-05": DAY(8, 0, "") } },
  { name: "parental in play", birth: "2026-08-17", entries: {
      "2026-08-19": DAY(8, 0, "dentist"),
      "2026-08-20": DAY(4, 4, "half day"),
      "2026-09-08": DAY(0, 8, "parental"),
      "2026-09-09": DAY(0, 8, "parental") } },
  { name: "across the nine-year step-up", today: "2028-03-01", birth: null,
    entries: { "2027-11-15": DAY(8, 0, "after the step-up") } },
  { name: "parental expiry boundary", today: "2027-10-01",
    birth: "2026-08-01", entries: { "2026-08-05": DAY(0, 8, "") } },
  { name: "re-anchored mid-stream", anchor: "2026-08-23", balance: 149.46,
    birth: null, entries: { "2026-09-04": DAY(8, 0, "") } },
];

const DEF = { today: "2026-08-19", anchor: "2026-07-26", balance: 100.00,
              hire: "2018-10-05" };

for (const sc of SCENARIOS) {
  check(`engines agree: ${sc.name}`, () => {
    const o = Object.assign({}, DEF, sc);
    const a = app.computeProjection(sc.entries, o.today, o.anchor, o.balance,
                                    o.hire, o.birth);
    const b = gas.computeProjection_(sc.entries, o.today, o.anchor, o.balance,
                                     o.hire, o.birth);
    if (a.length !== b.length)
      throw new Error(`row count: app ${a.length}, Code.gs ${b.length}`);
    for (let i = 0; i < a.length; i++) {
      const x = JSON.stringify(a[i]), y = JSON.stringify(b[i]);
      if (x !== y)
        throw new Error(`row ${i} (${a[i].date}) differs:\n`
                        + `      app     ${x}\n      Code.gs ${y}`);
    }
  });
}

check("Code.gs reproduces the golden fixture exactly", () => {
  const FIX = path.join(__dirname, "fixtures", "projection.json");
  const rows = gas.computeProjection_({
    "2026-08-19": DAY(8, 0, "dentist"),
    "2026-08-20": DAY(4, 4, "half day"),
    "2026-09-08": DAY(0, 8, "parental"),
    "2026-09-09": DAY(0, 8, "parental"),
    "2026-11-27": DAY(8, 0, "long weekend"),
    "2027-01-04": DAY(8, 0, "new year"),
    "2027-11-15": DAY(8, 0, "after the step-up"),
  }, "2026-08-19", "2026-07-26", 100.00, "2018-10-05", "2026-08-17");
  const actual = JSON.stringify(rows, null, 2) + "\n";
  const want = fs.readFileSync(FIX, "utf8");
  if (actual !== want) {
    const a = actual.split("\n"), b = want.split("\n");
    const i = a.findIndex((l, k) => l !== b[k]);
    throw new Error(`Code.gs drifted from the app at line ${i + 1}:\n`
                    + `      Code.gs ${a[i]}\n      app     ${b[i]}`);
  }
});

check("shared date helpers agree", () => {
  for (const [d, n] of [["2028-02-29", 1], ["2026-08-01", 1],
                        ["2018-10-05", 9], ["2024-02-29", 4]]) {
    const x = app.addYearsIso(d, n), y = gas.addYearsIso_(d, n);
    if (x !== y) throw new Error(`addYears(${d},${n}): app ${x}, Code.gs ${y}`);
  }
  for (const d of ["2026-08-22", "2026-08-23", "2026-08-19", "2026-07-26"]) {
    const x = app.isWeekend(d), y = gas.isWeekend_(d);
    if (x !== y) throw new Error(`isWeekend(${d}): app ${x}, Code.gs ${y}`);
  }
});

check("Code.gs does no local-time date construction", () => {
  // the classic Apps Script bug: new Date(y, m, d) is the Sheet's timezone
  const src = fs.readFileSync(
    path.join(__dirname, "..", "apps-script", "Code.gs"), "utf8");
  const bad = src.split("\n")
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => /new Date\([^)]*,/.test(l) && !/Date\.UTC/.test(l));
  if (bad.length)
    throw new Error("local-time Date construction at line(s) "
                    + bad.map(([n]) => n).join(", "));
});

check("registry rules fall back to the app's hardcoded values", () => {
  const r = gas.rulesFromTypes_([
    { key: "PTOB", model: "biweekly", rate: 6.7692, rateAfter: 8.0,
      stepYears: 9, cap: 240, capAfter: 320, active: true },
    { key: "Parental", model: "grant", grantHours: 480, active: true },
  ]);
  const d = gas.defaultRules_();
  if (JSON.stringify(r) !== JSON.stringify(d))
    throw new Error(`registry rules ${JSON.stringify(r)} != defaults ${JSON.stringify(d)}`);
});

/* ------------------------------------------- unconfigured Sheet */
/* setup() ends by calling refresh(), which ran the date helpers over the
   blank Config cells it had just written: isoOf_(parseIso_("")) throws
   RangeError, so setup() died on a brand-new Sheet and writeDashboard_
   then indexed rows[0] of an empty projection. */

check("a blank hire date does not throw", () => {
  const hire = "" ? gas.isoOf_(gas.parseIso_("")) : null;
  if (hire !== null) throw new Error(`expected null, got ${hire}`);
  // and the raw helper still throws, which is why refresh() must guard it
  let threw = false;
  try { gas.isoOf_(gas.parseIso_("")); } catch (e) { threw = true; }
  if (!threw) throw new Error("parseIso_('') unexpectedly became valid");
});

check("an unconfigured Sheet projects nothing, in both engines", () => {
  const g = gas.computeProjection_({}, "2026-08-20", null, NaN, null, null);
  const a = app.computeProjection({}, "2026-08-20", null, NaN, null, null);
  if (g.length !== 0 || a.length !== 0)
    throw new Error(`expected no rows, got Code.gs=${g.length} app=${a.length}`);
});

check("an anchor date with no balance is ignored, not seeded at zero", () => {
  const g = gas.computeProjection_({}, "2026-08-20", "2026-07-26", NaN, null, null);
  if (g.length !== 0)
    throw new Error(`projected ${g.length} rows from a missing balance`);
});

check("no hire date means the step-up never applies", () => {
  const g = gas.computeProjection_({}, "2028-06-01", "2026-07-26", 135.92, null, null);
  const a = app.computeProjection({}, "2028-06-01", "2026-07-26", 135.92, null, null);
  if (!g.length) throw new Error("expected rows");
  if (g.length !== a.length)
    throw new Error(`row count ${g.length} != ${a.length}`);
  for (let i = 0; i < g.length; i++) {
    if (g[i].cap !== a[i].cap)
      throw new Error(`row ${i} cap ${g[i].cap} != ${a[i].cap}`);
    if (Math.abs(g[i].balance - a[i].balance) > 1e-9)
      throw new Error(`row ${i} balance ${g[i].balance} != ${a[i].balance}`);
  }
  if (g.some(r => r.cap !== 240))
    throw new Error("cap stepped up without a hire date");
});

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("\nFAILURES:");
  for (const f of failures) console.log("  - " + f);
  process.exit(1);
}
