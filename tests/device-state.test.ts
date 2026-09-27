import { describe, expect, it } from 'vitest';
import { deviceSnapshot, journalSnapshot, restoreDeviceState, sharedSnapshot } from '../src/device-state';
import { itemKey } from '../src/markdown';
import type { PluginData } from '../src/types';
import { item, seeded } from './fixtures';

const NOW = 5_000_000;

// A 0.8.2 data.json: pending work lived in the shared file.
function legacy(): Partial<PluginData> & Record<string, unknown> {
    const { data } = seeded([item()]);
    return {
        version: 1 as unknown as 2, settings: data.settings,
        notes: { '2026-09-19.md': { rows: data.notes['2026-09-19.md']!.rows, retained: [item().key] } as never },
        outbox: {
            prepared: { key: 'prepared', path: '2026-09-19.md', kind: 'task', id: '', source: 'list', title: 'Only create once', create: { date: '2026-09-19', phase: 'prepared' } },
            sent: { key: 'sent', path: '2026-09-19.md', kind: 'task', id: '', source: 'list', title: 'Maybe created', create: { date: '2026-09-19', phase: 'sent' as never } },
            title: { key: 'title', path: '2026-09-19.md', kind: 'task', id: 'task-1', source: 'list', title: 'Renamed' },
            removal: { key: 'removal', path: '2026-09-19.md', kind: 'event', id: 'e', source: 'calendar', remove: true, removeAfter: NOW + 3000 },
        },
        created: { 'new:replacement': { source: 'list', id: 'created' } },
        deletedTasks: { [item().key]: { path: '2026-09-19.md', item: item(), deletionKey: item().key, deleted: false, restoredKey: 'new:replacement' } },
    };
}

describe('device-local sync state', () => {
    it('upgrades a 0.8.2 outbox on the original desktop (1.9)', () => {
        const { data, dropped } = restoreDeviceState(legacy(), null, null, false, NOW);
        expect(dropped).toEqual([]);
        expect(data.outbox.prepared?.create?.phase).toBe('prepared');
        // A POST that was sent may have succeeded: search before sending again.
        expect(data.outbox.sent?.create).toMatchObject({ phase: 'uncertain', settled: NOW });
        expect(data.outbox.title?.title).toBe('Renamed');
        expect(data.outbox.removal?.removeAfter).toBe(NOW + 3000);
        expect(data.notes['2026-09-19.md']).not.toHaveProperty('retained');
        expect(data.aliases[item().key]).toBe(itemKey('task', 'list', 'created'));
        expect(data.runtimeOwner).toBeTruthy();
    });
    it('upgrades 0.9.0 device state with pending work of each kind (1.9)', () => {
        const old = legacy();
        const local = { runtimeOwner: 'desktop', notes: old.notes, outbox: old.outbox, created: old.created, deletedTasks: old.deletedTasks };
        const { data } = restoreDeviceState({ version: 2, settings: seeded([]).data.settings }, local as never, null, false, NOW);
        expect(data.runtimeOwner).toBe('desktop');
        expect(Object.keys(data.outbox)).toEqual(['prepared', 'sent', 'title', 'removal']);
        expect(data.outbox.sent?.create?.phase).toBe('uncertain');
        expect(data.deletedTasks[item().key]?.restoredKey).toBe('new:replacement');
        expect(data.aliases[item().key]).toBe(itemKey('task', 'list', 'created'));
        // The next save splits the state into its two keys.
        expect(journalSnapshot(data)).toMatchObject({ version: 3, outbox: data.outbox, deletedTasks: data.deletedTasks });
        expect(deviceSnapshot(data)).not.toHaveProperty('outbox');
    });
    it('drops a record it cannot read and names it, instead of failing the load', () => {
        const old = legacy();
        (old.outbox as Record<string, unknown>).broken = { key: 'broken', kind: 'task' };
        (old.created as Record<string, unknown>).bad = { id: 1 };
        const { data, dropped } = restoreDeviceState(old, null, null, false, NOW);
        expect(data.outbox.broken).toBeUndefined();
        expect(data.created.bad).toBeUndefined();
        expect(dropped).toEqual(['a pending change (broken)', 'a created task (bad)']);
    });
    it('does not replay another device’s requests on mobile or a second desktop', () => {
        const shared = legacy();
        expect(restoreDeviceState(shared, null, null, true).data.outbox).toEqual({});
        shared.runtimeOwner = 'original-device';
        const restored = restoreDeviceState(shared, null, null, false).data;
        expect(restored.outbox).toEqual({});
        expect(restored.created).toEqual({});
        expect(restored.runtimeOwner).not.toBe('original-device');
    });
    it('restores this device’s state and journal and imports only shared configuration', () => {
        const local = restoreDeviceState(legacy(), null, null, false, NOW).data;
        local.edits.task = { path: '2026-09-19.md', title: 'Typed here' };
        const shared = legacy();
        shared.outbox = {};
        shared.settings!.intervalSeconds = 180;
        const restored = restoreDeviceState(shared, structuredClone(deviceSnapshot(local)), structuredClone(journalSnapshot(local)), true).data;
        expect(restored.outbox).toEqual(local.outbox);
        expect(restored.edits).toEqual(local.edits);
        expect(restored.notes).toEqual(local.notes);
        expect(restored.settings.intervalSeconds).toBe(180);
    });
    it('never puts runtime queues, note paths or device identifiers into synced settings', () => {
        const { data } = restoreDeviceState(legacy(), null, null, false);
        expect(sharedSnapshot(data)).toEqual({ version: 2, settings: data.settings });
        expect(restoreDeviceState(sharedSnapshot(data), null, null, true).data.outbox).toEqual({});
    });
});
