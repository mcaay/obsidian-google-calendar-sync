import assert from 'node:assert/strict';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// Declarative settings tab (Obsidian 1.13). `settingsPage` shows the tab; the
// plugin's state is read from the main window, where `app` lives. Every
// change is reverted, so later checks see the fixture settings.
export async function runSettingsChecks(settingsPage, page) {
    const consoleErrors = [];
    const onConsole = message => { if (message.type() === 'error') consoleErrors.push(message.text()); };
    page.on('console', onConsole);
    const current = () => page.evaluate(() => structuredClone(window.app.plugins.plugins['google-daily-notes'].data.settings));
    const stored = () => page.evaluate(async () => (await window.app.plugins.plugins['google-daily-notes'].loadData()).settings);
    const until = async (check, message) => {
        for (let attempt = 0; attempt < 50; attempt++) {
            if (await check()) return;
            await pause(100);
        }
        assert.fail(message);
    };
    const row = name => settingsPage.locator('.setting-item').filter({ has: settingsPage.locator('.setting-item-name').getByText(name, { exact: true }) });
    const invalid = name => row(name).evaluate(element => element.classList.contains('is-invalid'));

    for (const heading of ['Google account', 'Connect another device', 'Calendars and task lists', 'Daily note behavior']) {
        await settingsPage.getByText(heading, { exact: true }).waitFor();
    }
    await row('Connection').getByText('Connected', { exact: true }).waitFor();

    const overdue = (await current()).overdueTasks;
    await row('Overdue Google Tasks').locator('.checkbox-container').click();
    await until(async () => (await stored()).overdueTasks === !overdue, 'A toggle saves to data.json');
    await row('Overdue Google Tasks').locator('.checkbox-container').click();
    await until(async () => (await stored()).overdueTasks === overdue, 'A toggle saves its reverted value');

    const interval = row('Automatic sync interval').locator('input');
    await interval.fill('10');
    await interval.press('Enter');
    await until(() => invalid('Automatic sync interval'), 'An interval below the minimum shows an inline error');
    assert.equal((await current()).intervalSeconds, 120, 'An invalid interval is not saved');
    await interval.fill('300');
    await interval.press('Enter');
    await until(async () => (await stored()).intervalSeconds === 300 && !await invalid('Automatic sync interval'), 'A valid interval saves');
    await interval.fill('120');
    await interval.press('Enter');
    await until(async () => (await stored()).intervalSeconds === 120, 'The interval is restored');

    const zone = (await current()).timeZone;
    await row('Time zone').locator('input').fill('Mars/Olympus');
    await row('Time zone').getByText('Unknown time zone.', { exact: true }).waitFor();
    assert.equal((await current()).timeZone, zone, 'An unknown time zone is not saved');
    await row('Time zone').locator('input').fill(zone);
    await until(async () => !await invalid('Time zone'), 'A valid time zone clears the error');

    await row('Example calendar').getByRole('combobox').selectOption('events');
    await until(async () => (await stored()).calendars[0].role === 'events', 'A calendar role saves by ID');
    await row('Example calendar').getByRole('combobox').selectOption('recurring');
    await until(async () => (await stored()).calendars[0].role === 'recurring', 'The calendar role is restored');

    // Obsidian adds a hidden copy of each dropdown to measure its width.
    const choices = () => row('New tasks go to').getByRole('combobox').locator('option').allTextContents();
    await row('Example tasks').locator('.checkbox-container').click();
    await until(async () => {
        const settings = await current();
        return !settings.taskLists[0].enabled && settings.defaultTaskList === '' && (await choices()).join() === 'Choose a list';
    }, 'Disabling the default list clears it and rebuilds the list choices');
    await row('Example tasks').locator('.checkbox-container').click();
    await until(async () => {
        const settings = await current();
        return settings.taskLists[0].enabled && settings.defaultTaskList === 'list' && (await choices()).join() === 'Choose a list,Example tasks';
    }, 'Enabling a list makes it the default again');

    const link = settingsPage.getByRole('textbox', { name: 'Google sign-in link', exact: true });
    assert.equal(await link.isVisible(), false, 'The sign-in link row starts hidden');
    await row('Connection').getByRole('button', { name: 'Use another browser', exact: true }).click();
    await until(async () => await link.isVisible() && (await link.inputValue()).startsWith('https://accounts.google.com/'), 'Use another browser reveals the sign-in link');
    await page.evaluate(() => window.app.plugins.plugins['google-daily-notes'].auth.dispose());
    await row('Connection').getByText('Google sign-in cancelled.', { exact: true }).waitFor();
    await until(async () => !await link.isVisible(), 'A cancelled sign-in hides the link again');

    const setupCode = settingsPage.getByRole('textbox', { name: 'Setup code', exact: true });
    assert.equal(await setupCode.isVisible(), false, 'The setup code row starts hidden');
    await row('Share this Google connection').getByRole('button', { name: 'Create setup code', exact: true }).click();
    await until(async () => await setupCode.isVisible() && /^[A-Z2-7]{4}(-[A-Z2-7]{4}){4}$/.test(await setupCode.inputValue()), 'Create setup code reveals the code');
    await row('Share this Google connection').getByRole('button', { name: 'Cancel setup', exact: true }).click();
    await until(async () => !await setupCode.isVisible()
        && !await page.evaluate(() => window.app.plugins.plugins['google-daily-notes'].data.connectionTransfer), 'Cancel setup hides the code and removes the package');

    const search = settingsPage.locator('.setting-search-container input');
    await search.fill('Overdue Google Tasks');
    await settingsPage.locator('.setting-search-results').getByText('Overdue Google Tasks', { exact: true }).waitFor();
    await search.fill('Example calendar');
    await settingsPage.locator('.setting-search-results').getByText('Example calendar', { exact: true }).waitFor();
    await search.fill('');

    page.off('console', onConsole);
    assert.deepEqual(consoleErrors.filter(text => /setting/i.test(text)), [], 'No settings errors in the console');
    console.log('PASS: declarative settings save, validate, rebuild, reveal sign-in and setup rows, and appear in settings search.');
}
