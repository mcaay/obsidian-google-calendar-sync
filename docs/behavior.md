# Keyboard and sync reference

## Keyboard

| Key | Result |
| --- | --- |
| Cmd+Enter (Ctrl+Enter) | Toggle a task or a ⬜️ / ✅ calendar event. |
| Edit a title, then Escape | Sync the title. Without Vim: after 10 seconds without typing. |
| Vim `A` / `I` | Edit at the end / start of the title. |
| Vim `C`, `D`, `cc`, `S` | Change only the title; checkbox, time and hidden ID stay. |
| `o` / `O` or Enter on a task, `o` on the tasks heading | New task due on the note's date. |
| Paste a task row (`yyp`, `ddp`) | The pasted row becomes a new task. |
| `dd` | Delete from Google after 5 seconds. |

Calendar rows cannot create events. When the plugin refuses an edit, a notice says why.

## Deleting and undo

- A deleted row reaches Google after 5 seconds, without confirmation. `u` or Cmd+Z within that time cancels it. `ddp` deletes the original and creates the pasted task.
- Undo after 5 seconds recreates a Google Task as a new one-off task; its repeat schedule cannot be restored. A deleted calendar event cannot be restored.
- A recurring calendar event loses only that occurrence. Google's Tasks API cannot delete a whole repeating task; use **Delete all** in Google Tasks.
- Deleting a meeting you organize cancels it for every guest, and Google emails them. Deleting someone else's invitation sends no email. Deleting a task assigned from Docs or Chat also removes that assignment.

## What reaches Google

Only edits made in Obsidian's editor reach Google. A change that arrives any other way, for example through Obsidian Sync on another device, is not pushed again: the device where you made the change pushes it, the other device only shows it. A row deleted outside the editor comes back at the next sync.

Only `- [ ]` and `- [x]` rows directly under the tasks heading become Google Tasks; other lines there stay local. A new task row is created only by the device it was typed on, and a synced row can change a task only in a list enabled on this device.

Titles come from Google as plain text. Links, embeds, HTML, code, math and `%%` comments in them are escaped, so an invitation cannot load content, run code or add a clickable action. Bare web addresses still link.

## What appears

- Events overlapping the note's day, including all-day and multiday events.
- Tasks due that day, done or not.
- If enabled: unfinished tasks and unchecked ⬜️ events from earlier days.
- A checked row stays in its note.
- Recurring calendar rows show durations; times only with **Show times in recurring**.

Dates follow the time zone in settings. Google Tasks has dates only: a typed `📅 13:00` stays in the title and sets no reminder. Recurrence is managed in Google.

## Sync timing

Opening or creating an enabled note syncs it, then every 120 seconds (adjustable from 30 seconds to a day). Checkboxes sync at once, titles on Escape or after 10 seconds idle. **Sync now**, a command and an item in the `GCal:` status bar menu, syncs immediately. The status bar shows ✓ up to date, ↻ syncing and ✕ a problem; hover for details.

## Conflicts and failures

- Your edit wins for the field you changed; other fields keep Google's value.
- If Google refuses an edit, its value returns and a notice shows what you typed.
- Network and rate-limit problems keep edits queued. Account problems show a notice; revoked access shows **Reconnect needed**.
- A note is rewritten only if it did not change during the sync.
- New tasks carry a short tag in their Google notes until linked, to prevent duplicates. A lost response can rarely still leave a duplicate.

## Device state

Each device keeps pending edits, undo records and note snapshots in Obsidian's local storage, outside the vault. To discard everything pending on a device, disable the plugin, run this in the developer console, then enable it again:

```js
app.saveLocalStorage('google-daily-notes-journal', null); app.saveLocalStorage('google-daily-notes-device-state', null);
```

Data, permissions and **Disconnect**: see the [privacy policy](privacy.md).
