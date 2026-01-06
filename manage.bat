@echo off
setlocal enabledelayedexpansion

title NEXUS Management Console
cd /d "%~dp0"

:menu
cls
echo.
echo  =============================================
echo          NEXUS Management Console
echo  =============================================
echo.
echo    1. Start with Watchdog (recommended)
echo    2. Start Direct (no auto-restart)
echo    3. Stop Bridge
echo    4. View Status
echo    5. View Bridge Logs
echo    6. View Watchdog Logs
echo    7. Open Admin Panel
echo    8. Setup Auto-Start (on login)
echo    9. Remove Auto-Start
echo    0. Exit
echo.
set /p choice="  Enter choice [0-9]: "

if "%choice%"=="1" goto start_watchdog
if "%choice%"=="2" goto start_direct
if "%choice%"=="3" goto stop_bridge
if "%choice%"=="4" goto view_status
if "%choice%"=="5" goto view_bridge_logs
if "%choice%"=="6" goto view_watchdog_logs
if "%choice%"=="7" goto open_admin
if "%choice%"=="8" goto setup_autostart
if "%choice%"=="9" goto remove_autostart
if "%choice%"=="0" goto exit

echo.
echo  Invalid choice. Press any key to continue...
pause >nul
goto menu

:start_watchdog
cls
echo.
echo  Starting NEXUS with Watchdog...
echo.
echo  The watchdog will automatically restart the bridge if it crashes.
echo  Press Ctrl+C to stop.
echo.
node watchdog.js
echo.
echo  Watchdog stopped. Press any key to return to menu...
pause >nul
goto menu

:start_direct
cls
echo.
echo  Starting NEXUS Bridge directly...
echo.
echo  NOTE: This mode does NOT auto-restart on crash.
echo  Press Ctrl+C to stop.
echo.
node bridge.js
echo.
echo  Bridge stopped. Press any key to return to menu...
pause >nul
goto menu

:stop_bridge
cls
echo.
echo  Stopping NEXUS Bridge...
echo.

REM Find and kill node processes running bridge.js or watchdog.js
for /f "tokens=2" %%a in ('tasklist /fi "imagename eq node.exe" /fo list ^| find "PID:"') do (
    wmic process where "ProcessId=%%a" get CommandLine 2>nul | find "bridge.js" >nul && (
        echo  Stopping bridge.js [PID: %%a]
        taskkill /pid %%a /f >nul 2>&1
    )
    wmic process where "ProcessId=%%a" get CommandLine 2>nul | find "watchdog.js" >nul && (
        echo  Stopping watchdog.js [PID: %%a]
        taskkill /pid %%a /f >nul 2>&1
    )
)

echo.
echo  Done. Press any key to return to menu...
pause >nul
goto menu

:view_status
cls
echo.
echo  =============================================
echo              NEXUS Status
echo  =============================================
echo.

REM Check if bridge is running
set bridge_running=NO
set watchdog_running=NO

for /f "tokens=2" %%a in ('tasklist /fi "imagename eq node.exe" /fo list ^| find "PID:"') do (
    wmic process where "ProcessId=%%a" get CommandLine 2>nul | find "bridge.js" >nul && set bridge_running=YES
    wmic process where "ProcessId=%%a" get CommandLine 2>nul | find "watchdog.js" >nul && set watchdog_running=YES
)

echo  Bridge Status:   !bridge_running!
echo  Watchdog Status: !watchdog_running!
echo.

REM Show health file if exists
if exist health.json (
    echo  --- Health Data ---
    type health.json
    echo.
)

REM Show admin token
if exist .admin-token (
    echo.
    echo  --- Admin Token ---
    set /p token=<.admin-token
    echo  !token!
    echo.
)

echo.
echo  Press any key to return to menu...
pause >nul
goto menu

:view_bridge_logs
cls
echo.
echo  =============================================
echo           Bridge Logs (Last 50 lines)
echo  =============================================
echo.

if exist bridge.log (
    powershell -Command "Get-Content bridge.log -Tail 50"
) else (
    echo  No bridge.log found.
)

echo.
echo  Press any key to return to menu...
pause >nul
goto menu

:view_watchdog_logs
cls
echo.
echo  =============================================
echo         Watchdog Logs (Last 50 lines)
echo  =============================================
echo.

if exist watchdog.log (
    powershell -Command "Get-Content watchdog.log -Tail 50"
) else (
    echo  No watchdog.log found.
)

echo.
echo  Press any key to return to menu...
pause >nul
goto menu

:open_admin
cls
echo.
echo  Opening Admin Panel...
echo.

REM Try to get port from admin-server.js or default to 3000
set port=3000
start http://localhost:%port%

echo  Opened http://localhost:%port% in browser.
echo.

REM Show admin token if exists
if exist .admin-token (
    echo  --- Your Admin Token ---
    set /p token=<.admin-token
    echo  !token!
    echo.
    echo  Copy this token to log in to the admin panel.
)

echo.
echo  Press any key to return to menu...
pause >nul
goto menu

:setup_autostart
cls
echo.
echo  Setting up Auto-Start...
echo.
echo  This will configure NEXUS to start automatically when you log in.
echo.

powershell -ExecutionPolicy Bypass -File setup-task.ps1

echo.
echo  Press any key to return to menu...
pause >nul
goto menu

:remove_autostart
cls
echo.
echo  Removing Auto-Start...
echo.

powershell -ExecutionPolicy Bypass -File setup-task.ps1 -Remove

echo.
echo  Press any key to return to menu...
pause >nul
goto menu

:exit
echo.
echo  Goodbye!
echo.
exit /b 0
