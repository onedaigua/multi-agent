@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0upload-to-git.ps1" %*
if errorlevel 1 (
  echo.
  pause
) else if "%~1"=="" (
  echo.
  pause
)
