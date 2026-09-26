import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';
import { itemKey } from '../src/markdown';
import { initialData } from '../src/types';

it('preserves existing Unicode row IDs without Buffer', () => {
    const parts = ['event', 'kalendarz-zażółć@example.com', '例-123'];
    expect(itemKey('event', parts[1]!, parts[2]!)).toBe(Buffer.from(JSON.stringify(parts)).toString('base64url'));
});

it('loads the production plugin in a mobile runtime with no Node, Electron or Buffer', async () => {
    const bundled = await build({ entryPoints: ['src/main.ts'], bundle: true, write: false, format: 'cjs', platform: 'browser',
        external: ['obsidian', 'node:http', '@codemirror/*', '@lezer/*'], target: 'es2022' });
    const secrets = new Map<string, string>();
    const local = new Map<string, unknown>();
    const app = {
        secretStorage: { getSecret: (key: string) => secrets.get(key), setSecret: (key: string, value: string) => secrets.set(key, value) },
        loadLocalStorage: (key: string) => local.get(key),
        saveLocalStorage: (key: string, value: unknown) => local.set(key, value),
        workspace: { onLayoutReady: () => undefined },
    };
    class Plugin {
        app = app;
        async loadData() { return initialData(); }
        addStatusBarItem() { return { setText() {}, setAttribute() {}, addClass() {} }; }
        registerEditorExtension() {}
        addSettingTab() {}
        addCommand() {}
        registerDomEvent() {}
        register() {}
    }
    const runtimeModule = { exports: {} as { default: new () => { onload(): Promise<void>; auth: { connect(): Promise<void> } } } };
    const require = createRequire(import.meta.url);
    runInNewContext(bundled.outputFiles[0]!.text, {
        module: runtimeModule, exports: runtimeModule.exports,
        crypto, TextEncoder, TextDecoder, btoa, atob, structuredClone, URL, URLSearchParams, setTimeout, clearTimeout,
        window: {}, document: {},
        require: (id: string) => {
            if (id === 'obsidian') return { Plugin, PluginSettingTab: class {}, Platform: { isMobile: true } };
            if (id.startsWith('@codemirror/') || id.startsWith('@lezer/')) return require(id) as unknown;
            throw new Error(`Unavailable on mobile: ${id}`);
        },
    });
    const plugin = new runtimeModule.exports.default();
    await plugin.onload();
    expect(local.size).toBe(1);
    await expect(plugin.auth.connect()).rejects.toThrow('setup code');
});
