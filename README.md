# Calendar Sync by mcaay

Idea:
- events and tasks from Google appear as normal markdown in your daily notes
- which means **you can use normal keyboard navigation, including vim mode, to manage those tasks** and you can even toggle the "done" status, which will sync it to google

Why:
- google handles recurring tasks very well, so it's good to schedule them there
- google also handles meetings and events very well, it's easy to invite someone to a meeting if you just have his email address
- it's nice to see everything in obsidian rather than checking 2 separate places every day

Video walkthrough - **first 6 minutes is a TLDR section**, then I'm rambling for 15 more minutes.

[![Watch the walkthrough on YouTube](https://img.youtube.com/vi/RmP0dOEpyMs/maxresdefault.jpg)](https://www.youtube.com/watch?v=RmP0dOEpyMs)


## Install

Requires Obsidian 1.13+. Runs on macOS, Windows and Linux, and on iPhone (verified on a physical iPhone; Android is untested). [Connect your phone through Obsidian Sync](docs/setup.md#connect-another-device).

1. [Download the plugin](https://github.com/mcaay/obsidian-google-calendar-sync/releases/download/0.9.0/google-daily-notes.zip), unzip it into `<Vault>/.obsidian/plugins/`, then enable **Calendar Sync by mcaay** in **Settings → Community plugins**.
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

Use `YYYY-MM-DD` filenames. Rename or move the three headings wherever you want; keep their comments. Only checkbox rows directly under **google tasks** become Google Tasks; other lines there stay in your note. [Other date formats and template options](https://github.com/mcaay/obsidian-google-calendar-sync/blob/main/docs/setup.md#daily-note-template).

## Use it

- **Cmd/Ctrl+Enter** toggles tasks. Calendar titles starting with `⬜️` or `✅` also work as checkboxes when enabled in settings.
- **Edit a title** and press Escape in Vim. Without Vim, edits sync after 10 seconds of inactivity.
- **Vim `o` / `O`** on a Google Task creates another task due on the note's date.
- **Vim `yyp` / `ddp`** pastes a task row as a new task due on that note's date. `ddp` deletes the original after 5 seconds.
- **Vim `dd`** deletes from Google after 5 seconds. **`u` / Cmd+Z** within that window cancels deletion; undo right after creating a task removes it. Recurring Calendar events lose only that occurrence.
- **Hover `GCal:`** in the status bar to see what is syncing, waiting or failing.

Create and schedule Calendar events, including recurrence, in Google Calendar.

## Limits

- Google Tasks' API exposes dates, but no reminder times or recurrence controls. A typed `📅 13:00` stays in the title. Deleting an entire repeating task series cannot be guaranteed.
- Undo after the 5-second window recreates a Google Task without its recurrence or reminder time. It cannot restore a deleted Calendar event.
- Only edits made in Obsidian's editor reach Google. A change that arrives through Sync, another app or a plugin that writes the file shows Google's value again at the next sync.
- Deleting a meeting you organize cancels it for all guests, without notification emails.
- If Google's answer to a new task is lost, the plugin searches for the task before sending it again. Rarely, this still leaves a duplicate, which shows in the note.

The plugin connects directly to Google, with no telemetry. Other note text stays in your vault; credentials use Obsidian SecretStorage.

## Review

The code was reviewed by Opus 5.5, Fable 5.1 and GPT 6 Astra, and the fixes were implemented by Opus 5.5. You can read the reviews, the remarks on them and the fix plan in the [reviews](reviews) folder.

[Keyboard and sync details](https://github.com/mcaay/obsidian-google-calendar-sync/blob/main/docs/behavior.md) · [Privacy](https://github.com/mcaay/obsidian-google-calendar-sync/blob/main/docs/privacy.md) · [Development](https://github.com/mcaay/obsidian-google-calendar-sync/blob/main/docs/development.md) · [MIT license](LICENSE)
