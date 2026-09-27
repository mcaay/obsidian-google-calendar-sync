export function validDate(value: string): boolean {
    return /^\d{4}-\d{2}-\d{2}$/.test(value)
        && !Number.isNaN(Date.parse(value))
        && new Date(value).toISOString().slice(0, 10) === value;
}

export function addDays(date: string, days: number): string {
    const value = new Date(`${date}T12:00:00Z`);
    value.setUTCDate(value.getUTCDate() + days);
    return value.toISOString().slice(0, 10);
}

const formatters = new Map<string, Intl.DateTimeFormat>();

export function inZone(iso: string | number, timeZone: string): { date: string; time: string } {
    let format = formatters.get(timeZone);
    if (!format) {
        format = new Intl.DateTimeFormat('en-CA', {
            timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
        });
        formatters.set(timeZone, format);
    }
    const parts = format.formatToParts(new Date(iso));
    const get = (type: string) => parts.find(part => part.type === type)?.value ?? '';
    return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}` };
}

// The first instant whose local date is `date`. Where a transition skips local
// midnight, as in America/Santiago, the day starts when the clocks resume.
function dayStart(date: string, zone: string): number {
    const midnight = Date.parse(`${date}T00:00:00Z`);
    // Offsets stay within ±14 hours, so these bounds bracket the answer.
    let before = midnight - 15 * 3600000;
    let after = midnight + 15 * 3600000;
    // Transitions happen on whole minutes, so a minute-level search is exact.
    while (after - before > 60000) {
        const middle = before + Math.floor((after - before) / 120000) * 60000;
        if (inZone(middle, zone).date >= date) after = middle;
        else before = middle;
    }
    return after;
}

export function dayBounds(date: string, zone: string): { start: string; end: string } {
    return { start: new Date(dayStart(date, zone)).toISOString(), end: new Date(dayStart(addDays(date, 1), zone)).toISOString() };
}
