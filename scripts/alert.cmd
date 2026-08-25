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
REM Register with Task Scheduler (daily 07:00):
REM   schtasks /create /tn "career-ops-alert" /tr "%~f0" /sc daily /st 07:00 /f
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
