# 每日浏览器签到自动化

这套脚本会在 Windows 当前登录用户环境里，每天随机分散打开四个浏览器：

- Edge
- Firefox
- Chrome
- Brave

每个浏览器都会打开：

- `https://github.com/`
- `https://anyrouter.top/console`

脚本会为已经打开的浏览器新增临时签到窗口：先打开 GitHub，短等后关闭这个临时窗口，再打开 AnyRouter 控制台，等待几秒后关闭对应临时窗口。浏览器原本未打开时，会在访问后关闭本次启动的浏览器。不会留下 GitHub 或 AnyRouter 标签页。

浏览器会复用你平时的已登录会话，脚本不会关闭或最小化窗口。

## 飞书关键词

飞书机器人关键词是：

```text
签到
```

如果飞书机器人开启了“自定义关键词”安全设置，请把关键词配置为 `签到`。脚本发送的成功、失败、测试通知都会包含这个词。

## 安装

在 PowerShell 中进入本目录后运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install-DailyBrowserCheckin.ps1 -Force
```

安装后会创建当前用户计划任务：

```text
CodexDailyBrowserCheckin
```

计划任务会在这些时机运行：

- 每天 05:00
- 用户登录时
- 05:15 起每小时检查一次，持续 16 小时

实际打开浏览器的时间由脚本每天随机生成，范围是 05:00 到 21:00。

## 查看当天随机计划

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Run-DailyBrowserCheckin.ps1 -ShowPlan
```

## 手动立即执行

这会立即打开四个浏览器完成 GitHub 和 AnyRouter 访问：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Run-DailyBrowserCheckin.ps1 -RunAllNow -NoDelay
```

## 测试飞书通知

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Run-DailyBrowserCheckin.ps1 -TestNotification
```

## 日志和状态

状态文件和日志保存在：

```text
%LOCALAPPDATA%\CodexDailyBrowserCheckin
```

主要文件：

- `state-YYYY-MM-DD.json`：当天随机计划、已完成浏览器、通知状态
- `daily-browser-checkin.log`：运行日志

## 卸载

只移除计划任务：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Uninstall-DailyBrowserCheckin.ps1
```

移除计划任务并清理状态/日志：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Uninstall-DailyBrowserCheckin.ps1 -RemoveState
```
