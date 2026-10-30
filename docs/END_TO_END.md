# End to end: workflow, system, surfaces, and the definition of done

This document maps career-ops from first setup to a submitted application. For
each stage it says what "done" means and which check proves it. Those checks run
against a synthetic persona instead of the two profiles the system was tuned
on, so a rule that quietly reads one person's values shows up as a failure
rather than as a page that looks right to its author.

```bash
node --test tests/persona-e2e.test.mjs
```

The persona lives in `tests/fixtures/personas/general/`. It contains config and
data only: no code path knows it exists.

## The problem space

A job seeker wants the few postings worth an application today and the reason
each one made the cut. They do not want to read five hundred listings, and they
do not want anything submitted for them. "Done" for the system means:

- a new person can describe their targeting in config alone;
- every posting that reaches them was found, is still live, fits that targeting,
  and carries its reasons;
- every posting that was held back names the rule that held it back;
- nothing they see describes someone else's targeting.

## Personas

### The general persona

Riley Moreno is synthetic. Riley is a data and backend engineer with about four
years of experience, based in Chicago, who wants hybrid work in Chicago or a
remote US role. Riley holds a bachelor's degree and no clearance, and needs no
visa. Riley's floor is $140K, and Riley skips roles that ask for more than six
years. Riley reads the mail on a phone in the morning and wants a calendar block
at 18:30 Central for the best match of the day.

Every scoring key in Riley's profile differs from the maintainer profiles: role
family, home metro, region rule, years ceiling, comp floor, time zone, and no
hats model.

### Persona axes

| Axis | Owner profile | Second profile | Riley (general) | New grad (not built) | EU (not built) |
|---|---|---|---|---|---|
| Role family | UI/UX, front end, forward deployed | embedded, firmware | data, backend | software engineer | backend |
| Home metro | Southern California to Bay Area | California | Chicago | anywhere in the US | Berlin |
| Clearance | held | held | none | none | n/a |
| Sector bonus | none | government | none | none | none |
| Hats model | on | off | off | off | off |
| Years ceiling | none | set | 6 | 1 | none |
| Work authorization | citizen | citizen | citizen | needs sponsorship | needs a permit |
| Floor currency | USD | USD | USD | USD | EUR |
| Checked by | live data | live data | `persona-e2e` | nothing yet | nothing yet |

The two unbuilt columns mark axes the system has no rule for yet. See
[Open findings](#open-findings).

## Workflow: who does each step

Blue steps run unattended on a schedule. Amber steps call a model. Green steps
are the person's.

```mermaid
flowchart TB
  setup["Setup<br/>profile.yml · lanes.yml<br/>portals.yml · alerts.yml"]:::human
  scan["Discover<br/>swarm.mjs --scan"]:::auto
  live["Liveness and prune<br/>check-liveness --api-only"]:::auto
  cls["Classify into lanes"]:::auto
  read["Read descriptions<br/>enrich-jd.mjs"]:::auto
  score["Gate and score<br/>callback-score.mjs"]:::auto
  page["Snapshot page<br/>build-artifact.mjs"]:::auto
  cal["Calendar event<br/>calendar-alert.mjs"]:::auto
  mail["Diff mail<br/>notify-email.mjs"]:::auto
  review["Review on phone<br/>mail · page · hub"]:::human
  eval["Evaluate A to G<br/>career-ops mode, batch"]:::model
  tailor["Tailor CV and cover letter"]:::model
  apply["Submit the application"]:::human
  track["Tracker and follow-ups<br/>data/applications.md"]:::human
  setup --> scan --> live --> cls --> read --> score --> page
  page --> cal
  page --> mail
  cal --> review
  mail --> review
  review --> eval --> tailor --> apply --> track
  track -. "replies calibrate the bands" .-> score
  classDef auto fill:#dde8f3,stroke:#2b5d8a,color:#14202b
  classDef model fill:#f3e6d0,stroke:#8a5a1f,color:#2b1d0c
  classDef human fill:#dfeedb,stroke:#3f6b37,color:#16240f
```

The line between blue and green is the product's main promise. Everything above
"Review" is deterministic and never acts on the person's behalf. Everything
below it either asks a model or waits for the person.

## System: one scheduled run

`scripts/alert.cmd` runs at 07:00 and 19:00. A failed scan or page build stops
the chain before the mail, because a mail sent after a failed scan would mark a
day of postings as seen. Every other failure is logged and the chain continues.

```mermaid
flowchart TB
  start(["Task Scheduler<br/>07:00 and 19:00"]) --> swarm
  swarm["swarm.mjs --scan --stale<br/>preflight · scan · liveness · prune"]
  swarm -- "fails" --> stopA["log, stop<br/>no mail, postings stay unseen"]
  swarm -- "ok" --> enrich["enrich-jd.mjs<br/>skips linkedin.com"]
  enrich -- "ok or logged failure" --> build["build-artifact.mjs"]
  build -- "fails" --> stopB["log, stop"]
  build -- "ok" --> loop{"each profiles/*"}
  loop -- "has config/alerts.yml" --> sep["separate layer<br/>own scan, page and mail<br/>--root profiles/name"]
  loop -- "no alerts.yml" --> proj["projection page<br/>--as-profile name"]
  loop --> hub["build-hub.mjs"]
  hub --> calA["calendar-alert.mjs<br/>owner only"]
  calA --> mailA["notify-email.mjs"]
  mailA -- "fails" --> stopC["state untouched<br/>next run re-alerts"]
  mailA -- "ok" --> log[("data/alert-log.tsv")]
  swarm -. "HTTPS" .-> ats[["Greenhouse · Lever · Ashby<br/>Workday · iCIMS APIs"]]
  enrich -. "HTTPS" .-> ats
  calA -. "OAuth, calendar.events" .-> gcal[["Google Calendar"]]
  mailA -. "OAuth, gmail.send" .-> gmail[["Gmail"]]
```

A weekly sweep, `scripts/sweep.cmd` on Sunday at 03:00, is the only path that
finds companies missing from `portals.yml`. It is off this diagram because
nothing it does changes the morning mail.

## Data: which files each stage reads and writes

```mermaid
flowchart LR
  portals["portals.yml"] --> scan["scan"]
  scan --> pipe["data/pipeline.md"]
  scan --> hist["data/scan-history.tsv"]
  pipe --> liveness["liveness and prune"]
  liveness --> expired["data/expired-jobs.md"]
  liveness --> pipe
  pipe --> enrich["enrich-jd"]
  enrich --> facts["data/jd-facts.tsv"]
  profile["config/profile.yml"] --> model["buildModel"]
  lanes["config/lanes.yml"] --> model
  pipe --> model
  hist --> model
  facts --> model
  apps["data/applications.md"] --> model
  model --> html["output/pipeline-artifact.html"]
  model --> calSel["calendar selectRows"]
  model --> diff["mail diffRows"]
  alerts["config/alerts.yml"] --> calSel
  alerts --> diff
  state["data/alert-state.json"] <--> diff
```

`buildModel` in `build-artifact.mjs` is the single join. The page, the calendar
step and the mail all select from the rows it returns, so a posting cannot score
one way on the page and another way in the mail.

## Profile layers

The intent files (`config/profile.yml` and `config/lanes.yml`) decide how rows
are scored. The data files decide which rows exist. A profile under `profiles/`
uses one of two modes, and the mode depends on whether it has its own
`config/alerts.yml`.

```mermaid
flowchart TB
  subgraph owner["Owner layer (repo root)"]
    oData["data/ · portals.yml"]
    oIntent["config/profile.yml · lanes.yml"]
  end
  subgraph projection["Projection: profiles/name without alerts.yml"]
    pIntent["config/profile.yml · lanes.yml"]
  end
  subgraph separate["Separate layer: profiles/name with alerts.yml"]
    sData["data/ · portals.yml"]
    sIntent["config/ · alerts.yml"]
  end
  oData -- "rows" --> pPage["page: owner's rows, profile's scores<br/>unmatched titles dropped"]
  pIntent -- "scores" --> pPage
  sData -- "rows" --> sPage["page and mail: own rows, own scores<br/>unmatched titles kept, scored low"]
  sIntent -- "scores" --> sPage
  oData --> oPage["owner page, mail, calendar"]
  oIntent --> oPage
```

The persona fixture has its own `alerts.yml`, so the scheduler would run it as a
separate layer. The test builds it that way, and builds it a second time as a
projection to check that unmatched titles are dropped.

## Surfaces: what the person sees, and where

| Surface | Produced by | When | Readable on a phone |
|---|---|---|---|
| Mail body: top rows by match, new and upgraded | `notify-email.mjs` | after each run with a change | yes, static inline HTML |
| Mail attachment: the whole page | `build-artifact.mjs` | same mail | opens in a browser |
| Calendar event: one per posting over the stricter bar | `calendar-alert.mjs` | slot time in the profile's zone | yes |
| Pipeline page: rows, scores, reasons, gates, funnel | `build-artifact.mjs` | each run | yes, when published as an artifact |
| Hub: links to every profile's page | `build-hub.mjs` | each run | yes |
| Web app: board, pipeline, apply, CV studio, follow-ups | `web/` (Next.js) | on demand, local | no, it runs on localhost |
| Interview invite file | `ics-interview` | on demand | yes |

## Definition of done, stage by stage

| Stage | Done when | Check | Covered for Riley |
|---|---|---|---|
| Setup | A new person configures targeting by editing config only | the fixture is config and data only | yes |
| Discover | Postings that match `title_filter.positive` reach `pipeline.md` | scan and provider tests | no, needs the network |
| Liveness | A closed posting leaves the pipeline and is logged | liveness and prune tests | no, needs the network |
| Classify | Each row lands in the lane its title keyword names | `classify` | yes |
| Read | Description facts land in `jd-facts.tsv` | enrich-jd tests | the fixture supplies facts |
| Gate | Each profile-owned rule stops its row and names itself | `gate` | yes |
| Segment | Locations bucket by the profile's own home metro | `segment` | yes |
| Rank | A fresh home-metro primary role outranks above-level and remote | `rank` | yes |
| Project | Titles outside the target roles score low, or drop under a projection | `project` | yes |
| Page | Nothing on the page describes another person's targeting | `page` | yes |
| Mail | A first run reports every ungated row over the floor | `mail` | yes |
| Calendar | Stricter bar, profile's own zone, no LinkedIn | `calendar` | yes |
| Thresholds | Every floor in the profile's `alerts.yml` can be reached | `thresholds` | yes |
| Evaluate | A to G report with a 1 to 5 fit score | `evals/golden` | no, needs a model |
| Apply | A human submits; nothing is sent automatically | apply-runner tests | no |
| Track | The tracker row joins back to its posting | artifact-build tests | not for Riley |

## Findings from the first run

Three single-user assumptions were fixed in the same change that added the
persona:

- The `core` lane label read "AI / front-end / forward-deployed" on every
  profile's page. It now names the profile's own `target_roles.primary`.
- The scoring footer and the signal table described the three-hats model to
  profiles that never turned it on. Both now follow `scoring.hats`.
- The funnel label "Match ≥ 42" was a second copy of the strong band's floor.
  It now reads the floor from `BANDS`.

### Open findings

1. **Score ceiling for profiles without hats.** When a profile has no hats
   model, the title family is the whole fit, capped at 0.62 for a primary
   title. With no framework, clearance or sector bonus, the best possible score
   is 62. A calendar floor of 65 therefore selects nothing for Riley, and gives
   no warning. Reading the description can lower these scores, through a gate,
   but can never raise them. The fix is a decision about the cap: lifting it for
   rows whose description was read would rescale the second profile's scores,
   and its floors would need retuning.
2. **The calendar step uses one Google account.** `alert.cmd` runs
   `calendar-alert.mjs` for the owner only, so the `alerts.calendar` block in a
   separate layer never runs. Running it would place that person's events on
   the owner's calendar. The two candidate shapes are an attendee invite to the
   layer's `alerts.to` address, or a token per layer.
3. **The default time zone is the owner's.** `alerts.calendar.time_zone`
   defaults to `America/Los_Angeles`. Riley's config sets
   `America/Chicago`, and without that line the event would land at 18:30
   Pacific.
4. **No work-authorization fact.** `enrich-jd` extracts no sponsorship or
   authorization terms, so a person who needs sponsorship gets no gate on
   postings that rule it out.
5. **The floor has no currency.** `parseMoney` ignores the currency, so a EUR
   floor is compared with whatever number the description states.
