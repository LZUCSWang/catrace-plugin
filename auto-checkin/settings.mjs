/** auto-checkin settings — today's plan, run/pause controls, schedule config. */
const vue = globalThis.__CATRACE_VUE__ || {}
const naive = globalThis.__CATRACE_NAIVE__ || {}
const { h, ref, computed, onMounted, onBeforeUnmount } = vue
const { NButton, NInput, NSwitch, NTag, NAlert, NTooltip, useMessage } = naive

if (typeof h !== 'function' || typeof ref !== 'function') {
  throw new Error('Catrace plugin Vue runtime missing (__CATRACE_VUE__.h)')
}
if (!NButton || !NInput || !NSwitch || !NTag || !NAlert || !NTooltip || !useMessage) {
  throw new Error('Catrace plugin naive runtime missing (__CATRACE_NAIVE__)')
}
if (!plugin || !plugin.config || !plugin.shell || !plugin.setEnabled) {
  throw new Error('Catrace plugin API missing (plugin facade)')
}

const PLUGIN_ID = 'auto-checkin'
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/
const STATUS_LABEL = {
  pending: '待签到', running: '运行中', ok: '已成功',
  failed: '失败', skipped: '已跳过', missed: '已错过',
}
const STATUS_TAG = {
  pending: 'default', running: 'info', ok: 'success',
  failed: 'error', skipped: 'default', missed: 'warning',
}

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

const STYLE_ID = 'catrace-plugin-auto-checkin-settings-css'
const CSS = `
.ac-set { width:100%; box-sizing:border-box; display:flex; flex-direction:column; gap:0.75rem; color:#1f2328; }
.ac-set *, .ac-set *::before, .ac-set *::after { box-sizing:border-box; }
.ac-set .card {
  padding:1rem 1.25rem; border:0.0625rem solid #d0d7de; border-radius:0.875rem;
  background:#fff; display:flex; flex-direction:column; gap:0.75rem;
}
.ac-set .head { display:flex; align-items:center; justify-content:space-between; gap:0.75rem; flex-wrap:wrap; }
.ac-set h2 { margin:0; font-size:0.9375rem; font-weight:700; color:#1f2328; }
.ac-set .desc { margin:0; font-size:0.8125rem; line-height:1.55; color:#656d76; }
.ac-set .field { display:flex; flex-direction:column; gap:0.375rem; min-width:0; flex:1; }
.ac-set .label { font-size:0.75rem; font-weight:600; color:#656d76; }
.ac-set .hint { margin:0; font-size:0.6875rem; color:#8b949e; line-height:1.45; }
.ac-set .row { display:flex; align-items:flex-start; justify-content:space-between; gap:0.75rem; flex-wrap:wrap; }
.ac-set .row-inline { display:flex; align-items:center; gap:0.5rem; flex-wrap:wrap; }
.ac-set .num { width:6.5rem; }
.ac-set .unit { font-size:0.75rem; color:#656d76; font-weight:600; }
.ac-set .actions { display:flex; flex-wrap:wrap; gap:0.5rem; }
.ac-set .switch-pair { display:inline-flex; align-items:center; gap:0.5rem; font-size:0.8125rem; color:#424a53; font-weight:500; }
.ac-set .plan-head, .ac-set .plan-row {
  display:grid; grid-template-columns:5.5rem 3.5rem 4rem 1fr auto; gap:0.5rem;
  align-items:center; font-size:0.75rem; padding:0.375rem 0.5rem; border-radius:0.5rem;
}
.ac-set .plan-head { color:#656d76; font-weight:600; background:transparent; }
.ac-set .plan-row { background:#f6f8fa; color:#1f2328; }
.ac-set .plan-row .sum { color:#656d76; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ac-set .plan-row .mini {
  border:0; border-radius:999px; padding:0.1875rem 0.5rem; background:#7c3aed;
  color:#fff; font-size:0.6875rem; font-weight:700; cursor:pointer; white-space:nowrap;
}
.ac-set .plan-row .mini:hover { filter:brightness(1.05); }
.ac-set .status-line { font-size:0.75rem; color:#424a53; display:flex; gap:0.75rem; flex-wrap:wrap; }
.ac-set .status-line strong { color:#0969da; font-weight:650; }
`

function ensureStyles() {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID)) return
  const el = document.createElement('style')
  el.id = STYLE_ID
  el.textContent = CSS
  document.head.appendChild(el)
}

function clamp(n, min, max, fallback) {
  const v = Number(n)
  if (!Number.isFinite(v)) return fallback
  return Math.min(max, Math.max(min, Math.round(v)))
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

export default {
  name: 'AutoCheckinSettings',
  setup(_props, { expose }) {
    ensureStyles()
    const message = useMessage()
    const loading = ref(true)
    const busy = ref('')
    const headerLoading = ref(false)
    const enabled = ref(true)
    const status = ref(null)
    let saveTimer = null
    let pollTimer = null

    const windowStart = ref(DEFAULT_CONFIG.windowStart)
    const windowEnd = ref(DEFAULT_CONFIG.windowEnd)
    const browsersStr = ref(DEFAULT_CONFIG.browsers.join(', '))
    const catchUpOnWake = ref(DEFAULT_CONFIG.catchUpOnWake)
    const graceMinutes = ref(DEFAULT_CONFIG.graceMinutes)
    const timeoutMin = ref(DEFAULT_CONFIG.timeoutMin)
    const toastOnSuccess = ref(DEFAULT_CONFIG.toastOnSuccess)
    const toastDurationSec = ref(DEFAULT_CONFIG.toastDurationSec)
    const scriptPath = ref('')
    const logPath = ref('')
    const paused = ref(false)

    const headerEnabled = computed(() => enabled.value !== false)

    function currentConfig() {
      const browsers = browsersStr.value
        .split(/[,，]/)
        .map((s) => s.trim())
        .filter(Boolean)
      return {
        scriptPath: String(scriptPath.value || '').trim(),
        logPath: String(logPath.value || '').trim(),
        browsers: [...new Set(browsers)],
        windowStart: windowStart.value,
        windowEnd: windowEnd.value,
        catchUpOnWake: catchUpOnWake.value !== false,
        graceMinutes: clamp(graceMinutes.value, 1, 720, DEFAULT_CONFIG.graceMinutes),
        timeoutMin: clamp(timeoutMin.value, 1, 120, DEFAULT_CONFIG.timeoutMin),
        toastOnSuccess: toastOnSuccess.value !== false,
        toastDurationSec: clamp(toastDurationSec.value, 3, 600, DEFAULT_CONFIG.toastDurationSec),
        paused: paused.value !== false,
      }
    }

    function applyConfig(cfg = {}) {
      if (typeof cfg.scriptPath === 'string') scriptPath.value = cfg.scriptPath
      if (typeof cfg.logPath === 'string') logPath.value = cfg.logPath
      if (Array.isArray(cfg.browsers) && cfg.browsers.length) {
        browsersStr.value = cfg.browsers.join(', ')
      }
      if (HHMM_RE.test(cfg.windowStart)) windowStart.value = cfg.windowStart
      if (HHMM_RE.test(cfg.windowEnd)) windowEnd.value = cfg.windowEnd
      if (typeof cfg.catchUpOnWake === 'boolean') catchUpOnWake.value = cfg.catchUpOnWake
      graceMinutes.value = clamp(cfg.graceMinutes, 1, 720, DEFAULT_CONFIG.graceMinutes)
      timeoutMin.value = clamp(cfg.timeoutMin, 1, 120, DEFAULT_CONFIG.timeoutMin)
      if (typeof cfg.toastOnSuccess === 'boolean') toastOnSuccess.value = cfg.toastOnSuccess
      toastDurationSec.value = clamp(cfg.toastDurationSec, 3, 600, DEFAULT_CONFIG.toastDurationSec)
      paused.value = cfg.paused === true
    }

    async function run(key, task) {
      busy.value = key
      try {
        await task()
      } catch (error) {
        message.error(errorText(error))
      } finally {
        busy.value = ''
      }
    }

    async function persistAndSync({ quiet = false } = {}) {
      const cfg = currentConfig()
      if (!cfg.browsers.length) {
        if (!quiet) message.error('浏览器列表不能为空')
        return
      }
      if (!HHMM_RE.test(cfg.windowStart) || !HHMM_RE.test(cfg.windowEnd)) {
        if (!quiet) message.error('时间格式应为 HH:MM，如 09:00')
        return
      }
      if (cfg.windowStart >= cfg.windowEnd) {
        if (!quiet) message.error('窗口开始时间必须早于结束时间')
        return
      }
      windowStart.value = cfg.windowStart
      windowEnd.value = cfg.windowEnd
      await plugin.config.set(cfg)
      try {
        if (plugin.sidecar && typeof plugin.sidecar.request === 'function') {
          const result = await plugin.sidecar.request('setConfig', cfg)
          if (result && typeof result === 'object') status.value = result
        }
        if (!quiet) message.success('已保存')
      } catch (error) {
        if (!quiet) message.warning('已保存（启用插件后生效）')
        await plugin.log?.warn?.('config saved without sidecar', { error: errorText(error) })
      }
    }

    function scheduleSave() {
      if (saveTimer) clearTimeout(saveTimer)
      saveTimer = setTimeout(() => {
        saveTimer = null
        persistAndSync({ quiet: true }).catch((e) => message.error(errorText(e)))
      }, 500)
    }

    async function refreshStatus() {
      if (!plugin.sidecar || typeof plugin.sidecar.request !== 'function') {
        status.value = { error: 'sidecar 未运行（启用插件后可查看状态）' }
        return
      }
      const result = await plugin.sidecar.request('getStatus')
      status.value = result && typeof result === 'object' ? result : { raw: result }
    }

    function runBrowser(browser) {
      run(`run-${browser}`, async () => {
        if (!plugin.sidecar?.request) {
          message.warning('sidecar 未运行（请先启用插件）')
          return
        }
        const result = await plugin.sidecar.request('runNow', {
          browsers: [browser], reason: 'manual',
        })
        message.success(result?.queued?.includes(browser)
          ? `${browser} 已开始运行`
          : `${browser} 正在运行或已排队`)
        await refreshStatus()
      })
    }

    function runAll() {
      run('run-all', async () => {
        if (!plugin.sidecar?.request) {
          message.warning('sidecar 未运行（请先启用插件）')
          return
        }
        const result = await plugin.sidecar.request('runNow', { reason: 'manual' })
        const count = result?.queued?.length || 0
        message.success(count
          ? `已排队 ${count} 个浏览器（依次运行）`
          : '当前都在运行中或已排队')
        await refreshStatus()
      })
    }

    function reschedule() {
      run('reschedule', async () => {
        if (!plugin.sidecar?.request) {
          message.warning('sidecar 未运行（请先启用插件）')
          return
        }
        const result = await plugin.sidecar.request('reschedule')
        status.value = result
        message.success('已为未完成的浏览器重新随机分配时刻')
      })
    }

    function openLog() {
      run('open-log', async () => {
        const target = status.value?.logPath
        if (!target) {
          message.warning('启用插件后才能定位日志文件')
          return
        }
        await plugin.shell.openPath(target)
      })
    }

    function togglePaused(val) {
      paused.value = val === true
      run('pause', async () => {
        await persistAndSync({ quiet: true })
        message.success(val ? '已暂停：今日时刻保留，恢复后按补跑规则继续' : '已恢复调度')
      })
    }

    async function toggleEnabled(val) {
      const previous = enabled.value
      enabled.value = val
      headerLoading.value = true
      try {
        await plugin.setEnabled(val)
        await plugin.config.set(currentConfig())
        window.dispatchEvent(
          new CustomEvent('catrace:plugin-enabled-changed', {
            detail: { id: PLUGIN_ID, enabled: val },
          }),
        )
      } catch (e) {
        enabled.value = previous
        message.error(errorText(e))
      } finally {
        headerLoading.value = false
      }
    }

    onMounted(() => {
      run('boot', async () => {
        loading.value = true
        try {
          const raw = await plugin.config.get()
          applyConfig(raw && typeof raw === 'object' ? raw : DEFAULT_CONFIG)
          try {
            await refreshStatus()
          } catch {
            status.value = null
          }
        } finally {
          loading.value = false
        }
      })
      pollTimer = setInterval(() => {
        refreshStatus().catch(() => {})
      }, 5000)
    })

    onBeforeUnmount(() => {
      if (pollTimer) clearInterval(pollTimer)
      if (saveTimer) clearTimeout(saveTimer)
    })

    expose({
      headerEnabled,
      headerLoading,
      toggleEnabled,
    })

    function planRow(entry) {
      const r = entry.lastResult
      const btnLabel = entry.status === 'pending' ? '立即跑'
        : entry.status === 'failed' || entry.status === 'missed' ? '重试' : '再跑'
      return h('div', { class: 'plan-row', key: entry.browser }, [
        h('strong', entry.browser),
        h('span', entry.time),
        h(
          NTag,
          { size: 'small', round: true, bordered: false, type: STATUS_TAG[entry.status] || 'default' },
          { default: () => STATUS_LABEL[entry.status] || entry.status },
        ),
        h('span', { class: 'sum', title: r?.summary || '' }, r?.summary || '—'),
        h(
          'button',
          {
            class: 'mini',
            type: 'button',
            disabled: entry.status === 'running' || busy.value === `run-${entry.browser}`,
            onClick: () => runBrowser(entry.browser),
          },
          entry.status === 'running' ? '运行中…' : btnLabel,
        ),
      ])
    }

    return () => {
      const st = status.value || {}
      const plan = Array.isArray(st.schedule) ? st.schedule : []

      return h('div', { class: 'ac-set' }, [
        h('div', { class: 'card' }, [
          h('div', { class: 'head' }, [
            h('h2', '今日签到'),
            h('span', { class: 'switch-pair' }, [
              h(NSwitch, {
                value: paused.value,
                size: 'small',
                'onUpdate:value': togglePaused,
              }),
              paused.value ? '已暂停' : '调度中',
            ]),
          ]),
          loading.value
            ? h('p', { class: 'desc' }, '加载中…')
            : st.error
              ? h(NAlert, { type: 'warning', showIcon: false }, { default: () => st.error })
              : h('div', { class: 'status-line' }, [
                  h('span', ['日期 ', h('strong', st.date || '-')]),
                  h('span', ['下一时刻 ',
                    h('strong', st.next ? `${st.next.browser} ${st.next.time}` : '无')]),
                  h('span', ['运行中 ',
                    h('strong', st.running ? st.running.browser : '—')]),
                  Array.isArray(st.queued) && st.queued.length
                    ? h('span', ['排队 ', h('strong', st.queued.join('、'))])
                    : null,
                ]),
          plan.length
            ? h('div', { class: 'plan-head' }, [
                h('span', '浏览器'), h('span', '时刻'), h('span', '状态'),
                h('span', '结果'), h('span', '操作'),
              ])
            : null,
          ...plan.map(planRow),
          h('div', { class: 'actions' }, [
            h(NButton, {
              size: 'small', type: 'primary',
              loading: busy.value === 'run-all',
              disabled: !!busy.value && busy.value !== 'run-all',
              onClick: runAll,
            }, { default: () => '立即全部签到' }),
            h(NButton, {
              size: 'small',
              loading: busy.value === 'reschedule',
              disabled: !!busy.value && busy.value !== 'reschedule',
              onClick: reschedule,
            }, { default: () => '重算剩余时刻' }),
            h(NButton, {
              size: 'small',
              loading: busy.value === 'open-log',
              disabled: !!busy.value && busy.value !== 'open-log',
              onClick: openLog,
            }, { default: () => '打开日志' }),
            h(NButton, {
              size: 'small',
              loading: busy.value === 'status',
              disabled: !!busy.value && busy.value !== 'status',
              onClick: () => run('status', refreshStatus),
            }, { default: () => '刷新状态' }),
          ]),
        ]),
        h('div', { class: 'card' }, [
          h('div', { class: 'head' }, [h('h2', '调度设置')]),
          h('p', { class: 'desc' },
            '每个浏览器每天随机分配一个时刻：窗口被均分为 N 段，各浏览器在其专属时段内随机取点，彼此天然错开。'),
          h('div', { class: 'row' }, [
            h('div', { class: 'field' }, [
              h('div', { class: 'label' }, '窗口开始'),
              h(NInput, {
                value: windowStart.value,
                placeholder: '09:00',
                'onUpdate:value': (v) => {
                  windowStart.value = v
                  scheduleSave()
                },
              }),
            ]),
            h('div', { class: 'field' }, [
              h('div', { class: 'label' }, '窗口结束'),
              h(NInput, {
                value: windowEnd.value,
                placeholder: '21:00',
                'onUpdate:value': (v) => {
                  windowEnd.value = v
                  scheduleSave()
                },
              }),
            ]),
          ]),
          h('div', { class: 'field' }, [
            h('div', { class: 'label' }, '浏览器列表'),
            h(NInput, {
              value: browsersStr.value,
              placeholder: 'Edge, Firefox, Chrome, Brave',
              'onUpdate:value': (v) => {
                browsersStr.value = v
                scheduleSave()
              },
            }),
            h('p', { class: 'hint' }, '逗号分隔，须与签到脚本 -BrowserNames 过滤的名字一致。改动在明天生效，或点「重算剩余时刻」。'),
          ]),
          h('div', { class: 'row' }, [
            h('div', { class: 'field' }, [
              h('span', { class: 'switch-pair' }, [
                h(NSwitch, {
                  value: catchUpOnWake.value,
                  'onUpdate:value': (v) => {
                    catchUpOnWake.value = v === true
                    scheduleSave()
                  },
                }),
                '窗口内唤醒即补跑',
              ]),
              h('p', { class: 'hint' },
                '开：错过时刻后（睡眠/关机），窗口结束前唤醒就立即补跑；关：仅迟到有限分钟内仍执行，其余标记为错过。'),
              !catchUpOnWake.value
                ? h('div', { class: 'row-inline' }, [
                    h(NInput, {
                      class: 'num',
                      value: String(graceMinutes.value),
                      'onUpdate:value': (v) => {
                        graceMinutes.value = clamp(v, 1, 720, DEFAULT_CONFIG.graceMinutes)
                        scheduleSave()
                      },
                    }),
                    h('span', { class: 'unit' }, '分钟内仍执行'),
                  ])
                : null,
            ]),
            h('div', { class: 'field' }, [
              h('div', { class: 'label' }, '单次超时'),
              h('div', { class: 'row-inline' }, [
                h(NInput, {
                  class: 'num',
                  value: String(timeoutMin.value),
                  'onUpdate:value': (v) => {
                    timeoutMin.value = clamp(v, 1, 120, DEFAULT_CONFIG.timeoutMin)
                    scheduleSave()
                  },
                }),
                h('span', { class: 'unit' }, '分钟（超时强杀进程树）'),
              ]),
            ]),
          ]),
        ]),
        h('div', { class: 'card' }, [
          h('div', { class: 'head' }, [h('h2', '通知与路径')]),
          h('div', { class: 'row' }, [
            h('div', { class: 'field' }, [
              h('span', { class: 'switch-pair' }, [
                h(NSwitch, {
                  value: toastOnSuccess.value,
                  'onUpdate:value': (v) => {
                    toastOnSuccess.value = v === true
                    scheduleSave()
                  },
                }),
                '成功也弹卡片',
              ]),
              h('p', { class: 'hint' }, '失败/跳过必定弹卡；关闭后成功只在面板可见。'),
            ]),
            h('div', { class: 'field' }, [
              h('div', { class: 'label' }, '卡片停留'),
              h('div', { class: 'row-inline' }, [
                h(NInput, {
                  class: 'num',
                  value: String(toastDurationSec.value),
                  'onUpdate:value': (v) => {
                    toastDurationSec.value = clamp(v, 3, 600, DEFAULT_CONFIG.toastDurationSec)
                    scheduleSave()
                  },
                }),
                h('span', { class: 'unit' }, '秒'),
              ]),
            ]),
          ]),
          h('div', { class: 'field' }, [
            h('div', { class: 'label' }, '签到脚本路径'),
            h(NInput, {
              value: scriptPath.value,
              placeholder: '留空使用插件内置 scripts/Run-DailyBrowserCheckin.ps1',
              'onUpdate:value': (v) => {
                scriptPath.value = v
                scheduleSave()
              },
            }),
          ]),
          h('div', { class: 'field' }, [
            h('div', { class: 'label' }, '日志文件路径'),
            h(NInput, {
              value: logPath.value,
              placeholder: '留空使用默认 %LOCALAPPDATA% 日志',
              'onUpdate:value': (v) => {
                logPath.value = v
                scheduleSave()
              },
            }),
            h('p', { class: 'hint' }, `脚本：${(status.value || {}).scriptPath || '（启用后显示）'}`),
          ]),
        ]),
      ])
    }
  },
}
