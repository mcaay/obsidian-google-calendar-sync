import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { SecretStorage } from 'obsidian';
import type { Transport } from './http';

const AUTH_KEY = 'google-daily-notes-oauth';
export const CLIENT_SECRET_KEY = 'google-daily-notes-client-secret';
const SCOPES = [
    'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/tasks',
];

interface Tokens { clientId: string; access: string; refresh: string; expires: number }

export class GoogleAuth {
    private server?: Server;
    private abort?: () => void;
    private refreshing?: Promise<string>;
    private generation = 0;

    constructor(private secrets: SecretStorage, private clientId: () => string, private transport: Transport, private openBrowser: (url: string) => Promise<void>) {}

    connected(): boolean { return Boolean(this.read()?.refresh); }

    private read(): Tokens | undefined {
        const raw = this.secrets.getSecret(AUTH_KEY);
        if (!raw) return undefined;
        try {
            const tokens = JSON.parse(raw) as Tokens;
            return tokens.clientId === this.clientId() ? tokens : undefined;
        } catch { return undefined; }
    }

    private async exchange(values: Record<string, string>): Promise<Tokens> {
        const generation = this.generation;
        const clientId = this.clientId();
        const response = await this.transport({
            url: 'https://oauth2.googleapis.com/token', method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ ...values, client_id: this.clientId(), client_secret: this.secrets.getSecret(CLIENT_SECRET_KEY) ?? '' }).toString(),
        });
        if (response.status !== 200) throw new Error('Google sign-in failed. Check the desktop OAuth client or reconnect in settings.');
        if (generation !== this.generation || clientId !== this.clientId()) throw new Error('Google connection changed while signing in.');
        const body = response.json as { access_token: string; refresh_token?: string; expires_in: number };
        const tokens: Tokens = { clientId: this.clientId(), access: body.access_token, refresh: body.refresh_token ?? this.read()?.refresh ?? '', expires: Date.now() + body.expires_in * 1000 };
        if (!tokens.refresh) throw new Error('Google did not return offline access. Connect again.');
        this.secrets.setSecret(AUTH_KEY, JSON.stringify(tokens));
        return tokens;
    }

    async token(force = false): Promise<string> {
        const saved = this.read();
        if (!saved) throw new Error('Connect your Google account in plugin settings.');
        if (!force && saved.expires > Date.now() + 60000) return saved.access;
        this.refreshing ??= this.exchange({ grant_type: 'refresh_token', refresh_token: saved.refresh }).then(value => value.access).finally(() => { this.refreshing = undefined; });
        return this.refreshing;
    }

    async connect(openBrowser = this.openBrowser): Promise<void> {
        if (this.server) throw new Error('Google sign-in is already open in your browser.');
        if (!this.clientId().endsWith('.apps.googleusercontent.com')) throw new Error('Enter your Google desktop OAuth client ID first.');
        const verifier = randomBytes(32).toString('base64url');
        const state = randomBytes(32).toString('base64url');
        const server = createServer();
        this.server = server;
        try {
            await new Promise<void>((resolve, reject) => {
                server.once('error', reject);
                server.listen(0, '127.0.0.1', resolve);
            });
            const address = server.address();
            if (!address || typeof address === 'string') throw new Error('Could not start the local Google sign-in callback.');
            const redirect = `http://127.0.0.1:${address.port}/callback`;
            const code = await new Promise<string>((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('Google sign-in timed out. Connect again in settings.')), 30 * 60 * 1000);
                const finish = (error?: Error, value?: string) => {
                    clearTimeout(timeout);
                    if (error) reject(error); else resolve(value!);
                };
                this.abort = () => finish(new Error('Google sign-in cancelled.'));
                server.on('request', (request, response) => {
                    const url = new URL(request.url ?? '', redirect);
                    if (request.method !== 'GET' || url.pathname !== '/callback' || url.searchParams.get('state') !== state) {
                        response.writeHead(400).end('Invalid sign-in callback.'); return;
                    }
                    const value = url.searchParams.get('code');
                    response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
                    response.end(value ? 'Sign-in received. Return to Obsidian.' : 'Sign-in was not completed. Return to Obsidian.');
                    finish(value ? undefined : new Error('Google sign-in was declined.'), value ?? undefined);
                });
                const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
                url.search = new URLSearchParams({
                    client_id: this.clientId(), redirect_uri: redirect, response_type: 'code',
                    scope: SCOPES.join(' '), state, access_type: 'offline', prompt: 'consent',
                    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
                }).toString();
                void openBrowser(url.toString()).catch(error => finish(error as Error));
            });
            await this.exchange({ code, redirect_uri: redirect, grant_type: 'authorization_code', code_verifier: verifier });
        } finally { this.dispose(); }
    }

    disconnect(): void {
        this.dispose();
        this.secrets.setSecret(AUTH_KEY, '');
    }

    dispose(): void {
        this.generation++;
        this.abort?.(); this.abort = undefined;
        this.server?.close(); this.server = undefined;
    }
}
