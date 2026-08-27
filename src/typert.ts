/**
 * Host-face Typert manifest for `dsh-usage-balance-meter`.
 *
 * The `typert-loader` scans the package's `./typert` export and registers the
 * invocations so the web client can call `remote.usageMeter.*`.
 *
 * @module dsh-usage-balance-meter/typert
 */

import { z } from 'zod'

/**
 * Structural contract enforced by `@deepseek-ai/dsh-typert-loader`'s
 * `validateTypertManifest` (packages/typert/loader/src/index.ts in the
 * harness). `TYPERT.model` is REQUIRED — omitting it fails the boot with
 * "`<pkg>` TYPERT.model must be an object". Annotating the manifest with this
 * type moves that failure from runtime to compile time. Keep this in sync if
 * the loader's checks change.
 */
interface TypertServiceMember {
  readonly kind: 'property' | 'method' | 'getter' | 'setter' | 'call' | 'construct' | 'index'
  readonly name: string
  readonly signature: string
  readonly summary?: string
}

interface TypertServiceModel {
  readonly key: string
  readonly exportName: string
  readonly description?: string
  readonly tags: readonly unknown[]
  readonly members: readonly TypertServiceMember[]
  readonly types: readonly { readonly name: string; readonly declaration: string }[]
}

interface TypertHostModel {
  readonly services: readonly TypertServiceModel[]
  readonly events: readonly { readonly name: string; readonly signature: string; readonly mode?: string }[]
  readonly objects: readonly { readonly name: string; readonly exportName: string; readonly members: readonly TypertServiceMember[] }[]
}

interface TypertInvocationDescriptor {
  readonly id: string
  readonly service: string
  readonly namespace: string
  readonly method: string
  readonly invocation: { readonly kind: 'direct' | 'context' }
  readonly parameters: readonly unknown[]
  readonly result: { readonly mode: 'strict'; readonly typeSymbol: string; readonly schema: unknown }
}

interface TypertHostManifest {
  readonly package: string
  readonly face: 'host'
  readonly schemas: readonly unknown[]
  readonly model: TypertHostModel
  readonly invocations: readonly TypertInvocationDescriptor[]
}

const num = z.number()

const totalsSchema = z.object({
  calls: num,
  input: num,
  output: num,
  cacheRead: num,
  cacheWrite: num,
  reasoning: num,
  cost: z.record(z.string(), num),
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
export const TYPERT: TypertHostManifest = {
  package: 'dsh-usage-balance-meter',
  face: 'host',
  schemas: [],
  model: {
    services: [
      {
        key: 'usageMeter',
        exportName: 'usageMeter',
        description: 'Host-side usage meter service consumed by the web client footer.',
        tags: [],
        members: [
          {
            kind: 'method',
            name: 'getState',
            signature: 'getState(): Promise<CostState>',
            summary: 'Return the current cost state (today/month/all totals and budget).',
          },
        ],
        types: [],
      },
    ],
    events: [],
    objects: [],
  },
  invocations: [
    {
      id: 'dsh-usage-balance-meter#usageMeter/getState',
      service: 'usageMeter',
      namespace: 'usageMeter',
      method: 'getState',
      invocation: { kind: 'direct' },
      parameters: [],
      result: costStateCodec,
    },
  ],
}

export default TYPERT
