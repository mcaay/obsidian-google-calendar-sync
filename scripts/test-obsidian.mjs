import { chromium } from 'playwright-core';
import { build } from 'esbuild';
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { builtinModules } from 'node:module';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const directory = await mkdtemp(join(tmpdir(), 'google-daily-notes-test-'));
const profile = join(directory, 'profile');
const vault = join(directory, 'Test vault');
const pluginFolder = join(vault, '.obsidian/plugins/google-daily-notes');
await mkdir(profile, { recursive: true });
await mkdir(pluginFolder, { recursive: true });
await mkdir('output/playwright', { recursive: true });
const support = join(homedir(), 'Library/Application Support/obsidian');
const updates = (await readdir(support)).filter(name => /^obsidian-.*\.asar$/.test(name)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
if (updates.length) await cp(join(support, updates.at(-1)), join(profile, updates.at(-1)));
await writeFile(join(profile, 'obsidian.json'), JSON.stringify({ vaults: { '1234567890abcdef': { path: vault, ts: Date.now(), open: true } } }));
await writeFile(join(vault, '.obsidian/app.json'), JSON.stringify({ vimMode: true, useTab: true, tabSize: 4, propertiesInDocument: 'hidden', livePreview: true, showLineNumber: false, defaultViewMode: 'source', readableLineLength: true }));
const plugins = ['google-daily-notes'];
await writeFile(join(vault, '.obsidian/hotkeys.json'), JSON.stringify({ 'editor:toggle-checklist-status': [{ modifiers: ['Mod'], key: 'Enter' }] }));
// Optional compatibility run against a locally installed Tasks plugin. Copy
// only its executable assets; all task data and settings below are fixtures.
if (process.env.OBSIDIAN_TASKS_PLUGIN) {
    const tasksFolder = join(vault, '.obsidian/plugins/obsidian-tasks-plugin');
    await mkdir(tasksFolder, { recursive: true });
    for (const file of ['main.js', 'manifest.json', 'styles.css']) await cp(join(process.env.OBSIDIAN_TASKS_PLUGIN, file), join(tasksFolder, file));
    await writeFile(join(tasksFolder, 'data.json'), JSON.stringify({ setDoneDate: false, recurrenceOnNextLine: true }));
    await writeFile(join(vault, '.obsidian/hotkeys.json'), JSON.stringify({ 'editor:toggle-checklist-status': [], 'obsidian-tasks-plugin:toggle-done': [{ modifiers: ['Mod'], key: 'Enter' }] }));
    plugins.unshift('obsidian-tasks-plugin');
}
await writeFile(join(vault, '.obsidian/community-plugins.json'), JSON.stringify(plugins));
await writeFile(join(vault, '.obsidian/core-plugins.json'), JSON.stringify(['file-explorer', 'daily-notes', 'templates']));
await writeFile(join(vault, '2026-09-19.md'), `---\ngoogle-daily: true\n---\n# Daily work\n\n- [ ] My own task\n\n- [ ] google events <!-- gdn:events -->\n- [ ] recurring <!-- gdn:recurring -->\n- [ ] google tasks <!-- gdn:tasks -->\n\nMy own notes stay here.\n`);
for (const file of ['manifest.json', 'styles.css']) await cp(file, join(pluginFolder, file));
await build({ entryPoints: ['tests/obsidian-fixture.ts'], outfile: join(pluginFolder, 'main.js'), bundle: true, platform: 'node', format: 'cjs', target: 'es2022', external: ['obsidian', 'electron', '@codemirror/*', '@lezer/*', ...builtinModules, ...builtinModules.map(name => `node:${name}`)] });

console.log(`Isolated test vault: ${vault}`);
let application;
let processHandle;
try {
    const environment = { ...process.env };
    delete environment.ELECTRON_RUN_AS_NODE;
    processHandle = spawn(process.env.OBSIDIAN_EXECUTABLE ?? '/Applications/Obsidian.app/Contents/MacOS/Obsidian', [`--user-data-dir=${profile}`, '--remote-debugging-port=0'], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    processHandle.stdout.on('data', chunk => console.log('Obsidian:', chunk.toString().slice(0, 1000)));
    processHandle.stderr.on('data', chunk => console.log('Obsidian stderr:', chunk.toString().slice(0, 1000)));
    let port;
    for (let attempt = 0; attempt < 100; attempt++) {
        try { port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; break; }
        catch { await new Promise(resolve => setTimeout(resolve, 300)); }
    }
    if (!port) throw new Error('Isolated Obsidian did not open its debugging port.');
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    application = {
        firstWindow: async () => browser.contexts()[0].pages()[0] ?? browser.contexts()[0].waitForEvent('page'),
        windows: () => browser.contexts()[0].pages(),
        close: () => browser.close(),
    };
    const page = await application.firstWindow();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') console.log('Renderer:', message.text().slice(0, 300)); });
    await page.waitForFunction(() => window.app?.workspace?.layoutReady, { timeout: 30000 });
    assert.equal(await page.evaluate(() => window.app.vault.adapter.getBasePath()), vault, 'Refuse to run tests against a personal vault');
    console.log('Initial UI:', (await page.locator('body').innerText()).slice(0, 1200));
    const trust = page.getByText('Trust author and enable plugins', { exact: true });
    if (await trust.isVisible()) await trust.click();
    await page.waitForFunction(() => Boolean(window.app?.plugins?.plugins?.['google-daily-notes']));
    for (const other of application.windows()) if (other !== page) await other.close();
    await page.bringToFront();
    // Native setup UI can keep community plugins disabled in a new profile.
    await page.evaluate(async () => {
        if (!window.app.plugins.plugins['google-daily-notes']) await window.app.plugins.enablePlugin('google-daily-notes');
        const file = window.app.vault.getAbstractFileByPath('2026-09-19.md');
        await window.app.workspace.getLeaf(false).openFile(file);
    });
    await page.waitForFunction(() => window.app.workspace.activeEditor?.editor?.getValue().includes('Weekly review') && Object.keys(window.app.plugins.plugins['google-daily-notes'].data.notes['2026-09-19.md']?.rows ?? {}).length === 5);
    await page.evaluate(() => window.app.plugins.plugins['google-daily-notes'].persist());
    await page.evaluate(async () => {
        await window.app.plugins.disablePlugin('google-daily-notes');
        await window.app.plugins.enablePlugin('google-daily-notes');
    });
    await page.waitForFunction(() => Object.keys(window.app.plugins.plugins['google-daily-notes'].data.notes['2026-09-19.md']?.rows ?? {}).length === 5);
    await page.evaluate(() => window.app.setting.close());
    await page.bringToFront();
    console.log('Plugin loaded; Markdown rows rendered.');
    const editorText = () => page.evaluate(() => window.app.workspace.activeEditor.editor.getValue());
    const selectRow = async (title, column = 0) => {
        await page.evaluate(({ title, column }) => {
            const editor = window.app.workspace.activeEditor.editor;
            const line = editor.getValue().split('\n').findIndex(value => value.includes(title));
            if (line < 0) throw new Error(`Missing row: ${title}`);
            editor.setCursor({ line, ch: column }); editor.focus();
        }, { title, column });
    };
    const setVim = async enabled => {
        await page.evaluate(enabled => {
            window.app.vault.setConfig('vimMode', enabled);
            window.app.workspace.updateOptions();
        }, enabled);
        await page.waitForFunction(enabled => Boolean(window.app.workspace.activeEditor.editor.cm.cm?.state.vim) === enabled, enabled);
    };
    const before = await editorText();
    const syncedRows = before.split('\n').filter(line => /<!-- gdn:[A-Za-z0-9_-]{10,} -->$/.test(line));
    assert.equal(syncedRows.length, 5);
    assert.ok(syncedRows.every(line => line.startsWith('\t- ')), 'Generated rows use Obsidian tabs');
    assert.doesNotMatch(before, /^\s+- \[ \][ \t]*$/m, 'No automatic blank task');
    console.log('PASS: configured tabs in every Google group, no blank placeholder.');
    await selectRow('My own task');
    await page.keyboard.press('Meta+Enter');
    assert.match(await editorText(), /- \[x\] My own task/);
    await page.keyboard.press('Meta+Enter');
    assert.match(await editorText(), /- \[ \] My own task/);
    assert.equal(await page.evaluate(() => window.gdnTest.operations.length), 0, 'Local task shortcuts never reach Google');
    console.log('PASS: the existing checkbox shortcut still works for local tasks.');
    await selectRow('Weekly review');
    await page.keyboard.press('o');
    assert.equal(await editorText(), before, 'Vim o must not insert calendar rows');
    await page.keyboard.press('O');
    assert.equal(await editorText(), before, 'Vim O must not insert calendar rows');
    await page.keyboard.press('Meta+Enter');
    await page.waitForFunction(() => window.gdnTest.operations.some(operation => operation.done === true), undefined, { timeout: 3000 });
    assert.match(await editorText(), /\[x\] 90 min Weekly review/);
    assert.equal(await page.evaluate(() => window.gdnTest.operations.length), 1, 'One keypress sends one update');
    for (const done of [false, true]) {
        const previous = await page.evaluate(() => window.gdnTest.operations.length);
        await page.keyboard.press('Meta+Enter');
        await page.waitForFunction(({ previous, done }) => window.gdnTest.operations.length === previous + 1 && window.gdnTest.operations.at(-1).done === done, { previous, done }, { timeout: 3000 });
    }
    console.log('PASS: calendar o/O blocked, Cmd+Enter toggled and synced.');

    await selectRow('Weekly review');
    await page.keyboard.press('A');
    await page.keyboard.type(' updated');
    assert.match(await editorText(), /Weekly review updated/);
    assert.equal(await page.evaluate(() => window.gdnTest.operations.some(operation => operation.title === 'Weekly review updated')), false, 'Do not sync a title before leaving insert mode');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => window.gdnTest.operations.some(operation => operation.title === 'Weekly review updated'));
    console.log('PASS: Vim A edits the title; Escape syncs it.');

    await selectRow('Buy coffee');
    await page.keyboard.press('o');
    await page.keyboard.type('New task from Vim');
    assert.equal(await page.evaluate(() => window.gdnTest.operations.some(operation => operation.create)), false, 'Do not create incomplete drafts in insert mode');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => window.gdnTest.operations.some(operation => operation.create && operation.title === 'New task from Vim'));
    await page.waitForFunction(() => window.app.workspace.activeEditor.editor.getValue().includes('New task from Vim <!-- gdn:'));
    assert.match(await page.evaluate(() => { const editor = window.app.workspace.activeEditor.editor; return editor.getLine(editor.getCursor().line); }), /New task from Vim/, 'Cursor stays on a task when its local ID becomes a Google ID');
    console.log('PASS: Vim o creates one dated Google task.');

    await selectRow('Buy coffee');
    const position = await page.evaluate(() => window.app.workspace.activeEditor.editor.getCursor());
    await page.keyboard.press('j');
    assert.equal((await page.evaluate(() => window.app.workspace.activeEditor.editor.getCursor())).line, position.line + 1);
    console.log('PASS: ordinary Vim movement.');
    await selectRow('Monthly report', 12);
    await page.keyboard.press('j');
    assert.match(await page.evaluate(() => { const editor = window.app.workspace.activeEditor.editor; return editor.getLine(editor.getCursor().line); }), /google tasks/, 'Vim j reaches the next section without invisible lines');
    await selectRow('Buy coffee');
    await page.keyboard.press('Meta+Enter');
    await page.waitForFunction(() => window.gdnTest.operations.some(operation => operation.kind === 'task' && !operation.create && operation.done === true));
    assert.match(await editorText(), /\[x\] Buy coffee/);
    for (const done of [false, true]) {
        const previous = await page.evaluate(() => window.gdnTest.operations.length);
        await page.keyboard.press('Meta+Enter');
        await page.waitForFunction(({ previous, done }) => window.gdnTest.operations.length === previous + 1 && window.gdnTest.operations.at(-1).done === done, { previous, done }, { timeout: 3000 });
    }
    console.log('PASS: calendar tasks and Google Tasks check and uncheck exactly once per Cmd+Enter.');

    await page.screenshot({ path: 'output/playwright/daily-note.png' });
    await page.evaluate(async () => {
        const before = window.app.workspace.activeEditor.editor.getValue();
        await window.app.plugins.disablePlugin('google-daily-notes');
        await window.app.plugins.enablePlugin('google-daily-notes');
        if (window.app.workspace.activeEditor.editor.getValue() !== before) throw new Error('Reload modified note unexpectedly');
    });
    console.log('PASS: plugin unload/reload.');
    for (const title of ['Weekly review updated', 'Buy coffee']) {
        await selectRow(title);
        for (const done of [false, true]) {
            const previous = await page.evaluate(() => window.gdnTest.operations.length);
            await page.keyboard.press('Meta+Enter');
            await page.waitForFunction(({ previous, done }) => window.gdnTest.operations.length === previous + 1 && window.gdnTest.operations.at(-1).done === done, { previous, done }, { timeout: 3000 });
        }
    }
    console.log('PASS: both checkbox types still toggle after plugin unload/reload.');

    await setVim(false);
    await selectRow('New task from Vim');
    await page.evaluate(() => {
        const editor = window.app.workspace.activeEditor.editor;
        const cursor = editor.getCursor();
        editor.setCursor({ line: cursor.line, ch: editor.getLine(cursor.line).indexOf(' <!-- gdn:') });
    });
    await page.keyboard.type(' without Vim');
    assert.equal(await page.evaluate(() => window.gdnTest.operations.some(operation => operation.title === 'New task from Vim without Vim')), false);
    await page.waitForFunction(() => window.gdnTest.operations.some(operation => operation.title === 'New task from Vim without Vim'), { timeout: 15000 });
    console.log('PASS: non-Vim title edits sync after idle.');

    const originalItems = await page.evaluate(() => structuredClone(window.gdnTest.items));
    await page.evaluate(() => { window.gdnTest.items = []; });
    await page.evaluate(async () => {
        const file = await window.app.vault.create('2026-09-20.md', '# Another day\n\n');
        await window.app.workspace.getLeaf(false).openFile(file);
        window.app.workspace.activeEditor.editor.setCursor({ line: 2, ch: 0 });
        window.app.commands.executeCommandById('google-daily-notes:insert-daily-sections');
    });
    await page.waitForFunction(() => window.app.workspace.activeEditor.editor.getValue().includes('google-daily: true') && window.app.workspace.activeEditor.editor.getValue().includes('gdn:tasks'));
    assert.match(await editorText(), /# Another day/);
    assert.doesNotMatch(await editorText(), /^\s+- \[ \][ \t]*$/m, 'Template does not insert a blank task');
    console.log('PASS: template command preserves the note and enables its sections.');
    await setVim(true);
    await selectRow('google tasks');
    await page.keyboard.press('o');
    await page.keyboard.type('First task in empty group');
    assert.match(await editorText(), /gdn:tasks -->\n\t- \[ \] First task in empty group/);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => window.app.workspace.activeEditor.editor.getValue().includes('First task in empty group <!-- gdn:'));
    console.log('PASS: Vim o on an empty tasks heading creates the first dated task.');
    for (const width of [2, 8]) {
        await page.evaluate(width => {
            window.app.vault.setConfig('useTab', false);
            window.app.vault.setConfig('tabSize', width);
            window.app.workspace.updateOptions();
            window.app.plugins.plugins['google-daily-notes'].controller.reconnect();
        }, width);
        await page.waitForFunction(width => window.app.workspace.activeEditor.editor.getValue().includes('\n' + ' '.repeat(width) + '- [ ] First task'), width);
    }
    await selectRow('First task in empty group');
    await page.keyboard.press('o');
    await page.keyboard.type('Task with eight spaces');
    assert.match(await editorText(), /\n {8}- \[ \] Task with eight spaces/);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => window.app.workspace.activeEditor.editor.getValue().includes('Task with eight spaces <!-- gdn:'));
    console.log('PASS: changing indentation updates existing rows and newly created tasks without reloading.');
    await setVim(false);
    await selectRow('google tasks');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Task from heading without Vim');
    assert.match(await editorText(), /gdn:tasks -->\n {8}- \[ \] Task from heading without Vim/);
    await page.waitForFunction(() => window.app.workspace.activeEditor.editor.getValue().includes('Task from heading without Vim <!-- gdn:'), undefined, { timeout: 15000 });
    console.log('PASS: Enter on the tasks heading also creates a task without Vim.');
    await page.evaluate(items => {
        window.gdnTest.items = items;
        window.app.vault.setConfig('useTab', true);
        window.app.vault.setConfig('tabSize', 4);
        window.app.workspace.updateOptions();
    }, originalItems);
    await page.evaluate(async () => {
        const file = await window.app.vault.create('2026-09-21.md', '');
        await window.app.workspace.getLeaf(false).openFile(file);
        window.app.workspace.activeEditor.editor.setValue('---\ngoogle-daily: true\n---\n- [ ] events <!-- gdn:events -->\n- [ ] recurring <!-- gdn:recurring -->\n- [ ] tasks <!-- gdn:tasks -->\n');
    });
    await page.waitForFunction(() => window.app.workspace.activeEditor.editor.getValue().includes('Planning meeting'), undefined, { timeout: 3000 });
    console.log('PASS: newly applied daily-note templates populate without the typing delay.');
    await page.evaluate(async () => { await window.app.workspace.getLeaf(false).openFile(window.app.vault.getAbstractFileByPath('2026-09-19.md')); });
    await page.evaluate(() => window.app.commands.executeCommandById('markdown:toggle-preview'));
    const checkbox = page.locator('.markdown-preview-view li[data-task="x"]').filter({ hasText: 'Weekly review updated' }).last().locator('input[type="checkbox"]').first();
    await checkbox.click();
    await page.waitForFunction(() => window.gdnTest.operations.some(operation => operation.kind === 'event' && operation.done === false));
    console.log('PASS: reading-view checkbox clicks sync immediately.');
    await page.evaluate(() => window.app.commands.executeCommandById('markdown:toggle-preview'));

    await setVim(true);
    const beforeBackgroundChange = await editorText();
    await page.evaluate(() => {
        const cm = window.app.workspace.activeEditor.editor.cm;
        const from = cm.state.doc.toString().lastIndexOf('\n', cm.state.doc.toString().indexOf('Planning meeting')) + 1;
        const line = cm.state.doc.lineAt(from);
        cm.dispatch({ changes: { from, to: line.to + 1 } });
    });
    assert.equal(await editorText(), beforeBackgroundChange, 'A background transaction cannot authorize a remote deletion');
    const deletionTitles = ['Planning meeting', 'Weekly review updated', 'Buy coffee', 'New task from Vim without Vim'];
    const removalCount = () => page.evaluate(() => window.gdnTest.operations.filter(operation => operation.remove).length);
    for (const title of deletionTitles) {
        await selectRow(title);
        await page.keyboard.press('d');
        await page.keyboard.press('d');
        assert.ok(!(await editorText()).includes(title), `Row disappears immediately: ${title}`);
        await page.waitForFunction(() => Object.values(window.app.plugins.plugins['google-daily-notes'].data.outbox).some(operation => operation.remove));
        await page.keyboard.press('u');
        assert.ok((await editorText()).includes(title), `Native Vim undo restores: ${title}`);
        await page.waitForFunction(() => !Object.values(window.app.plugins.plugins['google-daily-notes'].data.outbox).some(operation => operation.remove));
    }
    await new Promise(resolve => setTimeout(resolve, 5100));
    assert.equal(await removalCount(), 0, 'Cancelled deletions never reach Google');
    console.log('PASS: native Vim u cancels task and event deletions within the grace period.');

    // Redo uses native history too and starts a fresh grace period.
    await page.keyboard.press('Control+r');
    assert.ok(!(await editorText()).includes(deletionTitles.at(-1)));
    assert.equal(await removalCount(), 0);
    await page.keyboard.press('u');
    assert.ok((await editorText()).includes(deletionTitles.at(-1)));

    const deletionStarted = Date.now();
    for (const title of deletionTitles) {
        await selectRow(title);
        await page.keyboard.press('d');
        await page.keyboard.press('d');
        assert.ok(!(await editorText()).includes(title), `Row disappears immediately: ${title}`);
        assert.equal(await page.locator('.modal').count(), 0, 'No confirmation popup');
    }
    assert.equal(await removalCount(), 0, 'Deletes stay local during the grace period');
    await page.evaluate(async () => {
        await window.app.plugins.plugins['google-daily-notes'].persist();
        await window.app.plugins.disablePlugin('google-daily-notes');
        await window.app.plugins.enablePlugin('google-daily-notes');
    });
    assert.equal(await removalCount(), 0, 'Plugin reload preserves the grace period');
    assert.doesNotMatch(await editorText(), /Planning meeting|Weekly review updated|Buy coffee|New task from Vim/);
    await page.waitForFunction(() => window.gdnTest.operations.filter(operation => operation.remove).length === 4
        && !Object.values(window.app.plugins.plugins['google-daily-notes'].data.outbox).some(operation => operation.remove), undefined, { timeout: 8000 });
    assert.ok(Date.now() - deletionStarted >= 5000, 'No remote deletion before five seconds');
    assert.match(await editorText(), /Monthly report/, 'Other calendar occurrences remain');
    const createsBeforeLateUndo = await page.evaluate(() => window.gdnTest.operations.filter(operation => operation.create).length);
    await page.keyboard.press('u');
    await page.waitForFunction(count => window.gdnTest.operations.filter(operation => operation.create).length === count + 1
        && !Object.keys(window.app.plugins.plugins['google-daily-notes'].data.outbox).length, createsBeforeLateUndo, { timeout: 5000 });
    const replacement = await page.evaluate(() => structuredClone(window.gdnTest.items.find(item => item.title === 'New task from Vim without Vim')));
    assert.ok(replacement);
    const restoredRowKey = await page.evaluate(id => Object.values(window.app.plugins.plugins['google-daily-notes'].data.notes['2026-09-19.md'].rows).find(row => row.id === id).key, replacement.id);
    assert.ok((await editorText()).includes(restoredRowKey), 'Late undo binds the replacement Google ID to the stable Markdown row');
    assert.doesNotMatch(await editorText(), /Planning meeting|Weekly review updated|Buy coffee/, 'Undo never recreates calendar events');
    await selectRow(replacement.title);
    await page.keyboard.press('Meta+Enter');
    await page.waitForFunction(id => window.gdnTest.operations.some(operation => operation.id === id && operation.done === true), replacement.id);
    // Delete the recreated task, then undo again after the deadline. Both rounds
    // must use their current Google IDs, including through native history mapping.
    await page.keyboard.press('d');
    await page.keyboard.press('d');
    await page.waitForFunction(id => window.gdnTest.operations.some(operation => operation.remove && operation.id === id), replacement.id, { timeout: 8000 });
    await page.keyboard.press('u');
    await page.waitForFunction(count => window.gdnTest.operations.filter(operation => operation.create).length === count + 2
        && !Object.keys(window.app.plugins.plugins['google-daily-notes'].data.outbox).length, createsBeforeLateUndo, { timeout: 5000 });
    const secondReplacement = await page.evaluate(() => structuredClone(window.gdnTest.items.find(item => item.title === 'New task from Vim without Vim')));
    assert.notEqual(secondReplacement.id, replacement.id);
    assert.ok((await editorText()).includes(restoredRowKey));
    await page.keyboard.press('Control+r');
    assert.ok(!(await editorText()).includes(restoredRowKey), 'Native redo deletes the current replacement');
    await page.keyboard.press('u');
    assert.ok((await editorText()).includes(restoredRowKey), 'Undo during redo grace retains the same replacement');
    console.log('PASS: late Vim undo recreates and relinks Google Tasks; subsequent toggles, deletion and redo use the new ID.');

    await setVim(false);
    const selectTimedRow = () => page.evaluate(() => {
        const editor = window.app.workspace.activeEditor.editor;
        const line = editor.getValue().split('\n').findIndex(line => line.includes('Call Sam'));
        editor.setSelection({ line, ch: 0 }, { line: line + 1, ch: 0 });
        editor.focus();
    });
    await selectTimedRow();
    await page.keyboard.press('Backspace');
    assert.doesNotMatch(await editorText(), /Call Sam/);
    await page.keyboard.press('Meta+z');
    assert.match(await editorText(), /Call Sam/, 'Cmd+Z restores a deleted task outside Vim');
    await new Promise(resolve => setTimeout(resolve, 5100));
    assert.equal(await removalCount(), 5, 'Cmd+Z cancels remote deletion');
    await selectTimedRow();
    await page.keyboard.press('Backspace');
    await page.waitForFunction(() => window.gdnTest.operations.some(operation => operation.remove && operation.id === 'timed'), undefined, { timeout: 8000 });
    await page.keyboard.press('Meta+z');
    await page.waitForFunction(() => window.gdnTest.items.some(item => item.title.includes('Call Sam') && item.id !== 'timed')
        && !Object.keys(window.app.plugins.plugins['google-daily-notes'].data.outbox).length, undefined, { timeout: 5000 });
    const restoredTimedKey = await page.evaluate(() => Object.values(window.app.plugins.plugins['google-daily-notes'].data.notes['2026-09-19.md'].rows).find(item => item.title.includes('Call Sam')).key);
    assert.ok((await editorText()).includes(restoredTimedKey), 'Late Cmd+Z restores and relinks the task without Vim');
    console.log('PASS: Cmd+Z cancels deletion within five seconds and recreates the task after five seconds.');

    await page.evaluate(() => { window.app.setting.open(); window.app.setting.openTabById('google-daily-notes'); });
    let settingsPage;
    for (let attempt = 0; attempt < 20; attempt++) {
        settingsPage = application.windows().find(other => other !== page);
        if (settingsPage) break;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    settingsPage ??= page;
    await settingsPage.getByText('Desktop OAuth client ID', { exact: true }).waitFor();
    await settingsPage.screenshot({ path: 'output/playwright/settings.png' });
    if (settingsPage !== page) await settingsPage.close();
    else await page.evaluate(() => window.app.setting.close());
    await page.setViewportSize({ width: 1000, height: 900 });
    await page.screenshot({ path: 'output/playwright/daily-note-narrow.png' });
    assert.deepEqual(errors, [], 'No renderer exceptions');
    await writeFile('output/playwright/result.json', JSON.stringify({ passed: true, vault, screenshots: ['daily-note.png', 'daily-note-narrow.png', 'settings.png'], errors }, null, 2));
    console.log('Obsidian integration checks passed.');
} catch (error) {
    if (application) {
        for (const page of application.windows()) {
            console.log('Failure UI:', (await page.locator('body').innerText().catch(() => '')).slice(0, 1800));
            await page.screenshot({ path: 'output/playwright/failure.png' }).catch(() => undefined);
            console.log('Failure state:', await page.evaluate(() => ({ editor: window.app?.workspace?.activeEditor?.editor?.getValue(), operations: window.gdnTest?.operations })).catch(() => ({})));
        }
    }
    throw error;
} finally {
    if (application) await application.close();
    if (processHandle) processHandle.kill('SIGTERM');
}
