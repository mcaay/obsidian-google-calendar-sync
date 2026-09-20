import { Annotation, EditorSelection, EditorState, StateField, Transaction, type Extension } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { editorInfoField, Keymap, MarkdownView, type KeymapEventHandler, type Scope } from 'obsidian';
import { itemKey, noteDate, permittedEdit, regions, ROW_ID, rowKey, visibleRow } from './markdown';
import type { Item, PluginData } from './types';

export const fromSync = Annotation.define<boolean>();

interface VimAdapter {
    state: { vim?: { insertMode?: boolean; visualMode?: boolean } };
    on(event: string, callback: (value: { mode: string }) => void): void;
    off(event: string, callback: (value: { mode: string }) => void): void;
}
type VimView = EditorView & { cm?: VimAdapter };
interface VimWindow extends Window { CodeMirrorAdapter?: { Vim: { handleKey(cm: VimAdapter, key: string): void } } }

export interface EditorHooks {
    rows(path: string): Record<string, Item>;
    indent(): string;
    changed(path: string, vim: boolean, toggled: boolean): void;
    normal(path: string): void;
    deleted(path: string, keys: string[]): void;
    undoableDeletions(path: string, at: number): string[];
    restored(path: string, keys: string[], at: number): void;
}

// Only full-row removal counts as deletion. Removing or damaging the hidden
// identity while leaving the visible title must never delete a Google item.
function deletedRowKeys(transaction: Transaction): string[] {
    if (!['input', 'delete', 'undo', 'redo'].some(event => transaction.isUserEvent(event))) return [];
    try {
        const before = regions(transaction.startState.doc.toString()).flatMap(region => region.lines);
        const after = new Set(regions(transaction.newDoc.toString()).flatMap(region => region.lines.map(line => rowKey(line.text))));
        const keys: string[] = [];
        transaction.changes.iterChanges((from, to, _fromNew, _toNew, inserted) => {
            if (inserted.length) return;
            for (const line of before) {
                const key = rowKey(line.text);
                if (key && !after.has(key) && from <= line.from && to >= line.to) keys.push(key);
            }
        });
        return keys;
    } catch { return []; }
}

function restoredRowKeys(transaction: Transaction, allowed: string[]): string[] {
    if (!transaction.isUserEvent('undo') && !transaction.isUserEvent('redo')) return [];
    try {
        const before = new Set(regions(transaction.startState.doc.toString()).flatMap(region => region.lines.map(line => rowKey(line.text))));
        return regions(transaction.newDoc.toString()).flatMap(region => region.lines.flatMap(line => {
            const key = rowKey(line.text);
            return key && !before.has(key) && allowed.includes(key) ? [key] : [];
        }));
    } catch { return []; }
}

function context(view: EditorView): string | undefined {
    const file = view.state.field(editorInfoField, false)?.file;
    return file && noteDate(view.state.doc.toString(), file.basename) ? file.path : undefined;
}

function insertMode(view: EditorView): void {
    const cm = (view as VimView).cm;
    if (cm) (view.dom.ownerDocument.defaultView as VimWindow | null)?.CodeMirrorAdapter?.Vim.handleKey(cm, 'i');
}

function decorations(state: EditorState): DecorationSet {
    const file = state.field(editorInfoField, false)?.file;
    if (!file || !noteDate(state.doc.toString(), file.basename)) return Decoration.none;
    try {
        const managed = regions(state.doc.toString());
        const replacements = managed.flatMap(region => region.lines.flatMap(line => {
            const match = ROW_ID.exec(line.text);
            return match ? [Decoration.replace({}).range(line.from + match.index, line.to)] : [];
        }));
        for (const region of managed) {
            const marker = ROW_ID.exec(region.heading.text)!;
            replacements.push(Decoration.replace({}).range(region.heading.from + marker.index, region.heading.to));
        }
        return Decoration.set(replacements, true);
    } catch { return Decoration.none; }
}

/**
 * How to read this code:
 * 1. editorExtension() installs a transaction filter and native editor handlers.
 * 2. permittedEdit() in markdown.ts protects IDs and event structure.
 * 3. handleKey() handles managed-row toggles and task insertion; changed() tells
 *    SyncScheduler (scheduler.ts) when to push. Vim's mode event flushes titles.
 * 4. deletedRowKeys() journals full-row deletions with a five-second deadline.
 *    restoredRowKeys() lets native undo cancel pending deletion or recreate a
 *    deleted Google Task. Calendar events are never recreated from the note.
 *    Calendar rows keep their occurrence IDs when the delayed deletion is sent.
 * Ordinary: Cmd+Enter changes a real Markdown checkbox and queues a status push.
 * Tricky: o on a calendar row does nothing; o on a task makes an unlinked draft.
 */
export function editorExtension(hooks: EditorHooks): Extension {
    const handleKey = (event: KeyboardEvent, view: EditorView): boolean => {
        const path = context(view);
        if (!path || view.state.selection.ranges.length !== 1) return false;
        const line = view.state.doc.lineAt(view.state.selection.main.head);
        const key = rowKey(line.text);
        const item = key ? hooks.rows(path)[key] : undefined;
        const cm = (view as VimView).cm;
        const vimNormal = Boolean(cm?.state.vim && !cm.state.vim.insertMode && !cm.state.vim.visualMode);
        const escape = event.key === 'Escape' || (event.ctrlKey && ['[', 'c'].includes(event.key));
        if (escape && cm?.state.vim && !vimNormal) {
            (view.dom.ownerDocument.defaultView as VimWindow | null)?.CodeMirrorAdapter?.Vim.handleKey(cm, '<Esc>');
            queueMicrotask(() => hooks.normal(path));
            return true;
        }
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            if (!item) return false;
            if (item.done !== undefined && item.writable) {
                const match = /\[([ xX])\]/.exec(line.text);
                if (match) view.dispatch({ changes: { from: line.from + match.index + 1, to: line.from + match.index + 2, insert: match[1]!.toLowerCase() === 'x' ? ' ' : 'x' }, userEvent: 'input' });
            }
            event.preventDefault(); return true;
        }
        if (item && vimNormal && !event.ctrlKey && !event.metaKey && ['A', 'I'].includes(event.key)) {
            const end = line.text.search(ROW_ID);
            const start = /^\s*- (?:\[[ xX]\] )?/.exec(line.text)?.[0].length ?? 0;
            view.dispatch({ selection: EditorSelection.cursor(line.from + (event.key === 'A' ? end : start + item.prefix.length)) });
            insertMode(view);
            event.preventDefault(); return true;
        }
        const newLine = (vimNormal && ['o', 'O'].includes(event.key) && !event.ctrlKey && !event.metaKey)
            || (!vimNormal && event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey);
        if (newLine && key) {
            if (item?.kind === 'event') { event.preventDefault(); return true; }
            const taskHeading = key === 'tasks' && !(vimNormal && event.key === 'O');
            if (!taskHeading && item?.kind !== 'task' && !key.startsWith('new:')) return false;
            const region = regions(view.state.doc.toString(), hooks.indent()).find(region => taskHeading
                ? region.heading.from === line.from
                : region.section === 'tasks' && line.from >= region.from && line.from < region.to);
            if (!region) return false;
            const draft = `${region.indent}- [ ] `;
            const above = vimNormal && event.key === 'O';
            const position = above ? line.from : line.to;
            // Enter insert mode before the document update. Otherwise the
            // observer would flush and reorder this blank draft as a
            // normal-mode edit before the user can type its title.
            if (vimNormal) insertMode(view);
            view.dispatch({ changes: { from: position, insert: above ? draft + '\n' : '\n' + draft }, selection: EditorSelection.cursor(position + (above ? draft.length : 1 + draft.length)), userEvent: 'input' });
            event.preventDefault(); return true;
        }
        return false;
    };
    const hiddenMetadata = StateField.define<DecorationSet>({
        create: state => decorations(state),
        update: (value, transaction) => transaction.docChanged ? decorations(transaction.state) : value,
        provide: field => [EditorView.decorations.from(field), EditorView.atomicRanges.of(view => view.state.field(field))],
    });
    return [
        hiddenMetadata,
        EditorState.transactionFilter.of(transaction => {
            if (!transaction.docChanged || transaction.annotation(fromSync)) return transaction;
            const info = transaction.startState.field(editorInfoField, false);
            const file = info?.file;
            const before = transaction.startState.doc.toString();
            if (!file || !noteDate(before, file.basename)) return transaction;
            const rows = hooks.rows(file.path);
            const deleted = deletedRowKeys(transaction);
            const restored = restoredRowKeys(transaction, hooks.undoableDeletions(file.path, transaction.annotation(Transaction.time)!));
            return permittedEdit(before, transaction.newDoc.toString(), rows, deleted, restored) ? transaction : [];
        }),
        EditorView.domEventHandlers({
            blur(_event, view) {
                const path = context(view);
                if (path && (view as VimView).cm?.state.vim) hooks.normal(path);
            },
        }),
        ViewPlugin.fromClass(class {
            private cm?: VimAdapter;
            private scope?: Scope | null;
            private toggleHandler?: KeymapEventHandler;
            private bindTimer: ReturnType<typeof setTimeout>;
            private modeChanged = (mode: { mode: string }) => {
                const path = context(this.view);
                if (path && mode.mode === 'normal') queueMicrotask(() => hooks.normal(path));
            };

            private keydown = (event: KeyboardEvent) => {
                // A view-scope hotkey may already have handled the same event.
                if (event.defaultPrevented && (event.metaKey || event.ctrlKey) && event.key === 'Enter') return;
                if (!this.view.contentDOM.contains(event.target as Node)) return;
                if (handleKey(event, this.view)) {
                    event.preventDefault();
                    event.stopImmediatePropagation();
                }
            };

            constructor(private view: EditorView) {
                // Vim itself registers at highest CM precedence. DOM capture must
                // run before it so a blocked o does not still enter insert mode.
                view.dom.ownerDocument.defaultView?.addEventListener('keydown', this.keydown, true);
                this.bindTimer = setTimeout(() => this.bind(), 0);
            }

            private bind(): void {
                const info = this.view.state.field(editorInfoField, false);
                const scope = info instanceof MarkdownView ? info.scope : undefined;
                if (this.scope !== scope) {
                    if (this.toggleHandler) this.scope?.unregister(this.toggleHandler);
                    this.scope = scope;
                    // Obsidian resolves view hotkeys before application commands.
                    // A catch-all returning undefined lets ordinary rows reach
                    // their existing command. A specific binding would swallow
                    // the shortcut even when we return undefined.
                    this.toggleHandler = scope?.register(null, null, event => {
                        if (event.key === 'Enter' && Keymap.isModifier(event, 'Mod') && !event.shiftKey && !event.altKey
                            && info instanceof MarkdownView && info.getMode() === 'source' && handleKey(event, this.view)) return false;
                        return undefined;
                    });
                }
                const cm = (this.view as VimView).cm;
                if (this.cm === cm) return;
                this.cm?.off('vim-mode-change', this.modeChanged);
                this.cm = cm;
                this.cm?.on('vim-mode-change', this.modeChanged);
            }

            update(update: ViewUpdate): void {
                this.bind();
                if (!update.docChanged || update.transactions.every(transaction => transaction.annotation(fromSync))) return;
                const path = context(this.view);
                if (!path) return;
                const deleted = update.transactions.filter(transaction => !transaction.annotation(fromSync)).flatMap(deletedRowKeys);
                if (deleted.length) hooks.deleted(path, deleted);
                let restored = false;
                for (const transaction of update.transactions.filter(transaction => !transaction.annotation(fromSync))) {
                    const at = transaction.annotation(Transaction.time)!;
                    const keys = restoredRowKeys(transaction, hooks.undoableDeletions(path, at));
                    if (keys.length) { hooks.restored(path, keys, at); restored = true; }
                }
                let toggled = false;
                const before = new Map<string, boolean | undefined>();
                try {
                    for (const region of regions(update.startState.doc.toString())) for (const line of region.lines) {
                        const key = rowKey(line.text); if (key) before.set(key, visibleRow(line.text)?.done);
                    }
                    for (const region of regions(update.state.doc.toString())) for (const line of region.lines) {
                        const key = rowKey(line.text);
                        if (key && before.has(key) && before.get(key) !== visibleRow(line.text)?.done) toggled = true;
                    }
                } catch { return; }
                const vim = this.cm?.state.vim;
                hooks.changed(path, Boolean(vim), toggled || deleted.length > 0 || restored);
                if (restored || (vim && !vim.insertMode && !vim.visualMode)) queueMicrotask(() => hooks.normal(path));
            }

            destroy(): void {
                clearTimeout(this.bindTimer);
                if (this.toggleHandler) this.scope?.unregister(this.toggleHandler);
                this.cm?.off('vim-mode-change', this.modeChanged);
                this.view.dom.ownerDocument.defaultView?.removeEventListener('keydown', this.keydown, true);
            }
        }),
    ];
}

export function replaceEditorText(view: EditorView, before: string, after: string, created: PluginData['created'] = {}): void {
    if (before === after) return;
    const oldRegions = regions(before);
    const newRegions = regions(after);
    const sameHeadings = oldRegions.length > 0 && oldRegions.length === newRegions.length && oldRegions.every((region, index) => {
        const next = newRegions[index]!;
        return region.section === next.section && before.slice(region.heading.from, region.from) === after.slice(next.heading.from, next.from);
    });
    // Separate group transactions preserve selections in unrelated text between
    // groups. A single replacement spanning the whole note would move that cursor.
    const parts = sameHeadings ? oldRegions.map((region, index) => ({
        before: before.slice(region.from, region.to), after: after.slice(newRegions[index]!.from, newRegions[index]!.to), offset: region.from,
    })) : [{ before, after, offset: 0 }];
    const changes = parts.flatMap(part => {
        if (part.before === part.after) return [];
        let start = 0;
        while (start < part.before.length && start < part.after.length && part.before[start] === part.after[start]) start++;
        let oldEnd = part.before.length;
        let newEnd = part.after.length;
        while (oldEnd > start && newEnd > start && part.before[oldEnd - 1] === part.after[newEnd - 1]) { oldEnd--; newEnd--; }
        return [{ from: part.offset + start, to: part.offset + oldEnd, insert: part.after.slice(start, newEnd) }];
    });
    const cursor = view.state.selection.main;
    const cursorLine = view.state.doc.lineAt(cursor.head);
    const key = rowKey(cursorLine.text);
    let selection: EditorSelection | undefined;
    if (key && cursor.empty) {
        const result = created[key];
        const targetKey = result ? itemKey('task', result.source, result.id) : key;
        const marker = after.indexOf(`<!-- gdn:${targetKey} -->`);
        if (marker >= 0) {
            const lineStart = after.lastIndexOf('\n', marker) + 1;
            selection = EditorSelection.single(Math.min(lineStart + cursor.head - cursorLine.from, marker - 1));
        }
    }
    view.dispatch({
        changes, selection,
        annotations: [fromSync.of(true), Transaction.addToHistory.of(false)],
    });
}
