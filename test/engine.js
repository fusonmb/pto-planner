/* Loads the calc engine out of index.html so it can run under node.
   Nothing here modifies the app: the engine text is extracted verbatim,
   given a localStorage shim, and evaluated.  If the markers below stop
   matching, the extraction fails loudly rather than testing stale code. */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const APP = path.join(__dirname, "..", "index.html");

/* the code part of a line, with any trailing // comment removed */
function codeOf(line) {
  let quote = null;
  for (let k = 0; k < line.length; k++) {
    const c = line[k];
    if (quote) {
      if (c === "\\") k++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (c === "/" && line[k + 1] === "/") return line.slice(0, k);
  }
  return line;
}

/* net bracket depth a line contributes, ignoring strings and comments */
function balance(line) {
  const code = codeOf(line);
  let d = 0, quote = null;
  for (let k = 0; k < code.length; k++) {
    const c = code[k];
    if (quote) {
      if (c === "\\") k++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if ("([{".includes(c)) d++;
    else if (")]}".includes(c)) d--;
  }
  return d;
}

function extract(src) {
  const lines = src.split("\n");
  const at = (re) => {
    const i = lines.findIndex((l) => re.test(l));
    if (i < 0) throw new Error(`engine.js: marker not found: ${re}`);
    return i;
  };
  const start = at(/calc engine \*\//);
  const end = at(/=+ UI \*\//);
  // date helpers live below the UI marker but the engine depends on them
  const helpers = [];
  const taken = new Set();
  for (const re of [/^const iso = /, /^const parseISO = /,
                    /^const PERIOD_EPOCH /, /^const isWeekend = /,
                    /^const periodIndex = /]) {
    const i = at(re);
    // a declaration may wrap; consume lines until brackets balance AND the
    // statement is terminated.  A `;` alone is not enough -- these one-liner
    // arrow bodies contain semicolons inside their own braces.
    let j = i, depth = 0;
    for (;; j++) {
      if (j > i + 8) throw new Error(`engine.js: runaway decl at ${re}`);
      depth += balance(lines[j]);
      if (depth === 0 && /;\s*$/.test(codeOf(lines[j]).trimEnd())) break;
    }
    if (taken.has(i)) continue;          // already swallowed by a previous decl
    for (let k = i; k <= j; k++) taken.add(k);
    helpers.push(lines.slice(i, j + 1).join("\n"));
  }
  // `const` declarations stay lexical and never land on the sandbox global,
  // so re-export by name everything the tests need to reach.
  const EXPORTS = [
    "ORIGINAL_ANCHOR", "ACCRUAL_BASE", "ACCRUAL_AFTER_9YRS",
    "CAP_BASE", "CAP_AFTER_9YRS", "STEP_YEARS", "PARENTAL_TOTAL",
    "MAX_DAY_HOURS", "PERIOD_DAYS", "BUILTIN_HOLIDAYS", "STORE_KEY",
    "iso", "parseISO", "isWeekend", "periodIndex", "r2",
  ];
  const epilogue = EXPORTS.map((n) => `globalThis.${n} = ${n};`).join("\n");
  return lines.slice(start, end).join("\n") + "\n" + helpers.join("\n")
       + "\n" + epilogue + "\n";
}

function makeStore(initial) {
  let backing = initial === undefined ? null : JSON.stringify(initial);
  return {
    getItem: (k) => (k === "leavePlannerData" ? backing : null),
    setItem: (k, v) => { if (k === "leavePlannerData") backing = v; },
    removeItem: () => { backing = null; },
    raw: () => (backing === null ? null : JSON.parse(backing)),
  };
}

/* Build a fresh engine bound to `data`.  Each call is fully isolated, so a
   test that writes leave can't leak into the next one. */
function loadEngine(data) {
  const store = makeStore(data);
  const sandbox = { localStorage: store, console };
  vm.createContext(sandbox);
  vm.runInContext(extract(fs.readFileSync(APP, "utf8")), sandbox,
                  { filename: "index.html:calc-engine" });
  sandbox.store = store;
  return sandbox;
}

module.exports = { loadEngine };
