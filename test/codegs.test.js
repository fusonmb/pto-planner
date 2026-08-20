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

/* ------------------------------------------- Dashboard rendering */
/* writeDashboard_ had no coverage because it needs SpreadsheetApp, and it was
   broken: its header block mixed 1-wide and 3-wide rows, but setValues()
   demands a perfect rectangle, so writing a *populated* Dashboard always threw
   "The data has 1 but the range has 3".  This mock is the smallest surface
   that catches shape errors. */

function mockSheets() {
  const writes = [];
  const chain = new Proxy(function () {}, {
    get: () => chain,
    apply: () => chain,
  });
  const charts = [];
  const inserted = [];
  const removed = [];
  const chartCalls = { ranges: [], options: {}, position: null, type: null };
  const builder = {
    setChartType: (t) => { chartCalls.type = t; return builder; },
    addRange: (r) => { chartCalls.ranges.push(r); return builder; },
    setPosition: (...a) => { chartCalls.position = a; return builder; },
    setOption: (k, v) => { chartCalls.options[k] = v; return builder; },
    build: () => ({ __chart: true, calls: chartCalls }),
  };
  const sheet = {
    clear: () => sheet,
    setFrozenRows: () => sheet,
    autoResizeColumn: () => sheet,
    autoResizeColumns: () => sheet,
    getLastRow: () => 0,
    getLastColumn: () => 0,
    getMaxColumns: () => 26,
    newChart: () => builder,
    getCharts: () => charts.slice(),
    insertChart: (c) => { inserted.push(c); charts.push(c); },
    removeChart: (c) => { removed.push(c); const i = charts.indexOf(c);
                          if (i >= 0) charts.splice(i, 1); },
    getRange: (row, col, nRows, nCols) => ({
      __geom: { row, col, nRows: nRows || 1, nCols: nCols || 1 },
      setValues: (data) => {
        writes.push({ row, col, nRows: nRows || 1, nCols: nCols || 1, data });
        return chain;
      },
      setValue: () => chain,
      setFontSize: () => chain, setFontWeight: () => chain,
      setFontColor: () => chain, setBackground: () => chain,
      setNumberFormat: () => chain, setHorizontalAlignment: () => chain,
      setWrap: () => chain, setBorder: () => chain,
      clearDataValidations: () => chain, setDataValidation: () => chain,
    }),
  };
  global.SpreadsheetApp = {
    getActive: () => ({ getSheetByName: () => sheet, getSheets: () => [sheet] }),
  };
  global.Charts = { ChartType: { LINE: "LINE", COLUMN: "COLUMN" } };
  writes.charts = { inserted, removed, calls: chartCalls, live: charts };
  return writes;
}

function assertRectangular(writes) {
  writes.forEach((w, i) => {
    if (!Array.isArray(w.data))
      throw new Error(`write ${i}: data is not an array`);
    if (w.data.length !== w.nRows)
      throw new Error(`write ${i}: ${w.data.length} rows into a range of ${w.nRows}`);
    w.data.forEach((row, r) => {
      if (!Array.isArray(row))
        throw new Error(`write ${i} row ${r}: not an array`);
      if (row.length !== w.nCols)
        throw new Error(`write ${i} row ${r}: data has ${row.length} `
                        + `but the range has ${w.nCols}`);
    });
  });
}

check("a populated Dashboard writes only rectangles", () => {
  const writes = mockSheets();
  const rows = gas.computeProjection_(
      { "2026-08-19": DAY(8, 0, "dentist") },
      "2026-08-20", "2026-08-09", 142.69, "2018-11-13", "2026-08-14");
  if (!rows.length) throw new Error("fixture produced no rows");
  gas.writeDashboard_(rows, {
    displayName: "Leave Planner", childBirthDate: "2026-08-14",
  }, "2026-08-20");
  if (!writes.length) throw new Error("nothing was written");
  assertRectangular(writes);
});

check("an empty Dashboard writes only rectangles", () => {
  const writes = mockSheets();
  gas.writeDashboard_([], { displayName: "Leave Planner" }, "2026-08-20");
  if (!writes.length) throw new Error("nothing was written");
  assertRectangular(writes);
});

check("the Dashboard reports the balance as of today, not the anchor", () => {
  const writes = mockSheets();
  const rows = gas.computeProjection_({}, "2026-08-20", "2026-08-09", 142.69,
                                      "2018-11-13", null);
  gas.writeDashboard_(rows, { displayName: "Leave Planner" }, "2026-08-20");
  const head = writes[0].data;
  const line = head.find(r => r[0] === "Current PTOB");
  if (!line) throw new Error("no Current PTOB line");
  if (line[2] !== "as of 2026-08-09")
    throw new Error(`expected the 2026-08-09 row, got "${line[2]}"`);
});

/* ------------------------------------------------ Dashboard chart */

check("a populated Dashboard gets exactly one chart", () => {
  const writes = mockSheets();
  const rows = gas.computeProjection_({}, "2026-08-20", "2026-08-09", 142.69,
                                      "2018-11-13", "2026-08-14");
  gas.writeDashboard_(rows, { displayName: "Leave Planner",
                              childBirthDate: "2026-08-14" }, "2026-08-20");
  const c = writes.charts;
  if (c.inserted.length !== 1)
    throw new Error(`inserted ${c.inserted.length} charts, want 1`);
  if (c.calls.type !== "LINE")
    throw new Error(`chart type ${c.calls.type}`);
});

check("refreshing does not stack charts", () => {
  const writes = mockSheets();
  const rows = gas.computeProjection_({}, "2026-08-20", "2026-08-09", 142.69,
                                      null, null);
  const cfg = { displayName: "Leave Planner" };
  gas.writeDashboard_(rows, cfg, "2026-08-20");
  gas.writeDashboard_(rows, cfg, "2026-08-20");
  gas.writeDashboard_(rows, cfg, "2026-08-20");
  const c = writes.charts;
  if (c.live.length !== 1)
    throw new Error(`${c.live.length} charts left on the sheet after 3 refreshes`);
  if (c.removed.length !== 2)
    throw new Error(`removed ${c.removed.length}, expected 2`);
});

check("the chart plots the balance, cap and parental columns", () => {
  const writes = mockSheets();
  const rows = gas.computeProjection_({}, "2026-08-20", "2026-08-09", 142.69,
                                      null, "2026-08-14");
  gas.writeDashboard_(rows, { displayName: "Leave Planner",
                              childBirthDate: "2026-08-14" }, "2026-08-20");
  const g = writes.charts.calls.ranges.map(r => r.__geom);
  if (g.length !== 3)
    throw new Error(`${g.length} ranges, expected date + balance/cap + parental`);
  if (g[0].col !== 1 || g[0].nCols !== 1)
    throw new Error(`domain range is col ${g[0].col} x${g[0].nCols}, want col 1 x1`);
  if (g[1].col !== 5 || g[1].nCols !== 2)
    throw new Error(`series range is col ${g[1].col} x${g[1].nCols}, want col 5 x2`);
  if (g[2].col !== 8 || g[2].nCols !== 1)
    throw new Error(`parental range is col ${g[2].col} x${g[2].nCols}, want col 8 x1`);
  const rowsWanted = rows.length + 1;      // body + header
  g.forEach((x, i) => {
    if (x.nRows !== rowsWanted)
      throw new Error(`range ${i} covers ${x.nRows} rows, want ${rowsWanted}`);
  });
});

check("no birth date means no parental series", () => {
  const writes = mockSheets();
  const rows = gas.computeProjection_({}, "2026-08-20", "2026-08-09", 142.69,
                                      null, null);
  gas.writeDashboard_(rows, { displayName: "Leave Planner" }, "2026-08-20");
  const c = writes.charts.calls;
  if (c.ranges.length !== 2)
    throw new Error(`${c.ranges.length} ranges, expected 2 without parental`);
  if (c.options.series[2])
    throw new Error("a parental series was styled with no birth date");
});

check("the chart is anchored clear of the table", () => {
  const writes = mockSheets();
  const rows = gas.computeProjection_({}, "2026-08-20", "2026-08-09", 142.69,
                                      null, null);
  gas.writeDashboard_(rows, { displayName: "Leave Planner" }, "2026-08-20");
  const pos = writes.charts.calls.position;
  if (!pos) throw new Error("no position set");
  if (pos[1] <= 8)
    throw new Error(`chart anchored at column ${pos[1]}, which overlaps the 8-column table`);
});

check("an unconfigured Dashboard carries no chart", () => {
  const writes = mockSheets();
  gas.writeDashboard_([], { displayName: "Leave Planner" }, "2026-08-20");
  if (writes.charts.inserted.length !== 0)
    throw new Error("charted an empty projection");
});

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("\nFAILURES:");
  for (const f of failures) console.log("  - " + f);
  process.exit(1);
}
