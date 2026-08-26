@echo off
REM scripts\sweep.cmd — the weekly deep hydration pass.
REM
REM Deliberately separate from scripts\alert.cmd. The daily run is on the
REM critical path for a 07:00 email, and the two stages below are the slow
REM ones: scan-ats-full.mjs sweeps entire public ATS directories rather than a
REM company list, and a full liveness check falls back to Playwright, which is
REM sequential by design. Running them daily would push the alert late for no
REM extra coverage.
REM
REM Every stage is deterministic. No model is invoked and nothing is ever
REM submitted on your behalf.
REM
REM Register with Task Scheduler (weekly, Sunday 03:00):
REM   schtasks /create /tn "career-ops-sweep" /tr "%~f0" /sc weekly /d SUN /st 03:00 /f
REM Run it once by hand first, then read data\alert-log.tsv.

setlocal enabledelayedexpansion
cd /d "%~dp0.."

set LOG=data\alert-log.tsv
if not exist "%LOG%" echo when	stage	result> "%LOG%"
for /f "usebackq tokens=*" %%t in (`powershell -NoProfile -Command "(Get-Date).ToString('s')"`) do set TS=%%t

REM --since 10 keeps a margin over the weekly interval so a run that slips a
REM day still overlaps the previous sweep. --resume continues from the
REM 500-company checkpoint if an earlier run was interrupted.
call node scan-ats-full.mjs --since 10 --resume
if errorlevel 1 goto :failed_ats

call node scan-hn.mjs
if errorlevel 1 goto :failed_hn

REM Full two-rung liveness over everything still pending, including the
REM Playwright fallback the daily run skips with --api-only. This is what
REM tightens the "Removed (est.)" bound in data\expired-jobs.md, which is only
REM ever as tight as the checking cadence.
REM
REM check-liveness.mjs exits 1 whenever anything is expired or uncertain. That
REM is its normal report, not a failure — a sweep that finds a dead posting has
REM done its job. swarm.mjs treats it the same way. Do NOT add an
REM `if errorlevel 1` guard here: every sweep would log FAILED and the prune
REM below would never run.
set URLS=%TEMP%\career-ops-sweep-pending.txt
call node -e "import('./swarm.mjs').then(async m=>{const {readFileSync,writeFileSync}=await import('node:fs');let t='';try{t=readFileSync('data/pipeline.md','utf-8')}catch{};writeFileSync(process.argv[1],m.parsePendingRows(t).map(r=>r.url).join('\n')+'\n')})" "%URLS%"
if errorlevel 1 goto :failed_liveness
call node check-liveness.mjs --file "%URLS%" --throttle
del "%URLS%" 2>nul

call node prune-pipeline.mjs --stale 45
if errorlevel 1 goto :failed_prune

echo !TS!	sweep	ok>> "%LOG%"
exit /b 0

REM A failed stage stops the chain, same as alert.cmd. The one exception is the
REM liveness stage above, whose exit code is a finding rather than an error.
:failed_ats
echo !TS!	sweep-ats	FAILED - hn, liveness and prune skipped>> "%LOG%"
exit /b 1
:failed_hn
echo !TS!	sweep-hn	FAILED - liveness and prune skipped>> "%LOG%"
exit /b 1
:failed_liveness
echo !TS!	sweep-liveness	FAILED - could not build the pending URL list, prune skipped>> "%LOG%"
exit /b 1
:failed_prune
echo !TS!	sweep-prune	FAILED>> "%LOG%"
exit /b 1
