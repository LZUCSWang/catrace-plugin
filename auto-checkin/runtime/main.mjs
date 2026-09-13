/** auto-checkin sidecar — daily random-time check-in scheduler.
 *
 * Each day every configured browser gets one random time, stratified into
 * equal slots across the configured window (default 09:00-21:00) so the
 * runs spread across the day. At its time the sidecar spawns the bundled
 * PowerShell script once with -BrowserNames <name>, parses the lines the
 * script appends to its log, and publishes result/summary toasts.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const pluginId = process.env.CATRACE_PLUGIN_ID || 'auto-checkin'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = path.resolve(__dirname, '..')
const STATE_PATH = path.join(__dirname, 'state.json')
const BUNDLED_SCRIPT = path.join(PLUGIN_DIR, 'scripts', 'Run-DailyBrowserCheckin.ps1')
const DEFAULT_LOG = path.join(
  os.homedir(), 'AppData', 'Local', 'CodexDailyBrowserCheckin', 'daily-browser-checkin.log'
)

const TICK_MS = 20_000
const FIRST_TICK_MS = 1_500
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/
const STATUS_LABEL = {
  pending: '待签到', running: '运行中', ok: '已成功',
  failed: '失败', skipped: '已跳过', missed: '已错过'
}
const SUMMARY_ICON = { ok: '✅', failed: '❌', skipped: '⏭️', missed: '⚠️' }

const DEFAULT_CONFIG = {
  scriptPath: '',
  logPath: '',
  browsers: ['Edge', 'Firefox', 'Chrome', 'Brave'],
  windowStart: '09:00',
  windowEnd: '21:00',
  catchUpOnWake: true,
  graceMinutes: 10,
  timeoutMin: 15,
  toastOnSuccess: true,
  toastDurationSec: 20,
  paused: false,
}

let config = { ...DEFAULT_CONFIG }
let state = { version: 1, date: '', schedule: [], summaryPublished: false, history: [] }
let currentRun = null
let currentChild = null
const queue = []

const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
const log = (message, level = 'info', data) => send({ v: 1, op: 'log', level, message, data })

function respond(requestId, ok, result, error) {
  const message = { v: 1, op: 'response', requestId, ok }
  if (ok) message.result = result ?? null
  else message.error = error || 'request failed'
  send(message)
}

/* ---------- time helpers (local time) ---------- */

function todayStr() {
  const d = new Date()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

function nowMinutes() {
  const d = new Date()
  return d.getHours() * 60 + d.getMinutes()
}

function parseHHMM(value) {
  if (typeof value !== 'string' || !HHMM_RE.test(value)) return null
  const [h, m] = value.split(':').map(Number)
  return h * 60 + m
}

function fmtHHMM(minute) {
  const m = ((minute % 1440) + 1440) % 1440
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

function normalizeBrowsers(input) {
  const list = Array.isArray(input) ? input : String(input || '').split(',')
  const cleaned = list.map((s) => String(s).trim()).filter(Boolean)
  return [...new Set(cleaned)]
}

/* ---------- config ---------- */

function applyConfig(input = {}) {
  const next = { ...config }
  if (typeof input.scriptPath === 'string') next.scriptPath = input.scriptPath.trim()
  if (typeof input.logPath === 'string') next.logPath = input.logPath.trim()
  if (input.browsers !== undefined) next.browsers = normalizeBrowsers(input.browsers)
  if (parseHHMM(input.windowStart) != null) next.windowStart = input.windowStart
  if (parseHHMM(input.windowEnd) != null) next.windowEnd = input.windowEnd
  const ws = parseHHMM(next.windowStart)
  const we = parseHHMM(next.windowEnd)
  if (ws != null && we != null && ws >= we) {
    log(`invalid window ${next.windowStart}-${next.windowEnd}, keeping previous`, 'warn')
    next.windowStart = config.windowStart
    next.windowEnd = config.windowEnd
  }
  if (typeof input.catchUpOnWake === 'boolean') next.catchUpOnWake = input.catchUpOnWake
  next.graceMinutes = clampInt(input.graceMinutes, 1, 720, config.graceMinutes)
  next.timeoutMin = clampInt(input.timeoutMin, 1, 120, config.timeoutMin)
  if (typeof input.toastOnSuccess === 'boolean') next.toastOnSuccess = input.toastOnSuccess
  next.toastDurationSec = clampInt(input.toastDurationSec, 3, 600, config.toastDurationSec)
  if (typeof input.paused === 'boolean') next.paused = input.paused

  const shapeChanged =
    JSON.stringify(next.browsers) !== JSON.stringify(config.browsers) ||
    next.windowStart !== config.windowStart ||
    next.windowEnd !== config.windowEnd
  config = next

  // Nothing ran yet today -> safe to rebuild the plan with the new shape.
  if (shapeChanged && state.schedule.length > 0
    && state.schedule.every((e) => e.status === 'pending')) {
    state.schedule = genSchedule(config)
    log('schedule regenerated after config shape change')
  }
  saveState()
}

function currentScriptPath() {
  return config.scriptPath || BUNDLED_SCRIPT
}

function currentLogPath() {
  return config.logPath || DEFAULT_LOG
}

/* ---------- state ---------- */

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'))
    if (raw && typeof raw === 'object') {
      state = {
        version: 1,
        date: typeof raw.date === 'string' ? raw.date : '',
        schedule: Array.isArray(raw.schedule) ? raw.schedule : [],
        summaryPublished: !!raw.summaryPublished,
        history: Array.isArray(raw.history) ? raw.history : [],
      }
    }
  } catch {
    /* fresh state */
  }
}

function saveState() {
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify({
      ...state, savedAt: new Date().toISOString(),
    }, null, 2))
  } catch (e) {
    log(`save state failed: ${e}`, 'warn')
  }
}

/* ---------- schedule ---------- */

function genSchedule(cfg) {
  const start = parseHHMM(cfg.windowStart) ?? 540
  const end = parseHHMM(cfg.windowEnd) ?? 1260
  const browsers = cfg.browsers.filter(Boolean)
  if (!browsers.length || end <= start) return []
  const span = end - start
  const shuffled = browsers
    .map((browser) => ({ browser, r: Math.random() }))
    .sort((a, b) => a.r - b.r)
    .map((x) => x.browser)
  return shuffled
    .map((browser, i) => {
      // stratified: slot i covers [start + span*i/n, start + span*(i+1)/n)
      const lo = start + Math.floor((span * i) / shuffled.length)
      const hi = start + Math.floor((span * (i + 1)) / shuffled.length)
      const minute = lo + Math.floor(Math.random() * Math.max(1, hi - lo))
      return {
        browser, minute, time: fmtHHMM(minute),
        status: 'pending', runCount: 0, lastResult: null,
      }
    })
    .sort((a, b) => a.minute - b.minute)
}

function ensureToday() {
  const today = todayStr()
  if (state.date === today) return
  state.date = today
  state.summaryPublished = false
  state.schedule = genSchedule(config)
  log(`generated schedule for ${today}`, 'info',
    { plan: state.schedule.map((e) => `${e.browser}@${e.time}`) })
  saveState()
}

/* ---------- runner ---------- */

function enqueue(browser, reason) {
  if (!state.schedule.some((e) => e.browser === browser)) return false
  if (currentRun && currentRun.browser === browser) return false
  if (queue.some((j) => j.browser === browser)) return false
  queue.push({ browser, reason })
  pump()
  return true
}

async function pump() {
  if (currentRun || queue.length === 0) return
  const job = queue.shift()
  const entry = state.schedule.find((e) => e.browser === job.browser)
  if (!entry) return pump()
  currentRun = { browser: job.browser, since: Date.now(), reason: job.reason }
  try {
    await runBrowser(entry, job.reason)
  } catch (e) {
    log(`run crashed: ${job.browser}: ${e}`, 'error')
    entry.status = 'failed'
    entry.lastResult = {
      startedAt: currentRun.since, endedAt: Date.now(), durationSec: 0,
      exitCode: -1, timedOut: false, status: 'failed', summary: `调度异常：${e}`, lines: [],
    }
    saveState()
  } finally {
    currentRun = null
    maybePublishSummary()
    pump()
  }
}

function logSize(file) {
  try {
    return fs.statSync(file).size
  } catch {
    return 0
  }
}

function readNewLines(file, offsetBytes) {
  try {
    const size = fs.statSync(file).size
    if (size <= offsetBytes) return []
    const fd = fs.openSync(file, 'r')
    try {
      const buf = Buffer.alloc(size - offsetBytes)
      fs.readSync(fd, buf, 0, buf.length, offsetBytes)
      return buf.toString('utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean)
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return []
  }
}

// Write-Log prefixes every line with an ISO timestamp:
// "2026-09-13T13:00:31.1146846+08:00 Edge: launched, ..."
function stripLogTimestamp(line) {
  const m = line.match(/^\d{4}-\d{2}-\d{2}T\S+\s+(.*)$/)
  return m ? m[1] : line
}

function runPowerShell(script, browser) {
  return new Promise((resolve) => {
    const timeoutMs = Math.max(1, config.timeoutMin) * 60_000
    let child
    try {
      child = spawn('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', script, '-BrowserNames', browser,
      ], { cwd: path.dirname(script), stdio: ['ignore', 'ignore', 'pipe'] })
    } catch (e) {
      resolve({ code: -1, timedOut: false, stderrTail: String(e) })
      return
    }
    currentChild = child
    let timedOut = false
    let stderrTail = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (d) => { stderrTail = (stderrTail + d).slice(-800) })
    const timer = setTimeout(() => {
      timedOut = true
      log(`run timed out after ${config.timeoutMin}min, killing tree: ${browser}`, 'warn')
      if (child.pid) {
        try {
          spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' })
        } catch { /* ignore */ }
      }
    }, timeoutMs)
    child.on('error', (e) => {
      clearTimeout(timer)
      if (currentChild === child) currentChild = null
      resolve({ code: -1, timedOut: false, stderrTail: String(e) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (currentChild === child) currentChild = null
      if (stderrTail.trim()) log(`powershell stderr (${browser}): ${stderrTail.trim()}`, 'warn')
      resolve({ code: code ?? -1, timedOut, stderrTail })
    })
  })
}

function classify(lines, browser, code, timedOut, stderrTail) {
  const strip = (l) => l.slice(`${browser}: `.length)
  let verdict
  if (timedOut) {
    verdict = { status: 'failed', summary: `运行超时（>${config.timeoutMin} 分钟），已强制结束` }
  } else {
    const last = lines.length ? lines[lines.length - 1] : ''
    if (last.includes(': failed -')) verdict = { status: 'failed', summary: strip(last) }
    else if (last.includes('skipped')) verdict = { status: 'skipped', summary: strip(last) || '已跳过' }
    else if (lines.length) verdict = { status: 'ok', summary: strip(last) || '签到完成' }
    else if (code !== 0) {
      const first = String(stderrTail || '').split(/\r?\n/).find(Boolean) || ''
      verdict = { status: 'failed', summary: `脚本退出码 ${code}${first ? `：${first.slice(0, 160)}` : ''}` }
    } else {
      verdict = { status: 'failed', summary: '无日志输出（检查脚本路径与日志路径配置）' }
    }
  }
  // The script appends balance=<value> to its log lines.
  const joined = lines.join('\n')
  const balance = joined.match(/balance=([^,)\n]*)/)
  if (balance && balance[1].trim() && balance[1].trim() !== '?') verdict.balance = balance[1].trim()
  return verdict
}

async function runBrowser(entry, reason) {
  const script = currentScriptPath()
  const logPath = currentLogPath()
  entry.status = 'running'
  entry.runCount += 1
  saveState()
  const offset = logSize(logPath)
  const startedAt = Date.now()
  log(`run start: ${entry.browser} (${reason})`)
  const { code, timedOut, stderrTail } = await runPowerShell(script, entry.browser)
  const endedAt = Date.now()
  const lines = readNewLines(logPath, offset)
    .map(stripLogTimestamp)
    .filter((l) => l.startsWith(`${entry.browser}: `))
  const verdict = classify(lines, entry.browser, code, timedOut, stderrTail)
  entry.status = verdict.status
  entry.lastResult = {
    startedAt, endedAt, durationSec: Math.round((endedAt - startedAt) / 1000),
    exitCode: code, timedOut, status: verdict.status,
    summary: verdict.summary, lines: lines.slice(-4),
    balance: verdict.balance || null,
  }
  state.history.unshift({ date: state.date, browser: entry.browser, ...entry.lastResult })
  state.history = state.history.slice(0, 30)
  saveState()
  log(`run done: ${entry.browser} -> ${verdict.status}`)
  publishResult(entry, reason, logPath)
  maybePublishSummary()
}

/* ---------- publish ---------- */

function publishResult(entry, reason, logPath) {
  const r = entry.lastResult
  const ok = r.status === 'ok'
  if (ok && !config.toastOnSuccess && reason !== 'manual' && reason !== 'retry') return
  const reasonTag = reason === 'catchup' ? '（补跑）'
    : reason === 'manual' ? '（手动）'
      : reason === 'retry' ? '（重试）' : ''
  const level = ok ? 'success' : r.status === 'skipped' ? 'info' : 'error'
  const sticky = r.status === 'failed'
  // Success/skip cards auto-hide and carry no buttons. Failures stay until
  // dismissed, so they need both a retry and a way to close the card.
  const actions = []
  if (r.status === 'failed') {
    actions.push({ id: 'retry', label: '重试' })
    actions.push({ id: 'dismiss', label: '关闭' })
  }
  send({
    v: 1, op: 'publish', event: {
      eventType: 'auto-checkin.result',
      kind: 'auto-checkin',
      title: `${entry.browser} ${STATUS_LABEL[r.status]}${reasonTag}`,
      body: r.summary || '',
      level,
      sticky,
      actions,
      payload: {
        view: 'result',
        browser: entry.browser,
        status: r.status,
        summary: r.summary,
        balance: r.balance || null,
        plannedAt: entry.time,
        durationSec: r.durationSec,
        logPath,
        auto_hide_ms: sticky ? 0 : Math.max(3, config.toastDurationSec) * 1000,
      },
      dedupeKey: `auto-checkin:result:${state.date}:${entry.browser}:${entry.runCount}`,
    },
  })
}

function maybePublishSummary() {
  if (state.summaryPublished) return
  if (!state.schedule.length || currentRun || queue.length) return
  if (state.schedule.some((e) => e.status === 'pending' || e.status === 'running')) return
  const rows = state.schedule.map((e) =>
    `${e.browser} ${SUMMARY_ICON[e.status] || '·'} ${e.time} ${STATUS_LABEL[e.status]}`)
  const bad = state.schedule.filter((e) => e.status === 'failed' || e.status === 'missed').length
  send({
    v: 1, op: 'publish', event: {
      eventType: 'auto-checkin.summary',
      kind: 'auto-checkin',
      title: bad ? `今日签到结束（${bad} 项异常）` : '今日签到全部完成',
      body: rows.join('\n'),
      level: bad ? 'warning' : 'success',
      actions: [],
      payload: {
        view: 'summary',
        date: state.date,
        summary: rows,
        logPath: currentLogPath(),
        auto_hide_ms: Math.max(5, config.toastDurationSec) * 1000,
      },
      dedupeKey: `auto-checkin:summary:${state.date}`,
    },
  })
  state.summaryPublished = true
  saveState()
}

/* ---------- tick ---------- */

function tick() {
  try {
    ensureToday()
    if (config.paused) return
    if (currentRun) return
    const nowM = nowMinutes()
    const endM = parseHHMM(config.windowEnd) ?? 1260
    for (const entry of state.schedule) {
      if (entry.status !== 'pending' || entry.minute > nowM) continue
      const late = nowM - entry.minute
      const catchUp = config.catchUpOnWake
        ? nowM <= endM + 5
        : late <= config.graceMinutes
      if (!catchUp) {
        entry.status = 'missed'
        entry.lastResult = {
          endedAt: Date.now(), status: 'missed',
          summary: `错过 ${late} 分钟，超出补跑范围`,
        }
        log(`mark missed: ${entry.browser} (${late}min late)`, 'warn')
        saveState()
        continue
      }
      enqueue(entry.browser, late > 5 ? 'catchup' : 'scheduled')
      return
    }
    maybePublishSummary()
  } catch (e) {
    log(`tick error: ${e}`, 'error')
  }
}

/* ---------- RPC / stdin ---------- */

function statusPayload() {
  const pending = state.schedule
    .filter((e) => e.status === 'pending')
    .sort((a, b) => a.minute - b.minute)
  return {
    date: state.date,
    paused: !!config.paused,
    running: currentRun
      ? { browser: currentRun.browser, since: currentRun.since, reason: currentRun.reason }
      : null,
    queued: queue.map((j) => j.browser),
    next: pending.length
      ? { browser: pending[0].browser, time: pending[0].time }
      : null,
    schedule: state.schedule.map((e) => ({
      browser: e.browser, time: e.time, minute: e.minute, status: e.status,
      runCount: e.runCount, lastResult: e.lastResult,
    })),
    history: state.history.slice(0, 10),
    scriptPath: currentScriptPath(),
    logPath: currentLogPath(),
    config,
    now: Date.now(),
  }
}

function handleRequest(message) {
  const { requestId, method, params = {} } = message
  try {
    switch (method) {
      case 'getStatus':
        respond(requestId, true, statusPayload())
        break
      case 'setConfig':
        applyConfig(params)
        respond(requestId, true, statusPayload())
        break
      case 'runNow': {
        const wanted = normalizeBrowsers(params.browsers).filter(
          (b) => state.schedule.some((e) => e.browser === b))
        const list = wanted.length ? wanted : state.schedule.map((e) => e.browser)
        const queued = []
        for (const b of list) {
          if (enqueue(b, params.reason || 'manual')) queued.push(b)
        }
        respond(requestId, true, { queued, running: currentRun ? currentRun.browser : null })
        break
      }
      case 'reschedule': {
        // keep finished-success entries; re-roll times for the rest
        const keep = state.schedule.filter((e) => e.status === 'ok' || e.status === 'skipped')
        const redone = genSchedule(config).filter(
          (e) => !keep.some((k) => k.browser === e.browser))
        state.schedule = [...keep, ...redone].sort((a, b) => a.minute - b.minute)
        state.summaryPublished = false
        saveState()
        log('schedule re-rolled (ok/skipped kept)')
        respond(requestId, true, statusPayload())
        break
      }
      default:
        respond(requestId, false, null, `unknown method: ${method}`)
    }
  } catch (e) {
    respond(requestId, false, null, String(e))
  }
}

function handleResolved(message) {
  const actionId = message.actionId
  const payload = (message.payload && typeof message.payload === 'object') ? message.payload : {}
  if (actionId === 'retry' && payload.browser) {
    enqueue(payload.browser, 'retry')
  }
}

function gracefulShutdown() {
  log('graceful shutdown', 'info',
    { running: currentRun ? currentRun.browser : null, queued: queue.length })
  saveState()
  if (currentChild && currentChild.pid) {
    try {
      spawn('taskkill', ['/F', '/T', '/PID', String(currentChild.pid)], { stdio: 'ignore' })
    } catch { /* ignore */ }
  }
  setTimeout(() => process.exit(0), 300)
  process.exit(0)
}

/* ---------- bootstrap ---------- */

send({ v: 1, op: 'ready' })
log('auto-checkin sidecar ready', 'info', { pluginId, pid: process.pid })

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  if (message.op === 'shutdown') {
    gracefulShutdown()
    return
  }
  if (message.op === 'config' && message.config && typeof message.config === 'object') {
    applyConfig(message.config)
    ensureToday()
    return
  }
  if (message.op === 'request') {
    handleRequest(message)
    return
  }
  if (message.op === 'resolved') {
    handleResolved(message)
  }
})

loadState()
ensureToday()
const timer = setInterval(tick, TICK_MS)
timer.unref()
setTimeout(tick, FIRST_TICK_MS).unref()
