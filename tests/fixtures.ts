import { initialData, type Item, type PluginData } from '../src/types';
import { itemKey, renderNote, TEMPLATE } from '../src/markdown';

export const DATE = '2026-09-19';
export const PATH = `${DATE}.md`;
export const EMPTY = `---\ngoogle-daily: true\n---\n# Daily note\n\nMy own text.\n\n${TEMPLATE}\nOutside the sections.\n`;

export function item(values: Partial<Item> = {}): Item {
    const result: Item = {
        key: '', kind: 'task', source: 'list', id: 'task-1', section: 'tasks',
        title: 'Buy coffee', done: false, prefix: '', date: DATE, writable: true, sort: DATE,
        ...values,
    };
    result.key ||= itemKey(result.kind, result.source, result.id);
    return result;
}

export function event(values: Partial<Item> = {}): Item {
    return item({ kind: 'event', source: 'calendar', id: 'instance_20260919', section: 'recurring', title: 'Weekly review', prefix: '90 min ', ...values });
}

export function seeded(items: Item[]): { data: PluginData; text: string } {
    const data = initialData();
    data.runtimeOwner = 'device';
    data.settings.timeZone = 'Europe/Warsaw';
    data.settings.defaultTaskList = 'list';
    data.settings.taskLists = [{ id: 'list', name: 'Tasks', enabled: true }];
    data.notes[PATH] = { rows: Object.fromEntries(items.map(value => [value.key, structuredClone(value)])) };
    return { data, text: renderNote(EMPTY, items) };
}

// A task row typed under the tasks heading, with the owned key the editor adds.
export function withDraft(text: string, title: string, key = 'new:device:1', done = false): string {
    return text.replace('<!-- gdn:tasks -->\n', `<!-- gdn:tasks -->\n    - [${done ? 'x' : ' '}] ${title} <!-- gdn:${key} -->\n`);
}
