/* Runs every test file.  node test/run.js */
"use strict";
const { execFileSync } = require("child_process");
const path = require("path");

const SUITES = ["calc.test.js", "codegs.test.js", "store.test.js"];
let failed = 0;

for (const s of SUITES) {
  process.stdout.write(`\n=== ${s} ===`);
  try {
    process.stdout.write(
      execFileSync(process.execPath, [path.join(__dirname, s)],
                   { encoding: "utf8" }));
  } catch (e) {
    process.stdout.write(e.stdout || "");
    process.stdout.write(e.stderr || "");
    failed++;
  }
}
console.log(failed ? `\n${failed} suite(s) FAILED` : "\nall suites passed");
process.exit(failed ? 1 : 0);
