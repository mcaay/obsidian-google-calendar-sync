import { describe, expect, it } from 'vitest';
import { noteDate, enableNote, permittedEdit, regions, renderNote, renderRow, cleanTitle, googleTitle, draftTitle, ROW_ID, TEMPLATE } from '../src/markdown';
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
        expect(rendered).toContain(renderRow(item(), '\t\t'));
        expect(rendered).toContain('\t\t- [ ] draft\n\t- [ ] Local sibling\n');
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
    it('preserves CRLF throughout managed sections', () => {
        const rendered = renderNote(EMPTY.replaceAll('\n', '\r\n'), [item()]);
        expect(rendered.replaceAll('\r\n', '')).not.toContain('\n');
    });
    it('ignores markers in fenced examples', () => expect(regions('```markdown\n' + EMPTY + '\n```')).toEqual([]));
    it('rejects duplicate sections without rewriting a note', () => {
        expect(() => regions(EMPTY + '- [ ] Duplicate <!-- gdn:tasks -->')).toThrow();
    });
    it('escapes comment injection and line breaks in remote titles', () => {
        expect(cleanTitle('hello\n<!-- gdn:tasks -->')).toBe('hello &lt;!-- gdn:tasks --&gt;');
        expect(googleTitle(cleanTitle('<!-- example -->'))).toBe('<!-- example -->');
    });
    it('accepts a task written as a plain line after Vim o', () => expect(draftTitle('    Call Sam')).toEqual({ title: 'Call Sam', done: false }));
    it('keeps ambiguous local task identities', () => expect(renderNote(EMPTY.replace('<!-- gdn:tasks -->\n', '<!-- gdn:tasks -->\n    - [ ] Waiting <!-- gdn:new:abc -->\n'), [])).toContain('gdn:new:abc'));
    it('does not swallow a space just typed at the title boundary', () => {
        const row = '    - [ ] New title  <!-- gdn:abc -->';
        expect(ROW_ID.exec(row)?.index).toBe(row.indexOf(' <!--'));
        expect(row.replace(ROW_ID, '')).toBe('    - [ ] New title ');
    });
    it('renders after a heading with no trailing newline', () => expect(renderNote('- [ ] tasks <!-- gdn:tasks -->', [item()])).toContain('-->\n    - [ ] Buy coffee'));
});

describe('editor protection', () => {
    const rows = [event(), item(), event({ id: 'ordinary', section: 'events', done: undefined, prefix: '📅 13:00 (90 min) ' })];
    const { text, data } = seeded(rows);
    const snapshots = data.notes[`${DATE}.md`]!.rows;
    it('allows event title edits and checkbox toggles', () => {
        expect(permittedEdit(text, text.replace('Weekly review', 'Monthly review'), snapshots)).toBe(true);
        expect(permittedEdit(text, text.replace('- [ ] 90 min', '- [x] 90 min'), snapshots)).toBe(true);
    });
    it('blocks new calendar rows and scheduling changes', () => {
        expect(permittedEdit(text, text.replace('90 min Weekly', '30 min Weekly'), snapshots)).toBe(false);
        expect(permittedEdit(text, text.replace('- [ ] recurring <!-- gdn:recurring -->', '    - another event\n- [ ] recurring <!-- gdn:recurring -->'), snapshots)).toBe(false);
    });
    it('blocks unidentified deletion, duplicates and modification of row identities', () => {
        const row = renderRow(rows[0]!, '    ');
        expect(permittedEdit(text, text.replace(row + '\n', ''), snapshots)).toBe(false);
        expect(permittedEdit(text, text.replace(row, row + '\n' + row), snapshots)).toBe(false);
        expect(permittedEdit(text, text.replace(rows[0]!.key, 'other'), snapshots)).toBe(false);
    });
    it('allows explicitly deleted event and task rows while protecting remaining IDs', () => {
        for (const item of rows) {
            const after = text.replace(renderRow(item, '    ') + '\n', '');
            expect(permittedEdit(text, after, snapshots, [item.key])).toBe(true);
        }
        const task = rows[1]!;
        expect(permittedEdit(text, text.replace(` <!-- gdn:${task.key} -->`, ''), snapshots)).toBe(false);
    });
    it('allows new task rows and unrelated note editing', () => {
        expect(permittedEdit(text, text.replace('Outside the sections.', '    - [ ] New task\nOutside the sections.'), snapshots)).toBe(true);
        expect(permittedEdit(text, 'intro\n' + text, snapshots)).toBe(true);
    });
    it('restores only explicitly undoable rows, without allowing duplicates or different identities', () => {
        for (const item of rows) {
            const deleted = text.replace(renderRow(item, '    ') + '\n', '');
            expect(permittedEdit(deleted, text, snapshots, [], [item.key])).toBe(true);
            expect(permittedEdit(deleted, text, snapshots)).toBe(false);
            expect(permittedEdit(deleted, text.replace(item.key, 'another-identity'), snapshots, [], [item.key])).toBe(false);
            const duplicate = text.replace(renderRow(item, '    '), [renderRow(item, '    '), renderRow(item, '    ')].join('\n'));
            expect(permittedEdit(deleted, duplicate, snapshots, [], [item.key])).toBe(false);
        }
    });
    it('blocks changes to read-only events', () => {
        const readonly = { ...snapshots, [rows[0]!.key]: { ...rows[0]!, writable: false } };
        expect(permittedEdit(text, text.replace('90 min Weekly review', '90 min Changed'), readonly)).toBe(false);
        expect(permittedEdit(text, text.replace(renderRow(rows[0]!, '    ') + '\n', ''), readonly, [rows[0]!.key])).toBe(false);
    });
});
