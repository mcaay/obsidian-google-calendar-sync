import { base64url } from './encoding';
import { encryptConnection, decryptConnection, type ConnectionTransfer } from './connection-transfer';
import { Platform, type SecretStorage } from 'obsidian';
import type { Transport } from './http';

// Not `import type`: Obsidian's review flags every static Node import, even type-only ones.
type Server = import('node:http').Server;

const AUTH_KEY = 'google-daily-notes-oauth';
export const CLIENT_SECRET_KEY = 'google-daily-notes-client-secret';
const SCOPES: Record<string, string> = {
    'https://www.googleapis.com/auth/calendar.calendarlist.readonly': 'your calendar list',
    'https://www.googleapis.com/auth/calendar.events': 'calendar events',
    'https://www.googleapis.com/auth/tasks': 'Google Tasks',
};

interface Tokens { clientId: string; access: string; refresh: string; expires: number }

// Google revoked the refresh token or it expired. Retrying cannot help.
export class ReconnectNeeded extends Error {
    constructor() { super('Google access expired or was revoked. Reconnect in Calendar Sync settings.'); }
}

export class GoogleAuth {
    private server?: Server;
    private abort?: () => void;
    private refreshing?: Promise<string>;
    private generation = 0;
    private dead = false;

    constructor(private secrets: SecretStorage, private clientId: () => string, private transport: Transport, private openBrowser: (url: string) => Promise<void>) {}

    connected(): boolean { return Boolean(this.read()?.refresh) && !this.dead; }

    needsReconnect(): boolean { return this.dead && Boolean(this.read()?.refresh); }

    private read(): Tokens | undefined {
        let raw: string | null;
        try { raw = this.secrets.getSecret(AUTH_KEY); } catch { return undefined; }
        if (!raw) return undefined;
        try {
            const tokens = JSON.parse(raw) as Tokens;
            return tokens.clientId === this.clientId() ? tokens : undefined;
        } catch { return undefined; }
    }

    private store(key: string, value: string): void {
        try { this.secrets.setSecret(key, value); }
        catch (error) { throw new Error(`Obsidian could not store the Google connection securely: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
    }

    private async exchange(values: Record<string, string>): Promise<Tokens> {
        const generation = this.generation;
        const clientId = this.clientId();
        const response = await this.transport({
            url: 'https://oauth2.googleapis.com/token', method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ ...values, client_id: this.clientId(), client_secret: this.secrets.getSecret(CLIENT_SECRET_KEY) ?? '' }).toString(),
        });
        if (response.status !== 200) {
            // 2.6: a revoked or expired refresh token stays dead until reconnect.
            if (values.grant_type === 'refresh_token' && (response.json as { error?: string } | undefined)?.error === 'invalid_grant' && generation === this.generation) {
                this.dead = true;
                throw new ReconnectNeeded();
            }
            throw new Error('Google sign-in failed. Check the desktop OAuth client or reconnect in settings.');
        }
        if (generation !== this.generation || clientId !== this.clientId()) throw new Error('Google connection changed while signing in.');
        const body = response.json as { access_token: string; refresh_token?: string; expires_in: number; scope?: string };
        if (values.grant_type === 'authorization_code' && body.scope !== undefined) {
            const granted = new Set(body.scope.split(' '));
            const missing = Object.entries(SCOPES).filter(([scope]) => !granted.has(scope)).map(([, name]) => name);
            if (missing.length) throw new Error(`Google did not grant access to ${missing.join(' and ')}. Connect again and allow all requested access.`);
        }
        const tokens: Tokens = { clientId: this.clientId(), access: body.access_token, refresh: body.refresh_token ?? this.read()?.refresh ?? '', expires: Date.now() + body.expires_in * 1000 };
        if (!tokens.refresh) throw new Error('Google did not return offline access. Connect again.');
        this.store(AUTH_KEY, JSON.stringify(tokens));
        this.dead = false;
        return tokens;
    }

    async token(force = false): Promise<string> {
        const saved = this.read();
        if (!saved) throw new Error('Connect your Google account in plugin settings.');
        if (this.dead) throw new ReconnectNeeded();
        if (!force && saved.expires > Date.now() + 60000) return saved.access;
        this.refreshing ??= this.exchange({ grant_type: 'refresh_token', refresh_token: saved.refresh }).then(value => value.access).finally(() => { this.refreshing = undefined; });
        return this.refreshing;
    }

    async connect(openBrowser = this.openBrowser): Promise<void> {
        // Keep this guard first: Obsidian's review accepts the Node import below only behind it.
        if (!Platform.isDesktop) throw new Error('Use the setup code from your connected computer.');
        if (!this.clientId().endsWith('.apps.googleusercontent.com')) throw new Error('Enter your Google desktop OAuth client ID first.');
        // A new attempt replaces one still waiting for the browser.
        if (this.server) this.dispose();
        const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
        const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
        const state = base64url(crypto.getRandomValues(new Uint8Array(32)));
        // Import only when desktop sign-in is invoked. Mobile has no Node HTTP.
        const { createServer } = await import('node:http');
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
                const timeout = window.setTimeout(() => reject(new Error('Google sign-in timed out. Connect again in settings.')), 30 * 60 * 1000);
                const finish = (error?: Error, value?: string) => {
                    window.clearTimeout(timeout);
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
                    scope: Object.keys(SCOPES).join(' '), state, access_type: 'offline', prompt: 'consent',
                    code_challenge: challenge, code_challenge_method: 'S256',
                }).toString();
                void openBrowser(url.toString()).catch(error => finish(error as Error));
            });
            await this.exchange({ code, redirect_uri: redirect, grant_type: 'authorization_code', code_verifier: verifier });
        } finally { if (this.server === server) this.dispose(); }
    }

    async shareConnection(): Promise<{ transfer: ConnectionTransfer; code: string }> {
        const tokens = this.read();
        if (!tokens) throw new Error('Connect Google on this device first.');
        return encryptConnection({ clientId: tokens.clientId, refresh: tokens.refresh, clientSecret: this.secrets.getSecret(CLIENT_SECRET_KEY) ?? '' });
    }

    async importConnection(transfer: ConnectionTransfer, code: string): Promise<void> {
        const generation = this.generation;
        const credentials = await decryptConnection(transfer, code);
        if (credentials.clientId !== this.clientId()) throw new Error('Wait for the Google client settings to finish syncing, then try again.');
        // Validate with Google before replacing this device's existing connection.
        const response = await this.transport({
            url: 'https://oauth2.googleapis.com/token', method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ client_id: credentials.clientId, client_secret: credentials.clientSecret,
                grant_type: 'refresh_token', refresh_token: credentials.refresh }).toString(),
        });
        if (response.status !== 200) throw new Error('Google rejected the connection. Reconnect on your computer and create a new setup code.');
        if (generation !== this.generation || credentials.clientId !== this.clientId()) throw new Error('Google connection changed while signing in.');
        const body = response.json as { access_token: string; expires_in: number; refresh_token?: string };
        if (!body.access_token || !Number.isFinite(body.expires_in)) throw new Error('Google returned an incomplete connection. Try again.');
        this.store(CLIENT_SECRET_KEY, credentials.clientSecret);
        this.store(AUTH_KEY, JSON.stringify({ clientId: credentials.clientId, access: body.access_token,
            refresh: body.refresh_token ?? credentials.refresh, expires: Date.now() + body.expires_in * 1000 } satisfies Tokens));
        this.dead = false;
    }

    disconnect(): void {
        this.dispose();
        this.dead = false;
        this.store(AUTH_KEY, '');
    }

    dispose(): void {
        this.generation++;
        this.abort?.(); this.abort = undefined;
        this.server?.close(); this.server = undefined;
    }
}
