# Start Telegram-Claude Bridge + Admin Panel
$bridgeDir = $PSScriptRoot

# Kill existing bridge processes
Get-WmiObject Win32_Process -Filter "name='node.exe'" | ForEach-Object {
    if ($_.CommandLine -match "bridge\.js|admin-server\.js") {
        Write-Host "Killing PID $($_.ProcessId): $($_.CommandLine.Substring(0, [Math]::Min(80, $_.CommandLine.Length)))"
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

Start-Sleep -Seconds 1

# Start bridge in background
Write-Host "Starting bridge.js..."
Start-Process -WindowStyle Hidden -FilePath "node" -ArgumentList "bridge.js" -WorkingDirectory $bridgeDir

# Start admin server in background
Write-Host "Starting admin-server.js..."
Start-Process -WindowStyle Hidden -FilePath "node" -ArgumentList "admin-server.js" -WorkingDirectory $bridgeDir

Start-Sleep -Seconds 2

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "  Both services started!" -ForegroundColor Green
Write-Host "  Admin Panel: http://localhost:3000" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Green
Write-Host ""

# Open browser
Start-Process "http://localhost:3000"
