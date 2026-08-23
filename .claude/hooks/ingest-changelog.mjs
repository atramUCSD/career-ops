#!/usr/bin/env node
// SessionStart hook — career-ops only.
//
// Loads the two files that carry state between sessions:
//   1. the newest data/SESSION-HANDOFF-*.md  (the running change log)
//   2. data/PENDING-METRICS.md               (unverified numbers — do NOT ship)
//
// Emits SessionStart additionalContext. Silent no-op if neither file exists.
//
// Registered in .claude/settings.json, NOT settings.local.json: the local file
// is gitignored, so a registration there dies with the checkout it was made in.
// That is not hypothetical — it is why a session started with no handoff context
// after the window holding it was terminated. Claude Code still asks once per
// machine before running a project hook, so a fresh clone needs one /hooks open
// or a restart before this fires.
//
// The registration deliberately does NOT redirect stderr: `|| true` already
// keeps a broken hook from blocking session start, and swallowing the error too
// would make the failure invisible, which is the state this comment exists to
// prevent recurring.

import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DATA = join(ROOT, 'data')

// Cap so a long-running change log can't crowd out the session.
const MAX_CHARS = 14000

// The change log grows at the bottom, so keep its tail.
function tailTo(text, limit) {
  if (text.length <= limit) return text
  const cut = text.slice(text.length - limit)
  const nl = cut.indexOf('\n')
  return '[...earlier entries truncated — read the file directly for full history...]\n' +
    (nl === -1 ? cut : cut.slice(nl + 1))
}

// PENDING-METRICS.md leads with the OPEN ASKS block, so keep its head instead.
function headTo(text, limit) {
  if (text.length <= limit) return text
  const cut = text.slice(0, limit)
  const nl = cut.lastIndexOf('\n')
  return (nl === -1 ? cut : cut.slice(0, nl)) +
    '\n[...remainder truncated — read data/PENDING-METRICS.md directly...]'
}

function newestHandoff() {
  if (!existsSync(DATA)) return null
  const files = readdirSync(DATA)
    .filter((f) => /^SESSION-HANDOFF-.*\.md$/.test(f))
    .sort() // ISO dates in the filename sort chronologically
  return files.length ? files[files.length - 1] : null
}

const parts = []

const handoff = newestHandoff()
if (handoff) {
  parts.push(
    `## career-ops change log — data/${handoff}\n\n` +
      'Most recent first-hand record of what was changed and why. Read it before\n' +
      'editing user-layer files. Per the standing rule, append an entry here for\n' +
      'every major write you make this session.\n\n' +
      tailTo(readFileSync(join(DATA, handoff), 'utf8'), MAX_CHARS)
  )
}

const metrics = join(DATA, 'PENDING-METRICS.md')
if (existsSync(metrics)) {
  parts.push(
    '## Unverified metrics — data/PENDING-METRICS.md\n\n' +
      'GUARDRAIL: nothing in this file is verified. Do not copy any figure from it\n' +
      'into cv.md, a cover letter, an application form, or an interview answer.\n\n' +
      'The OPEN ASKS block at the top is a standing reminder list the user asked for.\n' +
      'Surface it at the END of your first substantive reply this session, even if\n' +
      'the session is about something else. See modes/_custom.md House Rules.\n\n' +
      headTo(readFileSync(metrics, 'utf8'), MAX_CHARS)
  )
}

if (!parts.length) process.exit(0)

process.stdout.write(
  JSON.stringify({
    suppressOutput: true,
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext:
        'Session state carried over from previous career-ops sessions:\n\n' +
        parts.join('\n\n---\n\n'),
    },
  })
)
