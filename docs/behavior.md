# Keyboard and sync reference

## Keyboard

| Action | Result |
| --- | --- |
| Vim movement | Ordinary movement through actual Markdown rows. |
| Cmd+Enter on macOS, Ctrl+Enter elsewhere | Toggle a Google task or marked calendar event. |
| Edit a title, then Escape | Sync the title when Vim enters normal mode. |
| Edit without Vim | Sync after 10 seconds without another edit to that note. |
| Vim `A` / `I` on a synced row | Insert at the end / beginning of the editable title. |
| Vim `C`, `D`, `cc`, `S` on a synced row | Change or delete the title only. The checkbox, event time and hidden ID stay. |
| Vim `o` / `O` on a Google Task | Insert a new task below / above, due on the note's date. |
| Vim `o`, or Enter outside Vim normal mode, on the Google Tasks heading | Insert the first child task, including when the group is empty. |
| Enter on a Google Task outside Vim normal mode | Insert a new task below. |
| Vim `o` / `O`, or Enter, on a calendar event | No action. Calendar rows cannot create new events. |
| Paste a task row, for example `yyp` or `ddp` | The pasted row becomes a new task due on that note's date. |

Vim `dd` and other whole-row deletions remove the row immediately and wait **5 seconds** before deleting it from Google. Native Vim `u` or Cmd+Z during those five seconds restores the row and cancels deletion. Redo starts a fresh five-second window. No confirmation appears. `ddp` therefore deletes the original task after five seconds and creates the pasted one; undo keeps the original. Google-only data such as a repeat schedule does not move with a pasted row.

Undo after creating a task removes its row and deletes the task after the same five seconds. Redo within that time keeps it.

After five seconds, undo of a **Google Task** creates a new task with the restored title and completion status, original due date, and original task list. The restored row then carries the new task's ID, so other devices see the same task. If deletion is still pending, creation waits for it to succeed; offline retries and plugin reloads preserve this sequence. Restoring stale Markdown outside native undo never creates a replacement.

For recurring **Calendar events**, deletion affects only the displayed occurrence. Calendar events cannot be recreated from Obsidian after deletion has been sent: undo still brings the row back, a notice says the event cannot be restored, and the row disappears at the next sync. Undo and redo always apply; they never get stuck on a row that Google no longer has. Pasting a calendar row is refused with a notice.

For **Google Tasks**, the plugin deletes the task by ID. Google's public API exposes neither recurrence information nor a delete-all-occurrences option, so the plugin cannot guarantee removal of an entire repeating series. Use Google's own **Delete all** action for that. A task recreated by late undo is a one-off task; the API cannot restore its repeat schedule or native reminder time. See the [Tasks API](https://developers.google.com/workspace/tasks/reference/rest/v1/tasks) and [Google's recurring-task instructions](https://support.google.com/tasks/answer/12132599).

Event time, duration, row identity, and group structure remain protected. An edit the plugin refuses shows a short notice saying why. Groups can be added, for example by inserting the template into an enabled note, but not removed while the note has `google-daily: true`; set it to `false` first. A note with a duplicated group marker stays editable so you can remove the extra one. A code fence above the groups may hide them while you type; they return when the fence closes. A synced row cannot be split into two lines.

## Which edits reach Google

Only edits made in Obsidian's editor on this device change Google: typing, checkbox toggles, deletions, undo and redo, and checkbox clicks in Reading view. Changes that reach a note any other way are treated as display: Obsidian Sync, iCloud or Dropbox, git, other apps, and plugins that write the file directly. A synced row changed that way shows Google's values again at the next sync. Deleting a row outside Obsidian's editor never deletes the Google item; it returns at the next sync.

In the Google Tasks group, only `- [ ]` and `- [x]` rows directly under the heading become Google Tasks. Plain text, other bullets, nested lines and code blocks stay local and untouched. A task row belongs to the device that created it: the plugin's `o`, `O` and Enter give it a hidden ID at once, and a checkbox row you type or paste gets one in the same edit. A task row that arrives from another device without an ID stays a local row.

Calendar groups stay in chronological order. Task rows keep the order you give them; a new task from Google appears at its sorted place among them. A sync changes only the lines that differ.

Titles from Google are shown as text. HTML, image and note embeds, and inline code in a title are escaped with backslashes, so an invitation or an assigned task cannot make a note load remote content or run inline code. Links and emphasis still work. Editing such a title sends it back without the added backslashes.

## What appears

- Normal events overlapping the note's day, including multiday and all-day events.
- Events with `⬜️` or `✅` at the beginning of the title appear as checkboxes when **Calendar checkboxes** is enabled. Checking a recurring event changes that occurrence only.
- Unchecked marked events from earlier days when **Overdue calendar tasks** is enabled. No historical cutoff applies. Each device keeps a list of them and asks Google only for changes since its last sync, plus one full reading a day.
- Scheduled Google Tasks due that day, plus unfinished tasks from earlier days when enabled. Unscheduled and future tasks are omitted.
- Both done and undone items scheduled for the note's day. A checked row in a note stays in that note, even when it is overdue, so you can see it and undo the checkmark. It is not carried into the next day's note. Every device reads this from the note itself.
- Recurring-calendar durations, with times hidden by default. Enable **Show times in recurring** to display them. Normal events always show their times.

The configured time zone governs event dates and times, including daylight-saving transitions and days whose midnight is skipped. Google's task due dates are used as dates without time-zone conversion.

## Google Tasks limits

**Google's public Tasks API cannot read or write native task times.** A title such as `📅 13:00 Call Sam` is supported as a literal title, visible in both apps. It does not create a timed Google reminder. A time set in Google's UI cannot be displayed through this API. See the [official task resource reference](https://developers.google.com/workspace/tasks/reference/rest/v1/tasks).

Recurrence is managed in Google. The plugin shows the dated task instances Google exposes through its API; it cannot expand a recurring Google Task into all future occurrences or edit recurrence rules. Calendar recurrence is supported through Google's expanded event instances.

## Sync timing

Opening or creating an enabled note triggers a sync. The default interval is 120 seconds; it can be set between 30 seconds and one day. Checkbox changes sync immediately; title edits sync when Vim returns to normal mode, or after 10 seconds of inactivity without Vim. An edit-triggered sync restarts the interval. Editing text outside synced rows does not start a sync. Pending work also completes when its note is closed, disabled, renamed outside Obsidian or deleted.

## Conflicts and failures

- An edited title or status in Obsidian wins for that field. Fields you did not edit keep Google's current value.
- A conditional update re-reads once if the remote resource changed during the request.
- Multiple local edits to the same item are serialized. An edit made while an earlier one is being sent stays pending and is sent next.
- **Google refuses an edit**, for example a title on a read-only calendar or an event Google does not let you rename: Google wins. The edit is dropped, the row shows Google's value again, and a notice shows the refused value so the text you typed is not lost. A refused new task stays as a local row and is sent again only after you edit it.
- **Account problems**, such as a disabled API or missing permission, keep the work queued and show a notice naming the fix. Expired or revoked access shows **Reconnect needed** once and stops retrying until you reconnect.
- **Temporary problems**, such as no network, Google errors or rate limits, keep the work queued. The plugin waits longer after repeated rate limits and follows Google's requested delay.
- **A calendar or list that cannot be read** is skipped; its rows stay as they are and a notice names it.
- A remote deletion wins over stale note content. Explicit native undo of a task deleted through the plugin creates a new linked task.
- A note is updated only if its text still matches what the sync read. Typing during a network request postpones the refresh instead of overwriting your work.
- New tasks briefly receive a unique reconciliation tag in their Google task notes. Once the Google task ID is saved and the note shows the new ID, the plugin removes its exact tag, preserving any description you added. Failed cleanup retries automatically; tags left by older versions are cleaned up too.
- **A creation whose response was lost** is searched for two minutes after that request ended, including tasks that were completed or deleted since. A match is linked; several matches link one and leave the others as ordinary tasks. If a successful search finds nothing, the task is sent again with the same tag. Google's API has no idempotency key, so a first request that Google commits only after that search can still leave a duplicate. It appears in the note and can be deleted. Deleting the row cancels the creation for good.

The status bar shows `GCal: ✓` when up to date, `GCal: ↻` while syncing or waiting, and `GCal: ✕` for a problem, including **Not connected**. Hover over it for the reason. It also names task rows that are waiting for another device to create them. Problems that need your action also show a notice once per session on each device.

## Two devices

Each device creates only its own new tasks. While a task another device created still carries its reconciliation tag, this device links that row to the task, and an edit made here reaches it. If this device sees that row only after the tag was removed, the task can appear twice until Sync delivers the other device's updated row; an edit made on the stale row is lost. Keeping the tag longer would close this gap but leave it visible in Google Tasks.

## Effects on other people

Row deletion follows the rules above, without confirmation:

- Deleting a meeting you organize cancels it for every guest, without notification emails. Guests who do not use Google Calendar may keep a stale copy.
- Deleting a Google Task assigned to you from Google Docs or Chat also deletes the original assignment there, as Google's Tasks API documents.
- Title and ✅ / ⬜️ changes on meetings you organize are visible to guests.

## Pending work on this device

Pending edits, deletions and undo decisions are saved on each device in Obsidian's local storage, outside the vault and outside `data.json`: `google-daily-notes-journal` for pending work and `google-daily-notes-device-state` for note snapshots, created task IDs and the overdue-event list. Copying or deleting `data.json` does not back up or clear them. Each save is read back; if saving fails, the plugin sends nothing to Google, keeps what it has, and shows a notice. An undone deletion can then still run after a restart.

Device state that is no longer needed is removed automatically: undo records after Obsidian restarts, note snapshots after 14 days without a sync, and created task IDs 14 days after their tag was removed. A copy of an old note that arrives later is then not linked on this device, and its draft rows are not created again.

To discard all pending work on a device, disable the plugin, then run this in the developer console and enable it again:

```js
app.saveLocalStorage('google-daily-notes-journal', null); app.saveLocalStorage('google-daily-notes-device-state', null);
```

Queued work belongs to the device, not to a Google account. After switching accounts, it runs through the new account wherever that account has access, for example a shared calendar, and is refused elsewhere.

## Privacy and permissions

Google OAuth tokens and the client secret use Obsidian's local `SecretStorage`, outside the plugin's `data.json`. This is Obsidian-managed storage; the plugin does not make its own encryption guarantee. Do not include secrets or personal note data in bug reports.

The plugin contacts Google's authorization and token endpoints, Calendar API, and Tasks API. It sends selected item IDs, edited titles and status, and new task titles, dates, and reconciliation tags. It asks Google only for the fields it uses. Other note text and vault filenames are not sent to Google. There is no telemetry and no external server operated by this plugin.

Permissions requested:

- `calendar.calendarlist.readonly` to list calendars and their permissions.
- `calendar.events` to read events, update their titles and checkmarks, and delete individual events or occurrences. The plugin does not create events or delete whole recurring calendar series.
- `tasks` to read, rename, complete, create, and delete tasks.

If Google's consent screen grants only part of this, connecting stops and names what is missing.

Disconnect removes the locally stored authorization on this device. It does not revoke access at Google, because other devices use the same authorization. To revoke it everywhere, use your [Google account connections](https://myaccount.google.com/connections).
