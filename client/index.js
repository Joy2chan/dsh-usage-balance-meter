/**
 * dsh-usage-meter — minimal web client footer.
 *
 * EXPERIMENTAL: this is a scaffold for the "minimal Web UI footer" roadmap
 * item. It follows the dsh-cost-meter client-loading pattern
 * (`window.__ModuleLoader__.load` + `ctx.slots`), but has not been verified
 * against a live Harness web build in this environment.
 *
 * It renders the current session's cost/token projection (`costUsage`) into
 * the `sidebar.footer.action` slot.
 */
window.__ModuleLoader__.load({
  id: 'dsh-usage-meter',
  factory: (require) => {
    const React = require('react')
    const { useProjection } = require('@deepseek-ai/dsh-client-runtime')

    const inject = ['remote', 'slots']
    const name = 'usage-meter-client'

    function SidebarFooter() {
      const cost = useProjection('costUsage')
      const has = typeof cost === 'object' && cost !== null
      const text = has
        ? `cost ${cost.cost} · ↑${cost.input}/${cost.cacheRead} ↓${cost.output}`
        : 'cost —'
      return React.createElement('div', { style: { fontSize: 12, fontWeight: 600 } }, text)
    }

    async function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined || typeof slots.inject !== 'function') return
      slots.inject('sidebar.footer.action', () => {
        return slots.register(
          { name: 'sidebar.footer.action', id: 'usage-meter', order: 0, inject: () => ({}) },
          SidebarFooter,
        )
      })
    }

    return { name, inject, apply }
  },
})
