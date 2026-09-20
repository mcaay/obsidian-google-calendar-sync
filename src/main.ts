import { Plugin, requestUrl } from 'obsidian';
import { shell } from 'electron';
import { GoogleAuth } from './auth';
import { GoogleClient } from './google';
import { Controller } from './controller';
import { editorExtension } from './editor';
import { GoogleSettingsTab } from './settings';
import { initialData, type PluginData } from './types';
import type { Transport } from './http';

/**
 * How to read this code:
 * 1. onload() restores settings and the outbox, then wires GoogleAuth (auth.ts)
 *    and GoogleClient (google.ts) to Controller (controller.ts).
 * 2. Controller.start() registers note events and starts SyncScheduler (scheduler.ts).
 * 3. editorExtension() (editor.ts) observes native Markdown edits; SyncEngine.run()
 *    (sync.ts) reconciles them with Google and writes managed regions back safely.
 * Ordinary: opening an enabled daily note starts a sync without a button.
 * Tricky: an offline title edit stays in the outbox and is retried after restart.
 */
export default class GoogleDailyNotes extends Plugin {
    data!: PluginData;
    auth!: GoogleAuth;
    google!: GoogleClient;
    controller!: Controller;
    private saving: Promise<void> = Promise.resolve();

    async onload(): Promise<void> {
        const stored = await this.loadData() as Partial<PluginData> | null;
        const defaults = initialData();
        this.data = { ...defaults, ...stored, settings: { ...defaults.settings, ...stored?.settings } };
        const transport: Transport = async request => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                const response = await Promise.race([
                    requestUrl({ ...request, throw: false }),
                    new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Google request timed out. Pending edits are kept.')), 30000); }),
                ]);
                return { status: response.status, json: response.text ? response.json as unknown : {} };
            } finally { if (timer) clearTimeout(timer); }
        };
        this.auth = new GoogleAuth(this.app.secretStorage, () => this.data.settings.clientId, transport, url => shell.openExternal(url));
        this.google = new GoogleClient(transport, force => this.auth.token(force));
        this.controller = new Controller(this, this.data, this.google, () => this.persist(), () => this.auth.connected());
        this.registerEditorExtension(editorExtension({
            rows: path => this.controller.engine.editorRows(path),
            indent: () => this.controller.indent(),
            changed: (path, vim, toggled) => this.controller.scheduler.changed(path, vim, toggled),
            normal: path => this.controller.scheduler.normal(path),
            deleted: (path, keys) => this.controller.queueDeletions(path, keys),
            undoableDeletions: (path, at) => this.controller.engine.undoableDeletions(path, at),
            restored: (path, keys, at) => this.controller.restoreDeletions(path, keys, at),
        }));
        this.addSettingTab(new GoogleSettingsTab(this.app, this));
        this.addCommand({
            id: 'insert-daily-sections', name: 'Insert Google daily sections',
            editorCallback: (editor, context) => {
                if (context.file) void this.controller.insertTemplate(editor, context.file).catch(error => this.controller.setStatus(String(error)));
            },
        });
        this.app.workspace.onLayoutReady(() => this.controller.start());
        this.register(() => { this.controller.dispose(); this.auth.dispose(); });
    }

    async persist(): Promise<void> {
        const snapshot = structuredClone(this.data);
        this.saving = this.saving.catch(() => undefined).then(() => this.saveData(snapshot));
        return this.saving;
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
