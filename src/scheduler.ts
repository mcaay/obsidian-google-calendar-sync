export type Reason = 'open' | 'edit' | 'toggle' | 'delete' | 'periodic';

// setTimeout overflows above 2^31 ms, so the interval stays within a day.
export const MIN_INTERVAL = 30;
export const MAX_INTERVAL = 24 * 3600;

/** One queue prevents overlapping pulls, pushes, and note writes. */
export class SyncScheduler {
    private timer?: ReturnType<typeof setTimeout>;
    private idle = new Map<string, ReturnType<typeof setTimeout>>();
    // pull: whether the run may skip reading Google when it sent nothing (4.5).
    private queue = new Map<string, { titles: boolean; pull: boolean; reset: boolean }>();
    private busy = false;
    private stopped = false;
    readonly dirty = new Set<string>();

    constructor(private run: (path: string, titles: boolean, pull: boolean) => Promise<void>, private paths: () => string[], private interval: () => number, private onError: (error: unknown) => void) {}

    start(): void { this.resetPeriodic(); }

    request(path: string, reason: Reason, titles = reason !== 'toggle'): void {
        if (this.stopped) return;
        const old = this.queue.get(path);
        this.queue.set(path, {
            titles: titles || Boolean(old?.titles),
            pull: reason !== 'edit' || Boolean(old?.pull),
            reset: reason === 'edit' || reason === 'toggle' || reason === 'delete' || Boolean(old?.reset),
        });
        void this.drain();
    }

    changed(path: string, vim: boolean, toggled: boolean): void {
        this.dirty.add(path);
        const old = this.idle.get(path);
        if (old) clearTimeout(old);
        if (toggled) this.request(path, 'toggle', false);
        if (!vim) this.idle.set(path, setTimeout(() => this.normal(path), 10000));
    }

    normal(path: string): void {
        const timer = this.idle.get(path);
        if (timer) clearTimeout(timer);
        this.idle.delete(path);
        if (this.dirty.delete(path)) this.request(path, 'edit', true);
    }

    private async drain(): Promise<void> {
        if (this.busy || this.stopped) return;
        this.busy = true;
        try {
            while (this.queue.size && !this.stopped) {
                const [path, job] = this.queue.entries().next().value!;
                this.queue.delete(path);
                try { await this.run(path, job.titles, job.pull); } catch (error) { this.onError(error); }
                if (job.reset) this.resetPeriodic();
            }
        } finally { this.busy = false; }
    }

    resetPeriodic(): void {
        if (this.timer) clearTimeout(this.timer);
        if (this.stopped) return;
        this.timer = setTimeout(() => {
            for (const path of this.paths()) this.request(path, 'periodic', !this.dirty.has(path));
            this.resetPeriodic();
        }, Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, this.interval())) * 1000);
    }

    dispose(): void {
        this.stopped = true;
        if (this.timer) clearTimeout(this.timer);
        for (const timer of this.idle.values()) clearTimeout(timer);
        this.idle.clear(); this.queue.clear(); this.dirty.clear();
    }
}
