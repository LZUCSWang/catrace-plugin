$ErrorActionPreference = 'Stop'

$scriptPath = Join-Path $PSScriptRoot 'Run-DailyBrowserCheckin.ps1'
$content = Get-Content -LiteralPath $scriptPath -Raw

$checks = @(
    [pscustomobject]@{
        Name = 'GitHub visit remains enabled'
        Pass = $content -match 'Start-Process\s+-FilePath\s+\$browser\.Path\s+-ArgumentList\s+\$GitHubUrl'
    },
    [pscustomobject]@{
        Name = 'AnyRouter visit remains enabled'
        Pass = $content -match 'Start-Process\s+-FilePath\s+\$browser\.Path\s+-ArgumentList\s+\$AnyRouterUrl'
    },
    [pscustomobject]@{
        Name = 'GitHub default wait is doubled to 4 seconds'
        Pass = $content -match '\[int\]\$GitHubWaitSeconds\s*=\s*4\b'
    },
    [pscustomobject]@{
        Name = 'AnyRouter default wait is doubled to 10 seconds'
        Pass = $content -match '\[int\]\$AnyRouterLoadSeconds\s*=\s*10\b'
    },
    [pscustomobject]@{
        Name = 'Running browser opens GitHub in a tracked temporary window'
        Pass = $content -match 'Open-TemporaryBrowserWindow\s+-Browser\s+\$browser\s+-Url\s+\$GitHubUrl'
    },
    [pscustomobject]@{
        Name = 'Running browser opens AnyRouter in a tracked temporary window'
        Pass = $content -match 'Open-TemporaryBrowserWindow\s+-Browser\s+\$browser\s+-Url\s+\$AnyRouterUrl'
    },
    [pscustomobject]@{
        Name = 'Running browser closes GitHub by exact window handle'
        Pass = $content -match 'Close-BrowserWindowHandle\s+-WindowHandle\s+\$githubWindow'
    },
    [pscustomobject]@{
        Name = 'Running browser closes AnyRouter by exact window handle'
        Pass = $content -match 'Close-BrowserWindowHandle\s+-WindowHandle\s+\$anyRouterWindow'
    },
    [pscustomobject]@{
        Name = 'Running browser main loop no longer uses GitHub title cleanup'
        Pass = $content -notmatch 'Close-TabByTitle\s+-Shell\s+\$shell\s+-TitleKeyword\s+''GitHub'''
    },
    [pscustomobject]@{
        Name = 'Running browser main loop no longer uses AnyRouter title cleanup'
        Pass = $content -notmatch 'Close-TabByTitle\s+-Shell\s+\$shell\s+-TitleKeyword\s+''AnyRouter'''
    },
    [pscustomobject]@{
        Name = 'Maoyulin browser launch is disabled in main loop'
        Pass = $content -notmatch 'Start-Process\s+-FilePath\s+\$browser\.Path\s+-ArgumentList\s+\$maoyulinArgs'
    },
    [pscustomobject]@{
        Name = 'Maoyulin check-in click is disabled in main loop'
        Pass = $content -notmatch 'Invoke-MaoyulinCheckin\s+-Shell\s+\$shell\s+-Browser\s+\$browser'
    },
    [pscustomobject]@{
        Name = 'Maoyulin tab cleanup is disabled in main loop'
        Pass = $content -notmatch 'Close-TabByTitle\s+-Shell\s+\$shell\s+-TitleKeyword\s+\$MaoyulinTitleKeyword'
    }
)

$failed = @($checks | Where-Object { -not $_.Pass })
foreach ($check in $checks) {
    $status = if ($check.Pass) { 'PASS' } else { 'FAIL' }
    Write-Host ('{0}: {1}' -f $status, $check.Name)
}

if ($failed.Count -gt 0) {
    throw ('Static checks failed: {0}' -f (($failed | Select-Object -ExpandProperty Name) -join '; '))
}
