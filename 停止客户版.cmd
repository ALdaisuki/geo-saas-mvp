@echo off
chcp 65001 >nul
setlocal
where pwsh >nul 2>nul
if %errorlevel%==0 (
  pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-customer-demo.ps1"
) else (
  powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-customer-demo.ps1"
)
if not %errorlevel%==0 pause
