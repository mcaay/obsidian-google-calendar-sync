import { GoogleError, RequestTimeout } from './http';
import { itemKey, noteDate, parseItemKey, regions, renderNote, rowKey, syncedRows, visibleRow, type Region } from './markdown';
import type { Edit, GoogleTask, Item, Loaded, Operation, PluginData, Remote } from './types';

export interface NoteAccess {
    read(path: string): Promise<string | undefined>;
    indent(): string;
    tabWidth(): number;
    // Compare-and-swap: never overwrite text typed while a Google request ran.
    write(path: string, before: string, after: string): Promise<boolean>;
}

// journal: pending work and undo decisions (small, saved on every change).
// all: also note snapshots, created IDs and caches (saved after runs).
export type SaveScope = 'journal' | 'all';

export interface Status {
    state: 'ok' | 'busy' | 'error';
    text: string;
    detail?: string;
}

// A problem that needs the user's attention. The controller shows each id once.
export interface Problem {
    id: string;
    message: string;
}

// Google may still commit a POST whose response never arrived. Wait this long
// after that request ended before searching for it and sending it again (D3).
export const UNCERTAIN_WAIT = 2 * 60000;
const MARKER_WAIT = 24 * 3600000;
// Snapshots and created IDs nothing needs any more are pruned after this.
export const RETENTION = 14 * 24 * 3600000;

const basename = (path: string) => path.split('/').pop()!.replace(/\.md$/, '');

/**
 * How to read this code:
 * 1. The editor (editor.ts) journals edits made on this device: journalEdits(),
 *    queueDeletions() and restoreDeletions(). Each saves the small journal at
 *    once. Changes that reach a note any other way are display state (D1).
 * 2. run() reads the note, and stage() turns journal entries and this
 *    device's own drafts into the durable outbox.
 * 3. flush() sends the outbox. Every request gets its own outcome: a refusal
 *    drops that edit and names it (D2); quota, network and authorization
 *    problems stop sending until later. flushCreation() runs the creation state
 *    machine (prepared, sending, uncertain, refused) with the D3 resend rule.
 * 4. Remote.load() reads Google; compose() hides pending deletions, relinks
 *    drafts other devices created, keeps rows of unreadable sources and
 *    overlays pending values; renderNote() (markdown.ts) writes only lines
 *    that differ. NoteAccess.write() refuses to overwrite concurrent typing.
 * 5. After the rewritten keys reached the note, cleanupMarkers() removes the
 *    temporary creation markers from Google.
 * Ordinary: a checkbox becomes one journal entry, one PATCH and a refreshed row.
 * Tricky: Sync delivers another device's older title for a row. It is not in
 *    this device's journal, so nothing is sent and the next render shows
 *    Google's title again.
 */
export class SyncEngine {
    stopped = false;
    storageFailed = false;
    // The latest account, quota or network problem. A flush that sends
    // everything it can clears it; a failed load sets it again.
    private problem?: Status;
    private flushing?: Promise<boolean>;

    constructor(
        public data: PluginData,
        private remote: Remote,
        private notes: NoteAccess,
        private save: (scope: SaveScope) => boolean,
        private now: () => number = Date.now,
        private report: (problem: Problem) => void = () => undefined,
    ) {}

    persist(scope: SaveScope): boolean {
        const saved = this.save(scope);
        if (!saved && !this.storageFailed) {
            this.report({ id: 'storage', message: 'Calendar Sync cannot save its pending work on this device, so it sends nothing to Google. An undone deletion may still run after a restart. Free up storage or restart Obsidian.' });
        }
        this.storageFailed = !saved;
        return saved;
    }

    async run(path: string, titles: boolean, render = true, pullWhenIdle = true): Promise<Status> {
        if (this.stopped) return this.status();
        const text = await this.notes.read(path);
        const date = text === undefined ? undefined : noteDate(text, basename(path));
        let parsed: Region[] = [];
        if (text !== undefined && date) {
            try { parsed = regions(text, this.notes.indent(), this.notes.tabWidth()); }
            catch {
                this.report({ id: `markers:${path}`, message: `${basename(path)} has a duplicate or nested Google group marker. Remove the extra marker to resume syncing that note.` });
            }
        }
        // Pending work that was already authorized still completes when its
        // note is closed, disabled, renamed outside Obsidian or deleted (D11).
        if (text === undefined || !date || !parsed.length) return this.drain();
        const staged = this.stage(path, date, parsed, titles);
        if (!this.persist('journal')) return this.status();
        const sent = await this.flush();
        if (this.stopped) return this.status();
        if (!render || (!titles && this.typing(path))) return { state: 'busy', text: 'Editing' };
        if (!pullWhenIdle && !staged && !sent) return this.status();
        let loaded: Loaded;
        try { loaded = await this.remote.load(date, this.data.settings, this.retained(parsed), this.data.calendars); }
        catch (error) { return this.failure(error); }
        if (this.stopped) return this.status();
        for (const failure of loaded.failed) {
            this.report({ id: `source:${failure.source}`, message: `Could not read “${failure.name}”. Its rows stay as they are. ${failure.message}` });
        }
        const { items, keep, text: prepared } = this.compose(path, text, parsed, loaded);
        const after = renderNote(prepared, items, this.notes.indent(), this.notes.tabWidth(), keep);
        const state = this.data.notes[path]!;
        // A render that changes nothing writes nothing (FP-5).
        if (after === text || await this.notes.write(path, text, after)) {
            state.rows = {
                ...Object.fromEntries(Object.entries(state.rows).filter(([, item]) => this.pendingDeletion(item))),
                ...Object.fromEntries(items.map(item => [item.key, (({ marker: _marker, ...row }) => row)(item)])),
            };
            // Pending local rows retain their baseline until they can be resolved.
            for (const row of syncedRows(regions(after, this.notes.indent(), this.notes.tabWidth()))) {
                const operation = this.data.outbox[row.key];
                if (row.key.startsWith('new:') && operation?.create) state.rows[row.key] = this.draftSnapshot(operation);
            }
            state.synced = this.now();
            this.persist('all');
            await this.cleanupMarkers(path);
        } else this.persist('all');
        return this.status(path, after);
    }

    // Sends pending work without reading or rendering any note.
    async drain(): Promise<Status> {
        if (this.stopped) return this.status();
        await this.flush();
        await this.cleanupMarkers();
        this.persist('all');
        return this.status();
    }

    status(path?: string, text?: string): Status {
        if (this.storageFailed) return { state: 'error', text: 'Cannot save pending work on this device', detail: 'Nothing is sent to Google until saving works again.' };
        if (this.problem) return this.problem;
        const waiting: string[] = [];
        if (path && text !== undefined) {
            try {
                for (const row of syncedRows(regions(text, this.notes.indent(), this.notes.tabWidth()))) {
                    if (row.key.startsWith('new:') && !this.owns(row.key) && !this.data.created[row.key] && !this.data.aliases[row.key]) waiting.push(visibleRow(row.line.text)?.title.trim() || '(untitled)');
                }
            } catch { /* Reported by run(). */ }
        }
        const operations = Object.values(this.data.outbox);
        const detail = waiting.length ? `Waiting for another device to create: ${waiting.join(', ')}` : undefined;
        if (operations.some(operation => operation.create?.phase === 'uncertain' || operation.create?.phase === 'sending')) return { state: 'busy', text: 'Waiting to confirm a task creation with Google', detail };
        if (operations.some(operation => operation.remove)) return { state: 'busy', text: 'Deletion pending', detail };
        if (detail) return { state: 'busy', text: 'Waiting for another device', detail };
        return { state: 'ok', text: 'Up to date' };
    }

    private failure(error: unknown): Status {
        const message = error instanceof Error ? error.message : 'Sync failed. Pending edits are kept.';
        this.problem = { state: 'error', text: message };
        if (error instanceof GoogleError && error.failure === 'account') this.report({ id: `account:${error.reason}`, message });
        return this.problem;
    }

    private typing(path: string): boolean {
        return Object.values(this.data.edits).some(edit => edit.path === path && edit.title !== undefined);
    }

    // A checked row in the note stays there, even when it is overdue or done.
    // Deriving this from the note keeps every device in agreement (P1).
    private retained(parsed: Region[]): string[] {
        return syncedRows(parsed).flatMap(row => {
            const key = this.resolve(row.key);
            return !key.startsWith('new:') && visibleRow(row.line.text)?.done ? [key] : [];
        });
    }

    owns(key: string): boolean {
        // Only a key this device issued is its draft. The owner prefix in a key
        // is visible in synced notes, so a copied or forged key proves nothing.
        return Object.hasOwn(this.data.drafts, key) || Boolean(this.data.outbox[key]?.create) || Boolean(this.data.created[key]);
    }

    // The row key a stale key refers to now: after a late-undo replacement,
    // after this device created a draft, or after relinking a foreign draft.
    resolve(key: string): string {
        let current = key;
        for (let hop = 0; hop < 8; hop++) {
            const created = this.data.created[current];
            const next = this.data.aliases[current] ?? (created && !created.marker ? itemKey('task', created.source, created.id) : undefined);
            if (!next || next === current) break;
            current = next;
        }
        return current;
    }

    // The key records when the draft was made, so a stale copy of a note
    // arriving after its created ID was pruned is never created again. The
    // journal records the key at once, which is what makes it this device's.
    draftKey(): string {
        const key = `new:${this.data.runtimeOwner ? this.data.runtimeOwner + ':' : ''}${this.now().toString(36)}_${crypto.randomUUID()}`;
        this.data.drafts[key] = this.now();
        this.persist('journal');
        return key;
    }

    private stale(key: string): boolean {
        const made = /^new:[^:]+:([0-9a-z]+)_/.exec(key)?.[1];
        return made !== undefined && this.now() - parseInt(made, 36) > RETENTION;
    }

    private snapshot(path: string, key: string): Item | undefined {
        return this.data.notes[path]?.rows[key] ?? this.data.deletedTasks[key]?.item
            ?? Object.values(this.data.notes).find(state => state.rows[key])?.rows[key];
    }

    // A task row another device rendered has no local snapshot yet. Its key
    // names the task, so it can still be edited or deleted, but only in a list
    // enabled here: a key planted in a note must not reach any other list.
    foreignTask(key: string, text?: string): Item | undefined {
        const target = parseItemKey(key);
        const visible = text === undefined ? undefined : visibleRow(text);
        if (target?.kind !== 'task' || !visible) return undefined;
        if (!this.data.settings.taskLists.some(list => list.enabled && list.id === target.source)) return undefined;
        return { key, kind: 'task', source: target.source, id: target.id, section: 'tasks', title: visible.title.trim(), done: visible.done ?? false, prefix: '', date: '', writable: true, sort: '' };
    }

    journalEdits(path: string, edits: ({ key: string } & Edit)[]): void {
        for (const { key, ...fields } of edits) {
            this.data.edits[key] = { ...this.data.edits[key], ...fields, path };
            // Editing a refused draft is the signal to try creating it again.
            const operation = this.data.outbox[this.resolve(key)];
            if (operation?.create?.phase === 'refused') this.data.outbox[operation.key] = { ...operation, create: { ...operation.create, phase: 'prepared' } };
        }
        this.persist('journal');
    }

    private draftSnapshot(operation: Operation): Item {
        return {
            key: operation.key, kind: 'task', source: operation.source, id: operation.id,
            section: 'tasks', title: operation.title ?? '', done: operation.done ?? false,
            prefix: '', date: operation.create?.date ?? '', writable: true, sort: '',
        };
    }

    private stage(path: string, date: string, parsed: Region[], titles: boolean): boolean {
        const state = this.data.notes[path] ??= { rows: {} };
        const rows = syncedRows(parsed);
        let staged = false;
        // 1. Journal entries made in this device's editor.
        for (const [key, edit] of Object.entries(this.data.edits)) {
            if (edit.path !== path) continue;
            const fields: Edit = {
                ...(edit.done !== undefined ? { done: edit.done } : {}),
                ...(titles && edit.title !== undefined ? { title: edit.title } : {}),
            };
            if (!Object.keys(fields).length) continue;
            const line = rows.find(row => row.key === key)?.line.text;
            const target = this.target(path, key, line);
            // A foreign draft waits until its task is relinked; its row gone,
            // the edit has nowhere to go (P2).
            if (target === 'wait' && line !== undefined) continue;
            if (target && target !== 'wait') {
                this.queueFields(target, fields);
                staged = true;
            }
            if (fields.done !== undefined) delete edit.done;
            if (fields.title !== undefined) delete edit.title;
            if (edit.done === undefined && edit.title === undefined) delete this.data.edits[key];
        }
        for (const region of parsed) {
            if (region.section !== 'tasks') continue;
            for (const line of region.lines) {
                const key = line.fenced ? undefined : rowKey(line.text);
                if (!key) continue;
                const visible = visibleRow(line.text);
                const title = visible?.title.trim();
                // 2. A late undo: create the replacement from the restored row.
                const restoration = this.data.deletedTasks[key];
                if (restoration?.restoredKey && !restoration.deleted && !this.data.created[restoration.restoredKey]) {
                    if (!title) continue;
                    const existing = this.data.outbox[restoration.restoredKey];
                    if (existing?.remove) continue;
                    const operation: Operation = {
                        ...existing, key: restoration.restoredKey, kind: 'task', id: '', source: restoration.item.source,
                        path, title, done: visible?.done ?? false,
                        create: existing?.create ?? { date: restoration.item.date || date, phase: 'prepared' },
                        replaces: existing?.replaces ?? (restoration.deletionKey !== restoration.restoredKey ? restoration.deletionKey : undefined),
                    };
                    if (JSON.stringify(existing) !== JSON.stringify(operation)) { this.data.outbox[operation.key] = operation; staged = true; }
                    state.rows[key] = { ...this.draftSnapshot(operation), key };
                    continue;
                }
                // 3. This device's own drafts become creations from the row's
                // current text, including edits another device made (1.4).
                if (!key.startsWith('new:') || !this.owns(key) || this.data.created[key] || !title || visible?.done === undefined) continue;
                const existing = this.data.outbox[key];
                if (!existing && this.stale(key)) continue;
                if (existing?.remove || (existing && existing.create?.phase !== 'prepared')) continue;
                // Creation waits for Vim normal mode or the idle timeout.
                if (!titles && !existing) continue;
                const source = existing?.source ?? this.data.settings.defaultTaskList;
                if (!source) {
                    this.report({ id: 'default-list', message: 'Choose a list for new tasks in Calendar Sync settings. Task rows stay in your note until then.' });
                    continue;
                }
                const operation: Operation = {
                    ...existing, key, kind: 'task', id: '', source, path,
                    title: titles ? title : existing!.title, done: visible.done,
                    create: existing?.create ?? { date, phase: 'prepared' },
                };
                if (JSON.stringify(existing) !== JSON.stringify(operation)) { this.data.outbox[key] = operation; staged = true; }
                state.rows[key] = this.draftSnapshot(operation);
            }
        }
        return staged;
    }

    // Where a journal edit goes: a pending creation, or a Google item.
    private target(path: string, key: string, line?: string): Operation | 'wait' | undefined {
        const current = this.resolve(key);
        const restoration = this.data.deletedTasks[key];
        if (restoration?.restoredKey && !restoration.deleted && !this.data.created[restoration.restoredKey]) return this.data.outbox[restoration.restoredKey];
        if (current.startsWith('new:')) {
            const operation = this.data.outbox[current];
            if (operation?.create) return operation;
            return this.owns(current) ? undefined : 'wait';
        }
        const item = this.snapshot(path, current) ?? this.snapshot(path, key) ?? this.foreignTask(current, line);
        if (!item?.writable) return undefined;
        return { key: current, kind: item.kind, source: item.source, id: item.id, path, marker: item.done !== undefined };
    }

    private queueFields(target: Operation, fields: Edit): void {
        if (target.create) {
            const operation = { ...this.data.outbox[target.key] ?? target, ...fields };
            this.data.outbox[target.key] = operation;
            return;
        }
        const pending = this.data.outbox[target.key];
        this.data.outbox[target.key] = { ...pending, ...target, ...(pending?.remove ? { remove: true, removeAfter: pending.removeAfter } : {}), ...fields };
    }

    private pendingKeys(): Set<string> {
        const keys = new Set<string>();
        for (const operation of Object.values(this.data.outbox)) {
            if (!operation.remove) continue;
            const target = this.data.created[operation.key] ?? operation;
            keys.add(operation.key);
            if (target.id) keys.add(itemKey(operation.kind, target.source, target.id));
        }
        return keys;
    }

    private pendingDeletion(item: Item, pending = this.pendingKeys()): boolean {
        return pending.has(item.key) || pending.has(itemKey(item.kind, item.source, item.id));
    }

    // Builds what the note should show. Returns the note text with stale row
    // keys already replaced, so the render keeps each row where it is.
    private compose(path: string, text: string, parsed: Region[], loaded: Loaded): { items: Item[]; keep: Set<string>; text: string } {
        const state = this.data.notes[path]!;
        const pending = this.pendingKeys();
        const rows = syncedRows(parsed);
        const present = new Set(rows.map(row => row.key));
        // P2: while a draft another device created still carries its marker in
        // Google, relink the draft's row to that task instead of showing both.
        for (const item of loaded.items) {
            if (!item.marker || !present.has(item.marker) || this.data.created[item.marker] || this.data.outbox[item.marker]) continue;
            if (loaded.items.filter(other => other.marker === item.marker).length === 1) this.data.aliases[item.marker] = item.key;
        }
        // Late undo keeps the Markdown row while its replacement is created.
        const items = loaded.items.filter(item => !this.pendingDeletion(item, pending));
        for (const [key, record] of Object.entries(this.data.deletedTasks)) {
            if (record.path !== path || record.deleted || !record.restoredKey || this.data.created[record.restoredKey]) continue;
            const snapshot = state.rows[key];
            if (snapshot && present.has(key)) items.push(snapshot);
        }
        // Rows of sources that could not be read stay as they are.
        const keep = new Set<string>();
        const unreadable = new Set(loaded.failed.map(failure => `${failure.kind}:${failure.source}`));
        for (const row of rows) {
            const target = state.rows[row.key] ?? (parseItemKey(row.key) && { ...parseItemKey(row.key)!, key: row.key });
            if (!target || !unreadable.has(`${target.kind}:${target.source}`)) continue;
            if (state.rows[row.key] && !items.some(item => item.key === row.key)) items.push(state.rows[row.key]!);
            else keep.add(row.key);
        }
        for (const item of items) {
            const operation = this.data.outbox[item.key];
            if (operation?.title !== undefined) item.title = operation.title;
            if (operation?.done !== undefined) item.done = operation.done;
        }
        return { items, keep, text: this.rekey(text, parsed) };
    }

    // Replaces stale keys in place: drafts this device created, relinked
    // drafts and late-undo replacements (1.6).
    private rekey(text: string, parsed: Region[]): string {
        let prepared = text;
        for (const row of syncedRows(parsed).reverse()) {
            const current = this.resolve(row.key);
            const restoration = this.data.deletedTasks[row.key];
            if (current === row.key || (restoration?.restoredKey && !this.data.created[restoration.restoredKey])) continue;
            const from = row.line.from + row.line.text.lastIndexOf(`gdn:${row.key} -->`) + 4;
            prepared = prepared.slice(0, from) + current + prepared.slice(from + row.key.length);
        }
        return prepared;
    }

    queueDeletions(path: string, rows: { key: string; text?: string }[]): void {
        for (const { key, text } of rows) {
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
            const snapshot = this.snapshot(path, key) ?? this.foreignTask(key, text);
            if (!snapshot?.writable && !pending?.create) continue;
            const item = pending?.create ? { ...this.draftSnapshot(pending), key } : snapshot!;
            if (item.kind === 'task') this.data.deletedTasks[key] = { path, item: { ...item }, deletionKey: pendingKey, deleted: true };
            this.data.outbox[pendingKey] = {
                ...(pending ?? { key: pendingKey, kind: item.kind, source: item.source, id: item.id, path }),
                remove: true, removeAfter: this.now() + 5000,
            };
        }
        this.persist('journal');
    }

    // Returns event keys whose deletion was already sent: Google cannot
    // restore them, so the next render removes the row again (D12).
    restoreDeletions(path: string, keys: string[], at = this.now()): string[] {
        const lost: string[] = [];
        for (const restored of keys) {
            // Native history can still hold a row's key from before a late-undo
            // replacement; the alias leads to the current row's record.
            const key = this.data.deletedTasks[restored]?.deleted ? restored : this.resolve(restored);
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
                record.restoredKey = this.draftKey();
            } else if (parseItemKey(key)?.kind === 'event') lost.push(key);
        }
        this.persist('journal');
        return lost;
    }

    editorRows(path: string): Record<string, Item> {
        return {
            ...Object.fromEntries(Object.entries(this.data.deletedTasks).filter(([, record]) => record.path === path).map(([key, record]) => [key, record.item])),
            ...this.data.notes[path]?.rows,
        };
    }

    // Serialized: the scheduler never overlaps runs, but deadline timers and
    // late responses may call in while a run waits for Google.
    flush(): Promise<boolean> {
        this.flushing ??= this.flushOnce().finally(() => { this.flushing = undefined; });
        return this.flushing;
    }

    private async flushOnce(): Promise<boolean> {
        let sent = false;
        let stopped = false;
        for (const [key, operation] of Object.entries(this.data.outbox)) {
            if (this.stopped || this.storageFailed) { stopped = true; break; }
            if (this.data.outbox[key] !== operation) continue;
            if (operation.remove && (operation.removeAfter ?? 0) > this.now()) continue;
            if (operation.replaces && this.data.outbox[operation.replaces]?.remove) continue;
            try {
                if (operation.create) sent = await this.flushCreation(key, operation) || sent;
                else {
                    if (operation.remove) await this.remote.remove(operation);
                    else await this.remote.patch(operation);
                    if (operation.remove) this.forget(operation);
                    this.settle(key, operation);
                    sent = true;
                }
            } catch (error) {
                if (this.fail(key, operation, error)) { this.persist('journal'); stopped = true; break; }
            }
            if (!this.persist('journal')) { stopped = true; break; }
        }
        // A run that sent everything it could clears an earlier problem.
        if (!stopped) this.problem = undefined;
        return sent;
    }

    // Clears what a finished request sent. A field that changed while the
    // request ran still holds a newer value and stays pending.
    private settle(key: string, sent: Operation): void {
        const current = this.data.outbox[key];
        if (!current) return;
        if (current === sent) { delete this.data.outbox[key]; return; }
        const next = { ...current };
        if (sent.title !== undefined && next.title === sent.title) delete next.title;
        if (sent.done !== undefined && next.done === sent.done) delete next.done;
        if (sent.remove && next.remove) { delete next.remove; delete next.removeAfter; }
        if (next.title === undefined && next.done === undefined && !next.remove && !next.create) delete this.data.outbox[key];
        else this.data.outbox[key] = next;
    }

    // A removed item leaves every note's baseline.
    private forget(operation: Operation): void {
        const target = this.data.created[operation.key] ?? operation;
        for (const state of Object.values(this.data.notes)) for (const [rowKey, row] of Object.entries(state.rows)) {
            if (rowKey === operation.key || (row.kind === operation.kind && row.source === target.source && row.id === target.id)) delete state.rows[rowKey];
        }
        for (const record of Object.values(this.data.created)) if (operation.kind === 'task' && record.source === target.source && record.id === target.id) record.markerRemoved = true;
    }

    // Returns true when sending must stop: the account, quota or network is the
    // problem, not this item. The operation stays queued for a later run.
    private fail(key: string, operation: Operation, error: unknown): boolean {
        if (!(error instanceof GoogleError)) { this.failure(error); return true; }
        if (error.failure === 'gone' && !operation.create) {
            // Remote deletion wins. Editing a stale line cannot recreate it.
            delete this.data.outbox[key];
            return false;
        }
        if (error.failure !== 'refused' && error.failure !== 'gone') { this.failure(error); return true; }
        // D2: Google wins. Drop what was refused and show the typed value.
        const title = operation.title ?? this.snapshot(operation.path, key)?.title ?? this.data.deletedTasks[key]?.item.title ?? '';
        const what = operation.create ? `create “${title}”` : operation.remove ? `delete “${title}”`
            : operation.title !== undefined ? `rename it to “${operation.title}”` : `mark “${title}” as ${operation.done ? 'done' : 'not done'}`;
        this.report({
            id: `refused:${key}:${this.now()}`,
            message: `Google refused to ${what}. ${error.message} ${operation.create ? 'The row stays in your note; edit it to try again.' : 'The note shows Google’s value again.'}`,
        });
        if (operation.create) {
            this.setPhase(key, 'refused');
            return false;
        }
        // The row comes back, so its undo record must not recreate the task.
        if (operation.remove) for (const [row, record] of Object.entries(this.data.deletedTasks)) if (record.deletionKey === key) delete this.data.deletedTasks[row];
        this.settle(key, operation);
        return false;
    }

    /**
     * How to read this code:
     * 1. flushCreation() handles one task creation. A draft never sent is
     *    cancelled locally when its row is deleted, and posted otherwise.
     * 2. Before a POST, the phase `sending` and the attempt time are saved.
     *    A definite answer settles it; a timeout or lost response makes it
     *    `uncertain`, and a transport timeout reports when the abandoned
     *    request itself finally ended.
     * 3. Two minutes after that, find() searches for the creation marker,
     *    including deleted tasks. A match is linked; several matches link one
     *    and leave the rest as ordinary tasks. No match: a deleted row cancels
     *    the creation for good, otherwise the same key and marker are sent
     *    again (D3). A failed search changes nothing.
     * Ordinary: one POST, then linkCreated() and a rewritten row key.
     * Tricky: the first POST commits after the search came back empty and the
     *    resend succeeded. That leaves a duplicate the note shows; no request
     *    ordering on this side can rule it out.
     */
    private async flushCreation(key: string, operation: Operation): Promise<boolean> {
        const creation = operation.create!;
        const created = this.data.created[key];
        if (created) { this.linkCreated(key, operation, created); return true; }
        if (operation.remove && (creation.phase === 'prepared' || creation.phase === 'refused')) {
            delete this.data.outbox[key];
            for (const state of Object.values(this.data.notes)) delete state.rows[key];
            return false;
        }
        if (creation.phase === 'refused' || creation.phase === 'sending') return false;
        if (creation.phase === 'uncertain') {
            if (creation.settled === undefined || this.now() - creation.settled < UNCERTAIN_WAIT) return false;
            let found: GoogleTask[];
            // A failed search proves nothing: the creation stays uncertain.
            try { found = await this.remote.find(operation); }
            catch (error) {
                if (error instanceof GoogleError && (error.failure === 'refused' || error.failure === 'gone')) return false;
                throw error;
            }
            if (this.data.outbox[key] !== operation) return false;
            if (found.length) {
                this.adopt(key, operation, found);
                return true;
            }
            if (operation.remove) { delete this.data.outbox[key]; return true; }
        }
        const sending: Operation = { ...operation, create: { ...creation, phase: 'sending', attempted: creation.attempted ?? this.now() } };
        this.data.outbox[key] = sending;
        // Never send before the intent to send is durable.
        if (!this.persist('journal')) { this.data.outbox[key] = operation; return false; }
        try {
            const result = await this.remote.insert(sending);
            this.data.created[key] = { ...result, at: this.now(), path: sending.path };
            this.persist('all');
            this.linkCreated(key, sending, result);
            return true;
        } catch (error) {
            // Google answered with an error: nothing was created.
            const definite = error instanceof GoogleError && error.status >= 400 && error.status < 500 && error.status !== 408;
            const phase = !definite ? 'uncertain' : error.failure === 'refused' || error.failure === 'gone' ? 'refused' : 'prepared';
            this.setPhase(key, phase, error instanceof RequestTimeout ? undefined : this.now());
            if (phase === 'refused') { this.fail(key, sending, error); return false; }
            if (error instanceof RequestTimeout) void this.late(key, error);
            throw error;
        }
    }

    private setPhase(key: string, phase: 'prepared' | 'uncertain' | 'refused', settled?: number): void {
        const current = this.data.outbox[key];
        if (!current?.create) return;
        this.data.outbox[key] = { ...current, create: { ...current.create, phase, ...(phase === 'uncertain' ? { settled } : {}) } };
    }

    // The abandoned POST ended after all. A success tells us the task's ID.
    private async late(key: string, timeout: RequestTimeout): Promise<void> {
        const response = await timeout.late.catch(() => undefined);
        const current = this.data.outbox[key];
        if (this.stopped || current?.create?.phase !== 'uncertain' || this.data.created[key]) return;
        const id = response && response.status >= 200 && response.status < 300 ? (response.json as { id?: string } | undefined)?.id : undefined;
        if (id) {
            this.data.created[key] = { source: current.source, id, at: this.now(), path: current.path };
            this.persist('all');
        } else this.setPhase(key, 'uncertain', this.now());
        this.persist('journal');
    }

    // Links the marked task a search found. Extra copies become ordinary
    // tasks once their markers are gone, so the note shows them.
    private adopt(key: string, operation: Operation, found: GoogleTask[]): void {
        const [linked, ...others] = [...found].sort((a, b) => Number(Boolean(a.deleted)) - Number(Boolean(b.deleted)));
        const result = { source: operation.source, id: linked!.id };
        this.data.created[key] = { ...result, at: this.now(), path: operation.path };
        for (const other of others) {
            if (!other.deleted) this.data.created[`${key}:copy:${other.id}`] = { source: operation.source, id: other.id, marker: key, at: this.now(), path: operation.path };
        }
        this.persist('all');
        // The found task holds the title and state of the first attempt.
        this.linkCreated(key, { ...operation, title: undefined, done: undefined }, result);
    }

    // After the POST: point the row at the task and keep any newer edit.
    private linkCreated(key: string, sent: Operation, result: { source: string; id: string }): void {
        const current = this.data.outbox[key];
        const taskKey = itemKey('task', result.source, result.id);
        const restored = Object.entries(this.data.deletedTasks).find(([, record]) => record.restoredKey === key);
        // 1.6: a late-undo row takes its replacement's key; the old key stays
        // an alias so native undo and redo still find the row.
        if (restored) this.data.aliases[restored[0]] = taskKey;
        for (const state of Object.values(this.data.notes)) for (const rowKey of [key, restored?.[0]]) {
            const snapshot = rowKey ? state.rows[rowKey] : undefined;
            if (snapshot) { snapshot.source = result.source; snapshot.id = result.id; }
        }
        if (!current) return;
        if (current.remove) {
            this.data.outbox[key] = { key, kind: 'task', source: result.source, id: result.id, path: current.path, remove: true, removeAfter: current.removeAfter };
            return;
        }
        delete this.data.outbox[key];
        const fields: Edit = {
            ...(current.title !== undefined && current.title !== sent.title ? { title: current.title } : {}),
            ...(current.done !== undefined && current.done !== sent.done ? { done: current.done } : {}),
        };
        if (Object.keys(fields).length) this.data.outbox[taskKey] = { ...this.data.outbox[taskKey], key: taskKey, kind: 'task', source: result.source, id: result.id, path: current.path, ...fields };
    }

    // Removes creation markers once the new key reached the note, so other
    // devices can relink a stale draft until then (P2). Without a render, the
    // key is rewritten in the note file first.
    private async cleanupMarkers(path?: string): Promise<void> {
        for (const [key, created] of Object.entries(this.data.created)) {
            if (created.markerRemoved || this.stopped || this.storageFailed || this.data.outbox[key]?.create) continue;
            // `path` was just rendered with the new key. Another note gets its
            // key rewritten first; a note that cannot be, waits up to a day.
            const rendered = created.path === undefined || created.path === path || created.marker;
            if (!rendered && this.now() - (created.at ?? 0) < MARKER_WAIT && !await this.rewrite(created.path!)) continue;
            try {
                await this.remote.removeCreationMarker(created.marker ?? key, created.source, created.id);
            } catch (error) {
                if (!(error instanceof GoogleError) || error.failure !== 'refused') { this.failure(error); return; }
            }
            created.markerRemoved = true;
            created.at = this.now();
            if (!this.persist('all')) return;
        }
    }

    /**
     * 4.8: removes device state that is provably disposable.
     * - Deletion records and late-undo aliases serve native undo history,
     *   which Obsidian keeps in memory across note switches and plugin reloads
     *   but not across an app restart. `restarted` is true on the first load
     *   of an app session; unfinished restorations and anything pending stay.
     * - A note snapshot goes when nothing pending refers to its note and the
     *   note is gone or was not synced for 14 days. A missing snapshot sends
     *   nothing; the next render rebuilds it.
     * - A created ID goes 14 days after its marker was removed. A stale copy
     *   of that draft is then not relinked; the key's age keeps it from being
     *   created again.
     * - An issued draft key goes after 14 days, and so does the overdue-event
     *   list of a calendar that was not read for 14 days.
     */
    prune(restarted: boolean, exists: (path: string) => boolean): void {
        const now = this.now();
        const pending = new Set<string>([...Object.keys(this.data.outbox), ...Object.keys(this.data.edits)]);
        for (const operation of Object.values(this.data.outbox)) if (operation.replaces) pending.add(operation.replaces);
        if (restarted) {
            for (const [key, record] of Object.entries(this.data.deletedTasks)) {
                const restoring = !record.deleted && record.restoredKey && !this.data.created[record.restoredKey];
                if (!restoring && !pending.has(key) && !pending.has(record.deletionKey) && !(record.restoredKey && pending.has(record.restoredKey))) delete this.data.deletedTasks[key];
            }
            for (const key of Object.keys(this.data.aliases)) if (!this.data.deletedTasks[key] && !pending.has(key)) delete this.data.aliases[key];
        }
        const paths = new Set([...Object.values(this.data.outbox), ...Object.values(this.data.edits), ...Object.values(this.data.deletedTasks)].map(entry => entry.path));
        for (const [path, state] of Object.entries(this.data.notes)) {
            if (!paths.has(path) && (!exists(path) || now - (state.synced ?? now) > RETENTION)) delete this.data.notes[path];
        }
        // A draft this old is never created anyway (stale()), and an
        // overdue-event list not read for as long belongs to a calendar no
        // longer in use.
        for (const [key, issued] of Object.entries(this.data.drafts)) if (now - issued > RETENTION) delete this.data.drafts[key];
        for (const [id, entry] of Object.entries(this.data.calendars)) if (!(now - entry.scanned <= RETENTION)) delete this.data.calendars[id];
        const records = Object.values(this.data.deletedTasks);
        for (const [key, created] of Object.entries(this.data.created)) {
            if (!created.markerRemoved || now - (created.at ?? now) < RETENTION || pending.has(key) || records.some(record => record.restoredKey === key || record.deletionKey === key)) continue;
            delete this.data.created[key];
        }
    }

    // Rewrites resolved keys in a note that is not being rendered.
    private async rewrite(path: string): Promise<boolean> {
        const text = await this.notes.read(path);
        if (text === undefined) return true;
        let parsed: Region[];
        try { parsed = regions(text, this.notes.indent(), this.notes.tabWidth()); } catch { return false; }
        const prepared = this.rekey(text, parsed);
        return prepared === text || await this.notes.write(path, text, prepared);
    }
}
