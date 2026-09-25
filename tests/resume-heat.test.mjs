// Guards the resume heat map: band weighting, the three CV states, and that a
// hat term and its plural tool name never report as two rows.
import assert from 'node:assert/strict';
import { heatMap, postingTerms } from '../resume-heat.mjs';

const cv = `# Someone

## Experience
Shipped a full-stack React app and ran user research with clinicians.

## Skills
React, TypeScript, Figma
`;

const jd = 'We want React, TypeScript, full-stack delivery, user research, Kubernetes and LLMs (large language model work).';

const map = heatMap([
  { text: jd, band: 'premier' },
  { text: jd, band: 'ordinary' },
  { text: 'Kubernetes only.', band: 'low' },
], cv);

assert.equal(map.reachable, 2, 'low and gated postings are not reachable');
const by = Object.fromEntries(map.terms.map(t => [t.term, t]));

assert.equal(by.react.heat, 4, 'premier weighs 3, ordinary 1');
assert.equal(by.react.cv, 'named');
assert.equal(by['full-stack'].cv, 'shown', 'prose-only evidence is a Skills promotion');
assert.equal(by['user research'].cv, 'shown');
assert.equal(by.Kubernetes.cv, 'missing');
assert.equal(by.Kubernetes.postings, 2, 'the low-band posting does not count');
assert.ok(!('LLMs' in by), 'the plural tool name folds into the hat term');

const one = postingTerms(jd, cv);
assert.equal(one[0].cv, 'missing', 'gaps sort first for a single posting');

console.log('resume-heat tests passed');
