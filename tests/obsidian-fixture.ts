// Test-only entry point. Never included in the production plugin bundle.
import GoogleDailyNotes from '../src/main';
import { event, item } from './fixtures';
import type { Item, Operation } from '../src/types';
import { CLIENT_SECRET_KEY, GoogleAuth } from '../src/auth';
import { cleanTitle, googleTitle } from '../src/markdown';

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
        this.data.settings.clientId = 'fixture.apps.googleusercontent.com';
        this.app.secretStorage.setSecret(CLIENT_SECRET_KEY, 'fixture-secret');
        this.app.secretStorage.setSecret('google-daily-notes-oauth', JSON.stringify({ clientId: this.data.settings.clientId,
            access: 'fixture-access', refresh: 'fixture-refresh', expires: Date.now() + 3600000 }));
        this.auth.dispose();
        this.auth = new GoogleAuth(this.app.secretStorage, () => this.data.settings.clientId,
            async () => ({ status: 200, json: { access_token: 'fixture-access', expires_in: 3600 } }), async () => undefined);
        // Items hold Google's plain titles; the real client escapes them on load.
        this.google.load = async () => { fixture.loads++; return { items: structuredClone(fixture.items).map(value => ({ ...value, title: cleanTitle(value.title) })), failed: [] }; };
        this.google.sources = async () => ({ calendars: this.data.settings.calendars, taskLists: this.data.settings.taskLists });
        this.google.removeCreationMarker = async () => undefined;
        this.google.patch = async operation => {
            fixture.operations.push(structuredClone(operation));
            const target = fixture.items.find(value => value.kind === operation.kind && value.source === operation.source && value.id === operation.id);
            if (target) {
                if (operation.title !== undefined) target.title = googleTitle(operation.title);
                if (operation.done !== undefined) target.done = operation.done;
            }
        };
        this.google.find = async () => [];
        this.google.insert = async operation => {
            fixture.operations.push(structuredClone(operation));
            const created = item({ id: `created-${fixture.operations.length}`, title: googleTitle(operation.title ?? ''), done: operation.done });
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
