export interface HttpRequest {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
}
export interface HttpResponse { status: number; json: unknown }
export type Transport = (request: HttpRequest) => Promise<HttpResponse>;

export class GoogleError extends Error {
    constructor(public status: number) {
        super(status === 401 ? 'Google authorization expired. Reconnect in plugin settings.'
            : status === 403 ? 'Google denied access. Check API enablement and account permissions.'
                : status === 429 ? 'Google rate limit reached. Sync will retry automatically.'
                    : `Google request failed (${status}). Pending edits are kept.`);
    }
}
