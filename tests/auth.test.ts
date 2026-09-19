import { describe, expect, it, vi } from 'vitest';
import type { SecretStorage } from 'obsidian';
import { GoogleAuth } from '../src/auth';

function setup(expires: number) {
    const values = new Map<string, string>([['google-daily-notes-oauth', JSON.stringify({ clientId: 'client', access: 'old-access', refresh: 'refresh', expires })]]);
    const secrets = { getSecret: (key: string) => values.get(key) ?? null, setSecret: (key: string, value: string) => values.set(key, value) } as unknown as SecretStorage;
    const transport = vi.fn(async () => ({ status: 200, json: { access_token: 'new-access', expires_in: 3600 } }));
    return { auth: new GoogleAuth(secrets, () => 'client', transport, async () => undefined), transport, values };
}

describe('OAuth token management', () => {
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
