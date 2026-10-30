@echo off
REM scripts\alert.cmd: one scheduled career-ops run (scrape, triage, snapshot,
REM mail). The chain and its fail-stop rules live in runner.mjs ("alert"). This
REM shim keeps a Task Scheduler entry registered on this file working;
REM `node runner.mjs install` moves the entry to career-ops.exe, which runs the
REM same chain with no console window. Results go to data\alert-log.tsv.
cd /d "%~dp0.."
node runner.mjs alert
exit /b %errorlevel%
