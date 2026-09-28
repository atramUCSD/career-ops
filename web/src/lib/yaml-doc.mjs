import fs from "node:fs";
import path from "node:path";
import * as YAML from "yaml";

// Comment-preserving edits to the user's YAML config (profile.yml, portals.yml,
// alerts.yml, lanes.yml). A js-yaml load/dump round trip drops every comment,
// and these files are mostly comments: the user's own notes on why a keyword or
// a floor is there. Here the file is parsed as a yaml Document, edited in
// place, and only the settings whose values changed are re-rendered and
// spliced into the original text, so every other byte stays the user's.

/**
 * Lets a route tell a broken user-layer file (409: the user must repair it)
 * from an installation or read failure (500).
 */
export class ConfigError extends Error {
  /**
   * @param {string} message
   * @param {"invalid-user-config" | "read-failed" | "invalid-template"} kind
   * @param {unknown} [cause]
   */
  constructor(message, kind, cause) {
    super(message, { cause });
    this.name = "ConfigError";
    this.kind = kind;
  }
}

/** 409 for a user file the user has to repair, 500 for anything else. */
export function configErrorResponse(error) {
  const status = error instanceof ConfigError && error.kind === "invalid-user-config" ? 409 : 500;
  return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status });
}

// lineWidth 0: never fold a long string the user wrote on one line.
const OPTS = { lineWidth: 0, flowCollectionPadding: false };

/**
 * Parse a user-layer YAML file, seeding from the shipped template only when the
 * file is absent. A file that exists but is malformed, or is a list or a single
 * value, is an error: treating it as missing is how a user's config gets
 * replaced with the example.
 *
 * @param {string} file
 * @param {string} templateFile
 * @param {string} [label] how the file is named in errors, e.g. "config/profile.yml"
 * @returns {{ doc: YAML.Document, src: string, seeded: boolean }}
 */
export function loadYamlDoc(file, templateFile, label = path.basename(file)) {
  let src;
  let seeded = false;
  try {
    src = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw new ConfigError(`could not read ${label}`, "read-failed", error);
    seeded = true;
    try {
      src = fs.readFileSync(templateFile, "utf8");
    } catch (templateError) {
      throw new ConfigError(`could not read the template for ${label}`, "read-failed", templateError);
    }
  }

  const doc = YAML.parseDocument(src);
  const kind = seeded ? "invalid-template" : "invalid-user-config";
  if (doc.errors.length) {
    const message = seeded
      ? `the template for ${label} is not valid YAML`
      : `${label} exists but is not valid YAML — refusing to overwrite it.`;
    throw new ConfigError(message, kind, doc.errors[0]);
  }
  if (!YAML.isMap(doc.contents)) {
    const message = seeded
      ? `the template for ${label} must contain named settings`
      : `${label} must contain named settings, not a list or single value. Refusing to overwrite it.`;
    throw new ConfigError(message, kind);
  }
  return { doc, src, seeded };
}

const isPlainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Set `value` at `keys`. A plain object merges key by key, so settings it does
 * not name are left alone. A list written over an existing list keeps the
 * surviving items' nodes, and with them their comments and quoting.
 *
 * @param {YAML.Document} doc
 * @param {Array<string | number>} keys a number indexes into a list
 * @param {unknown} value
 */
export function setIn(doc, keys, value) {
  if (isPlainObject(value)) {
    for (const [k, v] of Object.entries(value)) setIn(doc, [...keys, k], v);
    return;
  }
  // An empty `key:` becomes a map; anything else in the way is the user's
  // value and is not ours to replace.
  for (let i = 1; i < keys.length; i++) {
    const parent = doc.getIn(keys.slice(0, i), true);
    if (parent === undefined || YAML.isCollection(parent)) continue;
    if (YAML.isScalar(parent) && parent.value == null) {
      doc.setIn(keys.slice(0, i), new YAML.YAMLMap());
      continue;
    }
    throw new ConfigError(
      `${keys.slice(0, i).join(".")} is not a set of named settings — refusing to overwrite it.`,
      "invalid-user-config",
    );
  }
  const node = doc.getIn(keys, true);
  if (Array.isArray(value) && YAML.isSeq(node)) setSeq(doc, node, value);
  // Over an existing scalar, yaml keeps the node, so its quoting and comment stay.
  else doc.setIn(keys, Array.isArray(value) ? doc.createNode(value) : value);
}

const joinComments = (a, b) => (a && b ? `${a}\n${b}` : a || b);

function setSeq(doc, seq, values) {
  const json = (v) => JSON.stringify(YAML.isNode(v) ? v.toJSON() : v);
  const wanted = new Map();
  for (const v of values) wanted.set(json(v), (wanted.get(json(v)) ?? 0) + 1);
  const take = (k) => {
    const n = wanted.get(k) ?? 0;
    if (n) wanted.set(k, n - 1);
    return n > 0;
  };

  const items = [];
  // A removed item's comment is usually a heading for the items after it, so
  // it moves to the next item that stays. With no kept item after it, the
  // section it headed is gone, and so is the heading; a new item is appended
  // at the end and does not inherit it.
  let carried = { comment: undefined, space: false };
  for (const item of seq.items) {
    if (take(json(item))) {
      if (YAML.isNode(item)) {
        item.commentBefore = joinComments(carried.comment, item.commentBefore);
        item.spaceBefore ||= carried.space;
      }
      carried = { comment: undefined, space: false };
      items.push(item);
    } else if (YAML.isNode(item)) {
      carried = { comment: joinComments(carried.comment, item.commentBefore), space: carried.space || !!item.spaceBefore };
    }
  }
  const quoted = seq.items.find((i) => YAML.isScalar(i) && typeof i.value === "string")?.type;
  for (const v of values) {
    if (!take(json(v))) continue;
    const node = doc.createNode(v);
    if (quoted && YAML.isScalar(node) && typeof node.value === "string") node.type = quoted;
    items.push(node);
  }
  seq.items = items;
}

const keyOf = (pair) => (YAML.isScalar(pair.key) ? pair.key.value : pair.key);

// Render one pair as it would appear at column 0, minus what sits outside its
// source range: the comment and blank line above the key and the comments
// trailing the value. Those stay as the user wrote them.
function renderPair(pair, style) {
  const copy = pair.clone();
  if (YAML.isNode(copy.key)) {
    copy.key.commentBefore = undefined;
    copy.key.spaceBefore = false;
  }
  // Trailing comments attach to the innermost last collection, not always the
  // value itself, so clear them down the last-item chain.
  for (let node = copy.value; YAML.isCollection(node); ) {
    node.comment = undefined;
    const last = node.items.at(-1);
    node = YAML.isPair(last) ? last.value : last;
  }
  if (YAML.isScalar(copy.value)) copy.value.comment = undefined;
  const doc = new YAML.Document(new YAML.YAMLMap());
  doc.contents.items.push(copy);
  return doc.toString({ ...OPTS, ...style, verifyAliasOrder: false });
}

// The indent a block was written with, relative to its key at column `col`,
// so a re-rendered block matches it.
function styleOf(slice, col) {
  const depth = [...slice.matchAll(/\n( *)\S/g)].map((m) => m[1].length - col).find((d) => d > 0);
  return { indent: depth || 2, indentSeq: !slice.includes(`\n${" ".repeat(col)}- `) };
}

// Collect the splices that turn `old`, parsed from `src`, into `pair`. A block
// map with the same keys is descended into, so an edit re-renders only the
// setting that changed; re-rendering a whole block would re-space every
// aligned trailing comment in it.
function splicePair(pair, old, src, splices) {
  const start = old.key.range[0];
  const end = (old.value ?? old.key).range[1];
  const slice = src.slice(start, end);
  const col = start - src.lastIndexOf("\n", start - 1) - 1;
  const style = styleOf(slice, col);
  const next = renderPair(pair, style);
  if (next === renderPair(old, style)) return;

  const [a, b] = [pair.value, old.value];
  if (YAML.isMap(a) && YAML.isMap(b) && !a.flow && !b.flow && a.items.length === b.items.length) {
    const olds = new Map(b.items.map((p) => [keyOf(p), p]));
    if (a.items.every((p) => olds.has(keyOf(p)))) {
      for (const p of a.items) splicePair(p, olds.get(keyOf(p)), src, splices);
      return;
    }
  }
  const text = next.replace(/\n(?=.)/g, `\n${" ".repeat(col)}`);
  splices.push([start, end, slice.endsWith("\n") ? text : text.replace(/\n$/, "")]);
}

/**
 * Serialize `doc`, which was parsed from `src`, changing only the settings
 * whose values differ. Top-level keys may be added, never removed.
 *
 * @param {YAML.Document} doc
 * @param {string} src
 */
export function toYaml(doc, src) {
  const base = YAML.parseDocument(src);
  const before = new Map(YAML.isMap(base.contents) ? base.contents.items.map((p) => [keyOf(p), p]) : []);
  const eol = src.includes("\r\n") ? (s) => s.replace(/\r?\n/g, "\r\n") : (s) => s;

  const splices = [];
  let appended = "";
  for (const pair of doc.contents.items) {
    const old = before.get(keyOf(pair));
    if (old) splicePair(pair, old, src, splices);
    else appended += renderPair(pair, {});
  }

  let out = src;
  for (const [start, end, text] of splices.reverse()) out = out.slice(0, start) + eol(text) + out.slice(end);
  if (appended) out = `${out.replace(/\s*$/, "")}${eol("\n\n")}${eol(appended)}`.replace(/^\s+/, "");
  return out;
}
