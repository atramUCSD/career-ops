/**
 * personalization.mjs — which personalization files still carry template
 * content. Shared by doctor.mjs and the web Home's setup checklist; doctor
 * runs checks at import time, so the rule lives here where both can import it.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { sectionState, scanHeadings, SECTIONS } from './lib/personalization.mjs';

// Personalization files that silently degrade output while still passing the
// existence check. `modes/_custom.md` is deliberately absent: it holds optional
// procedural house rules, so shipping it unedited is a valid end state. These
// two are not —
//   _profile.md unedited feeds the TEMPLATE AUTHOR's archetypes and North Star
//     into every A-F evaluation, so offers are scored against a stranger.
//   _brief.md unedited hands the triage first pass literal `{placeholders}`
//     instead of the candidate's archetypes, comp floor and hard DQ criteria.
// Explicit onboarding copies both from their templates, so existence alone
// tells us nothing about personalization — only the CONTENT does.
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
 * the existence checks' job. Templates are read from `templateRoot` (the code
 * checkout) first, so doctor and the web agree on which sections are still
 * template text even when a separate data root or profile holds an older copy;
 * `root`'s own copy only covers a checkout that ships none (#5340).
 */
export function unpersonalizedFiles(root, templateRoot = root) {
  const out = [];
  for (const { path, template, impact } of PERSONALIZATION_FILES) {
    const targetPath = join(root, ...path.split('/'));
    const checkoutTemplatePath = join(templateRoot, ...template.split('/'));
    const templatePath = existsSync(checkoutTemplatePath) ? checkoutTemplatePath : join(root, ...template.split('/'));
    if (!existsSync(targetPath) || !existsSync(templatePath)) continue;
    let target, tpl;
    try {
      target = readFileSync(targetPath, 'utf-8');
      tpl = readFileSync(templatePath, 'utf-8');
    } catch {
      continue; // unreadable → let the existence checks speak
    }
    // An empty file is neither identical to the template nor carries a
    // placeholder, so it would pass as personalized while the web asks for
    // every section (#5340).
    if (!target.trim()) {
      out.push({ path, reason: 'is empty', impact });
      continue;
    }
    if (path === 'modes/_profile.md') {
      // A _profile.md written in the user's own structure, without any of the
      // eight ## Your … headings, is quiet here rather than reported as missing
      // every section (#5126). Missing prerequisites speak for absent files.
      const userHeadings = new Set(scanHeadings(target).heads.filter((h) => h.level === 2).map((h) => h.heading));
      const hasAnyTemplateHeading = SECTIONS.some((s) => userHeadings.has(s.heading));
      if (!hasAnyTemplateHeading) {
        const left = [...templatePlaceholders(tpl)].filter((p) => target.includes(p));
        if (left.length > 0) {
          out.push({
            path,
            reason: `still has ${left.length} unfilled placeholder${left.length === 1 ? '' : 's'} (e.g. ${left[0]})`,
            impact,
          });
        }
        continue;
      }
      const states = sectionState(target, tpl);
      const unfilled = states.filter((s) => s.state !== 'filled');
      if (unfilled.length > 0) {
        const n = unfilled.length;
        const templateCount = unfilled.filter((s) => s.state === 'template').length;
        const missingCount = unfilled.filter((s) => s.state === 'missing').length;
        const ids = unfilled.map((s) => s.id).join(', ');
        out.push({
          path,
          reason: `still has ${n} unfilled section${n === 1 ? '' : 's'}: ${templateCount} on template, ${missingCount} missing (${ids})`,
          impact,
        });
      }
      continue;
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
