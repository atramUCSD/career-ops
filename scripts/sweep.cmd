@echo off
REM scripts\sweep.cmd: the weekly deep hydration pass. The chain and its
REM fail-stop rules live in runner.mjs ("sweep"). This shim keeps a Task
REM Scheduler entry registered on this file working; `node runner.mjs install`
REM moves the entry to career-ops.exe. Results go to data\alert-log.tsv.
cd /d "%~dp0.."
node runner.mjs sweep
exit /b %errorlevel%
