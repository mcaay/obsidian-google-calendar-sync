import { Platform, type SettingDefinitionGroup, type SettingTab } from 'obsidian';
import type GoogleDailyNotes from './main';

export function deviceConnectionSettings(plugin: GoogleDailyNotes, tab: SettingTab): SettingDefinitionGroup {
    // The created code is shown in its own row, revealed by refreshDomState().
    let setupCode = '';
    let output: HTMLInputElement | undefined;
    let code = '';
    return {
        type: 'group',
        heading: Platform.isMobile ? 'Connect through Obsidian Sync' : 'Connect another device',
        items: [
            {
                name: 'Obsidian Sync',
                desc: createFragment(fragment => {
                    fragment.appendText('Enable ');
                    fragment.createEl('strong', { text: 'Installed community plugins' });
                    fragment.appendText(' and ');
                    fragment.createEl('strong', { text: 'Active community plugin list' });
                    fragment.appendText(' on both devices. Installed plugins includes their settings. The connection package is encrypted; the setup code is not saved.');
                }),
            },
            {
                name: 'Share this Google connection',
                visible: () => plugin.auth.connected(),
                render: setting => {
                    setting.addButton(button => button.setButtonText('Create setup code').onClick(async () => {
                        button.setDisabled(true); setting.setErrorMessage(null);
                        try {
                            const shared = await plugin.auth.shareConnection();
                            plugin.data.connectionTransfer = shared.transfer;
                            await plugin.persist();
                            setupCode = shared.code;
                            tab.refreshDomState();
                            if (output) { output.value = setupCode; output.focus(); output.select(); }
                            setting.setDesc('On the other device, open this plugin’s settings and enter the setup code.');
                        } catch (error) { setting.setErrorMessage(error instanceof Error ? error.message : 'Could not create setup code.'); }
                        finally { button.setDisabled(false); }
                    })).addButton(button => button.setButtonText('Cancel setup').onClick(async () => {
                        delete plugin.data.connectionTransfer;
                        await plugin.persist();
                        setupCode = '';
                        if (output) output.value = '';
                        tab.refreshDomState();
                        setting.setDesc('Setup package removed.');
                    }));
                },
            },
            {
                name: 'Setup code',
                desc: 'Enter this on the other device within 30 minutes. Keep it private.',
                visible: () => setupCode !== '' && plugin.auth.connected(),
                render: setting => {
                    setting.settingEl.addClass('gdn-setup-code');
                    setting.addText(text => {
                        output = text.inputEl;
                        output.readOnly = true;
                        output.setAttribute('aria-label', 'Setup code');
                    });
                },
            },
            {
                name: 'Code from your connected device',
                render: setting => {
                    let input!: HTMLInputElement;
                    setting.addText(text => {
                        input = text.inputEl;
                        input.autocomplete = 'off'; input.spellcheck = false;
                        input.setAttribute('aria-label', 'Code from your connected device');
                        text.setPlaceholder('XXXX-XXXX-XXXX-XXXX-XXXX').onChange(value => { code = value; });
                    }).addButton(button => button.setButtonText('Connect').setCta().onClick(async () => {
                        button.setDisabled(true); setting.setErrorMessage(null);
                        try {
                            await plugin.onExternalSettingsChange();
                            const transfer = plugin.data.connectionTransfer;
                            if (!transfer) throw new Error('Waiting for the connection package. Let Obsidian Sync finish on both devices, then try again.');
                            await plugin.auth.importConnection(transfer, code);
                            code = ''; input.value = '';
                            if (plugin.data.connectionTransfer?.encrypted === transfer.encrypted) delete plugin.data.connectionTransfer;
                            await plugin.persist();
                            plugin.controller.resume();
                            tab.update();
                        } catch (error) { setting.setErrorMessage(error instanceof Error ? error.message : 'Could not connect.'); }
                        finally { button.setDisabled(false); }
                    }));
                },
            },
        ],
    };
}
