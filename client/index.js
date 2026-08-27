/**
 * dsh-usage-balance-meter — web client footer with click-to-popup details.
 *
 * - Reads host ledger state through Typert (`remote.usageMeter.getState()`).
 * - Renders a sidebar footer button (⌁ + short today cost + budget%).
 * - Clicking the button opens a details popup anchored above the footer:
 *   the popup is fixed-positioned from the button rect, its width is capped
 *   at the sidebar content width (never wider than the sidebar), long lines
 *   wrap instead of overflowing.
 * - The popup closes automatically when the sidebar collapses (slot `wide`
 *   prop goes false), on outside click, on Escape, and on window resize.
 *
 * Open/closed state is kept in localStorage.
 */
window.__ModuleLoader__.load({
  id: 'dsh-usage-balance-meter',
  factory: (require) => {
    const React = require('react')
    const { useState, useEffect, useRef, useLayoutEffect, useCallback } = React

    const inject = ['slots', 'remote']
    const name = 'usage-balance-meter-client'
    let clientCtx = null
    /** Rail click expands the sidebar through the host layout service. */
    function expandSidebar() {
      try { clientCtx?.get('layout')?.toggleSidebar?.() } catch { /* layout unavailable */ }
    }

    /** Inline SVG pulse icon (design-system stroke style, theme colored). */
    function CostIcon({ size }) {
      return React.createElement(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          flexShrink: 0,
        },
        React.createElement('polyline', { points: '1.5 8 4 8 6 14 10 2 12 8 14.5 8' }),
      )
    }

    // Minimal Typert client contribution matching the host ./typert manifest.
    // Mounting it makes ctx.get('remote.usageMeter') available on the client.
    const CONTRIBUTION = {
      package: 'dsh-usage-balance-meter',
      descriptors: [
        {
          id: 'dsh-usage-balance-meter#usageMeter/getState',
          service: 'usageMeter',
          namespace: 'usageMeter',
          method: 'getState',
          invocation: { kind: 'direct' },
          parameters: [],
          result: {
            mode: 'strict',
            typeSymbol: 'dsh-usage-balance-meter#CostState',
            schema: { parse: (v) => v },
          },
        },
      ],
    }

    let store = { status: 'loading', state: null, raw: null }
    const listeners = new Set()
    function setStore(next) {
      store = next
      for (const fn of Array.from(listeners)) fn(store)
    }
    function subscribe(fn) {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    }

    function costParts(costObj) {
      if (!costObj || typeof costObj !== 'object') return []
      return Object.entries(costObj)
        .map(([currency, value]) => `${currency} ${Number(value).toFixed(4)}`)
    }

    /** First currency cost only — the footer label must stay one short line. */
    function shortCost(costObj) {
      const parts = costParts(costObj)
      if (parts.length === 0) return ''
      return parts[0]
    }

    /** Compact token formatting: 3.2M / 840 / 4.1k. */
    function fmtTokens(n) {
      if (typeof n !== 'number' || !Number.isFinite(n)) return '0'
      if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(1)}M`
      if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)}k`
      return String(n)
    }

    const POPUP_MAX_WIDTH = 300

    function CostFooter({ wide }) {
      const [snap, setSnap] = useState(store)
      const [open, setOpen] = useState(() => {
        try { return localStorage.getItem('dsh-um-open') !== '0' } catch { return true }
      })
      const rootRef = useRef(null)
      const buttonRef = useRef(null)
      const panelRef = useRef(null)
      const [popup, setPopup] = useState({ left: 0, bottom: 0, width: POPUP_MAX_WIDTH })
      const [hovered, setHovered] = useState(false)

      useEffect(() => subscribe(setSnap), [])
      useEffect(() => {
        try { localStorage.setItem('dsh-um-open', open ? '1' : '0') } catch { /* ignore */ }
      }, [open])

      // The sidebar hands the foot slot its live state: wide=false means the
      // rail (collapsed) is settled — the popup must collapse with it.
      useEffect(() => {
        if (!wide) setOpen(false)
      }, [wide])

      const measure = useCallback(() => {
        const root = rootRef.current
        const button = buttonRef.current
        if (root === null || button === null) return
        const buttonRect = button.getBoundingClientRect()
        // The slot wrapper may be display:contents (zero rect); take the first
        // laid-out ancestor no wider than a sidebar column as the geometry cap
        // (foot area / sidebar column), never the whole app frame.
        let hostRect = null
        let el = root.parentElement
        for (let i = 0; i < 6 && el !== null; i++, el = el.parentElement) {
          const r = el.getBoundingClientRect()
          if (r.width > 0 && r.width <= 400) { hostRect = r; break }
        }
        if (hostRect === null) hostRect = buttonRect
        let width = Math.max(120, Math.min(hostRect.width - 8, POPUP_MAX_WIDTH))
        let left = Math.max(hostRect.left, 4)
        // Hard clamp: the popup must never stick out of the sidebar column.
        if (left + width > hostRect.right) width = Math.max(120, hostRect.right - left)
        const bottom = Math.max(8, window.innerHeight - buttonRect.top + 8)
        setPopup({ left, bottom, width })
      }, [])

      useLayoutEffect(() => {
        if (!open || !wide) return
        measure()
        const onResize = () => { measure() }
        window.addEventListener('resize', onResize)
        return () => { window.removeEventListener('resize', onResize) }
      }, [open, wide, measure, snap])

      // Outside click + Escape close the popup.
      useEffect(() => {
        if (!open) return
        const onPointerDown = (event) => {
          const panel = panelRef.current
          const button = buttonRef.current
          if (panel === null || button === null) return
          if (!panel.contains(event.target) && !button.contains(event.target)) setOpen(false)
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown, true)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown, true)
        }
      }, [open])

      const s = snap.state
      const todayCost = s && s.today && s.today.cost ? costParts(s.today.cost).join(' · ') : ''
      const budgetText = s && s.budget ? ` ${s.budget.percent.toFixed(0)}%` : ''
      let compactLabel = wide
        ? (todayCost ? `${shortCost(s.today.cost)}${budgetText}` : 'cost')
        : ''
      if (snap.status === 'error') compactLabel = wide ? 'err' : ''
      else if (snap.status === 'loading') compactLabel = wide ? '…' : ''

      const details = []
      if (snap.status === 'loading') details.push({ label: 'status', value: 'loading…' })
      else if (snap.status === 'error') details.push({ label: 'status', value: 'error (remote unavailable)' })
      if (!s && snap.raw !== null && snap.raw !== undefined) {
        const text = JSON.stringify(snap.raw)
        details.push({ label: 'raw', value: text.length > 400 ? text.slice(0, 400) + '…' : text })
      }
      if (s) {
        const period = (label, t) => ({
          label,
          value: `${costParts(t.cost).join(', ') || '0'} · ${fmtTokens(t.input)} in / ${fmtTokens(t.output)} out / ${fmtTokens(t.cacheRead)} cache · ${t.calls} calls`,
        })
        details.push(period('today', s.today))
        details.push(period('month', s.month))
        details.push(period('all', s.all))
        if (s.budget) details.push({
          label: 'budget',
          value: `${s.budget.percent.toFixed(1)}% (${s.budget.used.toFixed(4)} / ${s.budget.amount.toFixed(4)})`,
        })
      }

      const styles = {
        root: { position: 'relative', display: 'flex', alignItems: 'center', width: '100%', minWidth: 0 },
        button: wide ? {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 3,
          padding: '1px 3px',
          borderRadius: 6,
          border: 'none',
          background: 'transparent',
          color: 'inherit',
          cursor: 'pointer',
          font: 'inherit',
          lineHeight: 'inherit',
          width: 'auto',
          justifyContent: 'center',
          minWidth: 0,
        } : {
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 36,
          height: 36,
          padding: 0,
          border: 'none',
          borderRadius: '50%',
          background: hovered ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
          color: 'var(--dsw-alias-label-primary)',
          cursor: 'pointer',
          lineHeight: 1,
          fontSize: 18,
        },
        label: {
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          display: 'block',
        },
        chevron: { fontSize: 10, opacity: 0.7, flexShrink: 0 },
        panel: {
          position: 'fixed',
          left: popup.left,
          bottom: popup.bottom,
          width: popup.width,
          boxSizing: 'border-box',
          zIndex: 9999,
          padding: 8,
          borderRadius: 8,
          border: '1px solid rgba(127,127,127,.3)',
          background: '#fff',
          color: '#111',
          fontSize: 12,
          boxShadow: '0 4px 16px rgba(0,0,0,.15)',
          display: 'flex',
          flexDirection: 'column',
          gap: 3,
          maxHeight: '60vh',
          overflowY: 'auto',
        },
        row: { display: 'flex', gap: 6, minWidth: 0, alignItems: 'baseline' },
        rowLabel: { color: '#888', flexShrink: 0 },
        rowValue: { wordBreak: 'break-word', minWidth: 0, fontVariantNumeric: 'tabular-nums' },
      }

      return React.createElement(
        'div',
        { ref: rootRef, style: styles.root },
        React.createElement(
          'button',
          {
            ref: buttonRef,
            onClick: () => { if (wide) setOpen(o => !o); else expandSidebar() },
            onMouseEnter: () => setHovered(true),
            onMouseLeave: () => setHovered(false),
            style: styles.button,
            title: todayCost ? `Today ${todayCost}` : 'dsh-usage-balance-meter',
            'aria-expanded': open,
          },
          wide
            ? React.createElement(React.Fragment, null,
                React.createElement('span', { style: { display: 'inline-flex', flexShrink: 0 } }, React.createElement(CostIcon, { size: 13 })),
                React.createElement('span', { style: styles.label }, compactLabel),
                React.createElement('span', { style: styles.chevron, 'aria-hidden': 'true' }, open ? '▴' : '▾'),
              )
            : React.createElement(CostIcon, { size: 18 }),
        ),
        open && wide
          ? React.createElement(
              'div',
              { ref: panelRef, style: styles.panel, role: 'dialog' },
              details.length > 0
                ? details.map((row, i) => React.createElement(
                    'div',
                    { key: i, style: styles.row },
                    React.createElement('span', { style: styles.rowLabel }, row.label),
                    React.createElement('span', { style: styles.rowValue }, row.value),
                  ))
                : React.createElement('div', null, 'no data'),
            )
          : null,
      )
    }

    async function apply(ctx) {
      clientCtx = ctx
      const slots = ctx.get('slots')
      // Register the client Typert contribution so the remote is available.
      const remoteHost = ctx.remote
      if (remoteHost !== undefined && typeof remoteHost.$mount === 'function') {
        try { await remoteHost.$mount(CONTRIBUTION) } catch { /* ignore */ }
      }
      const remote = ctx.get('remote.usageMeter')
      if (remote === undefined) {
        console.warn('[usage-balance-meter] remote.usageMeter is undefined')
        setStore({ status: 'error', state: null })
      } else if (typeof remote.getState !== 'function') {
        console.warn('[usage-balance-meter] remote.usageMeter has no getState', remote)
        setStore({ status: 'error', state: null })
      } else {
        remote.getState().then(
          (result) => {
            console.log('[usage-balance-meter] getState result', result)
            if (result !== null && typeof result === 'object' && 'ok' in result) {
              setStore({ status: 'ready', state: result.ok === true ? result.value : null, raw: result })
            } else {
              // Some deployments may return the state directly rather than {ok,value}.
              setStore({ status: 'ready', state: result, raw: result })
            }
          },
          (error) => {
            console.warn('[usage-balance-meter] getState failed', error)
            setStore({ status: 'error', state: null })
          },
        )
      }
      if (slots === undefined || typeof slots.inject !== 'function') return
      slots.inject('sidebar.footer.action', () => slots.register(
        { name: 'sidebar.footer.action', id: 'usage-balance-meter', order: 0 },
        CostFooter,
      ))
    }

    return { name, inject, apply }
  },
})
