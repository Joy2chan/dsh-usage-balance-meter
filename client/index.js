/**
 * dsh-usage-balance-meter — web client footer.
 *
 * Reads the host ledger through `remote.usageMeter.getState()` (Typert) and
 * renders today's cost + budget status in the `sidebar.footer.action` seat.
 *
 * EXPERIMENTAL: modeled on dsh-cost-meter's client; needs a live Harness web
 * build/browser to fully verify.
 */
window.__ModuleLoader__.load({
  id: 'dsh-usage-balance-meter',
  factory: (require) => {
    const React = require('react')
    const { useState, useEffect } = React
    const inject = ['slots', 'remote']
    const name = 'usage-meter-client'

    let store = { status: 'loading', state: null }
    const listeners = new Set()
    function setStore(next) {
      store = next
      for (const fn of Array.from(listeners)) fn(store)
    }
    function subscribe(fn) {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    }

    function SidebarFooter({ wide }) {
      const [snap, setSnap] = useState(store)
      useEffect(() => subscribe(setSnap), [])
      const s = snap.state
      let label = '⌁'
      if (snap.status === 'ready' && s !== null) {
        const costObj = s.today && typeof s.today.cost === 'object' && s.today.cost !== null ? s.today.cost : {}
        const cost = Object.entries(costObj)
          .map(([c, v]) => `${c} ${Number(v).toFixed(4)}`)
          .join(' · ') || '0'
        label = `${cost}${s.budget !== null ? ` · ${s.budget.percent.toFixed(0)}%` : ''}`
      } else if (snap.status === 'loading') {
        label = '…'
      }
      return React.createElement(
        'div',
        {
          style: {
            fontSize: wide ? 12 : 11,
            fontWeight: 600,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          },
          title: 'dsh-usage-balance-meter',
        },
        label,
      )
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      const remote = ctx.get('remote.usageMeter')
      if (remote !== undefined && typeof remote.getState === 'function') {
        remote.getState().then(
          (result) => {
            setStore({ status: 'ready', state: result !== null && typeof result === 'object' && result.ok === true ? result.value : null })
          },
          () => { setStore({ status: 'error', state: null }) },
        )
      } else {
        setStore({ status: 'error', state: null })
      }
      if (slots === undefined || typeof slots.inject !== 'function') return
      slots.inject('sidebar.footer.action', () => slots.register(
        { name: 'sidebar.footer.action', id: 'usage-meter', order: 0 },
        SidebarFooter,
      ))
    }

    return { name, inject, apply }
  },
})
