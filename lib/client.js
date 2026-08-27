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

    // ===== Web settings section: editable per-provider pricing =====
    const PRICE_FIELDS = [
      ['inputPricePerMillion', 'In /M'],
      ['outputPricePerMillion', 'Out /M'],
      ['cacheReadPricePerMillion', 'Cache r /M'],
      ['cacheWritePricePerMillion', 'Cache w /M'],
    ]

    // Seed rows so the editor renders before any user prices exist; mirrors
    // DEFAULT_PRICE_TABLE keys in src/index.ts.
    const SEED_PROVIDERS = {
      'opencode-go': { currency: 'USD', models: { 'deepseek-v4-flash': {}, 'deepseek-v4-pro': {} } },
      'deepseek-official': { currency: 'CNY', models: { 'deepseek-v4-flash': {}, 'deepseek-v4-pro': {} } },
    }

    let pricingScope = null

    function numOf(value) {
      if (typeof value !== 'number' && typeof value !== 'string') return ''
      const n = Number(value)
      return Number.isFinite(n) ? n : ''
    }

    function cloneRecord(value) {
      if (value === null || typeof value !== 'object') return {}
      return JSON.parse(JSON.stringify(value))
    }

    function draftOfSection(section) {
      const prices = section && typeof section === 'object' && section.prices && typeof section.prices === 'object'
        ? section.prices
        : undefined
      return {
        currency: section && typeof section.currency === 'string' ? section.currency : 'USD',
        default: prices && typeof prices.default === 'object' && prices.default !== null ? cloneRecord(prices.default) : {},
        providers: prices && typeof prices.providers === 'object' && Object.keys(prices.providers).length > 0
          ? cloneRecord(prices.providers)
          : cloneRecord(SEED_PROVIDERS),
      }
    }

    function valueFromDraft(draft) {
      const providers = {}
      for (const [provider, entry] of Object.entries(draft.providers)) {
        const name = String(provider).trim()
        if (!name) continue
        const models = {}
        for (const [model, fields] of Object.entries(entry && typeof entry === 'object' && entry.models ? entry.models : {})) {
          const modelName = String(model).trim()
          if (!modelName) continue
          const flat = {}
          for (const [key] of PRICE_FIELDS) {
            const n = numOf(fields[key])
            if (n !== '' && n >= 0) flat[key] = n
          }
          if (Object.keys(flat).length > 0) models[modelName] = flat
        }
        if (Object.keys(models).length > 0) {
          const currency = entry && typeof entry.currency === 'string' ? String(entry.currency).trim() : ''
          providers[name] = { ...(currency ? { currency } : {}), models }
        }
      }
      const defaults = {}
      for (const [key] of PRICE_FIELDS) {
        const n = numOf(draft.default[key])
        if (n !== '' && n >= 0) defaults[key] = n
      }
      return { ...(Object.keys(defaults).length > 0 ? { default: defaults } : {}), providers }
    }

    const editorInputStyle = { width: '100%', boxSizing: 'border-box', padding: '2px 4px', borderRadius: 4, border: '1px solid #ccc', fontSize: 12, background: '#fff', color: '#111' }
    const editorBtnStyle = { padding: '2px 8px', borderRadius: 4, border: '1px solid #ccc', background: '#f5f5f5', color: '#111', cursor: 'pointer', fontSize: 12 }

    function PriceField({ label, value, onChange }) {
      return React.createElement('label', { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } },
        React.createElement('span', { style: { fontSize: 10, opacity: 0.7, whiteSpace: 'nowrap' } }, label),
        React.createElement('input', {
          type: 'number', min: 0, step: 'any', inputMode: 'decimal',
          value: numOf(value) === '' ? '' : String(numOf(value)),
          onChange: (event) => onChange(event.target.value),
          style: editorInputStyle,
        }),
      )
    }

    function UsageBalanceSection() {
      const scope = pricingScope
      const [draft, setDraft] = React.useState(() => {
        const snap = scope ? scope.getSnapshot() : null
        return draftOfSection(snap && snap.value)
      })
      const [status, setStatus] = React.useState('')
      const [pending, setPending] = React.useState({})
      const [newProviderName, setNewProviderName] = React.useState('')

      React.useEffect(() => {
        if (!scope || typeof scope.subscribe !== 'function') return
        return scope.subscribe(() => {
          const snap = scope.getSnapshot()
          if (snap && snap.status === 'ready') setDraft(draftOfSection(snap.value))
        })
      }, [scope])

      const update = (builder) => { setDraft((d) => builder(cloneRecord(d))) }
      const setDefaultField = (key, value) => update((d) => { d.default[key] = value; return d })
      const setProviderField = (provider, key, value) => update((d) => {
        const entry = d.providers[provider] = d.providers[provider] || {}
        entry[key] = value
        return d
      })
      const setModelField = (provider, model, key, value) => update((d) => {
        const entry = d.providers[provider] = d.providers[provider] || {}
        const models = entry.models = entry.models || {}
        const fields = models[model] = models[model] || {}
        fields[key] = value
        return d
      })
      const removeModel = (provider, model) => update((d) => {
        if (d.providers[provider]) delete d.providers[provider].models[model]
        return d
      })
      const removeProvider = (provider) => update((d) => { delete d.providers[provider]; return d })
      const addProvider = () => {
        const name = String(newProviderName).trim()
        if (!name) return
        update((d) => { d.providers[name] = d.providers[name] || { currency: 'USD', models: {} }; return d })
        setNewProviderName('')
      }
      const addModel = (provider) => {
        const name = String(pending[provider] || '').trim()
        if (!name) return
        update((d) => {
          const entry = d.providers[provider] = d.providers[provider] || { models: {} }
          entry.models = entry.models || {}
          entry.models[name] = entry.models[name] || {}
          return d
        })
        setPending((p) => { const next = { ...p }; delete next[provider]; return next })
      }
      const save = async () => {
        if (!scope || typeof scope.set !== 'function') { setStatus('unavailable'); return }
        try {
          setStatus('saving')
          await scope.set('prices', valueFromDraft(draft))
          setStatus('saved')
        } catch (error) {
          setStatus('save failed: ' + String(error))
        }
      }

      const snap = scope ? scope.getSnapshot() : null
      if (!scope || (snap && snap.status === 'unavailable')) {
        return React.createElement('div', { style: { padding: 12, color: '#888', fontSize: 13 } },
          'Settings are not available in this mode (memory / remote browser).')
      }
      const providerEntries = Object.entries(draft.providers)

      return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, padding: 12 } },
        React.createElement('div', { style: { fontSize: 13, fontWeight: 600, color: '#111' } }, 'Per-provider pricing'),
        React.createElement('div', { style: { fontSize: 11, color: '#888' } },
          'Flat price per 1M tokens. Leave a field empty to inherit the baked default.',
        ),
        React.createElement('div', { style: { border: '1px solid #e0e0e0', borderRadius: 8, padding: 10, display: 'flex', flexDirection: 'column', gap: 6 } },
          React.createElement('div', { style: { fontSize: 12, fontWeight: 600, color: '#111' } }, 'Global default'),
          React.createElement('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 8 } },
            PRICE_FIELDS.map(([key, label]) => React.createElement(PriceField, {
              key, label, value: draft.default[key], onChange: (v) => setDefaultField(key, v),
            })),
          ),
        ),
        providerEntries.map(([provider, entry]) => React.createElement(
          'div', { key: provider, style: { border: '1px solid #e0e0e0', borderRadius: 8, padding: 10, display: 'flex', flexDirection: 'column', gap: 8 } },
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
            React.createElement('strong', { style: { fontSize: 12, color: '#111' } }, provider),
            React.createElement('label', { style: { display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#888' } },
              'currency',
              React.createElement('input', {
                value: entry.currency || '', onChange: (e) => setProviderField(provider, 'currency', e.target.value),
                style: { ...editorInputStyle, width: 60 },
              }),
            ),
            React.createElement('button', { onClick: () => removeProvider(provider), style: editorBtnStyle }, 'remove'),
          ),
          Object.keys(entry.models || {}).length === 0
            ? React.createElement('div', { style: { fontSize: 11, color: '#aaa' } }, 'No models yet.')
            : Object.entries(entry.models).map(([model, fields]) => React.createElement(
                'div', { key: model, style: { display: 'grid', gridTemplateColumns: '110px repeat(4, minmax(80px, 1fr)) 28px', gap: 6, alignItems: 'end' } },
                React.createElement('div', { style: { fontSize: 12, fontWeight: 600, color: '#111', lineHeight: '22px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, model),
                PRICE_FIELDS.map(([key, label]) => React.createElement(PriceField, {
                  key, label, value: fields[key], onChange: (v) => setModelField(provider, model, key, v),
                })),
                React.createElement('button', { onClick: () => removeModel(provider, model), style: { ...editorBtnStyle, padding: '2px 6px' }, title: 'remove model' }, 'x'),
              ),
          ),
          React.createElement('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
            React.createElement('input', {
              value: pending[provider] || '', placeholder: 'new model id',
              onChange: (e) => setPending((p) => ({ ...p, [provider]: e.target.value })),
              onKeyDown: (e) => { if (e.key === 'Enter') addModel(provider) },
              style: { ...editorInputStyle, width: 180 },
            }),
            React.createElement('button', { onClick: () => addModel(provider), style: editorBtnStyle }, 'add model'),
          ),
        )),
        React.createElement('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
          React.createElement('input', {
            value: newProviderName, placeholder: 'provider id (e.g. my-llm)',
            onChange: (e) => setNewProviderName(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') addProvider() },
            style: { ...editorInputStyle, width: 200 },
          }),
          React.createElement('button', { onClick: addProvider, style: editorBtnStyle }, 'add provider'),
        ),
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
          React.createElement('button', {
            onClick: save,
            style: { padding: '6px 16px', borderRadius: 6, border: 'none', background: '#3b82f6', color: '#fff', cursor: 'pointer', fontSize: 13 },
          }, 'Save prices'),
          status ? React.createElement('span', { style: { fontSize: 11, color: '#888' } }, status) : null,
        ),
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

      // Web Settings page: editable per-provider pricing under the settings
      // namespace registered host-side by installSettingsSection.
      try {
        const settingsScope = ctx.get('settingsScope')
        if (settingsScope !== undefined && typeof settingsScope.bind === 'function') {
          pricingScope = settingsScope.bind({ namespace: 'usage-meter' })
          slots.inject('settings.section', () => slots.register(
            { name: 'settings.section', id: 'usage-meter', order: 30, label: () => 'Usage balance' },
            UsageBalanceSection,
          ))
        }
      } catch { /* settings section unavailable */ }
    }

    return { name, inject, apply }
  },
})
