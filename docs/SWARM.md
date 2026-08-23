# Swarm — the end-to-end conductor

`swarm.mjs` runs the job hunt as one sequence instead of five scripts a human
remembers to run in the right order: **discover → liveness → prune → classify
into role families → (phase 2) pre-screen → evaluate → stage an application
package for review.**

It is not a replacement for `batch/batch-runner.sh`. That script already owns
worker dispatch, the PID pool, the state lock, report-number reservation, retry
and rate-limit pause, and post-run reconciliation. The conductor owns the stages
that never existed, and shells out to the runner for evaluation.

**Nothing is ever submitted.** The pipeline stops at a package staged for a human.

## The Playwright boundary

The conductor is the only process in a swarm run that may hold a browser.
Liveness runs `check-liveness.mjs --api-only`, which never opens one; anything
needing a rendered page is fetched serially here and handed to a worker as a
file. Workers are launched with `--strict-mcp-config` and no MCP servers, so
`modes/_shared.md`'s "never 2+ agents with Playwright in parallel" holds by
construction rather than by convention.

## Lanes (role families)

A lane is one role family carried end to end. `config/lanes.yml` names it once:

```yaml
lanes:
  - id: devrel
    archetype: "Developer Relations / Developer Advocate"
    title_keywords: ["Developer Relations", "Developer Advocate", "DevRel"]
    jd_gate:
      positive: ["community", "documentation", "sdk"]
      negative: ["quota", "commission"]
    max_evaluations: 8
```

Copy `config/lanes.example.yml` to start. The real file is gitignored, like
`config/profile.yml`.

Two couplings matter, and both are checked rather than generated:

- `title_keywords` must be **byte-identical** to entries in `portals.yml` →
  `title_filter.positive`. That literal string is the mechanism —
  `matchedTitleKeywords()` returns the as-written keyword, which is already how
  `content_filter.by_title_keyword` attaches a content gate to a title keyword.
- `archetype` must appear in `modes/_profile.md`, `modes/_shared.md`,
  `batch/batch-prompt.md` and `config/profile.yml`. A family registered on the
  scan side but not the evaluation side is the expensive failure: the postings
  arrive and are scored as some *other* archetype, and the report reads
  perfectly plausibly.

```bash
node swarm.mjs --check-lanes    # report drift, exit 1 if a lane is unregistered
```

The checker never edits those files — `portals.yml`, `modes/_profile.md` and
`config/profile.yml` are the user's own gitignored data, and a generator writing
into them would fight their edits.

All lanes share one A–G rubric. A lane changes the framing a worker is given,
never a dimension weight, so a DevRel role stays comparable to a Forward
Deployed one.

## Running it

```bash
node swarm.mjs --dry-run --max-evals 8     # print the plan; write nothing
node swarm.mjs --stale 90 --max-evals 5    # sweep, prune, then plan
node swarm.mjs --scan --since 180          # discover first (see the backfill note)
```

| Stage | What runs | Cost |
|-------|-----------|------|
| 0 preflight | lane parse + registration check, `cv-sync-check.mjs` | free |
| 1 discover (`--scan`) | `scan.mjs` | free |
| 2 liveness | `check-liveness.mjs --api-only` | free, no browser |
| 3 prune | `prune-pipeline.mjs [--stale N]` | free |
| 4a classify | `laneForTitle` per pending row — deterministic, no model | free |

Rows no lane claims are not dropped: the original AI/front-end targeting has no
lane of its own and is carried in a `core` bucket, uncapped except by the global
budget. Selection interleaves lanes round-robin so one family with 200 fresh
postings cannot starve one with three, and is stable — the same pending list
produces the same picks, so a resumed run dispatches the same set.

### Backfill after adding a lane

`max_posting_age_days` in `portals.yml` also feeds `resolveEarlyStopMs`, which
truncates pagination. The first scan after adding a lane therefore needs a wider
window, or a live three-month-old posting in the new family never surfaces at
all:

```bash
node scan.mjs --since 180     # once, by hand, after adding a lane
```

## Seeing the pipeline

```bash
node build-artifact.mjs     # renders every pending row as one HTML page
```

Lanes are the page's primary axis, and each row shows the title keyword that
admitted it — the same string the lane matched on, so the page doubles as the
audit trail for keyword noise. See [SCRIPTS.md](SCRIPTS.md#build-artifact).

## Tests

```bash
node test-all.mjs --only lanes        # classification, gates, registration drift
node test-all.mjs --only swarm-plan     # row parsing, caps, lane interleaving
node test-all.mjs --only artifact-build # page generation, bands, escaping
node test-all.mjs --only callback-score # reply-odds prior: caps, geography, bounds
node test-all.mjs --only notify-email # alert diff, MIME, credential handling
```
