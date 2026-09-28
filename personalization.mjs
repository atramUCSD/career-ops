/**
 * personalization.mjs — which personalization files still carry template
 * content. Shared by doctor.mjs and the web Home's setup checklist; doctor
 * runs checks at import time, so the rule lives here where both can import it.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

// Personalization files that silently degrade output while still passing the
// existence check. `modes/_custom.md` is deliberately absent: it holds optional
// procedural house rules, so shipping it unedited is a valid end state. These
// two are not —
//   _profile.md unedited feeds the TEMPLATE AUTHOR's archetypes and North Star
//     into every A-F evaluation, so offers are scored against a stranger.
//   _brief.md unedited hands the triage first pass literal `{placeholders}`
//     instead of the candidate's archetypes, comp floor and hard DQ criteria.
// doctor auto-copies both from their templates on first run, so "the file
// exists" is guaranteed and tells us nothing — only its CONTENT does.
export const PERSONALIZATION_FILES = [
  {
    path: 'modes/_profile.md',
    template: 'modes/_profile.template.md',
    impact: 'evaluations score against the template author\'s targeting, not yours',
  },
  {
    path: 'modes/_brief.md',
    template: 'modes/_brief.template.md',
    impact: 'triage reads literal {placeholders} instead of your archetypes',
  },
];

// Placeholder tokens the template itself ships, e.g. `{Your Name}`. Comparing
// against the template's own set (rather than any `{...}` run) keeps braces the
// user legitimately wrote — a code snippet, a JSON example — from false-firing.
function templatePlaceholders(text) {
  return new Set(text.match(/\{[^{}\n]{2,60}\}/g) || []);
}

/**
 * [{ path, reason, impact }] for personalization files under `root` still
 * carrying template content. Missing files are NOT reported here — that is
 * the existence checks' job. Templates are read from `templateRoot`, which
 * differs from `root` when `root` is a profile's data directory: a profile
 * holds a copy of the template, never the template itself.
 */
export function unpersonalizedFiles(root, templateRoot = root) {
  const out = [];
  for (const { path, template, impact } of PERSONALIZATION_FILES) {
    const targetPath = join(root, ...path.split('/'));
    const templatePath = join(templateRoot, ...template.split('/'));
    if (!existsSync(targetPath) || !existsSync(templatePath)) continue;
    let target, tpl;
    try {
      target = readFileSync(targetPath, 'utf-8');
      tpl = readFileSync(templatePath, 'utf-8');
    } catch {
      continue; // unreadable → let the existence checks speak
    }
    if (target === tpl) {
      out.push({ path, reason: 'still identical to the shipped template', impact });
      continue;
    }
    const left = [...templatePlaceholders(tpl)].filter((p) => target.includes(p));
    if (left.length > 0) {
      out.push({
        path,
        reason: `still has ${left.length} unfilled placeholder${left.length === 1 ? '' : 's'} (e.g. ${left[0]})`,
        impact,
      });
    }
  }
  return out;
}
