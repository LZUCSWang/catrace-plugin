param(
    [switch]$Force,
    [switch]$SkipRegister
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$TaskName = 'CodexDailyBrowserCheckin'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RunScript = Join-Path $ScriptDir 'Run-DailyBrowserCheckin.ps1'

function New-CheckinTaskTriggers {
    param([string]$UserName = $env:USERNAME)

    $dailyTimes = @('05:00', '09:00', '13:00', '17:00', '20:30')
    $triggers = @()
    foreach ($time in $dailyTimes) {
        $triggers += New-ScheduledTaskTrigger -Daily -At ([datetime]$time)
    }
    $triggers += New-ScheduledTaskTrigger -AtLogOn -User $UserName
    return $triggers
}

if ($SkipRegister) {
    return
}

if (-not (Test-Path -LiteralPath $RunScript)) {
    throw "Run script not found: $RunScript"
}

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing -and -not $Force) {
    throw "Scheduled task '$TaskName' already exists. Re-run with -Force to replace it."
}
if ($existing) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

$powerShellPath = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$argument = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f $RunScript
$action = New-ScheduledTaskAction -Execute $powerShellPath -Argument $argument

$triggers = New-CheckinTaskTriggers -UserName $env:USERNAME

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 30)

$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$task = New-ScheduledTask -Action $action -Trigger $triggers -Settings $settings -Principal $principal -Description 'Open Edge, Firefox, Chrome, and Brave daily for GitHub and AnyRouter check-in.'

Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null

Write-Host "Installed scheduled task: $TaskName"
Write-Host "Run script: $RunScript"
Write-Host "State/log root: $env:LOCALAPPDATA\CodexDailyBrowserCheckin"
Write-Host "Tip: run '.\Run-DailyBrowserCheckin.ps1 -ShowPlan' to view today's randomized plan."
