import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Ledger, localDayKey, type LedgerUsage } from '../src/ledger.js'

const oldHome = process.env.DSH_HOME
let dir: string

function usage(input: number, output: number, cacheRead = 0, cacheWrite = 0, reasoning = 0): LedgerUsage {
  return { input, output, cacheRead, cacheWrite, reasoning }
}

afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  if (oldHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = oldHome
})

describe('Ledger', () => {
  it('accumulates today/month/all totals and persists on close', () => {
    dir = mkdtempSync(join(tmpdir(), 'um-ledger-'))
    process.env.DSH_HOME = dir
    const path = join(dir, 'storages', 'usage-meter', 'ledger.json')

    const ledger = Ledger.open()
    const now = Date.now()
    ledger.account({ provider: 'deepseek-official', model: 'deepseek-v4-pro', timestamp: now, usage: usage(1000, 200), cost: 0.1 })
    ledger.account({ provider: 'deepseek-official', model: 'deepseek-v4-flash', timestamp: now, usage: usage(500, 100), cost: 0.05 })
    const totals = ledger.totals()
    expect(totals.today.calls).toBe(2)
    expect(totals.today.input).toBe(1500)
    expect(totals.today.output).toBe(300)
    expect(totals.today.cost).toBeCloseTo(0.15)
    expect(totals.month.calls).toBe(2)
    expect(totals.all.calls).toBe(2)
    ledger.close()

    // Reopen to confirm persistence.
    const reopened = Ledger.open()
    expect(reopened.totals().today.calls).toBe(2)
    expect(reopened.totals().all.cost).toBeCloseTo(0.15)
    reopened.close()

    expect(localDayKey(now).length).toBe(10)
  })

  it('rangeTotals sums inclusive date ranges', () => {
    dir = mkdtempSync(join(tmpdir(), 'um-range-'))
    process.env.DSH_HOME = dir
    const ledger = Ledger.open()
    const base = Date.parse('2026-08-10T12:00:00Z')
    ledger.account({ provider: 'p', model: 'm', timestamp: base, usage: usage(1, 1), cost: 1 })
    ledger.account({ provider: 'p', model: 'm', timestamp: base + 2 * 86400_000, usage: usage(1, 1), cost: 2 })
    const range = ledger.rangeTotals('2026-08-09', '2026-08-11')
    expect(range.calls).toBe(1)
    expect(range.cost).toBe(1)
    ledger.close()
  })
})
