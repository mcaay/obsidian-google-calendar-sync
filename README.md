# Google Calendar Sync by mcaay

[![Watch the walkthrough on YouTube](https://img.youtube.com/vi/RmP0dOEpyMs/maxresdefault.jpg)](https://www.youtube.com/watch?v=RmP0dOEpyMs)

Google Calendar and Google Tasks in your Obsidian daily notes. Real Markdown rows: edit titles, tick checkboxes and add tasks with your keyboard, including Vim.

Shows the note's events and dated tasks, plus unfinished tasks from earlier days. Unscheduled Google Tasks stay out. Syncs automatically.

## Install

Early release, v0.8.1. Requires Obsidian desktop 1.11.4+. Mobile support is a v2 target.

1. [Download the plugin](https://github.com/mcaay/obsidian-google-calendar-sync/releases/download/0.8.1/google-daily-notes.zip), unzip it into `<Vault>/.obsidian/plugins/`, then enable **Google Calendar Sync by mcaay** in **Settings → Community plugins**.
2. [Connect Google](https://github.com/mcaay/obsidian-google-calendar-sync/blob/main/docs/setup.md). You currently need your own Google Cloud OAuth client; the guide covers setup and choosing calendars and task lists.
3. Add this to your daily-note template. If it already has properties, add `google-daily: true` to those.

```markdown
---
google-daily: true
---

- [ ] google events <!-- gdn:events -->
- [ ] recurring <!-- gdn:recurring -->
- [ ] google tasks <!-- gdn:tasks -->
```

Use `YYYY-MM-DD` filenames. Rename or move the three headings wherever you want; keep their comments. [Other date formats and template options](https://github.com/mcaay/obsidian-google-calendar-sync/blob/main/docs/setup.md#daily-note-template).

## Use it

- **Cmd/Ctrl+Enter** toggles tasks. Calendar titles starting with `⬜️` or `✅` also work as checkboxes when enabled in settings.
- **Edit a title** and press Escape in Vim. Without Vim, edits sync after 10 seconds of inactivity.
- **Vim `o` / `O`** on a Google Task creates another task due on the note's date.
- **Vim `dd`** deletes from Google after 5 seconds. **`u` / Cmd+Z** within that window cancels deletion. Recurring Calendar events lose only that occurrence.

Create and schedule Calendar events, including recurrence, in Google Calendar.

## Limits

- Google Tasks' API exposes dates, but no reminder times or recurrence controls. A typed `📅 13:00` stays in the title. Deleting an entire repeating task series cannot be guaranteed.
- Undo after the 5-second window recreates a Google Task without its recurrence or reminder time. It cannot restore a deleted Calendar event.

The plugin connects directly to Google, with no telemetry. Other note text stays in your vault; credentials use Obsidian SecretStorage.

[Keyboard and sync details](https://github.com/mcaay/obsidian-google-calendar-sync/blob/main/docs/behavior.md) · [Privacy](https://github.com/mcaay/obsidian-google-calendar-sync/blob/main/docs/privacy.md) · [Development](https://github.com/mcaay/obsidian-google-calendar-sync/blob/main/docs/development.md) · [MIT license](LICENSE)
