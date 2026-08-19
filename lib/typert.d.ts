/**
 * Host-face Typert manifest for `dsh-usage-balance-meter`.
 *
 * The `typert-loader` scans the package's `./typert` export and registers the
 * invocations so the web client can call `remote.usageMeter.*`.
 *
 * @module dsh-usage-balance-meter/typert
 */
import { z } from 'zod';
/** The full Typert manifest for this package. */
export declare const TYPERT: {
    package: string;
    face: "host";
    schemas: never[];
    invocations: {
        id: string;
        service: string;
        namespace: string;
        method: string;
        invocation: {
            kind: "direct";
        };
        parameters: never[];
        result: {
            mode: "strict";
            typeSymbol: string;
            schema: z.ZodObject<{
                currency: z.ZodString;
                today: z.ZodObject<{
                    calls: z.ZodNumber;
                    input: z.ZodNumber;
                    output: z.ZodNumber;
                    cacheRead: z.ZodNumber;
                    cacheWrite: z.ZodNumber;
                    reasoning: z.ZodNumber;
                    cost: z.ZodRecord<z.ZodString, z.ZodNumber>;
                }, z.core.$strip>;
                month: z.ZodObject<{
                    calls: z.ZodNumber;
                    input: z.ZodNumber;
                    output: z.ZodNumber;
                    cacheRead: z.ZodNumber;
                    cacheWrite: z.ZodNumber;
                    reasoning: z.ZodNumber;
                    cost: z.ZodRecord<z.ZodString, z.ZodNumber>;
                }, z.core.$strip>;
                all: z.ZodObject<{
                    calls: z.ZodNumber;
                    input: z.ZodNumber;
                    output: z.ZodNumber;
                    cacheRead: z.ZodNumber;
                    cacheWrite: z.ZodNumber;
                    reasoning: z.ZodNumber;
                    cost: z.ZodRecord<z.ZodString, z.ZodNumber>;
                }, z.core.$strip>;
                budget: z.ZodNullable<z.ZodObject<{
                    enabled: z.ZodLiteral<true>;
                    period: z.ZodString;
                    used: z.ZodNumber;
                    amount: z.ZodNumber;
                    percent: z.ZodNumber;
                    warnPercent: z.ZodNumber;
                    errorPercent: z.ZodNumber;
                }, z.core.$strip>>;
            }, z.core.$strip>;
        };
    }[];
};
export default TYPERT;
