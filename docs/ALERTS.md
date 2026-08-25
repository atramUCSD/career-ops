# Scheduled email alerts

One scheduled run scrapes the boards, retires what died, rebuilds the snapshot
page, and mails you what changed. Every stage is deterministic — no model is
invoked, and nothing is ever submitted on your behalf.

```
swarm.mjs --scan --stale     scan → liveness → prune
build-artifact.mjs           output/pipeline-artifact.html
notify-email.mjs             diff against last alert → one email
```

`scripts/alert.cmd` chains the three and appends a row to `data/alert-log.tsv`.

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

```bat
schtasks /create /tn "career-ops-alert" /tr "C:\path\to\career-ops\scripts\alert.cmd" /sc daily /st 07:00 /f
```

Daily is the right cadence: freshness is the largest timing discount in the
match model (a posting past its first weeks is scored down to ×0.60), so a day
of latency is a real cost.

Task Scheduler, not `CronCreate`. Every stage here is deterministic — putting a
model in the loop would cost tokens and require Claude to be running.
`CronCreate` stays the right tool if you later schedule the *evaluation* stage,
which does need a model.

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
| `config/alerts.yml` | recipient, threshold, row cap (gitignored) |
| `data/alert-state.json` | seen/strong URL sets + last run (gitignored) |
| `data/alert-log.tsv` | one row per scheduled run |
| `scripts/alert.cmd` | the scheduled chain |

```bash
node test-all.mjs --only notify-email
```
