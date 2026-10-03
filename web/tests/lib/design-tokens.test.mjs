// Durable form of the two "Done means" greps at the top of web/DESIGN.md.
// Walks web/src and fails on any raw palette class, off-scale arbitrary value
// or raw hsl()/rgb() color outside components/ui/ and the DESIGN.md section 9
// allowlist below.
//
// Run:  node --test tests/lib/design-tokens.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isNestedCheckout } from "../../../lib/mjs-files.mjs";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");

// Copied verbatim from DESIGN.md. Grep 1 scans every file, grep 2 only *.tsx.
const GREPS = [
  {
    name: "raw classes",
    re: /(emerald|amber|red|sky|zinc)-[0-9]|text-\[[0-9.]+px\]|tracking-\[|text-brand\/|hover:(brightness|-?translate|shadow)|transition-all|focus(-visible|-within)?:(ring|border)|ring-dashed|drop-shadow|prose-sm/g,
    applies: () => true,
  },
  {
    name: "raw hsl/rgb",
    re: /hsla?\(|rgba?\(/g,
    applies: (file) => file.endsWith(".tsx"),
  },
];

// Section 9 only. Each entry is one file plus a regex the offending LINE must
// match; nothing here exempts a directory or a whole grep. An entry that no
// longer matches anything fails the suite, so the list cannot rot.
// Section 9 items the greps cannot hit (hex shader colors, theme-color meta,
// #000 mask stops, the digest's inline hex, bg-white/text-white, the hero
// veil's dark:bg-background/45) need no entry.
const ALLOW = [
  {
    file: "components/company-logo.tsx",
    pattern: /linear-gradient\(135deg, hsl\(\$\{hue\} .*hsl\(\$\{\(hue \+ 28\) % 360\}/,
    why: "DESIGN.md section 9: company-logo.tsx hue-hashed hsl() monogram",
  },
];

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return isNestedCheckout(p) ? [] : walk(p);
    return [p];
  });
}

function scan() {
  const hits = [];
  const used = new Set();
  for (const abs of walk(SRC)) {
    const file = relative(SRC, abs).split(sep).join("/");
    if (file.startsWith("components/ui/")) continue;
    const buf = readFileSync(abs);
    if (buf.includes(0)) continue; // binary, as grep skips it
    buf.toString("utf8").split(/\r?\n/).forEach((line, i) => {
      for (const g of GREPS) {
        if (!g.applies(file)) continue;
        const matches = [...line.matchAll(g.re)].map((m) => m[0]);
        if (!matches.length) continue;
        const allow = ALLOW.find((a) => a.file === file && a.pattern.test(line));
        if (allow) {
          used.add(allow);
          continue;
        }
        hits.push(`web/src/${file}:${i + 1}: ${matches.join(", ")}  |  ${line.trim()}`);
      }
    });
  }
  return { hits, unused: ALLOW.filter((a) => !used.has(a)) };
}

const { hits, unused } = scan();

test("no raw palette, arbitrary-size or hsl/rgb color outside components/ui and section 9", () => {
  assert.equal(hits.length, 0, `\n${hits.length} design-token violation(s):\n${hits.join("\n")}\n`);
});

test("every section 9 allowlist entry still matches a line", () => {
  assert.deepEqual(
    unused.map((a) => `${a.file} ${a.pattern}`),
    [],
    "stale allowlist entry: remove it or fix its pattern",
  );
});
