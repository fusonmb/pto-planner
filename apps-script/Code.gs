/**
 * Leave Planner — Apps Script for the backing Google Sheet.
 *
 * The web app (index.html) owns the leave data and is authoritative.  This
 * script exists so the Sheet is useful on its own: it builds the tabs, keeps
 * them validated and readable, and refreshes a Dashboard of computed
 * balances.
 *
 * Sheets API writes do NOT fire onEdit, so when the web app saves, nothing
 * here runs.  The Dashboard therefore refreshes on open and once daily, and
 * is a mirror rather than a source of truth.  Everything a human may edit by
 * hand lives on the Leave / Config / Holidays tabs, which the app reads back.
 *
 * The accrual walk below is a deliberate line-for-line port of
 * computeProjection() in index.html.  test/codegs.test.js asserts the two
 * produce identical output for a fixture plan; keep them in step.
 *
 * Setup: run setup() once from the Apps Script editor.
 */

/* eslint no-unused-vars: 0 */

// ============================================================
// Constants
// ============================================================

var TABS = {
  config: 'Config',
  types: 'LeaveTypes',
  leave: 'Leave',
  holidays: 'Holidays',
  dashboard: 'Dashboard',
};

var PERIOD_DAYS = 14;
var PROJECTION_MONTHS = 36;

// Fixed columns on the Leave tab.  Everything between Date and Label is one
// column per active leave type, in LeaveTypes order.
var LEAVE_FIXED_HEAD = ['Date'];
var LEAVE_FIXED_TAIL = ['Label', 'Updated'];

var THEME = {
  header: '#1f2933',
  headerText: '#f5f7fa',
  band: '#f4f6f8',
  ptob: '#2f9e5f',
  parental: '#e05b8a',
  muted: '#6b7785',
};

var CONFIG_DEFAULTS = [
  ['displayName',    'Leave Planner', 'Shown on the Dashboard'],
  ['hireDate',       '',              'Your hire date — drives the nine-year step-up'],
  ['anchorSunday',   '2026-07-26',    'A pay-period posting Sunday'],
  ['anchorBalance',  '',              'Your known PTOB balance ON anchorSunday'],
  ['childBirthDate', '',              'Blank disables parental leave'],
  ['hoursPerDay',    '8',             'Display only: hours per leave day'],
  ['maxDayHours',    '8',             'Max combined hours on any one day'],
  ['timezone',       'America/New_York', 'Used for date display only'],
];

var TYPE_HEADERS = ['Key', 'Label', 'Color', 'Model', 'Rate', 'RateAfter',
                    'StepYears', 'Cap', 'CapAfter', 'GrantHours',
                    'ExpiresMonths', 'WholeHoursOnly', 'Active'];

var TYPE_DEFAULTS = [
  ['PTOB', 'PTOB', THEME.ptob, 'biweekly', 6.7692, 8.0, 9, 240, 320, '', '', false, true],
  ['Parental', 'Parental', THEME.parental, 'grant', '', '', '', '', '', 480, 12, true, true],
];

// ============================================================
// Date helpers — UTC ONLY
//
// Apps Script runs in the Sheet's timezone; the web app does every date
// calculation in UTC.  Mixing the two shifts period Sundays by a day at
// boundaries, so nothing here may use local-time Date construction.
// ============================================================

function parseIso_(s) {
  if (s instanceof Date) {
    // a Date read out of a cell is midnight in the Sheet's timezone
    return new Date(Date.UTC(s.getFullYear(), s.getMonth(), s.getDate()));
  }
  var p = String(s).slice(0, 10).split('-');
  return new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2])));
}

function isoOf_(d) {
  return d.toISOString().slice(0, 10);
}

function addDays_(d, n) {
  var out = new Date(d.getTime());
  out.setUTCDate(out.getUTCDate() + n);
  return out;
}

function addMonths_(d, n) {
  var out = new Date(d.getTime());
  out.setUTCMonth(out.getUTCMonth() + n);
  return out;
}

/** iso + n years, clamping Feb 29 back to Feb 28 — matches addYearsIso(). */
function addYearsIso_(isoStr, n) {
  var d = parseIso_(isoStr);
  var m = d.getUTCMonth();
  d.setUTCFullYear(d.getUTCFullYear() + n);
  if (d.getUTCMonth() !== m) d.setUTCDate(0);
  return isoOf_(d);
}

function isWeekend_(isoStr) {
  var dow = parseIso_(isoStr).getUTCDay();
  return dow === 0 || dow === 6;
}

var r2_ = function (v) { return Math.round(v * 100) / 100; };

// ============================================================
// The accrual walk — pure, no SpreadsheetApp
// ============================================================

/**
 * Balance at every period Sunday from the anchor out to the horizon.
 *
 * Port of computeProjection() in index.html.  Per period, in this order:
 * usage in the 14-day window ending on the Sunday is subtracted, the accrual
 * is added, then the cap is applied — so leave taken in a period frees cap
 * headroom for that same period's accrual.
 *
 * @param {Object} entries  {iso: {b: hours, nr: hours, label: string}}
 * @param {string} todayIso horizon is this + PROJECTION_MONTHS
 * @param {string} anchorIso a period Sunday
 * @param {number} anchorBal the KNOWN balance on anchorIso — the walk is
 *     seeded with it and never runs before it
 * @return {Array<Object>} one row per period Sunday, anchor row first
 */
function computeProjection_(entries, todayIso, anchorIso, anchorBal, hireIso,
                            birthIso, rules) {
  rules = rules || defaultRules_();
  if (!anchorIso || !isFinite(anchorBal)) return [];   // not configured yet
  // with no hire date the step-up cannot be dated, so it never applies
  var nineYears = hireIso ? addYearsIso_(hireIso, rules.stepYears) : null;
  var expiry = birthIso ? addYearsIso_(birthIso, 1) : null;

  function nrRem(asOf) {
    if (!birthIso || asOf < birthIso) return null;
    if (asOf >= expiry) return 0;
    var used = 0;
    for (var d in entries) {
      if (d >= birthIso && d <= asOf) used += entries[d].nr || 0;
    }
    return r2_(Math.max(0, rules.parentalTotal - used));
  }

  var rows = [{
    date: anchorIso, used: 0, accrued: 0, lost: 0,
    balance: anchorBal,
    cap: nineYears && anchorIso >= nineYears ? rules.capAfter : rules.capBase,
    nrUsed: 0, nrRemaining: nrRem(anchorIso),
    overdrawn: false,
  }];

  var balance = anchorBal;
  var end = addMonths_(parseIso_(todayIso), PROJECTION_MONTHS);
  var sunday = addDays_(parseIso_(anchorIso), PERIOD_DAYS);

  while (sunday <= end) {
    var s1 = isoOf_(sunday);
    var senior = !!nineYears && s1 >= nineYears;
    var rate = senior ? rules.rateAfter : rules.rateBase;
    var cap = senior ? rules.capAfter : rules.capBase;
    var s0 = isoOf_(addDays_(sunday, -(PERIOD_DAYS - 1)));

    var used = 0, nrUsed = 0;
    for (var d2 in entries) {
      if (d2 >= s0 && d2 <= s1) {
        used += entries[d2].b || 0;
        nrUsed += entries[d2].nr || 0;
      }
    }
    used = r2_(used);
    nrUsed = r2_(nrUsed);

    var afterUse = balance - used;
    var preCap = afterUse + rate;
    var lost = Math.max(0, preCap - cap);
    balance = Math.min(preCap, cap);

    rows.push({
      date: s1, used: used, accrued: rate, lost: r2_(lost),
      balance: r2_(balance), cap: cap,
      nrUsed: nrUsed, nrRemaining: nrRem(s1),
      overdrawn: afterUse < 0 || balance < 0,
    });
    sunday = addDays_(sunday, PERIOD_DAYS);
  }
  return rows;
}

/** Accrual parameters as the app hardcodes them; overridden from LeaveTypes. */
function defaultRules_() {
  return {
    rateBase: 6.7692, rateAfter: 8.0,
    capBase: 240, capAfter: 320,
    stepYears: 9, parentalTotal: 480,
  };
}

/** Build the rules object from the LeaveTypes registry. */
function rulesFromTypes_(types) {
  var rules = defaultRules_();
  for (var i = 0; i < types.length; i++) {
    var t = types[i];
    if (!t.active) continue;
    if (t.model === 'biweekly') {
      rules.rateBase = Number(t.rate) || rules.rateBase;
      rules.rateAfter = Number(t.rateAfter) || rules.rateAfter;
      rules.capBase = Number(t.cap) || rules.capBase;
      rules.capAfter = Number(t.capAfter) || rules.capAfter;
      rules.stepYears = Number(t.stepYears) || rules.stepYears;
    } else if (t.model === 'grant') {
      rules.parentalTotal = Number(t.grantHours) || rules.parentalTotal;
    }
  }
  return rules;
}


// ============================================================
// Reading the Sheet
// ============================================================

function ss_() { return SpreadsheetApp.getActive(); }

function sheet_(name) {
  var sh = ss_().getSheetByName(name);
  if (!sh) throw new Error('Missing tab "' + name + '" — run setup().');
  return sh;
}

/** All non-empty rows of a tab, as arrays, excluding the header row. */
function rows_(sh) {
  var last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, sh.getLastColumn()).getValues()
           .filter(function (r) { return String(r[0]).trim() !== ''; });
}

function readConfig_() {
  var cfg = {};
  rows_(sheet_(TABS.config)).forEach(function (r) {
    cfg[String(r[0]).trim()] = r[1];
  });
  return cfg;
}

function readTypes_() {
  return rows_(sheet_(TABS.types)).map(function (r) {
    return {
      key: String(r[0]).trim(), label: String(r[1]).trim(), color: r[2],
      model: String(r[3]).trim(), rate: r[4], rateAfter: r[5],
      stepYears: r[6], cap: r[7], capAfter: r[8], grantHours: r[9],
      expiresMonths: r[10], wholeHoursOnly: r[11] === true,
      active: r[12] === true,
    };
  });
}

function activeTypes_(types) {
  return types.filter(function (t) { return t.active && t.key; });
}

/**
 * Which entry field a leave type feeds.  The accrual walk understands two:
 * `b` (the accruing balance) and `nr` (the granted pool).  Types with model
 * 'none' are recorded but do not affect any balance.
 */
function fieldOf_(type) {
  if (type.model === 'biweekly') return 'b';
  if (type.model === 'grant') return 'nr';
  return null;
}

/** Leave tab column layout for the current registry. */
function leaveHeaders_(types) {
  return LEAVE_FIXED_HEAD
    .concat(activeTypes_(types).map(function (t) { return t.label || t.key; }))
    .concat(LEAVE_FIXED_TAIL);
}

/**
 * The Leave tab as {iso: {b, nr, label}} — the shape the walk and the web app
 * both use.  One row per day, so the shared per-day label has exactly one
 * home and the combined-hours limit is checkable within a single row.
 */
function readLeave_(types) {
  var act = activeTypes_(types);
  var out = {};
  rows_(sheet_(TABS.leave)).forEach(function (r) {
    var iso = isoOf_(parseIso_(r[0]));
    var day = out[iso] || { b: 0, nr: 0, label: '' };
    for (var i = 0; i < act.length; i++) {
      var f = fieldOf_(act[i]);
      var h = Number(r[1 + i]) || 0;
      if (f && h) day[f] = r2_((day[f] || 0) + h);
    }
    var label = r[1 + act.length];
    if (label) day.label = String(label).slice(0, 80);
    out[iso] = day;
  });
  return out;
}

/**
 * Holiday map from the Holidays tab.  Source 'removed' tombstones a built-in
 * the user deleted — dropping that column would make built-ins undeletable,
 * which is the removedHolidays mechanism the web app already relies on.
 */
function readHolidays_() {
  var out = {};
  rows_(sheet_(TABS.holidays)).forEach(function (r) {
    var iso = isoOf_(parseIso_(r[0]));
    var source = String(r[2] || 'custom').trim().toLowerCase();
    if (source === 'removed') delete out[iso];
    else out[iso] = String(r[1] || 'Holiday');
  });
  return out;
}

// ============================================================
// Dashboard
// ============================================================

function refresh() {
  var cfg = readConfig_();
  var types = readTypes_();
  var entries = readLeave_(types);
  var rules = rulesFromTypes_(types);

  // Blank Config cells are the normal first-run state, not an error.  An
  // anchor date with no balance is ignored rather than seeded at zero: a
  // confident projection from a made-up 0 is worse than no projection.
  var anchorIso = cfg.anchorSunday ? isoOf_(parseIso_(cfg.anchorSunday)) : null;
  var anchorBal = (cfg.anchorBalance === '' || cfg.anchorBalance === null ||
                   cfg.anchorBalance === undefined)
                  ? NaN : Number(cfg.anchorBalance);
  var hireIso = cfg.hireDate ? isoOf_(parseIso_(cfg.hireDate)) : null;
  var birthIso = cfg.childBirthDate ? isoOf_(parseIso_(cfg.childBirthDate)) : null;
  var todayIso = isoOf_(new Date());

  var rows = computeProjection_(entries, todayIso, anchorIso, anchorBal,
                                hireIso, birthIso, rules);
  writeDashboard_(rows, cfg, todayIso);
  return rows.length;
}

/** Regenerate every tab's layout after the registry changes, keeping data. */
function rebuild() {
  var types = readTypes_();
  reheadLeave_(types);
  refresh();
}

function writeDashboard_(rows, cfg, todayIso) {
  var sh = sheet_(TABS.dashboard);
  sh.clear();

  // Nothing to project yet.  Say so plainly instead of dying on rows[0].
  if (!rows.length) {
    sh.getRange(1, 1, 4, 1).setValues([
      [String(cfg.displayName || 'Leave Planner')],
      ['Not set up yet.'],
      ['Enter your PTOB balance in the Config tab as anchorBalance — the '
       + 'balance you had on the anchorSunday date above it.'],
      ['Then run Leave Planner \u2192 Refresh balances from the menu.'],
    ]);
    sh.getRange(1, 1).setFontSize(14).setFontWeight('bold');
    sh.getRange(2, 1).setFontWeight('bold');
    sh.getRange(3, 1, 2, 1).setFontColor(THEME.muted);
    autosize_(sh, 1);
    return;
  }

  // current = the last period Sunday on or before today
  var current = rows[0];
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].date <= todayIso) current = rows[i];
  }

  // setValues demands a perfect rectangle: every row must be exactly as wide
  // as the range, so the text-only rows carry two trailing blanks.
  var head = [
    [String(cfg.displayName || 'Leave Planner'), '', ''],
    ['Balances are computed by the planner app; this tab is a read-only mirror.', '', ''],
    ['Refreshed ' + todayIso + ' — reopen the Sheet or run refresh() to update.', '', ''],
    ['', '', ''],
    ['Current PTOB', current.balance, 'as of ' + current.date],
    ['Cap', current.cap, ''],
    ['Parental remaining',
     current.nrRemaining === null ? 'n/a' : current.nrRemaining,
     cfg.childBirthDate ? 'expires ' + addYearsIso_(isoOf_(parseIso_(cfg.childBirthDate)), 1) : 'no birth date set'],
    ['', '', ''],
  ];
  sh.getRange(1, 1, head.length, 3).setValues(head);
  sh.getRange(1, 1).setFontSize(14).setFontWeight('bold');
  sh.getRange(2, 1, 2, 1).setFontColor(THEME.muted).setFontSize(9);
  sh.getRange(5, 1, 3, 1).setFontWeight('bold');

  var top = head.length + 1;
  var cols = ['Period Sunday', 'PTOB used', 'Accrued', 'Lost to cap',
              'PTOB balance', 'Cap', 'Parental used', 'Parental left'];
  sh.getRange(top, 1, 1, cols.length).setValues([cols]);
  styleHeader_(sh, top, cols.length);

  var body = rows.map(function (r) {
    return [r.date, r.used, r.accrued, r.lost, r.balance, r.cap,
            r.nrUsed, r.nrRemaining === null ? '' : r.nrRemaining];
  });
  if (body.length) {
    sh.getRange(top + 1, 1, body.length, cols.length).setValues(body);
    // flag overdrawn periods the same way the app does
    for (var j = 0; j < rows.length; j++) {
      if (rows[j].overdrawn) {
        sh.getRange(top + 1 + j, 1, 1, cols.length).setFontColor('#c0392b');
      }
    }
    sh.getRange(top + 1, 2, body.length, 7).setNumberFormat('0.00');
  }
  sh.setFrozenRows(top);
  autosize_(sh, cols.length);
}

// ============================================================
// Setup
// ============================================================

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Leave Planner')
    .addItem('Refresh balances', 'refresh')
    .addItem('Rebuild layout', 'rebuild')
    .addToUi();
  try { refresh(); } catch (e) { /* first open, before setup() */ }
}

/** Run once from the Apps Script editor. */
function setup() {
  ensureSheet_(TABS.config);
  ensureSheet_(TABS.types);
  ensureSheet_(TABS.leave);
  ensureSheet_(TABS.holidays);
  ensureSheet_(TABS.dashboard);

  buildConfig_();
  buildLeaveTypes_();
  reheadLeave_(readTypes_());
  buildHolidays_();
  installTrigger();
  refresh();
  return 'setup complete';
}

function buildConfig_() {
  var sh = sheet_(TABS.config);
  if (sh.getLastRow() > 1) return;          // never clobber existing config
  sh.clear();
  sh.getRange(1, 1, 1, 3).setValues([['Key', 'Value', 'Notes']]);
  sh.getRange(2, 1, CONFIG_DEFAULTS.length, 3).setValues(CONFIG_DEFAULTS);
  styleHeader_(sh, 1, 3);
  sh.setFrozenRows(1);
  sh.getRange(2, 3, CONFIG_DEFAULTS.length, 1).setFontColor(THEME.muted);
  autosize_(sh, 3);
}

function buildLeaveTypes_() {
  var sh = sheet_(TABS.types);
  if (sh.getLastRow() > 1) return;
  sh.clear();
  sh.getRange(1, 1, 1, TYPE_HEADERS.length).setValues([TYPE_HEADERS]);
  sh.getRange(2, 1, TYPE_DEFAULTS.length, TYPE_HEADERS.length)
    .setValues(TYPE_DEFAULTS);
  styleHeader_(sh, 1, TYPE_HEADERS.length);
  sh.setFrozenRows(1);

  var models = SpreadsheetApp.newDataValidation()
    .requireValueInList(['biweekly', 'grant', 'none'], true)
    .setAllowInvalid(false).build();
  sh.getRange(2, 4, 200, 1).setDataValidation(models);
  var bool = SpreadsheetApp.newDataValidation().requireCheckbox().build();
  sh.getRange(2, 12, 200, 2).setDataValidation(bool);
  autosize_(sh, TYPE_HEADERS.length);
}

/**
 * Write the Leave tab header for the current registry, preserving any data
 * already under columns that survive.  Adding a leave type is a row in
 * LeaveTypes plus this call — no deploy.
 */
function reheadLeave_(types) {
  var sh = sheet_(TABS.leave);
  var want = leaveHeaders_(types);
  var lastCol = Math.max(sh.getLastColumn(), want.length);
  var have = sh.getLastRow() >= 1
    ? sh.getRange(1, 1, 1, lastCol).getValues()[0] : [];

  if (sh.getLastRow() > 1 && have.length) {
    // re-order existing columns to match the new header rather than
    // overwriting in place, which would silently mis-file hours
    var data = rows_(sh);
    var moved = data.map(function (r) {
      return want.map(function (h) {
        var at = have.indexOf(h);
        return at >= 0 ? r[at] : '';
      });
    });
    sh.clear();
    sh.getRange(1, 1, 1, want.length).setValues([want]);
    if (moved.length) {
      sh.getRange(2, 1, moved.length, want.length).setValues(moved);
    }
  } else {
    sh.clear();
    sh.getRange(1, 1, 1, want.length).setValues([want]);
  }

  styleHeader_(sh, 1, want.length);
  sh.setFrozenRows(1);

  var act = activeTypes_(types);
  var maxDay = Number(readConfig_().maxDayHours) || 8;
  var hours = SpreadsheetApp.newDataValidation()
    .requireNumberBetween(0, maxDay)
    .setHelpText('0 to ' + maxDay + ' hours.')
    .setAllowInvalid(false).build();
  if (act.length) {
    sh.getRange(2, 2, 2000, act.length).setDataValidation(hours)
      .setNumberFormat('0.00');
    // colour each type's column to match the app
    for (var i = 0; i < act.length; i++) {
      sh.getRange(1, 2 + i).setBackground(act[i].color || THEME.header);
    }
  }
  sh.getRange(2, 1, 2000, 1).setNumberFormat('yyyy-mm-dd');
  flagBadRows_(sh, act.length, maxDay);
  autosize_(sh, want.length);
}

/**
 * Conditional formatting so a hand-edit that breaks an invariant is visible
 * in the Sheet, including on mobile where the app's own validation is absent.
 */
function flagBadRows_(sh, typeCount, maxDay) {
  if (!typeCount) return;
  sh.clearConditionalFormatRules();
  var body = sh.getRange(2, 1, 2000, typeCount + LEAVE_FIXED_TAIL.length + 1);
  var sum = 'SUM($B2:$' + colLetter_(1 + typeCount) + '2)';
  var rules = [
    // more than the daily maximum across all types
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=AND($A2<>"", ' + sum + '>' + maxDay + ')')
      .setBackground('#f9d6d5').setRanges([body]).build(),
    // a weekend, which never receives leave
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=AND($A2<>"", WEEKDAY($A2,2)>5, ' + sum + '>0)')
      .setBackground('#fde8c8').setRanges([body]).build(),
  ];
  sh.setConditionalFormatRules(rules);
}

function buildHolidays_() {
  var sh = sheet_(TABS.holidays);
  if (sh.getLastRow() > 1) return;
  sh.clear();
  sh.getRange(1, 1, 1, 3).setValues([['Date', 'Name', 'Source']]);
  styleHeader_(sh, 1, 3);
  sh.setFrozenRows(1);
  var source = SpreadsheetApp.newDataValidation()
    .requireValueInList(['builtin', 'custom', 'removed'], true)
    .setAllowInvalid(false).build();
  sh.getRange(2, 3, 2000, 1).setDataValidation(source);
  sh.getRange(2, 1, 2000, 1).setNumberFormat('yyyy-mm-dd');
  autosize_(sh, 3);
}

function installTrigger() {
  var existing = ScriptApp.getProjectTriggers();
  for (var i = 0; i < existing.length; i++) {
    if (existing[i].getHandlerFunction() === 'refresh') {
      ScriptApp.deleteTrigger(existing[i]);
    }
  }
  // Sheets API writes do not fire onEdit, so a daily pass is the backstop
  ScriptApp.newTrigger('refresh').timeBased().everyDays(1).atHour(5).create();
}

// ============================================================
// Small helpers
// ============================================================

function ensureSheet_(name) {
  var s = ss_();
  return s.getSheetByName(name) || s.insertSheet(name);
}

function styleHeader_(sh, row, cols) {
  sh.getRange(row, 1, 1, cols)
    .setBackground(THEME.header).setFontColor(THEME.headerText)
    .setFontWeight('bold');
}

function autosize_(sh, cols) {
  for (var i = 1; i <= cols; i++) sh.autoResizeColumn(i);
}

function colLetter_(n) {
  var s = '';
  while (n > 0) {
    var m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = (n - m - 1) / 26;
  }
  return s;
}

// Exported for the node test harness; harmless inside Apps Script.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    computeProjection_: computeProjection_,
    addYearsIso_: addYearsIso_,
    isWeekend_: isWeekend_,
    parseIso_: parseIso_,
    isoOf_: isoOf_,
    defaultRules_: defaultRules_,
    rulesFromTypes_: rulesFromTypes_,
    writeDashboard_: writeDashboard_,
  };
}
