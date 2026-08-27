import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { bindUsageMeter } from '../src/index.js'

describe('usageMeter typert remote binding', () => {
  it('carries a visible, identity-checked binding the gateway accepts', () => {
    const ctx = new Context()
    const service = bindUsageMeter(ctx, {} as never, () => ({} as never))
    ;(ctx as unknown as { provide?: (name: string, service: unknown) => void })
      .provide?.('usageMeter', service)

    const receiver = ctx.get('usageMeter') as unknown
    // Replicates api/gateway validateBinding: unwrap the cordis proxy, read
    // typertRemote, and verify its service identity + serviceKey/namespace.
    const originalSymbol = Symbol.for('cordis.original')
    const original = typeof receiver === 'object' && receiver !== null
      ? (Reflect.get(receiver, originalSymbol) ?? receiver)
      : receiver
    const binding = Reflect.get(original, 'typertRemote')
    expect(binding).toEqual(expect.objectContaining({
      serviceKey: 'usageMeter',
      namespace: 'usageMeter',
    }))
    expect(Reflect.get(binding, 'service')).toBe(original)

    // Gateway dispatch goes through Reflect.get(receiver, method); the method
    // must be callable (object-literal own property is fine).
    expect(typeof Reflect.get(receiver, 'getState')).toBe('function')
  })
})
