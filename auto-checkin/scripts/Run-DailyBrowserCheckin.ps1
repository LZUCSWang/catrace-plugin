# Daily browser check-in (simplified).
# Triggered by Task Scheduler at 13:00 daily. For each of Edge / Firefox /
# Chrome / Brave, using the logged-in profile:
#   1. open GitHub and keep it for just a few seconds (a visit is enough)
#   2. open the AnyRouter console and wait for it to load (a visit is enough)
#   3. clean up:
#      - browser was already open -> close only the temporary windows opened by this run
#      - browser was not open     -> close the whole browser afterwards

param(
    [string[]]$BrowserNames = @(),
    [int]$GitHubWaitSeconds = 10,
    [int]$AnyRouterLoadSeconds = 15,
    [int]$MaoyulinLoadSeconds = 10,
    [int]$MaoyulinButtonTimeoutSeconds = 30,
    [int]$MaoyulinLoginWaitSeconds = 15,
    [int]$PostCheckinWaitSeconds = 10
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes

# Chromium only builds the accessibility tree of web pages on demand. A
# WM_GETOBJECT / OBJID_CLIENT query against the Chrome_RenderWidgetHostHWND
# child window (exactly what a screen reader does) switches it on inside an
# already-running browser, where command-line flags would be ignored. This
# matters mostly for Brave, which additionally ships with Chromium's UIA
# provider feature disabled: fresh launches get --enable-features=UiaProvider
# below, running instances need this MSAA poke before the page content shows
# up in the UI Automation tree. Firefox windows have no such child window,
# so the poke is a harmless no-op there.
Add-Type -ReferencedAssemblies Accessibility -TypeDefinition @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using Accessibility;
public static class ChromiumAccessibilityPoke {
    private delegate bool EnumProc(IntPtr h, IntPtr lp);
    [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr hwnd, EnumProc cb, IntPtr lp);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetClassName(IntPtr h, StringBuilder sb, int max);
    [DllImport("oleacc.dll")] private static extern int AccessibleObjectFromWindow(IntPtr hwnd, uint id, ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object ppv);
    public static int PokeWindow(IntPtr topLevel) {
        List<IntPtr> widgets = new List<IntPtr>();
        EnumChildWindows(topLevel, delegate(IntPtr h, IntPtr lp) {
            StringBuilder sb = new StringBuilder(256);
            GetClassName(h, sb, 256);
            if (sb.ToString() == "Chrome_RenderWidgetHostHWND") { widgets.Add(h); }
            return true;
        }, IntPtr.Zero);
        Guid iid = new Guid("618736e0-3c3d-11cf-810c-00aa00389b71");
        foreach (IntPtr h in widgets) {
            object accObj;
            AccessibleObjectFromWindow(h, 0xFFFFFFFC, ref iid, out accObj);
            if (accObj != null) {
                try { IAccessible acc = (IAccessible)accObj; int unused = acc.accChildCount; } catch {}
            }
        }
        return widgets.Count;
    }
}
"@

# Real mouse click at screen coordinates, for elements that expose neither
# the Invoke nor the SelectionItem pattern (e.g. plain links on LinuxDO's
# OAuth consent page). The target window must be in the foreground.
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class MouseClicker {
    [DllImport("user32.dll")] private static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] private static extern void mouse_event(uint flags, uint dx, uint dy, uint data, IntPtr extra);
    public static void ClickAt(int x, int y) {
        SetCursorPos(x, y);
        mouse_event(0x0002, 0, 0, 0, IntPtr.Zero);
        mouse_event(0x0004, 0, 0, 0, IntPtr.Zero);
    }
}
"@

Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class BrowserWindowTools {
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    public static IntPtr[] GetVisibleTopLevelWindowsForPids(int[] pids) {
        HashSet<uint> wanted = new HashSet<uint>();
        foreach (int pid in pids) { wanted.Add((uint)pid); }
        List<IntPtr> windows = new List<IntPtr>();
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            if (wanted.Contains(pid) && IsWindowVisible(hWnd)) {
                windows.Add(hWnd);
            }
            return true;
        }, IntPtr.Zero);
        return windows.ToArray();
    }

    public static bool CloseWindow(IntPtr hWnd) {
        return PostMessage(hWnd, 0x0010, IntPtr.Zero, IntPtr.Zero);
    }

    public static bool WindowExists(IntPtr hWnd) {
        return IsWindow(hWnd);
    }
}
"@

$GitHubUrl = 'https://github.com/'
$AnyRouterUrl = 'https://anyrouter.top/console'
$MaoyulinUrl = 'https://api.maoyulin.xyz/console/personal'
$MaoyulinTitleKeyword = '猫羽雫API'
$Browsers = @(
    [pscustomobject]@{ Name = 'Edge';    Path = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe';       ProcessName = 'msedge';  Chromium = $true;  MaoyulinLogin = 'LinuxDO' },
    [pscustomobject]@{ Name = 'Firefox'; Path = 'C:\Program Files\Mozilla Firefox\firefox.exe';                       ProcessName = 'firefox'; Chromium = $false; MaoyulinLogin = 'GitHub' },
    [pscustomobject]@{ Name = 'Chrome';  Path = 'C:\Program Files\Google\Chrome\Application\chrome.exe';              ProcessName = 'chrome';  Chromium = $true;  MaoyulinLogin = 'GitHub' },
    [pscustomobject]@{ Name = 'Brave';   Path = 'C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe'; ProcessName = 'brave';   Chromium = $true;  MaoyulinLogin = 'GitHub' }
)
if ($BrowserNames -and $BrowserNames.Count -gt 0) {
    $Browsers = @($Browsers | Where-Object { $BrowserNames -contains $_.Name })
}
$LogFile = Join-Path $env:LOCALAPPDATA 'CodexDailyBrowserCheckin\daily-browser-checkin.log'

function Write-Log {
    param([string]$Message)
    $dir = Split-Path -Parent $LogFile
    if (-not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    Add-Content -LiteralPath $LogFile -Value ('{0} {1}' -f (Get-Date).ToString('o'), $Message) -Encoding UTF8
}

function Get-BrowserWindowHandles {
    param([pscustomobject]$Browser)
    $processIds = @(
        Get-Process -Name $Browser.ProcessName -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty Id
    )
    if ($processIds.Count -eq 0) {
        return @()
    }
    return @(
        [BrowserWindowTools]::GetVisibleTopLevelWindowsForPids([int[]]$processIds) |
            ForEach-Object { $_.ToInt64() }
    )
}

function New-BrowserWindowArguments {
    param([pscustomobject]$Browser, [string]$Url)
    if ($Browser.Chromium) {
        return @('--new-window', $Url)
    }
    return @('-new-window', $Url)
}

function Wait-NewBrowserWindow {
    param(
        [pscustomobject]$Browser,
        [long[]]$ExistingHandles,
        [int]$TimeoutSeconds = 15
    )
    $known = @{}
    foreach ($handle in $ExistingHandles) {
        $known[[string]$handle] = $true
    }
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        $newHandles = @(
            Get-BrowserWindowHandles -Browser $Browser |
                Where-Object { -not $known.ContainsKey([string]$_) }
        )
        if ($newHandles.Count -gt 0) {
            return [long]($newHandles | Select-Object -Last 1)
        }
        Start-Sleep -Milliseconds 250
    }
    return [long]0
}

function Open-TemporaryBrowserWindow {
    param([pscustomobject]$Browser, [string]$Url)
    $existingHandles = @(Get-BrowserWindowHandles -Browser $Browser)
    $arguments = New-BrowserWindowArguments -Browser $Browser -Url $Url
    Start-Process -FilePath $Browser.Path -ArgumentList $arguments
    return (Wait-NewBrowserWindow -Browser $Browser -ExistingHandles $existingHandles)
}

function Close-BrowserWindowHandle {
    param([long]$WindowHandle, [int]$TimeoutSeconds = 8)
    if ($WindowHandle -eq 0) {
        return $false
    }
    $window = [IntPtr]$WindowHandle
    if (-not [BrowserWindowTools]::WindowExists($window)) {
        return $true
    }
    [BrowserWindowTools]::CloseWindow($window) | Out-Null
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (-not [BrowserWindowTools]::WindowExists($window)) {
            return $true
        }
        Start-Sleep -Milliseconds 250
    }
    return (-not [BrowserWindowTools]::WindowExists($window))
}

# Activate a browser window: prefer a window whose title starts with the
# keyword, fall back to the browser's most recent window by process id.
function Invoke-ActivateWindow {
    param([object]$Shell, [pscustomobject]$Browser, [string]$TitleKeyword)
    if ($Shell.AppActivate($TitleKeyword)) {
        return $true
    }
    $proc = Get-Process -Name $Browser.ProcessName -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowHandle -ne 0 } |
        Sort-Object StartTime -Descending |
        Select-Object -First 1
    if ($proc) {
        return [bool]$Shell.AppActivate($proc.Id)
    }
    return $false
}

# Close one tab by activating the window whose title starts with the keyword,
# then sending Ctrl+W. If no window title matches, nothing is closed, so
# pre-existing user tabs are never touched by mistake.
function Close-TabByTitle {
    param([object]$Shell, [string]$TitleKeyword)
    if ($Shell.AppActivate($TitleKeyword)) {
        Start-Sleep -Milliseconds 500
        $Shell.SendKeys('^w')
        Start-Sleep -Milliseconds 500
        return $true
    }
    return $false
}

# Steer the active tab of the browser's matching window to a new URL by
# typing it into the address bar (Ctrl+L). Unlike Start-Process this does not
# open a second tab, which keeps the later title-based tab cleanup correct.
function Set-ActiveTabUrl {
    param([object]$Shell, [pscustomobject]$Browser, [string]$TitleKeyword, [string]$Url)
    if (-not (Invoke-ActivateWindow -Shell $Shell -Browser $Browser -TitleKeyword $TitleKeyword)) {
        return $false
    }
    Start-Sleep -Milliseconds 500
    $Shell.SendKeys('^l')
    Start-Sleep -Milliseconds 300
    $Shell.SendKeys($Url)
    Start-Sleep -Milliseconds 200
    $Shell.SendKeys('{ENTER}')
    return $true
}

# Find a button whose accessible name matches the pattern in any top-level
# window of the browser. Chromium and Firefox both expose the active tab's
# DOM as a UI Automation tree, so page buttons are reachable from outside
# without DevTools (remote debugging is blocked on default profiles anyway).
# Pass -ControlType to look for something other than a button (e.g. the
# 我已阅读并同意 checkbox on the Maoyulin login page).
function Find-ButtonByName {
    param(
        [pscustomobject]$Browser,
        [string]$NamePattern,
        [System.Windows.Automation.ControlType]$ControlType = [System.Windows.Automation.ControlType]::Button)
    $buttonCondition = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        $ControlType)
    $procs = @(Get-Process -Name $Browser.ProcessName -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowHandle -ne 0 })
    foreach ($proc in $procs) {
        try {
            $windowCondition = New-Object System.Windows.Automation.PropertyCondition(
                [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $proc.Id)
            $windows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
                [System.Windows.Automation.TreeScope]::Children, $windowCondition)
            foreach ($window in $windows) {
                [void][ChromiumAccessibilityPoke]::PokeWindow([IntPtr]$window.Current.NativeWindowHandle)
                $buttons = $window.FindAll(
                    [System.Windows.Automation.TreeScope]::Descendants, $buttonCondition)
                foreach ($button in $buttons) {
                    if ($button.Current.Name -match $NamePattern) {
                        return $button
                    }
                }
            }
        }
        catch {
            # Window vanished mid-scan or the accessibility tree was not
            # ready yet; the next polling round will retry.
        }
    }
    return $null
}

# Find any element (hyperlink, menu entry, button, ...) with this exact
# accessible name in any top-level window of the browser. Needed for controls
# that are not exposed as ControlType.Button, e.g. the 个人设置 nav item.
function Find-ElementByExactName {
    param([pscustomobject]$Browser, [string]$Name)
    $nameCondition = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::NameProperty, $Name)
    $procs = @(Get-Process -Name $Browser.ProcessName -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowHandle -ne 0 })
    foreach ($proc in $procs) {
        try {
            $windowCondition = New-Object System.Windows.Automation.PropertyCondition(
                [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $proc.Id)
            $windows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
                [System.Windows.Automation.TreeScope]::Children, $windowCondition)
            foreach ($window in $windows) {
                [void][ChromiumAccessibilityPoke]::PokeWindow([IntPtr]$window.Current.NativeWindowHandle)
                $element = $window.FindFirst(
                    [System.Windows.Automation.TreeScope]::Descendants, $nameCondition)
                if ($element) { return $element }
            }
        }
        catch {
            # Window vanished mid-scan or the accessibility tree was not
            # ready yet; the next polling round will retry.
        }
    }
    return $null
}

# Click a UIA element without the mouse when possible: Invoke pattern first,
# SelectionItem next (covers menu/nav entries), then a real mouse click at
# the element's clickable point, keyboard focus + Enter as the last resort.
function Invoke-UiaElement {
    param([object]$Shell, [pscustomobject]$Browser, [object]$Element)
    try {
        $Element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
        return
    }
    catch {}
    try {
        $Element.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select()
        return
    }
    catch {}
    try {
        $point = $Element.GetClickablePoint()
        Invoke-ActivateWindow -Shell $Shell -Browser $Browser -TitleKeyword $MaoyulinTitleKeyword | Out-Null
        Start-Sleep -Milliseconds 300
        [MouseClicker]::ClickAt([int]$point.X, [int]$point.Y)
        return
    }
    catch {}
    Invoke-ActivateWindow -Shell $Shell -Browser $Browser -TitleKeyword $MaoyulinTitleKeyword | Out-Null
    $Element.SetFocus()
    Start-Sleep -Milliseconds 300
    $Shell.SendKeys('{ENTER}')
}

# Wait for the Maoyulin page to expose its check-in button, then click it
# through the UIA Invoke pattern (no mouse movement or foreground needed).
# Returns a short status string for the log.
function Invoke-MaoyulinCheckin {
    param([object]$Shell, [pscustomobject]$Browser)
    $deadline = (Get-Date).AddSeconds($MaoyulinButtonTimeoutSeconds)
    $button = $null
    $loginHandled = $false
    $consentInfo = ''
    $agreeInfo = ''
    while ($true) {
        $button = Find-ButtonByName -Browser $Browser -NamePattern '签到'
        if ($button) { break }
        if (-not $loginHandled) {
            # An expired session redirects to /login?expired=true. The login
            # page shows both a GitHub and a LinuxDO button, so pick the one
            # this browser's account actually uses (MaoyulinLogin) instead of
            # whichever comes first in the accessibility tree; the OAuth
            # round trip then finishes on the browser's existing session.
            $loginButton = Find-ButtonByName -Browser $Browser -NamePattern ('使用\s*{0}\s*继续' -f $Browser.MaoyulinLogin)
            if ($loginButton) {
                $loginHandled = $true
                # The login page requires ticking the 我已阅读并同意 checkbox
                # before the OAuth buttons take effect. Prefer the Toggle
                # pattern (and leave it alone if already on); fall back to the
                # generic click helper for checkboxes without Toggle support.
                $agreeBox = Find-ButtonByName -Browser $Browser -NamePattern '我已阅读并同意' -ControlType ([System.Windows.Automation.ControlType]::CheckBox)
                if ($agreeBox) {
                    try {
                        $toggle = $agreeBox.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
                        if ($toggle.Current.ToggleState -ne [System.Windows.Automation.ToggleState]::On) {
                            $toggle.Toggle()
                        }
                    }
                    catch {
                        Invoke-UiaElement -Shell $Shell -Browser $Browser -Element $agreeBox
                    }
                    $agreeInfo = ' (同意 checked)'
                    Start-Sleep -Milliseconds 500
                }
                else {
                    $agreeInfo = ' (同意 not seen)'
                }
                Invoke-UiaElement -Shell $Shell -Browser $Browser -Element $loginButton
                # Wait for the OAuth round trip by polling instead of a fixed
                # sleep, so the switch to the check-in page happens as soon as
                # login finishes. LinuxDO shows a consent page with an 允许
                # control before redirecting (GitHub redirects silently); 允许
                # may be a plain link rather than a button, so fall back to an
                # exact-name search over all element types. The poll ends as
                # soon as the console is back (签到 button or 个人设置 nav
                # visible in the tree).
                $consentClicked = $false
                $loginDeadline = (Get-Date).AddSeconds($MaoyulinLoginWaitSeconds)
                while ((Get-Date) -lt $loginDeadline) {
                    Start-Sleep -Milliseconds 1500
                    if (Find-ButtonByName -Browser $Browser -NamePattern '签到') { break }
                    if (Find-ElementByExactName -Browser $Browser -Name '个人设置') { break }
                    if (-not $consentClicked) {
                        $allowButton = Find-ButtonByName -Browser $Browser -NamePattern '^允许'
                        if (-not $allowButton) {
                            $allowButton = Find-ElementByExactName -Browser $Browser -Name '允许'
                        }
                        if ($allowButton) {
                            Invoke-UiaElement -Shell $Shell -Browser $Browser -Element $allowButton
                            $consentClicked = $true
                            # Give the post-consent redirect its own full wait.
                            $loginDeadline = (Get-Date).AddSeconds($MaoyulinLoginWaitSeconds)
                        }
                    }
                }
                if ($Browser.MaoyulinLogin -eq 'LinuxDO') {
                    $consentInfo = if ($consentClicked) { ' (允许 clicked)' } else { ' (允许 not seen)' }
                }
                if (-not (Find-ButtonByName -Browser $Browser -NamePattern '签到')) {
                    # Login lands on /console/token; the check-in button only
                    # exists on /console/personal. Go there via the address
                    # bar (Ctrl+L) - clicking the 个人设置 nav item through
                    # UIA proved unreliable in Firefox.
                    Set-ActiveTabUrl -Shell $Shell -Browser $Browser -TitleKeyword $MaoyulinTitleKeyword -Url $MaoyulinUrl | Out-Null
                    Start-Sleep -Seconds $MaoyulinLoadSeconds
                }
                $deadline = (Get-Date).AddSeconds($MaoyulinButtonTimeoutSeconds)
                continue
            }
        }
        if ((Get-Date) -ge $deadline) {
            if ($loginHandled) { return ('button not found after re-login{0}{1}' -f $agreeInfo, $consentInfo) }
            return 'button not found'
        }
        Start-Sleep -Milliseconds 1500
    }
    $name = $button.Current.Name.Trim()
    if ($name -ne '立即签到' -or -not $button.Current.IsEnabled) {
        # Typically means today's reward was already collected.
        return ('skipped - button "{0}", enabled: {1}' -f $name, $button.Current.IsEnabled)
    }
    try {
        $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    }
    catch {
        # Fallback: give the button keyboard focus and press Enter.
        Invoke-ActivateWindow -Shell $Shell -Browser $Browser -TitleKeyword $MaoyulinTitleKeyword | Out-Null
        $button.SetFocus()
        Start-Sleep -Milliseconds 300
        $Shell.SendKeys('{ENTER}')
    }
    Start-Sleep -Seconds $PostCheckinWaitSeconds
    if ($loginHandled) { return ('clicked after re-login{0}{1}' -f $agreeInfo, $consentInfo) }
    return 'clicked'
}

# Inspect the console page in a browser window: detect error pages (a dead
# domain must not count as a check-in) and best-effort scrape the account
# username and balance from the accessibility tree.
function Get-ConsolePageInfo {
    param([long]$WindowHandle)
    $info = @{ Ok = $false; Error = ''; Balance = '?'; Texts = @() }
    if ($WindowHandle -eq 0) {
        $info.Error = 'page did not load (no window handle)'
        return $info
    }
    try {
        [void][ChromiumAccessibilityPoke]::PokeWindow([IntPtr]$WindowHandle)
        Start-Sleep -Milliseconds 800
        $window = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$WindowHandle)
        $elements = $window.FindAll(
            [System.Windows.Automation.TreeScope]::Descendants,
            [System.Windows.Automation.Condition]::TrueCondition)
    }
    catch {
        $info.Error = 'page did not load (uia scan failed)'
        return $info
    }
    $names = New-Object System.Collections.Generic.List[string]
    foreach ($el in $elements) {
        try { $n = $el.Current.Name } catch { $n = '' }
        if ($n) { [void]$names.Add($n) }
    }
    # Browser error pages: titles like "site - 网络错误" / "无法访问此页面".
    foreach ($n in $names) {
        if ($n -match '网络错误|无法访问|不能访问|拒绝连接|无法连接|DNS_PROBE|ERR_') {
            $info.Error = 'page did not load (browser error page)'
            return $info
        }
    }
    $info.Ok = $true
    $info.Texts = @($names | Select-Object -First 12)
    # Balance: a 余额-labeled text, then the first currency-ish value after it.
    for ($i = 0; $i -lt $names.Count; $i++) {
        if ($names[$i] -match '余额') {
            for ($j = $i + 1; $j -lt [Math]::Min($i + 6, $names.Count); $j++) {
                if ($names[$j] -match '^\s*(?:[$￥¥]\s*[\d,]+(?:\.\d+)?|[\d,]+\.\d{1,2})\s*$') {
                    $info.Balance = $names[$j].Trim()
                    break
                }
            }
            break
        }
    }
    return $info
}

foreach ($browser in $Browsers) {
    try {
        if (-not (Test-Path -LiteralPath $browser.Path)) {
            Write-Log ('{0}: executable not found, skipped.' -f $browser.Name)
            continue
        }

        # "Running" means it has a visible window (ignores background-only
        # helper processes such as Edge startup boost).
        $wasRunning = @(
            Get-Process -Name $browser.ProcessName -ErrorAction SilentlyContinue |
                Where-Object { $_.MainWindowHandle -ne 0 }
        ).Count -gt 0

        $shell = New-Object -ComObject WScript.Shell

        if ($wasRunning) {
            # Existing browser sessions keep using their logged-in profile,
            # but each check-in URL is isolated in its own temporary window.
            # Closing by the exact new window handle avoids relying on tab
            # titles such as "AnyRouter", which are not stable in Edge.
            $githubWindow = Open-TemporaryBrowserWindow -Browser $browser -Url $GitHubUrl
            Start-Sleep -Seconds $GitHubWaitSeconds
            $closedGitHub = Close-BrowserWindowHandle -WindowHandle $githubWindow

            $anyRouterWindow = Open-TemporaryBrowserWindow -Browser $browser -Url $AnyRouterUrl
            Start-Sleep -Seconds $AnyRouterLoadSeconds
            $pageInfo = Get-ConsolePageInfo -WindowHandle $anyRouterWindow
            $closedAnyRouter = Close-BrowserWindowHandle -WindowHandle $anyRouterWindow
            if (-not $pageInfo.Ok) {
                Write-Log ('{0}: failed - AnyRouter {1}.' -f $browser.Name, $pageInfo.Error)
                continue
            }
            if ($pageInfo.Balance -eq '?') {
                Write-Log ('{0}: balance not found, page texts: {1}' -f $browser.Name, ($pageInfo.Texts -join ' | '))
            }
            Write-Log ('{0}: check-in done in running browser (GitHub temporary window closed: {1}, AnyRouter visited: {2}, balance={3}).' -f $browser.Name, $closedGitHub, $closedAnyRouter, $pageInfo.Balance)
        }
        else {
            # Step 1: GitHub - a short visit is enough for the check-in.
            Start-Process -FilePath $browser.Path -ArgumentList $GitHubUrl
            Start-Sleep -Seconds $GitHubWaitSeconds

            # Step 2: AnyRouter - open the console; a visit is enough for check-in.
            $consoleWindow = Wait-NewBrowserWindow -Browser $browser -ExistingHandles @() -TimeoutSeconds 15
            Start-Process -FilePath $browser.Path -ArgumentList $AnyRouterUrl
            Start-Sleep -Seconds $AnyRouterLoadSeconds
            $pageInfo = Get-ConsolePageInfo -WindowHandle $consoleWindow


            # Step 3: cleanup.
            Get-Process -Name $browser.ProcessName -ErrorAction SilentlyContinue |
                Where-Object { $_.MainWindowHandle -ne 0 } |
                ForEach-Object { $_.CloseMainWindow() | Out-Null }
            Start-Sleep -Seconds 3
            Get-Process -Name $browser.ProcessName -ErrorAction SilentlyContinue |
                Where-Object { $_.MainWindowHandle -ne 0 } |
                Stop-Process -Force
            if (-not $pageInfo.Ok) {
                Write-Log ('{0}: failed - AnyRouter {1}.' -f $browser.Name, $pageInfo.Error)
                continue
            }
            if ($pageInfo.Balance -eq '?') {
                Write-Log ('{0}: balance not found, page texts: {1}' -f $browser.Name, ($pageInfo.Texts -join ' | '))
            }
            Write-Log ('{0}: launched, checked in (AnyRouter visited, balance={1}), browser closed.' -f $browser.Name, $pageInfo.Balance)
        }
    }
    catch {
        Write-Log ('{0}: failed - {1}' -f $browser.Name, $_.Exception.Message)
    }
}
