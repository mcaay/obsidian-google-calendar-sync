import { itemKey } from './markdown';
import { initialData, type Journal, type PluginData } from './types';

export const DEVICE_STATE_KEY = 'google-daily-notes-device-state';
export const JOURNAL_KEY = 'google-daily-notes-journal';
const VERSION = 3;

type Device = Pick<PluginData, 'runtimeOwner' | 'notes' | 'created' | 'calendars'>;
export type DeviceSnapshot = Device & { version: number };
export type JournalSnapshot = Journal & { version: number };

/**
 * How to read this code:
 * 1. onload() in src/main.ts reads shared data.json and this device's two
 *    local storage keys: the device state (note snapshots, created IDs,
 *    calendar cache) and the journal (pending work and undo decisions).
 * 2. restoreDeviceState() takes settings and encrypted setup from Sync, but uses
 *    this device's own state once initialized. migrate() upgrades 0.8.2's
 *    data.json and 0.9.0's single device key to the current shape.
 * 3. main.ts saves the journal after every editor decision and the device
 *    state after runs, reading each save back. sharedSnapshot() keeps runtime
 *    state out of data.json.
 * Ordinary: a phone imports source choices without replaying desktop requests.
 * Tricky: upgrading the original desktop keeps its pre-mobile offline outbox;
 *    a creation it had sent becomes uncertain and is searched for, not resent.
 */
export function restoreDeviceState(shared: Partial<PluginData> | null, local: Partial<DeviceSnapshot & Journal> | null, journal: Partial<JournalSnapshot> | null, mobile: boolean, now = Date.now()): { data: PluginData; dropped: string[] } {
    const defaults = initialData();
    const data: PluginData = { ...defaults, settings: { ...defaults.settings, ...shared?.settings }, notes: shared?.notes ?? {} };
    if (shared?.connectionTransfer) data.connectionTransfer = shared.connectionTransfer;
    if (local) {
        Object.assign(data, { runtimeOwner: local.runtimeOwner, notes: local.notes ?? {}, created: local.created ?? {}, calendars: local.calendars ?? {} });
        // 0.9.0 kept pending work inside the device state.
        const pending = local.version === VERSION ? journal : local;
        Object.assign(data, { edits: pending?.edits ?? {}, outbox: pending?.outbox ?? {}, deletedTasks: pending?.deletedTasks ?? {}, aliases: pending?.aliases ?? {}, drafts: pending?.drafts ?? {} });
    } else {
        // Only the original desktop may migrate the old, unowned outbox.
        if (!mobile && !shared?.runtimeOwner && shared?.version !== 2) {
            Object.assign(data, { outbox: shared?.outbox ?? {}, created: shared?.created ?? {}, deletedTasks: shared?.deletedTasks ?? {} });
        }
        data.runtimeOwner = crypto.randomUUID();
    }
    return { data, dropped: migrate(data, now) };
}

// Brings records from older versions to the current shape. A record that
// cannot be read is dropped and named, instead of breaking the load.
function migrate(data: PluginData, now: number): string[] {
    const dropped: string[] = [];
    const text = (value: unknown) => typeof value === 'string';
    for (const [path, state] of Object.entries(data.notes)) {
        if (!state || typeof state.rows !== 'object') { delete data.notes[path]; dropped.push(`sync state of ${path}`); continue; }
        // Retention now follows the checked rows in the note itself.
        delete (state as { retained?: unknown }).retained;
        // Pruning counts a snapshot's age from its last sync; start now.
        state.synced ??= now;
    }
    for (const [key, operation] of Object.entries(data.outbox)) {
        if (!operation || !text(operation.key) || !text(operation.path) || !text(operation.source) || !['event', 'task'].includes(operation.kind)) {
            delete data.outbox[key]; dropped.push(`a pending change (${key})`); continue;
        }
        const phase = operation.create?.phase as string | undefined;
        // A POST that was in flight when the app stopped may have succeeded.
        if (phase === 'sent' || phase === 'sending') operation.create = { ...operation.create!, phase: 'uncertain', settled: now };
        else if (operation.create && !['prepared', 'uncertain', 'refused'].includes(phase ?? '')) { delete data.outbox[key]; dropped.push(`a task creation (${operation.title ?? key})`); }
    }
    for (const [key, record] of Object.entries(data.created)) {
        if (!record || !text(record.source) || !text(record.id)) { delete data.created[key]; dropped.push(`a created task (${key})`); continue; }
        record.at ??= now;
    }
    for (const [key, record] of Object.entries(data.deletedTasks)) {
        if (!record || !text(record.path) || !record.item || !text(record.deletionKey)) { delete data.deletedTasks[key]; dropped.push(`an undo record (${key})`); continue; }
        // 0.9.0 kept the old row key after a late undo. Point it at the task
        // that replaced it (1.6).
        const replacement = record.restoredKey ? data.created[record.restoredKey] : undefined;
        if (replacement && !data.aliases[key]) data.aliases[key] = itemKey('task', replacement.source, replacement.id);
    }
    return dropped;
}

export function deviceSnapshot(data: PluginData): DeviceSnapshot {
    return { version: VERSION, runtimeOwner: data.runtimeOwner, notes: data.notes, created: data.created, calendars: data.calendars };
}

export function journalSnapshot(data: PluginData): JournalSnapshot {
    return { version: VERSION, edits: data.edits, outbox: data.outbox, deletedTasks: data.deletedTasks, aliases: data.aliases, drafts: data.drafts };
}

export function sharedSnapshot(data: PluginData): Pick<PluginData, 'version' | 'settings' | 'connectionTransfer'> {
    return structuredClone({ version: 2, settings: data.settings,
        ...(data.connectionTransfer ? { connectionTransfer: data.connectionTransfer } : {}) });
}
