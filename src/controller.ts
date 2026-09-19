import { MarkdownView, TFile, type App, type Editor, type Plugin } from 'obsidian';
import type { EditorView } from '@codemirror/view';
import { replaceEditorText } from './editor';
import { enableNote, noteDate, regions, TEMPLATE } from './markdown';
import { SyncEngine } from './sync';
import { SyncScheduler } from './scheduler';
import type { PluginData, Remote } from './types';

export class Controller {
    readonly engine: SyncEngine;
    readonly scheduler: SyncScheduler;
    private status: HTMLElement;
    private tracked = new Set<string>();
    private disposed = false;
    private deletionTimer?: ReturnType<typeof setTimeout>;

    constructor(private plugin: Plugin, public data: PluginData, remote: Remote, save: () => Promise<void>, private connected: () => boolean) {
        this.status = plugin.addStatusBarItem();
        this.setStatus('Connect in settings');
        this.engine = new SyncEngine(data, remote, {
            read: path => this.read(path),
            indent: () => this.indent(),
            write: (path, before, after) => this.write(path, before, after),
        }, save);
        this.scheduler = new SyncScheduler(async (path, titles) => {
            if (!this.connected() || this.disposed) return;
            const text = await this.read(path);
            if (!text || !noteDate(text, path.split('/').pop()!.replace(/\.md$/, ''))) return;
            this.setStatus('Syncing');
            const editing = this.scheduler.dirty.has(path);
            // A daily-note template is itself an editor change. Populate a newly
            // enabled, empty set of groups immediately instead of waiting for the
            // non-Vim typing debounce to expire.
            const initialTemplate = !this.data.notes[path] && !this.engine.hasLocalEdits(path, text);
            const result = await this.engine.run(path, titles && !editing, !editing || initialTemplate);
            if (result) this.setStatus(result);
        }, () => [...new Set([...this.paths(), ...Object.values(data.outbox).map(operation => operation.path)])], () => data.settings.intervalSeconds, error => this.setStatus(error instanceof Error ? error.message : 'Sync failed. Pending edits are kept.'));
    }

    private get app(): App { return this.plugin.app; }

    indent(): string {
        // Obsidian's editor preferences are not yet exposed in its public types.
        // Read them for each operation so changing the setting needs no reload.
        const vault = this.app.vault as App['vault'] & { getConfig(key: 'useTab' | 'tabSize'): unknown };
        if (vault.getConfig('useTab') !== false) return '\t';
        const size = vault.getConfig('tabSize');
        return ' '.repeat(typeof size === 'number' && Number.isInteger(size) && size > 0 ? size : 4);
    }

    private view(path: string): MarkdownView | undefined {
        const views = this.app.workspace.getLeavesOfType('markdown').map(leaf => leaf.view).filter((view): view is MarkdownView => view instanceof MarkdownView && view.file?.path === path && view.getMode() === 'source');
        return views.find(view => view === this.app.workspace.getActiveViewOfType(MarkdownView)) ?? views[0];
    }

    private paths(): string[] {
        return this.app.workspace.getLeavesOfType('markdown').flatMap(leaf => leaf.view instanceof MarkdownView && leaf.view.file ? [leaf.view.file.path] : []);
    }

    async read(path: string): Promise<string | undefined> {
        const view = this.view(path);
        if (view) {
            await view.save();
            return view.editor.getValue();
        }
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
            replaceEditorText(cm, before, after, this.data.created);
            // Task IDs must reach disk before an insertion can reach Google.
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

    setStatus(text: string): void {
        if (this.disposed) return;
        const symbol = text === 'Up to date' ? '✓'
            : ['Syncing', 'Editing', 'Deletion pending', 'Waiting to confirm a task creation with Google'].includes(text) ? '↻' : '✕';
        this.status.setText(`GCal: ${symbol}`);
        this.status.setAttribute('aria-description', `Google Calendar sync: ${text}`);
        this.status.addClass('gdn-status');
    }

    start(): void {
        if (this.disposed) return;
        const queue = (file: TFile | null) => {
            if (file?.extension === 'md') {
                this.tracked.add(file.path);
                this.scheduler.request(file.path, 'open', !this.scheduler.dirty.has(file.path));
            }
        };
        this.plugin.registerEvent(this.app.workspace.on('file-open', queue));
        this.plugin.registerEvent(this.app.vault.on('create', file => { if (file instanceof TFile) queue(file); }));
        this.plugin.registerEvent(this.app.vault.on('modify', file => {
            if (!(file instanceof TFile) || this.view(file.path) || !this.paths().includes(file.path) || !this.data.notes[file.path]) return;
            // Reading-view checkbox clicks write through the vault, bypassing CM.
            // Compare the note baseline to avoid reacting to our own refreshes.
            void this.read(file.path).then(text => {
                if (text && this.engine.hasLocalEdits(file.path, text, true)) this.scheduler.request(file.path, 'edit');
            }).catch(error => this.setStatus(error instanceof Error ? error.message : 'Could not read the note.'));
        }));
        // Metadata may appear after file creation when a daily-note template is applied.
        this.plugin.registerEvent(this.app.metadataCache.on('changed', file => {
            if (!this.tracked.has(file.path)) return;
            const state = this.data.notes[file.path];
            if (!state) this.scheduler.request(file.path, 'open', false);
        }));
        this.plugin.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
            if (this.data.notes[oldPath]) {
                this.data.notes[file.path] = this.data.notes[oldPath]!; delete this.data.notes[oldPath];
                for (const operation of Object.values(this.data.outbox)) if (operation.path === oldPath) operation.path = file.path;
            }
            this.tracked.delete(oldPath);
            if (file instanceof TFile) queue(file);
        }));
        for (const path of new Set([...this.paths(), ...Object.values(this.data.outbox).filter(operation => operation.remove).map(operation => operation.path)])) this.scheduler.request(path, 'open');
        this.scheduler.start();
        this.scheduleDeletions();
    }

    queueDeletions(path: string, keys: string[]): void {
        this.engine.queueDeletions(path, keys);
        this.scheduleDeletions();
    }

    cancelDeletions(path: string, keys: string[], at: number): void {
        this.engine.cancelDeletions(path, keys, at);
        this.scheduleDeletions();
    }

    private scheduleDeletions(): void {
        if (this.deletionTimer) clearTimeout(this.deletionTimer);
        if (this.disposed) return;
        const now = Date.now();
        const pending = Object.values(this.data.outbox).filter(operation => operation.remove);
        const due = pending.filter(operation => (operation.removeAfter ?? 0) <= now);
        for (const path of new Set(due.map(operation => operation.path))) this.scheduler.request(path, 'delete', false);
        const deadlines = pending.filter(operation => (operation.removeAfter ?? 0) > now).map(operation => operation.removeAfter!);
        if (!deadlines.length) return;
        this.deletionTimer = setTimeout(() => this.scheduleDeletions(), Math.max(0, Math.min(...deadlines) - now));
    }

    async insertTemplate(editor: Editor, file: TFile): Promise<void> {
        if (regions(editor.getValue()).length) { this.setStatus('This note already has Google sections'); return; }
        const before = editor.getValue();
        const from = editor.posToOffset(editor.getCursor('from'));
        const to = editor.posToOffset(editor.getCursor('to'));
        const after = enableNote(before.slice(0, from) + TEMPLATE + before.slice(to));
        const cm = (editor as Editor & { cm?: EditorView }).cm;
        if (!cm) throw new Error('This editor version is unsupported.');
        // One editor transaction avoids a file-write/editor-save race and the
        // resulting Obsidian external-modification notification.
        replaceEditorText(cm, before, after);
        await this.view(file.path)?.save();
        this.scheduler.request(file.path, 'open');
    }

    reconnect(): void {
        for (const path of this.paths()) this.scheduler.request(path, 'open');
        this.scheduler.resetPeriodic();
    }

    dispose(): void { this.disposed = true; clearTimeout(this.deletionTimer); this.engine.stopped = true; this.scheduler.dispose(); }
}
