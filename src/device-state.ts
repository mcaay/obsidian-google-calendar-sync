import { initialData, type PluginData } from './types';

export const DEVICE_STATE_KEY = 'google-daily-notes-device-state';
type Runtime = Pick<PluginData, 'notes' | 'outbox' | 'created' | 'deletedTasks' | 'runtimeOwner'>;

/**
 * How to read this code:
 * 1. onload() in src/main.ts reads shared data.json and device-local storage.
 * 2. restoreDeviceState() takes settings and encrypted setup from Sync, but uses
 *    this device's own baselines and outbox once initialized.
 * 3. persist() saves runtime locally before saving settings and encrypted setup.
 *    sharedSnapshot() excludes runtime from data.json. External
 *    settings changes update settings only, never another device's pending work.
 * Ordinary: a phone imports source choices without replaying desktop requests.
 * Tricky: upgrading the original desktop keeps its pre-mobile offline outbox.
 */
export function restoreDeviceState(shared: Partial<PluginData> | null, local: Runtime | null, mobile: boolean): PluginData {
    const defaults = initialData();
    const data = { ...defaults, ...shared, version: 2 as const, settings: { ...defaults.settings, ...shared?.settings } };
    if (local) Object.assign(data, local);
    else {
        // Only the original desktop may migrate the old, unowned outbox.
        if (mobile || shared?.runtimeOwner || shared?.version === 2) {
            data.outbox = {};
            data.created = {};
            data.deletedTasks = {};
        }
        data.runtimeOwner = crypto.randomUUID();
    }
    return data;
}

export function deviceSnapshot(data: PluginData): Runtime {
    return structuredClone({ runtimeOwner: data.runtimeOwner, notes: data.notes, outbox: data.outbox,
        created: data.created, deletedTasks: data.deletedTasks });
}

export function sharedSnapshot(data: PluginData): Pick<PluginData, 'version' | 'settings' | 'connectionTransfer'> {
    return structuredClone({ version: 2, settings: data.settings,
        ...(data.connectionTransfer ? { connectionTransfer: data.connectionTransfer } : {}) });
}
