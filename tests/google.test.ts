import { describe, expect, it, vi } from 'vitest';
import { GoogleClient } from '../src/google';
import type { HttpRequest, HttpResponse } from '../src/http';
import { initialData, type Operation } from '../src/types';

const operation: Operation = { key: 'key', kind: 'event', source: 'calendar@example.com', id: 'instance_20260919', path: '2026-09-19.md', done: true, marker: true };
const body = (request: HttpRequest) => JSON.parse(request.body!) as Record<string, unknown>;
function client(responses: HttpResponse[]) {
    const requests: HttpRequest[] = [];
    const transport = vi.fn(async (request: HttpRequest) => { requests.push(request); const response = responses.shift(); if (!response) throw new Error('Unexpected request'); return response; });
    return { api: new GoogleClient(transport, async () => 'test-token'), requests, transport };
}
const ok = (json: unknown): HttpResponse => ({ status: 200, json });

describe('Google API writes', () => {
    it('updates an occurrence summary only, with no invitations or scheduling edits', async () => {
        const h = client([ok({ summary: '⬜️ Review', etag: 'version', recurringEventId: 'series' }), ok({})]);
        await h.api.patch(operation);
        expect(h.requests[1]!.url).toContain('/events/instance_20260919?sendUpdates=none');
        expect(body(h.requests[1]!)).toEqual({ summary: '✅ Review' });
        expect(h.requests[1]!.headers?.['If-Match']).toBe('version');
    });
    it('preserves a remote checkmark when only renaming', async () => {
        const h = client([ok({ summary: '✅ Original' }), ok({})]);
        await h.api.patch({ ...operation, done: undefined, title: 'New title' });
        expect(body(h.requests[1]!)).toEqual({ summary: '✅ New title' });
    });
    it('does not duplicate a marker when marker semantics are disabled', async () => {
        const h = client([ok({ summary: '⬜️ Original' }), ok({})]);
        await h.api.patch({ ...operation, done: undefined, title: '⬜️ New title', marker: false });
        expect(body(h.requests[1]!)).toEqual({ summary: '⬜️ New title' });
    });
    it('re-reads after a conditional conflict before merging', async () => {
        const h = client([ok({ summary: '⬜️ Old', etag: 'v1' }), { status: 412, json: {} }, ok({ summary: '⬜️ Remote rename', etag: 'v2' }), ok({})]);
        await h.api.patch(operation);
        expect(body(h.requests[3]!)).toEqual({ summary: '✅ Remote rename' });
        expect(h.requests[3]!.headers?.['If-Match']).toBe('v2');
    });
    it('reopens a task without changing due, notes, or recurrence metadata', async () => {
        const h = client([ok({ etag: 'v1', due: '2026-09-19', notes: 'Keep this' }), ok({})]);
        await h.api.patch({ ...operation, kind: 'task', done: false });
        expect(body(h.requests[1]!)).toEqual({ status: 'needsAction', completed: null });
    });
    it('creates a dated task with a reconciliation token and no due time claim', async () => {
        const h = client([ok({ items: [] }), ok({ id: 'created' })]);
        const beforeInsert = vi.fn(async () => undefined);
        const result = await h.api.create({ ...operation, kind: 'task', title: '📅 13:00 Call', create: { date: '2026-09-19', phase: 'prepared' } }, beforeInsert);
        expect(beforeInsert).toHaveBeenCalledOnce();
        expect(result?.id).toBe('created');
        expect(body(h.requests[1]!)).toMatchObject({ title: '📅 13:00 Call', due: '2026-09-19T00:00:00.000Z', notes: '[google-daily-notes:key]' });
    });
    it('does not reinsert after an uncertain outcome', async () => {
        const h = client([ok({ items: [] })]);
        expect(await h.api.create({ ...operation, kind: 'task', create: { date: '2026-09-19', phase: 'sent' } }, async () => undefined)).toBeUndefined();
        expect(h.requests.every(request => !request.method || request.method === 'GET')).toBe(true);
    });
    it('reconciles a lost response and applies edits made while waiting', async () => {
        const h = client([ok({ items: [{ id: 'existing', notes: '[google-daily-notes:key]' }] }), ok({ id: 'existing', title: 'Old' }), ok({})]);
        const result = await h.api.create({ ...operation, kind: 'task', title: 'Latest', create: { date: '2026-09-19', phase: 'sent' } }, async () => undefined);
        expect(result?.id).toBe('existing');
        expect(h.requests.some(request => request.method === 'POST')).toBe(false);
        expect(body(h.requests[2]!).title).toBe('Latest');
    });
    it('does not retry a failed POST blindly', async () => {
        const h = client([ok({ items: [] }), { status: 503, json: {} }]);
        await expect(h.api.create({ ...operation, kind: 'task', create: { date: '2026-09-19', phase: 'prepared' } }, async () => undefined)).rejects.toThrow();
        expect(h.requests.filter(request => request.method === 'POST')).toHaveLength(1);
    });
    it('does not insert a draft cancelled during the reconciliation lookup', async () => {
        const h = client([ok({ items: [] })]);
        expect(await h.api.create({ ...operation, kind: 'task', create: { date: '2026-09-19', phase: 'prepared' } }, async () => false)).toBeUndefined();
        expect(h.requests).toHaveLength(1);
    });
    it('does not edit an uncertain task being reconciled for deletion', async () => {
        const h = client([ok({ items: [{ id: 'existing', notes: '[google-daily-notes:key]' }] })]);
        expect(await h.api.create({ ...operation, kind: 'task', remove: true, create: { date: '2026-09-19', phase: 'sent' } }, async () => undefined)).toEqual({ source: operation.source, id: 'existing' });
        expect(h.requests).toHaveLength(1);
    });
});

describe('Google deletions', () => {
    it('deletes a task directly by ID', async () => {
        const h = client([{ status: 204, json: {} }]);
        await h.api.remove({ ...operation, kind: 'task', remove: true });
        expect(h.requests[0]).toMatchObject({ method: 'DELETE', url: 'https://tasks.googleapis.com/tasks/v1/lists/calendar%40example.com/tasks/instance_20260919' });
        expect(h.requests[0]!.body).toBeUndefined();
    });
    it.each([{}, { recurringEventId: 'whole-series' }])('deletes only the selected calendar event or occurrence (%j)', async fields => {
        const h = client([ok({ id: operation.id, ...fields }), { status: 204, json: {} }]);
        await h.api.remove({ ...operation, remove: true });
        expect(h.requests[1]).toMatchObject({ method: 'DELETE', url: 'https://www.googleapis.com/calendar/v3/calendars/calendar%40example.com/events/instance_20260919?sendUpdates=none' });
        expect(h.requests.some(request => request.url.includes('whole-series'))).toBe(false);
    });
    it('refuses to delete a calendar series master', async () => {
        const h = client([ok({ recurrence: ['RRULE:FREQ=DAILY'] })]);
        await expect(h.api.remove({ ...operation, remove: true })).rejects.toThrow('entire series');
        expect(h.requests).toHaveLength(1);
    });
    it.each([404, 410])('treats an already deleted task as success (%i)', async status => {
        const h = client([{ status, json: {} }]);
        await expect(h.api.remove({ ...operation, kind: 'task', remove: true })).resolves.toBeUndefined();
    });
});

describe('creation marker cleanup', () => {
    it.each([
        ['[google-daily-notes:new:own]', ''],
        ['My notes\n[google-daily-notes:new:own]\nKeep this [google-daily-notes:new:other]', 'My notes\n\nKeep this [google-daily-notes:new:other]'],
    ])('removes only its own token from %s', async (notes, expected) => {
        const h = client([ok({ notes, etag: 'v1' }), ok({})]);
        await h.api.removeCreationMarker('new:own', 'list', 'task');
        expect(h.requests[1]!.url).toBe('https://tasks.googleapis.com/tasks/v1/lists/list/tasks/task');
        expect(body(h.requests[1]!)).toEqual({ notes: expected });
        expect(h.requests[1]!.headers?.['If-Match']).toBe('v1');
    });
    it('preserves description edits made during cleanup', async () => {
        const h = client([
            ok({ notes: '[google-daily-notes:new:own]', etag: 'v1' }), { status: 412, json: {} },
            ok({ notes: 'New user description [google-daily-notes:new:own]', etag: 'v2' }), ok({}),
        ]);
        await h.api.removeCreationMarker('new:own', 'list', 'task');
        expect(body(h.requests[3]!)).toEqual({ notes: 'New user description ' });
        expect(h.requests[3]!.headers?.['If-Match']).toBe('v2');
    });
    it.each([ok({ notes: 'Already clean' }), ok({ deleted: true }), { status: 404, json: {} }, { status: 410, json: {} }])('skips an absent marker or deleted task (%j)', async response => {
        const h = client([response]);
        await h.api.removeCreationMarker('new:own', 'list', 'task');
        expect(h.requests).toHaveLength(1);
        expect(h.requests[0]!.method).toBe('GET');
    });
    it('keeps cleanup pending when the description cannot be changed safely', async () => {
        const h = client([ok({ notes: '[google-daily-notes:new:own]' })]);
        await expect(h.api.removeCreationMarker('new:own', 'list', 'task')).rejects.toThrow('safely');
        expect(h.requests).toHaveLength(1);
    });
});

describe('Google API reads', () => {
    it('paginates sources and carries permissions', async () => {
        // sources() fetches calendars and task lists concurrently.
        const h = client([ok({ items: [{ id: 'cal', summary: 'Calendar', accessRole: 'reader' }], nextPageToken: 'page2' }), ok({ items: [{ id: 'list', title: 'Tasks' }] }), ok({ items: [{ id: 'write', summary: 'Writable', accessRole: 'writer' }] })]);
        const result = await h.api.sources();
        expect(result.calendars).toHaveLength(2);
        expect(result.calendars[0]?.writable).toBe(false);
        expect(result.calendars[1]?.writable).toBe(true);
        expect(h.requests[2]!.url).toContain('pageToken=page2');
    });
    it('loads recurring instances and completed tasks from Google first-party clients', async () => {
        const h = client([ok({ items: [] }), ok({ items: [] })]);
        const settings = initialData().settings;
        settings.calendars = [{ id: 'cal', name: 'Cal', role: 'recurring', writable: true }];
        settings.taskLists = [{ id: 'list', name: 'Tasks', enabled: true }];
        await h.api.load('2026-09-19', settings, []);
        const events = new URL(h.requests[0]!.url);
        const tasks = new URL(h.requests[1]!.url);
        expect(events.searchParams.get('singleEvents')).toBe('true');
        expect(events.searchParams.has('timeMin')).toBe(false);
        expect(tasks.searchParams.get('showCompleted')).toBe('true');
        expect(tasks.searchParams.get('showHidden')).toBe('true');
        expect(tasks.searchParams.get('showAssigned')).toBe('true');
    });
});
