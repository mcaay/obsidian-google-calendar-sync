import { MarkdownView, Notice, setTooltip, TFile, type App, type Editor, type Plugin } from 'obsidian';
import type { EditorView } from '@codemirror/view';
import { insertText, replaceEditorText } from './editor';
import { enableNote, noteDate, regions, syncedRows, TEMPLATE, visibleRow } from './markdown';
import { SyncEngine, type Problem, type SaveScope, type Status } from './sync';
import { SyncScheduler } from './scheduler';
import type { PluginData, Remote } from './types';

interface Connection {
    connected(): boolean;
    needsReconnect(): boolean;
}

/**
 * How to read this code:
 * 1. The constructor wires SyncEngine (sync.ts) to the vault and to one
 *    SyncScheduler (scheduler.ts) queue. Each scheduled run ends by showing
 *    a final status; its tooltip carries the reason.
 * 2. start() registers note events. A Reading-view checkbox click marks its
 *    note; the one checkbox flip reaching that note within a second counts as
 *    this device's edit, whether it arrives as a file change or in another
 *    pane (flip()). Any other outside change is display state (D1).
 * 3. Deletion deadlines are timers here; the engine keeps the durable state.
 * Ordinary: typing in an open daily note, then Escape, runs one edit sync.
 * Tricky: an outbox entry for a closed or deleted note still drains, because
 *    the periodic tick requests every path with pending work.
 */
export class Controller {
    readonly engine: SyncEngine;
    readonly scheduler: SyncScheduler;
    private status: HTMLElement;
    private tracked = new Set<string>();
    private disposed = false;
    private deletionTimer?: number;
    private shown = new Set<string>();
    private clicks = new Map<string, { at: number; before: string }>();

    constructor(private plugin: Plugin, public data: PluginData, remote: Remote, save: (scope: SaveScope) => boolean, private connection: Connection) {
        this.status = plugin.addStatusBarItem();
        this.status.addClass('gdn-status');
        this.setStatus({ state: 'error', text: 'Not connected' });
        this.engine = new SyncEngine(data, remote, {
            read: path => this.read(path),
            indent: () => this.indent(),
            tabWidth: () => this.tabWidth(),
            write: (path, before, after) => this.write(path, before, after),
        }, save, Date.now, problem => this.notice(problem));
        this.scheduler = new SyncScheduler(async (path, titles, pull) => {
            if (this.disposed) return;
            if (!this.connection.connected()) { this.disconnected(); return; }
            this.setStatus({ state: 'busy', text: 'Syncing' });
            const editing = this.scheduler.dirty.has(path);
            // A newly enabled note is populated at once, even while its template
            // insertion still counts as typing.
            const status = await this.engine.run(path, titles && !editing, !editing || !this.data.notes[path], pull);
            if (!this.connection.connected()) this.disconnected();
            else this.setStatus(status);
        }, () => [...new Set([...this.paths(), ...Object.values(data.outbox).map(operation => operation.path)])], () => data.settings.intervalSeconds,
        error => this.setStatus({ state: 'error', text: error instanceof Error ? error.message : 'Sync failed. Pending edits are kept.' }));
    }

    private get app(): App { return this.plugin.app; }

    indent(): string {
        // Obsidian's editor preferences are not yet exposed in its public types.
        // Read them for each operation so changing the setting needs no reload.
        if (this.config('useTab') !== false) return '\t';
        return ' '.repeat(this.tabWidth());
    }

    tabWidth(): number {
        const size = this.config('tabSize');
        return typeof size === 'number' && Number.isInteger(size) && size > 0 ? size : 4;
    }

    private config(key: 'useTab' | 'tabSize'): unknown {
        return (this.app.vault as App['vault'] & { getConfig(key: string): unknown }).getConfig(key);
    }

    private view(path: string): MarkdownView | undefined {
        const views = this.app.workspace.getLeavesOfType('markdown').map(leaf => leaf.view).filter((view): view is MarkdownView => view instanceof MarkdownView && view.file?.path === path && view.getMode() === 'source');
        return views.find(view => view === this.app.workspace.getActiveViewOfType(MarkdownView)) ?? views[0];
    }

    private paths(): string[] {
        return this.app.workspace.getLeavesOfType('markdown').flatMap(leaf => leaf.view instanceof MarkdownView && leaf.view.file ? [leaf.view.file.path] : []);
    }

    // The editor text is current: outside changes reach it as transactions.
    // The plugin saves a view only after writing to it.
    async read(path: string): Promise<string | undefined> {
        const view = this.view(path);
        if (view) return this.disposed ? undefined : view.editor.getValue();
        const file = this.app.vault.getAbstractFileByPath(path);
        return file instanceof TFile ? this.app.vault.read(file) : undefined;
    }

    private async write(path: string, before: string, after: string): Promise<boolean> {
        if (this.disposed) return false;
        if (before === after) return await this.read(path) === before;
        const view = this.view(path);
        if (view) {
            if (view.editor.getValue() !== before) return false;
            const cm = (view.editor as Editor & { cm?: EditorView }).cm;
            if (!cm) throw new Error('This editor version is unsupported. Use the current Obsidian desktop editor.');
            replaceEditorText(cm, before, after, key => this.engine.resolve(key));
            // Task IDs must reach disk before other devices can relink them.
            await view.save();
            return true;
        }
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) return false;
        let applied = false;
        await this.app.vault.process(file, text => {
            if (text !== before || this.disposed) return text;
            applied = true; return after;
        });
        return applied;
    }

    setStatus(status: Status): void {
        if (this.disposed) return;
        const symbol = status.state === 'ok' ? '✓' : status.state === 'busy' ? '↻' : '✕';
        this.status.setText(`GCal: ${symbol}`);
        setTooltip(this.status, `Google Calendar sync: ${status.text}${status.detail ? `\n${status.detail}` : ''}`, { placement: 'top' });
    }

    private disconnected(): void {
        if (this.connection.needsReconnect()) {
            this.setStatus({ state: 'error', text: 'Reconnect needed', detail: 'Google access expired or was revoked. Reconnect in Calendar Sync settings.' });
            this.notice({ id: 'reconnect', message: 'Calendar Sync: Google access expired or was revoked. Reconnect in the plugin settings.' });
        } else this.setStatus({ state: 'error', text: 'Not connected', detail: 'Connect Google in Calendar Sync settings.' });
    }

    // Problems that need action appear once per session on each device (D4).
    private notice(problem: Problem): void {
        if (this.disposed || this.shown.has(problem.id)) return;
        this.shown.add(problem.id);
        new Notice(`Calendar Sync: ${problem.message}`, 10000);
    }

    // `restarted`: the first load in this app session, when Obsidian's
    // in-memory undo history of every note is gone.
    start(restarted = false): void {
        if (this.disposed) return;
        const prune = (fresh: boolean) => {
            this.engine.prune(fresh, path => this.app.vault.getAbstractFileByPath(path) instanceof TFile);
            this.engine.persist('all');
        };
        prune(restarted);
        this.plugin.registerInterval(window.setInterval(() => prune(false), 24 * 3600000));
        const queue = (file: TFile | null) => {
            if (file?.extension === 'md') {
                this.tracked.add(file.path);
                this.scheduler.request(file.path, 'open', !this.scheduler.dirty.has(file.path));
            }
        };
        this.plugin.registerEvent(this.app.workspace.on('file-open', queue));
        this.plugin.registerEvent(this.app.vault.on('create', file => { if (file instanceof TFile) queue(file); }));
        const click = (event: MouseEvent) => {
            const target = event.target;
            if (!(target instanceof HTMLElement) || !target.matches('.markdown-preview-view .task-list-item-checkbox')) return;
            const view = this.app.workspace.getLeavesOfType('markdown').map(leaf => leaf.view).find(view => view.containerEl.contains(target));
            // Capture runs before Obsidian's own handler edits the note.
            if (view instanceof MarkdownView && view.file) this.clicks.set(view.file.path, { at: Date.now(), before: view.data });
        };
        this.plugin.registerDomEvent(document, 'click', click, true);
        this.plugin.registerEvent(this.app.workspace.on('window-open', (_window, win) => this.plugin.registerDomEvent(win.document, 'click', click, true)));
        this.plugin.registerEvent(this.app.vault.on('modify', file => {
            const mark = this.clicks.get(file.path);
            if (!(file instanceof TFile) || !mark || Date.now() - mark.at > 1000) return;
            void this.app.vault.cachedRead(file).then(text => this.flip(file.path, mark.before, text));
        }));
        // Metadata may appear after file creation when a daily-note template is applied.
        this.plugin.registerEvent(this.app.metadataCache.on('changed', (file, text) => {
            if (!this.tracked.has(file.path) || this.data.notes[file.path] || !noteDate(text, file.basename)) return;
            this.scheduler.request(file.path, 'open', false);
        }));
        this.plugin.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
            if (this.data.notes[oldPath]) { this.data.notes[file.path] = this.data.notes[oldPath]!; delete this.data.notes[oldPath]; }
            for (const record of [...Object.values(this.data.outbox), ...Object.values(this.data.deletedTasks), ...Object.values(this.data.edits), ...Object.values(this.data.created)]) {
                if (record.path === oldPath) record.path = file.path;
            }
            this.engine.persist('all');
            this.tracked.delete(oldPath);
            if (file instanceof TFile) queue(file);
        }));
        for (const path of new Set([...this.paths(), ...Object.values(this.data.outbox).map(operation => operation.path)])) this.scheduler.request(path, 'open');
        this.scheduler.start();
        this.scheduleDeletions();
    }

    // A change from outside this editor. Only a Reading-view click counts.
    external(path: string, before: string, after: string): void {
        const mark = this.clicks.get(path);
        if (mark && Date.now() - mark.at <= 1000) this.flip(path, before, after);
    }

    private flip(path: string, before: string, after: string): void {
        if (!this.clicks.has(path)) return;
        const unit = this.indent();
        const tab = this.tabWidth();
        let flips: { key: string; done: boolean }[];
        try {
            const old = new Map(syncedRows(regions(before, unit, tab)).map(row => [row.key, row.line.text]));
            flips = syncedRows(regions(after, unit, tab)).flatMap(row => {
                const previous = old.get(row.key);
                const done = visibleRow(row.line.text)?.done;
                return previous !== undefined && previous !== row.line.text && done !== undefined && visibleRow(previous)?.done !== done ? [{ key: row.key, done }] : [];
            });
        } catch { return; }
        if (flips.length !== 1) return;
        this.clicks.delete(path);
        this.engine.journalEdits(path, flips);
        this.scheduler.request(path, 'toggle', false);
    }

    queueDeletions(path: string, rows: { key: string; text: string }[]): void {
        this.engine.queueDeletions(path, rows);
        this.scheduleDeletions();
    }

    restoreDeletions(path: string, keys: string[], at: number): void {
        const lost = this.engine.restoreDeletions(path, keys, at);
        // D12: undo is never blocked, but a sent event deletion cannot be undone.
        if (lost.length) new Notice('Calendar Sync: a deleted calendar event cannot be restored after 5 seconds. Its row disappears at the next sync.');
        this.scheduleDeletions();
    }

    private scheduleDeletions(): void {
        if (this.deletionTimer) window.clearTimeout(this.deletionTimer);
        if (this.disposed) return;
        const now = Date.now();
        const pending = Object.values(this.data.outbox).filter(operation => operation.remove);
        const due = pending.filter(operation => (operation.removeAfter ?? 0) <= now);
        for (const path of new Set(due.map(operation => operation.path))) this.scheduler.request(path, 'delete', false);
        const deadlines = pending.filter(operation => (operation.removeAfter ?? 0) > now).map(operation => operation.removeAfter!);
        if (!deadlines.length) return;
        this.deletionTimer = window.setTimeout(() => this.scheduleDeletions(), Math.max(0, Math.min(...deadlines) - now));
    }

    async insertTemplate(editor: Editor, file: TFile): Promise<void> {
        if (regions(editor.getValue()).length) { new Notice('This note already has Google sections.'); return; }
        const before = editor.getValue();
        const from = editor.posToOffset(editor.getCursor('from'));
        const to = editor.posToOffset(editor.getCursor('to'));
        const after = enableNote(before.slice(0, from) + TEMPLATE + before.slice(to));
        const cm = (editor as Editor & { cm?: EditorView }).cm;
        if (!cm) throw new Error('This editor version is unsupported.');
        // One undoable editor transaction avoids a file-write/editor-save race
        // and the resulting Obsidian external-modification notification.
        insertText(cm, before, after);
        await this.view(file.path)?.save();
        this.scheduler.request(file.path, 'open');
    }

    reconnect(): void {
        for (const path of this.paths()) this.scheduler.request(path, 'open');
        this.scheduler.resetPeriodic();
    }

    resume(): void {
        for (const path of this.scheduler.dirty) this.scheduler.normal(path);
        this.scheduleDeletions();
        this.reconnect();
    }

    dispose(): void { this.disposed = true; window.clearTimeout(this.deletionTimer); this.engine.stopped = true; this.scheduler.dispose(); }
}
