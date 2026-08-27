import { describe, expect, it } from 'vitest'
import { TYPERT } from '../src/typert.js'

const MEMBER_KINDS = ['property', 'method', 'getter', 'setter', 'call', 'construct', 'index']

describe('host Typert manifest', () => {
  it('satisfies the typert-loader contract', () => {
    expect(TYPERT.package).toBe('dsh-usage-balance-meter')
    expect(TYPERT.face).toBe('host')
    expect(Array.isArray(TYPERT.schemas)).toBe(true)

    // The loader's validateTypertManifest requires model to be an object with
    // services/events/objects arrays — omitting it fails `dsh web` boot with
    // "TYPERT.model must be an object" (regression guard).
    expect(TYPERT.model).toBeTypeOf('object')
    expect(Array.isArray(TYPERT.model.services)).toBe(true)
    expect(Array.isArray(TYPERT.model.events)).toBe(true)
    expect(Array.isArray(TYPERT.model.objects)).toBe(true)

    const svc = TYPERT.model.services[0]
    expect(svc).toMatchObject({ key: 'usageMeter', exportName: 'usageMeter' })
    expect(Array.isArray(svc.tags)).toBe(true)
    expect(Array.isArray(svc.members)).toBe(true)
    expect(Array.isArray(svc.types)).toBe(true)
    for (const member of svc.members) {
      expect(typeof member.name).toBe('string')
      expect(typeof member.signature).toBe('string')
      expect(MEMBER_KINDS).toContain(member.kind)
    }

    expect(Array.isArray(TYPERT.invocations)).toBe(true)
    const invocation = TYPERT.invocations[0]
    expect(invocation).toMatchObject({
      id: 'dsh-usage-balance-meter#usageMeter/getState',
      service: 'usageMeter',
      namespace: 'usageMeter',
      method: 'getState',
    })
    expect(invocation.invocation.kind).toBe('direct')
    expect(Array.isArray(invocation.parameters)).toBe(true)
    expect(invocation.result.mode).toBe('strict')
    expect(typeof invocation.result.typeSymbol).toBe('string')
  })
})
