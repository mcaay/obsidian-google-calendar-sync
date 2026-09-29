import { Notice, Platform, Plugin, requestUrl } from 'obsidian';
import { GoogleAuth } from './auth';
import { GoogleClient } from './google';
import { Controller } from './controller';
import { editorExtension } from './editor';
import { GoogleSettingsTab } from './settings';
import { initialData, type PluginData } from './types';
import { DEVICE_STATE_KEY, deviceSnapshot, JOURNAL_KEY, journalSnapshot, restoreDeviceState, sharedSnapshot, type DeviceSnapshot, type JournalSnapshot } from './device-state';
import { RequestTimeout, type HttpResponse, type Transport } from './http';
import type { SaveScope } from './sync';

const SESSION_KEY = 'google-daily-notes-session';

/**
 * How to read this code:
 * 1. onload() restores settings, this device's state and its journal
 *    (device-state.ts), then wires GoogleAuth (auth.ts) and GoogleClient
 *    (google.ts) to Controller (controller.ts).
 * 2. Controller.start() registers note events and starts SyncScheduler (scheduler.ts).
 * 3. editorExtension() (editor.ts) journals native Markdown edits; SyncEngine.run()
 *    (sync.ts) reconciles them with Google and writes managed regions back safely.
 * 4. saveLocal() writes the journal or all device state and reads it back.
 *    Obsidian's storage helper ignores write errors, so a failed read-back is
 *    the only signal; SyncEngine then sends nothing (1.7).
 * Ordinary: opening an enabled daily note starts a sync without a button.
 * Tricky: an offline title edit stays in the journal and is retried after restart.
 */
export default class GoogleDailyNotes extends Plugin {
    data!: PluginData;
    auth!: GoogleAuth;
    google!: GoogleClient;
    controller!: Controller;
    private saving: Promise<void> = Promise.resolve();
    private sharedJSON = '';

    async onload(): Promise<void> {
        const stored = await this.loadData() as Partial<PluginData> | null;
        this.sharedJSON = JSON.stringify(stored);
        const restored = restoreDeviceState(stored,
            this.app.loadLocalStorage(DEVICE_STATE_KEY) as Partial<DeviceSnapshot & PluginData> | null,
            this.app.loadLocalStorage(JOURNAL_KEY) as Partial<JournalSnapshot> | null, Platform.isMobile);
        this.data = restored.data;
        if (restored.dropped.length) new Notice(`Calendar Sync could not upgrade ${restored.dropped.join(', ')} and removed it.`);
        this.saveLocal('all');
        const transport: Transport = async request => {
            const response: Promise<HttpResponse> = requestUrl({ ...request, throw: false }).then(result => {
                let json: unknown;
                // Error pages can be HTML. Keep the status either way.
                try { json = result.text ? JSON.parse(result.text) as unknown : {}; } catch { json = undefined; }
                return { status: result.status, json, headers: result.headers };
            });
            response.catch(() => undefined);
            let timer: number | undefined;
            try {
                return await Promise.race([
                    response,
                    new Promise<never>((_resolve, reject) => { timer = window.setTimeout(() => reject(new RequestTimeout(response)), 30000); }),
                ]);
            } finally { if (timer) window.clearTimeout(timer); }
        };
        this.auth = new GoogleAuth(this.app.secretStorage, () => this.data.settings.clientId, transport, async url => { window.open(url, '_external'); });
        this.google = new GoogleClient(transport, force => this.auth.token(force));
        this.controller = new Controller(this, this.data, this.google, scope => this.saveLocal(scope), this.auth);
        const engine = this.controller.engine;
        this.registerEditorExtension(editorExtension({
            rows: path => engine.editorRows(path),
            indent: () => this.controller.indent(),
            tabWidth: () => this.controller.tabWidth(),
            draftKey: () => engine.draftKey(),
            resolve: key => engine.resolve(key),
            changed: (path, vim, toggled) => this.controller.scheduler.changed(path, vim, toggled),
            normal: path => this.controller.scheduler.normal(path),
            edited: (path, edits) => engine.journalEdits(path, edits),
            deleted: (path, rows) => this.controller.queueDeletions(path, rows),
            restored: (path, keys, at) => this.controller.restoreDeletions(path, keys, at),
            external: (path, before, after) => this.controller.external(path, before, after),
            blocked: message => new Notice(message),
        }));
        this.addSettingTab(new GoogleSettingsTab(this.app, this));
        this.addCommand({
            id: 'insert-daily-sections', name: 'Insert Google daily sections',
            editorCallback: (editor, context) => {
                if (context.file) void this.controller.insertTemplate(editor, context.file).catch(error => new Notice(error instanceof Error ? error.message : String(error)));
            },
        });
        this.addCommand({ id: 'sync-now', name: 'Sync now', icon: 'refresh-cw', callback: () => this.controller.resume() });
        // sessionStorage survives plugin reloads but not an app restart.
        let restarted = false;
        try {
            restarted = !sessionStorage.getItem(SESSION_KEY);
            sessionStorage.setItem(SESSION_KEY, '1');
        } catch { /* Without it, nothing tied to undo history is pruned. */ }
        this.app.workspace.onLayoutReady(() => this.controller.start(restarted));
        this.registerDomEvent(document, 'visibilitychange', () => {
            if (Platform.isMobile && document.visibilityState === 'visible') this.controller.resume();
        });
        this.registerDomEvent(window, 'online', () => this.controller.resume());
        this.register(() => { this.saveLocal('all'); this.controller.dispose(); this.auth.dispose(); });
        // An expired setup package can no longer be imported.
        if (this.data.connectionTransfer && this.data.connectionTransfer.expires <= Date.now()) {
            delete this.data.connectionTransfer;
            await this.persist();
        }
    }

    // Returns false when the stored copy does not match what was written.
    saveLocal(scope: SaveScope): boolean {
        const write = (key: string, value: unknown) => {
            const serialized = JSON.stringify(value);
            this.app.saveLocalStorage(key, value);
            return JSON.stringify(this.app.loadLocalStorage(key)) === serialized;
        };
        const journal = write(JOURNAL_KEY, journalSnapshot(this.data));
        return (scope === 'journal' || write(DEVICE_STATE_KEY, deviceSnapshot(this.data))) && journal;
    }

    async persist(): Promise<void> {
        this.saveLocal('all');
        const snapshot = sharedSnapshot(this.data);
        const serialized = JSON.stringify(snapshot);
        if (serialized === this.sharedJSON) return this.saving;
        this.sharedJSON = serialized;
        this.saving = this.saving.catch(() => undefined).then(() => this.saveData(snapshot)).catch(error => {
            if (this.sharedJSON === serialized) this.sharedJSON = '';
            throw error;
        });
        return this.saving;
    }

    async onExternalSettingsChange(): Promise<void> {
        const shared = await this.loadData() as Partial<PluginData> | null;
        if (!shared) return;
        this.sharedJSON = JSON.stringify(shared);
        const settings = { ...initialData().settings, ...shared.settings };
        const changed = JSON.stringify(settings) !== JSON.stringify(this.data.settings);
        Object.assign(this.data.settings, settings);
        this.data.connectionTransfer = shared.connectionTransfer;
        if (changed) this.controller.reconnect();
    }

    async refreshSources(): Promise<void> {
        const loaded = await this.google.sources();
        const settings = this.data.settings;
        settings.calendars = loaded.calendars.map(calendar => ({ ...calendar, role: settings.calendars.find(old => old.id === calendar.id)?.role ?? 'off' }));
        settings.taskLists = loaded.taskLists.map(list => ({ ...list, enabled: settings.taskLists.find(old => old.id === list.id)?.enabled ?? false }));
        if (!settings.taskLists.some(list => list.id === settings.defaultTaskList && list.enabled)) settings.defaultTaskList = settings.taskLists.find(list => list.enabled)?.id ?? '';
        await this.persist();
    }
}
