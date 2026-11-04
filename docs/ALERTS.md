# Scheduled email alerts

One scheduled run scrapes the boards, retires what died, rebuilds the snapshot
page, and mails you what changed. Every stage is deterministic — no model is
invoked, and nothing is ever submitted on your behalf.

```
swarm.mjs --scan --stale     scan → liveness → prune
enrich-jd.mjs --skip linkedin.com   read new descriptions (not fatal)
build-artifact.mjs           output/pipeline-artifact.html
notify-email.mjs             diff against last alert → one email
```

`node runner.mjs alert` chains them, with the profile layers, hub and calendar
steps between the page and the mail, and appends a row to `data/alert-log.tsv`.

## What arrives

A diff, never a dump. The mail carries postings that are new since the last
alert, postings that have since reached the premier or strong match band, and the
count of retirements. A run with nothing new sends no mail at all.

Two payloads:

- **The message body** — a static, inline-styled table of the top rows by reply
  odds. Deliberately not the artifact HTML: mail clients strip `<script>`,
  external stylesheets and CSS custom properties, so the interactive page cannot
  render in an inbox. The two views are different documents on purpose.
- **The attachment** — `output/pipeline-artifact.html` whole, ~400KB,
  self-contained, opens fully interactive in a browser.

## Setup

### 1. Configure

```bash
cp config/alerts.example.yml config/alerts.yml   # then set alerts.to
```

`config/alerts.yml` is gitignored. Credentials do not live in it.

### 2. Mint a send-scoped token

`plugins/gmail` already carries an OAuth desktop client for read-only ingest.
Sending reuses the same client and adds one scope.

1. In Google Cloud Console, on the same OAuth client, run the consent flow again
   requesting `https://www.googleapis.com/auth/gmail.send`.
2. Put the resulting refresh token in `.env` as **`GMAIL_SEND_REFRESH_TOKEN`** —
   its own variable, so the ingest token stays read-only and either can be
   revoked without touching the other.

> **Publish the consent screen to Production.** Left in *Testing*, Google expires
> refresh tokens after 7 days and the scheduled alert dies silently after one
> week. Self-consent for your own account needs no Google review. This is the
> single most common way this integration breaks.

### 3. Seed, then verify

```bash
node notify-email.mjs --seed      # mark the current pipeline known, send nothing
node notify-email.mjs --dry-run   # writes output/alert-preview.eml, sends nothing
node notify-email.mjs             # first real send
```

Seeding matters: a first run against an established pipeline is a backlog, not
an alert. Without `--seed` the first mail reports every posting you already
know about.

### 4. Schedule

```bash
node runner.mjs install           # add --sync for the cloud sync task, --dry-run to print only
```

This builds `career-ops.exe` (a windowless launcher compiled from
`scripts/launcher.cs` with the .NET Framework `csc` that ships with Windows)
and registers `career-ops-alert` at 07:00 and 19:00 and `career-ops-sweep` on
Sunday at 03:00, both pointed at it, plus `career-ops-dashboard`, which runs
`career-ops.exe serve` at logon to start the web dashboard without opening a
browser. The launcher only runs
`node runner.mjs <command>` and appends its output to `data/runner-log-<command>.txt`, one log per command so an alert that overlaps the Sunday sweep is not locked out of a shared log;
every decision about which stage runs and which failure stops what lives in
`runner.mjs`, so a fix to the chain never needs a rebuild of the exe. The tasks
run on battery, wake the machine, and start late if a slot was missed. Windows
turns wake timers off on battery by default, so a closed laptop off the charger
runs the missed slots as one late run when it next wakes. Nothing is dropped,
because each mail is a diff against the last one sent.
`scripts/alert.cmd` and `scripts/sweep.cmd` remain as shims for a task still
registered on them.

`career-ops.exe` with no command opens the web dashboard at
http://127.0.0.1:3000, starting it hidden first if nothing answers there (about
15 seconds, logged to `data/web-log.txt`). The server stays up until
`career-ops.exe stop` or logoff, so later launches open it at once. It runs
`next dev`, which holds about 900 MB and compiles each page on its first visit.
Every launch also writes `output/status.html`: the tasks' last and next runs,
the recent log rows, and links to the pages. The exe opens that page as well
when a chain's latest run logged FAILED, and alone when the dashboard does not
come up. That page (or `data/alert-log.tsv`) is what to hand to whoever
maintains the install.

Daily is the right cadence: freshness is the largest timing discount in the
match model (a posting past its first weeks is scored down to ×0.60), so a day
of latency is a real cost.

Task Scheduler, not `CronCreate`. Every stage here is deterministic — putting a
model in the loop would cost tokens and require Claude to be running.
`CronCreate` stays the right tool if you later schedule the *evaluation* stage,
which does need a model.

## Two-tier cadence

The daily alert is not the whole hydration story. Two scheduled tasks run, and
they cover different ground:

| Task | When | Script | Covers |
|---|---|---|---|
| `career-ops-alert` | daily 07:00 and 19:00 | `career-ops.exe alert` | `swarm.mjs --scan` over the `portals.yml` company and board list, API-only liveness and description reads (both skip LinkedIn), prune, then the email |
| `career-ops-sweep` | weekly, Sunday 03:00 | `career-ops.exe sweep` | `scan-ats-full.mjs` reverse-ATS sweep, `scan-hn.mjs`, **full** liveness over every pending URL, LinkedIn included, with the Playwright fallback, prune |

The deep pass is separate for two reasons. It is slow — `scan-ats-full.mjs`
sweeps entire public ATS directories instead of a company list, and a full
liveness check falls back to Playwright, which is sequential by design. And it
is off the critical path — the daily run has an email to deliver at 07:00, and
nothing in the deep pass changes what that email says today.

Only the sweep reaches companies that are not in `portals.yml` at all. The
daily scan can only find a posting at a company you already track; the reverse
sweep is keyword-first across the whole Greenhouse/Lever/Ashby/Workday/iCIMS
directory, so it is how a company enters the pipeline in the first place.

One behavioural note that the sweep encodes deliberately:
`check-liveness.mjs` exits 1 whenever anything is expired or uncertain. That
is its normal report, not a failure — a sweep that finds a dead posting has done
its job. `swarm.mjs` already treats it that way, and the sweep must too.
A naive copy of the alert chain's stop-on-failure guard after that stage would
make every sweep log FAILED and skip the prune.

The same exit 1 also covers a crash, so `swarm.mjs` tells the two apart by
whether the check printed its `Results:` line. One that died before it exits
`swarm.mjs` with 3 once prune has run, and the alert logs
`liveness FAILED - continuing` and still sends the mail. The sweep checks the
same line and logs `sweep-liveness FAILED - continuing` before it prunes.
Without that, a liveness stage that recorded nothing looked the same as one
that found nothing.

LinkedIn is left out of the daily liveness check (`--liveness-skip
linkedin.com`). Its guest endpoint is paced at 3.5 s a request, and with about
3,300 LinkedIn URLs pending that held every alert run for more than three hours
before the mail. The weekly sweep checks them.

Both tasks append to `data/alert-log.tsv`.

## Calendar events

`calendar-alert.mjs` puts a Google Calendar event on the calendar for each
pending posting that clears a stricter bar than the mail: the
`alerts.calendar` rules in `config/alerts.yml` (score floor, company list,
title keywords, locations, excluded hosts, slot time). The alert chain
runs it after the hub build and before the mail, so a failure in either one
does not stop the other.

1. In Google Cloud Console, enable the **Google Calendar API** on the project
   that owns the mail's OAuth client.
2. `node scripts/mint-gmail-token.mjs --calendar` mints a `calendar.events`
   token into `.env` as `GCAL_REFRESH_TOKEN`. It is a separate token, so it can
   be revoked without touching the mail.
3. `node calendar-alert.mjs --dry-run` lists what would be created. Then set
   `calendar.enabled: true`.

Each event id is a hash of the posting URL. Calendar refuses a second insert
of the same id with 409, so the twice-daily runs never duplicate an event and
no state file is needed.

## Failure posture

State is written **only** after Gmail returns 2xx. A failed send leaves every
posting marked unseen, so the next run re-alerts rather than silently dropping a
day of postings. A failed scan stops the chain before the alert, for the same
reason — an alert after a failed scan would report "no change" and mark those
postings as seen forever.

A corrupt `data/alert-state.json` is treated as a first run. One noisy email
beats a silent scheduler.

## Known limitation

**A scheduled run cannot republish the artifact.** `Artifact` is a Claude Code
tool, not a CLI, so a headless `node` run cannot call it. The mail therefore
attaches a freshly built snapshot (always current) and links the last version
published from a Claude session (may lag). Set `artifact_url` in
`config/alerts.yml` to include the link, or leave it blank to omit it.

## Files

| Path | Role |
|---|---|
| `notify-email.mjs` | diff, compose, send |
| `gmail-send.mjs` | transport only — OAuth refresh + `messages/send` |
| `calendar-alert.mjs` | Calendar events for postings that pass `alerts.calendar` |
| `config/alerts.yml` | recipient, threshold, row cap (gitignored) |
| `data/alert-state.json` | seen/strong URL sets + last run (gitignored) |
| `data/alert-log.tsv` | one row per scheduled run |
| `runner.mjs` | the scheduled chains, the task install, the status page |
| `scripts/launcher.cs` | source of `career-ops.exe`, the windowless launcher the tasks run |
| `data/runner-log-<command>.txt` | the launched runs' console output, one file per command (`home` for no arguments) |

```bash
node test-all.mjs --only notify-email
```
