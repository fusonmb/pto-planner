/* Browser tests for the balance (anchor) editor.
   The calc suites cannot reach this: the bug was never in the arithmetic,
   it was that the editor prefilled the PROJECTED balance, so changing only
   the date re-anchored a derived number and moved the whole plan.  That is
   only visible by driving the page.

   Playwright is optional.  Without it this suite skips rather than fails,
   so `node test/run.js` still works on a machine that has not installed it.
   Run: node test/ui.test.js                                            */
"use strict";
const path = require("path");

let chromium;
try {
  ({ chromium } = require("playwright"));
} catch (e) {
  try {
    ({ chromium } = require(path.join(
      process.env.NODE_PATH || "/opt/node22/lib/node_modules", "playwright")));
  } catch (e2) {
    console.log("\n0 passed, 0 failed (skipped: playwright not installed)");
    process.exit(0);
  }
}

const APP = "file://" + path.join(__dirname, "..", "index.html");
const seed = (over) => JSON.stringify(Object.assign({
  entries: {}, holidays: {}, removedHolidays: [],
  anchor: { date: "2026-08-09", balance: 142.69 },
  hireDate: "2019-04-01", birthDate: null,
}, over || {}));

let pass = 0;
const failures = [];
const ok = (c, w) => { if (!c) throw new Error(w); };
const eq = (a, b, w) => {
  if (String(a) !== String(b)) throw new Error(`${w}: got ${a}, want ${b}`);
};

const DEVICES = [
  { name: "desktop", viewport: { width: 1280, height: 900 } },
  { name: "mobile", viewport: { width: 390, height: 844 },
    hasTouch: true, isMobile: true },
];

(async () => {
  const browser = await chromium.launch();

  async function page(ctxOpts, storage) {
    const ctx = await browser.newContext(ctxOpts);
    const p = await ctx.newPage();
    const errs = [];
    p.on("pageerror", (e) => errs.push(String(e)));
    await p.addInitScript((s) => {
      for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v);
    }, storage);
    await p.goto(APP);
    await p.waitForTimeout(250);
    return { ctx, p, errs };
  }

  async function check(name, fn) {
    try { await fn(); pass++; }
    catch (e) { failures.push(`${name}\n    ${e.message}`); }
  }

  for (const dev of DEVICES) {
    const tag = `[${dev.name}] `;

    await check(tag + "the editor prefills the anchor, not the projection", async () => {
      const { ctx, p } = await page(dev, { leavePlannerData: seed() });
      const tile = (await p.locator(".tile .value").first().textContent()).trim();
      ok(!tile.startsWith("142"), "fixture no longer projects away from the anchor");
      await p.locator(".tile .value.editable").first().click();
      await p.waitForTimeout(120);
      ok(await p.locator("#anchorEditor").isVisible(), "editor did not open");
      eq(await p.locator("#anHours").inputValue(), "142.69", "prefilled balance");
      eq(await p.locator("#anDate").inputValue(), "2026-08-09", "prefilled date");
      await ctx.close();
    });

    await check(tag + "changing the date leaves the balance alone", async () => {
      const { ctx, p } = await page(dev, { leavePlannerData: seed() });
      await p.locator(".tile .value.editable").first().click();
      await p.waitForTimeout(120);
      await p.locator("#anDate").selectOption("2026-09-20");
      await p.waitForTimeout(120);
      eq(await p.locator("#anHours").inputValue(), "142.69", "balance after date change");
      await ctx.close();
    });

    await check(tag + "nothing is saved until Save is pressed", async () => {
      const { ctx, p } = await page(dev, { leavePlannerData: seed() });
      await p.locator(".tile .value.editable").first().click();
      await p.waitForTimeout(120);
      await p.locator("#anHours").fill("150");
      await p.locator("#anDate").selectOption("2026-09-20");
      await p.locator("#anPreview").click();          // move focus off the fields
      await p.waitForTimeout(250);
      const a = await p.evaluate(() => JSON.parse(localStorage.leavePlannerData).anchor);
      eq(a.balance, 142.69, "balance saved on blur");
      eq(a.date, "2026-08-09", "date saved on blur");
      await ctx.close();
    });

    await check(tag + "Save commits the pair together", async () => {
      const { ctx, p } = await page(dev, { leavePlannerData: seed() });
      await p.locator(".tile .value.editable").first().click();
      await p.waitForTimeout(120);
      await p.locator("#anHours").fill("150");
      await p.locator("#anDate").selectOption("2026-09-20");
      await p.locator("#anSave").click();
      await p.waitForTimeout(300);
      const a = await p.evaluate(() => JSON.parse(localStorage.leavePlannerData).anchor);
      eq(a.balance, 150, "saved balance");
      eq(a.date, "2026-09-20", "saved date");
      ok(!(await p.locator("#anchorEditor").isVisible()), "editor stayed open");
      await ctx.close();
    });

    await check(tag + "Cancel discards the edit", async () => {
      const { ctx, p } = await page(dev, { leavePlannerData: seed() });
      await p.locator(".tile .value.editable").first().click();
      await p.waitForTimeout(120);
      await p.locator("#anHours").fill("999");
      await p.locator("#anCancel").click();
      await p.waitForTimeout(200);
      const a = await p.evaluate(() => JSON.parse(localStorage.leavePlannerData).anchor);
      eq(a.balance, 142.69, "balance after Cancel");
      ok(!(await p.locator("#anchorEditor").isVisible()), "editor stayed open");
      await ctx.close();
    });

    await check(tag + "the preview names both the pair and the result", async () => {
      const { ctx, p } = await page(dev, { leavePlannerData: seed() });
      await p.locator(".tile .value.editable").first().click();
      await p.waitForTimeout(120);
      await p.locator("#anHours").fill("150");
      await p.locator("#anDate").selectOption("2026-09-20");
      await p.waitForTimeout(150);
      const t = (await p.locator("#anPreview").textContent()).replace(/\s+/g, " ");
      ok(/150\.00 h/.test(t), `preview omits the typed balance: ${t}`);
      ok(/Sep 20, 2026/.test(t), `preview omits the chosen date: ${t}`);
      await ctx.close();
    });

    await check(tag + "the editor stays in hours when the tile shows days", async () => {
      const { ctx, p } = await page(dev,
        { leavePlannerData: seed(), ptoUnits: "days" });
      await p.locator(".tile .value.editable").first().click();
      await p.waitForTimeout(120);
      eq(await p.locator("#anHours").inputValue(), "142.69",
         "prefill converted to days");
      await p.locator("#anSave").click();
      await p.waitForTimeout(300);
      const a = await p.evaluate(() => JSON.parse(localStorage.leavePlannerData).anchor);
      eq(a.balance, 142.69, "saved value was converted");
      await ctx.close();
    });

    await check(tag + "a first run with no anchor can set one", async () => {
      const { ctx, p, errs } = await page(dev,
        { leavePlannerData: seed({ anchor: null, hireDate: null }) });
      await p.locator(".tile .value.editable").first().click();
      await p.waitForTimeout(120);
      ok(await p.locator("#anchorEditor").isVisible(), "editor did not open");
      await p.locator("#anHours").fill("100");
      await p.locator("#anSave").click();
      await p.waitForTimeout(300);
      const a = await p.evaluate(() => JSON.parse(localStorage.leavePlannerData).anchor);
      ok(a && a.balance === 100, "first run did not save: " + JSON.stringify(a));
      ok(errs.length === 0, "page errors: " + errs.join(" | "));
      await ctx.close();
    });
  }

  await browser.close();
  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log("\nFAILURES:");
    for (const f of failures) console.log("  - " + f);
    process.exit(1);
  }
})();
