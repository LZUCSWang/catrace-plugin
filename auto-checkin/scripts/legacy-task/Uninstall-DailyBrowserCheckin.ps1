param(
    [switch]$RemoveState
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$TaskName = 'CodexDailyBrowserCheckin'
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue

if ($existing) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed scheduled task: $TaskName"
}
else {
    Write-Host "Scheduled task not found: $TaskName"
}

if ($RemoveState) {
    $stateRoot = Join-Path $env:LOCALAPPDATA 'CodexDailyBrowserCheckin'
    if (Test-Path -LiteralPath $stateRoot) {
        Remove-Item -LiteralPath $stateRoot -Recurse -Force
        Write-Host "Removed state/log root: $stateRoot"
    }
}
