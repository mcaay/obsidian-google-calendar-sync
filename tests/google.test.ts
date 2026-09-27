import { describe, expect, it, vi } from 'vitest';
import { GoogleClient } from '../src/google';
import { errorReason, GoogleError, retryAfter, type HttpRequest, type HttpResponse } from '../src/http';
import { itemKey } from '../src/markdown';
import { initialData, type CalendarCache, type CalendarEvent, type Operation } from '../src/types';

const operation: Operation = { key: 'key', kind: 'event', source: 'calendar@example.com', id: 'instance_20260919', path: '2026-09-19.md', done: true, marker: true };
const body = (request: HttpRequest) => JSON.parse(request.body!) as Record<string, unknown>;
function client(responses: HttpResponse[], now = () => 1_000_000) {
    const requests: HttpRequest[] = [];
    const transport = vi.fn(async (request: HttpRequest) => { requests.push(request); const response = responses.shift(); if (!response) throw new Error('Unexpected request'); return response; });
    const token = vi.fn(async (_force?: boolean) => 'test-token');
    const sleep = vi.fn(async (_ms: number) => undefined);
    return { api: new GoogleClient(transport, token, sleep, now), requests, transport, token, sleep };
}
const ok = (json: unknown): HttpResponse => ({ status: 200, json });
const fail = (status: number, reason = '', headers?: Record<string, string>): HttpResponse => ({ status, json: { error: { errors: [{ reason }] } }, headers });

describe('Google API writes', () => {
    it('updates an occurrence summary only, with no invitations or scheduling edits', async () => {
        const h = client([ok({ summary: '⬜️ Review', etag: 'version', recurringEventId: 'series' }), ok({})]);
        await h.api.patch(operation);
        expect(h.requests[0]!.url).toContain('fields=id,summary,status,etag');
        expect(h.requests[1]!.url).toContain('/events/instance_20260919?sendUpdates=none');
        expect(body(h.requests[1]!)).toEqual({ summary: '✅ Review' });
        expect(h.requests[1]!.headers?.['If-Match']).toBe('version');
    });
    it('preserves a remote checkmark when only renaming', async () => {
        const h = client([ok({ summary: '✅ Original' }), ok({})]);
        await h.api.patch({ ...operation, done: undefined, title: 'New title' });
        expect(body(h.requests[1]!)).toEqual({ summary: '✅ New title' });
    });
    it('sends a Markdown-escaped title back as plain text (D7)', async () => {
        const h = client([ok({ summary: 'Old' }), ok({})]);
        await h.api.patch({ ...operation, done: undefined, marker: false, title: '\\<b> and \\![x](y)' });
        expect(body(h.requests[1]!)).toEqual({ summary: '<b> and ![x](y)' });
    });
    it('does not duplicate a marker when marker semantics are disabled', async () => {
        const h = client([ok({ summary: '⬜️ Original' }), ok({})]);
        await h.api.patch({ ...operation, done: undefined, title: '⬜️ New title', marker: false });
        expect(body(h.requests[1]!)).toEqual({ summary: '⬜️ New title' });
    });
    it('re-reads after a conditional conflict before merging', async () => {
        const h = client([ok({ summary: '⬜️ Old', etag: 'v1' }), fail(412), ok({ summary: '⬜️ Remote rename', etag: 'v2' }), ok({})]);
        await h.api.patch(operation);
        expect(body(h.requests[3]!)).toEqual({ summary: '✅ Remote rename' });
        expect(h.requests[3]!.headers?.['If-Match']).toBe('v2');
    });
    it('reopens a task without changing due, notes, or recurrence metadata', async () => {
        const h = client([ok({ etag: 'v1' }), ok({})]);
        await h.api.patch({ ...operation, kind: 'task', done: false });
        expect(body(h.requests[1]!)).toEqual({ status: 'needsAction', completed: null });
    });
    it('creates a dated task with one POST and no lookup (4.4)', async () => {
        const h = client([ok({ id: 'created' })]);
        const result = await h.api.insert({ ...operation, kind: 'task', title: '📅 13:00 Call', create: { date: '2026-09-19', phase: 'prepared' } });
        expect(result).toEqual({ source: operation.source, id: 'created' });
        expect(h.requests).toHaveLength(1);
        expect(h.requests[0]!.method).toBe('POST');
        expect(body(h.requests[0]!)).toMatchObject({ title: '📅 13:00 Call', due: '2026-09-19T00:00:00.000Z', notes: '[google-daily-notes:key]' });
    });
    it('never retries a failed POST', async () => {
        const h = client([fail(503)]);
        await expect(h.api.insert({ ...operation, kind: 'task', create: { date: '2026-09-19', phase: 'prepared' } })).rejects.toThrow();
        expect(h.requests).toHaveLength(1);
    });
    it('finds earlier attempts by marker, including deleted tasks, since the first attempt', async () => {
        const h = client([ok({ items: [{ id: 'mine', notes: 'x [google-daily-notes:key]' }, { id: 'other', notes: '[google-daily-notes:other]' }, { id: 'gone', deleted: true, notes: '[google-daily-notes:key]' }] })]);
        const found = await h.api.find({ ...operation, kind: 'task', create: { date: '2026-09-19', phase: 'uncertain', attempted: Date.parse('2026-09-19T10:00:00Z') } });
        expect(found.map(task => task.id)).toEqual(['mine', 'gone']);
        const url = new URL(h.requests[0]!.url);
        expect(url.searchParams.get('showDeleted')).toBe('true');
        expect(url.searchParams.get('showHidden')).toBe('true');
        expect(url.searchParams.get('updatedMin')).toBe('2026-09-18T10:00:00.000Z');
        const upgraded = client([ok({ items: [] })]);
        await upgraded.api.find({ ...operation, kind: 'task', create: { date: '2026-09-19', phase: 'uncertain' } });
        expect(new URL(upgraded.requests[0]!.url).searchParams.has('updatedMin')).toBe(false);
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
    it('refuses to delete a calendar series master, as an item refusal (D2)', async () => {
        const h = client([ok({ recurrence: ['RRULE:FREQ=DAILY'] })]);
        const error = await h.api.remove({ ...operation, remove: true }).catch((value: unknown) => value);
        expect(error).toBeInstanceOf(GoogleError);
        expect((error as GoogleError).failure).toBe('refused');
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
        const h = client([ok({ notes: '[google-daily-notes:new:own]', etag: 'v1' }), fail(412), ok({ notes: 'New user description [google-daily-notes:new:own]', etag: 'v2' }), ok({})]);
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

describe('errors, retries and backoff (2.5)', () => {
    it('reads the reason from old and new Google error bodies and survives HTML', () => {
        expect(errorReason({ error: { errors: [{ reason: 'rateLimitExceeded' }] } })).toBe('rateLimitExceeded');
        expect(errorReason({ error: { details: [{ reason: 'SERVICE_DISABLED' }], status: 'PERMISSION_DENIED' } })).toBe('SERVICE_DISABLED');
        expect(errorReason(undefined)).toBe('');
        expect(new GoogleError(503, errorReason(undefined)).failure).toBe('transient');
    });
    it.each([
        [403, 'rateLimitExceeded', 'quota'], [403, 'userRateLimitExceeded', 'quota'], [429, '', 'quota'],
        [403, 'accessNotConfigured', 'account'], [403, 'insufficientPermissions', 'account'],
        [403, 'forbidden', 'refused'], [400, 'invalid', 'refused'], [404, 'notFound', 'gone'], [502, '', 'transient'],
    ])('classifies %i %s as %s', (status, reason, failure) => expect(new GoogleError(status, reason).failure).toBe(failure));
    it('reads Retry-After in seconds or as a date', () => {
        expect(retryAfter({ 'Retry-After': '7' })).toBe(7000);
        expect(retryAfter({ 'retry-after': 'Thu, 01 Jan 1970 00:00:10 GMT' }, 4000)).toBe(6000);
        expect(retryAfter({})).toBeUndefined();
    });
    it('refreshes the token only after a 401', async () => {
        const h = client([fail(503), fail(401), ok({ summary: 'x' }), ok({})]);
        await h.api.patch({ ...operation, done: undefined, marker: false, title: 'x' });
        // The PATCH is a new request; it uses the token refreshed for the read.
        expect(h.token.mock.calls.map(([force]) => force)).toEqual([false, false, true, false]);
    });
    it('keeps the status of an HTML error page', async () => {
        const h = client([{ status: 502, json: undefined }, { status: 502, json: undefined }, { status: 502, json: undefined }]);
        const error = await h.api.patch({ ...operation, kind: 'task' }).catch((value: unknown) => value);
        expect((error as GoogleError).status).toBe(502);
    });
    it('honours Retry-After and then pauses every request for the account', async () => {
        let now = 1_000_000;
        const responses = [fail(429, '', { 'Retry-After': '5' }), fail(429, '', { 'Retry-After': '5' }), fail(403, 'rateLimitExceeded', { 'Retry-After': '120' })];
        const h = client(responses, () => now);
        await expect(h.api.patch({ ...operation, kind: 'task' })).rejects.toThrow('rate limit');
        expect(h.sleep.mock.calls.map(([ms]) => ms)).toEqual([5000, 5000]);
        await expect(h.api.remove({ ...operation, kind: 'task', remove: true })).rejects.toThrow();
        expect(h.requests).toHaveLength(3);
        now += 120_000;
        responses.push({ status: 204, json: {} });
        await h.api.remove({ ...operation, kind: 'task', remove: true });
        expect(h.requests).toHaveLength(4);
    });
});

describe('Google API reads', () => {
    const settings = () => {
        const value = initialData().settings;
        value.timeZone = 'Europe/Warsaw';
        value.calendars = [{ id: 'cal', name: 'Cal', role: 'recurring', writable: true }];
        value.taskLists = [{ id: 'list', name: 'Tasks', enabled: true }];
        return value;
    };
    it('paginates sources and carries permissions', async () => {
        // sources() fetches calendars and task lists concurrently.
        const h = client([ok({ items: [{ id: 'cal', summary: 'Calendar', accessRole: 'reader' }], nextPageToken: 'page2' }), ok({ items: [{ id: 'list', title: 'Tasks' }] }), ok({ items: [{ id: 'write', summary: 'Writable', accessRole: 'writer' }] })]);
        const result = await h.api.sources();
        expect(result.calendars).toHaveLength(2);
        expect(result.calendars[0]?.writable).toBe(false);
        expect(result.calendars[1]?.writable).toBe(true);
        expect(h.requests[2]!.url).toContain('pageToken=page2');
    });
    it('names the API whose sources could not be loaded', async () => {
        const h = client([ok({ items: [] }), fail(403, 'insufficientPermissions')]);
        await expect(h.api.sources()).rejects.toThrow('Could not load Google Tasks. Reconnect Google');
    });
    it('reads only the note’s day, earlier unfinished tasks and retained items (4.1, 4.2)', async () => {
        const value = settings();
        value.overdueEvents = false;
        const retainedTask = itemKey('task', 'list', 'done-last-week');
        const retainedEvent = itemKey('event', 'cal', 'checked-last-week');
        const h = client([
            ok({ items: [] }),
            ok({ id: 'checked-last-week', summary: '✅ Old', start: { dateTime: '2026-09-12T10:00:00+02:00' }, end: { dateTime: '2026-09-12T11:00:00+02:00' } }),
            ok({ items: [{ id: 'today', title: 'Today', due: '2026-09-19T00:00:00.000Z', status: 'completed' }] }),
            ok({ items: [{ id: 'late', title: 'Late', due: '2026-09-01T00:00:00.000Z', status: 'needsAction' }] }),
            ok({ id: 'done-last-week', title: 'Done', due: '2026-09-12T00:00:00.000Z', status: 'completed' }),
        ]);
        const loaded = await h.api.load('2026-09-19', value, [retainedTask, retainedEvent]);
        expect(loaded.items.map(item => item.id).sort()).toEqual(['checked-last-week', 'done-last-week', 'late', 'today']);
        const [events, event, today, overdue, task] = h.requests.map(request => new URL(request.url));
        expect(events!.searchParams.get('timeMin')).toBe('2026-09-18T22:00:00.000Z');
        expect(events!.searchParams.get('timeMax')).toBe('2026-09-19T22:00:00.000Z');
        expect(events!.searchParams.get('fields')).toContain('items(id,summary,status,etag,updated,recurringEventId,recurrence,start,end)');
        expect(event!.pathname).toContain('/events/checked-last-week');
        expect(today!.searchParams.get('dueMin')).toBe('2026-09-18T12:00:00.000Z');
        expect(today!.searchParams.get('dueMax')).toBe('2026-09-19T12:00:00.000Z');
        expect(today!.searchParams.get('showCompleted')).toBe('true');
        expect(today!.searchParams.get('showAssigned')).toBe('true');
        expect(overdue!.searchParams.get('showCompleted')).toBe('false');
        expect(overdue!.searchParams.has('dueMin')).toBe(false);
        expect(overdue!.searchParams.get('dueMax')).toBe('2026-09-18T12:00:00.000Z');
        expect(task!.pathname).toContain('/tasks/done-last-week');
        expect(task!.searchParams.get('fields')).toBe('id,title,status,due,notes,deleted,etag');
    });
    it('reports a source Google refuses and keeps loading the rest (2.2)', async () => {
        const value = settings();
        value.overdueEvents = false;
        value.overdueTasks = false;
        const h = client([fail(404, 'notFound'), ok({ items: [{ id: 'today', title: 'Today', due: '2026-09-19T00:00:00.000Z' }] })]);
        const loaded = await h.api.load('2026-09-19', value, []);
        expect(loaded.failed).toEqual([expect.objectContaining({ kind: 'event', source: 'cal', name: 'Cal' })]);
        expect(loaded.items.map(item => item.id)).toEqual(['today']);
    });
    it('fails the whole load on account, quota or network problems, so no rows disappear', async () => {
        const value = settings();
        value.overdueEvents = false;
        const h = client([fail(403, 'accessNotConfigured')]);
        await expect(h.api.load('2026-09-19', value, [])).rejects.toThrow('Enable the Google Calendar API');
    });
});

/**
 * A small Calendar server for the overdue cache: single events, recurring
 * series with instances, exceptions, deletions, `updated` stamps, `updatedMin`
 * and pagination, as the Calendar API documents them.
 */
class FakeCalendar {
    clock = Date.parse('2026-09-01T00:00:00Z');
    singles = new Map<string, CalendarEvent>();
    series = new Map<string, { master: CalendarEvent; instances: Map<string, CalendarEvent & { exception?: boolean }> }>();
    requests: URL[] = [];
    failOn?: (url: URL) => boolean;
    pageSize = 2;

    private tick(): string { this.clock += 60000; return new Date(this.clock).toISOString(); }
    private at(date: string, hour = 10): Pick<CalendarEvent, 'start' | 'end'> {
        return { start: { dateTime: `${date}T${String(hour).padStart(2, '0')}:00:00Z` }, end: { dateTime: `${date}T${String(hour + 1).padStart(2, '0')}:00:00Z` } };
    }
    add(id: string, summary: string, date: string): void { this.singles.set(id, { id, summary, status: 'confirmed', updated: this.tick(), ...this.at(date) }); }
    change(id: string, values: Partial<CalendarEvent>): void {
        const single = this.singles.get(id);
        if (single) { this.singles.set(id, { ...single, ...values, updated: this.tick() }); return; }
        for (const { instances } of this.series.values()) {
            const instance = instances.get(id);
            if (instance) instances.set(id, { ...instance, ...values, updated: this.tick(), exception: true });
        }
    }
    move(id: string, date: string): void { this.change(id, this.at(date)); }
    remove(id: string): void { this.change(id, { status: 'cancelled' }); }
    addSeries(id: string, summary: string, dates: string[]): void {
        const updated = this.tick();
        this.series.set(id, {
            master: { id, summary, status: 'confirmed', updated, recurrence: ['RRULE:FREQ=DAILY'], ...this.at(dates[0]!) },
            instances: new Map(dates.map(date => [`${id}_${date}`, { id: `${id}_${date}`, recurringEventId: id, summary, status: 'confirmed', updated, ...this.at(date) }])),
        });
    }
    editSeries(id: string, summary: string): void {
        const entry = this.series.get(id)!;
        const updated = this.tick();
        entry.master = { ...entry.master, summary, updated };
        for (const [key, instance] of entry.instances) if (!instance.exception) entry.instances.set(key, { ...instance, summary, updated });
    }
    removeSeries(id: string): void { const entry = this.series.get(id)!; entry.master = { ...entry.master, status: 'cancelled', updated: this.tick() }; }
    private get updated(): string { return new Date(this.clock).toISOString(); }

    respond(request: HttpRequest): HttpResponse {
        const url = new URL(request.url);
        this.requests.push(url);
        if (this.failOn?.(url)) throw new Error('Offline');
        const query = url.searchParams;
        const timeMin = query.get('timeMin');
        const timeMax = query.get('timeMax');
        const updatedMin = query.get('updatedMin');
        const start = (event: CalendarEvent) => event.start.dateTime!;
        const within = (event: CalendarEvent) => (!timeMax || start(event) < timeMax) && (!timeMin || event.end.dateTime! > timeMin);
        const visible = (event: CalendarEvent) => event.status !== 'cancelled' || Boolean(updatedMin) || query.get('showDeleted') === 'true';
        const changed = (event: CalendarEvent) => !updatedMin || event.updated! >= updatedMin;
        let items: CalendarEvent[];
        const instancesOf = /\/events\/([^/]+)\/instances$/.exec(url.pathname)?.[1];
        if (instancesOf) {
            const entry = this.series.get(decodeURIComponent(instancesOf))!;
            items = [...entry.instances.values()].filter(event => event.status !== 'cancelled' && within(event));
        } else if (query.get('singleEvents') === 'true') {
            const instances = [...this.series.values()].filter(entry => entry.master.status !== 'cancelled').flatMap(entry => [...entry.instances.values()]);
            items = [...this.singles.values(), ...instances].filter(event => visible(event) && within(event) && changed(event));
        } else {
            const exceptions = [...this.series.values()].flatMap(entry => [...entry.instances.values()].filter(instance => instance.exception));
            items = [...this.singles.values(), ...[...this.series.values()].map(entry => entry.master), ...exceptions].filter(event => visible(event) && changed(event));
        }
        const page = Number(query.get('pageToken') ?? 0);
        const slice = items.slice(page * this.pageSize, (page + 1) * this.pageSize).map(({ exception: _exception, ...event }: CalendarEvent & { exception?: boolean }) => event);
        return ok({ items: slice, updated: this.updated, ...((page + 1) * this.pageSize < items.length ? { nextPageToken: String(page + 1) } : {}) });
    }
}

describe('overdue calendar cache (4.3)', () => {
    const setup = () => {
        const calendar = new FakeCalendar();
        let now = Date.parse('2026-09-19T08:00:00Z');
        const settings = { ...initialData().settings, timeZone: 'UTC', overdueTasks: false, calendars: [{ id: 'cal', name: 'Cal', role: 'recurring' as const, writable: true }] };
        const api = new GoogleClient(async request => calendar.respond(request), async () => 'token', async () => undefined, () => now);
        const cache: Record<string, CalendarCache> = {};
        const overdue = async (date = '2026-09-19') => (await api.load(date, settings, [], cache)).items.map(item => item.id).sort();
        // What a fresh full scan shows for the same note.
        const fresh = async (date = '2026-09-19') => {
            const empty: Record<string, CalendarCache> = {};
            return (await new GoogleClient(async request => calendar.respond(request), async () => 'token', async () => undefined, () => now).load(date, settings, [], empty)).items.map(item => item.id).sort();
        };
        return { calendar, cache, settings, overdue, fresh, advance: (ms: number) => { now += ms; } };
    };
    it('equals a fresh full scan after every kind of change', async () => {
        const h = setup();
        h.calendar.add('open', '⬜ Open task', '2026-09-10');
        h.calendar.add('done', '✅ Done task', '2026-09-11');
        h.calendar.add('plain', 'Lunch', '2026-09-12');
        h.calendar.add('moved', '⬜ Will move', '2026-09-13');
        h.calendar.addSeries('daily', '⬜ Vitamins', ['2026-09-15', '2026-09-16', '2026-09-17']);
        expect(await h.overdue()).toEqual(await h.fresh());
        const transitions: (() => void)[] = [
            () => h.calendar.change('open', { summary: '✅ Open task' }),
            () => h.calendar.change('plain', { summary: '⬜ Lunch' }),
            () => h.calendar.change('done', { summary: 'Done task' }),
            () => h.calendar.move('moved', '2026-10-20'),
            () => h.calendar.remove('plain'),
            () => h.calendar.change('daily_2026-09-16', { summary: '✅ Vitamins' }),
            () => h.calendar.editSeries('daily', '⬜ Vitamins and water'),
            () => h.calendar.add('backdated', '⬜ Backdated', '2026-09-02'),
            () => h.calendar.removeSeries('daily'),
        ];
        for (const transition of transitions) {
            transition();
            h.advance(120000);
            expect(await h.overdue()).toEqual(await h.fresh());
        }
    });
    it('covers later note dates and midnight rollover', async () => {
        const h = setup();
        h.calendar.add('today', '⬜ Today', '2026-09-19');
        h.calendar.add('tomorrow', '⬜ Tomorrow', '2026-09-20');
        await h.overdue('2026-09-19');
        for (const date of ['2026-09-20', '2026-09-22', '2026-09-18']) {
            h.advance(120000);
            expect(await h.overdue(date)).toEqual(await h.fresh(date));
        }
    });
    it('lists only changes after the first scan', async () => {
        const h = setup();
        for (let day = 1; day <= 9; day++) h.calendar.add(`e${day}`, '⬜ Task', `2026-09-0${day}`);
        await h.overdue();
        const before = h.calendar.requests.length;
        h.advance(120000);
        await h.overdue();
        const refresh = h.calendar.requests.slice(before);
        expect(refresh.some(url => url.searchParams.has('updatedMin'))).toBe(true);
        expect(refresh.every(url => !(url.searchParams.get('singleEvents') === 'true' && !url.searchParams.has('timeMin')))).toBe(true);
    });
    it('keeps its state after an interrupted paginated refresh and an offline interval', async () => {
        const h = setup();
        for (let day = 1; day <= 5; day++) h.calendar.add(`e${day}`, '⬜ Task', `2026-09-0${day}`);
        await h.overdue();
        const watermark = h.cache.cal!.watermark;
        h.calendar.change('e1', { summary: '✅ Task' });
        h.calendar.change('e2', { summary: '✅ Task' });
        h.calendar.change('e3', { summary: '✅ Task' });
        h.calendar.failOn = url => url.searchParams.has('updatedMin') && url.searchParams.get('pageToken') === '1';
        h.advance(120000);
        await expect(h.overdue()).rejects.toThrow('Offline');
        expect(h.cache.cal!.watermark).toBe(watermark);
        h.calendar.failOn = () => true;
        h.advance(3600000);
        await expect(h.overdue()).rejects.toThrow('Offline');
        h.calendar.failOn = undefined;
        h.advance(120000);
        expect(await h.overdue()).toEqual(await h.fresh());
    });
    it('rebuilds after a time-zone change, a daily interval, or a too-old watermark', async () => {
        const h = setup();
        h.calendar.add('open', '⬜ Open', '2026-09-10');
        await h.overdue();
        const scanned = h.cache.cal!.scanned;
        h.settings.timeZone = 'Europe/Warsaw';
        await h.overdue();
        expect(h.cache.cal!.scope).toBe('Europe/Warsaw');
        h.advance(25 * 3600000);
        await h.overdue();
        expect(h.cache.cal!.scanned).toBeGreaterThan(scanned);
        const original = h.calendar.respond.bind(h.calendar);
        let refused = false;
        h.calendar.respond = request => {
            if (!refused && new URL(request.url).searchParams.has('updatedMin')) { refused = true; return fail(410, 'updatedMinTooLongAgo'); }
            return original(request);
        };
        h.advance(120000);
        expect(await h.overdue()).toEqual(await h.fresh());
        expect(refused).toBe(true);
    });
});
