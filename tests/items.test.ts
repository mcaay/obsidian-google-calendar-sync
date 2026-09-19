import { describe, expect, it } from 'vitest';
import { dayBounds } from '../src/dates';
import { eventItem, eventMarker, taskItem } from '../src/items';
import { initialData, type CalendarChoice, type CalendarEvent } from '../src/types';
import { DATE } from './fixtures';

const settings = { ...initialData().settings, timeZone: 'Europe/Warsaw' };
const calendar: CalendarChoice = { id: 'calendar', name: 'Recurring', role: 'recurring', writable: true };
const event: CalendarEvent = { id: 'instance', summary: '⬜️ Review', start: { dateTime: '2026-09-19T13:00:00+02:00' }, end: { dateTime: '2026-09-19T14:30:00+02:00' } };

describe('calendar dates and instances', () => {
    it('handles 23-hour and 25-hour days', () => {
        const spring = dayBounds('2026-03-29', 'Europe/Warsaw');
        const autumn = dayBounds('2026-10-25', 'Europe/Warsaw');
        expect((Date.parse(spring.end) - Date.parse(spring.start)) / 3600000).toBe(23);
        expect((Date.parse(autumn.end) - Date.parse(autumn.start)) / 3600000).toBe(25);
    });
    it('renders durations without times in recurring by default', () => {
        expect(eventItem(event, calendar, DATE, settings, [])).toMatchObject({ title: 'Review', done: false, prefix: '90 min ', id: 'instance' });
        expect(eventItem(event, { ...calendar, role: 'events' }, DATE, settings, [])?.prefix).toBe('📅 13:00 (90 min) ');
    });
    it('can show times in recurring', () => expect(eventItem(event, calendar, DATE, { ...settings, recurringTime: true }, [])?.prefix).toBe('📅 13:00 (90 min) '));
    it('includes overdue unchecked instances and omits completed ones', () => {
        expect(eventItem(event, calendar, '2026-09-20', settings, [])).toBeDefined();
        expect(eventItem({ ...event, summary: '✅ Review' }, calendar, '2026-09-20', settings, [])).toBeUndefined();
        expect(eventItem(event, calendar, '2026-09-20', { ...settings, overdueEvents: false }, [])).toBeUndefined();
    });
    it('can disable marker semantics', () => expect(eventItem(event, calendar, DATE, { ...settings, markers: false }, [])).toMatchObject({ title: '⬜️ Review', done: undefined }));
    it('handles multiday all-day events with exclusive ends', () => {
        const allDay = { ...event, summary: 'Holiday', start: { date: '2026-09-18' }, end: { date: '2026-09-20' } };
        expect(eventItem(allDay, calendar, DATE, settings, [])).toBeDefined();
        expect(eventItem(allDay, calendar, '2026-09-20', settings, [])).toBeUndefined();
    });
    it('includes an overnight event on both intersected days', () => {
        const overnight = { ...event, summary: 'Train', start: { dateTime: '2026-09-18T23:00:00+02:00' }, end: { dateTime: '2026-09-19T02:00:00+02:00' } };
        expect(eventItem(overnight, calendar, DATE, settings, [])).toBeDefined();
    });
    it('excludes cancellations', () => expect(eventItem({ ...event, status: 'cancelled' }, calendar, DATE, settings, [])).toBeUndefined());
    it('accepts markers with or without variation selectors', () => {
        expect(eventMarker('⬜ Do it')).toEqual({ title: 'Do it', done: false });
        expect(eventMarker('✅️ Done')).toEqual({ title: 'Done', done: true });
        expect(eventMarker('Discuss ✅')).toEqual({ title: 'Discuss ✅' });
    });
});

describe('Google Tasks dates', () => {
    it('never shows unscheduled or deleted tasks', () => {
        expect(taskItem({ id: 'x', title: 'No date' }, 'list', DATE, settings, [])).toBeUndefined();
        expect(taskItem({ id: 'x', due: DATE, deleted: true }, 'list', DATE, settings, [])).toBeUndefined();
    });
    it('uses the date part without a time-zone shift', () => expect(taskItem({ id: 'x', due: `${DATE}T00:00:00.000Z` }, 'list', DATE, { ...settings, timeZone: 'America/Los_Angeles' }, [])?.date).toBe(DATE));
    it('includes both statuses today, only unfinished tasks before today', () => {
        expect(taskItem({ id: 'x', due: DATE, status: 'completed' }, 'list', DATE, settings, [])).toBeDefined();
        expect(taskItem({ id: 'x', due: '2026-09-18', status: 'completed' }, 'list', DATE, settings, [])).toBeUndefined();
        expect(taskItem({ id: 'x', due: '2026-09-18', status: 'needsAction' }, 'list', DATE, settings, [])).toBeDefined();
    });
    it('does not infer native due times from a date-only response', () => expect(taskItem({ id: 'x', due: DATE, title: '📅 13:00 Call Sam' }, 'list', DATE, settings, [])?.title).toBe('📅 13:00 Call Sam'));
});
