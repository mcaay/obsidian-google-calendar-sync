import { Platform, Setting } from 'obsidian';
import type GoogleDailyNotes from './main';

export function deviceConnectionSettings(root: HTMLElement, plugin: GoogleDailyNotes, refresh: () => void): void {
    new Setting(root).setName(Platform.isMobile ? 'Connect through Obsidian Sync' : 'Connect another device').setHeading();
    root.createEl('p', { text: 'Enable Installed community plugins and Active community plugin list in Obsidian Sync on both devices. Installed plugins includes their settings. The connection package is encrypted; the setup code is not saved.' });
    const message = root.createEl('p', { cls: 'gdn-connection-status' });
    if (plugin.auth.connected()) {
        let output!: HTMLInputElement;
        const codeSetting = new Setting(root).setName('Setup code').setDesc('Enter this on the other device within 30 minutes. Keep it private.').addText(text => {
            output = text.inputEl;
            output.readOnly = true;
            output.setAttribute('aria-label', 'Setup code');
        });
        codeSetting.settingEl.addClass('gdn-setup-code');
        codeSetting.settingEl.hide();
        new Setting(root).setName('Share this Google connection').addButton(button => button.setButtonText('Create setup code').onClick(async () => {
            button.setDisabled(true);
            try {
                const { transfer, code } = await plugin.auth.shareConnection();
                plugin.data.connectionTransfer = transfer;
                await plugin.persist();
                output.value = code;
                codeSetting.settingEl.show();
                output.focus(); output.select();
                message.setText('On the other device, open this plugin’s settings and enter the setup code.');
            } catch (error) { message.setText(error instanceof Error ? error.message : 'Could not create setup code.'); }
            finally { button.setDisabled(false); }
        })).addButton(button => button.setButtonText('Cancel setup').onClick(async () => {
            delete plugin.data.connectionTransfer;
            await plugin.persist(); output.value = ''; codeSetting.settingEl.hide();
            message.setText('Setup package removed.');
        }));
    }
    let code = '';
    let input!: HTMLInputElement;
    new Setting(root).setName('Code from your connected device').addText(text => {
        input = text.inputEl;
        input.autocomplete = 'off'; input.spellcheck = false;
        input.setAttribute('aria-label', 'Code from your connected device');
        text.setPlaceholder('XXXX-XXXX-XXXX-XXXX-XXXX').onChange(value => { code = value; });
    }).addButton(button => button.setButtonText('Connect').setCta().onClick(async () => {
        button.setDisabled(true);
        try {
            await plugin.onExternalSettingsChange();
            const transfer = plugin.data.connectionTransfer;
            if (!transfer) throw new Error('Waiting for the connection package. Let Obsidian Sync finish on both devices, then try again.');
            await plugin.auth.importConnection(transfer, code);
            code = ''; input.value = '';
            if (plugin.data.connectionTransfer?.encrypted === transfer.encrypted) delete plugin.data.connectionTransfer;
            await plugin.persist();
            plugin.controller.resume();
            refresh();
        } catch (error) { message.setText(error instanceof Error ? error.message : 'Could not connect.'); }
        finally { button.setDisabled(false); }
    }));
}
