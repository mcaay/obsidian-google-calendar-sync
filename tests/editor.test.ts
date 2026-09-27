import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', async () => {
    const { StateField } = await import('@codemirror/state');
    return {
        editorInfoField: StateField.define<unknown>({ create: () => undefined, update: value => value }),
        editorLivePreviewField: StateField.define<boolean>({ create: () => false, update: value => value }),
        Keymap: { isModifier: () => false },
        MarkdownView: class {},
    };
});

import { EditorState, Transaction, type TransactionSpec } from '@codemirror/state';
import { history, redo, undo } from '@codemirror/commands';
import { editorInfoField } from 'obsidian';
import { draftSpec, editorExtension, fromSync, observe, replayChanges, type EditorHooks } from '../src/editor';
import { BLOCKED, itemKey, lineChanges, renderRow, TEMPLATE } from '../src/markdown';
import { SyncEngine, type Problem } from '../src/sync';
import type { Item, Remote } from '../src/types';
import { DATE, EMPTY, PATH, event, item, seeded } from './fixtures';

/**
 * A daily note in a CodeMirror state with Obsidian's undo history, the
 * plugin's editor extension and a real SyncEngine. The view plugin's work is
 * done by observe() and replayChanges(), exactly as update() calls them.
 */
class Note {
    state: EditorState;
    blocked: string[] = [];
    lost: string[] = [];
    problems: Problem[] = [];
    engine: SyncEngine;
    items: Item[];
    remote: { [K in keyof Remote]: ReturnType<typeof vi.fn> } & Remote;

    constructor(items: Item[], text?: string) {
        const seed = seeded(items);
        this.items = items;
        let created = 0;
        this.remote = {
            load: vi.fn(async () => ({ items: structuredClone(this.items), failed: [] })),
            patch: vi.fn(async operation => {
                const target = this.items.find(value => value.kind === operation.kind && value.id === operation.id);
                if (target && operation.title !== undefined) target.title = operation.title;
                if (target && operation.done !== undefined) target.done = operation.done;
            }),
            insert: vi.fn(async operation => {
                const id = `created-${++created}`;
                this.items.push(item({ id, title: operation.title, done: operation.done, date: operation.create!.date }));
                return { source: operation.source, id };
            }),
            find: vi.fn(async () => []),
            removeCreationMarker: vi.fn(async () => undefined),
            remove: vi.fn(async operation => { this.items = this.items.filter(value => !(value.kind === operation.kind && value.id === operation.id)); }),
        };
        this.engine = new SyncEngine(seed.data, this.remote, {
            read: async () => this.text, indent: () => '    ', tabWidth: () => 4,
            write: async (_path, before, after) => {
                if (this.text !== before) return false;
                this.state = this.state.update({ changes: lineChanges(before, after), annotations: [fromSync.of(true), Transaction.addToHistory.of(false)] }).state;
                return true;
            },
        }, () => true, Date.now, problem => this.problems.push(problem));
        this.state = EditorState.create({
            doc: text ?? seed.text,
            extensions: [history(), editorInfoField.init(() => ({ file: { path: PATH, basename: DATE } }) as never), editorExtension(this.hooks)],
        });
    }

    hooks: EditorHooks = {
        rows: path => this.engine.editorRows(path),
        indent: () => '    ',
        tabWidth: () => 4,
        draftKey: () => this.engine.draftKey(),
        resolve: key => this.engine.resolve(key),
        changed: () => undefined,
        normal: () => undefined,
        edited: (path, edits) => this.engine.journalEdits(path, edits),
        deleted: (path, rows) => this.engine.queueDeletions(path, rows),
        restored: (path, keys, at) => { this.lost.push(...this.engine.restoreDeletions(path, keys, at)); },
        external: () => undefined,
        blocked: message => { this.blocked.push(message); },
    };

    get text(): string { return this.state.doc.toString(); }

    private apply(transaction: Transaction): void {
        this.state = transaction.state;
        const result = observe(PATH, [transaction], this.hooks);
        if (!result.replay.length) return;
        const replay = replayChanges(this.state, [transaction], result.replay, this.hooks);
        if (!replay) return;
        this.state = this.state.update({ changes: replay.changes, annotations: [fromSync.of(true), Transaction.addToHistory.of(false)] }).state;
        if (replay.deleted.length) this.hooks.deleted(PATH, replay.deleted);
        if (replay.restored.length) this.hooks.restored(PATH, replay.restored, replay.at);
    }

    dispatch(spec: TransactionSpec): void { this.apply(this.state.update(spec)); }
    undo(): void { undo({ state: this.state, dispatch: transaction => this.apply(transaction) }); }
    redo(): void { redo({ state: this.state, dispatch: transaction => this.apply(transaction) }); }
    line(text: string) {
        for (let number = 1; number <= this.state.doc.lines; number++) if (this.state.doc.line(number).text.includes(text)) return this.state.doc.line(number);
        throw new Error(`No line with ${text}`);
    }
    // Vim dd: the line and its break.
    dd(text: string): void { const line = this.line(text); this.dispatch({ changes: { from: line.from, to: line.to + 1 }, userEvent: 'delete' }); }
    // Vim o on a line, then typing a title.
    o(text: string, title: string): void {
        this.dispatch(draftSpec(this.state, this.line(text).from, false, this.hooks)!);
        this.dispatch({ changes: { from: this.state.selection.main.head, insert: title }, userEvent: 'input.type' });
    }
    paste(text: string, below: string): void {
        const line = this.line(below);
        this.dispatch({ changes: { from: line.to, insert: '\n' + text }, userEvent: 'input.paste' });
    }
}

describe('editor and sync', () => {
    beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-19T08:00:00Z')); });
    afterEach(() => vi.useRealTimers());
    const wait = (ms: number) => vi.setSystemTime(Date.now() + ms);

    it('journals only the field an edit changed, and nothing for outside changes', () => {
        const note = new Note([item()]);
        const title = note.line('Buy coffee');
        note.dispatch({ changes: { from: title.from + title.text.indexOf('coffee'), to: title.from + title.text.indexOf('coffee') + 6, insert: 'tea' }, userEvent: 'input.type' });
        expect(note.engine.data.edits[item().key]).toEqual({ path: PATH, title: 'Buy tea' });
        const box = note.line('Buy tea');
        note.dispatch({ changes: { from: box.from + box.text.indexOf('[') + 1, to: box.from + box.text.indexOf('[') + 2, insert: 'x' }, userEvent: 'input' });
        expect(note.engine.data.edits[item().key]).toEqual({ path: PATH, title: 'Buy tea', done: true });
        note.engine.data.edits = {};
        const again = note.line('Buy tea');
        note.dispatch({ changes: { from: again.from, to: again.to, insert: again.text.replace('Buy tea', 'From the phone') }, userEvent: 'set' });
        expect(note.engine.data.edits).toEqual({});
        expect(note.text).toContain('From the phone');
    });

    it('counts another plugin’s untagged edit as local (FP-7)', () => {
        const note = new Note([item()]);
        const line = note.line('Buy coffee');
        note.dispatch({ changes: { from: line.from + line.text.indexOf('coffee'), to: line.from + line.text.indexOf('coffee') + 6, insert: 'beans' } });
        expect(note.engine.data.edits[item().key]?.title).toBe('Buy beans');
    });

    it('3.1: undo after creating a task removes the row and deletes the task after 5 seconds', async () => {
        const note = new Note([item()]);
        note.o('Buy coffee', 'Call Sam');
        await note.engine.run(PATH, true);
        const created = itemKey('task', 'list', 'created-1');
        expect(note.text).toContain(`Call Sam <!-- gdn:${created} -->`);
        note.undo();
        expect(note.text).not.toContain('Call Sam');
        expect(note.text).toContain('Buy coffee');
        expect(note.engine.data.outbox[created]).toMatchObject({ remove: true });
        wait(5000);
        await note.engine.run(PATH, true);
        expect(note.remote.remove).toHaveBeenCalledWith(expect.objectContaining({ id: 'created-1' }));
        expect(note.items.map(value => value.title)).toEqual(['Buy coffee']);
    });

    it('3.1: redo within 5 seconds keeps the created task', async () => {
        const note = new Note([item()]);
        note.o('Buy coffee', 'Call Sam');
        await note.engine.run(PATH, true);
        note.undo();
        wait(1000);
        note.redo();
        expect(note.text).toContain('Call Sam');
        expect(note.engine.data.outbox).toEqual({});
        wait(10000);
        await note.engine.run(PATH, true);
        expect(note.remote.remove).not.toHaveBeenCalled();
        expect(note.text.match(/Call Sam/g)).toHaveLength(1);
    });

    it('3.1: undo before the task exists removes the row and sends nothing', async () => {
        const note = new Note([item()]);
        note.o('Buy coffee', 'Call Sam');
        note.undo();
        expect(note.text).not.toContain('Call Sam');
        expect(note.text).not.toContain('gdn:new:');
        wait(5000);
        await note.engine.run(PATH, true);
        expect(note.remote.insert).not.toHaveBeenCalled();
    });

    it('3.2: after a late calendar undo, further undo and redo reach unrelated edits', async () => {
        const note = new Note([event(), item()]);
        const own = note.line('My own text.');
        note.dispatch({ changes: { from: own.to, insert: ' Hello' }, userEvent: 'input.type' });
        wait(1000);
        note.dd('Weekly review');
        wait(5000);
        await note.engine.run(PATH, true);
        expect(note.remote.remove).toHaveBeenCalledOnce();
        note.undo();
        expect(note.text).toContain('Weekly review');
        expect(note.lost).toEqual([event().key]);
        note.undo();
        expect(note.text).not.toContain('Hello');
        note.redo();
        expect(note.text).toContain('Hello');
        note.redo();
        expect(note.text).not.toContain('Weekly review');
        await note.engine.run(PATH, true);
        expect(note.remote.remove).toHaveBeenCalledOnce();
        expect(note.text).not.toContain('Weekly review');
    });

    it('3.2: undoing a template insertion deletes nothing in Google', async () => {
        const note = new Note([item()], '---\ngoogle-daily: true\n---\n# Day\n\n');
        note.dispatch({ changes: { from: note.text.length, insert: TEMPLATE }, userEvent: 'input.paste' });
        await note.engine.run(PATH, true);
        expect(note.text).toContain('Buy coffee');
        note.undo();
        expect(note.text).not.toContain('gdn:');
        wait(5000);
        await note.engine.run(PATH, true);
        expect(note.engine.data.outbox).toEqual({});
        expect(note.remote.remove).not.toHaveBeenCalled();
    });

    it('3.3: removing one copy of a duplicated row deletes nothing, and undo brings it back', async () => {
        const row = renderRow(item(), '    ');
        const note = new Note([item()], EMPTY.replace('<!-- gdn:tasks -->\n', `<!-- gdn:tasks -->\n${row}\n${row}\n`));
        note.dd('Buy coffee');
        expect(note.blocked).toEqual([]);
        expect(note.engine.data.outbox).toEqual({});
        note.undo();
        expect(note.text.split(row).length - 1).toBe(2);
        await note.engine.run(PATH, true);
        expect(note.text.split(row).length - 1).toBe(1);
        expect(note.remote.remove).not.toHaveBeenCalled();
    });

    it('3.3: typing stays possible in a note with duplicate group markers', () => {
        const note = new Note([item()], seeded([item()]).text + '- [ ] second <!-- gdn:tasks -->\n');
        const own = note.line('My own text.');
        note.dispatch({ changes: { from: own.to, insert: '!' }, userEvent: 'input.type' });
        expect(note.text).toContain('My own text.!');
    });

    it('3.4: ddp deletes the task and creates the pasted one; undo keeps the original', async () => {
        const note = new Note([item(), item({ id: 'other', title: 'Other task' })]);
        const row = note.line('Buy coffee').text;
        note.dd('Buy coffee');
        note.paste(row, 'Other task');
        expect(note.text).toContain('Buy coffee <!-- gdn:new:device:');
        expect(note.engine.data.outbox[item().key]).toMatchObject({ remove: true });
        await note.engine.run(PATH, true);
        expect(note.remote.insert).toHaveBeenCalledWith(expect.objectContaining({ title: 'Buy coffee', create: expect.objectContaining({ date: DATE }) }));
        wait(5000);
        await note.engine.run(PATH, true);
        expect(note.remote.remove).toHaveBeenCalledWith(expect.objectContaining({ id: 'task-1' }));
    });

    it('3.4: yyp creates a new task and keeps the original', async () => {
        const note = new Note([item()]);
        note.paste(note.line('Buy coffee').text, 'Buy coffee');
        await note.engine.run(PATH, true);
        expect(note.remote.insert).toHaveBeenCalledOnce();
        expect(note.remote.remove).not.toHaveBeenCalled();
        expect(note.text.match(/Buy coffee/g)).toHaveLength(2);
    });

    it('3.4: a pasted calendar row is rejected with a notice', () => {
        const note = new Note([event(), item()]);
        const row = note.line('Weekly review').text;
        note.dd('Weekly review');
        note.paste(row, 'Buy coffee');
        expect(note.blocked).toEqual([BLOCKED.event]);
        expect(note.text).not.toContain('Weekly review');
    });

    it('1.4: a checkbox row typed under the tasks heading is claimed in the same undo step', () => {
        const note = new Note([item()]);
        note.paste('    - [ ] Typed task', 'Buy coffee');
        expect(note.text).toMatch(/- \[ \] Typed task <!-- gdn:new:device:[^ ]+ -->/);
        note.undo();
        expect(note.text).not.toContain('Typed task');
        expect(note.text).not.toContain('gdn:new:');
    });

    it('1.6: a late undo gets the new task’s key; redo deletes it and undo restores it', async () => {
        const note = new Note([item()]);
        note.dd('Buy coffee');
        wait(5000);
        await note.engine.run(PATH, true);
        note.undo();
        await note.engine.run(PATH, true);
        const replacement = itemKey('task', 'list', 'created-1');
        expect(note.text).toContain(`Buy coffee <!-- gdn:${replacement} -->`);
        note.redo();
        expect(note.text).not.toContain('Buy coffee');
        expect(note.engine.data.outbox[replacement]).toMatchObject({ remove: true });
        wait(1000);
        note.undo();
        expect(note.text).toContain(`Buy coffee <!-- gdn:${replacement} -->`);
        expect(note.engine.data.outbox).toEqual({});
        wait(10000);
        await note.engine.run(PATH, true);
        expect(note.remote.remove).toHaveBeenCalledOnce();
        expect(note.items.map(value => value.id)).toEqual(['created-1']);
    });

    it('D9: D and cc change only the title of a synced row', () => {
        const note = new Note([item()]);
        const line = note.line('Buy coffee');
        const at = line.from + line.text.indexOf('coffee');
        note.dispatch({ changes: { from: at, to: line.to }, userEvent: 'delete' });
        // Vim D keeps the text before the cursor, including its space.
        expect(note.line('Buy ').text).toBe(`    - [ ] Buy  <!-- gdn:${item().key} -->`);
        const again = note.line('Buy ');
        note.dispatch({ changes: { from: again.from + 4, to: again.to }, selection: { anchor: again.from + 4 }, userEvent: 'delete' });
        expect(note.line(`gdn:${item().key}`).text).toBe(`    - [ ]  <!-- gdn:${item().key} -->`);
        expect(note.state.selection.main.head).toBe(again.from + 10);
        note.dispatch({ changes: { from: note.state.selection.main.head, insert: 'New title' }, userEvent: 'input.type' });
        expect(note.line('New title').text).toBe(`    - [ ] New title <!-- gdn:${item().key} -->`);
    });

    it('D9: another plugin may rewrite a whole row, and Vim 0D keeps the row', () => {
        const note = new Note([item()]);
        const line = note.line('Buy coffee');
        note.dispatch({ changes: { from: line.from, to: line.to, insert: line.text.replace('- [ ] Buy coffee', '- [x] Buy coffee ✅ 2026-09-19') }, userEvent: 'input' });
        expect(note.line('Buy coffee').text).toBe(`    - [x] Buy coffee ✅ 2026-09-19 <!-- gdn:${item().key} -->`);
        expect(note.engine.data.edits[item().key]).toMatchObject({ done: true, title: 'Buy coffee ✅ 2026-09-19' });
        const again = note.line('Buy coffee');
        note.dispatch({ changes: { from: again.from, to: again.to }, userEvent: 'delete' });
        expect(note.line(`gdn:${item().key}`).text).toBe(`    - [x]  <!-- gdn:${item().key} -->`);
        expect(note.engine.data.outbox).toEqual({});
    });

    it('3.9: a line break inside a synced row is rejected', () => {
        const note = new Note([item()]);
        const line = note.line('Buy coffee');
        note.dispatch({ changes: { from: line.from + line.text.indexOf('coffee'), insert: '\n    ' }, userEvent: 'input.paste' });
        expect(note.blocked).toEqual([BLOCKED.split]);
        expect(note.text).toContain('Buy coffee <!--');
    });

    it('3.5: an unclosed code fence above the groups can be typed and closed', () => {
        const note = new Note([item()]);
        const own = note.line('My own text.');
        note.dispatch({ changes: { from: own.to, insert: '\n```' }, userEvent: 'input.type' });
        expect(note.text).toContain('My own text.\n```');
        note.dispatch({ changes: { from: note.line('```').to, insert: '\ncode\n```' }, userEvent: 'input.type' });
        expect(note.blocked).toEqual([]);
        expect(note.text).toContain('```\ncode\n```');
    });

    it('D10: removing a group is blocked with a notice', () => {
        const note = new Note([item()]);
        note.dd('google tasks');
        expect(note.blocked).toEqual([BLOCKED.group]);
        expect(note.text).toContain('gdn:tasks');
    });
});
