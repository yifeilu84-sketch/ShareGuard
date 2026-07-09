@echo off
REM ============================================================
REM ShareGuard Pilot Experiment - Quick Run Script
REM ============================================================
REM Usage:
REM   scripts\local\run_pilot.bat              (run full pipeline)
REM   scripts\local\run_pilot.bat --skip-extract (skip feature extraction)
REM ============================================================

echo ============================================================
echo ShareGuard Pilot Experiment
echo DINOv2 frozen linear probe on 10K GenImage subset
echo ============================================================

cd /d "%~dp0\..\.."

python scripts\local\run_pilot.py --config configs\pilot\pilot_subset.yaml %*

echo.
echo Done. Check outputs\tables\pilot\ for results.
echo Check outputs\figures\pilot\ for robustness drop plot.
pause
