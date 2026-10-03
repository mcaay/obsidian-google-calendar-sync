import { addDays, dayBounds } from './dates';
import { eventItem, eventMarker, taskItem } from './items';
import { googleTitle, parseItemKey } from './markdown';
import { errorReason, GoogleError, retryAfter, type Transport } from './http';
import type { CalendarCache, CalendarChoice, CalendarEvent, GoogleTask, Item, Loaded, Operation, Remote, Settings, SourceFailure } from './types';

const CALENDAR = 'https://www.googleapis.com/calendar/v3';
const TASKS = 'https://tasks.googleapis.com/tasks/v1';
// Field masks keep what later steps use: ETags for conditional writes, the
// recurrence fields of the series guard, and task notes for creation markers.
const EVENT = 'id,summary,status,etag,updated,recurringEventId,recurrence,start,end';
const TASK = 'id,title,status,due,notes,deleted,etag';
const DAY = 24 * 3600000;
const enc = encodeURIComponent;

export class GoogleClient implements Remote {
    // An account-wide pause after Google asks us to slow down.
    private pausedUntil = 0;
    private quotaStreak = 0;

    constructor(private transport: Transport, private token: (force?: boolean) => Promise<string>, private sleep = (ms: number) => new Promise(resolve => window.setTimeout(resolve, ms)), private now = Date.now) {}

    private async request<T>(url: string, method = 'GET', body?: unknown, etag?: string): Promise<T> {
        let refreshed = false;
        for (let attempt = 0; ; attempt++) {
            if (this.now() < this.pausedUntil) throw new GoogleError(429, 'backoff', this.pausedUntil - this.now());
            const response = await this.transport({
                url, method,
                headers: {
                    // Refresh the access token only after Google rejected it.
                    Authorization: `Bearer ${await this.token(refreshed)}`,
                    'Content-Type': 'application/json',
                    ...(etag ? { 'If-Match': etag } : {}),
                },
                body: body === undefined ? undefined : JSON.stringify(body),
            });
            if (response.status >= 200 && response.status < 300) {
                this.quotaStreak = 0;
                return response.json as T;
            }
            const error = new GoogleError(response.status, errorReason(response.json), retryAfter(response.headers, this.now()));
            if (error.failure === 'auth' && !refreshed) { refreshed = true; continue; }
            // Never retry an insert: a lost response can hide a successful create.
            if (method !== 'POST' && (error.failure === 'quota' || error.status >= 500) && attempt < 2) {
                const wait = error.retryAfter ?? 1000 * 2 ** attempt;
                if (wait <= 30000) { await this.sleep(wait); continue; }
            }
            if (error.failure === 'quota') {
                this.quotaStreak++;
                const backoff = Math.min(30 * 60000, 60000 * 2 ** Math.min(this.quotaStreak - 1, 5));
                this.pausedUntil = this.now() + Math.min(60 * 60000, Math.max(error.retryAfter ?? 0, backoff));
            }
            throw error;
        }
    }

    private async list<T>(base: string, query: Record<string, string> = {}): Promise<T[]> {
        return (await this.pages<T>(base, query)).items;
    }

    // `updated` is the calendar's last modification time from the first page:
    // every change after it has a later `updated` value, including changes
    // made while later pages load.
    private async pages<T>(base: string, query: Record<string, string>): Promise<{ items: T[]; updated?: string }> {
        const items: T[] = [];
        let updated: string | undefined;
        let pageToken: string | undefined;
        do {
            const url = new URL(base);
            for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
            if (pageToken) url.searchParams.set('pageToken', pageToken);
            const page = await this.request<{ items?: T[]; nextPageToken?: string; updated?: string }>(url.toString());
            items.push(...(page.items ?? []));
            updated ??= page.updated;
            pageToken = page.nextPageToken;
        } while (pageToken);
        return { items, updated };
    }

    // A deleted item is simply absent; every other failure is the caller's.
    private async optional<T>(url: string): Promise<T | undefined> {
        try { return await this.request<T>(url); }
        catch (error) {
            if (error instanceof GoogleError && error.failure === 'gone') return undefined;
            throw error;
        }
    }

    async sources(): Promise<{ calendars: CalendarChoice[]; taskLists: { id: string; name: string; enabled: boolean }[] }> {
        const [calendars, lists] = await Promise.allSettled([
            this.list<{ id: string; summary: string; accessRole: string }>(`${CALENDAR}/users/me/calendarList`, { fields: 'items(id,summary,accessRole),nextPageToken' }),
            this.list<{ id: string; title: string }>(`${TASKS}/users/@me/lists`, { fields: 'items(id,title),nextPageToken' }),
        ]);
        const missing = [calendars.status === 'rejected' ? 'Google Calendar' : '', lists.status === 'rejected' ? 'Google Tasks' : ''].filter(Boolean);
        if (missing.length) {
            const reason = [calendars, lists].find(result => result.status === 'rejected') as PromiseRejectedResult;
            const detail = reason.reason instanceof Error ? reason.reason.message : 'Request failed.';
            throw new Error(`Could not load ${missing.join(' and ')}. ${detail}`);
        }
        return {
            calendars: (calendars as PromiseFulfilledResult<{ id: string; summary: string; accessRole: string }[]>).value.filter(calendar => calendar.accessRole !== 'freeBusyReader').map(calendar => ({
                id: calendar.id, name: calendar.summary, role: 'off', writable: ['owner', 'writer'].includes(calendar.accessRole),
            })),
            taskLists: (lists as PromiseFulfilledResult<{ id: string; title: string }[]>).value.map(list => ({ id: list.id, name: list.title, enabled: false })),
        };
    }

    /**
     * How to read this code:
     * 1. SyncEngine.run() in sync.ts calls load() with the note's date and the
     *    checked rows the note keeps (retained keys).
     * 2. Calendars: the day's events, overdue marked events from overdue() and
     *    retained events fetched by ID. Tasks: the day's tasks including
     *    completed ones, earlier unfinished tasks, and retained tasks by ID.
     * 3. A source Google refuses or no longer has is reported in `failed`; the
     *    note keeps its rows. Account, quota and network failures reject the
     *    whole load, so no row disappears because of them.
     * Ordinary: one request per list and calendar, plus a small overdue refresh.
     * Tricky: a checked task from last week stays in its note through a get by ID.
     */
    async load(date: string, settings: Settings, retained: string[], cache: Record<string, CalendarCache> = {}): Promise<Loaded> {
        const bounds = dayBounds(date, settings.timeZone);
        const items: Item[] = [];
        const failed: SourceFailure[] = [];
        const wanted = retained.flatMap(key => parseItemKey(key) ?? []);
        const skip = (kind: 'event' | 'task', source: string, name: string, error: unknown) => {
            if (!(error instanceof GoogleError) || (error.failure !== 'refused' && error.failure !== 'gone')) throw error;
            failed.push({ kind, source, name, message: error.message });
        };
        // Serial requests per source avoid bursts against Google quotas.
        for (const calendar of settings.calendars.filter(value => value.role !== 'off')) {
            const url = `${CALENDAR}/calendars/${enc(calendar.id)}/events`;
            try {
                const events = new Map<string, CalendarEvent>();
                for (const event of await this.list<CalendarEvent>(url, {
                    singleEvents: 'true', orderBy: 'startTime', maxResults: '2500', timeZone: settings.timeZone,
                    timeMin: bounds.start, timeMax: bounds.end, fields: `items(${EVENT}),nextPageToken`,
                })) events.set(event.id, event);
                if (settings.markers && settings.overdueEvents) {
                    for (const event of await this.overdue(url, calendar.id, date, settings, cache)) if (!events.has(event.id)) events.set(event.id, event);
                }
                for (const target of wanted) {
                    if (target.kind !== 'event' || target.source !== calendar.id || events.has(target.id)) continue;
                    const event = await this.optional<CalendarEvent>(`${url}/${enc(target.id)}?fields=${EVENT}&timeZone=${enc(settings.timeZone)}`);
                    if (event) events.set(event.id, event);
                }
                for (const event of events.values()) {
                    const item = eventItem(event, calendar, date, bounds, settings, retained);
                    if (item) items.push(item);
                }
            } catch (error) { skip('event', calendar.id, calendar.name, error); }
        }
        for (const list of settings.taskLists.filter(value => value.enabled)) {
            const url = `${TASKS}/lists/${enc(list.id)}/tasks`;
            try {
                const tasks = new Map<string, GoogleTask>();
                // Google stores due dates at midnight UTC and does not document
                // whether these bounds are inclusive; noon avoids the question.
                const queries = [{ dueMin: `${addDays(date, -1)}T12:00:00.000Z`, dueMax: `${date}T12:00:00.000Z`, showCompleted: 'true', showHidden: 'true' }];
                if (settings.overdueTasks) queries.push({ dueMin: '', dueMax: `${addDays(date, -1)}T12:00:00.000Z`, showCompleted: 'false', showHidden: 'false' });
                for (const { dueMin, ...query } of queries) {
                    for (const task of await this.list<GoogleTask>(url, {
                        maxResults: '100', showAssigned: 'true', ...query, ...(dueMin ? { dueMin } : {}), fields: `items(${TASK}),nextPageToken`,
                    })) tasks.set(task.id, task);
                }
                for (const target of wanted) {
                    if (target.kind !== 'task' || target.source !== list.id || tasks.has(target.id)) continue;
                    const task = await this.optional<GoogleTask>(`${url}/${enc(target.id)}?fields=${TASK}`);
                    if (task) tasks.set(task.id, task);
                }
                for (const task of tasks.values()) {
                    const item = taskItem(task, list.id, date, settings, retained);
                    if (item) items.push(item);
                }
            } catch (error) { skip('task', list.id, list.name, error); }
        }
        return { items, failed };
    }

    /**
     * How to read this code:
     * 1. overdue() keeps a device-local cache of past, unchecked marked events
     *    (⬜) per calendar, so a sync no longer downloads the whole history.
     * 2. scan() builds it with one full listing: at first use, after a
     *    time-zone change, and once a day as a safety net.
     * 3. refresh() asks only for events changed since the largest `updated`
     *    value Google reported, overlapping by a minute. A changed recurring
     *    series has its instances listed again; a cancelled one drops them.
     * 4. extend() adds the days between the cache's end and a later note date.
     *    Every step commits only after all its pages succeeded.
     * Ordinary: checking an old ⬜ event on the phone removes it at the next refresh.
     * Tricky: moving an overdue event into next month removes it, because the
     * refresh lists changed events without a time limit.
     */
    private async overdue(url: string, calendar: string, date: string, settings: Settings, cache: Record<string, CalendarCache>): Promise<CalendarEvent[]> {
        const until = `${addDays(date, 2)}T00:00:00.000Z`;
        const scope = settings.timeZone;
        let entry = cache[calendar];
        if (!entry || entry.scope !== scope || !(this.now() - entry.scanned < DAY)) entry = await this.scan(url, until, scope, settings);
        else {
            try { entry = await this.refresh(url, entry, settings); }
            catch (error) {
                // Google refuses an updatedMin that lies too far in the past.
                if (!(error instanceof GoogleError) || error.status !== 410) throw error;
                entry = await this.scan(url, until, scope, settings);
            }
            if (entry.until < until) entry = await this.extend(url, entry, until, settings);
        }
        cache[calendar] = entry;
        // eventItem() decides which of these are overdue for this note's date.
        return Object.values(entry.events);
    }

    private overdueCandidate(event: CalendarEvent, until: string): boolean {
        const start = event.start.dateTime ? Date.parse(event.start.dateTime) : Date.parse(`${event.start.date}T00:00:00Z`);
        return event.status !== 'cancelled' && eventMarker(event.summary ?? '').done === false && start < Date.parse(until);
    }

    // Google's own clock, never the device's. Without a calendar timestamp, fall
    // back to the newest event seen; the refresh overlap covers the gap.
    private watermark(result: { items: CalendarEvent[]; updated?: string }, previous: string): string {
        const newest = result.updated ?? result.items.reduce((latest, event) => event.updated && event.updated > latest ? event.updated : latest, '');
        return newest > previous ? newest : previous;
    }

    private async scan(url: string, until: string, scope: string, settings: Settings): Promise<CalendarCache> {
        const result = await this.pages<CalendarEvent>(url, {
            singleEvents: 'true', maxResults: '2500', timeMax: until, timeZone: settings.timeZone, fields: `updated,items(${EVENT}),nextPageToken`,
        });
        return {
            scope, until, scanned: this.now(), watermark: this.watermark(result, ''),
            events: Object.fromEntries(result.items.filter(event => this.overdueCandidate(event, until)).map(event => [event.id, event])),
        };
    }

    private async refresh(url: string, entry: CalendarCache, settings: Settings): Promise<CalendarCache> {
        if (!entry.watermark) return this.scan(url, entry.until, entry.scope, settings);
        const since = new Date(Date.parse(entry.watermark) - 60000).toISOString();
        const result = await this.pages<CalendarEvent>(url, {
            updatedMin: since, showDeleted: 'true', singleEvents: 'false', maxResults: '2500', timeZone: settings.timeZone,
            fields: `updated,items(${EVENT}),nextPageToken`,
        });
        const changed = result.items;
        const events = { ...entry.events };
        for (const event of changed) {
            if (event.recurrence?.length || (event.status === 'cancelled' && !event.recurringEventId)) {
                // A series edit can change every instance. Replace them all.
                for (const [id, cached] of Object.entries(events)) if (cached.recurringEventId === event.id) delete events[id];
                if (event.status !== 'cancelled' && event.recurrence?.length) {
                    for (const instance of await this.list<CalendarEvent>(`${url}/${enc(event.id)}/instances`, {
                        maxResults: '2500', timeMax: entry.until, timeZone: settings.timeZone, fields: `items(${EVENT}),nextPageToken`,
                    })) if (this.overdueCandidate(instance, entry.until)) events[instance.id] = instance;
                }
            }
            if (this.overdueCandidate(event, entry.until) && !event.recurrence?.length) events[event.id] = event;
            else delete events[event.id];
        }
        return { ...entry, events, watermark: this.watermark(result, entry.watermark) };
    }

    private async extend(url: string, entry: CalendarCache, until: string, settings: Settings): Promise<CalendarCache> {
        const added = await this.list<CalendarEvent>(url, {
            singleEvents: 'true', maxResults: '2500', timeMin: entry.until, timeMax: until, timeZone: settings.timeZone,
            fields: `items(${EVENT}),nextPageToken`,
        });
        const events = { ...entry.events };
        for (const event of added) if (this.overdueCandidate(event, until)) events[event.id] = event;
        return { ...entry, until, events };
    }

    /**
     * How to read this code:
     * 1. SyncEngine.flush() in sync.ts passes one durable edit to patch().
     * 2. request() reads the current resource; patch() merges only edited fields.
     * 3. The conditional PATCH protects concurrent changes and retries a conflict
     *    once against a fresh read. Unedited fields always retain Google's value.
     * Ordinary: toggle one recurring instance, preserving its title and time.
     * Tricky: a title edit races with a remote checkmark; re-read keeps the checkmark.
     */
    async patch(operation: Operation): Promise<void> {
        const url = operation.kind === 'event'
            ? `${CALENDAR}/calendars/${enc(operation.source)}/events/${enc(operation.id)}`
            : `${TASKS}/lists/${enc(operation.source)}/tasks/${enc(operation.id)}`;
        for (let attempt = 0; attempt < 2; attempt++) {
            let body: Record<string, unknown>;
            let etag: string | undefined;
            if (operation.kind === 'event') {
                const current = await this.request<CalendarEvent>(`${url}?fields=id,summary,status,etag,recurrence,recurringEventId`);
                if (current.status === 'cancelled') throw new GoogleError(410);
                // Like remove(): a note may change one occurrence, never a series.
                if (current.recurrence?.length && !current.recurringEventId) {
                    throw new GoogleError(400, 'recurringSeries', undefined, 'Only one occurrence of a recurring event can be changed from a note.');
                }
                // Always use the instance ID, never recurringEventId.
                const parsed = eventMarker(current.summary ?? '');
                const done = operation.done ?? parsed.done;
                const title = operation.title === undefined ? parsed.title : googleTitle(operation.title);
                body = { summary: operation.marker === false && operation.done === undefined
                    ? googleTitle(operation.title ?? current.summary ?? '')
                    : `${done === undefined ? '' : done ? '✅ ' : '⬜️ '}${title}` };
                etag = current.etag;
            } else {
                const current = await this.request<GoogleTask>(`${url}?fields=id,deleted,etag`);
                if (current.deleted) throw new GoogleError(410);
                body = {
                    ...(operation.title === undefined ? {} : { title: googleTitle(operation.title) }),
                    ...(operation.done === undefined ? {} : { status: operation.done ? 'completed' : 'needsAction' }),
                    ...(operation.done === false ? { completed: null } : {}),
                };
                etag = current.etag;
            }
            try {
                await this.request(url + (operation.kind === 'event' ? '?sendUpdates=none' : ''), 'PATCH', body, etag);
                return;
            } catch (error) {
                if (error instanceof GoogleError && error.status === 412 && attempt === 0) continue;
                throw error;
            }
        }
    }

    // One POST with a reconciliation marker in the notes. SyncEngine decides
    // whether an earlier attempt might exist; see find().
    async insert(operation: Operation): Promise<{ source: string; id: string }> {
        const task = await this.request<GoogleTask>(`${TASKS}/lists/${enc(operation.source)}/tasks?fields=id`, 'POST', {
            title: googleTitle(operation.title ?? ''),
            due: `${operation.create!.date}T00:00:00.000Z`,
            status: operation.done ? 'completed' : 'needsAction', notes: `[google-daily-notes:${operation.key}]`,
        });
        return { source: operation.source, id: task.id };
    }

    // Matches the durable marker, never a title, so identical names are safe.
    // Deleted and completed tasks count: a deleted match must not be resent.
    async find(operation: Operation): Promise<GoogleTask[]> {
        const marker = `[google-daily-notes:${operation.key}]`;
        // A day of margin covers clock differences between device and Google.
        // A creation upgraded from an older version has no recorded attempt,
        // so its search covers the whole list.
        const attempted = operation.create?.attempted;
        const tasks = await this.list<GoogleTask>(`${TASKS}/lists/${enc(operation.source)}/tasks`, {
            maxResults: '100', showCompleted: 'true', showHidden: 'true', showDeleted: 'true',
            ...(attempted ? { updatedMin: new Date(attempted - DAY).toISOString() } : {}),
            fields: 'items(id,notes,deleted),nextPageToken',
        });
        return tasks.filter(task => task.notes?.includes(marker));
    }

    async remove(operation: Operation): Promise<void> {
        // Tasks exposes deletion by ID only. It has no recurring-series ID or
        // delete-all option; never infer a series from matching task titles.
        const url = operation.kind === 'event'
            ? `${CALENDAR}/calendars/${enc(operation.source)}/events/${enc(operation.id)}`
            : `${TASKS}/lists/${enc(operation.source)}/tasks/${enc(operation.id)}`;
        try {
            let notify = false;
            if (operation.kind === 'event') {
                const current = await this.request<CalendarEvent>(`${url}?fields=id,status,recurrence,recurringEventId,organizer(self),attendees(self)`);
                if (current.status === 'cancelled') return;
                // Daily rows use events.list(singleEvents=true) instance IDs.
                // Never allow a stale or malformed row to delete a whole series.
                if (current.recurrence?.length && !current.recurringEventId) {
                    throw new GoogleError(400, 'recurringSeries', undefined, 'Only one occurrence of a recurring event can be deleted from a note.');
                }
                // Deleting a meeting you organize cancels it for its guests, so
                // Google tells them. Leaving someone else's invitation stays quiet.
                notify = current.organizer?.self === true && (current.attendees ?? []).some(attendee => !attendee.self);
            }
            await this.request(url + (operation.kind === 'event' ? `?sendUpdates=${notify ? 'all' : 'none'}` : ''), 'DELETE');
        } catch (error) {
            // Retrying a successful deletion whose response was lost is safe.
            if (error instanceof GoogleError && error.failure === 'gone') return;
            throw error;
        }
    }

    // Called only after SyncEngine has saved the Google ID. Keep the token
    // until then so a crash or lost creation response cannot cause duplicates.
    async removeCreationMarker(key: string, source: string, id: string): Promise<void> {
        const url = `${TASKS}/lists/${enc(source)}/tasks/${enc(id)}`;
        const marker = `[google-daily-notes:${key}]`;
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const current = await this.request<GoogleTask>(`${url}?fields=id,notes,deleted,etag`);
                if (current.deleted || !current.notes?.includes(marker)) return;
                if (!current.etag) throw new Error('Could not safely clean up the task description. Sync will retry.');
                // Remove only our exact token, preserving all user text. A fresh
                // read after a conflict also preserves edits made during cleanup.
                await this.request(url, 'PATCH', { notes: current.notes.replace(marker, '') }, current.etag);
                return;
            } catch (error) {
                if (error instanceof GoogleError) {
                    if (error.failure === 'gone') return;
                    if (error.status === 412 && attempt === 0) continue;
                }
                throw error;
            }
        }
    }
}
