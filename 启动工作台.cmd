@echo off
"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0studio\start.ps1"
if errorlevel 1 pause
