// Federal titles name the OPM parenthetical, not the role: a 2210 posting found
// by a "web" or "React" query arrives as "IT Specialist (APPSW)". A title_filter
// built from private-sector role names drops every one of them, which is what
// scan-history showed for USAJOBS (48 skipped_title, 5 added). The positives
// below are the ones templates/portals.example.yml suggests; the titles are
// real USAJOBS rows from that history.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTitleFilter } from '../scan.mjs';

const FEDERAL = ['APPSW', 'Application Software', 'Applications Software'];
const filter = buildTitleFilter({ positive: ['Frontend', 'Web Developer', ...FEDERAL], negative: ['Intern', 'Embedded'] });

test('APPSW-series titles pass', () => {
  for (const t of [
    'IT Specialist (APPSW)',
    'IT Specialist (Applications Software)',
    'Information Technology Specialist (Application Software)',
    'Information Technology Specialist (APPSW/SYSANALYSIS)',
    'Supervisory IT Specialist (APPSW)',
  ]) assert.ok(filter(t), t);
});

test('other 2210 parentheticals and negatives still drop', () => {
  for (const t of [
    'Information Technology Specialist (INET)',
    'Information Technology Specialist (Customer Support/Network Services)',
    'IT Specialist (APPSW) Intern',
    'Embedded Application Software Engineer',
  ]) assert.ok(!filter(t), t);
});
