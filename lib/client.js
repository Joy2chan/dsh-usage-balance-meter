/**
 * dsh-usage-balance-meter — web client footer with click-to-popup details.
 *
 * Build artifact of `npm run build:client` (copied from client/index.js).
 * The browser loads `exports["./client"]` = client/index.js; this copy exists
 * so bundle tooling/injector prechecks find the built client artifact.
 */
window.__ModuleLoader__.load({
  id: 'dsh-usage-balance-meter',
  factory: (require) => {
    const React = require('react')
    const { useState, useEffect, useRef, useLayoutEffect, useCallback } = React

    const inject = ['slots', 'remote']
    const name = 'usage-balance-meter-client'

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

    function shortCost(costObj) {
      const parts = costParts(costObj)
      if (parts.length === 0) return ''
      return parts[0]
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

      useEffect(() => subscribe(setSnap), [])
      useEffect(() => {
        try { localStorage.setItem('dsh-um-open', open ? '1' : '0') } catch { /* ignore */ }
      }, [open])

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
        ? (todayCost ? `⌁ ${shortCost(s.today.cost)}${budgetText}` : '⌁ cost')
        : '⌁'
      if (snap.status === 'error') compactLabel = wide ? '⌁ err' : '⌁!'
      else if (snap.status === 'loading') compactLabel = wide ? '⌁ …' : '⌁'

      const details = []
      if (snap.status === 'loading') details.push({ label: 'status', value: 'loading…' })
      else if (snap.status === 'error') details.push({ label: 'status', value: 'error (remote unavailable)' })
      if (!s && snap.raw !== null && snap.raw !== undefined) {
        const text = JSON.stringify(snap.raw)
        details.push({ label: 'raw', value: text.length > 400 ? text.slice(0, 400) + '…' : text })
      }
      if (s) {
        details.push({ label: 'today', value: costParts(s.today.cost).join(', ') || '0' })
        details.push({ label: 'month', value: costParts(s.month.cost).join(', ') || '0' })
        details.push({ label: 'all', value: costParts(s.all.cost).join(', ') || '0' })
        if (s.budget) details.push({
          label: 'budget',
          value: `${s.budget.percent.toFixed(1)}% (${s.budget.used.toFixed(4)} / ${s.budget.amount.toFixed(4)})`,
        })
      }

      const styles = {
        root: { position: 'relative', display: 'flex', alignItems: 'center', width: '100%', minWidth: 0 },
        button: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          padding: '2px 6px',
          borderRadius: 6,
          border: '1px solid rgba(127,127,127,.25)',
          background: 'transparent',
          color: 'inherit',
          cursor: 'pointer',
          font: 'inherit',
          width: wide ? '100%' : 'auto',
          justifyContent: wide ? 'space-between' : 'center',
          minWidth: 0,
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
            onClick: () => setOpen(o => !o),
            style: styles.button,
            title: todayCost ? `Today ${todayCost}` : 'dsh-usage-balance-meter',
            'aria-expanded': open,
          },
          React.createElement('span', { style: styles.label }, compactLabel),
          wide ? React.createElement('span', { style: styles.chevron, 'aria-hidden': 'true' }, open ? '▴' : '▾') : null,
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
      const slots = ctx.get('slots')
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
