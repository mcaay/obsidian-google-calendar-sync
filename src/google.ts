import { dayBounds, addDays } from './dates';
import { eventItem, eventMarker, taskItem } from './items';
import { googleTitle } from './markdown';
import { GoogleError, type Transport } from './http';
import type { CalendarChoice, CalendarEvent, GoogleTask, Item, Operation, Remote, Settings } from './types';

const CALENDAR = 'https://www.googleapis.com/calendar/v3';
const TASKS = 'https://tasks.googleapis.com/tasks/v1';
const enc = encodeURIComponent;

export class GoogleClient implements Remote {
    constructor(private transport: Transport, private token: (force?: boolean) => Promise<string>) {}

    private async request<T>(url: string, method = 'GET', body?: unknown, etag?: string): Promise<T> {
        for (let attempt = 0; attempt < 3; attempt++) {
            const response = await this.transport({
                url, method,
                headers: {
                    Authorization: `Bearer ${await this.token(attempt > 0)}`,
                    'Content-Type': 'application/json',
                    ...(etag ? { 'If-Match': etag } : {}),
                },
                body: body === undefined ? undefined : JSON.stringify(body),
            });
            if (response.status >= 200 && response.status < 300) return response.json as T;
            if (response.status === 401 && attempt === 0) continue;
            // Never retry an insert: a lost response can hide a successful create.
            if (method !== 'POST' && (response.status === 429 || response.status >= 500) && attempt < 2) {
                await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt));
                continue;
            }
            throw new GoogleError(response.status);
        }
        throw new GoogleError(401);
    }

    private async list<T>(base: string, query: Record<string, string> = {}): Promise<T[]> {
        const result: T[] = [];
        let pageToken: string | undefined;
        do {
            const url = new URL(base);
            for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
            if (pageToken) url.searchParams.set('pageToken', pageToken);
            const page = await this.request<{ items?: T[]; nextPageToken?: string }>(url.toString());
            result.push(...(page.items ?? []));
            pageToken = page.nextPageToken;
        } while (pageToken);
        return result;
    }

    async sources(): Promise<{ calendars: CalendarChoice[]; taskLists: { id: string; name: string; enabled: boolean }[] }> {
        const [calendars, lists] = await Promise.all([
            this.list<{ id: string; summary: string; accessRole: string }>(`${CALENDAR}/users/me/calendarList`),
            this.list<{ id: string; title: string }>(`${TASKS}/users/@me/lists`),
        ]);
        return {
            calendars: calendars.filter(calendar => calendar.accessRole !== 'freeBusyReader').map(calendar => ({
                id: calendar.id, name: calendar.summary, role: 'off', writable: ['owner', 'writer'].includes(calendar.accessRole),
            })),
            taskLists: lists.map(list => ({ id: list.id, name: list.title, enabled: false })),
        };
    }

    async load(date: string, settings: Settings, retained: string[]): Promise<Item[]> {
        const bounds = dayBounds(date, settings.timeZone);
        const items: Item[] = [];
        // Serial per-source pagination avoids bursts against Google quotas.
        for (const calendar of settings.calendars.filter(value => value.role !== 'off')) {
            const includeHistory = (settings.markers && settings.overdueEvents) || retained.length > 0;
            const events = await this.list<CalendarEvent>(`${CALENDAR}/calendars/${enc(calendar.id)}/events`, {
                singleEvents: 'true', orderBy: 'startTime', maxResults: '2500',
                timeMax: bounds.end, timeZone: settings.timeZone,
                ...(includeHistory ? {} : { timeMin: bounds.start }),
            });
            for (const event of events) {
                const item = eventItem(event, calendar, date, settings, retained);
                if (item) items.push(item);
            }
        }
        for (const list of settings.taskLists.filter(value => value.enabled)) {
            const tasks = await this.list<GoogleTask>(`${TASKS}/lists/${enc(list.id)}/tasks`, {
                maxResults: '100', showCompleted: 'true', showHidden: 'true', showAssigned: 'true',
                dueMax: `${addDays(date, 1)}T00:00:00.000Z`,
            });
            for (const task of tasks) {
                const item = taskItem(task, list.id, date, settings, retained);
                if (item) items.push(item);
            }
        }
        return items;
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
                const current = await this.request<CalendarEvent>(url);
                if (current.status === 'cancelled') throw new GoogleError(410);
                // Always use the instance ID, never recurringEventId.
                const parsed = eventMarker(current.summary ?? '');
                const done = operation.done ?? parsed.done;
                const title = operation.title === undefined ? parsed.title : googleTitle(operation.title);
                body = { summary: operation.marker === false && operation.done === undefined
                    ? googleTitle(operation.title ?? current.summary ?? '')
                    : `${done === undefined ? '' : done ? '✅ ' : '⬜️ '}${title}` };
                etag = current.etag;
            } else {
                const current = await this.request<GoogleTask>(url);
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

    async create(operation: Operation, beforeInsert: () => Promise<boolean | void>): Promise<{ source: string; id: string } | undefined> {
        const url = `${TASKS}/lists/${enc(operation.source)}/tasks`;
        const marker = `[google-daily-notes:${operation.key}]`;
        // A prior POST might have succeeded before its response was lost. Match a
        // durable notes token, never a title, so identical task names are safe.
        const tasks = await this.list<GoogleTask>(url, { maxResults: '100', showCompleted: 'true', showHidden: 'true' });
        const existing = tasks.find(task => !task.deleted && task.notes?.includes(marker));
        if (existing) {
            if (!operation.remove) await this.patch({ ...operation, id: existing.id });
            return { source: operation.source, id: existing.id };
        }
        if (operation.create?.phase === 'sent') return undefined;
        if (await beforeInsert() === false) return undefined;
        const task = await this.request<GoogleTask>(url, 'POST', {
            title: googleTitle(operation.title ?? ''),
            due: `${operation.create!.date}T00:00:00.000Z`,
            status: operation.done ? 'completed' : 'needsAction', notes: marker,
        });
        return { source: operation.source, id: task.id };
    }

    async remove(operation: Operation): Promise<void> {
        // Tasks exposes deletion by ID only. It has no recurring-series ID or
        // delete-all option; never infer a series from matching task titles.
        const url = operation.kind === 'event'
            ? `${CALENDAR}/calendars/${enc(operation.source)}/events/${enc(operation.id)}`
            : `${TASKS}/lists/${enc(operation.source)}/tasks/${enc(operation.id)}`;
        try {
            if (operation.kind === 'event') {
                const current = await this.request<CalendarEvent>(url);
                if (current.status === 'cancelled') return;
                // Daily rows use events.list(singleEvents=true) instance IDs.
                // Never allow a stale or malformed row to delete a whole series.
                if (current.recurrence?.length && !current.recurringEventId) throw new Error('Delete only a calendar occurrence from the daily note, not its entire series.');
            }
            await this.request(url + (operation.kind === 'event' ? '?sendUpdates=none' : ''), 'DELETE');
        } catch (error) {
            // Retrying a successful deletion whose response was lost is safe.
            if (error instanceof GoogleError && [404, 410].includes(error.status)) return;
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
                const current = await this.request<GoogleTask>(url);
                if (current.deleted || !current.notes?.includes(marker)) return;
                if (!current.etag) throw new Error('Could not safely clean up the task description. Sync will retry.');
                // Remove only our exact token, preserving all user text. A fresh
                // read after a conflict also preserves edits made during cleanup.
                await this.request(url, 'PATCH', { notes: current.notes.replace(marker, '') }, current.etag);
                return;
            } catch (error) {
                if (error instanceof GoogleError) {
                    if ([404, 410].includes(error.status)) return;
                    if (error.status === 412 && attempt === 0) continue;
                }
                throw error;
            }
        }
    }
}
