import { describe, expect, it, vi } from 'vitest';
import { SyncEngine, UNCERTAIN_WAIT, type Problem, type SaveScope } from '../src/sync';
import { GoogleError, RequestTimeout, type HttpResponse } from '../src/http';
import { itemKey, readRow, regions, syncedRows, visibleRow } from '../src/markdown';
import type { Edit, GoogleTask, Item, PluginData, Remote, SourceFailure } from '../src/types';
import { DATE, EMPTY, PATH, event, item, seeded, withDraft } from './fixtures';

function harness(items: Item[] = [item()], data?: PluginData, text?: string) {
    const seed = seeded(items);
    if (data) seed.data = data;
    const state = { text: text ?? seed.text, indent: '    ', now: 100000, failed: [] as SourceFailure[] };
    let createdCount = 0;
    const remote = {
        load: vi.fn(async (_date: string, _settings: unknown, _retained: string[]) => ({ items: structuredClone(items), failed: state.failed })),
        patch: vi.fn(async (operation: Parameters<Remote['patch']>[0]) => {
            const target = items.find(value => value.kind === operation.kind && value.source === operation.source && value.id === operation.id);
            if (target) {
                if (operation.title !== undefined) target.title = operation.title;
                if (operation.done !== undefined) target.done = operation.done;
            }
        }),
        insert: vi.fn(async (operation: Parameters<Remote['insert']>[0]) => {
            const id = ++createdCount === 1 ? 'created' : `created-${createdCount}`;
            items.push(item({ id, source: operation.source, title: operation.title, done: operation.done, date: operation.create!.date, marker: operation.key }));
            return { id, source: operation.source };
        }),
        find: vi.fn(async (_operation: Parameters<Remote['find']>[0]): Promise<GoogleTask[]> => []),
        removeCreationMarker: vi.fn(async (_key: string, _source: string, id: string) => {
            const target = items.find(value => value.id === id);
            if (target) delete target.marker;
        }),
        remove: vi.fn(async (operation: Parameters<Remote['remove']>[0]) => {
            const index = items.findIndex(value => value.kind === operation.kind && value.source === operation.source && value.id === operation.id);
            if (index >= 0) items.splice(index, 1);
        }),
    } satisfies Remote;
    const saved = { data: structuredClone(seed.data) };
    const save = vi.fn((_scope: SaveScope) => { saved.data = structuredClone(seed.data); return true; });
    const problems: Problem[] = [];
    const notes = {
        read: async () => state.text,
        indent: () => state.indent,
        tabWidth: () => 4,
        write: vi.fn(async (_path: string, before: string, after: string) => { if (state.text !== before) return false; state.text = after; return true; }),
    };
    const engine = new SyncEngine(seed.data, remote, notes, save, () => state.now, problem => problems.push(problem));
    const lines = (value: string) => new Map(syncedRows(regions(value, state.indent)).map(row => [row.key, row.line.text]));
    // An edit made in this device's editor: the new text, plus what the editor journals.
    const type = (next: string, target = engine) => {
        const before = lines(state.text);
        const edits: ({ key: string } & Edit)[] = [];
        for (const [key, line] of lines(next)) {
            const previous = before.get(key);
            if (previous === undefined || previous === line) continue;
            const snapshot = target.editorRows(PATH)[key];
            const read = (value: string): Edit | undefined => snapshot ? readRow(value, snapshot) : { title: visibleRow(value)?.title.trim(), done: visibleRow(value)?.done };
            const now = read(line);
            const old = read(previous);
            const edit: { key: string } & Edit = { key };
            if (now?.title && now.title !== old?.title) edit.title = now.title;
            if (now?.done !== undefined && now.done !== old?.done) edit.done = now.done;
            if (edit.title !== undefined || edit.done !== undefined) edits.push(edit);
        }
        // The editor gets every key it writes from draftKey(), which records it.
        for (const key of lines(next).keys()) if (key.startsWith('new:') && !before.has(key)) target.data.drafts[key] ??= state.now;
        state.text = next;
        if (edits.length) target.journalEdits(PATH, edits);
    };
    // A whole-row deletion in the editor, as Vim dd reports it.
    const remove = (key: string, target = engine) => {
        const line = state.text.split('\n').find(value => value.includes(`gdn:${key} -->`))!;
        state.text = state.text.split('\n').filter(value => value !== line).join('\n');
        target.queueDeletions(PATH, [{ key, text: line }]);
        return line;
    };
    const restart = () => new SyncEngine(structuredClone(saved.data), remote, notes, save, () => state.now, problem => problems.push(problem));
    return { ...seed, state, remote, save, saved, engine, items, problems, notes, type, remove, restart };
}

const rows = (text: string) => text.split('\n').filter(line => / <!-- gdn:[^ ]+ -->$/.test(line) && !/gdn:(events|recurring|tasks) /.test(line));

describe('note content is not authority (2026-10-03 security audits)', () => {
    const DAY = 24 * 3600000;
    it('does not create a draft with this device’s owner that this device never issued (Astra S1)', async () => {
        const h = harness([]);
        h.state.text = withDraft(EMPTY, 'Injected from an external file', 'new:device:forged');
        await h.engine.run(PATH, true);
        expect(h.remote.insert).not.toHaveBeenCalled();
        expect(h.state.text).toContain('Injected from an external file <!-- gdn:new:device:forged -->');
    });
    it('does not edit or delete a task row planted for a list that is not enabled (Fable L1, Astra S2)', async () => {
        const planted = item({ source: 'disabled-list', id: 'unrelated-task' });
        const h = harness([]);
        h.state.text = EMPTY.replace('<!-- gdn:tasks -->\n', `<!-- gdn:tasks -->\n    - [ ] Looks harmless <!-- gdn:${planted.key} -->\n`);
        expect(h.engine.editorRows(PATH)[planted.key]).toBeUndefined();
        h.type(h.state.text.replace('- [ ] Looks harmless', '- [x] Renamed'));
        await h.engine.run(PATH, true);
        expect(h.remote.patch).not.toHaveBeenCalled();
        h.state.text = EMPTY.replace('<!-- gdn:tasks -->\n', `<!-- gdn:tasks -->\n    - [ ] Looks harmless <!-- gdn:${planted.key} -->\n`);
        h.remove(planted.key);
        h.state.now += 6000;
        await h.engine.run(PATH, true);
        expect(h.remote.remove).not.toHaveBeenCalled();
    });
    it('still edits a task row another device rendered in an enabled list', async () => {
        const other = item({ id: 'from-the-phone', title: 'From the phone' });
        const h = harness([]);
        h.state.text = EMPTY.replace('<!-- gdn:tasks -->\n', `<!-- gdn:tasks -->\n    - [ ] From the phone <!-- gdn:${other.key} -->\n`);
        h.type(h.state.text.replace('- [ ] From the phone', '- [x] From the phone'));
        await h.engine.run(PATH, true);
        expect(h.remote.patch).toHaveBeenCalledWith(expect.objectContaining({ source: 'list', id: 'from-the-phone', done: true }));
    });
    it('keeps syncing a note with a row keyed like an Object.prototype member (Fable L2)', async () => {
        const h = harness();
        const planted = ['constructor', '__proto__', 'toString', 'hasOwnProperty'].map(key => `    - [x] Planted ${key} <!-- gdn:${key} -->`).join('\n');
        h.state.text = h.state.text.replace('<!-- gdn:tasks -->\n', `<!-- gdn:tasks -->\n${planted}\n`);
        h.items[0]!.title = 'Renamed in Google';
        const status = await h.engine.run(PATH, true);
        expect(status.state).toBe('ok');
        expect(h.state.text).toContain('Renamed in Google');
        expect(h.state.text).toContain('Planted constructor <!-- gdn:constructor -->');
    });
    it('drops the overdue-event list of a calendar not read for 14 days', () => {
        const h = harness([]);
        const entry = (scanned: number) => ({ scope: 'Europe/Warsaw', until: '', scanned, watermark: '', events: {} });
        h.data.calendars = { old: entry(h.state.now - 15 * DAY), fresh: entry(h.state.now - DAY) };
        h.engine.prune(false, () => true);
        expect(Object.keys(h.data.calendars)).toEqual(['fresh']);
    });
});

describe('journal: only this device’s editor edits reach Google (D1)', () => {
    it('does not push another device’s older title over a newer Google value', async () => {
        const h = harness();
        h.items[0]!.title = 'Newest Google title';
        // Sync delivers the other device's render; it is not in this journal.
        h.state.text = h.state.text.replace('Buy coffee', 'Synced older title');
        await h.engine.run(PATH, true);
        expect(h.remote.patch).not.toHaveBeenCalled();
        expect(h.state.text).toContain('Newest Google title');
    });
    it('does not push another device’s checkbox state', async () => {
        const h = harness();
        h.state.text = h.state.text.replace('- [ ] Buy coffee', '- [x] Buy coffee');
        await h.engine.run(PATH, true);
        expect(h.remote.patch).not.toHaveBeenCalled();
        expect(h.state.text).toContain('- [ ] Buy coffee');
    });
    it('still pushes a title edited here just before an outside write (AR-3)', async () => {
        const h = harness();
        h.type(h.state.text.replace('Buy coffee', 'Buy tea'));
        h.state.text = h.state.text.replace('Buy tea', 'Buy coffee').replace('Outside the sections.', 'Text from the phone.');
        await h.engine.run(PATH, true);
        expect(h.remote.patch).toHaveBeenCalledWith(expect.objectContaining({ title: 'Buy tea' }));
        expect(h.state.text).toContain('Buy tea');
        expect(h.state.text).toContain('Text from the phone.');
    });
    it('keeps new rows and paragraphs that arrive from outside and pushes nothing', async () => {
        const h = harness([item(), item({ id: 'phone', title: 'Rendered on the phone' })]);
        h.state.text = h.state.text.replace('Outside the sections.', 'Outside the sections.\nA paragraph from the phone.');
        await h.engine.run(PATH, true);
        expect(h.state.text).toContain('A paragraph from the phone.');
        expect(h.state.text).toContain('Rendered on the phone');
        expect(h.remote.patch).not.toHaveBeenCalled();
    });
    it('writes nothing when a render changes nothing (FP-5)', async () => {
        const h = harness();
        await h.engine.run(PATH, true);
        expect(h.notes.write).not.toHaveBeenCalled();
    });
    it('pushes just the edited title and preserves a remote status change', async () => {
        const h = harness();
        h.type(h.state.text.replace('Buy coffee', 'Buy tea'));
        h.items[0]!.done = true;
        await h.engine.run(PATH, true);
        expect(h.remote.patch).toHaveBeenCalledWith(expect.objectContaining({ title: 'Buy tea' }));
        expect(vi.mocked(h.remote.patch).mock.calls[0]![0].done).toBeUndefined();
        expect(h.state.text).toContain('- [x] Buy tea');
    });
    it('pushes a toggle immediately but keeps an unfinished title edit local', async () => {
        const h = harness();
        h.type(h.state.text.replace('- [ ] Buy coffee', '- [x] Buy coff'));
        await h.engine.run(PATH, false);
        expect(vi.mocked(h.remote.patch).mock.calls[0]![0]).toMatchObject({ done: true });
        expect(vi.mocked(h.remote.patch).mock.calls[0]![0].title).toBeUndefined();
        expect(h.state.text).toContain('Buy coff <!--');
        await h.engine.run(PATH, true);
        expect(h.items[0]!.title).toBe('Buy coff');
    });
    it('keeps failed edits in the durable journal and retries', async () => {
        const h = harness();
        h.type(h.state.text.replace('Buy coffee', 'Buy tea'));
        vi.mocked(h.remote.patch).mockRejectedValueOnce(new Error('Offline'));
        expect(await h.engine.run(PATH, true)).toMatchObject({ state: 'error', text: 'Offline' });
        expect(h.saved.data.outbox[item().key]?.title).toBe('Buy tea');
        await h.engine.run(PATH, true);
        expect(h.data.outbox).toEqual({});
        expect(h.state.text).toContain('Buy tea');
    });
    it('keeps a newer edit when an older request finishes (AP-1)', async () => {
        const h = harness();
        h.type(h.state.text.replace('Buy coffee', 'Buy tea'));
        vi.mocked(h.remote.patch).mockImplementationOnce(async () => { h.type(h.state.text.replace('Buy tea', 'Buy milk')); });
        await h.engine.run(PATH, true);
        expect(h.data.edits[item().key]?.title).toBe('Buy milk');
        await h.engine.run(PATH, true);
        expect(h.items[0]!.title).toBe('Buy milk');
    });
    it('saves edits, deletions and undo decisions at once, without a sync', () => {
        const h = harness();
        h.type(h.state.text.replace('Buy coffee', 'Buy tea'));
        expect(h.saved.data.edits[item().key]).toMatchObject({ title: 'Buy tea' });
        h.remove(item().key);
        expect(h.saved.data.outbox[item().key]?.remove).toBe(true);
        h.engine.restoreDeletions(PATH, [item().key]);
        expect(h.saved.data.outbox[item().key]?.remove).toBeUndefined();
        expect(vi.mocked(h.save).mock.calls.every(([scope]) => scope === 'journal')).toBe(true);
        expect(h.remote.load).not.toHaveBeenCalled();
    });
    it('leaves user text untouched if it changes during a fetch', async () => {
        const h = harness();
        h.remote.load.mockImplementationOnce(async () => { h.state.text += '\nFresh user text'; return { items: [item({ title: 'Remote title' })], failed: [] }; });
        await h.engine.run(PATH, true);
        expect(h.state.text).toContain('Fresh user text');
        expect(h.state.text).toContain('Buy coffee');
    });
    it('follows indentation changes on the next sync without sending Google edits', async () => {
        const h = harness([event(), item()]);
        for (const indent of ['\t', '  ', '        ']) {
            h.state.indent = indent;
            await h.engine.run(PATH, true);
            expect(rows(h.state.text)).toHaveLength(2);
            expect(rows(h.state.text).every(line => line.startsWith(indent + '- [ ] '))).toBe(true);
        }
        expect(h.remote.patch).not.toHaveBeenCalled();
        expect(h.remote.insert).not.toHaveBeenCalled();
    });
    it('restores a row missing from disk without an explicit editor deletion', async () => {
        const h = harness();
        h.state.text = h.state.text.split('\n').filter(line => !line.includes('Buy coffee')).join('\n');
        await h.engine.run(PATH, true);
        expect(h.state.text).toContain('Buy coffee');
        expect(h.remote.remove).not.toHaveBeenCalled();
    });
    it('does no work after unload', async () => {
        const h = harness(); h.engine.stopped = true; await h.engine.run(PATH, true);
        expect(h.remote.load).not.toHaveBeenCalled(); expect(h.remote.patch).not.toHaveBeenCalled();
    });
    it('does not pull or reorder rows while the user is entering a new task', async () => {
        const h = harness();
        h.type(withDraft(h.state.text, 'still typing'));
        const before = h.state.text;
        await h.engine.run(PATH, false, false);
        expect(h.remote.load).not.toHaveBeenCalled(); expect(h.remote.insert).not.toHaveBeenCalled();
        expect(h.state.text).toBe(before);
    });
    it('skips the pull for an edit sync that sent nothing (4.5)', async () => {
        const h = harness();
        await h.engine.run(PATH, true, true, false);
        expect(h.remote.load).not.toHaveBeenCalled();
        h.type(h.state.text.replace('Buy coffee', 'Buy tea'));
        await h.engine.run(PATH, true, true, false);
        expect(h.remote.load).toHaveBeenCalledOnce();
    });
});

describe('retention follows the note (1.3)', () => {
    it('keeps a checked overdue row that is in the note, on any device', async () => {
        const h = harness([item({ date: '2026-09-18', done: true })]);
        delete h.data.notes[PATH];
        await h.engine.run(PATH, true);
        expect(h.remote.load).toHaveBeenCalledWith(DATE, h.data.settings, [h.items[0]!.key], h.data.calendars);
        expect(h.state.text).toContain('[x] Buy coffee');
        expect(h.remote.patch).not.toHaveBeenCalled();
    });
    it('does not retain an unchecked overdue row', async () => {
        const h = harness([item({ date: '2026-09-18' })]);
        await h.engine.run(PATH, true);
        expect(h.remote.load).toHaveBeenCalledWith(DATE, h.data.settings, [], h.data.calendars);
    });
    it('retains an overdue item checked in this note so it can be undone', async () => {
        const h = harness([event({ date: '2026-09-18' })]);
        h.type(h.state.text.replace('- [ ] 90 min', '- [x] 90 min'));
        await h.engine.run(PATH, false);
        await h.engine.run(PATH, true);
        expect(h.remote.load).toHaveBeenLastCalledWith(DATE, h.data.settings, [h.items[0]!.key], h.data.calendars);
    });
});

describe('task creation', () => {
    it('creates a dated task once and binds its identity', async () => {
        const h = harness([]);
        h.type(withDraft(EMPTY, 'Call Sam'));
        await h.engine.run(PATH, true);
        expect(h.remote.insert).toHaveBeenCalledTimes(1);
        expect(vi.mocked(h.remote.insert).mock.calls[0]![0].create?.date).toBe(DATE);
        expect(h.state.text).toContain(`Call Sam <!-- gdn:${itemKey('task', 'list', 'created')}`);
        expect(h.state.text).not.toContain('gdn:new:');
        expect(h.remote.find).not.toHaveBeenCalled();
        await h.engine.run(PATH, true);
        expect(h.remote.insert).toHaveBeenCalledTimes(1);
    });
    it('rewrites the key before removing the creation marker (P2)', async () => {
        const h = harness([]);
        h.type(withDraft(EMPTY, 'Call Sam'));
        vi.mocked(h.remote.removeCreationMarker).mockImplementationOnce(async (_key, _source, id) => {
            expect(h.state.text).toContain(`gdn:${itemKey('task', 'list', id)} -->`);
            delete h.items.find(value => value.id === id)!.marker;
        });
        await h.engine.run(PATH, true);
        expect(h.remote.removeCreationMarker).toHaveBeenCalledOnce();
    });
    it('rewrites another note’s key before removing its marker when that creation finishes elsewhere', async () => {
        const h = harness([]);
        h.type(withDraft(EMPTY, 'Call Sam'));
        vi.mocked(h.remote.insert).mockRejectedValueOnce(new Error('Offline'));
        await h.engine.run(PATH, true);
        // The note is closed; its row lives on disk. Another note's sync sends it.
        const disk: Record<string, string> = { [PATH]: h.state.text, '2026-09-20.md': seeded([]).text };
        h.state.now += UNCERTAIN_WAIT;
        const other = new SyncEngine(h.data, h.remote, {
            read: async path => disk[path], indent: () => '    ', tabWidth: () => 4,
            write: async (path, before, after) => { if (disk[path] !== before) return false; disk[path] = after; return true; },
        }, () => true, () => h.state.now);
        vi.mocked(h.remote.removeCreationMarker).mockImplementationOnce(async (_key, _source, id) => {
            expect(disk[PATH]).toContain(`gdn:${itemKey('task', 'list', id)} -->`);
        });
        await other.run('2026-09-20.md', true);
        expect(h.remote.load).toHaveBeenCalledWith('2026-09-20', expect.anything(), [], expect.anything());
        expect(h.remote.removeCreationMarker).toHaveBeenCalledOnce();
        expect(disk[PATH]).not.toContain('gdn:new:');
    });
    it('creates nothing for plain lines, nested lines or code in the tasks group (D5)', async () => {
        const h = harness([]);
        h.state.text = EMPTY.replace('<!-- gdn:tasks -->\n', '<!-- gdn:tasks -->\n    Plain explanation\n    - a bullet\n    ```text\n    - [ ] example <!-- gdn:new:device:9 -->\n    ```\n');
        await h.engine.run(PATH, true);
        expect(h.remote.insert).not.toHaveBeenCalled();
        expect(h.state.text).toContain('    Plain explanation\n    - a bullet\n    ```text\n    - [ ] example <!-- gdn:new:device:9 -->\n    ```\n');
    });
    it('does not create a draft received from another device through Sync', async () => {
        const h = harness([]);
        h.state.text = withDraft(EMPTY, 'Desktop draft', 'new:desktop:123');
        await h.engine.run(PATH, true);
        expect(h.remote.insert).not.toHaveBeenCalled();
        expect(h.state.text).toContain('Desktop draft <!-- gdn:new:desktop:123 -->');
        expect(h.engine.status(PATH, h.state.text).detail).toContain('Desktop draft');
    });
    it('does not claim a keyless task row that arrived from elsewhere (A-7)', async () => {
        const h = harness([]);
        h.state.text = EMPTY.replace('<!-- gdn:tasks -->\n', '<!-- gdn:tasks -->\n    - [ ] One intended task\n');
        await h.engine.run(PATH, true);
        expect(h.remote.insert).not.toHaveBeenCalled();
        expect(h.state.text).toContain('- [ ] One intended task\n');
    });
    it('recreates its own draft from the note when its pending creation was lost', async () => {
        const h = harness([]);
        h.state.text = withDraft(EMPTY, 'Phone draft', h.engine.draftKey());
        h.data.outbox = {};
        await h.engine.run(PATH, true);
        expect(h.items.filter(value => value.title === 'Phone draft')).toHaveLength(1);
        expect(h.state.text).not.toContain('gdn:new:');
    });
    it('creates the draft from its current text, including another device’s edit (1.4)', async () => {
        const h = harness([]);
        h.type(withDraft(EMPTY, 'Call'));
        h.state.text = h.state.text.replace('Call <!--', 'Call Sam <!--');
        await h.engine.run(PATH, true);
        expect(vi.mocked(h.remote.insert).mock.calls[0]![0].title).toBe('Call Sam');
    });
    it('uses the configured indent for a synced draft row', async () => {
        const h = harness([]);
        h.state.indent = '\t';
        h.type(withDraft(EMPTY, 'Call Sam'));
        await h.engine.run(PATH, true);
        expect(h.state.text).toContain(`\n\t- [ ] Call Sam <!-- gdn:${itemKey('task', 'list', 'created')} -->`);
    });
    it('does not create a draft while it is still being typed, then creates it', async () => {
        const h = harness([]);
        h.type(withDraft(EMPTY, 'Call'));
        await h.engine.run(PATH, false);
        expect(h.remote.insert).not.toHaveBeenCalled();
        await h.engine.run(PATH, true);
        expect(h.remote.insert).toHaveBeenCalledOnce();
    });
    it('names a missing default list instead of failing the sync', async () => {
        const h = harness([]);
        h.data.settings.defaultTaskList = '';
        h.type(withDraft(EMPTY, 'Call Sam'));
        expect((await h.engine.run(PATH, true)).state).not.toBe('error');
        expect(h.problems.map(problem => problem.id)).toContain('default-list');
    });
    it('keeps the marker until the Google ID is durably saved', async () => {
        const h = harness([]);
        h.type(withDraft(EMPTY, 'Call Sam'));
        vi.mocked(h.remote.removeCreationMarker).mockImplementation(async key => {
            expect(h.saved.data.created[key]?.id).toBe('created');
            expect(h.saved.data.outbox[key]).toBeUndefined();
        });
        await h.engine.run(PATH, true);
        expect(h.remote.removeCreationMarker).toHaveBeenCalledOnce();
        expect(h.saved.data.created['new:device:1']?.markerRemoved).toBe(true);
        await h.engine.run(PATH, true);
        expect(h.remote.removeCreationMarker).toHaveBeenCalledOnce();
    });
    it('keeps the token and sends nothing while saving fails', async () => {
        const h = harness([]);
        h.type(withDraft(EMPTY, 'Call Sam'));
        let failing = true;
        h.save.mockImplementation(() => {
            if (failing && Object.keys(h.data.created).length) return false;
            h.saved.data = structuredClone(h.data);
            return true;
        });
        expect((await h.engine.run(PATH, true)).state).toBe('error');
        expect(h.remote.removeCreationMarker).not.toHaveBeenCalled();
        expect(h.problems.map(problem => problem.id)).toContain('storage');
        failing = false;
        await h.engine.run(PATH, true);
        expect(h.remote.removeCreationMarker).toHaveBeenCalledOnce();
        expect(h.remote.insert).toHaveBeenCalledOnce();
    });
    it('cleans up markers left by older versions and retries after a failed cleanup', async () => {
        const h = harness();
        h.data.created['new:legacy'] = { source: 'list', id: 'task-1' };
        vi.mocked(h.remote.removeCreationMarker).mockRejectedValueOnce(new Error('Offline'));
        await h.engine.run(PATH, true);
        expect(h.data.created['new:legacy']?.markerRemoved).toBeUndefined();
        const restarted = h.restart();
        await restarted.run(PATH, true);
        expect(h.remote.removeCreationMarker).toHaveBeenLastCalledWith('new:legacy', 'list', 'task-1');
        expect(restarted.data.created['new:legacy']?.markerRemoved).toBe(true);
        expect(h.remote.insert).not.toHaveBeenCalled();
    });
    it('cancels an unsent draft instead of creating and then deleting it', async () => {
        const h = harness([]);
        h.type(withDraft(EMPTY, 'Call Sam'));
        vi.mocked(h.remote.insert).mockRejectedValueOnce(new GoogleError(503));
        await h.engine.run(PATH, true);
        h.state.now += UNCERTAIN_WAIT;
        h.remove('new:device:1');
        h.state.now += 5000;
        vi.mocked(h.remote.find).mockResolvedValueOnce([]);
        await h.engine.run(PATH, true);
        expect(h.remote.insert).toHaveBeenCalledOnce();
        expect(h.remote.remove).not.toHaveBeenCalled();
        expect(h.data.outbox).toEqual({});
    });
    it('cancels a never-sent draft locally when its row is deleted', async () => {
        const h = harness([]);
        h.type(withDraft(EMPTY, 'Call Sam'));
        await h.engine.run(PATH, false);
        h.remove('new:device:1');
        h.state.now += 5000;
        await h.engine.run(PATH, true);
        expect(h.remote.insert).not.toHaveBeenCalled();
        expect(h.data.outbox).toEqual({});
    });
    it('deletes a draft whose creation finished after dd without inserting twice', async () => {
        const h = harness([]);
        h.type(withDraft(EMPTY, 'Call Sam'));
        vi.mocked(h.remote.insert).mockImplementationOnce(async operation => {
            h.remove(operation.key);
            h.items.push(item({ id: 'created' }));
            return { id: 'created', source: 'list' };
        });
        await h.engine.run(PATH, true);
        expect(Object.values(h.data.outbox)[0]).toMatchObject({ remove: true, id: 'created' });
        expect(h.state.text).not.toContain('Buy coffee');
        h.state.now += 5000;
        await h.engine.run(PATH, true);
        expect(h.remote.insert).toHaveBeenCalledOnce();
        expect(h.remote.remove).toHaveBeenCalledWith(expect.objectContaining({ id: 'created', source: 'list', remove: true }));
        expect(h.data.outbox).toEqual({});
    });
    it('sends an edit made while the creation request ran (1.4)', async () => {
        const h = harness([]);
        h.type(withDraft(EMPTY, 'Call'));
        vi.mocked(h.remote.insert).mockImplementationOnce(async operation => {
            h.type(h.state.text.replace('Call <!--', 'Call Sam <!--'));
            h.items.push(item({ id: 'created', title: operation.title }));
            return { id: 'created', source: 'list' };
        });
        await h.engine.run(PATH, true);
        await h.engine.run(PATH, true);
        expect(h.remote.patch).toHaveBeenCalledWith(expect.objectContaining({ id: 'created', title: 'Call Sam' }));
        expect(h.items[0]!.title).toBe('Call Sam');
    });
});

describe('uncertain creations (2.3, D3)', () => {
    const uncertain = async (error: unknown = new Error('Network lost')) => {
        const h = harness([]);
        h.type(withDraft(EMPTY, 'Call Sam'));
        vi.mocked(h.remote.insert).mockRejectedValueOnce(error);
        await h.engine.run(PATH, true);
        return h;
    };
    it('saves the sending phase before the POST', async () => {
        const h = harness([]);
        h.type(withDraft(EMPTY, 'Call Sam'));
        vi.mocked(h.remote.insert).mockImplementationOnce(async operation => {
            expect(h.saved.data.outbox[operation.key]?.create).toMatchObject({ phase: 'sending', attempted: 100000 });
            throw new Error('Response lost');
        });
        expect((await h.engine.run(PATH, true)).state).toBe('error');
        expect(h.data.outbox['new:device:1']?.create).toMatchObject({ phase: 'uncertain', settled: 100000 });
    });
    it('waits two minutes, then searches, then sends again with the same key', async () => {
        const h = await uncertain();
        h.state.now += UNCERTAIN_WAIT - 1;
        expect((await h.engine.run(PATH, true)).text).toContain('Waiting');
        expect(h.remote.find).not.toHaveBeenCalled();
        h.state.now += 1;
        await h.engine.run(PATH, true);
        expect(h.remote.find).toHaveBeenCalledOnce();
        expect(h.remote.insert).toHaveBeenCalledTimes(2);
        expect(vi.mocked(h.remote.insert).mock.calls[1]![0]).toMatchObject({ key: 'new:device:1', create: { attempted: 100000 } });
        expect(h.state.text).toContain(`Call Sam <!-- gdn:${itemKey('task', 'list', 'created')}`);
    });
    it('links a task the search finds instead of sending again', async () => {
        const h = await uncertain();
        h.items.push(item({ id: 'landed', title: 'Call Sam' }));
        vi.mocked(h.remote.find).mockResolvedValueOnce([{ id: 'landed', notes: '[google-daily-notes:new:device:1]' }]);
        h.state.now += UNCERTAIN_WAIT;
        await h.engine.run(PATH, true);
        expect(h.remote.insert).toHaveBeenCalledOnce();
        expect(h.state.text).toContain(`gdn:${itemKey('task', 'list', 'landed')}`);
        expect(h.remote.removeCreationMarker).toHaveBeenCalledWith('new:device:1', 'list', 'landed');
    });
    it('links a deleted match and never sends again', async () => {
        const h = await uncertain();
        vi.mocked(h.remote.find).mockResolvedValueOnce([{ id: 'landed', deleted: true, notes: '[google-daily-notes:new:device:1]' }]);
        h.state.now += UNCERTAIN_WAIT;
        await h.engine.run(PATH, true);
        expect(h.remote.insert).toHaveBeenCalledOnce();
        expect(h.data.created['new:device:1']?.id).toBe('landed');
    });
    it('links one of several matches and removes the other markers', async () => {
        const h = await uncertain();
        h.items.push(item({ id: 'first', title: 'Call Sam' }), item({ id: 'second', title: 'Call Sam' }));
        vi.mocked(h.remote.find).mockResolvedValueOnce([{ id: 'first', notes: '[google-daily-notes:new:device:1]' }, { id: 'second', notes: '[google-daily-notes:new:device:1]' }]);
        h.state.now += UNCERTAIN_WAIT;
        await h.engine.run(PATH, true);
        expect(h.remote.removeCreationMarker).toHaveBeenCalledWith('new:device:1', 'list', 'first');
        expect(h.remote.removeCreationMarker).toHaveBeenCalledWith('new:device:1', 'list', 'second');
        // The residual duplicate shows up as an ordinary row that can be deleted.
        expect(rows(h.state.text)).toHaveLength(2);
    });
    it('never downgrades after a failed search', async () => {
        const h = await uncertain();
        h.state.now += UNCERTAIN_WAIT;
        vi.mocked(h.remote.find).mockRejectedValueOnce(new GoogleError(403, 'forbidden')).mockRejectedValueOnce(new GoogleError(503));
        await h.engine.run(PATH, true);
        await h.engine.run(PATH, true);
        expect(h.remote.insert).toHaveBeenCalledOnce();
        expect(h.data.outbox['new:device:1']?.create?.phase).toBe('uncertain');
    });
    it('never resends a cancelled uncertain creation and deletes a late match', async () => {
        const h = await uncertain();
        h.remove('new:device:1');
        h.state.now += UNCERTAIN_WAIT;
        h.items.push(item({ id: 'landed', title: 'Call Sam' }));
        vi.mocked(h.remote.find).mockResolvedValueOnce([{ id: 'landed', notes: '[google-daily-notes:new:device:1]' }]);
        await h.engine.run(PATH, true);
        await h.engine.run(PATH, true);
        expect(h.remote.insert).toHaveBeenCalledOnce();
        expect(h.remote.remove).toHaveBeenCalledWith(expect.objectContaining({ id: 'landed' }));
        expect(h.items).toEqual([]);
    });
    it('drops a cancelled creation that a search does not find', async () => {
        const h = await uncertain();
        h.remove('new:device:1');
        h.state.now += UNCERTAIN_WAIT;
        await h.engine.run(PATH, true);
        expect(h.remote.insert).toHaveBeenCalledOnce();
        expect(h.data.outbox).toEqual({});
    });
    it('starts the two minutes when the abandoned request settles (FP-10)', async () => {
        let settle!: (response: HttpResponse) => void;
        const late = new Promise<HttpResponse>(resolve => { settle = resolve; });
        const h = await uncertain(new RequestTimeout(late));
        expect(h.data.outbox['new:device:1']?.create).toMatchObject({ phase: 'uncertain', settled: undefined });
        h.state.now += 10 * UNCERTAIN_WAIT;
        await h.engine.run(PATH, true);
        expect(h.remote.find).not.toHaveBeenCalled();
        settle({ status: 503, json: {} });
        await Promise.resolve(); await Promise.resolve();
        expect(h.data.outbox['new:device:1']?.create?.settled).toBe(h.state.now);
        h.state.now += UNCERTAIN_WAIT;
        await h.engine.run(PATH, true);
        expect(h.remote.find).toHaveBeenCalledOnce();
    });
    it('links a late success of the abandoned request', async () => {
        let settle!: (response: HttpResponse) => void;
        const late = new Promise<HttpResponse>(resolve => { settle = resolve; });
        const h = await uncertain(new RequestTimeout(late));
        h.items.push(item({ id: 'late', title: 'Call Sam' }));
        settle({ status: 200, json: { id: 'late' } });
        await Promise.resolve(); await Promise.resolve();
        await h.engine.run(PATH, true);
        expect(h.remote.insert).toHaveBeenCalledOnce();
        expect(h.state.text).toContain(`gdn:${itemKey('task', 'list', 'late')}`);
    });
    it('AR-1: links a task committed before the recovery search', async () => {
        const h = await uncertain();
        // The first POST lands before the search runs.
        h.items.push(item({ id: 'first-post', title: 'Call Sam', marker: 'new:device:1' }));
        vi.mocked(h.remote.find).mockResolvedValueOnce([{ id: 'first-post', notes: '[google-daily-notes:new:device:1]' }]);
        h.state.now += UNCERTAIN_WAIT;
        await h.engine.run(PATH, true);
        expect(h.remote.insert).toHaveBeenCalledOnce();
        expect(h.items.filter(value => value.title === 'Call Sam')).toHaveLength(1);
    });
    it('AR-1: a task committed after the resend is the documented residual duplicate', async () => {
        const h = await uncertain();
        h.state.now += UNCERTAIN_WAIT;
        await h.engine.run(PATH, true);
        // The first POST commits only now; the resend already succeeded.
        h.items.push(item({ id: 'first-post', title: 'Call Sam' }));
        await h.engine.run(PATH, true);
        expect(h.remote.insert).toHaveBeenCalledTimes(2);
        expect(rows(h.state.text).filter(line => line.includes('Call Sam'))).toHaveLength(2);
    });
    it('keeps the in-flight intent across a restart as uncertain, not resent at once', async () => {
        const h = await uncertain();
        const restarted = h.restart();
        await restarted.run(PATH, true);
        expect(h.remote.insert).toHaveBeenCalledOnce();
        expect(restarted.data.outbox['new:device:1']?.create?.phase).toBe('uncertain');
    });
});

describe('per-operation outcomes (2.1, D2)', () => {
    it('drops a refused edit, names the typed value and keeps pulling', async () => {
        const h = harness([event(), item()]);
        h.type(h.state.text.replace('Weekly review', 'Calendar rename').replace('Buy coffee', 'Task rename'));
        vi.mocked(h.remote.patch).mockRejectedValueOnce(new GoogleError(403, 'forbidden'));
        const status = await h.engine.run(PATH, true);
        expect(status.state).toBe('ok');
        expect(h.remote.patch).toHaveBeenCalledTimes(2);
        expect(h.items[1]!.title).toBe('Task rename');
        expect(h.data.outbox).toEqual({});
        expect(h.problems[0]!.message).toContain('Calendar rename');
        expect(h.state.text).toContain('Weekly review');
        expect(h.remote.load).toHaveBeenCalledOnce();
    });
    it('keeps a newer edit when an older one is refused (AP-6)', async () => {
        const h = harness();
        h.type(h.state.text.replace('Buy coffee', 'A'.repeat(1100)));
        vi.mocked(h.remote.patch).mockImplementationOnce(async () => {
            h.type(h.state.text.replace('- [ ] AAA', '- [x] AAA'));
            throw new GoogleError(400, 'invalid');
        });
        await h.engine.run(PATH, true);
        await h.engine.run(PATH, true);
        expect(vi.mocked(h.remote.patch).mock.calls[1]![0]).toMatchObject({ done: true });
        expect(vi.mocked(h.remote.patch).mock.calls[1]![0].title).toBeUndefined();
        expect(h.items[0]).toMatchObject({ title: 'Buy coffee', done: true });
    });
    it('returns a creation Google rate-limited to prepared and sends it again later', async () => {
        const h = harness([]);
        h.type(withDraft(EMPTY, 'Call Sam'));
        vi.mocked(h.remote.insert).mockRejectedValueOnce(new GoogleError(429));
        expect((await h.engine.run(PATH, true)).state).toBe('error');
        expect(h.data.outbox['new:device:1']?.create?.phase).toBe('prepared');
        await h.engine.run(PATH, true);
        expect(h.remote.insert).toHaveBeenCalledTimes(2);
        expect(h.remote.find).not.toHaveBeenCalled();
    });
    it('keeps a refused new task as a local row until it is edited', async () => {
        const h = harness([]);
        h.type(withDraft(EMPTY, 'Call Sam'));
        vi.mocked(h.remote.insert).mockRejectedValueOnce(new GoogleError(404, 'notFound'));
        await h.engine.run(PATH, true);
        expect(h.data.outbox['new:device:1']?.create?.phase).toBe('refused');
        expect(h.problems[0]!.message).toContain('Call Sam');
        await h.engine.run(PATH, true);
        expect(h.remote.insert).toHaveBeenCalledOnce();
        expect(h.state.text).toContain('Call Sam <!-- gdn:new:device:1 -->');
        h.type(h.state.text.replace('Call Sam <!--', 'Call Sam today <!--'));
        await h.engine.run(PATH, true);
        expect(h.remote.insert).toHaveBeenCalledTimes(2);
    });
    it('restores a row whose deletion Google refused, without an undo record', async () => {
        const h = harness();
        h.remove(item().key);
        h.state.now += 5000;
        vi.mocked(h.remote.remove).mockRejectedValueOnce(new GoogleError(400, 'recurringSeries', undefined, 'Only one occurrence of a recurring event can be deleted from a note.'));
        await h.engine.run(PATH, true);
        expect(h.state.text).toContain('Buy coffee');
        expect(h.data.deletedTasks).toEqual({});
        expect(h.data.outbox).toEqual({});
    });
    it.each([
        ['account', new GoogleError(403, 'accessNotConfigured')],
        ['quota', new GoogleError(429)],
        ['transient', new GoogleError(503)],
        ['network', new Error('Offline')],
    ])('keeps work queued and stops sending after a %s failure', async (_name, error) => {
        const h = harness([item(), item({ id: 'other', title: 'Other' })]);
        h.type(h.state.text.replace('Buy coffee', 'Buy tea').replace('Other', 'Changed'));
        vi.mocked(h.remote.patch).mockRejectedValueOnce(error);
        const status = await h.engine.run(PATH, true);
        expect(status.state).toBe('error');
        expect(h.remote.patch).toHaveBeenCalledOnce();
        expect(Object.keys(h.data.outbox)).toHaveLength(2);
        await h.engine.run(PATH, true);
        expect(h.data.outbox).toEqual({});
    });
    it('lets a remote deletion win without recreating the item', async () => {
        const h = harness();
        h.type(h.state.text.replace('Buy coffee', 'Buy tea'));
        vi.mocked(h.remote.patch).mockRejectedValueOnce(new GoogleError(404));
        h.remote.load.mockResolvedValueOnce({ items: [], failed: [] });
        await h.engine.run(PATH, true);
        expect(h.state.text).not.toContain('Buy tea');
        expect(h.remote.insert).not.toHaveBeenCalled();
        expect(h.data.outbox).toEqual({});
    });
    it('keeps the rows of a source that cannot be read (2.2)', async () => {
        const h = harness([event(), item()]);
        h.state.failed = [{ kind: 'event', source: 'calendar', name: 'Team', message: 'Google refused the request (404).' }];
        h.remote.load.mockResolvedValueOnce({ items: [item()], failed: h.state.failed });
        await h.engine.run(PATH, true);
        expect(h.state.text).toContain('Weekly review');
        expect(h.problems[0]!.message).toContain('Team');
    });
    it('drains pending work for a note that is closed, disabled or gone (2.4)', async () => {
        const h = harness();
        h.type(h.state.text.replace('Buy coffee', 'Buy tea'));
        await h.engine.run(PATH, false, false);
        vi.mocked(h.remote.patch).mockClear();
        h.type(h.state.text.replace('Buy tea', 'Buy milk'));
        h.engine.data.outbox[item().key] = { key: item().key, kind: 'task', source: 'list', id: 'task-1', path: 'Deleted note.md', title: 'Buy milk' };
        await h.engine.run('Deleted note.md', true);
        expect(h.remote.patch).toHaveBeenCalledWith(expect.objectContaining({ title: 'Buy milk' }));
    });
});

describe('deletion and undo', () => {
    it.each(['event', 'task'] as const)('syncs an explicit %s deletion without recreating it', async kind => {
        const target = kind === 'event' ? event() : item();
        const h = harness([target, item({ id: 'keep', title: 'Keep this' })]);
        h.remove(target.key);
        h.state.now += 5000;
        await h.engine.run(PATH, true);
        expect(h.remote.remove).toHaveBeenCalledWith(expect.objectContaining({ kind, source: target.source, id: target.id, remove: true }));
        expect(h.state.text).not.toContain(target.title);
        expect(h.state.text).toContain('Keep this');
        await h.engine.run(PATH, true);
        expect(h.remote.remove).toHaveBeenCalledOnce();
        expect(h.remote.insert).not.toHaveBeenCalled();
    });
    it('deletes a task row another device rendered before this one did', async () => {
        const h = harness([]);
        h.items.push(item({ id: 'phone' }));
        h.state.text = seeded([item({ id: 'phone' })]).text;
        h.remove(itemKey('task', 'list', 'phone'));
        h.state.now += 5000;
        await h.engine.run(PATH, true);
        expect(h.remote.remove).toHaveBeenCalledWith(expect.objectContaining({ id: 'phone' }));
    });
    it('persists a failed deletion and retries it after restart', async () => {
        const h = harness();
        h.remove(item().key);
        h.state.now += 5000;
        vi.mocked(h.remote.remove).mockRejectedValueOnce(new Error('Offline'));
        await h.engine.run(PATH, true);
        expect(h.saved.data.outbox[item().key]?.remove).toBe(true);
        const restarted = h.restart();
        await restarted.run(PATH, true);
        expect(h.remote.remove).toHaveBeenCalledTimes(2);
        expect(restarted.data.outbox).toEqual({});
        expect(h.state.text).not.toContain('Buy coffee');
    });
    it.each(['event', 'task'] as const)('hides a deleted %s during refresh and sends it at five seconds', async kind => {
        const target = kind === 'event' ? event() : item();
        const h = harness([target]);
        h.remove(target.key);
        expect((await h.engine.run(PATH, true)).text).toBe('Deletion pending');
        h.state.now += 4999;
        await h.engine.run(PATH, true);
        expect(h.remote.remove).not.toHaveBeenCalled();
        expect(h.state.text).not.toContain(target.key);
        expect(h.data.notes[PATH]!.rows[target.key]).toEqual(target);
        expect(h.data.outbox[target.key]?.removeAfter).toBe(h.state.now + 1);
        h.state.now++;
        expect(Object.keys(h.data.deletedTasks)).toEqual(kind === 'task' ? [target.key] : []);
        const lost = h.engine.restoreDeletions(PATH, [target.key]);
        expect(lost).toEqual(kind === 'event' ? [target.key] : []);
        expect((await h.engine.run(PATH, true)).text).toBe('Up to date');
        expect(h.remote.remove).toHaveBeenCalledOnce();
        expect(h.data.notes[PATH]!.rows[target.key]).toBeUndefined();
    });
    it('cancels deletion at 4999 ms and gives redo a fresh five seconds', async () => {
        const h = harness();
        const original = h.state.text;
        h.remove(item().key);
        const deleted = h.state.text;
        await h.engine.run(PATH, true);
        h.state.now += 4999;
        h.state.text = original;
        h.engine.restoreDeletions(PATH, [item().key]);
        await h.engine.run(PATH, true);
        h.state.now += 10000;
        await h.engine.run(PATH, true);
        expect(h.remote.remove).not.toHaveBeenCalled();
        expect(h.data.outbox).toEqual({});
        expect(h.state.text).toContain('Buy coffee');
        h.state.text = deleted;
        h.engine.queueDeletions(PATH, [{ key: item().key }]);
        h.state.now += 4999;
        await h.engine.run(PATH, true);
        expect(h.remote.remove).not.toHaveBeenCalled();
        h.state.now++;
        await h.engine.run(PATH, true);
        expect(h.remote.remove).toHaveBeenCalledOnce();
    });
    it('retains the remaining grace period across a restart', async () => {
        const h = harness();
        h.remove(item().key);
        h.state.now += 3000;
        const restarted = h.restart();
        await restarted.run(PATH, true);
        expect(h.remote.remove).not.toHaveBeenCalled();
        expect(h.state.text).not.toContain('Buy coffee');
        h.state.now += 2000;
        await restarted.run(PATH, true);
        expect(h.remote.remove).toHaveBeenCalledOnce();
    });
    it('keeps an undo made while disconnected after a restart (A-4)', async () => {
        const h = harness([event()]);
        const original = h.state.text;
        h.remove(event().key);
        h.state.now += 1000;
        h.state.text = original;
        h.engine.restoreDeletions(PATH, [event().key]);
        h.state.now += 10000;
        await h.restart().run(PATH, true);
        expect(h.remote.remove).not.toHaveBeenCalled();
        expect(h.state.text).toContain('Weekly review');
    });
    it('preserves offline title and status edits when undoing deletion', async () => {
        const h = harness();
        h.type(h.state.text.replace('- [ ] Buy coffee', '- [x] Buy tea'));
        vi.mocked(h.remote.patch).mockRejectedValueOnce(new Error('Offline'));
        await h.engine.run(PATH, true);
        const edited = h.state.text;
        h.remove(item().key);
        h.state.text = edited;
        h.engine.restoreDeletions(PATH, [item().key]);
        expect(h.data.outbox[item().key]).toMatchObject({ title: 'Buy tea', done: true });
        await h.engine.run(PATH, true);
        expect(h.remote.remove).not.toHaveBeenCalled();
        expect(h.items[0]).toMatchObject({ title: 'Buy tea', done: true });
    });
    it('recreates a late-undone task once with its list, date, title and status, under a portable key (1.6)', async () => {
        const original = item({ source: 'another-list', date: '2026-09-17', done: true, title: '📅 13:00 Buy tea' });
        const h = harness([original]);
        const text = h.state.text;
        h.remove(original.key);
        h.state.now += 5000;
        await h.engine.run(PATH, true);
        h.state.text = text;
        h.engine.restoreDeletions(PATH, [original.key]);
        await h.engine.run(PATH, false);
        const replacement = itemKey('task', 'another-list', 'created');
        expect(h.remote.insert).toHaveBeenCalledOnce();
        expect(vi.mocked(h.remote.insert).mock.calls[0]![0]).toMatchObject({
            title: original.title, done: true, source: 'another-list', create: { date: '2026-09-17' },
        });
        expect(h.state.text).toContain(`Buy tea <!-- gdn:${replacement} -->`);
        expect(h.data.aliases[original.key]).toBe(replacement);
        expect(h.remote.load).toHaveBeenLastCalledWith(DATE, h.data.settings, [replacement], h.data.calendars);
        await h.engine.run(PATH, true);
        expect(h.remote.insert).toHaveBeenCalledOnce();
    });
    it('sends another device’s edit on the replaced row to the new task (A-5)', async () => {
        const h = harness();
        const text = h.state.text;
        h.remove(item().key);
        h.state.now += 5000;
        await h.engine.run(PATH, true);
        h.state.text = text;
        h.engine.restoreDeletions(PATH, [item().key]);
        await h.engine.run(PATH, true);
        // Device B receives the rewritten row and edits its title.
        const phone = harness([], seeded([]).data, h.state.text);
        phone.items.push(...h.items);
        phone.type(phone.state.text.replace('Buy coffee', 'Buy beans'));
        await phone.engine.run(PATH, true);
        expect(phone.remote.patch).toHaveBeenCalledWith(expect.objectContaining({ id: 'created', title: 'Buy beans' }));
    });
    it('does not recreate a deleted task from stale text without an explicit undo', async () => {
        const h = harness();
        const text = h.state.text;
        h.remove(item().key);
        h.state.now += 5000;
        await h.engine.run(PATH, true);
        h.state.text = text;
        await h.engine.run(PATH, true);
        expect(h.remote.insert).not.toHaveBeenCalled();
        expect(h.state.text).not.toContain('Buy coffee');
    });
    it('waits for an offline deletion before creating its replacement, including after restart', async () => {
        const h = harness();
        const text = h.state.text;
        h.remove(item().key);
        h.state.now += 5000;
        vi.mocked(h.remote.remove).mockRejectedValueOnce(new Error('Offline')).mockRejectedValueOnce(new Error('Offline'));
        await h.engine.run(PATH, true);
        h.state.text = text;
        h.engine.restoreDeletions(PATH, [item().key]);
        await h.engine.run(PATH, false);
        expect(h.remote.insert).not.toHaveBeenCalled();
        expect(h.state.text).toContain(`Buy coffee <!-- gdn:${item().key}`);
        const restarted = h.restart();
        await restarted.run(PATH, true);
        expect(h.remote.remove).toHaveBeenCalledTimes(3);
        expect(h.remote.insert).toHaveBeenCalledOnce();
        expect(h.items).toHaveLength(1);
        expect(h.items[0]!.id).toBe('created');
        expect(restarted.data.outbox).toEqual({});
    });
    it('handles undo while the delete request is in flight', async () => {
        const h = harness();
        const text = h.state.text;
        h.remove(item().key);
        h.state.now += 5000;
        vi.mocked(h.remote.remove).mockImplementationOnce(async () => {
            h.state.text = text;
            h.engine.restoreDeletions(PATH, [item().key]);
            h.items.splice(0);
        });
        await h.engine.run(PATH, true);
        await h.engine.run(PATH, true);
        expect(h.remote.insert).toHaveBeenCalledOnce();
        expect(h.items).toHaveLength(1);
        expect(h.state.text).toContain(itemKey('task', 'list', 'created'));
    });
    it('keeps the replacement key across an uncertain creation instead of inserting again', async () => {
        const h = harness();
        const text = h.state.text;
        h.remove(item().key);
        h.state.now += 5000;
        await h.engine.run(PATH, true);
        h.state.text = text;
        h.engine.restoreDeletions(PATH, [item().key]);
        vi.mocked(h.remote.insert).mockRejectedValueOnce(new Error('Response lost'));
        await h.engine.run(PATH, false);
        const pending = Object.values(h.data.outbox)[0]!;
        expect(pending.create?.phase).toBe('uncertain');
        await h.engine.run(PATH, true);
        expect(Object.keys(h.data.outbox)).toEqual([pending.key]);
        expect(h.remote.insert).toHaveBeenCalledOnce();
        expect(h.state.text).toContain(item().key);
    });
    it('deletes and restores the current identity on repeated redo and undo', async () => {
        const h = harness();
        const original = h.state.text;
        h.remove(item().key);
        h.state.now += 5000;
        await h.engine.run(PATH, true);
        h.state.text = original;
        h.engine.restoreDeletions(PATH, [item().key]);
        await h.engine.run(PATH, true);
        const first = itemKey('task', 'list', 'created');
        const recreated = h.state.text;
        h.remove(first);
        h.state.now += 5000;
        await h.engine.run(PATH, true);
        h.state.text = recreated;
        h.engine.restoreDeletions(PATH, [first]);
        await h.engine.run(PATH, true);
        expect(h.remote.insert).toHaveBeenCalledTimes(2);
        expect(h.remote.remove).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'created' }));
        expect(h.state.text).toContain(itemKey('task', 'list', 'created-2'));
        expect(h.items).toHaveLength(1);
    });
    it('reaches the current record through an alias the history still holds', async () => {
        const h = harness();
        const original = h.state.text;
        h.remove(item().key);
        h.state.now += 5000;
        await h.engine.run(PATH, true);
        h.state.text = original;
        h.engine.restoreDeletions(PATH, [item().key]);
        await h.engine.run(PATH, true);
        const first = itemKey('task', 'list', 'created');
        h.remove(first);
        h.state.now += 1000;
        h.engine.restoreDeletions(PATH, [item().key]);
        expect(h.data.outbox[first]).toBeUndefined();
    });
    it('cancels a late undo redone before the replacement is staged', async () => {
        const h = harness();
        h.remove(item().key);
        h.state.now += 5000;
        await h.engine.run(PATH, true);
        h.engine.restoreDeletions(PATH, [item().key]);
        h.engine.queueDeletions(PATH, [{ key: item().key }]);
        await h.engine.run(PATH, true);
        expect(h.remote.insert).not.toHaveBeenCalled();
        expect(h.data.outbox).toEqual({});
    });
    it('does not send a cancelled deletion captured before another request finished', async () => {
        const h = harness([item(), event()]);
        h.type(h.state.text.replace('Buy coffee', 'Buy tea'));
        vi.mocked(h.remote.patch).mockRejectedValueOnce(new Error('Offline'));
        await h.engine.run(PATH, true);
        h.engine.queueDeletions(PATH, [{ key: event().key }]);
        vi.mocked(h.remote.patch).mockImplementationOnce(async () => {
            h.state.now += 4999;
            h.engine.restoreDeletions(PATH, [event().key]);
            h.state.now += 100;
        });
        await h.engine.flush();
        expect(h.remote.remove).not.toHaveBeenCalled();
        expect(h.data.outbox).toEqual({});
    });
    it('does not lose a deletion queued while a title update is in flight', async () => {
        const h = harness();
        h.type(h.state.text.replace('Buy coffee', 'Buy tea'));
        vi.mocked(h.remote.patch).mockImplementationOnce(async () => { h.remove(item().key); });
        await h.engine.run(PATH, true);
        expect(h.data.outbox[item().key]?.remove).toBe(true);
        h.state.now += 5000;
        await h.engine.run(PATH, true);
        expect(h.remote.remove).toHaveBeenCalledOnce();
    });
    it('sends no title or checkbox edit while saving fails, and keeps what was saved (AP-1)', async () => {
        const h = harness([item(), item({ id: 'other', title: 'Other' })]);
        h.type(h.state.text.replace('Buy coffee', 'Saved title'));
        h.save.mockImplementation(() => false);
        h.type(h.state.text.replace('- [ ] Other', '- [x] Other'));
        await h.engine.run(PATH, true);
        expect(h.remote.patch).not.toHaveBeenCalled();
        const restarted = h.restart();
        expect(restarted.data.edits).toEqual({ [item().key]: { path: PATH, title: 'Saved title' } });
        h.save.mockImplementation(() => { h.saved.data = structuredClone(h.data); return true; });
        await h.engine.run(PATH, true);
        expect(h.items.map(value => [value.title, value.done])).toEqual([['Saved title', false], ['Other', true]]);
    });
    it('sends nothing while saving fails, and an undone deletion only runs after a restart (AP-1)', async () => {
        const h = harness();
        const original = h.state.text;
        h.remove(item().key);
        h.save.mockImplementation(() => false);
        h.state.text = original;
        h.engine.restoreDeletions(PATH, [item().key]);
        h.state.now += 5000;
        await h.engine.run(PATH, true);
        expect(h.remote.remove).not.toHaveBeenCalled();
        expect(h.problems.find(problem => problem.id === 'storage')!.message).toContain('may still run after a restart');
        // After a restart the last saved journal still holds the deletion.
        h.save.mockImplementation(() => true);
        const restarted = h.restart();
        expect(restarted.data.outbox[item().key]?.remove).toBe(true);
    });
});

describe('two devices', () => {
    it('relinks a foreign draft by marker and sends the edit made here, never POSTing (P2)', async () => {
        const phone = harness([]);
        phone.state.text = withDraft(EMPTY, 'Call', 'new:desktop:7');
        phone.type(phone.state.text.replace('Call <!--', 'Call Sam <!--'));
        phone.items.push(item({ id: 'desktop-task', title: 'Call', marker: 'new:desktop:7' }));
        await phone.engine.run(PATH, true);
        expect(phone.remote.insert).not.toHaveBeenCalled();
        expect(phone.state.text).toContain(`Call <!-- gdn:${itemKey('task', 'list', 'desktop-task')}`);
        await phone.engine.run(PATH, true);
        expect(phone.remote.patch).toHaveBeenCalledWith(expect.objectContaining({ id: 'desktop-task', title: 'Call Sam' }));
        expect(rows(phone.state.text)).toHaveLength(1);
    });
    it('shows a stale draft seen after its marker was removed until Sync delivers the rewrite', async () => {
        const phone = harness([]);
        phone.state.text = withDraft(EMPTY, 'Call Sam', 'new:desktop:7');
        phone.items.push(item({ id: 'desktop-task', title: 'Call Sam' }));
        await phone.engine.run(PATH, true);
        expect(phone.remote.insert).not.toHaveBeenCalled();
        expect(rows(phone.state.text)).toHaveLength(2);
        // Sync delivers the desktop's rewritten row.
        phone.state.text = phone.state.text.replace('gdn:new:desktop:7', `gdn:${itemKey('task', 'list', 'desktop-task')}`);
        await phone.engine.run(PATH, true);
        expect(rows(phone.state.text)).toHaveLength(1);
        expect(phone.remote.insert).not.toHaveBeenCalled();
    });
    it('creates a simultaneous draft only once, by its owner', async () => {
        const desktop = harness([]);
        desktop.type(withDraft(EMPTY, 'One intended task', 'new:device:1'));
        const phone = harness([], { ...seeded([]).data, runtimeOwner: 'phone' }, desktop.state.text);
        await phone.engine.run(PATH, true);
        await desktop.engine.run(PATH, true);
        expect(phone.remote.insert).not.toHaveBeenCalled();
        expect(desktop.remote.insert).toHaveBeenCalledOnce();
    });
});

describe('pruning device state (4.8)', () => {
    const DAY = 24 * 3600000;
    const late = async () => {
        const h = harness();
        const text = h.state.text;
        h.remove(item().key);
        h.state.now += 5000;
        await h.engine.run(PATH, true);
        h.state.text = text;
        h.engine.restoreDeletions(PATH, [item().key]);
        await h.engine.run(PATH, true);
        return h;
    };
    it('keeps undo records across a plugin reload and drops them after an app restart', async () => {
        const h = await late();
        h.engine.prune(false, () => true);
        expect(h.data.deletedTasks[item().key]).toBeDefined();
        expect(h.data.aliases[item().key]).toBeDefined();
        // Native undo after the reload still reaches the replacement.
        h.remove(itemKey('task', 'list', 'created'));
        h.state.now += 1000;
        h.engine.restoreDeletions(PATH, [item().key]);
        expect(h.data.outbox).toEqual({});
        h.engine.prune(true, () => true);
        expect(h.data.deletedTasks).toEqual({});
        expect(h.data.aliases).toEqual({});
    });
    it('keeps a restoration that was interrupted before its creation was queued', () => {
        const h = harness();
        h.data.deletedTasks[item().key] = { path: PATH, item: item(), deletionKey: item().key, deleted: false, restoredKey: 'new:device:x' };
        h.engine.prune(true, () => true);
        expect(h.data.deletedTasks[item().key]).toBeDefined();
    });
    it('drops snapshots of notes left alone for 14 days and rebuilds them on reopening, pushing an offline edit', async () => {
        const h = harness();
        h.data.notes[PATH]!.synced = h.state.now;
        h.state.now += 15 * DAY;
        h.engine.prune(false, () => true);
        expect(h.data.notes[PATH]).toBeUndefined();
        h.type(h.state.text.replace('Buy coffee', 'Buy tea'));
        vi.mocked(h.remote.patch).mockRejectedValueOnce(new Error('Offline'));
        await h.engine.run(PATH, true);
        await h.engine.run(PATH, true);
        expect(h.items[0]!.title).toBe('Buy tea');
    });
    it('keeps a snapshot something pending refers to, and drops one of a deleted note', () => {
        const h = harness();
        h.data.notes['Gone.md'] = { rows: {}, synced: h.state.now };
        h.data.edits.x = { path: PATH, title: 'Pending' };
        h.state.now += 15 * DAY;
        h.engine.prune(false, path => path !== 'Gone.md');
        expect(h.data.notes[PATH]).toBeDefined();
        expect(h.data.notes['Gone.md']).toBeUndefined();
    });
    it('drops a created ID 14 days after its marker, and never creates a stale copy of that draft again', async () => {
        const h = harness([]);
        const key = h.engine.draftKey();
        h.type(withDraft(EMPTY, 'Call Sam', key));
        const stale = h.state.text;
        await h.engine.run(PATH, true);
        h.state.now += 15 * DAY;
        h.engine.prune(false, () => true);
        expect(h.data.created).toEqual({});
        // A stale copy of the note arrives with the draft row.
        h.state.text = stale;
        await h.engine.run(PATH, true);
        expect(h.remote.insert).toHaveBeenCalledOnce();
    });
});
