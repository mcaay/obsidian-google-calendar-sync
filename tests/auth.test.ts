import { describe, expect, it, vi } from 'vitest';
import type { SecretStorage } from 'obsidian';
import { CLIENT_SECRET_KEY, GoogleAuth, ReconnectNeeded } from '../src/auth';
import { encryptConnection } from '../src/connection-transfer';

function setup(expires: number) {
    const values = new Map<string, string>([['google-daily-notes-oauth', JSON.stringify({ clientId: 'client', access: 'old-access', refresh: 'refresh', expires })]]);
    const secrets = { getSecret: (key: string) => values.get(key) ?? null, setSecret: (key: string, value: string) => values.set(key, value) } as unknown as SecretStorage;
    const transport = vi.fn(async () => ({ status: 200, json: { access_token: 'new-access', expires_in: 3600 } }));
    return { auth: new GoogleAuth(secrets, () => 'client', transport, async () => undefined), transport, values };
}

describe('OAuth token management', () => {
    it('imports a synced connection into local secrets and refreshes directly on mobile', async () => {
        const values = new Map<string, string>();
        const secrets = { getSecret: (key: string) => values.get(key) ?? null, setSecret: (key: string, value: string) => values.set(key, value) } as unknown as SecretStorage;
        const transport = vi.fn(async () => ({ status: 200, json: { access_token: 'mobile-access', expires_in: 3600 } }));
        const auth = new GoogleAuth(secrets, () => 'test.apps.googleusercontent.com', transport, async () => undefined, true);
        const { transfer, code } = await encryptConnection({ clientId: 'test.apps.googleusercontent.com', clientSecret: 'secret', refresh: 'refresh' });
        await auth.importConnection(transfer, code);
        expect(auth.connected()).toBe(true);
        expect(await auth.token()).toBe('mobile-access');
        expect(values.get(CLIENT_SECRET_KEY)).toBe('secret');
        expect(transport.mock.calls[0]).toBeDefined();
        await auth.token(true);
        expect(transport).toHaveBeenCalledTimes(2);
        await expect(auth.connect()).rejects.toThrow('setup code');
    });
    it('keeps the current connection when importing an invalid or rejected package', async () => {
        const h = setup(Date.now() + 120000);
        const before = new Map(h.values);
        const { transfer, code } = await encryptConnection({ clientId: 'other.apps.googleusercontent.com', clientSecret: 'secret', refresh: 'refresh' });
        await expect(h.auth.importConnection(transfer, code)).rejects.toThrow('settings');
        expect(h.values).toEqual(before);
        expect(h.transport).not.toHaveBeenCalled();
    });
    it('stops retrying a revoked refresh token until the user reconnects (2.6)', async () => {
        const h = setup(0);
        h.transport.mockResolvedValue({ status: 400, json: { error: 'invalid_grant' } } as never);
        await expect(h.auth.token()).rejects.toBeInstanceOf(ReconnectNeeded);
        await expect(h.auth.token()).rejects.toBeInstanceOf(ReconnectNeeded);
        expect(h.transport).toHaveBeenCalledOnce();
        expect(h.auth.connected()).toBe(false);
        expect(h.auth.needsReconnect()).toBe(true);
    });
    it('reports scopes the consent screen did not grant (5.3)', async () => {
        const values = new Map<string, string>();
        const secrets = { getSecret: (key: string) => values.get(key) ?? null, setSecret: (key: string, value: string) => values.set(key, value) } as unknown as SecretStorage;
        const transport = vi.fn(async () => ({ status: 200, json: { access_token: 'a', refresh_token: 'r', expires_in: 3600, scope: 'https://www.googleapis.com/auth/calendar.events' } }));
        const auth = new GoogleAuth(secrets, () => 'test.apps.googleusercontent.com', transport, async () => undefined);
        try {
            await expect(auth.connect(async link => {
                const url = new URL(link);
                const callback = new URL(url.searchParams.get('redirect_uri')!);
                callback.search = new URLSearchParams({ code: 'c', state: url.searchParams.get('state')! }).toString();
                await fetch(callback);
            })).rejects.toThrow('did not grant access to your calendar list and Google Tasks');
            expect(auth.connected()).toBe(false);
        } finally { auth.dispose(); }
    });
    it('replaces a sign-in that is still waiting instead of failing (5.3)', async () => {
        const values = new Map<string, string>();
        const secrets = { getSecret: (key: string) => values.get(key) ?? null, setSecret: (key: string, value: string) => values.set(key, value) } as unknown as SecretStorage;
        const transport = vi.fn(async () => ({ status: 200, json: { access_token: 'a', refresh_token: 'r', expires_in: 3600 } }));
        const auth = new GoogleAuth(secrets, () => 'test.apps.googleusercontent.com', transport, async () => undefined);
        try {
            const first = auth.connect(async () => undefined).catch((error: unknown) => error);
            await new Promise(resolve => setTimeout(resolve, 20));
            await auth.connect(async link => {
                const url = new URL(link);
                const callback = new URL(url.searchParams.get('redirect_uri')!);
                callback.search = new URLSearchParams({ code: 'c', state: url.searchParams.get('state')! }).toString();
                await fetch(callback);
            });
            expect(String(await first)).toContain('cancelled');
            expect(auth.connected()).toBe(true);
        } finally { auth.dispose(); }
    });
    it('shows a SecretStorage failure instead of losing the connection silently (5.3)', async () => {
        const h = setup(0);
        const secrets = { getSecret: () => JSON.stringify({ clientId: 'client', access: 'a', refresh: 'r', expires: 0 }), setSecret: () => { throw new Error('Keychain locked'); } } as unknown as SecretStorage;
        const auth = new GoogleAuth(secrets, () => 'client', h.transport, async () => undefined);
        await expect(auth.token()).rejects.toThrow('Keychain locked');
    });
    it('can authorize in a chosen browser without opening the system browser', async () => {
        const values = new Map<string, string>();
        const secrets = { getSecret: (key: string) => values.get(key) ?? null, setSecret: (key: string, value: string) => values.set(key, value) } as unknown as SecretStorage;
        const transport = vi.fn(async () => ({ status: 200, json: { access_token: 'access', refresh_token: 'refresh', expires_in: 3600 } }));
        const systemBrowser = vi.fn(async () => undefined);
        const auth = new GoogleAuth(secrets, () => 'test.apps.googleusercontent.com', transport, systemBrowser);
        try {
            await auth.connect(async link => {
                const url = new URL(link);
                expect(url.origin).toBe('https://accounts.google.com');
                expect(url.searchParams.get('code_challenge_method')).toBe('S256');
                const callback = new URL(url.searchParams.get('redirect_uri')!);
                callback.search = new URLSearchParams({ code: 'test-code', state: 'incorrect' }).toString();
                expect((await fetch(callback)).status).toBe(400);
                expect(transport).not.toHaveBeenCalled();
                callback.searchParams.set('state', url.searchParams.get('state')!);
                expect((await fetch(callback)).status).toBe(200);
            });
            expect(systemBrowser).not.toHaveBeenCalled();
            expect(auth.connected()).toBe(true);
            expect(transport).toHaveBeenCalledOnce();
        } finally { auth.dispose(); }
    });
    it('reuses a valid token', async () => {
        const h = setup(Date.now() + 120000); expect(await h.auth.token()).toBe('old-access'); expect(h.transport).not.toHaveBeenCalled();
    });
    it('coalesces concurrent refreshes and preserves the refresh token', async () => {
        const h = setup(0); expect(await Promise.all([h.auth.token(), h.auth.token()])).toEqual(['new-access', 'new-access']);
        expect(h.transport).toHaveBeenCalledOnce();
        expect(JSON.parse(h.values.get('google-daily-notes-oauth')!).refresh).toBe('refresh');
    });
    it('clears authorization on disconnect', async () => {
        const h = setup(0); h.auth.disconnect(); expect(h.auth.connected()).toBe(false);
        await expect(h.auth.token()).rejects.toThrow('Connect');
    });
    it('cannot restore credentials after disconnect during a refresh', async () => {
        const h = setup(0);
        let finish!: () => void;
        h.transport.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ status: 200, json: { access_token: 'late-token', expires_in: 3600 } }); }));
        const pending = h.auth.token();
        h.auth.disconnect(); finish();
        await expect(pending).rejects.toThrow('connection changed');
        expect(h.auth.connected()).toBe(false);
    });
});
