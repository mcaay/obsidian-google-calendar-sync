import assert from 'node:assert/strict';

export async function runMobileChecks(page) {
    await page.setViewportSize({ width: 393, height: 852 });
    await page.waitForFunction(() => document.body.classList.contains('is-mobile'));
    await page.waitForFunction(() => document.querySelector('.metadata-property[data-property-key="google-daily"]'));
    assert.equal(await page.locator('.workspace-leaf.mod-active .metadata-container').isVisible(), false, 'Internal properties hidden by default');
    assert.doesNotMatch(await page.locator('.workspace-leaf.mod-active .cm-content').innerText(), /gdn:/, 'Live Preview hides all row and section IDs');
    await page.screenshot({ path: 'output/playwright/mobile-daily-note.png' });
    for (const title of ['Buy coffee', 'Weekly review']) {
        await page.locator('.workspace-leaf.mod-active .cm-line').filter({ hasText: title }).locator('input[type="checkbox"]').click();
        await page.waitForFunction(title => window.gdnTest.items.find(item => item.title === title)?.done === true, title);
    }
    console.log('PASS: mobile layout hides properties and comments; tapping both checkbox types syncs.');
    await page.evaluate(() => {
        const editor = window.app.workspace.activeEditor.editor;
        const line = editor.getValue().split('\n').findIndex(line => line.includes('Buy coffee'));
        editor.setCursor({ line, ch: editor.getLine(line).indexOf(' <!-- gdn:') }); editor.focus();
    });
    await page.keyboard.type(' on mobile');
    await page.waitForFunction(() => window.gdnTest.items.some(item => item.title === 'Buy coffee on mobile'), undefined, { timeout: 15000 });
    await page.keyboard.press('Enter');
    await page.keyboard.type('New task from phone');
    await page.waitForFunction(() => window.gdnTest.operations.some(operation => operation.create && operation.title === 'New task from phone'), undefined, { timeout: 15000 });
    console.log('PASS: mobile title editing and Enter task creation sync after idle.');

    await page.evaluate(async () => {
        const file = window.app.workspace.activeEditor.file;
        await window.app.fileManager.processFrontMatter(file, properties => { properties.category = 'Personal'; });
        window.app.workspace.activeEditor.editor.scrollTo(0, 0);
    });
    await page.locator('.workspace-leaf.mod-active .markdown-source-view .metadata-property[data-property-key="category"]').waitFor();
    assert.equal(await page.locator('.workspace-leaf.mod-active .markdown-source-view .metadata-container').isVisible(), true, 'Other properties remain visible');
    assert.equal(await page.locator('.workspace-leaf.mod-active .markdown-source-view .metadata-property[data-property-key="google-daily"]').isVisible(), false);
    await page.evaluate(() => window.app.commands.executeCommandById('markdown:toggle-preview'));
    await page.locator('.workspace-leaf.mod-active .markdown-preview-view').waitFor();
    assert.doesNotMatch(await page.locator('.workspace-leaf.mod-active .markdown-preview-view').innerText(), /gdn:|google-daily/);
    await page.evaluate(() => window.app.commands.executeCommandById('markdown:toggle-preview'));
    await page.locator('.workspace-leaf.mod-active .markdown-source-view').waitFor();
    await page.evaluate(() => window.app.commands.executeCommandById('editor:toggle-source'));
    await page.waitForFunction(() => document.querySelector('.workspace-leaf.mod-active .cm-content')?.textContent.includes('gdn:'));
    await page.evaluate(() => window.app.commands.executeCommandById('editor:toggle-source'));
    await page.waitForFunction(() => !document.querySelector('.workspace-leaf.mod-active .cm-content')?.textContent.includes('gdn:'));
    console.log('PASS: user properties remain visible; metadata is exposed only in Source mode.');

    const loadsBefore = await page.evaluate(() => window.gdnTest.loads);
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.waitForFunction(before => window.gdnTest.loads > before, loadsBefore);
    console.log('PASS: returning to the foreground resumes sync.');

    await page.evaluate(async () => {
        const plugin = window.app.plugins.plugins['google-daily-notes'];
        // Simulate a settings update delivered by Obsidian Sync. This must not
        // import a queued creation/deletion that belongs to the desktop.
        const shared = structuredClone(plugin.data);
        shared.runtimeOwner = 'another-device';
        shared.outbox.elsewhere = { key: 'elsewhere', kind: 'task', id: 'untouched', source: 'list', path: '2026-09-19.md', remove: true };
        const loadData = plugin.loadData.bind(plugin);
        plugin.loadData = async () => shared;
        await plugin.onExternalSettingsChange();
        plugin.loadData = loadData;
        if (plugin.data.outbox.elsewhere) throw new Error('Imported another device’s deletion');
        await plugin.persist();
        await window.app.plugins.disablePlugin('google-daily-notes');
        await window.app.plugins.enablePlugin('google-daily-notes');
        if (window.app.plugins.plugins['google-daily-notes'].data.outbox.elsewhere) throw new Error('Replayed another device’s deletion after reload');
        window.app.setting.open(); window.app.setting.openTabById('google-daily-notes');
    });
    await page.getByText('Connect through Obsidian Sync', { exact: true }).waitFor();
    assert.equal(await page.getByText('Desktop OAuth client ID', { exact: true }).count(), 0);
    await page.getByRole('button', { name: 'Create setup code', exact: true }).click();
    const setupCode = await page.getByRole('textbox', { name: 'Setup code', exact: true }).inputValue();
    assert.match(setupCode, /^[A-Z2-7]{4}(-[A-Z2-7]{4}){4}$/);
    const shared = await page.evaluate(() => JSON.stringify(window.app.plugins.plugins['google-daily-notes'].data.connectionTransfer));
    assert.ok(!shared.includes(setupCode) && !shared.includes('fixture-refresh'));
    await page.getByRole('textbox', { name: 'Code from your connected device', exact: true }).fill(setupCode);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.waitForFunction(() => !window.app.plugins.plugins['google-daily-notes'].data.connectionTransfer
        && window.app.plugins.plugins['google-daily-notes'].auth.connected());
    console.log('PASS: encrypted setup code imports through the mobile UI and removes the synced package.');
    await page.screenshot({ path: 'output/playwright/mobile-settings.png' });
    await page.evaluate(() => window.app.setting.close());
    console.log('PASS: mobile reload and settings import preserve this device’s outbox; mobile connection UI fits.');
}
