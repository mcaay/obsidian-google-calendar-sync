import { describe, expect, it, vi } from 'vitest';
import { SyncEngine } from '../src/sync';
import { GoogleError } from '../src/http';
import { itemKey } from '../src/markdown';
import type { Item, Remote } from '../src/types';
import { DATE, EMPTY, PATH, event, item, seeded } from './fixtures';

function harness(items: Item[] = [item()]) {
    const seed = seeded(items);
    const state = { text: seed.text, indent: '    ', now: 100000 };
    const remote: Remote = {
        load: vi.fn(async () => structuredClone(items)),
        patch: vi.fn(async operation => {
            const target = items.find(value => value.key === operation.key);
            if (target) {
                if (operation.title !== undefined) target.title = operation.title;
                if (operation.done !== undefined) target.done = operation.done;
            }
        }),
        create: vi.fn(async (operation, beforeInsert) => {
            if (await beforeInsert() === false) return undefined;
            items.push(item({ id: 'created', title: operation.title, done: operation.done }));
            return { id: 'created', source: 'list' };
        }),
        removeCreationMarker: vi.fn(async () => undefined),
        remove: vi.fn(async operation => {
            const index = items.findIndex(value => value.kind === operation.kind && value.source === operation.source && value.id === operation.id);
            if (index >= 0) items.splice(index, 1);
        }),
    };
    const save = vi.fn(async () => undefined);
    const engine = new SyncEngine(seed.data, remote, {
        read: async () => state.text,
        indent: () => state.indent,
        write: async (_path, before, after) => { if (state.text !== before) return false; state.text = after; return true; },
    }, save, () => state.now);
    return { ...seed, state, remote, save, engine, items };
}

describe('synchronization', () => {
    it('follows indentation changes on the next sync without sending Google edits', async () => {
        const h = harness([event(), item()]);
        for (const indent of ['\t', '  ', '        ']) {
            h.state.indent = indent;
            await h.engine.run(PATH, true);
            const rows = h.state.text.split('\n').filter(line => /<!-- gdn:[A-Za-z0-9_-]{10,} -->$/.test(line));
            expect(rows).toHaveLength(2);
            expect(rows.every(line => line.startsWith(indent + '- [ ] '))).toBe(true);
        }
        expect(h.remote.patch).not.toHaveBeenCalled();
        expect(h.remote.create).not.toHaveBeenCalled();
    });
    it('uses the configured indent for an offline task draft and its synced row', async () => {
        const h = harness([]);
        h.state.indent = '\t';
        h.state.text = EMPTY.replace('<!-- gdn:tasks -->\n', '<!-- gdn:tasks -->\n    - [ ] Call Sam\n');
        vi.mocked(h.remote.create).mockRejectedValueOnce(new Error('Offline'));
        await expect(h.engine.run(PATH, true)).rejects.toThrow('Offline');
        expect(h.state.text).toContain('\n\t- [ ] Call Sam <!-- gdn:new:');
        await h.engine.run(PATH, true);
        expect(h.state.text).toContain(`\n\t- [ ] Call Sam <!-- gdn:${itemKey('task', 'list', 'created')} -->`);
    });
    it('does not push unchanged stale note content over remote changes', async () => {
        const h = harness(); h.items[0]!.title = 'Changed in Google';
        await h.engine.run(PATH, true);
        expect(h.remote.patch).not.toHaveBeenCalled();
        expect(h.state.text).toContain('Changed in Google');
    });
    it('pushes just the edited title and preserves a remote status change', async () => {
        const h = harness(); h.state.text = h.state.text.replace('Buy coffee', 'Buy tea'); h.items[0]!.done = true;
        await h.engine.run(PATH, true);
        expect(h.remote.patch).toHaveBeenCalledWith(expect.objectContaining({ title: 'Buy tea' }));
        expect(vi.mocked(h.remote.patch).mock.calls[0]![0].done).toBeUndefined();
        expect(h.state.text).toContain('- [x] Buy tea');
    });
    it('pushes a toggle immediately but keeps an unfinished title edit local', async () => {
        const h = harness(); h.state.text = h.state.text.replace('- [ ] Buy coffee', '- [x] Buy coff');
        await h.engine.run(PATH, false);
        expect(vi.mocked(h.remote.patch).mock.calls[0]![0]).toMatchObject({ done: true });
        expect(vi.mocked(h.remote.patch).mock.calls[0]![0].title).toBeUndefined();
        expect(h.state.text).toContain('Buy coff <!--');
        await h.engine.run(PATH, true);
        expect(h.items[0]!.title).toBe('Buy coff');
    });
    it('keeps failed edits in a durable outbox and retries', async () => {
        const h = harness(); h.state.text = h.state.text.replace('Buy coffee', 'Buy tea');
        vi.mocked(h.remote.patch).mockRejectedValueOnce(new Error('Offline'));
        await expect(h.engine.run(PATH, true)).rejects.toThrow('Offline');
        expect(Object.values(h.data.outbox)[0]?.title).toBe('Buy tea');
        expect(h.save).toHaveBeenCalled();
        await h.engine.run(PATH, true);
        expect(h.data.outbox).toEqual({});
        expect(h.state.text).toContain('Buy tea');
    });
    it('leaves user text untouched if it changes during a fetch', async () => {
        const h = harness();
        vi.mocked(h.remote.load).mockImplementationOnce(async () => { h.state.text += '\nFresh user text'; return [item({ title: 'Remote title' })]; });
        await h.engine.run(PATH, true);
        expect(h.state.text).toContain('Fresh user text');
        expect(h.state.text).toContain('Buy coffee');
    });
    it('creates a dated task once and binds its identity', async () => {
        const h = harness([]); h.state.text = EMPTY.replace('<!-- gdn:tasks -->\n', '<!-- gdn:tasks -->\n    - [ ] Call Sam\n');
        await h.engine.run(PATH, true);
        expect(h.remote.create).toHaveBeenCalledTimes(1);
        expect(vi.mocked(h.remote.create).mock.calls[0]![0].create?.date).toBe(DATE);
        expect(h.state.text).toContain(`gdn:${itemKey('task', 'list', 'created')}`);
        expect(h.state.text).not.toContain('gdn:new:');
        await h.engine.run(PATH, true);
        expect(h.remote.create).toHaveBeenCalledTimes(1);
    });
    it('persists an in-flight creation before sending it', async () => {
        const h = harness([]); h.state.text = EMPTY.replace('<!-- gdn:tasks -->\n', '<!-- gdn:tasks -->\n    - [ ] Call Sam\n');
        vi.mocked(h.remote.create).mockImplementationOnce(async (operation, beforeInsert) => {
            await beforeInsert();
            expect(h.data.outbox[operation.key]?.create?.phase).toBe('sent');
            expect(h.state.text).toContain(operation.key);
            throw new Error('Response lost');
        });
        await expect(h.engine.run(PATH, true)).rejects.toThrow('Response lost');
        const pending = Object.values(h.data.outbox)[0]!;
        expect(pending.create?.phase).toBe('sent');
        vi.mocked(h.remote.create).mockResolvedValueOnce(undefined);
        expect(await h.engine.run(PATH, true)).toContain('Waiting');
        expect(h.state.text).toContain('Call Sam');
        expect(Object.keys(h.data.outbox)).toHaveLength(1);
        expect(h.remote.removeCreationMarker).not.toHaveBeenCalled();
    });
    it('removes the token only after its Google ID is durably saved', async () => {
        const h = harness([]);
        h.state.text = EMPTY.replace('<!-- gdn:tasks -->\n', '<!-- gdn:tasks -->\n    - [ ] Call Sam\n');
        let saved = structuredClone(h.data);
        h.save.mockImplementation(async () => { saved = structuredClone(h.data); });
        vi.mocked(h.remote.removeCreationMarker).mockImplementation(async (key, source, id) => {
            expect(saved.created[key]).toEqual({ source, id });
            expect(saved.outbox[key]).toBeUndefined();
        });
        await h.engine.run(PATH, true);
        expect(h.remote.removeCreationMarker).toHaveBeenCalledOnce();
        expect(Object.values(saved.created)[0]?.markerRemoved).toBe(true);
        await h.engine.run(PATH, true);
        expect(h.remote.removeCreationMarker).toHaveBeenCalledOnce();
        expect(h.remote.create).toHaveBeenCalledOnce();
    });
    it('cleans up old tasks and retries after a failed cleanup and restart', async () => {
        const h = harness();
        h.data.created['new:legacy'] = { source: 'list', id: 'task-1' };
        vi.mocked(h.remote.removeCreationMarker).mockRejectedValueOnce(new Error('Offline'));
        await expect(h.engine.run(PATH, true)).rejects.toThrow('Offline');
        expect(h.data.created['new:legacy']?.markerRemoved).toBeUndefined();
        const restored = structuredClone(h.data);
        const restarted = new SyncEngine(restored, h.remote, {
            read: async () => h.state.text, indent: () => h.state.indent,
            write: async (_path, _before, after) => { h.state.text = after; return true; },
        }, async () => undefined, () => h.state.now);
        await restarted.run(PATH, true);
        expect(h.remote.removeCreationMarker).toHaveBeenCalledTimes(2);
        expect(h.remote.removeCreationMarker).toHaveBeenLastCalledWith('new:legacy', 'list', 'task-1');
        expect(restored.created['new:legacy']?.markerRemoved).toBe(true);
        expect(h.remote.create).not.toHaveBeenCalled();
    });
    it('keeps the token when saving the new Google ID fails', async () => {
        const h = harness([]);
        h.state.text = EMPTY.replace('<!-- gdn:tasks -->\n', '<!-- gdn:tasks -->\n    - [ ] Call Sam\n');
        let failSave = true;
        let saved = structuredClone(h.data);
        h.save.mockImplementation(async () => {
            if (failSave && Object.keys(h.data.created).length) throw new Error('Disk write failed');
            saved = structuredClone(h.data);
        });
        await expect(h.engine.run(PATH, true)).rejects.toThrow('Disk write failed');
        expect(h.remote.removeCreationMarker).not.toHaveBeenCalled();
        expect(saved.created).toEqual({});
        failSave = false;
        vi.mocked(h.remote.removeCreationMarker).mockImplementation(async key => { expect(saved.created[key]?.id).toBe('created'); });
        await h.engine.run(PATH, true);
        expect(h.remote.removeCreationMarker).toHaveBeenCalledOnce();
        expect(h.remote.create).toHaveBeenCalledOnce();
    });
    it('lets a remote deletion win without recreating the item', async () => {
        const h = harness(); h.state.text = h.state.text.replace('Buy coffee', 'Buy tea');
        vi.mocked(h.remote.patch).mockRejectedValueOnce(new GoogleError(404));
        vi.mocked(h.remote.load).mockResolvedValueOnce([]);
        await h.engine.run(PATH, true);
        expect(h.state.text).not.toContain('Buy tea');
        expect(h.remote.create).not.toHaveBeenCalled();
        expect(h.data.outbox).toEqual({});
    });
    it('restores a row missing from disk without an explicit editor deletion', async () => {
        const h = harness(); h.state.text = h.state.text.split('\n').filter(line => !line.includes('Buy coffee')).join('\n');
        await h.engine.run(PATH, true);
        expect(h.state.text).toContain('Buy coffee');
        expect(h.remote.patch).not.toHaveBeenCalled();
        expect(h.remote.remove).not.toHaveBeenCalled();
    });
    it.each(['event', 'task'] as const)('syncs an explicit %s deletion without recreating it', async kind => {
        const target = kind === 'event' ? event() : item();
        const h = harness([target, item({ id: 'keep', title: 'Keep this' })]);
        h.state.text = h.state.text.split('\n').filter(line => !line.includes(target.key)).join('\n');
        h.engine.queueDeletions(PATH, [target.key]);
        h.state.now += 5000;
        await h.engine.run(PATH, true);
        expect(h.remote.remove).toHaveBeenCalledWith(expect.objectContaining({ kind, source: target.source, id: target.id, remove: true }));
        expect(h.state.text).not.toContain(target.title);
        expect(h.state.text).toContain('Keep this');
        await h.engine.run(PATH, true);
        expect(h.remote.remove).toHaveBeenCalledOnce();
        expect(h.remote.create).not.toHaveBeenCalled();
    });
    it('persists a failed deletion and retries it after restart', async () => {
        const h = harness();
        h.state.text = h.state.text.split('\n').filter(line => !line.includes(item().key)).join('\n');
        h.engine.queueDeletions(PATH, [item().key]);
        h.state.now += 5000;
        vi.mocked(h.remote.remove).mockRejectedValueOnce(new Error('Offline'));
        await expect(h.engine.run(PATH, true)).rejects.toThrow('Offline');
        expect(h.data.outbox[item().key]?.remove).toBe(true);
        const restored = structuredClone(h.data);
        const restarted = new SyncEngine(restored, h.remote, {
            read: async () => h.state.text, indent: () => h.state.indent,
            write: async (_path, _before, after) => { h.state.text = after; return true; },
        }, async () => undefined, () => h.state.now);
        await restarted.run(PATH, true);
        expect(h.remote.remove).toHaveBeenCalledTimes(2);
        expect(restored.outbox).toEqual({});
        expect(h.state.text).not.toContain('Buy coffee');
    });
    it.each(['event', 'task'] as const)('hides a deleted %s during refresh and sends it at five seconds', async kind => {
        const target = kind === 'event' ? event() : item();
        const h = harness([target]);
        h.state.text = h.state.text.split('\n').filter(line => !line.includes(target.key)).join('\n');
        h.engine.queueDeletions(PATH, [target.key]);
        expect(await h.engine.run(PATH, true)).toBe('Deletion pending');
        h.state.now += 4999;
        await h.engine.run(PATH, true);
        expect(h.remote.remove).not.toHaveBeenCalled();
        expect(h.state.text).not.toContain(target.key);
        expect(h.data.notes[PATH]!.rows[target.key]).toEqual(target);
        expect(h.engine.undoableDeletions(PATH)).toEqual([target.key]);
        h.state.now++;
        expect(h.engine.undoableDeletions(PATH)).toEqual([]);
        h.engine.cancelDeletions(PATH, [target.key]);
        expect(await h.engine.run(PATH, true)).toBe('Up to date');
        expect(h.remote.remove).toHaveBeenCalledOnce();
        expect(h.data.notes[PATH]!.rows[target.key]).toBeUndefined();
    });
    it('cancels deletion at 4999 ms and gives redo a fresh five seconds', async () => {
        const h = harness();
        const original = h.state.text;
        const deleted = original.split('\n').filter(line => !line.includes(item().key)).join('\n');
        h.state.text = deleted;
        h.engine.queueDeletions(PATH, [item().key]);
        await h.engine.run(PATH, true);
        h.state.now += 4999;
        h.state.text = original;
        h.engine.cancelDeletions(PATH, [item().key]);
        await h.engine.run(PATH, true);
        h.state.now += 10000;
        await h.engine.run(PATH, true);
        expect(h.remote.remove).not.toHaveBeenCalled();
        expect(h.data.outbox).toEqual({});
        expect(h.state.text).toContain('Buy coffee');
        h.state.text = deleted;
        h.engine.queueDeletions(PATH, [item().key]);
        h.state.now += 4999;
        await h.engine.run(PATH, true);
        expect(h.remote.remove).not.toHaveBeenCalled();
        h.state.now++;
        await h.engine.run(PATH, true);
        expect(h.remote.remove).toHaveBeenCalledOnce();
    });
    it('retains the remaining grace period across a restart', async () => {
        const h = harness();
        h.state.text = h.state.text.split('\n').filter(line => !line.includes(item().key)).join('\n');
        h.engine.queueDeletions(PATH, [item().key]);
        await h.engine.run(PATH, true);
        h.state.now += 3000;
        const restored = structuredClone(h.data);
        const restarted = new SyncEngine(restored, h.remote, {
            read: async () => h.state.text, indent: () => h.state.indent,
            write: async (_path, _before, after) => { h.state.text = after; return true; },
        }, async () => undefined, () => h.state.now);
        await restarted.run(PATH, true);
        expect(h.remote.remove).not.toHaveBeenCalled();
        expect(h.state.text).not.toContain('Buy coffee');
        h.state.now += 2000;
        await restarted.run(PATH, true);
        expect(h.remote.remove).toHaveBeenCalledOnce();
    });
    it('preserves offline title and status edits when undoing deletion', async () => {
        const h = harness();
        h.state.text = h.state.text.replace('- [ ] Buy coffee', '- [x] Buy tea');
        vi.mocked(h.remote.patch).mockRejectedValueOnce(new Error('Offline'));
        await expect(h.engine.run(PATH, true)).rejects.toThrow('Offline');
        const edited = h.state.text;
        h.state.text = edited.split('\n').filter(line => !line.includes(item().key)).join('\n');
        h.engine.queueDeletions(PATH, [item().key]);
        h.state.text = edited;
        h.engine.cancelDeletions(PATH, [item().key]);
        expect(h.data.outbox[item().key]).toMatchObject({ title: 'Buy tea', done: true });
        await h.engine.run(PATH, true);
        expect(h.remote.remove).not.toHaveBeenCalled();
        expect(h.items[0]).toMatchObject({ title: 'Buy tea', done: true });
    });
    it('does not send a cancelled deletion captured before another request finished', async () => {
        const h = harness([item(), event()]);
        h.state.text = h.state.text.replace('Buy coffee', 'Buy tea');
        vi.mocked(h.remote.patch).mockRejectedValueOnce(new Error('Offline'));
        await expect(h.engine.run(PATH, true)).rejects.toThrow('Offline');
        h.engine.queueDeletions(PATH, [event().key]);
        vi.mocked(h.remote.patch).mockImplementationOnce(async () => {
            h.state.now += 4999;
            h.engine.cancelDeletions(PATH, [event().key]);
            h.state.now += 100;
        });
        await h.engine.flush();
        expect(h.remote.remove).not.toHaveBeenCalled();
        expect(h.data.outbox).toEqual({});
    });
    it('cancels an unsent draft instead of creating and then deleting it', async () => {
        const h = harness([]);
        h.state.text = EMPTY.replace('<!-- gdn:tasks -->\n', '<!-- gdn:tasks -->\n    - [ ] Call Sam\n');
        vi.mocked(h.remote.create).mockRejectedValueOnce(new Error('Offline'));
        await expect(h.engine.run(PATH, true)).rejects.toThrow('Offline');
        const key = Object.keys(h.data.outbox)[0]!;
        h.state.text = h.state.text.split('\n').filter(line => !line.includes(key)).join('\n');
        h.engine.queueDeletions(PATH, [key]);
        h.state.now += 5000;
        await h.engine.run(PATH, true);
        expect(h.remote.create).toHaveBeenCalledOnce();
        expect(h.remote.remove).not.toHaveBeenCalled();
        expect(h.data.outbox).toEqual({});
    });
    it('does not lose a deletion queued while a title update is in flight', async () => {
        const h = harness();
        h.state.text = h.state.text.replace('Buy coffee', 'Buy tea');
        vi.mocked(h.remote.patch).mockImplementationOnce(async () => {
            h.state.text = h.state.text.split('\n').filter(line => !line.includes(item().key)).join('\n');
            h.engine.queueDeletions(PATH, [item().key]);
        });
        await h.engine.run(PATH, true);
        expect(h.data.outbox[item().key]?.remove).toBe(true);
        h.state.now += 5000;
        await h.engine.run(PATH, true);
        expect(h.remote.remove).toHaveBeenCalledOnce();
    });
    it('deletes a draft whose creation finished after dd without inserting twice', async () => {
        const h = harness([]);
        h.state.text = EMPTY.replace('<!-- gdn:tasks -->\n', '<!-- gdn:tasks -->\n    - [ ] Call Sam\n');
        vi.mocked(h.remote.create).mockImplementationOnce(async (operation, beforeInsert) => {
            await beforeInsert();
            h.state.text = h.state.text.split('\n').filter(line => !line.includes(operation.key)).join('\n');
            h.engine.queueDeletions(PATH, [operation.key]);
            return { id: 'created', source: 'list' };
        });
        await h.engine.run(PATH, true);
        expect(Object.values(h.data.outbox)[0]?.remove).toBe(true);
        h.state.now += 5000;
        await h.engine.run(PATH, true);
        expect(h.remote.create).toHaveBeenCalledOnce();
        expect(h.remote.remove).toHaveBeenCalledWith(expect.objectContaining({ id: 'created', source: 'list', remove: true }));
        expect(h.data.outbox).toEqual({});
    });
    it('retains an overdue item checked in this note so it can be undone', async () => {
        const h = harness([event({ date: '2026-09-18' })]);
        h.state.text = h.state.text.replace('- [ ] 90 min', '- [x] 90 min');
        await h.engine.run(PATH, false);
        expect(h.data.notes[PATH]!.retained).toContain(h.items[0]!.key);
    });
    it('does no work after unload', async () => {
        const h = harness(); h.engine.stopped = true; await h.engine.run(PATH, true);
        expect(h.remote.load).not.toHaveBeenCalled(); expect(h.remote.patch).not.toHaveBeenCalled();
    });
    it('does not pull or reorder rows while the user is entering a new task', async () => {
        const h = harness(); h.state.text = h.state.text.replace('<!-- gdn:tasks -->\n', '<!-- gdn:tasks -->\n    - [ ] still typing\n');
        const before = h.state.text;
        await h.engine.run(PATH, false, false);
        expect(h.remote.load).not.toHaveBeenCalled(); expect(h.remote.create).not.toHaveBeenCalled();
        expect(h.state.text).toBe(before);
    });
    it('does not let a denied calendar edit block an unrelated task update', async () => {
        const h = harness([event(), item()]);
        h.state.text = h.state.text.replace('Weekly review', 'Calendar rename').replace('Buy coffee', 'Task rename');
        vi.mocked(h.remote.patch).mockRejectedValueOnce(new GoogleError(403));
        await expect(h.engine.run(PATH, true)).rejects.toThrow('denied');
        expect(h.remote.patch).toHaveBeenCalledTimes(2);
        expect(h.items[1]!.title).toBe('Task rename');
        expect(Object.keys(h.data.outbox)).toHaveLength(1);
    });
});
