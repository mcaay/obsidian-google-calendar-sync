import { Platform, PluginSettingTab, type App, type ButtonComponent, type SettingDefinition, type SettingDefinitionItem } from 'obsidian';
import { CLIENT_SECRET_KEY } from './auth';
import { MAX_INTERVAL, MIN_INTERVAL } from './scheduler';
import type GoogleDailyNotes from './main';
import { DEFAULT_SETTINGS, type CalendarChoice, type Settings } from './types';
import { deviceConnectionSettings } from './device-connection-settings';

/**
 * How to read this code:
 * 1. Obsidian calls getSettingDefinitions() to draw the tab and, once at
 *    registration, to index settings search. It only describes rows.
 * 2. `control` rows read getControlValue() and write setControlValue(), which
 *    saves through plugin.persist() and then reconnects or resets the timer.
 *    Calendars and task lists bind by ID (`calendar:<id>`, `list:<id>`):
 *    Obsidian keys rows by name, and a calendar can share a list's name.
 * 3. `render` rows cover what a control cannot: the client ID saved only when
 *    the field is left, the secret in Obsidian's keychain, Google sign-in and
 *    device transfer (device-connection-settings.ts).
 * 4. update() rebuilds the tab after connecting or loading sources;
 *    refreshDomState() re-evaluates `visible` to reveal a prepared row.
 * Ordinary: switching off Overdue Google Tasks saves and resyncs open notes.
 * Tricky: switching off the default task list picks the next enabled list and
 *    rebuilds the tab, because enabled lists are the choices of New tasks go to.
 */
export class GoogleSettingsTab extends PluginSettingTab {
    constructor(app: App, private plugin: GoogleDailyNotes) { super(app, plugin); }

    getControlValue(key: string): unknown {
        const settings = this.plugin.data.settings;
        const id = key.slice(key.indexOf(':') + 1);
        if (key.startsWith('calendar:')) return settings.calendars.find(calendar => calendar.id === id)?.role;
        if (key.startsWith('list:')) return settings.taskLists.find(list => list.id === id)?.enabled;
        return settings[key as keyof Settings];
    }

    async setControlValue(key: string, value: unknown): Promise<void> {
        const settings = this.plugin.data.settings;
        const id = key.slice(key.indexOf(':') + 1);
        if (key.startsWith('calendar:')) {
            const calendar = settings.calendars.find(item => item.id === id);
            if (calendar) calendar.role = value as CalendarChoice['role'];
        } else if (key.startsWith('list:')) {
            const list = settings.taskLists.find(item => item.id === id);
            if (list) list.enabled = value as boolean;
            if (value && !settings.defaultTaskList) settings.defaultTaskList = id;
            if (!value && settings.defaultTaskList === id) settings.defaultTaskList = settings.taskLists.find(item => item.enabled)?.id ?? '';
        } else Object.assign(settings, { [key]: value });
        await this.plugin.persist();
        if (key === 'intervalSeconds') this.plugin.controller.scheduler.resetPeriodic();
        else if (key !== 'defaultTaskList') this.plugin.controller.reconnect();
        if (key.startsWith('list:')) this.update();
    }

    getSettingDefinitions(): SettingDefinitionItem[] {
        const plugin = this.plugin;
        const settings = plugin.data.settings;
        // Shared by the Connection row and the sign-in link row it reveals.
        let signInLink = '';
        let linkInput: HTMLInputElement | undefined;
        let attempt = 0;
        return [
            {
                type: 'group',
                heading: 'Google account',
                items: [
                    ...(Platform.isMobile ? [] : [
                        {
                            name: 'Desktop OAuth client ID',
                            desc: createFragment(fragment => {
                                fragment.appendText('Connect your own Google desktop OAuth client. Calendar titles and task edits go directly to Google. Other note content stays in your vault. ');
                                fragment.createEl('a', { text: 'OAuth setup guide', href: 'https://developers.google.com/identity/protocols/oauth2/native-app' });
                            }),
                            // Saved when the field is left, so Sync does not carry every keystroke.
                            render: setting => {
                                setting.addText(text => {
                                    text.setPlaceholder('...apps.googleusercontent.com').setValue(settings.clientId);
                                    text.inputEl.addEventListener('change', () => {
                                        settings.clientId = text.getValue().trim();
                                        void plugin.persist();
                                    });
                                });
                            },
                        },
                        {
                            name: 'Desktop OAuth client secret',
                            desc: 'Stored in Obsidian’s keychain, outside plugin data.json.',
                            render: setting => {
                                setting.addText(text => {
                                    text.inputEl.type = 'password';
                                    let saved = '';
                                    try { saved = this.app.secretStorage.getSecret(CLIENT_SECRET_KEY) ?? ''; } catch { /* Shown on change. */ }
                                    text.setValue(saved);
                                    text.inputEl.addEventListener('change', () => {
                                        setting.setErrorMessage(null);
                                        try { this.app.secretStorage.setSecret(CLIENT_SECRET_KEY, text.getValue().trim()); }
                                        catch (error) { setting.setErrorMessage(`Obsidian could not store the client secret securely: ${error instanceof Error ? error.message : String(error)}`); }
                                    });
                                });
                            },
                        },
                    ] satisfies SettingDefinition[]),
                    {
                        name: 'Connection',
                        render: setting => {
                            const status = plugin.auth.connected() ? 'Connected' : plugin.auth.needsReconnect() ? 'Reconnect needed' : 'Not connected';
                            setting.setDesc(status);
                            const connect = async (button: ButtonComponent, chooseBrowser = false) => {
                                const current = ++attempt;
                                button.setDisabled(true); setting.setErrorMessage(null); setting.setDesc('Continue in your browser.');
                                try {
                                    await plugin.auth.connect(chooseBrowser ? async url => {
                                        signInLink = url;
                                        this.refreshDomState();
                                        if (linkInput) { linkInput.value = url; linkInput.focus(); linkInput.select(); }
                                        setting.setDesc('Open the sign-in link below in your preferred browser.');
                                    } : undefined);
                                    await plugin.refreshSources();
                                    plugin.controller.reconnect(); this.update();
                                } catch (error) {
                                    // A newer attempt replaced this one; its own result counts.
                                    if (current === attempt) { setting.setDesc(status); setting.setErrorMessage(error instanceof Error ? error.message : 'Connection failed.'); }
                                } finally {
                                    button.setDisabled(false);
                                    if (current === attempt) {
                                        signInLink = '';
                                        if (linkInput) linkInput.value = '';
                                        this.refreshDomState();
                                    }
                                }
                            };
                            if (!Platform.isMobile) {
                                setting.addButton(button => button.setButtonText(plugin.auth.connected() ? 'Reconnect Google' : 'Connect Google').setCta().onClick(() => connect(button)))
                                    .addButton(button => button.setButtonText('Use another browser').onClick(() => connect(button, true)));
                            }
                            if (plugin.auth.connected()) setting.addButton(button => button.setButtonText('Disconnect').onClick(() => {
                                plugin.auth.disconnect(); plugin.controller.setStatus({ state: 'error', text: 'Not connected', detail: 'Connect Google in Calendar Sync settings.' }); this.update();
                            }));
                        },
                    },
                    ...(Platform.isMobile ? [] : [{
                        name: 'Google sign-in link',
                        desc: 'Copy this link into your preferred browser. It expires after 30 minutes.',
                        visible: () => signInLink !== '',
                        render: setting => {
                            setting.addText(text => {
                                linkInput = text.inputEl;
                                linkInput.readOnly = true;
                                linkInput.setAttribute('aria-label', 'Google sign-in link');
                            });
                        },
                    }] satisfies SettingDefinition[]),
                ],
            },
            deviceConnectionSettings(plugin, this),
            {
                type: 'group',
                heading: 'Calendars and task lists',
                items: [
                    {
                        name: 'Available sources',
                        desc: 'Refresh after adding or sharing a calendar or task list.',
                        render: setting => {
                            setting.addButton(button => button.setButtonText('Refresh sources').setDisabled(!plugin.auth.connected()).onClick(async () => {
                                setting.setErrorMessage(null);
                                try { await plugin.refreshSources(); this.update(); }
                                catch (error) { setting.setErrorMessage(error instanceof Error ? error.message : 'Could not load sources.'); }
                            }));
                        },
                    },
                    ...settings.calendars.map((calendar): SettingDefinition => ({
                        name: calendar.name,
                        desc: calendar.writable ? '' : 'Read-only calendar.',
                        control: { type: 'dropdown', key: `calendar:${calendar.id}`, options: { off: 'Hidden', events: 'Google events', recurring: 'Recurring' } },
                    })),
                    ...settings.taskLists.map((list): SettingDefinition => ({
                        name: list.name,
                        desc: 'Google Tasks list',
                        control: { type: 'toggle', key: `list:${list.id}` },
                    })),
                    {
                        name: 'New tasks go to',
                        control: {
                            type: 'dropdown', key: 'defaultTaskList',
                            options: { '': 'Choose a list', ...Object.fromEntries(settings.taskLists.filter(list => list.enabled).map(list => [list.id, list.name])) },
                        },
                    },
                ],
            },
            {
                type: 'group',
                heading: 'Daily note behavior',
                items: [
                    { name: 'Calendar checkboxes', desc: 'Treat titles starting with ⬜️ or ✅ as tasks.', control: { type: 'toggle', key: 'markers' } },
                    { name: 'Overdue calendar tasks', desc: 'Include unchecked marked events from earlier days.', control: { type: 'toggle', key: 'overdueEvents' } },
                    { name: 'Overdue Google Tasks', desc: 'Include dated, unfinished tasks from earlier days.', control: { type: 'toggle', key: 'overdueTasks' } },
                    { name: 'Show times in recurring', desc: 'Durations are always shown.', control: { type: 'toggle', key: 'recurringTime' } },
                    {
                        name: 'Automatic sync interval',
                        desc: `Seconds. Default: ${DEFAULT_SETTINGS.intervalSeconds}. Minimum: ${MIN_INTERVAL}. Maximum: ${MAX_INTERVAL}.`,
                        control: { type: 'number', key: 'intervalSeconds', min: MIN_INTERVAL, max: MAX_INTERVAL, defaultValue: DEFAULT_SETTINGS.intervalSeconds },
                    },
                    {
                        name: 'Time zone',
                        desc: 'Used for daily-note boundaries and calendar event times.',
                        control: {
                            type: 'text', key: 'timeZone',
                            validate: value => {
                                try { new Intl.DateTimeFormat('en', { timeZone: value }).format(); return undefined; }
                                catch { return 'Unknown time zone.'; }
                            },
                        },
                    },
                    { name: 'Task times', desc: 'Google Tasks exposes dates only. A typed 📅 13:00 prefix stays in the task title; it does not set a Google reminder or reveal a native task time.' },
                    {
                        name: 'Daily note template',
                        desc: createFragment(fragment => {
                            fragment.appendText('Use the ');
                            fragment.createEl('strong', { text: 'Insert Google daily sections' });
                            fragment.appendText(' command in your daily-note template. Enable notes with google-daily: true. The filename must be YYYY-MM-DD, or set google-daily-date in properties.');
                        }),
                    },
                ],
            },
        ];
    }
}
