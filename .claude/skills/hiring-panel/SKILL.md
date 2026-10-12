---
name: hiring-panel
description: >-
  Run a resume past seven isolated reviewer agents (an ATS screen, a hiring
  manager at 10 seconds, a hiring manager on a full read, a competing applicant,
  a CEO, a 30-second recruiter and a future teammate). Merge their findings into
  one ranked, line-referenced defect list, rewrite the resume inside the
  career-ops fact gate, and rerun the ATS screen blind for a before/after read.
  Use when the user invokes /hiring-panel or asks for a panel or multi-persona
  review of their resume or CV.
argument-hint: "[resume path | report # | company] [JD path | URL | report #] [--research]"
user-invocable: true
---

# hiring-panel

A career-ops mode with its own entry point. The procedure lives in `modes/hiring-panel.md`, and this file only loads it.

1. Derive `PROJECT_ROOT`: start at this file's directory and walk upward to the nearest directory that contains both `AGENTS.md` and `modes/`. Resolve every path against it, never against the process's working directory.
2. Read `config/profile.yml` if it exists, and take `language.output` (default `en`).
3. Read `modes/_profile.md` if it exists, then `modes/_custom.md` if it exists, then `modes/hiring-panel.md`.
4. Execute `modes/hiring-panel.md` with the arguments below. Inject this directive into every reader brief:

   > Write all human-facing output in `{language.output}` regardless of the language of these instructions or of the job description.

Arguments are positional and both optional:

- **First:** the resume, as a path (`.pdf`, `.html`, `.md`, `.txt`), a report number, or a company slug. A report or company resolves to that role's tailored CV. With nothing given, the resume is `cv.md`.
- **Second:** the JD, as a `jds/` path, a URL, or a report number. Pasted text anywhere in the message also counts.
- **`--research`:** ground the two hiring-manager readers with `hm-audit`'s web research step.
