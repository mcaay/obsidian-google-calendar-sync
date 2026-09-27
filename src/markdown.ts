import { validDate } from './dates';
import { base64url, fromBase64url } from './encoding';
import type { Edit, Item, Kind, Section } from './types';

export const SECTIONS: Section[] = ['events', 'recurring', 'tasks'];
// Hide exactly the separator before metadata, not spaces the user just typed.
// Swallowing all trailing spaces would push the insertion cursor past the ID.
export const ROW_ID = /[ \t]<!-- gdn:([A-Za-z0-9_:-]+) -->[ \t]*$/;
const HEADING = /^([ \t]*)- .+ <!-- gdn:(events|recurring|tasks) -->[ \t]*$/;
const CHECKBOX_ROW = /^[ \t]*- \[[ xX]\] /;
export const TEMPLATE = `- [ ] google events <!-- gdn:events -->
- [ ] recurring <!-- gdn:recurring -->
- [ ] google tasks <!-- gdn:tasks -->
`;

export interface Line {
    text: string;
    from: number;
    to: number;
    number: number;
    // Inside a fenced code block: never a synced row or a task draft.
    fenced?: boolean;
}

export interface Region {
    section: Section;
    heading: Line;
    from: number;
    to: number;
    indent: string;
    // Indentation width of the heading, and the widest direct child.
    parentWidth: number;
    childWidth: number;
    lines: Line[];
}

export function lines(text: string): Line[] {
    let offset = 0;
    return text.split('\n').map((value, index) => {
        const line = { text: value.replace(/\r$/, ''), from: offset, to: offset + value.replace(/\r$/, '').length, number: index };
        offset += value.length + 1;
        return line;
    });
}

export function noteDate(text: string, basename: string): string | undefined {
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1];
    if (!frontmatter || !/^google-daily:\s*true\s*$/m.test(frontmatter)) return undefined;
    const explicit = /^google-daily-date:[ \t]*(.*)$/m.exec(frontmatter)?.[1];
    const date = explicit === undefined ? basename : explicit.trim().replace(/^["']|["']$/g, '');
    return validDate(date) ? date : undefined;
}

export function enableNote(text: string): string {
    const crlf = text.includes('\r\n');
    const newline = crlf ? '\r\n' : '\n';
    const rows = text.split('\n');
    if (rows[0]?.replace(/\r$/, '') !== '---') return `---${newline}google-daily: true${newline}---${newline}${text}`;
    const close = rows.findIndex((row, index) => index > 0 && row.replace(/\r$/, '') === '---');
    if (close < 0) throw new Error('Close the existing frontmatter before inserting Google sections.');
    // Edit whole lines by index. String.replace would interpret `$'` in values.
    const existing = rows.findIndex((row, index) => index > 0 && index < close && /^google-daily:/.test(row));
    const property = `google-daily: true${crlf ? '\r' : ''}`;
    if (existing >= 0) rows[existing] = property;
    else rows.splice(close, 0, property);
    return rows.join('\n');
}

export function indentWidth(line: string, tabWidth = 4): number {
    let width = 0;
    for (const character of /^[ \t]*/.exec(line)![0]) width += character === '\t' ? tabWidth - (width % tabWidth) : 1;
    return width;
}

// An inline marker identifies a parent list item. Its indented children form
// the managed region, ending at the next nonblank line at the parent's level.
// This avoids extra physical lines that Vim could land on but the user cannot see.
export function regions(text: string, indentUnit = '    ', tabWidth = 4): Region[] {
    return scan(text, indentUnit, tabWidth).regions;
}

function scan(text: string, indentUnit: string, tabWidth: number): { regions: Region[]; openFence: boolean } {
    const result: Region[] = [];
    let current: Region | undefined;
    let fence: { character: string; length: number } | undefined;
    for (const line of lines(text)) {
        if (line.from >= text.length) break;
        if (current && !fence && line.text.trim() && indentWidth(line.text, tabWidth) <= current.parentWidth) {
            current.to = line.from;
            current = undefined;
        }
        const matchFence = /^\s*(`{3,}|~{3,})/.exec(line.text)?.[1];
        if (fence || matchFence) {
            if (!fence) fence = { character: matchFence![0]!, length: matchFence!.length };
            else if (matchFence && matchFence[0] === fence.character && matchFence.length >= fence.length) fence = undefined;
            if (current) current.lines.push({ ...line, fenced: true });
            continue;
        }
        const marker = HEADING.exec(line.text);
        if (marker) {
            const section = marker[2] as Section;
            if (current || result.some(region => region.section === section)) throw new Error('Daily note has duplicate or nested Google section markers.');
            const parentWidth = indentWidth(line.text, tabWidth);
            current = {
                section, heading: line, from: Math.min(text.length, line.to + (text.slice(line.to, line.to + 2) === '\r\n' ? 2 : 1)),
                to: text.length, indent: marker[1]! + indentUnit, parentWidth,
                childWidth: parentWidth + Math.max(1, indentWidth(indentUnit, tabWidth)), lines: [],
            };
            result.push(current);
        } else if (current) current.lines.push(line);
    }
    return { regions: result, openFence: Boolean(fence) };
}

export function itemKey(kind: Kind, source: string, id: string): string {
    return base64url(new TextEncoder().encode(JSON.stringify([kind, source, id])));
}

// Row keys encode their Google identity, so a pasted or foreign row can be
// recognised without a local snapshot.
export function parseItemKey(key: string): { kind: Kind; source: string; id: string } | undefined {
    if (key.startsWith('new:')) return undefined;
    try {
        const value = JSON.parse(new TextDecoder().decode(fromBase64url(key))) as unknown;
        if (Array.isArray(value)) {
            const [kind, source, id] = value as unknown[];
            if ((kind === 'event' || kind === 'task') && typeof source === 'string' && typeof id === 'string') return { kind, source, id };
        }
    } catch { /* Not an item key. */ }
    return undefined;
}

export function rowKey(line: string): string | undefined {
    return ROW_ID.exec(line)?.[1];
}

export function visibleRow(line: string): { title: string; done?: boolean } | undefined {
    const clean = line.replace(ROW_ID, '');
    const match = /^\s*- (?:\[([ xX])\] )?(.*)$/.exec(clean);
    if (!match) return undefined;
    return { title: match[2]!, done: match[1] === undefined ? undefined : match[1].toLowerCase() === 'x' };
}

export function readRow(line: string, item: Item): Edit | undefined {
    const visible = visibleRow(line);
    if (!visible || !visible.title.startsWith(item.prefix)) return undefined;
    return { title: visible.title.slice(item.prefix.length).trim(), done: item.done === undefined ? undefined : visible.done };
}

// Only a checkbox row directly under the tasks heading can become a Google Task.
// Plain text, other bullets, nested lines and code blocks stay local.
export function isTaskRow(region: Region, line: Line, tabWidth = 4): boolean {
    if (region.section !== 'tasks' || line.fenced || !CHECKBOX_ROW.test(line.text)) return false;
    const width = indentWidth(line.text, tabWidth);
    return width > region.parentWidth && width <= region.childWidth;
}

/**
 * Google titles are plain text; note text is Markdown. Titles from Google
 * escape HTML, embeds and inline code with backslashes, so an invitation or an
 * assigned task cannot make a note load remote content. Links and emphasis
 * still work. googleTitle() undoes only these sequences, so any other backslash
 * a user types reaches Google unchanged.
 * Ordinary: `![](https://x/p.png)` becomes `\![](https://x/p.png)`, a link.
 * Tricky: `a\<b` becomes `a\\\<b` and returns to Google as `a\<b`.
 */
export function cleanTitle(title: string): string {
    const flat = title.replace(/[\r\n]+/g, ' ').trim();
    let result = '';
    for (let index = 0; index < flat.length; index++) {
        const character = flat[index]!;
        const special = (at: number) => flat[at] === '<' || flat[at] === '`' || (flat[at] === '!' && flat[at + 1] === '[');
        if (special(index) || (character === '\\' && (flat[index + 1] === '\\' || special(index + 1)))) result += '\\';
        result += character;
    }
    return result;
}

export function googleTitle(title: string): string {
    // Earlier versions escaped only comment delimiters this way.
    const legacy = title.replace(/&lt;!--/g, '<!--').replace(/--&gt;/g, '-->');
    return legacy.replace(/\\(\\|<|`|!(?=\[))/g, '$1');
}

export function renderRow(item: Item, indent: string): string {
    return `${indent}- ${item.done === undefined ? '' : `[${item.done ? 'x' : ' '}] `}${item.prefix}${item.title} <!-- gdn:${item.key} -->`;
}

function order(a: Item, b: Item): number {
    return a.sort.localeCompare(b.sort) || a.key.localeCompare(b.key);
}

/**
 * Writes Google items into each group. Calendar groups stay chronological.
 * Task rows keep the order the user gave them; a new task from Google goes
 * before the first existing row that sorts after it. Unlinked text, drafts,
 * nested lines and code blocks stay where they are. `keep` names rows of
 * sources that could not be read; they stay as they are.
 */
export function renderNote(text: string, items: Item[], indentUnit = '    ', tabWidth = 4, keep: ReadonlySet<string> = new Set()): string {
    const newline = text.includes('\r\n') ? '\r\n' : '\n';
    let result = text;
    for (const region of regions(text, indentUnit, tabWidth).reverse()) {
        const managed = new Map(items.filter(item => item.section === region.section).map(item => [item.key, item]));
        const rows: { text: string; item?: Item }[] = [];
        const placed = new Set<string>();
        for (const line of region.lines) {
            const key = line.fenced ? undefined : rowKey(line.text);
            if (!key) { rows.push({ text: line.text }); continue; }
            // A duplicate left behind by a merge or an undo collapses into one row.
            if (placed.has(key)) continue;
            const item = managed.get(key);
            if (item) rows.push({ text: renderRow(item, region.indent), item });
            // A failed or ambiguous task creation keeps its local marker until
            // its remote identity is known.
            else if (key.startsWith('new:') || keep.has(key)) rows.push({ text: line.text });
            else continue;
            placed.add(key);
        }
        const added = [...managed.values()].filter(item => !placed.has(item.key)).sort(order);
        if (region.section === 'tasks') {
            for (const item of added) {
                let index = rows.findIndex(row => row.item && order(row.item, item) > 0);
                if (index < 0) index = rows.reduce((last, row, position) => row.text.trim() ? position + 1 : last, 0);
                rows.splice(index, 0, { text: renderRow(item, region.indent), item });
            }
        } else {
            const events = rows.filter(row => row.item).concat(added.map(item => ({ text: renderRow(item, region.indent), item })));
            events.sort((a, b) => order(a.item!, b.item!));
            rows.splice(0, rows.length, ...events, ...rows.filter(row => !row.item));
        }
        const body = rows.map(row => row.text).join(newline);
        const separator = region.from > 0 && text[region.from - 1] !== '\n' && body ? newline : '';
        result = result.slice(0, region.from) + separator + (body ? body + newline : '') + result.slice(region.to);
    }
    return result;
}

/**
 * Minimal whole-line changes from `before` to `after`. Each hunk replaces the
 * text from the end of the line before it to the start of the line after it,
 * including both line breaks. CodeMirror maps undo history through changes made
 * outside history; a hunk that cut into text the user inserted would leave a
 * fragment glued to a neighbouring row when that insertion is undone. A hunk
 * covering whole lines and both breaks can only leave a blank line.
 */
export function lineChanges(before: string, after: string): { from: number; to: number; insert: string }[] {
    if (before === after) return [];
    const a = before.split('\n');
    const b = after.split('\n');
    const starts: number[] = [];
    for (let index = 0, offset = 0; index <= a.length; offset += (a[index]?.length ?? 0) + 1, index++) starts.push(offset);
    let head = 0;
    while (head < a.length && head < b.length && a[head] === b[head]) head++;
    let tailA = a.length;
    let tailB = b.length;
    while (tailA > head && tailB > head && a[tailA - 1] === b[tailB - 1]) { tailA--; tailB--; }
    const hunks: { a: [number, number]; b: [number, number] }[] = [];
    const n = tailA - head;
    const m = tailB - head;
    if (n * m > 4_000_000) hunks.push({ a: [head, tailA], b: [head, tailB] });
    else {
        // Longest common subsequence over the changed middle lines.
        const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
        for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
            table[i]![j] = a[head + i] === b[head + j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
        }
        let i = 0;
        let j = 0;
        let start: [number, number] | undefined;
        const flush = () => { if (start) hunks.push({ a: [head + start[0], head + i], b: [head + start[1], head + j] }); start = undefined; };
        while (i < n || j < m) {
            if (i < n && j < m && a[head + i] === b[head + j]) { flush(); i++; j++; }
            else {
                start ??= [i, j];
                if (j < m && (i === n || table[i]![j + 1]! >= table[i + 1]![j]!)) j++;
                else i++;
            }
        }
        flush();
    }
    return hunks.map(({ a: [fromLine, toLine], b: [fromNew, toNew] }) => {
        const inserted = b.slice(fromNew, toNew).join('\n');
        const hasBefore = fromLine > 0;
        const hasAfter = toLine < a.length;
        const from = hasBefore ? starts[fromLine]! - 1 : 0;
        const to = hasAfter ? starts[toLine]! : before.length;
        if (hasBefore && hasAfter) return { from, to, insert: toNew > fromNew ? `\n${inserted}\n` : '\n' };
        if (hasBefore) return { from, to, insert: toNew > fromNew ? `\n${inserted}` : '' };
        if (hasAfter) return { from, to, insert: toNew > fromNew ? `${inserted}\n` : '' };
        return { from, to, insert: inserted };
    });
}

export interface RowRef {
    key: string;
    section: Section;
    line: Line;
}

export function syncedRows(parsed: Region[]): RowRef[] {
    return parsed.flatMap(region => region.lines.flatMap(line => {
        const key = line.fenced ? undefined : rowKey(line.text);
        return key ? [{ key, section: region.section, line }] : [];
    }));
}

export interface EditContext {
    snapshots: Record<string, Item>;
    // Keys of rows a user event removed completely.
    deleted: string[];
    // The plugin's own o, O or Enter inserted an owned draft.
    draftInsert: boolean;
    newKey(): string;
    indentUnit: string;
    tabWidth: number;
}

export interface EditCheck {
    // Why the edit is rejected, for a notice.
    block?: string;
    // Draft markers to add in the same transaction, in `after` positions.
    changes: { from: number; to: number; insert: string }[];
}

export const BLOCKED = {
    group: 'Google groups stay in an enabled note. To remove them, set google-daily: false first.',
    duplicate: 'Each Google group can appear only once in a note.',
    identity: 'Synced rows keep their hidden ID. Delete the whole row to delete the item.',
    readOnly: 'This calendar is read-only.',
    event: 'Calendar events cannot be created from a note. Undo within 5 seconds keeps a deleted event.',
    structure: 'Calendar groups contain only Google events. Add your notes outside them.',
    order: 'Calendar rows stay in time order.',
    split: 'A synced row cannot be split. Press Enter at the end of a task to add one below it.',
    unknown: 'This row is waiting for its first sync.',
};

/**
 * How to read this code:
 * 1. editorExtension() in src/editor.ts calls checkEdit() for each local editor
 *    transaction except undo and redo, which Obsidian never filters.
 * 2. A note whose groups are already malformed stays editable so it can be
 *    repaired. Adding groups is allowed; removing one is not, unless an unclosed
 *    code fence merely hides it while every row still exists.
 * 3. Removed rows must be whole-row deletions of writable rows. Rows the edit
 *    brings in with an existing ID (a paste) get a new draft key and become new
 *    tasks. Calendar rows can never be added.
 * 4. A keyless checkbox row that the edit produces directly under the tasks
 *    heading gets an owned draft key in the same transaction.
 * Ordinary: typing `- [ ] Call` claims the row as a new task.
 * Tricky: `ddp` deletes the task after 5 seconds and the paste creates a new one.
 */
export function checkEdit(before: string, after: string, touched: [number, number][], context: EditContext): EditCheck {
    const { indentUnit, tabWidth } = context;
    let oldRegions: Region[];
    try { oldRegions = regions(before, indentUnit, tabWidth); } catch { return { changes: [] }; }
    let scanned: { regions: Region[]; openFence: boolean };
    try { scanned = scan(after, indentUnit, tabWidth); } catch { return { block: BLOCKED.duplicate, changes: [] }; }
    const newRegions = scanned.regions;
    const oldRows = syncedRows(oldRegions);
    if (oldRegions.some(old => !newRegions.some(region => region.section === old.section))) {
        const hidden = scanned.openFence && oldRegions.every(old => after.includes(`<!-- gdn:${old.section} -->`))
            && oldRows.every(row => after.includes(`<!-- gdn:${row.key} -->`));
        return hidden ? { changes: [] } : { block: BLOCKED.group, changes: [] };
    }
    const newRows = syncedRows(newRegions);
    const count = (rows: RowRef[]) => rows.reduce((counts, row) => counts.set(row.key, (counts.get(row.key) ?? 0) + 1), new Map<string, number>());
    const oldCount = count(oldRows);
    const newCount = count(newRows);
    const touches = (line: Line) => touched.some(([from, to]) => from <= line.to && to >= line.from);
    const changes: EditCheck['changes'] = [];
    for (const row of oldRows) {
        const section = newRows.find(next => next.key === row.key)?.section;
        if (section === undefined) {
            if (!context.deleted.includes(row.key)) return { block: BLOCKED.identity, changes: [] };
            if (row.key.startsWith('new:')) continue;
            const item = context.snapshots[row.key];
            if (!item) return { block: BLOCKED.unknown, changes: [] };
            if (!item.writable) return { block: BLOCKED.readOnly, changes: [] };
        } else if (section !== row.section) return { block: BLOCKED.identity, changes: [] };
    }
    const added = new Map<string, number>();
    for (const row of newRows) {
        const extra = (newCount.get(row.key) ?? 0) - (oldCount.get(row.key) ?? 0);
        // Only a row this edit wrote is a paste. Rows that reappear untouched,
        // as when a code fence above them is closed, keep their keys.
        if (extra <= 0 || (added.get(row.key) ?? 0) >= extra || !touches(row.line)) continue;
        added.set(row.key, (added.get(row.key) ?? 0) + 1);
        if (context.draftInsert && row.key.startsWith('new:') && !oldCount.has(row.key)) continue;
        const kind = row.key.startsWith('new:') ? 'task' : parseItemKey(row.key)?.kind;
        if (row.section !== 'tasks' || kind !== 'task') return { block: BLOCKED.event, changes: [] };
        const match = ROW_ID.exec(row.line.text)!;
        const keyFrom = row.line.from + match.index + match[0].indexOf(row.key);
        changes.push({ from: keyFrom, to: keyFrom + row.key.length, insert: context.newKey() });
    }
    for (const previous of oldRegions) {
        const next = newRegions.find(region => region.section === previous.section)!;
        if (previous.section !== 'tasks') {
            const oldKeys = oldRows.filter(row => row.section === previous.section).map(row => row.key).filter(key => newCount.has(key));
            const newKeys = newRows.filter(row => row.section === previous.section).map(row => row.key);
            if (oldKeys.join() !== newKeys.join()) return { block: BLOCKED.order, changes: [] };
            const removed = oldRows.filter(row => row.section === previous.section && !newCount.has(row.key)).length;
            if (previous.lines.filter(line => line.text.trim()).length - removed !== next.lines.filter(line => line.text.trim()).length) return { block: BLOCKED.structure, changes: [] };
        }
        for (const line of next.lines) {
            if (line.fenced || !touches(line)) continue;
            const key = rowKey(line.text);
            if (key) {
                const old = oldRows.find(row => row.key === key && row.section === previous.section);
                if (!old || old.line.text === line.text || added.has(key)) continue;
                const item = context.snapshots[key];
                if (!item) { if (key.startsWith('new:')) continue; return { block: BLOCKED.unknown, changes: [] }; }
                if (!item.writable) return { block: BLOCKED.readOnly, changes: [] };
                const parsed = readRow(line.text, item);
                if (!parsed || (item.done === undefined && visibleRow(line.text)?.done !== undefined)) return { block: BLOCKED.identity, changes: [] };
                if (item.done !== undefined && parsed.done === undefined) return { block: BLOCKED.identity, changes: [] };
            } else if (isTaskRow(next, line, tabWidth)) changes.push({ from: line.to, to: line.to, insert: ` <!-- gdn:${context.newKey()} -->` });
        }
    }
    for (const region of newRegions) {
        if (oldRegions.some(old => old.section === region.section) || region.section !== 'tasks') continue;
        // A group added by this edit, for example a pasted template with rows.
        for (const line of region.lines) {
            if (!touches(line) || rowKey(line.text) || !isTaskRow(region, line, tabWidth)) continue;
            changes.push({ from: line.to, to: line.to, insert: ` <!-- gdn:${context.newKey()} -->` });
        }
    }
    return { changes: changes.sort((a, b) => a.from - b.from) };
}

// A line break inserted between a synced row's start and its hidden ID would
// leave the visible title on a line without identity.
export function splitsRow(before: string, change: { from: number; to: number; inserted: string }, indentUnit: string, tabWidth: number): boolean {
    if (!change.inserted.includes('\n')) return false;
    let parsed: Region[];
    try { parsed = regions(before, indentUnit, tabWidth); } catch { return false; }
    return syncedRows(parsed).some(({ line }) => {
        const idFrom = line.from + ROW_ID.exec(line.text)!.index;
        return change.from > line.from && change.from <= idFrom && change.to <= idFrom;
    });
}
