# NEXUS Task Scheduler Setup
# Usage:
#   .\setup-task.ps1              - Setup auto-start at login (default)
#   .\setup-task.ps1 -AtStartup   - Setup auto-start at system startup (requires admin)
#   .\setup-task.ps1 -Remove      - Remove the scheduled task

param(
    [switch]$AtStartup,
    [switch]$Remove
)

$TaskName = "NEXUS-Watchdog"
$NexusDir = $PSScriptRoot
$VbsPath = Join-Path $NexusDir "run-watchdog-hidden.vbs"

# Check for admin rights if AtStartup
if ($AtStartup -and -not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "ERROR: -AtStartup requires administrator privileges" -ForegroundColor Red
    Write-Host "Run PowerShell as Administrator and try again."
    exit 1
}

# Remove existing task
function Remove-NexusTask {
    try {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
        Write-Host "Task '$TaskName' removed successfully" -ForegroundColor Green
    } catch {
        Write-Host "Task '$TaskName' not found or already removed" -ForegroundColor Yellow
    }
}

if ($Remove) {
    Remove-NexusTask
    exit 0
}

# Remove existing task before creating new one
Remove-NexusTask

# Create VBS launcher if it doesn't exist
$VbsContent = @"
' NEXUS Watchdog Hidden Launcher
' Runs watchdog.js without showing a console window

Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "$($NexusDir.Replace('\', '\\'))"
WshShell.Run "node watchdog.js", 0, False
"@

Set-Content -Path $VbsPath -Value $VbsContent -Force
Write-Host "Created: $VbsPath" -ForegroundColor Cyan

# Create the scheduled task
$Action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$VbsPath`"" -WorkingDirectory $NexusDir

if ($AtStartup) {
    # Run at system startup (requires admin)
    $Trigger = New-ScheduledTaskTrigger -AtStartup
    $Principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
    Write-Host "Setting up auto-start at SYSTEM STARTUP" -ForegroundColor Cyan
} else {
    # Run at user login (default)
    $Trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
    Write-Host "Setting up auto-start at USER LOGIN" -ForegroundColor Cyan
}

$Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1)

try {
    Register-ScheduledTask `
        -TaskName $TaskName `
        -Action $Action `
        -Trigger $Trigger `
        -Principal $Principal `
        -Settings $Settings `
        -Description "NEXUS Telegram-Claude Bridge Watchdog" `
        -Force | Out-Null

    Write-Host ""
    Write-Host "SUCCESS: Task '$TaskName' created!" -ForegroundColor Green
    Write-Host ""
    Write-Host "NEXUS will now start automatically when you log in." -ForegroundColor White
    Write-Host ""
    Write-Host "To test, run: schtasks /run /tn `"$TaskName`"" -ForegroundColor Gray
    Write-Host "To remove:   .\setup-task.ps1 -Remove" -ForegroundColor Gray
} catch {
    Write-Host "ERROR: Failed to create task: $_" -ForegroundColor Red
    exit 1
}
