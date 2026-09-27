import { Annotation, EditorSelection, EditorState, StateEffect, StateField, Transaction, type ChangeSpec, type Extension, type Text } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { invertedEffects } from '@codemirror/commands';
import { editorInfoField, editorLivePreviewField, Keymap, MarkdownView, type KeymapEventHandler, type Scope } from 'obsidian';
import { BLOCKED, checkEdit, lineChanges, noteDate, parseItemKey, readRow, regions, ROW_ID, rowKey, splitsRow, syncedRows, visibleRow, type Region, type RowRef } from './markdown';
import type { Edit, Item } from './types';

// The plugin's own writes: renders, row-history replays and key rewrites.
export const fromSync = Annotation.define<boolean>();
// The plugin's o, O or Enter: a new row that already carries an owned key.
const draftInsert = Annotation.define<boolean>();

// Row-level meaning of an undo step. A render may later rewrite a row
// outside history (a new key, a Google title), which leaves CodeMirror's
// stored text changes empty; replaying this effect still removes or restores
// the row. Positions refer to the document the step applies to.
interface RowHistory {
    remove: string[];
    insert: { pos: number; text: string }[];
}
const rowHistory = StateEffect.define<RowHistory>({
    map: (value, mapping) => ({ remove: value.remove, insert: value.insert.map(entry => ({ ...entry, pos: mapping.mapPos(entry.pos, -1) })) }),
});

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
    tabWidth(): number;
    draftKey(): string;
    resolve(key: string): string;
    changed(path: string, vim: boolean, toggled: boolean): void;
    normal(path: string): void;
    edited(path: string, edits: ({ key: string } & Edit)[]): void;
    deleted(path: string, rows: { key: string; text: string }[]): void;
    restored(path: string, keys: string[], at: number): void;
    // A change that arrived from outside this editor, such as a reading-view
    // checkbox click in another pane.
    external(path: string, before: string, after: string): void;
    blocked(message: string): void;
}

// Parsing runs several times per keystroke; each document version once.
const parsedDocs = new WeakMap<Text, { tag: string; value: Region[] | undefined }>();
function parse(doc: Text, hooks: EditorHooks): Region[] | undefined {
    const tag = `${hooks.indent()}|${hooks.tabWidth()}`;
    const hit = parsedDocs.get(doc);
    if (hit?.tag === tag) return hit.value;
    let value: Region[] | undefined;
    try { value = regions(doc.toString(), hooks.indent(), hooks.tabWidth()); } catch { value = undefined; }
    parsedDocs.set(doc, { tag, value });
    return value;
}

function rowsOf(doc: Text, hooks: EditorHooks): RowRef[] {
    return syncedRows(parse(doc, hooks) ?? []);
}

function frontmatter(doc: Text): string {
    if (doc.lines < 2 || doc.line(1).text !== '---') return '';
    for (let number = 2; number <= Math.min(doc.lines, 500); number++) if (doc.line(number).text === '---') return doc.sliceString(0, doc.line(number).to);
    return '';
}

function dailyPath(state: EditorState, doc: Text = state.doc): string | undefined {
    const file = state.field(editorInfoField, false)?.file;
    return file && noteDate(frontmatter(doc), file.basename) ? file.path : undefined;
}

function context(view: EditorView): string | undefined {
    return dailyPath(view.state);
}

function local(transaction: Transaction): boolean {
    return transaction.docChanged && !transaction.annotation(fromSync) && !transaction.isUserEvent('set');
}

// Snapshots plus task rows another device rendered before this one did.
// Their keys name the task, so they can be edited and deleted right away.
function editorRows(path: string, doc: Text, hooks: EditorHooks): Record<string, Item> {
    const rows = { ...hooks.rows(path) };
    for (const row of rowsOf(doc, hooks)) {
        const target = rows[row.key] ? undefined : parseItemKey(row.key);
        if (target?.kind === 'task') rows[row.key] = { key: row.key, kind: 'task', source: target.source, id: target.id, section: 'tasks', title: '', done: visibleRow(row.line.text)?.done ?? false, prefix: '', date: '', writable: true, sort: '' };
    }
    return rows;
}

// Only full-row removal counts as deletion. Removing or damaging the hidden
// identity while leaving the visible title must never delete a Google item.
// Rows removed together with their group, as when undoing a template
// insertion, are not deletions either.
function deletedRows(transaction: Transaction, hooks: EditorHooks): { key: string; text: string }[] {
    if (!['input', 'delete', 'undo', 'redo'].some(event => transaction.isUserEvent(event))) return [];
    const before = rowsOf(transaction.startState.doc, hooks);
    const afterRegions = parse(transaction.newDoc, hooks) ?? [];
    const after = new Set(syncedRows(afterRegions).map(row => row.key));
    const result: { key: string; text: string }[] = [];
    transaction.changes.iterChanges((from, to, _fromNew, _toNew, inserted) => {
        if (inserted.length) return;
        for (const row of before) {
            if (after.has(row.key) || from > row.line.from || to < row.line.to || !afterRegions.some(region => region.section === row.section)) continue;
            if (!result.some(entry => entry.key === row.key)) result.push({ key: row.key, text: row.line.text });
        }
    });
    return result;
}

// Rows an undo or redo brought back. The engine decides what each means: a
// pending deletion is cancelled, a deleted task is recreated, and an event
// that is already gone is reported (D12).
function restoredRows(transaction: Transaction, hooks: EditorHooks): string[] {
    if (!transaction.isUserEvent('undo') && !transaction.isUserEvent('redo')) return [];
    const before = new Set(rowsOf(transaction.startState.doc, hooks).map(row => row.key));
    return rowsOf(transaction.newDoc, hooks).flatMap(row => !before.has(row.key) && !row.key.startsWith('new:') ? [row.key] : []);
}

// Title and checkbox values of rows whose line this transaction changed.
function editedRows(transaction: Transaction, rows: Record<string, Item>, hooks: EditorHooks): ({ key: string } & Edit)[] {
    const before = new Map(rowsOf(transaction.startState.doc, hooks).map(row => [row.key, row.line.text]));
    const result: ({ key: string } & Edit)[] = [];
    const read = (key: string, text: string): Edit | undefined => {
        const item = rows[key];
        if (item) return readRow(text, item);
        const visible = visibleRow(text);
        return key.startsWith('new:') && visible ? { title: visible.title.trim(), done: visible.done } : undefined;
    };
    for (const row of rowsOf(transaction.newDoc, hooks)) {
        const previous = before.get(row.key);
        if (previous === undefined || previous === row.line.text) continue;
        const now = read(row.key, row.line.text);
        const old = read(row.key, previous);
        if (!now) continue;
        const edit: { key: string } & Edit = { key: row.key };
        // An emptied title is never sent; the next render shows Google's.
        if (now.title && now.title !== old?.title) edit.title = now.title;
        if (now.done !== undefined && now.done !== old?.done) edit.done = now.done;
        if (edit.title !== undefined || edit.done !== undefined) result.push(edit);
    }
    return result;
}

function insertMode(view: EditorView): void {
    const cm = (view as VimView).cm;
    if (cm) (view.dom.ownerDocument.defaultView as VimWindow | null)?.CodeMirrorAdapter?.Vim.handleKey(cm, 'i');
}

function decorations(state: EditorState, hooks: EditorHooks): DecorationSet {
    if (!state.field(editorLivePreviewField, false) || !dailyPath(state)) return Decoration.none;
    const managed = parse(state.doc, hooks);
    if (!managed) return Decoration.none;
    const replacements = syncedRows(managed).map(({ line }) => Decoration.replace({}).range(line.from + ROW_ID.exec(line.text)!.index, line.to));
    for (const region of managed) {
        const marker = ROW_ID.exec(region.heading.text)!;
        replacements.push(Decoration.replace({}).range(region.heading.from + marker.index, region.heading.to));
    }
    return Decoration.set(replacements, true);
}

// Where a synced row's editable title starts and its hidden ID begins.
function titleRange(text: string, item: Item | undefined): { title: number; id: number; box?: number } | undefined {
    const id = ROW_ID.exec(text)?.index;
    const head = /^([ \t]*)- (\[[ xX]\] )?/.exec(text);
    if (id === undefined || !head) return undefined;
    const title = head[0].length + (item && text.startsWith(item.prefix, head[0].length) ? item.prefix.length : 0);
    return { title: Math.min(title, id), id, box: head[2] ? head[1]!.length + 3 : undefined };
}

/**
 * The plugin's o, O or Enter on a task row or on the tasks heading: a new
 * checkbox row below (or above) that carries its owned key from the start, in
 * the same undo step, so no other device can claim it (1.4).
 */
export function draftSpec(state: EditorState, lineFrom: number, above: boolean, hooks: EditorHooks): { changes: ChangeSpec; selection: EditorSelection; userEvent: string; annotations: ReturnType<typeof draftInsert.of> } | undefined {
    const line = state.doc.lineAt(lineFrom);
    const heading = rowKey(line.text) === 'tasks' && !above;
    const region = parse(state.doc, hooks)?.find(region => heading
        ? region.heading.from === line.from
        : region.section === 'tasks' && line.from >= region.from && line.from < region.to);
    if (!region) return undefined;
    const draft = `${region.indent}- [ ] `;
    const row = `${draft} <!-- gdn:${hooks.draftKey()} -->`;
    const position = above ? line.from : line.to;
    return {
        changes: { from: position, insert: above ? row + '\n' : '\n' + row },
        selection: EditorSelection.single(position + (above ? draft.length : 1 + draft.length)),
        userEvent: 'input', annotations: draftInsert.of(true),
    };
}

/**
 * Journals what the local transactions of one editor update did and reports
 * whether a sync should follow. `replay` lists transactions that carry row
 * history for replayChanges().
 */
export function observe(path: string, transactions: readonly Transaction[], hooks: EditorHooks): { relevant: boolean; toggled: boolean; restored: boolean; replay: number[] } {
    const result = { relevant: false, toggled: false, restored: false, replay: [] as number[] };
    transactions.forEach((transaction, index) => {
        if (!transaction.docChanged && !transaction.effects.some(effect => effect.is(rowHistory))) return;
        if (transaction.annotation(fromSync)) return;
        if (transaction.isUserEvent('set')) {
            hooks.external(path, transaction.startState.doc.toString(), transaction.newDoc.toString());
            return;
        }
        const at = transaction.annotation(Transaction.time)!;
        const rows = editorRows(path, transaction.startState.doc, hooks);
        const deleted = deletedRows(transaction, hooks);
        if (deleted.length) { hooks.deleted(path, deleted); result.relevant = result.toggled = true; }
        const restored = restoredRows(transaction, hooks);
        if (restored.length) { hooks.restored(path, restored, at); result.relevant = result.toggled = result.restored = true; }
        const edits = editedRows(transaction, rows, hooks);
        if (edits.length) {
            hooks.edited(path, edits);
            result.relevant = true;
            if (edits.some(edit => edit.done !== undefined)) result.toggled = true;
        }
        // A pasted or claimed draft is a task to create.
        const known = new Set(rowsOf(transaction.startState.doc, hooks).map(row => row.key));
        if (rowsOf(transaction.newDoc, hooks).some(row => row.key.startsWith('new:') && !known.has(row.key))) result.relevant = true;
        // An undo that removed a group heading leaves its rendered rows behind.
        const history = transaction.isUserEvent('undo') || transaction.isUserEvent('redo');
        const sections = new Set((parse(transaction.newDoc, hooks) ?? []).map(region => region.section));
        if (transaction.effects.some(effect => effect.is(rowHistory)) || (history && (parse(transaction.startState.doc, hooks) ?? []).some(region => !sections.has(region.section)))) result.replay.push(index);
    });
    return result;
}

/**
 * The row-level part of an undo or redo whose text changes a render made
 * empty, computed against the state after `transactions`. Rows whose group
 * heading the undo removed go with it and delete nothing in Google (3.2).
 */
export function replayChanges(state: EditorState, transactions: readonly Transaction[], indexes: number[], hooks: EditorHooks): { changes: ChangeSpec[]; deleted: { key: string; text: string }[]; restored: string[]; at: number } | undefined {
    const doc = state.doc;
    const managed = parse(doc, hooks);
    if (!managed) return undefined;
    const rows = syncedRows(managed);
    const remove = new Map<number, { key: string; text: string; delete: boolean }>();
    const insert: { pos: number; text: string; key: string }[] = [];
    const at = transactions[indexes[0]!]?.annotation(Transaction.time) ?? Date.now();
    const sections = new Set(managed.map(region => region.section));
    for (const index of indexes) {
        const transaction = transactions[index]!;
        const map = (pos: number) => transactions.slice(index).reduce((mapped, later) => later.changes.mapPos(mapped, -1), pos);
        for (const effect of transaction.effects) {
            if (!effect.is(rowHistory)) continue;
            for (const key of effect.value.remove) {
                const row = rows.find(next => next.key === key || hooks.resolve(next.key) === hooks.resolve(key));
                if (row) remove.set(row.line.from, { key: row.key, text: row.line.text, delete: true });
            }
            for (const entry of effect.value.insert) {
                const key = rowKey(entry.text);
                if (!key || rows.some(next => hooks.resolve(next.key) === hooks.resolve(key)) || insert.some(other => other.key === key)) continue;
                insert.push({ pos: Math.min(map(entry.pos), doc.length), text: entry.text, key });
            }
        }
        for (const orphan of rowsOf(transaction.startState.doc, hooks)) {
            if (sections.has(orphan.section)) continue;
            for (let number = 1; number <= doc.lines; number++) {
                const line = doc.line(number);
                if (rowKey(line.text) === orphan.key && !remove.has(line.from)) remove.set(line.from, { key: orphan.key, text: line.text, delete: false });
            }
        }
    }
    if (!remove.size && !insert.length) return undefined;
    const changes: ChangeSpec[] = [...remove.keys()].map(from => {
        const line = doc.lineAt(from);
        return line.to < doc.length ? { from: line.from, to: line.to + 1 } : { from: Math.max(0, line.from - 1), to: line.to };
    });
    for (const entry of insert.sort((a, b) => a.pos - b.pos)) {
        const line = doc.lineAt(entry.pos);
        // Restore a whole line at the start of the line at pos or the next one.
        const start = entry.pos === line.from ? line.from : line.to + 1;
        if (start <= doc.length) changes.push({ from: start, insert: entry.text + '\n' });
        else changes.push({ from: doc.length, insert: '\n' + entry.text });
    }
    return {
        changes,
        deleted: [...remove.values()].filter(entry => entry.delete).map(({ key, text }) => ({ key, text })),
        restored: insert.map(entry => entry.key), at,
    };
}

/**
 * How to read this code:
 * 1. editorExtension() installs a change filter, a transaction filter, an
 *    undo-history hook and native key handlers for enabled daily notes.
 * 2. The change filter clamps a partial deletion on a synced row to its title,
 *    so Vim C, D, cc and S keep the checkbox, event prefix and hidden ID (D9).
 * 3. The transaction filter calls checkEdit() in markdown.ts for local edits.
 *    Obsidian dispatches undo and redo unfiltered, and external file changes
 *    arrive as `set`; neither is checked. Pasted rows and typed checkbox rows
 *    receive owned draft keys inside the same transaction.
 * 4. The view plugin's update() journals what each local transaction did:
 *    edited titles and checkboxes, whole-row deletions and undo restorations.
 *    Only those touch Google (D1), and only they schedule a sync (4.5).
 * 5. invertedEffects stores a row-level description with every undo step that
 *    inserts or removes rows; replay() carries it out after undo and redo when
 *    a render has since rewritten those rows outside history (3.1, 1.6).
 * Ordinary: Cmd+Enter changes a real Markdown checkbox and queues a status push.
 * Tricky: o, a title, Escape, then u once the task exists: the key was
 *    rewritten outside history, so replay() removes the row and queues the
 *    task's deletion with the usual 5-second grace.
 */
export function editorExtension(hooks: EditorHooks): Extension {
    const handleKey = (event: KeyboardEvent, view: EditorView): boolean => {
        if (event.isComposing) return false;
        const path = context(view);
        if (!path || view.state.selection.ranges.length !== 1) return false;
        const line = view.state.doc.lineAt(view.state.selection.main.head);
        const key = rowKey(line.text);
        const item = key ? editorRows(path, view.state.doc, hooks)[key] : undefined;
        const cm = (view as VimView).cm;
        const vimNormal = Boolean(cm?.state.vim && !cm.state.vim.insertMode && !cm.state.vim.visualMode);
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            if (!item) return false;
            if (item.done !== undefined && item.writable) {
                const match = /\[([ xX])\]/.exec(line.text);
                if (match) view.dispatch({ changes: { from: line.from + match.index + 1, to: line.from + match.index + 2, insert: match[1]!.toLowerCase() === 'x' ? ' ' : 'x' }, userEvent: 'input' });
            }
            event.preventDefault(); return true;
        }
        if (item && vimNormal && !event.ctrlKey && !event.metaKey && ['A', 'I'].includes(event.key)) {
            const range = titleRange(line.text, item);
            if (!range) return false;
            view.dispatch({ selection: EditorSelection.cursor(line.from + (event.key === 'A' ? range.id : range.title)) });
            insertMode(view);
            event.preventDefault(); return true;
        }
        const newLine = (vimNormal && ['o', 'O'].includes(event.key) && !event.ctrlKey && !event.metaKey)
            || (!vimNormal && event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey);
        if (newLine && key) {
            if (item?.kind === 'event') { event.preventDefault(); return true; }
            if (key !== 'tasks' && item?.kind !== 'task' && !key.startsWith('new:')) return false;
            const spec = draftSpec(view.state, line.from, vimNormal && event.key === 'O', hooks);
            if (!spec) return false;
            // Enter insert mode before the document update. Otherwise the
            // observer would flush this blank draft as a normal-mode edit.
            if (vimNormal) insertMode(view);
            view.dispatch(spec);
            event.preventDefault(); return true;
        }
        return false;
    };
    const hiddenMetadata = StateField.define<DecorationSet>({
        create: state => decorations(state, hooks),
        update: (value, transaction) => transaction.docChanged
            || transaction.state.field(editorLivePreviewField, false) !== transaction.startState.field(editorLivePreviewField, false)
            ? decorations(transaction.state, hooks) : value,
        provide: field => [EditorView.decorations.from(field), EditorView.atomicRanges.of(view => view.state.field(field))],
    });
    const skipped = (transaction: Transaction) => !local(transaction) || transaction.isUserEvent('undo') || transaction.isUserEvent('redo');
    let lastNotice = '';
    let lastNoticeAt = 0;
    const block = (message: string) => {
        // 3.7: say why an edit did nothing, without repeating on every key.
        const now = Date.now();
        if (message !== lastNotice || now - lastNoticeAt > 5000) hooks.blocked(message);
        lastNotice = message;
        lastNoticeAt = now;
    };
    return [
        hiddenMetadata,
        EditorState.changeFilter.of(transaction => {
            if (skipped(transaction)) return true;
            const path = dailyPath(transaction.startState);
            if (!path) return true;
            const doc = transaction.startState.doc;
            const rows = editorRows(path, doc, hooks);
            const protectedLines = new Map<number, number[]>();
            const managed = parse(doc, hooks) ?? [];
            const lines = [...syncedRows(managed).map(row => ({ line: row.line, item: rows[row.key] })), ...managed.map(region => ({ line: region.heading, item: undefined, heading: true }))];
            transaction.changes.iterChanges((from, to, _fromNew, _toNew, inserted) => {
                const target = lines.find(({ line }) => from >= line.from && from <= line.to);
                // Changes that span lines are for the transaction filter.
                if (!target || to > target.line.to) return;
                const range = titleRange(target.line.text, target.item);
                if (!range) return;
                const { line } = target;
                // A checkbox toggle replaces the character between the brackets.
                if (range.box !== undefined && from === line.from + range.box && to === from + 1 && /^[ xX]$/.test(inserted.toString())) return;
                // A command that rewrites the whole line, like another plugin's
                // toggle, is checked as a whole by the transaction filter.
                if (inserted.length && from === line.from && to === line.to) return;
                // Indentation too: Vim 0C must not move a row out of its group.
                protectedLines.set(line.from, 'heading' in target
                    ? [line.from + range.id, line.to]
                    : [line.from, line.from + range.title, line.from + range.id, line.to]);
            });
            const pairs: number[] = [];
            for (const [, bounds] of [...protectedLines.entries()].sort(([a], [b]) => a - b)) {
                for (let index = 0; index < bounds.length; index += 2) if (bounds[index]! < bounds[index + 1]!) pairs.push(bounds[index]!, bounds[index + 1]!);
            }
            return pairs.length ? pairs : true;
        }),
        EditorState.transactionFilter.of(transaction => {
            if (skipped(transaction)) return transaction;
            const path = dailyPath(transaction.startState) ?? dailyPath(transaction.startState, transaction.newDoc);
            if (!path) return transaction;
            const before = transaction.startState.doc.toString();
            const after = transaction.newDoc.toString();
            const unit = hooks.indent();
            const tab = hooks.tabWidth();
            let split = false;
            const touched: [number, number][] = [];
            transaction.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
                if (splitsRow(before, { from: fromA, to: toA, inserted: inserted.toString() }, unit, tab)) split = true;
                // A whole-line removal touches no line that remains.
                if (inserted.length || !before.slice(fromA, toA).includes('\n')) touched.push([fromB, toB]);
            });
            if (split) { block(BLOCKED.split); return []; }
            const result = checkEdit(before, after, touched, {
                snapshots: editorRows(path, transaction.startState.doc, hooks),
                deleted: deletedRows(transaction, hooks).map(row => row.key),
                draftInsert: Boolean(transaction.annotation(draftInsert)),
                newKey: () => hooks.draftKey(), indentUnit: unit, tabWidth: tab,
            });
            if (result.block) { block(result.block); return []; }
            const specs: (Transaction | { changes?: ChangeSpec; selection?: EditorSelection; sequential: boolean })[] = [transaction];
            if (result.changes.length) specs.push({ changes: result.changes, sequential: true });
            // After a clamped cc or S the cursor would sit before the checkbox.
            const head = transaction.selection?.main.head;
            if (head !== undefined && !result.changes.length) {
                const rows = editorRows(path, transaction.newDoc, hooks);
                const row = rowsOf(transaction.newDoc, hooks).find(({ line }) => head >= line.from && head <= line.to);
                const oldRow = row && rowsOf(transaction.startState.doc, hooks).find(old => old.key === row.key);
                const range = row && titleRange(row.line.text, rows[row.key]);
                const oldRange = oldRow && titleRange(oldRow.line.text, rows[row.key]);
                const title = (text: string, value: typeof range) => value ? text.slice(value.title, value.id) : '';
                if (row && oldRow && range && head >= row.line.from && head < row.line.from + range.title
                    && title(oldRow.line.text, oldRange) !== title(row.line.text, range)) {
                    specs.push({ selection: EditorSelection.single(row.line.from + range.title), sequential: true });
                }
            }
            return specs.length === 1 ? transaction : specs;
        }),
        invertedEffects.of(transaction => {
            if (!local(transaction) && !transaction.effects.some(effect => effect.is(rowHistory))) return [];
            if (transaction.annotation(fromSync) || transaction.isUserEvent('set') || !dailyPath(transaction.startState)) return [];
            const before = rowsOf(transaction.startState.doc, hooks);
            const afterRegions = parse(transaction.state.doc, hooks) ?? [];
            const after = syncedRows(afterRegions);
            const present = (key: string) => after.some(row => row.key === key || hooks.resolve(row.key) === hooks.resolve(key));
            const removed = before.filter(row => !after.some(next => next.key === row.key) && afterRegions.some(region => region.section === row.section))
                .map(row => ({ pos: transaction.changes.mapPos(row.line.from, -1), text: row.line.text }));
            const inserted = after.filter(row => !before.some(old => old.key === row.key)).map(row => row.key);
            // An undo or redo also does what its replay will do next.
            for (const effect of transaction.effects) {
                if (!effect.is(rowHistory)) continue;
                for (const key of effect.value.remove) {
                    const row = after.find(next => next.key === key || hooks.resolve(next.key) === hooks.resolve(key));
                    if (row && !removed.some(entry => entry.text === row.line.text)) removed.push({ pos: row.line.from, text: row.line.text });
                }
                for (const entry of effect.value.insert) {
                    const key = rowKey(entry.text);
                    if (key && !present(key) && !inserted.includes(key)) inserted.push(key);
                }
            }
            return removed.length || inserted.length ? [rowHistory.of({ remove: inserted, insert: removed.sort((a, b) => a.pos - b.pos) })] : [];
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
                // Vim's cc, S and C enter insert mode at the checkbox after the
                // title was cleared; typing belongs at the title's start (D9).
                if (update.selectionSet && this.cm?.state.vim?.insertMode) queueMicrotask(() => this.keepCursorInTitle());
                if (!update.docChanged && !update.transactions.some(transaction => transaction.effects.some(effect => effect.is(rowHistory)))) return;
                const path = dailyPath(update.state) ?? dailyPath(update.startState);
                if (!path) return;
                const result = observe(path, update.transactions, hooks);
                if (result.replay.length) {
                    const expected = update.state;
                    queueMicrotask(() => this.replay(path, update.transactions, result.replay, expected));
                }
                if (!result.relevant) return;
                const vim = this.cm?.state.vim;
                hooks.changed(path, Boolean(vim), result.toggled);
                if (result.restored || (vim && !vim.insertMode && !vim.visualMode)) queueMicrotask(() => hooks.normal(path));
            }

            private keepCursorInTitle(): void {
                const path = context(this.view);
                const cursor = this.view.state.selection.main;
                if (!path || !cursor.empty) return;
                const line = this.view.state.doc.lineAt(cursor.head);
                const key = rowKey(line.text);
                const item = key ? editorRows(path, this.view.state.doc, hooks)[key] : undefined;
                const range = item && titleRange(line.text, item);
                if (range && cursor.head < line.from + range.title) {
                    this.view.dispatch({ selection: EditorSelection.single(line.from + range.title) });
                }
            }

            private replay(path: string, transactions: readonly Transaction[], indexes: number[], expected: EditorState): void {
                // Vim moves the cursor right after an undo. A selection change
                // keeps every position valid; a document change does not.
                if (this.view.state.doc !== expected.doc) return;
                const replay = replayChanges(this.view.state, transactions, indexes, hooks);
                if (!replay) return;
                this.view.dispatch({ changes: replay.changes, annotations: [fromSync.of(true), Transaction.addToHistory.of(false)] });
                if (replay.deleted.length) hooks.deleted(path, replay.deleted);
                if (replay.restored.length) hooks.restored(path, replay.restored, replay.at);
                hooks.changed(path, Boolean(this.cm?.state.vim), true);
                queueMicrotask(() => hooks.normal(path));
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

// Applies a render as whole-line changes outside history. The cursor stays on
// its row, even when that row's key was rewritten.
export function replaceEditorText(view: EditorView, before: string, after: string, resolve: (key: string) => string = key => key): void {
    if (before === after) return;
    const changes = lineChanges(before, after);
    const cursor = view.state.selection.main;
    const cursorLine = view.state.doc.lineAt(cursor.head);
    const key = rowKey(cursorLine.text);
    let selection: EditorSelection | undefined;
    if (key && cursor.empty && changes.some(change => change.from <= cursorLine.to && change.to >= cursorLine.from)) {
        const marker = after.indexOf(` <!-- gdn:${resolve(key)} -->`);
        if (marker >= 0) {
            const lineStart = after.lastIndexOf('\n', marker) + 1;
            selection = EditorSelection.single(Math.min(lineStart + cursor.head - cursorLine.from, marker));
        }
    }
    view.dispatch({ changes, selection, annotations: [fromSync.of(true), Transaction.addToHistory.of(false)] });
}

// A user edit applied as one undoable step, for the template command.
export function insertText(view: EditorView, before: string, after: string): void {
    if (before === after) return;
    view.dispatch({ changes: lineChanges(before, after), userEvent: 'input.paste' });
}

