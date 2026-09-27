import { describe, expect, it } from 'vitest';
import { BLOCKED, checkEdit, cleanTitle, enableNote, googleTitle, isTaskRow, lineChanges, noteDate, parseItemKey, regions, renderNote, renderRow, ROW_ID, splitsRow, TEMPLATE, type EditContext } from '../src/markdown';
import { EMPTY, DATE, event, item, seeded } from './fixtures';

describe('daily note activation', () => {
    it('uses the daily note date, not the current date', () => expect(noteDate(EMPTY, '2020-01-01')).toBe('2020-01-01'));
    it('requires explicit opt-in', () => expect(noteDate(EMPTY.replace('true', 'false'), DATE)).toBeUndefined());
    it('supports an explicit date property', () => expect(noteDate(EMPTY.replace('google-daily: true', 'google-daily: true\ngoogle-daily-date: "2026-09-18"'), 'Custom')).toBe('2026-09-18'));
    it('rejects invalid dates', () => expect(noteDate(EMPTY, '2026-02-30')).toBeUndefined());
    it('supports Windows line endings', () => expect(noteDate(EMPTY.replaceAll('\n', '\r\n'), DATE)).toBe(DATE));
    it('does not fall back to a filename when an explicit date is invalid', () => expect(noteDate(EMPTY.replace('google-daily: true', 'google-daily: true\ngoogle-daily-date: nonsense'), DATE)).toBeUndefined());
    it('enables notes without rewriting other frontmatter or duplicating it', () => {
        const source = '---\ntags: [work]\n# My comment\ngoogle-daily: false\n---\nNote text';
        expect(enableNote(source)).toBe(source.replace('false', 'true'));
        expect(enableNote('My note')).toBe('---\ngoogle-daily: true\n---\nMy note');
    });
    it('handles empty frontmatter and replacement patterns in values (1.8)', () => {
        expect(enableNote('---\n---\nBody')).toBe('---\ngoogle-daily: true\n---\nBody');
        expect(enableNote('---\n\n---\n')).toBe('---\n\ngoogle-daily: true\n---\n');
        for (const pattern of ["$'", '$`', '$&', '$$']) {
            const source = `---\ntitle: cost ${pattern} more\n---\n`;
            expect(enableNote(source)).toBe(`---\ntitle: cost ${pattern} more\ngoogle-daily: true\n---\n`);
        }
        expect(enableNote('---\r\ntags: [a]\r\n---\r\nx')).toBe('---\r\ntags: [a]\r\ngoogle-daily: true\r\n---\r\nx');
        expect(() => enableNote('---\ntags: [a]\n')).toThrow('Close');
    });
});

describe('managed Markdown', () => {
    it('leaves empty groups empty without adding placeholder tasks', () => {
        expect(TEMPLATE).not.toMatch(/^\s+- \[ \][ \t]*$/m);
        expect(renderNote(TEMPLATE, [])).toBe(TEMPLATE);
        const rendered = renderNote(TEMPLATE, [item()]);
        expect(rendered.split('\n').filter(line => /^\s+- /.test(line))).toHaveLength(1);
    });
    it.each(['\t', '  ', '        '])('renders every group with the configured indentation %j', indent => {
        const rows = [event({ section: 'events' }), event({ id: 'recurring' }), item()];
        const rendered = renderNote(EMPTY, rows, indent);
        for (const row of rows) expect(rendered).toContain(renderRow(row, indent));
        expect(renderNote(rendered, rows, indent)).toBe(rendered);
        expect(rendered).toContain('Outside the sections.');
    });
    it('adds one configured level below nested headings and preserves unrelated indentation', () => {
        const source = '- [ ] Local\n\t- [ ] tasks <!-- gdn:tasks -->\n\t\t- [ ] draft\n\t- [ ] Local sibling\n';
        const rendered = renderNote(source, [item()], '\t');
        expect(rendered).toContain(`\t\t- [ ] draft\n${renderRow(item(), '\t\t')}\n\t- [ ] Local sibling\n`);
    });
    it('renders real Markdown and preserves unrelated text and drafts', () => {
        const source = EMPTY.replace('<!-- gdn:tasks -->\n', '<!-- gdn:tasks -->\n    - [ ] draft\n');
        const rendered = renderNote(source, [event(), item()]);
        expect(rendered).toContain('- [ ] 90 min Weekly review');
        expect(rendered).toContain('My own text.');
        expect(rendered).toContain('Outside the sections.');
        expect(rendered).toContain('    - [ ] draft');
        expect(renderNote(rendered, [event(), item()])).toBe(rendered);
    });
    it('keeps the task order of the note and inserts new tasks at their sorted place (D13)', () => {
        const [a, b, c] = [item({ id: 'a', title: 'A', sort: '1' }), item({ id: 'b', title: 'B', sort: '2' }), item({ id: 'c', title: 'C', sort: '3' })];
        const ordered = renderNote(EMPTY, [a, c]);
        expect(renderNote(ordered, [a, b, c])).toContain([a, b, c].map(value => renderRow(value, '    ')).join('\n'));
        // The user moved C above A and wrote a note under it.
        const moved = ordered.replace(renderRow(a, '    ') + '\n' + renderRow(c, '    '), renderRow(c, '    ') + '\n    note under C\n' + renderRow(a, '    '));
        const rendered = renderNote(moved, [a, { ...b, title: 'B' }, { ...c, title: 'C renamed' }]);
        expect(rendered).toContain([renderRow({ ...c, title: 'C renamed' }, '    '), '    note under C', renderRow(a, '    ')].join('\n'));
        expect(rendered.indexOf(renderRow(b, '    '))).toBeLessThan(rendered.indexOf('C renamed'));
    });
    it('keeps calendar groups chronological', () => {
        const late = event({ id: 'late', title: 'Late', sort: '2026-09-19 15:00' });
        const early = event({ id: 'early', title: 'Early', sort: '2026-09-19 09:00' });
        expect(renderNote(EMPTY, [late, early]).indexOf('Early')).toBeLessThan(renderNote(EMPTY, [late, early]).indexOf('Late'));
    });
    it('collapses a duplicated row and keeps rows of unreadable sources', () => {
        const row = renderRow(item(), '    ');
        const duplicated = EMPTY.replace('<!-- gdn:tasks -->\n', `<!-- gdn:tasks -->\n${row}\n${row}\n`);
        expect(renderNote(duplicated, [item()]).split(row).length - 1).toBe(1);
        const foreign = renderRow(item({ id: 'unreadable' }), '    ');
        const kept = EMPTY.replace('<!-- gdn:tasks -->\n', `<!-- gdn:tasks -->\n${foreign}\n`);
        expect(renderNote(kept, [], '    ', 4, new Set([item({ id: 'unreadable' }).key]))).toContain(foreign);
        expect(renderNote(kept, [])).not.toContain(foreign);
    });
    it('preserves CRLF throughout managed sections', () => {
        const rendered = renderNote(EMPTY.replaceAll('\n', '\r\n'), [item()]);
        expect(rendered.replaceAll('\r\n', '')).not.toContain('\n');
    });
    it('ignores markers in fenced examples', () => expect(regions('```markdown\n' + EMPTY + '\n```')).toEqual([]));
    it('rejects duplicate sections without rewriting a note', () => {
        expect(() => regions(EMPTY + '- [ ] Duplicate <!-- gdn:tasks -->')).toThrow();
    });
    it('keeps a ROW_ID separator the user just typed', () => {
        const row = '    - [ ] New title  <!-- gdn:abc -->';
        expect(ROW_ID.exec(row)?.index).toBe(row.indexOf(' <!--'));
        expect(row.replace(ROW_ID, '')).toBe('    - [ ] New title ');
    });
    it('renders after a heading with no trailing newline', () => expect(renderNote('- [ ] tasks <!-- gdn:tasks -->', [item()])).toContain('-->\n    - [ ] Buy coffee'));
    it('decodes row keys, including Unicode sources', () => {
        expect(parseItemKey(item().key)).toEqual({ kind: 'task', source: 'list', id: 'task-1' });
        expect(parseItemKey(event({ source: 'kalendarz-zażółć' }).key)).toMatchObject({ kind: 'event', source: 'kalendarz-zażółć' });
        expect(parseItemKey('new:device:1')).toBeUndefined();
    });
});

describe('the tasks group (D5)', () => {
    const note = EMPTY.replace('<!-- gdn:tasks -->\n', '<!-- gdn:tasks -->\n    - [ ] Direct task\n    Plain text\n    - bullet\n        - [ ] Nested task\n    ```\n    - [ ] Code\n    ```\n\t- [x] Tab-indented task\n');
    const region = regions(note).find(value => value.section === 'tasks')!;
    const line = (text: string) => region.lines.find(value => value.text.includes(text))!;
    it('treats only direct checkbox rows as tasks', () => {
        expect(isTaskRow(region, line('Direct task'))).toBe(true);
        expect(isTaskRow(region, line('Tab-indented task'))).toBe(true);
        for (const text of ['Plain text', '- bullet', 'Nested task', 'Code']) expect(isTaskRow(region, line(text))).toBe(false);
    });
    it('uses the configured tab width for nesting', () => {
        const tabbed = regions('- [ ] tasks <!-- gdn:tasks -->\n  - [ ] two spaces\n\t- [ ] tab\n', '  ', 2)[0]!;
        expect(isTaskRow(tabbed, tabbed.lines[0]!, 2)).toBe(true);
        expect(isTaskRow(tabbed, tabbed.lines[1]!, 2)).toBe(true);
        expect(isTaskRow(tabbed, tabbed.lines[1]!, 8)).toBe(false);
    });
});

describe('titles from Google (D7)', () => {
    it('escapes HTML, embeds and inline code, and keeps links', () => {
        expect(cleanTitle('![](https://tracker.example/p.png)')).toBe('\\![](https://tracker.example/p.png)');
        expect(cleanTitle('<img src=x> and <iframe src=y>')).toBe('\\<img src=x> and \\<iframe src=y>');
        expect(cleanTitle('![[Private note]]')).toBe('\\![[Private note]]');
        expect(cleanTitle('`$= dv.pages()`')).toBe('\\`$= dv.pages()\\`');
        expect(cleanTitle('[Agenda](https://example.com) *soon*')).toBe('[Agenda](https://example.com) *soon*');
    });
    it('cannot inject a comment marker or a line break', () => {
        const title = cleanTitle('hello\n<!-- gdn:tasks -->');
        expect(title).toBe('hello \\<!-- gdn:tasks -->');
        expect(ROW_ID.test(`    - [ ] ${title}`)).toBe(false);
    });
    it.each(['a\\<b', '\\\\', '![x](y)', '`code`', 'C:\\path\\n', 'end\\', '<img src=x>', '\\![', 'x!y', '\\\\<', '&lt;tag&gt;', 'a <!-- gdn:tasks -->', 'already \\escaped'])('round-trips %j', title => {
        expect(googleTitle(cleanTitle(title))).toBe(title);
    });
    it('sends other backslashes a user types unchanged', () => expect(googleTitle('C:\\temp \\d')).toBe('C:\\temp \\d'));
    it('still reads comment escapes from earlier versions', () => expect(googleTitle('&lt;!-- x --&gt;')).toBe('<!-- x -->'));
});

describe('whole-line render changes', () => {
    const apply = (before: string, changes: { from: number; to: number; insert: string }[]) => {
        let result = before;
        for (const change of [...changes].sort((a, b) => b.from - a.from)) result = result.slice(0, change.from) + change.insert + result.slice(change.to);
        return result;
    };
    it.each([
        ['A\nB\nC', 'A\nX\nC'], ['A\nB', 'A\nB\nC'], ['A\nB\nC', 'B\nC'], ['A\nB\nC', 'A\nB'], ['', 'X'], ['A', ''],
        ['A\nB\nC\nD', 'A\nC\nB\nD'], ['A\r\nB\r\nC', 'A\r\nX\r\nC'], ['A\n', 'A\nB\n'], ['A\nB\n', 'A\n'], ['A\nB\nC\nD\nE', 'X\nB\nY\nD\nZ'],
    ])('turns %j into %j', (before, after) => expect(apply(before, lineChanges(before, after))).toBe(after));
    it('replaces whole lines with both line breaks', () => {
        expect(lineChanges('A\nkey:1\nC', 'A\nkey:2\nC')).toEqual([{ from: 1, to: 8, insert: '\nkey:2\n' }]);
    });
});

describe('editor protection (checkEdit)', () => {
    const rows = [event(), item(), event({ id: 'ordinary', section: 'events', done: undefined, prefix: '📅 13:00 (90 min) ' })];
    const { text, data } = seeded(rows);
    const snapshots = data.notes[`${DATE}.md`]!.rows;
    let keys = 0;
    const context = (values: Partial<EditContext> = {}): EditContext => ({
        snapshots, deleted: [], draftInsert: false, newKey: () => `new:device:${++keys}`, indentUnit: '    ', tabWidth: 4, ...values,
    });
    // The lines an edit touched, in the new text.
    const all = (after: string): [number, number][] => [[0, after.length]];
    const check = (after: string, values: Partial<EditContext> = {}, before = text) => checkEdit(before, after, all(after), context(values));
    it('allows event title edits and checkbox toggles', () => {
        expect(check(text.replace('Weekly review', 'Monthly review')).block).toBeUndefined();
        expect(check(text.replace('- [ ] 90 min', '- [x] 90 min')).block).toBeUndefined();
    });
    it('keeps calendar rows in time order and lets task rows move', () => {
        const two = seeded([event({ id: 'a', title: 'First', sort: '1' }), event({ id: 'b', title: 'Second', sort: '2' }), item({ id: 'x', title: 'Task X', sort: '1' }), item({ id: 'y', title: 'Task Y', sort: '2' })]).text;
        const swap = (text: string, a: string, b: string) => {
            const lines = text.split('\n');
            const i = lines.findIndex(line => line.includes(a));
            const j = lines.findIndex(line => line.includes(b));
            [lines[i], lines[j]] = [lines[j]!, lines[i]!];
            return lines.join('\n');
        };
        expect(check(swap(two, 'First', 'Second'), {}, two).block).toBe(BLOCKED.order);
        expect(check(swap(two, 'Task X', 'Task Y'), {}, two).block).toBeUndefined();
    });
    it('blocks new calendar rows and scheduling changes', () => {
        expect(check(text.replace('90 min Weekly', '30 min Weekly')).block).toBe(BLOCKED.identity);
        expect(check(text.replace('- [ ] recurring <!-- gdn:recurring -->', '    - another event\n- [ ] recurring <!-- gdn:recurring -->')).block).toBe(BLOCKED.structure);
    });
    it('blocks unidentified deletion and damaged identities', () => {
        const row = renderRow(rows[0]!, '    ');
        expect(check(text.replace(row + '\n', '')).block).toBe(BLOCKED.identity);
        expect(check(text.replace(rows[0]!.key, 'other')).block).toBeDefined();
    });
    it('allows explicitly deleted rows while protecting remaining IDs', () => {
        for (const value of rows) expect(check(text.replace(renderRow(value, '    ') + '\n', ''), { deleted: [value.key] }).block).toBeUndefined();
        expect(check(text.replace(` <!-- gdn:${rows[1]!.key} -->`, '')).block).toBe(BLOCKED.identity);
    });
    it('blocks changes to read-only events', () => {
        const readonly = { ...snapshots, [rows[0]!.key]: { ...rows[0]!, writable: false } };
        expect(check(text.replace('90 min Weekly review', '90 min Changed'), { snapshots: readonly }).block).toBe(BLOCKED.readOnly);
        expect(check(text.replace(renderRow(rows[0]!, '    ') + '\n', ''), { snapshots: readonly, deleted: [rows[0]!.key] }).block).toBe(BLOCKED.readOnly);
    });
    it('allows unrelated note editing and new groups, and blocks removing a group (D10)', () => {
        expect(check('intro\n' + text).block).toBeUndefined();
        const partial = seeded([]).text.replace('- [ ] google tasks <!-- gdn:tasks -->\n', '');
        expect(checkEdit(partial, seeded([]).text, all(seeded([]).text), context()).block).toBeUndefined();
        expect(check(text.replace('- [ ] google tasks <!-- gdn:tasks -->\n', '')).block).toBe(BLOCKED.group);
    });
    it('claims a typed checkbox row under the tasks heading, and only that (1.4)', () => {
        const after = text.replace('Outside the sections.', '    - [ ] New task\n    plain line\n        - [ ] nested\nOutside the sections.');
        const result = check(after);
        expect(result.block).toBeUndefined();
        expect(result.changes).toHaveLength(1);
        expect(after.slice(0, result.changes[0]!.from)).toMatch(/- \[ \] New task$/);
        expect(result.changes[0]!.insert).toMatch(/^ <!-- gdn:new:device:\d+ -->$/);
    });
    it('does not claim a row the edit did not touch', () => {
        const before = text.replace('Outside the sections.', '    - [ ] From another device\nOutside the sections.');
        const after = before.replace('My own text.', 'My own text, edited.');
        const from = after.indexOf('edited');
        expect(checkEdit(before, after, [[from, from + 6]], context()).changes).toEqual([]);
    });
    it('gives a pasted task row a new draft key, including ddp and a paste into another note (3.4)', () => {
        const row = renderRow(rows[1]!, '    ');
        const pasted = text.replace(row, `${row}\n${row}`);
        const from = pasted.indexOf(row) + row.length + 1;
        const result = checkEdit(text, pasted, [[from, from + row.length]], context());
        expect(result.block).toBeUndefined();
        expect(result.changes).toEqual([{ from: from + row.indexOf(rows[1]!.key), to: from + row.indexOf(rows[1]!.key) + rows[1]!.key.length, insert: expect.stringMatching(/^new:device:/) }]);
        const deleted = text.replace(row + '\n', '');
        expect(check(text.replace(row + '\n', '').replace('Outside', row + '\nOutside'), {}, deleted).changes[0]?.insert).toMatch(/^new:device:/);
    });
    it('rejects a pasted calendar row, which cannot be created', () => {
        const row = renderRow(rows[0]!, '    ');
        const deleted = text.replace(row + '\n', '');
        expect(check(deleted.replace('<!-- gdn:tasks -->\n', `<!-- gdn:tasks -->\n${row}\n`), {}, deleted).block).toBe(BLOCKED.event);
    });
    it('keeps a note with duplicate markers editable and removes one copy of a duplicated row (3.3)', () => {
        const broken = text + '- [ ] Duplicate <!-- gdn:tasks -->\n';
        expect(check(broken.replace('My own text.', 'Fixed'), {}, broken).block).toBeUndefined();
        const row = renderRow(rows[1]!, '    ');
        const duplicated = text.replace(row, `${row}\n${row}`);
        expect(check(text, {}, duplicated).block).toBeUndefined();
        expect(check(duplicated.replace('My own text.', 'Typing'), {}, duplicated).block).toBeUndefined();
    });
    it('blocks an edit that adds a duplicate group', () => {
        expect(check(text + '- [ ] Again <!-- gdn:tasks -->\n').block).toBe(BLOCKED.duplicate);
    });
    it('allows a code fence that hides the groups while every row still exists (3.5)', () => {
        expect(check(text.replace('My own text.', 'My own text.\n```')).block).toBeUndefined();
        // Closing it again brings the rows back unchanged, never as pastes.
        const open = text.replace('My own text.', 'My own text.\n```');
        const closed = open.replace('My own text.\n```', 'My own text.\n```\n```');
        const at = closed.indexOf('```\n```') + 4;
        expect(checkEdit(open, closed, [[at, at + 3]], context())).toEqual({ changes: [] });
        const hidden = text.replace('My own text.', 'My own text.\n```').replace(` <!-- gdn:${rows[1]!.key} -->`, '');
        expect(check(hidden).block).toBe(BLOCKED.group);
    });
    it('detects a line break inserted inside a synced row (3.9)', () => {
        const row = renderRow(rows[1]!, '    ');
        const at = text.indexOf(row) + row.indexOf('coffee');
        expect(splitsRow(text, { from: at, to: at, inserted: '\n' }, '    ', 4)).toBe(true);
        expect(splitsRow(text, { from: text.indexOf(row) + row.length, to: text.indexOf(row) + row.length, inserted: '\n' }, '    ', 4)).toBe(false);
        expect(splitsRow(text, { from: text.indexOf(row), to: text.indexOf(row), inserted: '\n' }, '    ', 4)).toBe(false);
    });
});
