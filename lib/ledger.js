/**
 * Persistent usage meter ledger: daily aggregates persisted under
 * `$DSH_HOME/storages/usage-meter/ledger.json`, with today / month / total
 * roll-ups computed from the daily map.
 *
 * @module dsh-usage-balance-meter/ledger
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
const LEDGER_VERSION = 1;
const DEFAULT_HISTORY_DAYS = 180;
function zeroTotals() {
    return { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0 };
}
function addTotals(target, u, cost) {
    target.calls += 1;
    target.input += u.input;
    target.output += u.output;
    target.cacheRead += u.cacheRead;
    target.cacheWrite += u.cacheWrite;
    target.reasoning += u.reasoning;
    target.cost += cost;
}
/** Local-timezone day key for a timestamp, e.g. `2026-08-18`. */
export function localDayKey(ms) {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
/** Local-timezone month key, e.g. `2026-08`. */
export function localMonthKey(ms) {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}
/** Local-timezone date key for a custom range end (inclusive of the day). */
export function addDays(key, days) {
    const [y, m, d] = key.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    date.setDate(date.getDate() + days);
    return localDayKey(date.getTime());
}
function dayExists(daily, key) {
    const existing = daily[key];
    if (existing !== undefined)
        return existing;
    const next = { date: key, totals: zeroTotals(), byProviderModel: {} };
    daily[key] = next;
    return next;
}
/**
 * Open (or create) the ledger file. `historyDays` bounds retention; older
 * days are pruned on the next save.
 */
export class Ledger {
    path;
    historyDays;
    file;
    saveTimer = null;
    constructor(path, historyDays, file) {
        this.path = path;
        this.historyDays = historyDays;
        this.file = file;
    }
    /**
     * Open the ledger. Prefer a caller-supplied `baseDir` (an allowed durable
     * location under the current file policy, e.g. the workspace root); without
     * one, fall back to `$DSH_HOME/storages/usage-meter/ledger.json`.
     * Passing `null` returns a non-persisting in-memory ledger.
     */
    static open(historyDays = DEFAULT_HISTORY_DAYS, baseDir) {
        const path = baseDir === null
            ? ''
            : baseDir === undefined
                ? join(resolveDshHome(), 'storages', 'usage-meter', 'ledger.json')
                : join(baseDir, 'ledger.json');
        let file;
        if (path.length === 0) {
            file = { version: LEDGER_VERSION, historyDays, daily: {}, updatedAt: Date.now() };
        }
        else {
            try {
                const parsed = JSON.parse(readFileSync(path, 'utf8'));
                file = {
                    version: LEDGER_VERSION,
                    historyDays: typeof parsed.historyDays === 'number' ? parsed.historyDays : historyDays,
                    daily: typeof parsed.daily === 'object' && parsed.daily !== null ? parsed.daily : {},
                    updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now(),
                };
            }
            catch {
                file = { version: LEDGER_VERSION, historyDays, daily: {}, updatedAt: Date.now() };
            }
        }
        const ledger = new Ledger(path, historyDays, file);
        ledger.prune();
        return ledger;
    }
    /** Account one model call into its local day aggregate. */
    account(entry) {
        const key = localDayKey(entry.timestamp);
        const day = dayExists(this.file.daily, key);
        addTotals(day.totals, entry.usage, entry.cost);
        const pmKey = `${entry.provider}:${entry.model}`;
        const pm = day.byProviderModel[pmKey] ?? zeroTotals();
        addTotals(pm, entry.usage, entry.cost);
        day.byProviderModel[pmKey] = pm;
        this.file.updatedAt = Date.now();
        this.scheduleSave();
    }
    /** Rolled-up totals for today, this month, and all time. */
    totals() {
        const now = Date.now();
        const todayKey = localDayKey(now);
        const monthKey = localMonthKey(now);
        let today = zeroTotals();
        let month = zeroTotals();
        let all = zeroTotals();
        for (const [key, day] of Object.entries(this.file.daily)) {
            all = sumTotals(all, day.totals);
            if (key === todayKey)
                today = day.totals;
            if (key.startsWith(`${monthKey}-`))
                month = sumTotals(month, day.totals);
        }
        return { today, month, all };
    }
    /** Totals over an inclusive local-day range (`YYYY-MM-DD` .. `YYYY-MM-DD`). */
    rangeTotals(start, end) {
        let sum = zeroTotals();
        for (const [key, day] of Object.entries(this.file.daily)) {
            if (key >= start && key <= end)
                sum = sumTotals(sum, day.totals);
        }
        return sum;
    }
    /** Flush any pending write synchronously (used on disposal). */
    close() {
        if (this.saveTimer !== null) {
            clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }
        this.writeFile();
    }
    scheduleSave() {
        if (this.saveTimer !== null)
            return;
        // 250ms debounce so rapid tool/stream activity coalesces into one write.
        this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            this.writeFile();
        }, 250);
    }
    prune() {
        const cutoff = addDays(localDayKey(Date.now()), -this.historyDays);
        for (const key of Object.keys(this.file.daily)) {
            if (key < cutoff)
                delete this.file.daily[key];
        }
    }
    writeFile() {
        if (this.path.length === 0)
            return; // in-memory ledger
        mkdirSync(dirname(this.path), { recursive: true });
        const tmp = `${this.path}.tmp`;
        writeFileSync(tmp, JSON.stringify(this.file, null, 2), 'utf8');
        renameSync(tmp, this.path);
    }
}
function sumTotals(left, right) {
    return {
        calls: left.calls + right.calls,
        input: left.input + right.input,
        output: left.output + right.output,
        cacheRead: left.cacheRead + right.cacheRead,
        cacheWrite: left.cacheWrite + right.cacheWrite,
        reasoning: left.reasoning + right.reasoning,
        cost: left.cost + right.cost,
    };
}
