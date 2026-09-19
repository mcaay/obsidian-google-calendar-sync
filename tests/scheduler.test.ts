import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SyncScheduler } from '../src/scheduler';

describe('sync timing', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());
    const setup = () => {
        const run = vi.fn(async (_path: string, _titles: boolean) => undefined);
        const error = vi.fn();
        const scheduler = new SyncScheduler(run, () => ['day.md'], () => 120, error);
        scheduler.start();
        return { scheduler, run, error };
    };
    it('polls at 120 seconds', async () => {
        const { scheduler, run } = setup(); await vi.advanceTimersByTimeAsync(119999); expect(run).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1); expect(run).toHaveBeenCalledWith('day.md', true); scheduler.dispose();
    });
    it('debounces non-Vim edits for 10 seconds of inactivity', async () => {
        const { scheduler, run } = setup(); scheduler.changed('day.md', false, false);
        await vi.advanceTimersByTimeAsync(9000); scheduler.changed('day.md', false, false);
        await vi.advanceTimersByTimeAsync(9999); expect(run).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1); expect(run).toHaveBeenCalledOnce(); scheduler.dispose();
    });
    it('waits for Vim normal mode instead of an idle timeout', async () => {
        const { scheduler, run } = setup(); scheduler.changed('day.md', true, false);
        await vi.advanceTimersByTimeAsync(11000); expect(run).not.toHaveBeenCalled();
        scheduler.normal('day.md'); expect(run).toHaveBeenCalledWith('day.md', true); scheduler.dispose();
    });
    it('sends toggles immediately and restarts the periodic clock', async () => {
        const { scheduler, run } = setup(); await vi.advanceTimersByTimeAsync(100000);
        scheduler.changed('day.md', true, true); await vi.advanceTimersByTimeAsync(0);
        expect(run).toHaveBeenCalledWith('day.md', false);
        await vi.advanceTimersByTimeAsync(119999); expect(run).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(1); expect(run).toHaveBeenCalledTimes(2); scheduler.dispose();
    });
    it('serializes concurrent requests and coalesces pending jobs', async () => {
        let finish!: () => void;
        const { scheduler, run } = setup();
        run.mockImplementationOnce(() => new Promise<undefined>(resolve => { finish = () => resolve(undefined); }));
        scheduler.request('one', 'open'); scheduler.request('two', 'toggle'); scheduler.request('two', 'edit');
        expect(run).toHaveBeenCalledOnce(); finish(); await vi.advanceTimersByTimeAsync(0);
        expect(run).toHaveBeenCalledTimes(2); expect(run).toHaveBeenLastCalledWith('two', true); scheduler.dispose();
    });
    it('resets the periodic timer after a grace-period deletion sync', async () => {
        const { scheduler, run } = setup();
        await vi.advanceTimersByTimeAsync(5000);
        scheduler.request('day.md', 'delete', false);
        await vi.advanceTimersByTimeAsync(119999);
        expect(run).toHaveBeenCalledOnce();
        expect(run).toHaveBeenCalledWith('day.md', false);
        await vi.advanceTimersByTimeAsync(1);
        expect(run).toHaveBeenCalledTimes(2);
        scheduler.dispose();
    });
    it('cancels timers and queued work on unload', async () => {
        const { scheduler, run } = setup(); scheduler.changed('day.md', false, false); scheduler.dispose();
        await vi.advanceTimersByTimeAsync(240000); expect(run).not.toHaveBeenCalled();
    });
});
