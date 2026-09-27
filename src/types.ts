import type { ConnectionTransfer } from './connection-transfer';

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

// A snapshot describes what was last written to this particular note. It
// supplies each row's Google identity, prefix and permissions to the editor.
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
    // The Google-side creation key found in a task's notes, used to relink a
    // draft that another device created (see relinkDrafts() in sync.ts).
    marker?: string;
}

export interface NoteState {
    rows: Record<string, Item>;
    // Last successful render, used to prune snapshots of notes left alone.
    synced?: number;
}

export interface Edit {
    title?: string;
    done?: boolean;
}

// An editor edit that no sync has staged yet.
export interface JournalEdit extends Edit {
    path: string;
}

// prepared: never sent. sending: a POST is in flight. uncertain: its outcome is
// unknown. refused: Google rejected it; only a new edit sends it again.
export type CreationPhase = 'prepared' | 'sending' | 'uncertain' | 'refused';

export interface Creation {
    date: string;
    phase: CreationPhase;
    // First POST attempt; the lookup searches tasks updated since then.
    attempted?: number;
    // When an uncertain POST ended (or the plugin loaded): the D3 clock.
    settled?: number;
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
    // Recreating a deleted task must wait until its old ID is confirmed gone.
    replaces?: string;
    create?: Creation;
}

export interface DeletedTask {
    path: string;
    item: Item;
    deletionKey: string;
    deleted: boolean;
    restoredKey?: string;
}

// Device-local pending work and undo decisions. It is small and saved after
// every editor decision, separately from the note snapshots.
export interface Journal {
    edits: Record<string, JournalEdit>;
    outbox: Record<string, Operation>;
    deletedTasks: Record<string, DeletedTask>;
    // Row keys replaced after a late undo, so native undo and redo still map.
    aliases: Record<string, string>;
}

export interface CalendarCache {
    // The time zone the cache was built for; a change rebuilds it.
    scope: string;
    // Marked, unchecked instances starting before this instant.
    until: string;
    // Time of the last full listing. A daily one bounds any drift.
    scanned: number;
    // Google's last modification time seen, for incremental refreshes.
    watermark: string;
    events: Record<string, CalendarEvent>;
}

export interface PluginData extends Journal {
    version: 2;
    connectionTransfer?: ConnectionTransfer;
    runtimeOwner?: string;
    settings: Settings;
    notes: Record<string, NoteState>;
    // Maps durable local creation IDs to Google IDs after a successful insert.
    // `marker` names the creation key of an extra copy a search found; `path`
    // is the note whose row the new key replaces.
    created: Record<string, { source: string; id: string; markerRemoved?: boolean; at?: number; path?: string; marker?: string }>;
    calendars: Record<string, CalendarCache>;
}

export function initialData(): PluginData {
    return {
        version: 2, settings: structuredClone(DEFAULT_SETTINGS), notes: {}, created: {}, calendars: {},
        edits: {}, outbox: {}, deletedTasks: {}, aliases: {},
    };
}

export interface CalendarEvent {
    id: string;
    summary?: string;
    status?: string;
    etag?: string;
    updated?: string;
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

export interface SourceFailure {
    kind: Kind;
    source: string;
    name: string;
    message: string;
}

export interface Loaded {
    items: Item[];
    // Sources that could not be read. Their rows stay as they are.
    failed: SourceFailure[];
}

export interface Remote {
    load(date: string, settings: Settings, retained: string[], cache?: Record<string, CalendarCache>): Promise<Loaded>;
    patch(operation: Operation): Promise<void>;
    // Sends one POST. Never looks up earlier attempts (see find()).
    insert(operation: Operation): Promise<{ source: string; id: string }>;
    // Finds tasks carrying this creation's marker, including deleted ones.
    find(operation: Operation): Promise<GoogleTask[]>;
    removeCreationMarker(key: string, source: string, id: string): Promise<void>;
    remove(operation: Operation): Promise<void>;
}
