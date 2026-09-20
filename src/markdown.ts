import { validDate } from './dates';
import type { Edit, Item, Section } from './types';

export const SECTIONS: Section[] = ['events', 'recurring', 'tasks'];
// Hide exactly the separator before metadata, not spaces the user just typed.
// Swallowing all trailing spaces would push the insertion cursor past the ID.
export const ROW_ID = /[ \t]<!-- gdn:([A-Za-z0-9_:-]+) -->[ \t]*$/;
export const TEMPLATE = `- [ ] google events <!-- gdn:events -->
- [ ] recurring <!-- gdn:recurring -->
- [ ] google tasks <!-- gdn:tasks -->
`;

export interface Line {
    text: string;
    from: number;
    to: number;
    number: number;
}

export interface Region {
    section: Section;
    heading: Line;
    from: number;
    to: number;
    indent: string;
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
    const newline = text.includes('\r\n') ? '\r\n' : '\n';
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
    if (!frontmatter) {
        if (text.startsWith('---\n') || text.startsWith('---\r\n')) throw new Error('Close the existing frontmatter before inserting Google sections.');
        return `---${newline}google-daily: true${newline}---${newline}${text}`;
    }
    const properties = frontmatter[1]!;
    const updated = /^google-daily:/m.test(properties)
        ? properties.replace(/^google-daily:.*$/m, 'google-daily: true')
        : properties + newline + 'google-daily: true';
    return text.replace(frontmatter[0], frontmatter[0].replace(properties, updated));
}

// An inline marker identifies a parent list item. Its indented children form
// the managed region, ending at the next nonblank line at the parent's level.
// This avoids extra physical lines that Vim could land on but the user cannot see.
export function regions(text: string, indentUnit = '    '): Region[] {
    const result: Region[] = [];
    let current: Region | undefined;
    let parentIndent = 0;
    let fence: { character: string; length: number } | undefined;
    const indentation = (value: string) => (/^[ \t]*/.exec(value)![0]).replace(/\t/g, '    ').length;
    for (const line of lines(text)) {
        if (line.from >= text.length) break;
        if (current && line.text.trim() && indentation(line.text) <= parentIndent) {
            current.to = line.from;
            current = undefined;
        }
        const matchFence = /^\s*(`{3,}|~{3,})/.exec(line.text)?.[1];
        if (matchFence) {
            if (!fence) fence = { character: matchFence[0]!, length: matchFence.length };
            else if (matchFence[0] === fence.character && matchFence.length >= fence.length) fence = undefined;
            if (current) current.lines.push(line);
            continue;
        }
        if (fence) { if (current) current.lines.push(line); continue; }
        const marker = /^([ \t]*)- .+ <!-- gdn:(events|recurring|tasks) -->[ \t]*$/.exec(line.text);
        if (marker) {
            const section = marker[2] as Section;
            if (current || result.some(region => region.section === section)) throw new Error('Daily note has duplicate or nested Google section markers.');
            parentIndent = indentation(line.text);
            current = {
                section, heading: line, from: Math.min(text.length, line.to + (text.slice(line.to, line.to + 2) === '\r\n' ? 2 : 1)),
                to: text.length, indent: marker[1]! + indentUnit, lines: [],
            };
            result.push(current);
        } else if (current) current.lines.push(line);
    }
    return result;
}

export function itemKey(kind: 'event' | 'task', source: string, id: string): string {
    return Buffer.from(JSON.stringify([kind, source, id])).toString('base64url');
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

export function cleanTitle(title: string): string {
    // Newlines and HTML comment delimiters are structural in Markdown.
    return title.replace(/[\r\n]+/g, ' ').replace(/<!--/g, '&lt;!--').replace(/-->/g, '--&gt;').trim();
}

export function googleTitle(title: string): string {
    return title.replace(/&lt;!--/g, '<!--').replace(/--&gt;/g, '-->');
}

export function renderRow(item: Item, indent: string): string {
    return `${indent}- ${item.done === undefined ? '' : `[${item.done ? 'x' : ' '}] `}${item.prefix}${item.title} <!-- gdn:${item.key} -->`;
}

export function renderNote(text: string, items: Item[], indentUnit = '    '): string {
    const newline = text.includes('\r\n') ? '\r\n' : '\n';
    let result = text;
    for (const region of regions(text, indentUnit).reverse()) {
        const managed = items.filter(item => item.section === region.section).sort((a, b) => a.sort.localeCompare(b.sort) || a.key.localeCompare(b.key));
        // Preserve all unlinked text, including drafts. A failed or ambiguous task
        // creation keeps its local marker until its remote identity is known.
        const preserved = region.lines.filter(line => !rowKey(line.text) || (rowKey(line.text)?.startsWith('new:') && !managed.some(item => item.key === rowKey(line.text))));
        const body = [...managed.map(item => renderRow(item, region.indent)), ...preserved.map(line => line.text)].join(newline);
        const separator = region.from > 0 && text[region.from - 1] !== '\n' && body ? newline : '';
        result = result.slice(0, region.from) + separator + (body ? body + newline : '') + result.slice(region.to);
    }
    return result;
}

export function draftTitle(line: string): { title: string; done: boolean } | undefined {
    if (rowKey(line) || !line.trim() || line.trim().startsWith('<!--')) return undefined;
    const row = visibleRow(line);
    const title = (row?.title ?? line.trim().replace(/^-\s*/, '')).trim();
    return title ? { title, done: row?.done ?? false } : undefined;
}

/** Protect row identity and calendar structure while allowing ordinary title edits. */
export function permittedEdit(before: string, after: string, snapshots: Record<string, Item>, deletedKeys: string[] = [], restoredKeys: string[] = []): boolean {
    try {
        const oldRegions = regions(before);
        const newRegions = regions(after);
        if (oldRegions.length !== newRegions.length) return false;
        for (const previous of oldRegions) {
            const next = newRegions.find(region => region.section === previous.section);
            if (!next) return false;
            const oldIds = previous.lines.map(line => rowKey(line.text)).filter((key): key is string => Boolean(key));
            const newIds = next.lines.map(line => rowKey(line.text)).filter((key): key is string => Boolean(key));
            const keptIds = oldIds.filter(key => !deletedKeys.includes(key));
            const restored = newIds.filter(key => !oldIds.includes(key) && restoredKeys.includes(key));
            const remainingIds = newIds.filter(key => !restored.includes(key));
            if (new Set(newIds).size !== newIds.length || keptIds.length !== remainingIds.length || keptIds.some((key, index) => key !== remainingIds[index])) return false;
            const removedCount = oldIds.length - keptIds.length;
            if (previous.section !== 'tasks' && previous.lines.filter(line => line.text.trim()).length - removedCount + restored.length !== next.lines.filter(line => line.text.trim()).length) return false;
            for (const key of restored) {
                const item = snapshots[key];
                const line = next.lines.find(line => rowKey(line.text) === key)!;
                if (!item?.writable || item.section !== previous.section || !readRow(line.text, item)) return false;
            }
            for (const oldLine of previous.lines) {
                const key = rowKey(oldLine.text);
                if (!key) continue;
                const newLine = next.lines.find(line => rowKey(line.text) === key);
                if (!newLine) {
                    if (!deletedKeys.includes(key) || (!snapshots[key]?.writable && !key.startsWith('new:'))) return false;
                    continue;
                }
                if (newLine.text === oldLine.text) continue;
                const item = snapshots[key];
                if (!item) { if (!key.startsWith('new:')) return false; continue; }
                if (!item.writable) return false;
                const parsed = readRow(newLine.text, item);
                if (!parsed || (item.done === undefined && visibleRow(newLine.text)?.done !== undefined)) return false;
                if (item.done !== undefined && parsed.done === undefined) return false;
            }
        }
        return true;
    } catch { return false; }
}
