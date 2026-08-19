/**
 * Host-face Typert manifest for `dsh-usage-balance-meter`.
 *
 * The `typert-loader` scans the package's `./typert` export and registers the
 * invocations so the web client can call `remote.usageMeter.*`.
 *
 * @module dsh-usage-balance-meter/typert
 */

import { z } from 'zod'

const num = z.number()

const totalsSchema = z.object({
  calls: num,
  input: num,
  output: num,
  cacheRead: num,
  cacheWrite: num,
  reasoning: num,
  cost: num,
})

const budgetSchema = z.object({
  enabled: z.literal(true),
  period: z.string(),
  used: num,
  amount: num,
  percent: num,
  warnPercent: num,
  errorPercent: num,
})

const costStateSchema = z.object({
  currency: z.string(),
  today: totalsSchema,
  month: totalsSchema,
  all: totalsSchema,
  budget: budgetSchema.nullable(),
})

const costStateCodec = {
  mode: 'strict' as const,
  typeSymbol: 'dsh-usage-balance-meter#CostState',
  schema: costStateSchema,
}

/** The full Typert manifest for this package. */
export const TYPERT = {
  package: 'dsh-usage-balance-meter',
  face: 'host' as const,
  schemas: [],
  invocations: [
    {
      id: 'dsh-usage-balance-meter#usageMeter/getState',
      service: 'usageMeter',
      namespace: 'usageMeter',
      method: 'getState',
      invocation: { kind: 'direct' as const },
      parameters: [],
      result: costStateCodec,
    },
  ],
}

export default TYPERT
