import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { beforeAll, expect, it } from 'vitest';
import { itemKey } from '../src/markdown';
import { initialData } from '../src/types';

type Runtime = {
    onload(): Promise<void>; auth: { connect(): Promise<void> }; saveLocal(scope: 'journal' | 'all'): boolean;
    data: { outbox: Record<string, unknown>; connectionTransfer?: unknown };
    controller: { scheduler: { request(path: string, reason: string): void } };
};
let bundle = '';

beforeAll(async () => {
    const bundled = await build({ entryPoints: ['src/main.ts'], bundle: true, write: false, format: 'cjs', platform: 'browser', supported: { 'dynamic-import': false },
        external: ['obsidian', 'node:http', '@codemirror/*', '@lezer/*'], target: 'es2022' });
    bundle = bundled.outputFiles[0]!.text;
});

// Loads the production bundle with a fake Obsidian. `store` behaves like
// Obsidian's saveLocalStorage: it swallows write errors.
function load(store: (key: string, value: unknown) => void, local = new Map<string, unknown>(), shared: unknown = initialData()) {
    const secrets = new Map<string, string>();
    const notices: string[] = [];
    const tooltips: string[] = [];
    const app = {
        secretStorage: { getSecret: (key: string) => secrets.get(key), setSecret: (key: string, value: string) => secrets.set(key, value) },
        loadLocalStorage: (key: string) => structuredClone(local.get(key)) ?? null,
        saveLocalStorage: (key: string, value: unknown) => { try { store(key, value); } catch { /* Obsidian ignores it. */ } },
        workspace: { onLayoutReady: () => undefined },
    };
    class Plugin {
        app = app;
        async loadData() { return structuredClone(shared); }
        addStatusBarItem() { return { setText() {}, setAttribute() {}, addClass() {} }; }
        registerEditorExtension() {}
        addSettingTab() {}
        addCommand() {}
        registerDomEvent() {}
        register() {}
        async saveData() {}
    }
    const runtimeModule = { exports: {} as { default: new () => Runtime } };
    const require = createRequire(import.meta.url);
    runInNewContext(bundle, {
        module: runtimeModule, exports: runtimeModule.exports,
        crypto, TextEncoder, TextDecoder, btoa, atob, structuredClone, URL, URLSearchParams, setTimeout, clearTimeout, performance,
        window: { setTimeout, clearTimeout }, document: {},
        require: (id: string) => {
            if (id === 'obsidian') {
                return { Plugin, PluginSettingTab: class {}, Platform: { isMobile: true, isDesktop: false }, setTooltip: (_el: unknown, text: string) => tooltips.push(text), Notice: class { constructor(message: string) { notices.push(message); } }, MarkdownView: class {}, TFile: class {} };
            }
            if (id.startsWith('@codemirror/') || id.startsWith('@lezer/')) return require(id) as unknown;
            throw new Error(`Unavailable on mobile: ${id}`);
        },
    });
    return { plugin: new runtimeModule.exports.default(), local, notices, tooltips };
}

it('preserves existing Unicode row IDs without Buffer', () => {
    const parts = ['event', 'kalendarz-zażółć@example.com', '例-123'];
    expect(itemKey('event', parts[1]!, parts[2]!)).toBe(Buffer.from(JSON.stringify(parts)).toString('base64url'));
});

it('loads the production plugin in a mobile runtime with no Node, Electron or Buffer', async () => {
    const local = new Map<string, unknown>();
    const { plugin } = load((key, value) => local.set(key, structuredClone(value)), local);
    await plugin.onload();
    expect([...local.keys()].sort()).toEqual(['google-daily-notes-device-state', 'google-daily-notes-journal', 'google-daily-notes-session']);
    await expect(plugin.auth.connect()).rejects.toThrow('setup code');
});

it('notices a storage write that failed silently (1.7)', async () => {
    const local = new Map<string, unknown>();
    let full = false;
    const { plugin } = load((key, value) => {
        if (full) throw new DOMException('Quota exceeded', 'QuotaExceededError');
        local.set(key, structuredClone(value));
    }, local);
    await plugin.onload();
    expect(plugin.saveLocal('journal')).toBe(true);
    full = true;
    plugin.data.outbox.pending = { key: 'pending' };
    expect(plugin.saveLocal('journal')).toBe(false);
    expect(plugin.saveLocal('all')).toBe(false);
    full = false;
    expect(plugin.saveLocal('all')).toBe(true);
    expect((local.get('google-daily-notes-journal') as { outbox: object }).outbox).toHaveProperty('pending');
});

it('removes an expired setup package and ends each run with a status, including Not connected (F-L8, O-L9)', async () => {
    const shared = { ...initialData(), connectionTransfer: { version: 1, expires: Date.now() - 1000, iv: 'x', encrypted: 'y' } };
    const { plugin, tooltips } = load(() => undefined, new Map(), shared);
    await plugin.onload();
    expect(plugin.data.connectionTransfer).toBeUndefined();
    plugin.controller.scheduler.request('2026-09-19.md', 'open');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(tooltips.at(-1)).toBe('Google Calendar sync: Not connected\nConnect Google in Calendar Sync settings.');
});
