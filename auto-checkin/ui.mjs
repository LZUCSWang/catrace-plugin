/** auto-checkin toast — per-browser result card / daily summary card. */
const { h } = globalThis.__CATRACE_VUE__ || {}
if (typeof h !== 'function') throw new Error('Catrace plugin Vue runtime missing')

const STYLE_ID = 'catrace-plugin-auto-checkin-css'
const CSS = `
.ac-root { position:relative; width:100%; box-sizing:border-box; font-family:system-ui,-apple-system,"Segoe UI",sans-serif; }
.ac-row { display:flex; align-items:flex-start; gap:0.625rem; width:100%; padding:0.0625rem 0.0625rem 0.4375rem 0.0625rem; box-sizing:border-box; }
.ac-badge {
  flex-shrink:0; width:2.125rem; height:2.125rem; border-radius:0.625rem;
  display:flex; align-items:center; justify-content:center;
  font-size:0.75rem; font-weight:800; color:#fff;
}
.ac-badge.ok { background:linear-gradient(145deg,#16a34a,#22c55e); }
.ac-badge.failed { background:linear-gradient(145deg,#dc2626,#f87171); }
.ac-badge.skipped { background:linear-gradient(145deg,#64748b,#94a3b8); }
.ac-badge.summary { background:linear-gradient(145deg,#7c3aed,#a78bfa); }
.ac-mid { flex:1; min-width:0; display:flex; flex-direction:column; gap:0.125rem; }
.ac-title { margin:0; font-size:0.8125rem; font-weight:700; color:#0f172a; line-height:1.3; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ac-sub { margin:0; font-size:0.6875rem; font-weight:500; color:#64748b; line-height:1.35; word-break:break-all; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
.ac-meta { margin:0; font-size:0.625rem; color:#94a3b8; line-height:1.3; white-space:nowrap; }
.ac-lines { margin:0.25rem 0 0; padding:0; list-style:none; font-size:0.6875rem; color:#475569; line-height:1.6; max-height:6.25rem; overflow:auto; }
.ac-lines li { display:flex; justify-content:space-between; gap:0.5rem; }
.ac-lines li span:last-child { flex-shrink:0; color:#94a3b8; }
.ac-actions { flex-shrink:0; display:flex; align-items:center; gap:0.375rem; }
.ac-btn {
  border:0; border-radius:999px; padding:0.3125rem 0.625rem; min-height:1.625rem;
  background:#7c3aed; color:#fff; font-size:0.6875rem; font-weight:700;
  cursor:pointer; white-space:nowrap; line-height:1.2;
  box-shadow:0 0.0625rem 0.25rem rgba(124,58,237,0.28);
}
.ac-btn.ghost { background:#f1f5f9; color:#475569; box-shadow:none; }
.ac-btn:hover { filter:brightness(1.05); }
.ac-bar-wrap {
  position:absolute; left:0.5rem; right:0.5rem; bottom:0; height:0.125rem;
  pointer-events:none; overflow:hidden; border-radius:999px; background:rgba(124,58,237,0.12);
}
.ac-bar {
  height:100%; width:100%; border-radius:999px;
  background:linear-gradient(90deg,#7c3aed,#c4b5fd);
  transform-origin:left center;
  /* Same contract as Rest/Sdk cards: one CSS timeline, pause on hover only. */
  animation:ac-shrink var(--toast-auto-hide-ms, 8000ms) linear forwards;
}
.ac-bar.paused { animation-play-state:paused; }
@keyframes ac-shrink {
  from { transform:scaleX(1); }
  to { transform:scaleX(0); }
}
`

function ensureStyles() {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID)) return
  const el = document.createElement('style')
  el.id = STYLE_ID
  el.textContent = CSS
  document.head.appendChild(el)
}

export default {
  name: 'AutoCheckinCard',
  props: {
    event: { type: Object, required: true },
    isHovered: { type: Boolean, default: false },
  },
  emits: ['close', 'action'],
  created() { ensureStyles() },
  render() {
    const event = this.event || {}
    const payload = event.payload || {}
    const isSummary = payload.view === 'summary'

    let badgeClass = 'summary'
    let badgeText = '✓'
    let sub = payload.summary || event.body || ''
    let meta = ''
    if (!isSummary) {
      badgeClass = payload.status === 'ok' ? 'ok'
        : payload.status === 'skipped' ? 'skipped' : 'failed'
      badgeText = (payload.browser || '?').slice(0, 1)
      const parts = []
      if (payload.plannedAt) parts.push(`计划 ${payload.plannedAt}`)
      if (payload.durationSec != null) parts.push(`用时 ${payload.durationSec}s`)
      meta = parts.join(' · ')
    }

    return h('div', { class: 'ac-root' }, [
      h('div', { class: 'ac-row' }, [
        h('div', { class: `ac-badge ${badgeClass}` }, badgeText),
        h('div', { class: 'ac-mid' }, [
          h('p', { class: 'ac-title' }, event.title || '自动签到'),
          isSummary
            ? h(
                'ul',
                { class: 'ac-lines' },
                (payload.summary || []).map((row) => {
                  const cells = String(row).split(' ')
                  return h('li', [
                    h('span', cells.slice(0, 2).join(' ')),
                    h('span', cells.slice(2).join(' ')),
                  ])
                }),
              )
            : h('p', { class: 'ac-sub' }, sub),
          meta ? h('p', { class: 'ac-meta' }, meta) : null,
        ]),
        h('div', { class: 'ac-actions' }, [
          ...(event.actions || []).map((action) =>
            h(
              'button',
              {
                key: action.id,
                class: action.id === 'viewLog' ? 'ac-btn ghost' : 'ac-btn',
                type: 'button',
                onClick: () => this.$emit('action', action.id),
              },
              action.label,
            ),
          ),
        ]),
      ]),
      h('div', { class: 'ac-bar-wrap' }, [
        h('div', { class: this.isHovered ? 'ac-bar paused' : 'ac-bar' }),
      ]),
    ])
  },
}
