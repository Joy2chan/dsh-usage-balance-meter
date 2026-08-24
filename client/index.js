/**
 * dsh-usage-balance-meter — web client footer with show/hide toggle.
 *
 * Reads host ledger state through Typert (`remote.usageMeter.getState()`) and
 * renders a sidebar footer. Clicking the footer toggles a small detail panel
 * (today/month/all + budget). The open/closed state is kept in localStorage.
 *
 * EXPERIMENTAL: this needs a live Harness web build/browser to fully verify.
 */
window.__ModuleLoader__.load({
  id: 'dsh-usage-balance-meter',
  factory: (require) => {
    const React = require('react')
    const { useState, useEffect, useCallback } = React

    const inject = ['slots', 'remote']
    const name = 'usage-balance-meter-client'

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

    function costParts(costObj) {
      if (!costObj || typeof costObj !== 'object') return []
      return Object.entries(costObj)
        .map(([currency, value]) => `${currency} ${Number(value).toFixed(4)}`)
    }

    function CostFooter({ wide }) {
      const [snap, setSnap] = useState(store)
      const [open, setOpen] = useState(() => {
        try { return localStorage.getItem('dsh-um-open') !== '0' } catch { return true }
      })
      useEffect(() => subscribe(setSnap), [])
      useEffect(() => {
        try { localStorage.setItem('dsh-um-open', open ? '1' : '0') } catch { /* ignore */ }
      }, [open])

      const s = snap.state
      const todayCost = s && s.today && s.today.cost ? costParts(s.today.cost).join(' · ') : ''
      const budgetText = s && s.budget ? ` ${s.budget.percent.toFixed(0)}%` : ''
      let compactLabel = wide
        ? (todayCost ? `⌁ ${todayCost}${budgetText}` : '⌁ cost')
        : '⌁'
      if (snap.status === 'error') compactLabel = wide ? '⌁ err' : '⌁!'
      else if (snap.status === 'loading') compactLabel = wide ? '⌁ …' : '⌁'

      const details = []
      if (s) {
        details.push(`today: ${costParts(s.today.cost).join(', ') || '0'}`)
        details.push(`month: ${costParts(s.month.cost).join(', ') || '0'}`)
        details.push(`all: ${costParts(s.all.cost).join(', ') || '0'}`)
        if (s.budget) details.push(`budget: ${s.budget.percent.toFixed(1)}% (${s.budget.used.toFixed(4)} / ${s.budget.amount.toFixed(4)})`)
      }

      const styles = {
        root: { display: 'flex', alignItems: 'center', gap: 6, fontSize: wide ? 12 : 11, lineHeight: 1, userSelect: 'none' },
        button: { display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 6px', borderRadius: 6, border: '1px solid rgba(127,127,127,.25)', background: 'transparent', color: 'inherit', cursor: 'pointer', font: 'inherit', whiteSpace: 'nowrap' },
        panel: { marginTop: 6, padding: 8, borderRadius: 8, border: '1px solid rgba(127,127,127,.2)', background: 'rgba(127,127,127,.08)', fontSize: 11, display: 'flex', flexDirection: 'column', gap: 4, whiteSpace: 'nowrap' },
      }

      return React.createElement(
        'div',
        { style: styles.root },
        React.createElement(
          'button',
          { onClick: () => setOpen(o => !o), style: styles.button, title: todayCost ? `Today ${todayCost}` : 'dsh-usage-balance-meter' },
          compactLabel,
        ),
        open
          ? React.createElement('div', { style: styles.panel }, details.map((line, i) => React.createElement('div', { key: i }, line)))
          : null,
      )
    }

    async function apply(ctx) {
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
              setStore({ status: 'ready', state: result.ok === true ? result.value : null })
            } else {
              // Some deployments may return the state directly rather than {ok,value}.
              setStore({ status: 'ready', state: result })
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
