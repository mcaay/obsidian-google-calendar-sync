import { randomUUID } from 'node:crypto';
import { GoogleError } from './http';
import { draftTitle, itemKey, noteDate, readRow, regions, renderNote, rowKey, visibleRow } from './markdown';
import type { Item, Operation, PluginData, Remote } from './types';

export interface NoteAccess {
    read(path: string): Promise<string | undefined>;
    indent(): string;
    // Compare-and-swap: never overwrite text typed while a Google request ran.
    write(path: string, before: string, after: string): Promise<boolean>;
}

/**
 * How to read this code:
 * 1. run() reads the note and stage() turns changed fields into a durable outbox.
 * 2. flush() sends the outbox through GoogleClient in google.ts before pulling.
 *    It saves confirmed Google IDs before removing their temporary notes tokens.
 *    Saved IDs with no markerRemoved flag also clean up tasks from older versions.
 *    queueDeletions() journals explicit editor deletions; missing rows on disk
 *    alone never become remote deletions. Deletions wait five seconds; native
 *    undo calls restoreDeletions() before that deadline. Later task undo creates a
 *    replacement with a stable Markdown ID so native redo preserves the row.
 *    The new task waits for confirmation that the old task was deleted.
 * 3. Remote.load() builds dated items (items.ts); renderNote() (markdown.ts)
 *    updates only managed regions. NoteAccess.write() checks for concurrent edits.
 * Ordinary: a checkbox becomes one status operation, then a refreshed Markdown row.
 * Tricky: typing during a slow fetch makes the final write fail its comparison;
 * the text stays intact and the next scheduled run reconciles it.
 */
export class SyncEngine {
    stopped = false;

    constructor(public data: PluginData, private remote: Remote, private notes: NoteAccess, private save: () => Promise<void>, private now: () => number = Date.now) {}

    async run(path: string, titles: boolean, render = true): Promise<string> {
        if (this.stopped) return '';
        let text = await this.notes.read(path);
        if (text === undefined) return '';
        const date = noteDate(text, path.split('/').pop()!.replace(/\.md$/, ''));
        if (!date || !regions(text).length) return '';
        text = await this.stage(path, text, date, titles);
        if (this.stopped) return '';
        await this.flush();
        if (this.stopped) return '';
        if (!render) return 'Editing';
        const state = this.data.notes[path]!;
        const retained = state.retained.map(key => {
            const record = this.data.deletedTasks[key];
            const target = record?.restoredKey ? this.data.created[record.restoredKey] : record?.item;
            return target ? itemKey('task', target.source, target.id) : key;
        });
        const loaded = await this.remote.load(date, this.data.settings, retained);
        if (this.stopped) return '';
        // Google still has the item during the undo window. Keep it hidden in
        // the note while retaining its snapshot so native undo can restore it.
        const linked = loaded.map(item => {
            // Keep the Markdown identity stable for native undo/redo. Only the
            // remote ID changes; the same binding applies in other daily notes.
            const binding = Object.entries(this.data.deletedTasks).find(([, record]) => {
                const target = record.restoredKey ? this.data.created[record.restoredKey] : record.item;
                return item.kind === 'task' && target?.source === item.source && target.id === item.id;
            });
            return binding ? { ...item, key: binding[0] } : item;
        });
        const items = linked.filter(item => !this.pendingDeletion(item));
        for (const [key, record] of Object.entries(this.data.deletedTasks)) {
            if (record.path !== path || record.deleted || !record.restoredKey || this.data.created[record.restoredKey]) continue;
            const snapshot = state.rows[key];
            if (snapshot && text.includes(`<!-- gdn:${key} -->`)) items.push(snapshot);
        }
        // A status-only flush must not overwrite a title still being edited.
        if (!titles && this.hasLocalEdits(path, text)) return 'Editing';
        for (const item of items) {
            const pending = this.data.outbox[item.key];
            if (pending?.title !== undefined) item.title = pending.title;
            if (pending?.done !== undefined) item.done = pending.done;
        }
        // Successful inserts replace their local ID with the durable Google ID.
        let transformed = text;
        for (const [key, result] of Object.entries(this.data.created)) {
            if (this.data.deletedTasks[key]) continue;
            transformed = transformed.replace(`<!-- gdn:${key} -->`, `<!-- gdn:${itemKey('task', result.source, result.id)} -->`);
        }
        const after = renderNote(transformed, items, this.notes.indent());
        if (await this.notes.write(path, text, after)) {
            state.rows = {
                ...Object.fromEntries(Object.entries(state.rows).filter(([, item]) => this.pendingDeletion(item))),
                ...Object.fromEntries(items.map(item => [item.key, item])),
            };
            // Pending local rows retain their baseline until they can be resolved.
            for (const region of regions(after)) for (const line of region.lines) {
                const key = rowKey(line.text);
                if (!key?.startsWith('new:')) continue;
                const operation = this.data.outbox[key];
                if (operation) state.rows[key] = this.createdSnapshot(operation);
            }
            await this.save();
        }
        const uncertain = Object.values(this.data.outbox).some(operation => operation.create?.phase === 'sent');
        return uncertain ? 'Waiting to confirm a task creation with Google'
            : Object.values(this.data.outbox).some(operation => operation.remove) ? 'Deletion pending' : 'Up to date';
    }

    private pendingDeletion(item: Item): boolean {
        return Object.values(this.data.outbox).some(operation => {
            if (!operation.remove) return false;
            const target = this.data.created[operation.key] ?? operation;
            return operation.key === item.key || (operation.kind === item.kind && target.source === item.source && target.id === item.id);
        });
    }

    hasLocalEdits(path: string, text: string, includeStatus = false): boolean {
        const snapshots = this.data.notes[path]?.rows ?? {};
        for (const region of regions(text)) for (const line of region.lines) {
            const key = rowKey(line.text);
            const snapshot = key ? snapshots[key] : undefined;
            if (snapshot) {
                const current = readRow(line.text, snapshot);
                if (current?.title !== snapshot.title) return true;
                if (includeStatus && current?.done !== snapshot.done) return true;
            } else if (region.section === 'tasks' && draftTitle(line.text)) return true;
        }
        return false;
    }

    queueDeletions(path: string, keys: string[]): void {
        for (const key of keys) {
            const previous = this.data.deletedTasks[key];
            const replacement = previous?.restoredKey;
            const pendingKey = replacement && !this.data.created[replacement] ? replacement : key;
            const pending = this.data.outbox[pendingKey];
            // Redo before staging cancels the replacement intent. No new task
            // exists yet, and the original deletion remains authoritative.
            if (replacement && pendingKey === replacement && !pending) {
                previous.deleted = true;
                delete previous.restoredKey;
                continue;
            }
            const snapshot = this.data.notes[path]?.rows[key];
            if (!snapshot?.writable && !pending?.create) continue;
            const item = pending?.create ? { ...this.createdSnapshot(pending), key } : snapshot!;
            if (item.kind === 'task') this.data.deletedTasks[key] = { path, item: { ...item }, deletionKey: pendingKey, deleted: true };
            this.data.outbox[pendingKey] = {
                ...(pending ?? { key, kind: item.kind, source: item.source, id: item.id, path }),
                remove: true, removeAfter: this.now() + 5000,
            };
        }
    }

    undoableDeletions(path: string, at = this.now()): string[] {
        return [...new Set([
            ...Object.values(this.data.outbox).filter(operation => operation.path === path && operation.remove
                && (operation.removeAfter ?? 0) > at).map(operation => operation.key),
            ...Object.entries(this.data.deletedTasks).filter(([, record]) => record.path === path).map(([key]) => key),
        ])];
    }

    restoreDeletions(path: string, keys: string[], at = this.now()): void {
        for (const key of keys) {
            const record = this.data.deletedTasks[key];
            if (record && (record.path !== path || !record.deleted)) continue;
            const pendingKey = record?.deletionKey ?? key;
            const pending = this.data.outbox[pendingKey];
            if (pending?.path === path && pending.remove && (pending.removeAfter ?? 0) > at) {
                const operation = { ...pending };
                delete operation.remove;
                delete operation.removeAfter;
                // Undo retains title/status edits or creation already queued before dd.
                if (operation.create || operation.title !== undefined || operation.done !== undefined) this.data.outbox[pendingKey] = operation;
                else delete this.data.outbox[pendingKey];
                if (record) {
                    record.deleted = false;
                    if (operation.create) record.restoredKey = pendingKey;
                }
            } else if (record) {
                record.deleted = false;
                record.restoredKey = `new:${randomUUID()}`;
            }
        }
    }

    editorRows(path: string): Record<string, Item> {
        return {
            ...Object.fromEntries(Object.entries(this.data.deletedTasks).filter(([, record]) => record.path === path).map(([key, record]) => [key, record.item])),
            ...this.data.notes[path]?.rows,
        };
    }

    private async stage(path: string, text: string, date: string, titles: boolean): Promise<string> {
        const state = this.data.notes[path] ??= { rows: {}, retained: [] };
        let prepared = text;
        const edits: { from: number; to: number; text: string }[] = [];
        // Journal explicit undo before any insert. Its stable row identity lets
        // a restart recover the original list/date without guessing from titles.
        if (Object.values(this.data.deletedTasks).some(record => record.path === path && record.restoredKey && !this.data.created[record.restoredKey])) await this.save();
        for (const region of regions(text, this.notes.indent())) for (const line of region.lines) {
            let key = rowKey(line.text);
            let snapshot = key ? state.rows[key] : undefined;
            const restoration = key ? this.data.deletedTasks[key] : undefined;
            if (key && restoration?.restoredKey && !restoration.deleted) {
                const created = this.data.created[restoration.restoredKey];
                if (!created) {
                    const draft = visibleRow(line.text);
                    if (!draft?.title.trim()) continue;
                    const existing = this.data.outbox[restoration.restoredKey];
                    const operation: Operation = {
                        ...existing, key: restoration.restoredKey, kind: 'task', id: '', source: restoration.item.source,
                        path, title: draft.title.trim(), done: draft.done ?? false,
                        create: existing?.create ?? { date: restoration.item.date, phase: 'prepared' },
                        replaces: existing?.replaces ?? (restoration.deletionKey !== restoration.restoredKey ? restoration.deletionKey : undefined),
                    };
                    this.data.outbox[operation.key] = operation;
                    state.rows[key] = { ...this.createdSnapshot(operation), key };
                    continue;
                }
                snapshot = { ...(snapshot ?? restoration.item), ...created, key };
                state.rows[key] = snapshot;
            }
            if (region.section === 'tasks' && titles && !restoration && (!key || key.startsWith('new:'))) {
                const draft = key ? visibleRow(line.text) : draftTitle(line.text);
                const created = key ? this.data.created[key] : undefined;
                if (created) {
                    // Only an explicit undo with a fresh replacement ID may
                    // recreate a deleted task; stale notes cannot do so.
                    if (!snapshot) continue;
                    snapshot = { ...snapshot, ...created, key: itemKey('task', created.source, created.id) };
                } else if (draft?.title.trim()) {
                    key ??= `new:${randomUUID()}`;
                    const existing = this.data.outbox[key];
                    const source = existing?.source ?? this.data.settings.defaultTaskList;
                    if (!source) throw new Error('Choose a default Google Tasks list in plugin settings.');
                    const operation: Operation = {
                        ...existing, key, kind: 'task', id: '', source,
                        path, title: draft.title.trim(), done: draft.done ?? false,
                        create: existing?.create ?? { date, phase: 'prepared' },
                    };
                    this.data.outbox[key] = operation;
                    state.rows[key] = this.createdSnapshot(operation);
                    if (!rowKey(line.text)) edits.push({ from: line.from, to: line.to, text: `${region.indent}- [${operation.done ? 'x' : ' '}] ${operation.title} <!-- gdn:${key} -->` });
                    continue;
                }
            }
            if (!snapshot?.writable || !key) continue;
            const current = readRow(line.text, snapshot);
            if (!current) continue;
            const changedTitle = titles && Boolean(current.title) && current.title !== snapshot.title;
            const changedDone = current.done !== undefined && current.done !== snapshot.done;
            if (!changedTitle && !changedDone) continue;
            const targetKey = snapshot.key;
            this.data.outbox[targetKey] = {
                ...this.data.outbox[targetKey], key: targetKey, kind: snapshot.kind,
                source: snapshot.source, id: snapshot.id, path,
                marker: snapshot.done !== undefined,
                ...(changedTitle ? { title: current.title } : {}),
                ...(changedDone ? { done: current.done } : {}),
            };
            if (changedTitle) state.rows[key]!.title = current.title!;
            if (changedDone) state.rows[key]!.done = current.done;
            if (changedDone && current.done && snapshot.date < date && !state.retained.includes(targetKey)) state.retained.push(targetKey);
        }
        for (const edit of edits.reverse()) prepared = prepared.slice(0, edit.from) + edit.text + prepared.slice(edit.to);
        // Write local identities first. If the app crashes before the journal is
        // saved, stage() can reconstruct it from the same IDs in the note. Saving
        // an outbox first could leave both an unlinked draft and a queued insert.
        if (prepared !== text && !await this.notes.write(path, text, prepared)) {
            // No request has been sent. Discard new drafts whose identities were
            // not written, then capture the latest text on the next run.
            for (const edit of edits) {
                const key = rowKey(edit.text)!;
                delete this.data.outbox[key]; delete state.rows[key];
            }
            await this.save();
            return text;
        }
        await this.save();
        return prepared;
    }

    private createdSnapshot(operation: Operation): Item {
        return {
            key: operation.key, kind: 'task', source: operation.source, id: operation.id,
            section: 'tasks', title: operation.title ?? '', done: operation.done ?? false,
            prefix: '', date: operation.create?.date ?? '', writable: true, sort: '',
        };
    }

    async flush(): Promise<void> {
        let failure: unknown;
        for (const [key, operation] of Object.entries(this.data.outbox)) {
            if (this.stopped) return;
            if (this.data.outbox[key] !== operation) continue;
            if (operation.remove && (operation.removeAfter ?? 0) > this.now()) continue;
            if (operation.replaces && this.data.outbox[operation.replaces]?.remove) continue;
            try {
                if (operation.create) {
                    if (operation.remove && operation.create.phase === 'prepared' && !this.data.created[key]) {
                        delete this.data.outbox[key];
                        for (const state of Object.values(this.data.notes)) delete state.rows[key];
                        await this.save();
                        continue;
                    }
                    const created = this.data.created[key] ?? await this.remote.create(operation, async () => {
                        // The user can delete a draft while create() is looking
                        // for a previous response. Do not send a cancelled insert.
                        if (this.stopped || this.data.outbox[key] !== operation) return false;
                        operation.create!.phase = 'sent';
                        await this.save();
                        return true;
                    });
                    if (!created) continue;
                    this.data.created[key] = created;
                    if (operation.done) {
                        const retained = this.data.notes[operation.path]?.retained;
                        const createdKey = Object.entries(this.data.deletedTasks).find(([, record]) => record.restoredKey === key)?.[0] ?? itemKey('task', created.source, created.id);
                        if (retained && !retained.includes(createdKey)) retained.push(createdKey);
                    }
                    const rowKey = Object.entries(this.data.deletedTasks).find(([, record]) => record.restoredKey === key)?.[0] ?? key;
                    const snapshot = this.data.notes[operation.path]?.rows[rowKey];
                    if (snapshot) { snapshot.source = created.source; snapshot.id = created.id; }
                    if (operation.remove) {
                        await this.save();
                        await this.remote.remove({ ...operation, ...created });
                    }
                } else if (operation.remove) await this.remote.remove(operation);
                else await this.remote.patch(operation);
                if (operation.remove) {
                    const target = this.data.created[key] ?? operation;
                    for (const state of Object.values(this.data.notes)) for (const [rowKey, row] of Object.entries(state.rows)) {
                        if (rowKey === key || (row.kind === operation.kind && row.source === target.source && row.id === target.id)) {
                            delete state.rows[rowKey];
                            state.retained = state.retained.filter(retained => retained !== rowKey);
                        }
                    }
                    for (const record of Object.values(this.data.created)) if (operation.kind === 'task' && record.source === target.source && record.id === target.id) record.markerRemoved = true;
                }
                // An edit or deletion queued during the request is newer than
                // the response we just received. Keep it for the next run.
                if (this.data.outbox[key] === operation) delete this.data.outbox[key];
                await this.save();
            } catch (error) {
                if (error instanceof GoogleError) {
                    if (!operation.create && [404, 410].includes(error.status)) {
                        // Remote deletion wins. Editing a stale line cannot recreate it.
                        delete this.data.outbox[key]; await this.save(); continue;
                    }
                    if (operation.create && error.status >= 400 && error.status < 500) {
                        operation.create.phase = 'prepared'; await this.save();
                    }
                }
                failure ??= error;
                // One item's permission failure must not block unrelated tasks.
                // Authentication, quota, and network failures affect the account;
                // stop those here and let the scheduler back off.
                if (!(error instanceof GoogleError) || error.status === 401 || error.status === 429 || error.status >= 500) break;
            }
        }
        if (failure) throw failure;
        for (const [key, created] of Object.entries(this.data.created)) {
            if (this.stopped) return;
            if (created.markerRemoved) continue;
            // Persist again before cleanup, including after a previous save
            // failed. The Google ID must survive a crash before its token goes.
            await this.save();
            await this.remote.removeCreationMarker(key, created.source, created.id);
            created.markerRemoved = true;
            await this.save();
        }
    }
}
