import { cleanTitle, itemKey } from './markdown';
import { dayBounds, inZone } from './dates';
import type { CalendarChoice, CalendarEvent, GoogleTask, Item, Settings } from './types';

export function eventMarker(summary: string): { title: string; done?: boolean } {
    const match = /^(⬜\uFE0F?|✅\uFE0F?)\s*/u.exec(summary);
    return match ? { title: summary.slice(match[0].length), done: match[1]!.startsWith('✅') } : { title: summary };
}

export function eventItem(event: CalendarEvent, calendar: CalendarChoice, date: string, settings: Settings, retained: string[]): Item | undefined {
    if (event.status === 'cancelled') return undefined;
    const start = event.start.dateTime;
    const zoned = start ? inZone(start, settings.timeZone) : undefined;
    const startDate = event.start.date ?? zoned?.date;
    if (!startDate) return undefined;
    const { start: dayStart, end: dayEnd } = dayBounds(date, settings.timeZone);
    const occurs = start
        ? Date.parse(start) < Date.parse(dayEnd) && Date.parse(event.end.dateTime ?? start) > Date.parse(dayStart)
        : startDate <= date && (event.end.date ?? startDate) > date;
    const marked = settings.markers ? eventMarker(event.summary ?? '(Untitled event)') : { title: event.summary ?? '(Untitled event)', done: undefined };
    const key = itemKey('event', calendar.id, event.id);
    if (!occurs && !(startDate < date && ((settings.overdueEvents && marked.done === false) || retained.includes(key)))) return undefined;
    const minutes = start && event.end.dateTime ? Math.max(0, Math.round((Date.parse(event.end.dateTime) - Date.parse(start)) / 60000)) : undefined;
    const showTime = calendar.role === 'events' || settings.recurringTime;
    const prefix = start
        ? `${showTime ? `📅 ${zoned!.time} ` : ''}${minutes ? (showTime ? `(${minutes} min) ` : `${minutes} min `) : ''}`
        : '📅 (all day) ';
    return {
        key, kind: 'event', source: calendar.id, id: event.id,
        section: calendar.role === 'recurring' ? 'recurring' : 'events',
        title: cleanTitle(marked.title), done: marked.done, prefix,
        date: startDate, writable: calendar.writable, sort: `${startDate} ${zoned?.time ?? '00:00'}`,
    };
}

export function taskItem(task: GoogleTask, source: string, date: string, settings: Settings, retained: string[]): Item | undefined {
    if (task.deleted || !task.due) return undefined;
    // Google's due field is a calendar date, even though its wire format is UTC.
    // Converting it into a local time zone would shift tasks to the wrong day.
    const due = task.due.slice(0, 10);
    const done = task.status === 'completed';
    const key = itemKey('task', source, task.id);
    if (due !== date && !(due < date && ((!done && settings.overdueTasks) || retained.includes(key)))) return undefined;
    return {
        key, kind: 'task', source, id: task.id, section: 'tasks',
        title: cleanTitle(task.title ?? ''), done, prefix: '', date: due,
        writable: true, sort: `${due} ${/^📅 (\d{2}:\d{2})\s/.exec(task.title ?? '')?.[1] ?? '99:99'} ${task.title ?? ''}`,
    };
}
