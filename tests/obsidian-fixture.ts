// Test-only entry point. Never included in the production plugin bundle.
import GoogleDailyNotes from '../src/main';
import { event, item } from './fixtures';
import type { Item, Operation } from '../src/types';

interface TestState { items: Item[]; operations: Operation[]; loads: number }
declare global { interface Window { gdnTest?: TestState } }

export default class FixturePlugin extends GoogleDailyNotes {
    async onload(): Promise<void> {
        await super.onload();
        const fixture = window.gdnTest ??= {
            items: [
                event({ id: 'meeting', section: 'events', title: 'Planning meeting', done: undefined, prefix: '📅 13:00 (90 min) ' }),
                event(),
                event({ id: 'finished', title: 'Monthly report', prefix: '30 min ', done: true, sort: '2026-09-19 15:00' }),
                item(),
                item({ id: 'timed', title: '📅 12:00 Call Sam' }),
            ], operations: [], loads: 0,
        };
        this.data.settings.defaultTaskList = 'list';
        this.data.settings.calendars = [{ id: 'calendar', name: 'Example calendar', role: 'recurring', writable: true }];
        this.data.settings.taskLists = [{ id: 'list', name: 'Example tasks', enabled: true }];
        this.auth.connected = () => true;
        this.google.load = async () => { fixture.loads++; return structuredClone(fixture.items); };
        this.google.sources = async () => ({ calendars: this.data.settings.calendars, taskLists: this.data.settings.taskLists });
        this.google.removeCreationMarker = async () => undefined;
        this.google.patch = async operation => {
            fixture.operations.push(structuredClone(operation));
            const target = fixture.items.find(value => value.kind === operation.kind && value.source === operation.source && value.id === operation.id);
            if (target) {
                if (operation.title !== undefined) target.title = operation.title;
                if (operation.done !== undefined) target.done = operation.done;
            }
        };
        this.google.create = async (operation, beforeInsert) => {
            if (await beforeInsert() === false) return undefined;
            fixture.operations.push(structuredClone(operation));
            const created = item({ id: `created-${fixture.operations.length}`, title: operation.title, done: operation.done });
            fixture.items.push(created);
            return { source: created.source, id: created.id };
        };
        this.google.remove = async operation => {
            fixture.operations.push(structuredClone(operation));
            fixture.items = fixture.items.filter(item => !(item.kind === operation.kind && item.source === operation.source && item.id === operation.id));
        };
        await this.persist();
    }
}
