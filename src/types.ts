export type Section = 'events' | 'recurring' | 'tasks';
export type Kind = 'event' | 'task';

export interface CalendarChoice {
    id: string;
    name: string;
    role: 'off' | 'events' | 'recurring';
    writable: boolean;
}

export interface Settings {
    clientId: string;
    calendars: CalendarChoice[];
    taskLists: { id: string; name: string; enabled: boolean }[];
    defaultTaskList: string;
    markers: boolean;
    overdueEvents: boolean;
    overdueTasks: boolean;
    recurringTime: boolean;
    intervalSeconds: number;
    timeZone: string;
}

export const DEFAULT_SETTINGS: Settings = {
    clientId: '', calendars: [], taskLists: [], defaultTaskList: '',
    markers: true, overdueEvents: true, overdueTasks: true, recurringTime: false,
    intervalSeconds: 120, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
};

// A snapshot describes what was last written to this particular note. Comparing
// against it prevents an old note from pushing stale Google data back upstream.
export interface Item {
    key: string;
    kind: Kind;
    source: string;
    id: string;
    section: Section;
    title: string;
    done?: boolean;
    prefix: string;
    date: string;
    writable: boolean;
    sort: string;
}

export interface NoteState {
    rows: Record<string, Item>;
    retained: string[];
}

export interface Edit {
    title?: string;
    done?: boolean;
}

export interface Operation extends Edit {
    key: string;
    kind: Kind;
    source: string;
    id: string;
    path: string;
    marker?: boolean;
    remove?: boolean;
    removeAfter?: number;
    create?: { date: string; phase: 'prepared' | 'sent' };
}

export interface PluginData {
    version: 1;
    settings: Settings;
    notes: Record<string, NoteState>;
    outbox: Record<string, Operation>;
    // Maps durable local creation IDs to Google IDs after a successful insert.
    created: Record<string, { source: string; id: string; markerRemoved?: boolean }>;
}

export function initialData(): PluginData {
    return { version: 1, settings: structuredClone(DEFAULT_SETTINGS), notes: {}, outbox: {}, created: {} };
}

export interface CalendarEvent {
    id: string;
    summary?: string;
    status?: string;
    etag?: string;
    recurringEventId?: string;
    recurrence?: string[];
    start: { date?: string; dateTime?: string; timeZone?: string };
    end: { date?: string; dateTime?: string };
}

export interface GoogleTask {
    id: string;
    title?: string;
    status?: 'needsAction' | 'completed';
    due?: string;
    notes?: string;
    deleted?: boolean;
    etag?: string;
}

export interface Remote {
    load(date: string, settings: Settings, retained: string[]): Promise<Item[]>;
    patch(operation: Operation): Promise<void>;
    create(operation: Operation, beforeInsert: () => Promise<boolean | void>): Promise<{ source: string; id: string } | undefined>;
    removeCreationMarker(key: string, source: string, id: string): Promise<void>;
    remove(operation: Operation): Promise<void>;
}
