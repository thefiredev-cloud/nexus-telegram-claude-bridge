@echo off
cd /d %%~dp0
powershell -ExecutionPolicy Bypass -File start-all.ps1
