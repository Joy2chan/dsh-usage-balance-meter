/**
 * Persistent usage meter ledger: daily aggregates persisted under
 * `$DSH_HOME/storages/usage-meter/ledger.json` (or a workspace-root copy),
 * with today / month / total roll-ups computed from the daily map.
 *
 * Costs are stored **per currency** (`Record<currency, number>`) so providers
 * billed in different currencies are NEVER summed together.
 *
 * @module dsh-usage-balance-meter/ledger
 */
/** Disjoint token buckets for one accounted model call. */
export interface LedgerUsage {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    reasoning: number;
}
/** One accounted model call captured from an `llm/stream` usage chunk. */
export interface LedgerEntry {
    provider: string;
    model: string;
    sessionId?: string;
    timestamp: number;
    usage: LedgerUsage;
    /** Currency this call was billed in. */
    currency: string;
    /** Cost value in {@link currency}. */
    cost: number;
}
/** A rolled-up view of a period's totals. Costs are keyed by currency. */
export interface TotalsView {
    calls: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    reasoning: number;
    cost: Record<string, number>;
}
/** Local-timezone day key for a timestamp, e.g. `2026-08-18`. */
export declare function localDayKey(ms: number): string;
/** Local-timezone month key, e.g. `2026-08`. */
export declare function localMonthKey(ms: number): string;
/** Move a local day key forward/back by whole days. */
export declare function addDays(key: string, days: number): string;
/**
 * Open (or create) the ledger file. `historyDays` bounds retention; older
 * days are pruned on the next save.
 */
export declare class Ledger {
    readonly path: string;
    private readonly historyDays;
    private file;
    private saveTimer;
    private constructor();
    /**
     * Open the ledger. Prefer a caller-supplied `baseDir` (an allowed durable
     * location under the current file policy, e.g. the workspace root); without
     * one, fall back to `$DSH_HOME/storages/usage-meter/ledger.json`.
     * Passing `null` returns a non-persisting in-memory ledger.
     */
    static open(historyDays?: number, baseDir?: string | null): Ledger;
    /** Account one model call into its local day aggregate. */
    account(entry: LedgerEntry): void;
    /** Rolled-up totals for today, this month, and all time. */
    totals(): {
        today: TotalsView;
        month: TotalsView;
        all: TotalsView;
    };
    /** Totals over an inclusive local-day range (`YYYY-MM-DD` .. `YYYY-MM-DD`). */
    rangeTotals(start: string, end: string): TotalsView;
    /** Cost for one currency across the whole ledger. */
    costIn(currency: string): number;
    /** Flush any pending write synchronously (used on disposal). */
    close(): void;
    private scheduleSave;
    private prune;
    private writeFile;
}
