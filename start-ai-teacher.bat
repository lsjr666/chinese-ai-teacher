@echo off
setlocal
title AI Teacher Launcher
cd /d "%~dp0"

echo.
echo ==========================================
echo        AI Teacher local launcher
echo ==========================================
echo Project: %CD%
echo.

netstat -ano | findstr /R /C:":8080 .*LISTENING" >nul
if errorlevel 1 (
  echo Starting local vision model on port 8080...
  start "AI Teacher - Model" powershell.exe -NoProfile -ExecutionPolicy Bypass -NoExit -File "%~dp0scripts\start-llama-server.ps1"
) else (
  echo Model port 8080 is already running.
)

netstat -ano | findstr /R /C:":8090 .*LISTENING" >nul
if errorlevel 1 (
  echo Starting local math model on port 8090...
  start "AI Teacher - Math Model" powershell.exe -NoProfile -ExecutionPolicy Bypass -NoExit -File "%~dp0scripts\start-math-server.ps1"
) else (
  echo Math model port 8090 is already running.
)

rem The science model ships either as a quantised GGUF (llama.cpp) or as the full
rem bfloat16 checkpoint (Python). Only start it when nothing is still downloading.
set "SCIENCE_READY="
if exist "%~dp0models\Intern-S1-mini-GGUF\*.gguf" (
  dir /b "%~dp0models\Intern-S1-mini-GGUF\*.part" >nul 2>&1
  if errorlevel 1 set "SCIENCE_READY=1"
)
if not defined SCIENCE_READY (
  if exist "%~dp0models\Intern-S1-mini\config.json" (
    dir /b "%~dp0models\Intern-S1-mini\*.part" >nul 2>&1
    if errorlevel 1 set "SCIENCE_READY=1"
  )
)

if defined SCIENCE_READY (
  netstat -ano | findstr /R /C:":8100 .*LISTENING" >nul
  if errorlevel 1 (
    echo Starting local science model on port 8100...
    start "AI Teacher - Science Model" powershell.exe -NoProfile -ExecutionPolicy Bypass -NoExit -File "%~dp0scripts\start-science-server.ps1"
  ) else (
    echo Science model port 8100 is already running.
  )
) else (
  echo Science model not installed; deep thinking on science subjects will fall back to the vision model.
)

netstat -ano | findstr /R /C:":8787 .*LISTENING" >nul
if errorlevel 1 (
  echo Starting backend on port 8787...
  start "AI Teacher - Backend" powershell.exe -NoProfile -ExecutionPolicy Bypass -NoExit -File "%~dp0scripts\start-backend.ps1"
) else (
  echo Backend port 8787 is already running.
)

netstat -ano | findstr /R /C:":5173 .*LISTENING" >nul
if errorlevel 1 (
  echo Starting frontend on port 5173...
  start "AI Teacher - Frontend" powershell.exe -NoProfile -ExecutionPolicy Bypass -NoExit -File "%~dp0scripts\start-client.ps1"
) else (
  echo Frontend port 5173 is already running.
)

echo.
echo Waiting for the frontend...
for /l %%i in (1,1,30) do (
  curl.exe -s -f http://127.0.0.1:5173/ >nul 2>&1
  if not errorlevel 1 goto frontend_ready
  timeout /t 1 /nobreak >nul
)

echo Frontend did not respond within 30 seconds.
echo Keep this window open and inspect the service windows.
pause
exit /b 1

:frontend_ready
echo Frontend is ready.
echo.
echo Computer: http://localhost:5173/
echo Phone: use the computer hotspot IPv4 address with port 5173.
echo Available IPv4 addresses:
ipconfig | findstr /I "IPv4"
echo Phone URL format: http://HOTSPOT_IPV4:5173/
start "" http://localhost:5173/
echo.
echo The service windows must remain open while you use the app.
pause
