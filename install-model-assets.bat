@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-model-assets.ps1" %*
set "install_exit_code=%ERRORLEVEL%"
echo.
if "%install_exit_code%"=="0" (
  echo Model asset installation completed.
) else (
  echo Model asset installation failed with exit code %install_exit_code%.
)
pause
exit /b %install_exit_code%
