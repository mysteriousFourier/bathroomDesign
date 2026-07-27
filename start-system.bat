@echo off
setlocal
cd /d "%~dp0"

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-system.ps1" %*
set "START_EXIT_CODE=%ERRORLEVEL%"

if not "%START_EXIT_CODE%"=="0" (
  echo.
  echo Startup failed. Review the message above, then press any key to close.
  pause >nul
)

exit /b %START_EXIT_CODE%
