@echo off
chcp 65001 >nul
setlocal
where docker >nul 2>nul
if not %errorlevel%==0 (
  echo [GEO 客户版] 未检测到 Docker Desktop。
  echo 正在打开官方下载页面，安装并启动后再次双击本文件。
  start "" "https://www.docker.com/products/docker-desktop/"
  pause
  exit /b 1
)
docker info >nul 2>nul
if not %errorlevel%==0 (
  echo [GEO 客户版] Docker Desktop 已安装，但尚未启动。
  echo 请启动 Docker Desktop，等待状态正常后再次双击本文件。
  pause
  exit /b 1
)
where pwsh >nul 2>nul
if %errorlevel%==0 (
  pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-customer-demo.ps1"
) else (
  powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-customer-demo.ps1"
)
if not %errorlevel%==0 pause
