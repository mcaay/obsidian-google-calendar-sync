export interface HttpRequest {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
}
export interface HttpResponse { status: number; json: unknown; headers?: Record<string, string> }
export type Transport = (request: HttpRequest) => Promise<HttpResponse>;

// The 30-second limit stops waiting, not the request. `late` settles when the
// abandoned request does, so an uncertain task creation can start its clock.
export class RequestTimeout extends Error {
    constructor(readonly late: Promise<HttpResponse>) {
        super('Google did not answer within 30 seconds. Pending edits are kept.');
    }
}

// refused: Google rejected this item; the edit is dropped (D2).
// gone: the item no longer exists. account: fixing needs the user.
// quota: back off for the whole account. transient: retry later.
export type Failure = 'refused' | 'gone' | 'account' | 'auth' | 'quota' | 'transient';

const QUOTA = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded', 'dailyLimitExceeded', 'RATE_LIMIT_EXCEEDED']);
const DISABLED = new Set(['accessNotConfigured', 'SERVICE_DISABLED']);
const SCOPE = new Set(['insufficientPermissions', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT']);

export class GoogleError extends Error {
    readonly failure: Failure;

    constructor(readonly status: number, readonly reason = '', readonly retryAfter?: number, detail?: string) {
        const failure: Failure = status === 401 ? 'auth'
            : status === 429 || (status === 403 && QUOTA.has(reason)) ? 'quota'
                : status === 403 && (DISABLED.has(reason) || SCOPE.has(reason)) ? 'account'
                    : status === 404 || status === 410 ? 'gone'
                        : status >= 400 && status < 500 && status !== 408 && status !== 412 ? 'refused'
                            : 'transient';
        super(detail ?? (failure === 'auth' ? 'Google authorization expired. Reconnect in plugin settings.'
            : failure === 'quota' ? 'Google rate limit reached. Sync will retry automatically.'
                : DISABLED.has(reason) ? 'Enable the Google Calendar API and Google Tasks API in your Google Cloud project.'
                    : SCOPE.has(reason) ? 'Reconnect Google and allow access to Calendar and Tasks.'
                        : failure === 'refused' || failure === 'gone' ? `Google refused the request (${status}${reason ? ` ${reason}` : ''}).`
                            : `Google request failed (${status || 'network'}). Pending edits are kept.`));
        this.failure = failure;
    }
}

// Google's error body names the reason in either the older `errors` list or
// the newer `details` entries. Neither is guaranteed, and some errors are HTML.
export function errorReason(json: unknown): string {
    const error = (json as { error?: { errors?: { reason?: string }[]; details?: { reason?: string }[]; status?: string } } | undefined)?.error;
    return error?.errors?.find(entry => entry.reason)?.reason ?? error?.details?.find(entry => entry.reason)?.reason ?? error?.status ?? '';
}

export function retryAfter(headers: Record<string, string> | undefined, now = Date.now()): number | undefined {
    const value = Object.entries(headers ?? {}).find(([name]) => name.toLowerCase() === 'retry-after')?.[1];
    if (!value) return undefined;
    const seconds = Number(value);
    const milliseconds = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
    return Number.isFinite(milliseconds) && milliseconds >= 0 ? milliseconds : undefined;
}
