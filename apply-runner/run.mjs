#!/usr/bin/env node
/**
 * Unattended Greenhouse apply runner. Fork-only: declared in
 * config/local-paths.txt so update-system never ships or overwrites it, and it
 * changes nothing under web/ — it drives the web engine from outside.
 *
 * Phase 0 is a dry run and has no submit path. `inspect` opens the posting named
 * by a report's **URL:** line and records the form; `fill` replays it, fills it
 * through the engine's fillSession and writes a review packet to
 * output/{NNN-company-role}/apply/. For the whole session a network interlock
 * aborts every request other than GET/HEAD/OPTIONS: submit-guard.mjs vets clicks
 * only, and a field handler or an Enter keypress can still call
 * form.requestSubmit().
 *
 *   node apply-runner/run.mjs inspect --report N
 *   node apply-runner/run.mjs fill --report N --answers answers.json
 *
 * Exit 0 = clean packet, 2 = parked (reason printed), 1 = error.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire, register } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { applicationArtifactPaths } from "../application-artifacts.mjs";
import { isMainModule } from "../lib/is-main-module.mjs";
import { reportNumberFromCell } from "../web/src/lib/apply/cv-selection.mjs";
import { factsOf } from "../web/src/lib/apply/drive-action.mjs";
import { pickComboboxOption } from "../web/src/lib/apply/option-match.mjs";
import { isResumeLabel } from "../web/src/lib/apply/resume-label.mjs";
import { isSubmitControl, snapshotLabel } from "../web/src/lib/apply/submit-guard.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WEB = join(ROOT, "web");
const USAGE = "usage: node apply-runner/run.mjs inspect --report N\n       node apply-runner/run.mjs fill --report N --answers answers.json";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
// URL regexes a form must POST to before submit. The application endpoint never
// goes here. Dry runs keep this empty so the CV never leaves the machine: the
// Discord 007 run (2026-10-22) showed Greenhouse uploads the resume on attach
// by a presigned POST to grnhse-prod-jben-us-west-2.s3.us-west-2.amazonaws.com,
// which Phase 1 allows on the approved submit run only, then waits for the
// upload to finish before the click. Snowplow analytics (c.spl.greenhouse.io)
// stays blocked; the form does not need it.
const FILL_ALLOW = [];
const INTERLOCKS = new WeakMap();
// openSession closes the context when it aborts, taking its state with it; the
// blocked log is still the evidence for why the form never rendered.
let lastInterlock = null;

/**
 * Abort and log every request other than GET/HEAD/OPTIONS until `armed` is set.
 * `route` is the context's own route method; guardContext passes the original
 * because it has replaced context.route with its ordering check.
 */
async function installInterlock(context, route = context.route.bind(context)) {
  const state = { armed: false, blocked: [] };
  // ponytail: keyed on method, so a GET-method form or a WebSocket message gets
  // past it. Greenhouse posts; add a navigation check before targeting an ATS
  // that submits by GET.
  await route("**/*", (r) => {
    const req = r.request();
    if (state.armed || SAFE_METHODS.has(req.method()) || FILL_ALLOW.some((rx) => rx.test(req.url()))) return r.fallback();
    state.blocked.push({ method: req.method(), url: req.url(), resourceType: req.resourceType() });
    return r.abort("accessdenied");
  });
  INTERLOCKS.set(context, state);
  lastInterlock = state;
  return state;
}

/**
 * Put the interlock in right after the context's first route — in the engine,
 * the egress guard — and refuse any later one. Context routes run
 * last-registered first and the guard ends in route.continue(), so the
 * interlock must come after it, and a route added after the interlock would run
 * ahead of it.
 */
export function guardContext(context) {
  const route = context.route.bind(context);
  context.route = async (...args) => {
    if (INTERLOCKS.has(context)) throw new Error("a second context route would run ahead of the submit interlock");
    await route(...args);
    await installInterlock(context, route);
  };
  return context;
}

export const interlockState = (context) => INTERLOCKS.get(context);

/**
 * Launch Chrome as session.ts headedBrowser() does and pre-seed it, so every
 * context the engine opens blocks service workers (their fetches skip context
 * routes) and gets the interlock.
 */
async function seedBrowser() {
  const { chromium } = createRequire(join(WEB, "package.json"))("playwright-core");
  const browser = await chromium.launch({ channel: "chrome", headless: false, args: ["--window-position=-3200,-3200", "--window-size=1280,940"] });
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (options = {}) => guardContext(await newContext({ ...options, serviceWorkers: "block" }));
  globalThis.__coHeadedBrowser = browser;
}

/** sha256 over what Alan approves. Each part is length-prefixed so bytes cannot
 *  move across a boundary and keep the digest. */
export function approvalHash(answers, fingerprint, cv) {
  const h = createHash("sha256");
  for (const part of [answers, Buffer.from(fingerprint), cv]) h.update(`${part.length}:`).update(part);
  return h.digest("hex");
}

/** The form as answers.json was drafted against it. Field ids are positional
 *  (extract.ts co0, co1, ...), so a reordered form changes this too. */
const fingerprint = (fields) => JSON.stringify(fields.map((f) => [f.id, f.type, f.label, Boolean(f.required), f.options ?? []]));

const CONFIRM_PATH = /\/(confirmation|thanks)\b/i;
const CONFIRM_TEXT = /thank you for applying|application (was )?(received|submitted)/i;

/** True when any frame shows the post-submit state. */
export async function isConfirmed(page) {
  for (const frame of page.frames()) {
    if (URL.canParse(frame.url()) && CONFIRM_PATH.test(new URL(frame.url()).pathname)) return true;
    const text = await frame.evaluate(() => document.body?.innerText ?? "").catch(() => "");
    if (CONFIRM_TEXT.test(text)) return true;
  }
  return false;
}

/** Every visible control isSubmitControl() flags, tagged with a data-co-ref a
 *  click can target. Same visibility rule and same facts as drive.ts snapshot(). */
export async function submitControls(frame) {
  const prefix = `s${randomUUID().slice(0, 8)}`;
  await frame.evaluate((prefix) => {
    for (const stale of document.querySelectorAll("[data-co-ref]")) stale.removeAttribute("data-co-ref");
    let n = 0;
    for (const el of document.querySelectorAll('a, button, input, [role="button"], [role="link"]')) {
      const r = el.getBoundingClientRect();
      if (el.offsetParent !== null && r.width > 2 && r.height > 2) el.setAttribute("data-co-ref", `${prefix}-${n++}`);
    }
  }, prefix);
  const handles = await frame.$$(`[data-co-ref^="${prefix}-"]`);
  const facts = await Promise.all(handles.map((h) => h.evaluate(factsOf, null).catch(() => null)));
  await Promise.all(handles.map((h) => h.dispose().catch(() => {})));
  return facts.filter((f) => f?.ref && isSubmitControl(f));
}

/** The one submit control, or a refusal naming all of them. */
export async function soleSubmitControl(frame) {
  const controls = await submitControls(frame);
  if (controls.length !== 1) throw new Error(`${controls.length} submit controls: ${controls.map(snapshotLabel).join(" | ")}`);
  return controls[0];
}

const MENU = '.select__menu .select__option, .select__menu-list [role="option"], [class*="menu" i] [role="option"]';

/**
 * Second pass over the comboboxes fillSession gave up on. It reads the menu a
 * fixed 300 ms after typing the whole answer, before a remote autocomplete such
 * as Greenhouse's Location (City) has answered. This types the part before the
 * first comma and polls the menu for up to 5 s. Otherwise the same rules: click
 * only an option pickComboboxOption accepts, never press Enter, Escape on no
 * match. Marks the steps it fixes ok and returns their labels.
 */
// ponytail: lives here because web/ stays untouched. The upstream fix is a
// polled menu read in session.ts fillSession, after which this pass can go.
export async function retryComboboxes(s, fields, answers, steps) {
  const filled = [];
  for (const step of steps) {
    const value = answers[step.fieldId];
    if (step.ok || !value || !fields.find((f) => f.id === step.fieldId)?.combobox) continue;
    const loc = s.frame.locator(`[data-co-field=${JSON.stringify(step.fieldId)}]`).first();
    const options = s.frame.locator(MENU);
    try {
      await loc.scrollIntoViewIfNeeded();
      await loc.click();
      await loc.fill("");
      await loc.pressSequentially(value.split(",")[0].trim(), { delay: 15 });
      let pick = -1;
      for (let prev = "", end = Date.now() + 5000; pick < 0 && Date.now() < end; ) {
        await s.page.waitForTimeout(250);
        const texts = JSON.stringify(await options.allInnerTexts());
        // Two equal reads first: a debounced autocomplete can re-render the list
        // between the read and the click, and the index would hit another option.
        if (texts === prev) pick = pickComboboxOption(JSON.parse(texts), value);
        prev = texts;
      }
      if (pick < 0) {
        await s.page.keyboard.press("Escape");
        continue;
      }
      await options.nth(pick).click();
      // verifyFill only checks that a combobox shows something, not that it is this.
      const shown = await loc.evaluate((el) => el.closest('[class*="select__control" i]')?.querySelector('[class*="single-value" i]')?.textContent ?? "");
      if (pickComboboxOption([shown], value) === 0) {
        step.ok = true;
        filled.push(step.label);
      }
    } catch {
      await s.page.keyboard.press("Escape").catch(() => {});
    }
  }
  return filled;
}

function parkReason({ fields, issues, frameUrl, confirmed }) {
  const codes = new Set(issues.map((i) => i.code));
  if (codes.has("captcha-present")) return "captcha";
  if (codes.has("multi-step")) return "multi-step";
  const host = URL.canParse(frameUrl) ? new URL(frameUrl).hostname : "";
  if (host !== "greenhouse.io" && !host.endsWith(".greenhouse.io")) return `form-not-on-greenhouse: ${host || frameUrl}`;
  const file = fields.find((f) => f.type === "file" && f.required && !isResumeLabel(f.label));
  if (file) return `required-file: ${file.label}`;
  // Phase 1 detects success by this text; already present, it proves nothing.
  if (confirmed) return "confirmation-text-before-submit";
  return null;
}

async function loadEngine() {
  // The engine finds the checkout from cwd, which it expects to be web/.
  process.env.CAREER_OPS_CODE_ROOT ??= ROOT;
  // Node strips types, but the engine imports with Next's @/ alias and no .ts
  // extension. Same hook as web/tests/lib/apply-resume-upload.test.mjs.
  const src = join(WEB, "src");
  register(`data:text/javascript,${encodeURIComponent(`
    import { existsSync } from 'node:fs';
    import { pathToFileURL, fileURLToPath } from 'node:url';
    import path from 'node:path';
    export async function resolve(specifier, context, nextResolve) {
      const base = specifier.startsWith('@/')
        ? path.join(${JSON.stringify(src)}, specifier.slice(2))
        : specifier.startsWith('.') ? fileURLToPath(new URL(specifier, context.parentURL)) : null;
      if (base) {
        for (const ext of ['', '.ts', '.mjs', '.js']) {
          if (existsSync(base + ext)) return { url: pathToFileURL(base + ext).href, shortCircuit: true };
        }
      }
      return nextResolve(specifier, context);
    }
  `)}`, pathToFileURL(src + "/"));
  const [session, cv, core, diagnose] = await Promise.all([
    import("../web/src/lib/apply/session.ts"),
    import("../web/src/lib/apply/cv.ts"),
    import("../web/src/lib/career-ops.ts"),
    import("../web/src/lib/apply/diagnose.ts"),
  ]);
  return { ...session, ...cv, ...core, verifyFill: diagnose.verifyFill };
}

/** openSession behind the interlock, or { parked }. Fails closed when the
 *  session's context did not come through guardContext. */
async function open(engine, url) {
  if (!globalThis.__coHeadedBrowser) await seedBrowser();
  let opened;
  try {
    opened = await engine.openSession(url);
  } catch (err) {
    return { parked: `open-failed: ${err.message}` };
  }
  const s = engine.getSession(opened.id);
  const lock = interlockState(s?.context);
  if (!lock) {
    await engine.closeSession(opened.id);
    throw new Error("the session opened without the submit interlock");
  }
  return { ...opened, s, lock };
}

const writeJson = (dir, name, data) => writeFileSync(join(dir, name), `${JSON.stringify(data, null, 2)}\n`);
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const park = (reason) => (console.log(`parked: ${reason}`), 2);

async function inspect(engine, n, url, dir) {
  const o = await open(engine, url);
  if (o.parked) {
    writeJson(dir, "inspect.json", { report: n, url, parked: o.parked, blocked: lastInterlock?.blocked ?? [] });
    return park(o.parked);
  }
  try {
    const frameUrl = o.s.frame.url();
    const controls = await submitControls(o.s.frame);
    const parked = parkReason({ fields: o.fields, issues: o.issues, frameUrl, confirmed: await isConfirmed(o.s.page) });
    await o.s.page.screenshot({ path: join(dir, "inspect.png"), fullPage: true, timeout: 30_000 });
    writeJson(dir, "fields.json", o.fields);
    writeJson(dir, "inspect.json", {
      report: n,
      url,
      title: o.title,
      frameUrl,
      fingerprint: fingerprint(o.fields),
      issues: o.issues,
      submitControls: controls.map((f) => ({ label: snapshotLabel(f), tag: f.tag, type: f.type, role: f.role, inForm: f.inForm })),
      blocked: o.lock.blocked,
      parked,
    });
    if (parked) return park(parked);
    console.log(`ok: ${o.fields.length} fields, ${controls.length} submit control(s)`);
    return 0;
  } finally {
    await engine.closeSession(o.id);
  }
}

async function fill(engine, n, url, dir, answersFile) {
  const inspected = readJson(join(dir, "inspect.json"));
  if (inspected.parked) return park(`inspect parked: ${inspected.parked}`);
  const answerBytes = readFileSync(answersFile);
  const answers = JSON.parse(answerBytes);
  // fillSession skips an unknown id silently, and ids are positional: a typo
  // would leave a field empty with nothing to show for it.
  const ids = new Set(readJson(join(dir, "fields.json")).map((f) => f.id));
  if (typeof answers !== "object" || answers === null || Array.isArray(answers)) throw new Error("answers.json must be an object of field id to string");
  const bad = Object.entries(answers).filter(([id, v]) => !ids.has(id) || typeof v !== "string").map(([id]) => id);
  if (bad.length) throw new Error(`answers.json: unknown field id or non-string value: ${bad.join(", ")}`);
  rmSync(join(dir, "approval.txt"), { force: true });
  const cvPath = await engine.resolveSessionCv({ application: n });
  if (!cvPath) return park("no-tailored-cv");

  const o = await open(engine, url);
  if (o.parked) return park(o.parked);
  try {
    const fp = fingerprint(o.fields);
    if (fp !== inspected.fingerprint) return park("form-changed-since-inspect");
    const before = parkReason({ fields: o.fields, issues: o.issues, frameUrl: o.s.frame.url(), confirmed: await isConfirmed(o.s.page) });
    if (before) return park(before);
    const result = await engine.fillSession(o.id, answers, o.fields, cvPath);
    const retried = await retryComboboxes(o.s, o.fields, answers, result.steps);
    if (retried.length) result.issues = await engine.verifyFill(o.s.frame, o.fields, answers);
    await o.s.page.screenshot({ path: join(dir, "filled.png"), fullPage: true, timeout: 30_000 });
    const failedSteps = result.steps.filter((s) => !s.ok).map((s) => s.label);
    writeJson(dir, "verify.json", { navigated: result.navigated, issues: result.issues, failedSteps, retried, cv: cvPath });
    writeJson(dir, "blocked.json", o.lock.blocked);
    writeFileSync(join(dir, "answers.json"), answerBytes);
    if (result.navigated) return park("navigated-during-fill");
    if (result.issues.length || failedSteps.length) return park("fill-issues");
    writeFileSync(join(dir, "approval.txt"), `${approvalHash(answerBytes, fp, readFileSync(cvPath))}\n`);
    console.log("ok: filled, not submitted");
    return 0;
  } finally {
    await engine.closeSession(o.id);
  }
}

async function main(argv) {
  const { positionals, values } = parseArgs({ args: argv, allowPositionals: true, options: { report: { type: "string" }, answers: { type: "string" } } });
  const [cmd, ...extra] = positionals;
  const shape = (cmd === "inspect" && !values.answers) || (cmd === "fill" && values.answers);
  if (!shape || extra.length || !/^\d+$/.test(values.report ?? "")) {
    console.error(USAGE);
    return 1;
  }
  const n = String(Number(values.report));
  const engine = await loadEngine();
  // The URL comes from report N and the CV from tracker row N, so they must be
  // the same role or the CV goes to the wrong posting.
  const app = engine.findApplication(n);
  if (reportNumberFromCell(app?.report) !== Number(n)) throw new Error(`tracker row ${n} does not link report ${n}`);
  const url = engine.readReport(n)?.content.match(/^\*\*URL:\*\*\s*(\S+)/m)?.[1];
  if (!url) throw new Error(`report ${n} has no **URL:** line`);
  const dir = join(applicationArtifactPaths({ reportNum: n, company: app.company, role: app.role, root: join(ROOT, "output") }).root, "apply");
  mkdirSync(dir, { recursive: true });
  console.log(`packet: ${dir}`);
  try {
    return cmd === "inspect" ? await inspect(engine, n, url, dir) : await fill(engine, n, url, dir, resolve(values.answers));
  } finally {
    await globalThis.__coHeadedBrowser?.close().catch(() => {});
  }
}

if (isMainModule(import.meta.url)) {
  // Explicit exit: closeSession arms the engine's 5-minute idle-close timer.
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err?.message ?? err);
      process.exit(1);
    },
  );
}
