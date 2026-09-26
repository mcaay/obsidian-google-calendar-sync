import { describe, expect, it } from 'vitest';
import { deviceSnapshot, restoreDeviceState, sharedSnapshot } from '../src/device-state';
import { item, seeded } from './fixtures';

describe('device-local sync state', () => {
    const pending = () => {
        const { data } = seeded([item()]);
        data.version = 1;
        data.outbox.pending = { key: 'pending', path: '2026-09-19.md', kind: 'task', id: '', source: 'list',
            title: 'Only create once', create: { date: '2026-09-19', phase: 'prepared' } };
        return data;
    };
    it('preserves the original desktop outbox on upgrade', () => {
        const shared = pending();
        expect(restoreDeviceState(shared, null, false).outbox).toEqual(shared.outbox);
    });
    it('does not replay another device’s requests on mobile or a second desktop', () => {
        const shared = pending();
        expect(restoreDeviceState(shared, null, true).outbox).toEqual({});
        shared.runtimeOwner = 'original-device';
        const restored = restoreDeviceState(shared, null, false);
        expect(restored.outbox).toEqual({});
        expect(restored.notes).toEqual(shared.notes);
        expect(restored.runtimeOwner).not.toBe(shared.runtimeOwner);
    });
    it('restores this device’s offline edits and imports only shared configuration', () => {
        const local = restoreDeviceState(pending(), null, false);
        const shared = pending();
        shared.outbox = {};
        shared.notes = {};
        shared.settings.intervalSeconds = 180;
        const restored = restoreDeviceState(shared, deviceSnapshot(local), true);
        expect(restored.outbox).toEqual(local.outbox);
        expect(restored.notes).toEqual(local.notes);
        expect(restored.settings.intervalSeconds).toBe(180);
    });
    it('never puts runtime queues, note paths or device identifiers into synced settings', () => {
        const data = restoreDeviceState(pending(), null, false);
        expect(sharedSnapshot(data)).toEqual({ version: 2, settings: data.settings });
        expect(restoreDeviceState(sharedSnapshot(data), null, true).outbox).toEqual({});
    });
});
