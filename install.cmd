@echo off
rem 双击安装 dsh-token-mascot 到 desktop profile（装完需完全退出并重开 DSH）
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
if errorlevel 1 pause
