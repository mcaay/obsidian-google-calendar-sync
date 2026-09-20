# Keyboard and sync reference

## Keyboard

| Action | Result |
| --- | --- |
| Vim movement | Ordinary movement through actual Markdown rows. |
| Cmd+Enter on macOS, Ctrl+Enter elsewhere | Toggle a Google task or marked calendar event. |
| Edit a title, then Escape | Sync the title when Vim enters normal mode. |
| Edit without Vim | Sync after 10 seconds without another edit to that note. |
| Vim `A` / `I` on a synced row | Insert at the end / beginning of the editable title. |
| Vim `o` / `O` on a Google Task | Insert a new task below / above, due on the note's date. |
| Vim `o`, or Enter outside Vim normal mode, on the Google Tasks heading | Insert the first child task, including when the group is empty. |
| Enter on a Google Task outside Vim normal mode | Insert a new task below. |
| Vim `o` / `O`, or Enter, on a calendar event | No action. Calendar rows cannot create new events. |

Vim `dd` and other whole-row deletions remove the row immediately and wait **5 seconds** before deleting it from Google. Native Vim `u` or Cmd+Z during those five seconds restores the row and cancels deletion. Redo starts a fresh five-second window. No confirmation appears.

After five seconds, undo of a **Google Task** creates a new task with the restored title and completion status, original due date, and original task list. The restored row is linked to its new Google ID. If deletion is still pending, creation waits for it to succeed; offline retries and plugin reloads preserve this sequence. Restoring stale Markdown outside native undo never creates a replacement.

For recurring **Calendar events**, deletion affects only the displayed occurrence. Calendar events cannot be recreated from Obsidian after deletion has been sent.

For **Google Tasks**, the plugin deletes the task by ID. Google's public API exposes neither recurrence information nor a delete-all-occurrences option, so the plugin cannot guarantee removal of an entire repeating series. Use Google's own **Delete all** action for that. A task recreated by late undo is a one-off task; the API cannot restore its repeat schedule or native reminder time. See the [Tasks API](https://developers.google.com/workspace/tasks/reference/rest/v1/tasks) and [Google's recurring-task instructions](https://support.google.com/tasks/answer/12132599).

Event time, duration, row identity, and section structure remain protected. Removing a row through an external editor does not delete it from Google and it returns at the next sync. Manage event scheduling and recurrence in Google.

## What appears

- Normal events overlapping the note's day, including multiday and all-day events.
- Events with `⬜️` or `✅` at the beginning of the title appear as checkboxes when **Calendar checkboxes** is enabled. Checking a recurring event changes that occurrence only.
- Unchecked marked events from earlier days when **Overdue calendar tasks** is enabled. No historical cutoff is silently applied; large calendars can take longer on a sync.
- Scheduled Google Tasks due that day, plus unfinished tasks from earlier days when enabled. Unscheduled and future tasks are omitted.
- Both done and undone items scheduled for the note's day. An overdue item you complete in that note stays there so you can see it and undo the checkmark. It is not carried into the next day's note.
- Recurring-calendar durations, with times hidden by default. Enable **Show times in recurring** to display them. Normal events always show their times.

The configured time zone governs event dates and times, including daylight-saving transitions. Google's task due dates are used as dates without time-zone conversion.

## Google Tasks limits

**Google's public Tasks API cannot read or write native task times.** A title such as `📅 13:00 Call Sam` is supported as a literal title, visible in both apps. It does not create a timed Google reminder. A time set in Google's UI cannot be displayed through this API. See the [official task resource reference](https://developers.google.com/workspace/tasks/reference/rest/v1/tasks).

Recurrence is managed in Google. The plugin shows the dated task instances Google exposes through its API; it cannot expand a recurring Google Task into all future occurrences or edit recurrence rules. Calendar recurrence is supported through Google's expanded event instances.

## Sync timing

Opening or creating an enabled note triggers a sync. The default interval is 120 seconds. Checkbox changes sync immediately; title edits sync when Vim returns to normal mode, or after 10 seconds of inactivity without Vim. An edit-triggered sync restarts the interval.

## Conflicts and retries

- An edited title or status in Obsidian wins for that field. Fields you did not edit keep Google's current value.
- A conditional update re-reads once if the remote resource changed during the request. Remaining failures retain the edit for a later automatic retry.
- Multiple local edits to the same item are serialized. The latest staged edit to a field wins.
- A remote deletion wins over stale note content. Explicit native undo of a task deleted through the plugin creates a new linked task.
- Read-only calendars are displayed but cannot be edited.
- A note is updated only if its text still matches what the sync read. Typing during a network request postpones the refresh instead of overwriting your work.
- Failed edits remain in the plugin's durable outbox. The next sync retries them, including after a restart. Do not delete the plugin's `data.json` while it contains pending work.
- New tasks briefly receive a unique reconciliation tag in their Google task notes. Once the Google task ID is saved locally, the plugin removes its exact tag, preserving any description you added. Failed cleanup retries automatically; tags left by older versions are cleaned up too. If a creation response is lost, the plugin searches for the tag first. If the outcome remains unknown, it keeps the draft and displays a waiting status instead of risking a duplicate insertion. An ambiguous creation is not blindly retried. Google's API offers no idempotency key, so a permanently uncertain creation may need inspection in Google.

The status bar uses `GCal: ✓` when up to date, `GCal: ↻` while syncing or waiting, and `GCal: ✕` for a sync problem. It has no tooltip. Opening an enabled note or reconnecting also schedules synchronization.

## Privacy and permissions

Google OAuth tokens and the client secret use Obsidian's local `SecretStorage`, outside the plugin's `data.json`. This is Obsidian-managed storage; the plugin does not make its own encryption guarantee. Do not include secrets or personal note data in bug reports.

The plugin contacts Google's authorization and token endpoints, Calendar API, and Tasks API. It sends selected item IDs, edited titles and status, and new task titles, dates, and reconciliation tags. Other note text and vault filenames are not sent to Google. There is no telemetry and no external server operated by this plugin.

Permissions requested:

- `calendar.calendarlist.readonly` to list calendars and their permissions.
- `calendar.events` to read events, update their titles and checkmarks, and delete individual events or occurrences. The plugin does not create events or delete whole recurring calendar series.
- `tasks` to read, rename, complete, create, and delete tasks.

Disconnect removes the locally stored authorization. To revoke Google's grant as well, use your [Google account connections](https://myaccount.google.com/connections).
