import { PluginSettingTab, Setting, type App, type ButtonComponent } from 'obsidian';
import { CLIENT_SECRET_KEY } from './auth';
import type GoogleDailyNotes from './main';

export class GoogleSettingsTab extends PluginSettingTab {
    constructor(app: App, private plugin: GoogleDailyNotes) { super(app, plugin); }

    display(): void {
        const { containerEl: root } = this;
        const plugin = this.plugin;
        const settings = plugin.data.settings;
        root.empty();
        new Setting(root).setName('Google account').setHeading();
        root.createEl('p', { text: 'Connect your own Google desktop OAuth client. Calendar titles and task edits go directly to Google. Other note content stays in your vault.' });
        root.createEl('a', { text: 'OAuth setup guide', href: 'https://developers.google.com/identity/protocols/oauth2/native-app' });
        new Setting(root).setName('Desktop OAuth client ID').addText(text => text.setPlaceholder('...apps.googleusercontent.com').setValue(settings.clientId).onChange(async value => {
            settings.clientId = value.trim(); await plugin.persist();
        }));
        new Setting(root).setName('Desktop OAuth client secret').setDesc('Stored in Obsidian SecretStorage, outside plugin data.json.').addText(text => {
            text.inputEl.type = 'password';
            text.setValue(this.app.secretStorage.getSecret(CLIENT_SECRET_KEY) ?? '').onChange(value => this.app.secretStorage.setSecret(CLIENT_SECRET_KEY, value.trim()));
        });
        const message = root.createEl('p', { cls: 'gdn-connection-status', text: plugin.auth.connected() ? 'Connected' : 'Not connected' });
        const connection = new Setting(root).setName('Connection');
        let linkInput!: HTMLInputElement;
        const linkSetting = new Setting(root).setName('Google sign-in link').setDesc('Copy this link into your preferred browser. It expires after 30 minutes.').addText(text => {
            linkInput = text.inputEl;
            linkInput.readOnly = true;
            linkInput.setAttribute('aria-label', 'Google sign-in link');
        });
        linkSetting.settingEl.hide();
        const connect = async (button: ButtonComponent, chooseBrowser = false) => {
            button.setDisabled(true); message.setText('Continue in your browser.');
            try {
                await plugin.auth.connect(chooseBrowser ? async url => {
                    linkInput.value = url;
                    linkSetting.settingEl.show();
                    message.setText('Open the sign-in link below in your preferred browser.');
                    linkInput.focus(); linkInput.select();
                } : undefined);
                await plugin.refreshSources();
                plugin.controller.reconnect(); this.display();
            } catch (error) { message.setText(error instanceof Error ? error.message : 'Connection failed.'); }
            finally { button.setDisabled(false); linkInput.value = ''; linkSetting.settingEl.hide(); }
        };
        connection.addButton(button => button.setButtonText(plugin.auth.connected() ? 'Reconnect Google' : 'Connect Google').setCta().onClick(() => connect(button)))
            .addButton(button => button.setButtonText('Use another browser').onClick(() => connect(button, true)))
            .addButton(button => button.setButtonText('Disconnect').onClick(() => {
            plugin.auth.disconnect(); plugin.controller.setStatus('Disconnected'); this.display();
        }));
        new Setting(root).setName('Calendars and task lists').setHeading();
        new Setting(root).setName('Available sources').setDesc('Refresh after adding or sharing a calendar or task list.').addButton(button => button.setButtonText('Refresh sources').setDisabled(!plugin.auth.connected()).onClick(async () => {
            try { await plugin.refreshSources(); this.display(); }
            catch (error) { message.setText(error instanceof Error ? error.message : 'Could not load sources.'); }
        }));
        for (const calendar of settings.calendars) {
            new Setting(root).setName(calendar.name).setDesc(calendar.writable ? '' : 'Read-only calendar.').addDropdown(dropdown => dropdown.addOptions({ off: 'Hidden', events: 'Google events', recurring: 'Recurring' }).setValue(calendar.role).onChange(async value => {
                calendar.role = value as typeof calendar.role; await plugin.persist(); plugin.controller.reconnect();
            }));
        }
        for (const list of settings.taskLists) new Setting(root).setName(list.name).setDesc('Google Tasks list').addToggle(toggle => toggle.setValue(list.enabled).onChange(async value => {
            list.enabled = value;
            if (value && !settings.defaultTaskList) settings.defaultTaskList = list.id;
            if (!value && settings.defaultTaskList === list.id) settings.defaultTaskList = settings.taskLists.find(item => item.enabled)?.id ?? '';
            await plugin.persist(); plugin.controller.reconnect(); this.display();
        }));
        new Setting(root).setName('New tasks go to').addDropdown(dropdown => {
            dropdown.addOption('', 'Choose a list');
            for (const list of settings.taskLists.filter(value => value.enabled)) dropdown.addOption(list.id, list.name);
            dropdown.setValue(settings.defaultTaskList).onChange(async value => { settings.defaultTaskList = value; await plugin.persist(); });
        });
        new Setting(root).setName('Daily note behavior').setHeading();
        for (const [key, name, description] of [
            ['markers', 'Calendar checkboxes', 'Treat titles starting with ⬜️ or ✅ as tasks.'],
            ['overdueEvents', 'Overdue calendar tasks', 'Include unchecked marked events from earlier days.'],
            ['overdueTasks', 'Overdue Google Tasks', 'Include dated, unfinished tasks from earlier days.'],
            ['recurringTime', 'Show times in recurring', 'Durations are always shown.'],
        ] as const) new Setting(root).setName(name).setDesc(description).addToggle(toggle => toggle.setValue(settings[key]).onChange(async value => {
            settings[key] = value; await plugin.persist(); plugin.controller.reconnect();
        }));
        new Setting(root).setName('Automatic sync interval').setDesc('Seconds. Default: 120. Minimum: 30.').addText(text => text.setValue(String(settings.intervalSeconds)).onChange(async value => {
            const seconds = Number(value);
            if (Number.isFinite(seconds) && seconds >= 30) { settings.intervalSeconds = seconds; await plugin.persist(); plugin.controller.scheduler.resetPeriodic(); }
        }));
        new Setting(root).setName('Time zone').setDesc('Used for daily-note boundaries and calendar event times.').addText(text => text.setValue(settings.timeZone).onChange(async value => {
            try { new Intl.DateTimeFormat('en', { timeZone: value }).format(); }
            catch { return; }
            settings.timeZone = value; await plugin.persist(); plugin.controller.reconnect();
        }));
        root.createEl('p', { text: 'Google Tasks exposes dates only. A typed 📅 13:00 prefix stays in the task title; it does not set a Google reminder or reveal a native task time.' });
        root.createEl('p', { text: 'Use the Insert Google daily sections command in your daily-note template. Enable notes with google-daily: true. The filename must be YYYY-MM-DD, or set google-daily-date in properties.' });
    }
}
