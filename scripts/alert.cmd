@echo off
REM scripts\alert.cmd — one scheduled career-ops run: scrape, triage, snapshot, mail.
REM
REM Every stage is deterministic. No model is invoked and nothing is ever
REM submitted on your behalf; this path reads job boards and writes one email.
REM
REM Stages 0-3 (preflight, scan, liveness, prune) are swarm.mjs's job already,
REM including the temp URL file check-liveness.mjs needs — this script does not
REM reimplement them. swarm.mjs exits non-zero on lane registration drift, which
REM is the right place for the chain to stop.
REM
REM Register with Task Scheduler (daily 07:00, repeating at 19:00):
REM   schtasks /create /tn "career-ops-alert" /tr "%~f0" /sc daily /st 07:00 /f
REM   schtasks /change /tn "career-ops-alert" /ri 720 /du 24:00
REM A daily trigger repeating every 720 minutes for 24 hours fires morning and
REM evening, which is one task rather than two competing for the same lock.
REM Run it once by hand first, then read data\alert-log.tsv.

setlocal enabledelayedexpansion
cd /d "%~dp0.."

set LOG=data\alert-log.tsv
if not exist "%LOG%" echo when	stage	result> "%LOG%"
for /f "usebackq tokens=*" %%t in (`powershell -NoProfile -Command "(Get-Date).ToString('s')"`) do set TS=%%t

call node swarm.mjs --scan --since 45 --stale 45
if errorlevel 1 goto :failed_triage

call node build-artifact.mjs
if errorlevel 1 goto :failed_artifact

REM Each profile is a projection of the scan that just ran, so there is nothing
REM to re-scrape — only a second render of the same corpus through someone
REM else's targeting. A broken profile config must never take the mail down
REM with it: the mail is the critical path and these pages are not, so a
REM failure here logs a row and the chain continues.
if exist profiles (
  for /d %%p in (profiles\*) do (
    call node build-artifact.mjs --as-profile "%%~nxp" --out "output\pipeline-%%~nxp.html"
    if errorlevel 1 echo !TS!	profile %%~nxp	FAILED - continuing>> "%LOG%"
  )
)

call node build-hub.mjs
if errorlevel 1 echo !TS!	hub	FAILED - continuing>> "%LOG%"

call node notify-email.mjs
if errorlevel 1 goto :failed_alert

echo !TS!	run	ok>> "%LOG%"
exit /b 0

REM A failed stage stops the chain. In particular a failed scan must never be
REM followed by an alert: it would report "no change" and mark a day of
REM postings as already seen, so they would never appear in any later mail.
:failed_triage
echo !TS!	triage	FAILED - snapshot and alert skipped>> "%LOG%"
exit /b 1
:failed_artifact
echo !TS!	artifact	FAILED - alert skipped>> "%LOG%"
exit /b 1
:failed_alert
echo !TS!	alert	FAILED - state left untouched, next run re-alerts>> "%LOG%"
exit /b 1
