/**
 * Host-face Typert manifest for `dsh-usage-balance-meter`.
 *
 * The `typert-loader` scans the package's `./typert` export and registers the
 * invocations so the web client can call `remote.usageMeter.*`.
 *
 * @module dsh-usage-balance-meter/typert
 */
/**
 * Structural contract enforced by `@deepseek-ai/dsh-typert-loader`'s
 * `validateTypertManifest` (packages/typert/loader/src/index.ts in the
 * harness). `TYPERT.model` is REQUIRED — omitting it fails the boot with
 * "`<pkg>` TYPERT.model must be an object". Annotating the manifest with this
 * type moves that failure from runtime to compile time. Keep this in sync if
 * the loader's checks change.
 */
interface TypertServiceMember {
    readonly kind: 'property' | 'method' | 'getter' | 'setter' | 'call' | 'construct' | 'index';
    readonly name: string;
    readonly signature: string;
    readonly summary?: string;
}
interface TypertServiceModel {
    readonly key: string;
    readonly exportName: string;
    readonly description?: string;
    readonly tags: readonly unknown[];
    readonly members: readonly TypertServiceMember[];
    readonly types: readonly {
        readonly name: string;
        readonly declaration: string;
    }[];
}
interface TypertHostModel {
    readonly services: readonly TypertServiceModel[];
    readonly events: readonly {
        readonly name: string;
        readonly signature: string;
        readonly mode?: string;
    }[];
    readonly objects: readonly {
        readonly name: string;
        readonly exportName: string;
        readonly members: readonly TypertServiceMember[];
    }[];
}
interface TypertInvocationDescriptor {
    readonly id: string;
    readonly service: string;
    readonly namespace: string;
    readonly method: string;
    readonly invocation: {
        readonly kind: 'direct' | 'context';
    };
    readonly parameters: readonly unknown[];
    readonly result: {
        readonly mode: 'strict';
        readonly typeSymbol: string;
        readonly schema: unknown;
    };
}
interface TypertHostManifest {
    readonly package: string;
    readonly face: 'host';
    readonly schemas: readonly unknown[];
    readonly model: TypertHostModel;
    readonly invocations: readonly TypertInvocationDescriptor[];
}
/** The full Typert manifest for this package. */
export declare const TYPERT: TypertHostManifest;
export default TYPERT;
