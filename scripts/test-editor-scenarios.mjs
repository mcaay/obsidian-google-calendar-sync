import assert from 'node:assert/strict';

// GUI checks added with the 0.9.0 fix plan. Each scenario uses its own note
// and fixture items, so earlier history in 2026-09-19 cannot interfere. IDs
// differ from the earlier checks', because waits match recorded operations.
const key = (kind, source, id) => Buffer.from(JSON.stringify([kind, source, id])).toString('base64url');
const task = (id, title, date, values = {}) => ({ key: key('task', 'list', id), kind: 'task', source: 'list', id, section: 'tasks', title, done: false, prefix: '', date, writable: true, sort: date, ...values });
const event = (id, title, date, values = {}) => ({ key: key('event', 'calendar', id), kind: 'event', source: 'calendar', id, section: 'recurring', title, done: false, prefix: '30 min ', date, writable: true, sort: `${date} 10:00`, ...values });
const note = date => `---\ngoogle-daily: true\n---\n# ${date}\n\nMy own notes stay here.\n\n- [ ] google events <!-- gdn:events -->\n- [ ] recurring <!-- gdn:recurring -->\n- [ ] google tasks <!-- gdn:tasks -->\n\nEnd of note.\n`;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
// A fragment glued to a row after an undo would follow its hidden ID.
const glued = text => text.split('\n').some(line => /<!-- gdn:[^ ]+ -->\S/.test(line));

export async function runEditorChecks(page, { editorText, selectRow, setVim }) {
    const count = () => page.evaluate(() => window.gdnTest.operations.length);
    const setItems = items => page.evaluate(items => { window.gdnTest.items = items; }, items);
    const open = async (date, items, shown = items[0]?.title) => {
        await setItems(items);
        await page.evaluate(async ({ name, content }) => {
            const file = window.app.vault.getAbstractFileByPath(name) ?? await window.app.vault.create(name, content);
            await window.app.workspace.getLeaf(false).openFile(file);
        }, { name: `${date}.md`, content: note(date) });
        if (shown) await page.waitForFunction(title => window.app.workspace.activeEditor?.editor?.getValue().includes(title), shown, { timeout: 8000 });
    };
    const sync = date => page.evaluate(name => window.app.plugins.plugins['google-daily-notes'].controller.engine.run(name, true), `${date}.md`);
    const disk = date => page.evaluate(name => window.app.vault.adapter.read(name), `${date}.md`);
    const writeOutside = (date, text) => page.evaluate(({ name, text }) => window.app.vault.adapter.write(name, text), { name: `${date}.md`, text });
    const waitText = (text, present = true) => page.waitForFunction(({ text, present }) => window.app.workspace.activeEditor.editor.getValue().includes(text) === present, { text, present }, { timeout: 8000 });
    const waitOperation = (fields, timeout = 9000) => page.waitForFunction(fields => window.gdnTest.operations.some(operation => Object.entries(fields).every(([name, value]) => operation[name] === value)), fields, { timeout });
    // Obsidian shows a notice in whichever window was last active.
    const noticeWith = text => page.waitForFunction(text => [...new Set([document, activeWindow.document])].some(doc => [...doc.querySelectorAll('.notice')].some(notice => notice.textContent.includes(text))), text, { timeout: 5000 });
    const outbox = () => page.evaluate(() => structuredClone(window.app.plugins.plugins['google-daily-notes'].data.outbox));
    const originalItems = await page.evaluate(() => structuredClone(window.gdnTest.items));
    await setVim(true);

    // 1.1 / D1: another device writes a row and a paragraph into the open note.
    {
        const date = '2026-10-01';
        const phone = task('phone', 'Rendered on the phone', date);
        await open(date, [task('kept', 'Existing task', date)]);
        const before = await count();
        await setItems([task('kept', 'Existing task', date), phone]);
        const text = await editorText();
        await writeOutside(date, text.replace('<!-- gdn:tasks -->\n', `<!-- gdn:tasks -->\n\t- [ ] Rendered on the phone <!-- gdn:${phone.key} -->\n`).replace('End of note.', 'Written on the phone.\nEnd of note.'));
        await waitText('Written on the phone.');
        await sync(date);
        const after = await editorText();
        assert.match(after, /Rendered on the phone/);
        assert.match(after, /Written on the phone\./);
        assert.equal(await disk(date), after, 'Disk and editor agree');
        assert.equal(await count(), before, 'Changes from outside push nothing');
        console.log('PASS: an outside write with a new row and a paragraph survives and pushes nothing.');

        // The same note in two panes converges after a render.
        await page.evaluate(async name => { await window.app.workspace.getLeaf('split').openFile(window.app.vault.getAbstractFileByPath(name)); }, `${date}.md`);
        await setItems([task('kept', 'Existing task', date), phone, task('added', 'Added in Google', date)]);
        await sync(date);
        await page.waitForFunction(name => {
            const views = window.app.workspace.getLeavesOfType('markdown').map(leaf => leaf.view).filter(view => view.file?.path === name);
            return views.length === 2 && views.every(view => view.editor.getValue().includes('Added in Google'));
        }, `${date}.md`, { timeout: 8000 });
        assert.match(await disk(date), /Added in Google/);
        console.log('PASS: the same note in two panes converges.');

        // FP-4: a Reading-view click counts, with a Live Preview pane open too.
        await page.evaluate(() => window.app.workspace.activeLeaf.view.setState({ ...window.app.workspace.activeLeaf.view.getState(), mode: 'preview' }, { history: false }));
        // The innermost list item: the group heading's item contains this text too.
        const checkbox = page.locator('.workspace-leaf.mod-active .markdown-preview-view li').filter({ hasText: 'Existing task' }).last().locator('input[type="checkbox"]').first();
        await checkbox.waitFor();
        await checkbox.click();
        await waitOperation({ id: 'kept', done: true });
        console.log('PASS: a Reading-view click with a Live Preview pane open is pushed.');
        await page.evaluate(() => window.app.workspace.activeLeaf.detach());
        // The same flip arriving without a click is display state.
        const flipped = await count();
        await writeOutside(date, (await editorText()).replace('- [x] Existing task', '- [ ] Existing task'));
        await waitText('- [ ] Existing task');
        await pause(1500);
        await sync(date);
        assert.equal(await count(), flipped, 'A checkbox flip from outside is not pushed');
        assert.match(await editorText(), /- \[x\] Existing task/, 'Google’s value is shown again');
        console.log('PASS: the same flip without a click is not pushed.');

        // FP-7: another plugin’s editor command counts as a local edit.
        await page.evaluate(() => {
            const editor = window.app.workspace.activeEditor.editor;
            const line = editor.getValue().split('\n').findIndex(value => value.includes('Added in Google'));
            const ch = editor.getLine(line).indexOf('[ ]') + 1;
            editor.replaceRange('x', { line, ch }, { line, ch: ch + 1 });
        });
        await waitOperation({ id: 'added', done: true });
        console.log('PASS: another plugin’s editor edit is pushed.');
    }

    // 3.1: undo after creating a task, an earlier edit, then redo after a sync.
    {
        const date = '2026-10-02';
        await open(date, [task('base', 'Base task', date)]);
        await selectRow('My own notes stay here.');
        await page.keyboard.press('A');
        await page.keyboard.type(' (edited)');
        await page.keyboard.press('Escape');
        await selectRow('Base task');
        await page.keyboard.press('o');
        await page.keyboard.type('Created then undone');
        await page.keyboard.press('Escape');
        await waitOperation({ title: 'Created then undone' });
        await page.waitForFunction(() => /Created then undone <!-- gdn:(?!new:)/.test(window.app.workspace.activeEditor.editor.getValue()), undefined, { timeout: 8000 });
        const created = await page.evaluate(() => window.gdnTest.items.find(item => item.title === 'Created then undone').id);
        await page.keyboard.press('u');
        await waitText('Created then undone', false);
        assert.equal(glued(await editorText()), false, 'Undo leaves no fragment');
        await waitOperation({ id: created, remove: true });
        await page.keyboard.press('u');
        await waitText(' (edited)', false);
        await sync(date);
        await page.keyboard.press('Control+r');
        await waitText(' (edited)');
        assert.equal(glued(await editorText()), false);
        console.log('PASS: undo removes a created task after 5 seconds; older edits and redo after a sync still work.');
    }

    // 3.2 / D12: a late Calendar undo, then further undo and redo.
    {
        const date = '2026-10-03';
        await open(date, [event('standup', 'Standup', date), task('other', 'Other task', date)]);
        await selectRow('My own notes stay here.');
        await page.keyboard.press('A');
        await page.keyboard.type(' before');
        await page.keyboard.press('Escape');
        await selectRow('Standup');
        await page.keyboard.press('d');
        await page.keyboard.press('d');
        await waitOperation({ id: 'standup', remove: true });
        await page.keyboard.press('u');
        await waitText('Standup');
        await noticeWith('cannot be restored');
        await page.keyboard.press('u');
        await waitText(' before', false);
        await page.keyboard.press('Control+r');
        await waitText(' before');
        await page.keyboard.press('Control+r');
        await waitText('Standup', false);
        await sync(date);
        assert.doesNotMatch(await editorText(), /Standup/);
        console.log('PASS: a late Calendar undo shows a notice, and undo and redo keep working past it.');
    }

    // 3.2: undoing a template insertion deletes nothing in Google.
    {
        const date = '2026-10-04';
        await setItems([task('template', 'Template task', date)]);
        await page.evaluate(async name => {
            const file = await window.app.vault.create(name, '# Plain note\n\n');
            await window.app.workspace.getLeaf(false).openFile(file);
            window.app.workspace.activeEditor.editor.setCursor({ line: 2, ch: 0 });
            window.app.commands.executeCommandById('google-daily-notes:insert-daily-sections');
        }, `${date}.md`);
        await waitText('Template task');
        const before = await count();
        await selectRow('# Plain note');
        await page.keyboard.press('u');
        await waitText('gdn:', false);
        await pause(5500);
        assert.equal(await count(), before, 'Undoing a template deletes nothing');
        console.log('PASS: undoing a template insertion deletes nothing in Google.');
    }

    // 3.3: a duplicated row, and a note with duplicate markers.
    {
        const date = '2026-10-05';
        await open(date, [task('twice', 'Duplicated task', date)]);
        const text = await editorText();
        const row = text.split('\n').find(line => line.includes('Duplicated task'));
        await writeOutside(date, text.replace(row, `${row}\n${row}`).replace('End of note.', 'End of note.\n- [ ] extra <!-- gdn:tasks -->'));
        await page.waitForFunction(row => window.app.workspace.activeEditor.editor.getValue().split(row).length === 3, row, { timeout: 8000 });
        const before = await count();
        await selectRow('My own notes stay here.');
        await page.keyboard.press('A');
        await page.keyboard.type(' typed');
        await page.keyboard.press('Escape');
        await waitText('here. typed');
        await selectRow('Duplicated task');
        await page.keyboard.press('d');
        await page.keyboard.press('d');
        assert.equal((await editorText()).split(row).length, 2, 'One copy remains');
        await page.keyboard.press('u');
        assert.equal((await editorText()).split(row).length, 3);
        await pause(5500);
        assert.equal(await count(), before, 'Removing a copy deletes nothing');
        console.log('PASS: a duplicated row and duplicate markers stay editable; removing a copy deletes nothing.');
    }

    // 3.4: ddp, yyp, a paste into another day, and ddp on an event.
    {
        const date = '2026-10-06';
        await open(date, [task('move', 'Move me', date), task('stay', 'Stay here', date), event('call', 'Client call', date)]);
        await selectRow('Move me');
        await page.keyboard.press('d');
        await page.keyboard.press('d');
        await selectRow('Stay here');
        await page.keyboard.press('p');
        // In normal mode the paste syncs at once and gets the new task's key.
        await waitOperation({ title: 'Move me' });
        assert.doesNotMatch(await editorText(), /gdn:WyJ0YXNrIiwibGlzdCIsIm1vdmUiXQ/, 'The pasted row does not reuse the deleted task’s key');
        await waitOperation({ id: 'move', remove: true });
        await selectRow('Stay here');
        await page.keyboard.press('y');
        await page.keyboard.press('y');
        await page.keyboard.press('p');
        await waitOperation({ title: 'Stay here' });
        const other = '2026-10-07';
        await open(other, [task('elsewhere', 'Elsewhere', other)]);
        await selectRow('Elsewhere');
        await page.keyboard.press('p');
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => window.gdnTest.operations.filter(operation => operation.title === 'Stay here' && operation.create).length === 2, undefined, { timeout: 9000 });
        const pasted = await page.evaluate(() => window.gdnTest.operations.filter(operation => operation.title === 'Stay here' && operation.create).at(-1).create.date);
        assert.equal(pasted, other, 'A paste into another note uses that note’s date');
        await open(date, [task('stay', 'Stay here', date), event('call', 'Client call', date)]);
        await selectRow('Client call');
        await page.keyboard.press('d');
        await page.keyboard.press('d');
        await page.keyboard.press('p');
        await noticeWith('Calendar events cannot be created');
        await page.keyboard.press('u');
        await waitText('Client call');
        await pause(5500);
        assert.equal(Object.keys(await outbox()).length, 0);
        assert.equal(await page.evaluate(() => window.gdnTest.operations.some(operation => operation.id === 'call' && operation.remove)), false, 'Undo within 5 seconds keeps the event');
        console.log('PASS: ddp and yyp create new tasks, a paste uses its note’s date, and a pasted event is refused.');
    }

    // 3.5 and D9: a code fence above the groups; C, D, cc and S on a row.
    {
        const date = '2026-10-08';
        await open(date, [task('change', 'Change me please', date)]);
        // Obsidian pairs a typed fence, so open one fence as another plugin would.
        const fence = marker => page.evaluate(marker => {
            const editor = window.app.workspace.activeEditor.editor;
            const line = editor.getValue().split('\n').findIndex(value => value.includes(marker));
            editor.replaceRange('\n```', { line, ch: editor.getLine(line).length });
        }, marker);
        await fence('My own notes stay here.');
        await waitText('here.\n```\n');
        await sync(date);
        assert.match(await editorText(), /here\.\n```\n\n- \[ \] google events/, 'Hidden groups are left alone');
        await fence('```');
        await waitText('```\n```');
        await sync(date);
        assert.equal((await editorText()).match(/Change me please <!--/g)?.length, 1, 'Closing the fence creates nothing');
        console.log('PASS: a code fence can be opened above the groups and closed again.');
        const rowKey = key('task', 'list', 'change');
        await selectRow('Change me please', (await editorText()).split('\n').find(line => line.includes('Change me')).indexOf('please'));
        await page.keyboard.press('D');
        await waitOperation({ id: 'change', title: 'Change me' });
        await waitText(`Change me <!-- gdn:${rowKey} -->`);
        for (const [keys, title] of [[['c', 'c'], 'Via cc'], [['S'], 'Via S'], [['0', 'C'], 'Via C']]) {
            await selectRow(rowKey, 12);
            for (const pressed of keys) await page.keyboard.press(pressed);
            await page.keyboard.type(title);
            await page.keyboard.press('Escape');
            await waitText(`${title} <!-- gdn:${rowKey} -->`);
            await waitOperation({ id: 'change', title });
        }
        console.log('PASS: Vim C, D, cc and S change only the title.');
    }

    // 3.8: Escape closes a suggestion popup; 3.9: a row cannot be split.
    {
        const date = '2026-10-09';
        await open(date, [task('split', 'Do not split', date)]);
        await selectRow('My own notes stay here.');
        await page.keyboard.press('A');
        await page.keyboard.type(' [[');
        await page.locator('.suggestion-container').waitFor({ timeout: 5000 });
        await page.keyboard.press('Escape');
        await page.locator('.suggestion-container').waitFor({ state: 'detached', timeout: 5000 });
        await page.keyboard.press('Escape');
        console.log('PASS: Escape closes an editor suggestion popup.');
        await page.evaluate(() => {
            const cm = window.app.workspace.activeEditor.editor.cm;
            const text = cm.state.doc.toString();
            cm.dispatch({ changes: { from: text.indexOf('Do not split') + 3, insert: '\n\t' }, userEvent: 'input.paste' });
        });
        await noticeWith('cannot be split');
        assert.match(await editorText(), /Do not split <!--/);
        console.log('PASS: splitting a synced row is refused with a notice.');
        // O-L14: Enter that commits an input-method composition adds no task.
        await selectRow('Do not split');
        await page.keyboard.press('A');
        const rows = (await editorText()).split('\n').length;
        await page.evaluate(() => window.app.workspace.activeEditor.editor.cm.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })));
        await pause(300);
        assert.doesNotMatch(await editorText(), /gdn:new:/, 'A composing Enter inserts no draft');
        assert.ok((await editorText()).split('\n').length <= rows + 1);
        await page.keyboard.press('Escape');
        console.log('PASS: Enter during input-method composition adds no task.');
    }

    // 5.1 / D7: titles from Google load no remote content.
    {
        const hits = [];
        await page.route('https://example.invalid/**', route => { hits.push(route.request().url()); return route.fulfill({ status: 204, body: '' }); });
        const date = '2026-10-10';
        await open(date, [event('beacon', '![pixel](https://example.invalid/p.png) <img src="https://example.invalid/q.png"> `$= 1`', date)], 'q.png');
        assert.match(await editorText(), /\\!\[pixel\]\\\(https:\/\/example\.invalid\/p\.png\) \\<img/, 'The title is escaped');
        await pause(1500);
        await page.evaluate(() => window.app.commands.executeCommandById('markdown:toggle-preview'));
        await page.locator('.workspace-leaf.mod-active .markdown-preview-view').waitFor();
        await pause(1500);
        await page.evaluate(() => window.app.commands.executeCommandById('markdown:toggle-preview'));
        assert.deepEqual(hits, [], 'No remote request in Live Preview or Reading view');
        await page.unroute('https://example.invalid/**');
        console.log('PASS: remote titles load no images or HTML in Live Preview and Reading view.');
    }

    // 2026-10-03 audits: a title someone else wrote cannot become a clickable action.
    {
        const date = '2026-10-11';
        await open(date, [
            event('invite', '[Join meeting](obsidian://new?file=Pwned&content=x&overwrite=true) $\\href{file:///etc/hosts}{agenda}$ %% https://example.invalid/agenda', date),
            event('after', 'Row after the invitation', date, { sort: `${date} 11:00` }),
        ], 'Row after the invitation');
        // Reading view renders links as anchors; Live Preview as link and URL spans.
        const links = () => page.evaluate(() => {
            const leaf = '.workspace-leaf.mod-active';
            const anchors = [...document.querySelectorAll(`${leaf} .markdown-preview-view a`)].map(anchor => anchor.getAttribute('href') ?? '');
            const spans = [...document.querySelectorAll(`${leaf} .cm-content .cm-url, ${leaf} .cm-content .cm-link`)].map(span => span.textContent ?? '');
            return [...anchors, ...spans];
        });
        const math = () => page.evaluate(() => document.querySelectorAll('.workspace-leaf.mod-active mjx-container').length);
        const row = () => page.evaluate(() => [...document.querySelectorAll('.workspace-leaf.mod-active .cm-line, .workspace-leaf.mod-active .markdown-preview-view li')]
            .map(element => element.textContent ?? '').find(text => text.includes('Join meeting')) ?? '');
        const check = async view => {
            const found = await links();
            assert.deepEqual(found.filter(link => /(obsidian|file):/i.test(link)), [], `No obsidian: or file: link in ${view}: ${JSON.stringify(found)}`);
            assert.ok(found.some(link => link.includes('https://example.invalid/agenda')), `A bare web address still links in ${view}: ${JSON.stringify(found)}`);
            // A rendered link would hide its brackets and its destination.
            assert.match(await row(), /\[Join meeting\]\\?\(obsidian:\/\/new/, `The invitation link stays text in ${view}`);
            assert.equal(await math(), 0, `No rendered math in ${view}`);
        };
        await selectRow('My own notes stay here.');
        await pause(1000);
        await check('Live Preview');
        await page.evaluate(() => window.app.commands.executeCommandById('markdown:toggle-preview'));
        await page.locator('.workspace-leaf.mod-active .markdown-preview-view').waitFor();
        await pause(1000);
        await check('Reading view');
        assert.ok(await page.locator('.workspace-leaf.mod-active .markdown-preview-view').getByText('Row after the invitation').isVisible(), 'A %% in a title hides nothing after it');
        await page.evaluate(() => window.app.commands.executeCommandById('markdown:toggle-preview'));
        console.log('PASS: titles from other people add no links, math or comments.');
    }
    await setItems(originalItems);
}
