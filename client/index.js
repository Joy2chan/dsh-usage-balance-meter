/**
 * dsh-usage-meter — minimal web client footer.
 *
 * EXPERIMENTAL scaffold. It follows the dsh-cost-meter loading pattern
 * (`window.__ModuleLoader__.load` + `ctx.slots`). The footer seat
 * (`sidebar.footer.action`) only receives the owner props (`wide`), so this
 * scaffold renders a safe placeholder; wiring live totals is the next step
 * (via a host Typert `usageMeter` remote, like cost-meter's `costMeter`).
 */
window.__ModuleLoader__.load({
  id: 'dsh-usage-meter',
  factory: (require) => {
    const React = require('react')
    const inject = ['slots']
    const name = 'usage-meter-client'

    function SidebarFooter({ wide }) {
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
          title: 'dsh-usage-meter',
        },
        wide ? 'cost meter' : '⌁',
      )
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined || typeof slots.inject !== 'function') return
      slots.inject('sidebar.footer.action', () => slots.register(
        { name: 'sidebar.footer.action', id: 'usage-meter', order: 0 },
        SidebarFooter,
      ))
    }

    return { name, inject, apply }
  },
})
