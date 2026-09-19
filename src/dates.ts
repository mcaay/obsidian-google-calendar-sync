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

export function inZone(iso: string, timeZone: string): { date: string; time: string } {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(iso));
    const get = (type: string) => parts.find(part => part.type === type)?.value ?? '';
    return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}` };
}

function midnight(date: string, zone: string): string {
    const desired = Date.parse(`${date}T00:00:00Z`);
    let timestamp = desired;
    // Re-evaluate the offset at the target instant, including a DST transition.
    for (let i = 0; i < 4; i++) {
        const local = inZone(new Date(timestamp).toISOString(), zone);
        const difference = desired - Date.parse(`${local.date}T${local.time}:00Z`);
        if (!difference) break;
        timestamp += difference;
    }
    return new Date(timestamp).toISOString();
}

export function dayBounds(date: string, zone: string): { start: string; end: string } {
    return { start: midnight(date, zone), end: midnight(addDays(date, 1), zone) };
}
