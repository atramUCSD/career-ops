/**
 * apply-runner/run.mjs against real Chrome and fixture pages, with no network:
 * the submit interlock and the combobox second pass. Not in config/local-paths.txt:
 * tests/ is a system path, so the coverage guard refuses fork-only files there.
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { toolRequired } from "./required-tools.mjs";
import { approvalHash, guardContext, interlockState, isConfirmed, retryComboboxes, soleSubmitControl } from "../apply-runner/run.mjs";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..", "web");
const { chromium } = createRequire(join(WEB, "package.json"))("playwright-core");

const SUBMIT = '<button type="submit">Submit application</button>';
// The field's input handler submits the form: the path a click guard never sees.
const form = (buttons) => `<!doctype html><title>Apply</title>
<form method="post" action="/apply">
  <input id="name" name="name">
  ${buttons}
</form>
<script>document.getElementById("name").addEventListener("input", (e) => e.target.form.requestSubmit());</script>`;

// Skip without Chrome, except where the browser is required (tests/required-tools.mjs).
let browser;
try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
} catch (e) {
  if (toolRequired("browser")) throw e;
}
const skip = !browser && "Chrome cannot launch";
after(() => browser?.close());

/** A guarded context whose first route stands in for the engine's egress guard:
 *  it serves the fixture and records every POST that gets past the interlock. */
async function open(buttons) {
  const context = guardContext(await browser.newContext({ serviceWorkers: "block" }));
  const posts = [];
  await context.route("https://apply.test/**", (route) => {
    const req = route.request();
    if (req.method() === "POST") {
      posts.push(req.url());
      return route.fulfill({ contentType: "text/html", body: "<h1>Thank you for applying</h1>" });
    }
    return route.fulfill({ contentType: "text/html", body: new URL(req.url()).pathname === "/" ? form(buttons) : "" });
  });
  const page = await context.newPage();
  await page.goto("https://apply.test/");
  return { context, page, posts };
}

test("unarmed, a field handler's requestSubmit is aborted and logged", { skip }, async () => {
  const { context, page, posts } = await open(SUBMIT);
  const failed = page.waitForEvent("requestfailed", (r) => r.method() === "POST");
  await page.fill("#name", "Alan");
  assert.equal((await failed).failure()?.errorText, "net::ERR_ACCESS_DENIED");
  assert.deepEqual(interlockState(context).blocked.map((b) => `${b.method} ${b.url}`), ["POST https://apply.test/apply"]);
  assert.deepEqual(posts, []);
  // Context routes run last-registered first, so a later one would run ahead of
  // the interlock and could continue() what it would have aborted.
  await assert.rejects(context.route("**/*", (r) => r.continue()), /ahead of the submit interlock/);
  await context.close();
});

test("armed, the sole submit control reaches the endpoint and the confirmation is detected", { skip }, async () => {
  const { context, page, posts } = await open(SUBMIT);
  assert.equal(await isConfirmed(page), false);
  const control = await soleSubmitControl(page.mainFrame());
  interlockState(context).armed = true;
  await Promise.all([page.waitForURL("https://apply.test/apply"), page.click(`[data-co-ref="${control.ref}"]`)]);
  assert.deepEqual(posts, ["https://apply.test/apply"]);
  assert.equal(await isConfirmed(page), true);
  await context.close();
});

test("a form with two submit controls is refused", { skip }, async () => {
  // Untyped <button> inside a form submits by HTML default.
  const { context, page } = await open(`${SUBMIT}<button>Apply now</button>`);
  await assert.rejects(soleSubmitControl(page.mainFrame()), /2 submit controls/);
  await context.close();
});

test("approvalHash changes with the answers, the form and the CV", () => {
  const answers = Buffer.from('{"co0":"Alan"}');
  const cv = Buffer.from("%PDF-1.7");
  const base = approvalHash(answers, "[]", cv);
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.notEqual(approvalHash(Buffer.from('{"co0":"Alan T"}'), "[]", cv), base);
  assert.notEqual(approvalHash(answers, '[["co0"]]', cv), base);
  assert.notEqual(approvalHash(answers, "[]", Buffer.from("%PDF-1.6")), base);
  // Without the length prefixes these two would hash the same bytes.
  assert.notEqual(approvalHash(Buffer.from("ab"), "c", Buffer.alloc(0)), approvalHash(Buffer.from("a"), "bc", Buffer.alloc(0)));
});

// A react-select shell over a remote autocomplete: options arrive 1 s after the
// last keystroke, far past fillSession's 300 ms read.
const AUTOCOMPLETE = `<!doctype html>
<div class="select__control"><div class="select__single-value"></div><input data-co-field="co0" role="combobox"></div>
<div id="menu"></div>
<script>
  const input = document.querySelector("input");
  const menu = document.getElementById("menu");
  let timer;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    menu.className = "";
    menu.replaceChildren();
    timer = setTimeout(() => {
      window.lastQuery = input.value;
      menu.className = "select__menu";
      for (const city of ["San Diego, California, United States", "San Diego County, California, United States"]) {
        const o = Object.assign(document.createElement("div"), { className: "select__option", textContent: city });
        o.setAttribute("role", "option");
        o.onclick = () => {
          document.querySelector(".select__single-value").textContent = city;
          menu.replaceChildren();
        };
        menu.append(o);
      }
    }, 1000);
  });
</script>`;

test("a failed combobox gets a second pass that waits for a remote autocomplete", { skip }, async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.setContent(AUTOCOMPLETE);
  const city = "San Diego, California, United States";
  const steps = [{ fieldId: "co0", label: "Location (City)", ok: false }];
  const filled = await retryComboboxes({ frame: page.mainFrame(), page }, [{ id: "co0", combobox: true }], { co0: city }, steps);
  assert.deepEqual(filled, ["Location (City)"]);
  assert.equal(steps[0].ok, true);
  assert.equal(await page.textContent(".select__single-value"), city);
  assert.equal(await page.evaluate(() => window.lastQuery), "San Diego");
  await context.close();
});
