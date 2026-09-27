# Fix plan - Opus 5.5

Date: 2026-09-26. Baseline: `ff020e5` (v0.9.0, unreleased). Sources: `Review - Opus 5.5.md` (O), `Review - Fable 5.1.md` (F) and `Review - Astra.md` (A). Revised the same day after the remarks on O by Fable (`Review - Opus 5.5 - remarks by Fable 5.1.md`, FR) and Astra (`Remarks on Review - Opus 5.5.md`, AR), and again after their remarks on this plan (`Fix plan - Opus 5.5 - remarks by Fable 5.1.md`, FP, and `Remarks on Fix plan - Opus 5.5.md`, AP). IDs such as O-C1, F-H3, A-7, AR-1 or FP-2 refer to their findings or numbered remarks.

## Decisions

| # | Topic | Decision | By |
| --- | --- | --- | --- |
| D1 | What a device pushes | Only edits made in Obsidian on that device: typing, toggles, deletions, undo and redo in the editor, and reading-view checkbox clicks. Anything else that changes the file (Sync, other apps, git, other plugins writing the file) is display state and is refreshed from Google. | You |
| D2 | Edits Google refuses | Google wins: the edit is dropped, the row shows Google's value again, and you are told. A refused new task stays as a local row and is retried only after you edit it. | You |
| D3 | Lost task sends | Search again after at least 2 minutes. If a successful search does not find the task, send it again. Deleting the row cancels. | You |
| D4 | Visibility | The Mac status shows the reason on hover. Problems that need action also show a one-time notice on both devices. | You |
| D5 | Tasks group | Only `- [ ]` and `- [x]` rows directly under the group heading become Google Tasks. Plain text, other bullets, nested lines and code blocks stay local and untouched. The plugin's own `o`, `O` and Enter already create checkbox rows. | Me |
| D6 | Deleting shared items | Row deletion keeps its current behavior, which the project rules authorize without confirmation. Deleting a meeting you organize cancels it for all guests without notification emails, so guests outside Google may keep a stale copy. Deleting a task assigned from Docs or Chat also deletes the original there. Title and ✅/⬜️ edits on meetings you organize are visible to guests. All of this is documented, not blocked. | You |
| D7 | Remote titles | Reversibly escape HTML, image and note embeds, and inline code in titles from Google, and unescape when pushing. Links and emphasis keep working. | Me |
| D8 | Overdue history | Keep the documented unlimited history, but fetch it incrementally instead of downloading everything on every sync. | Me |
| D9 | Vim `C`, `D`, `cc`, `S` | On synced rows they act on the editable title only, keeping the checkbox, event prefix and hidden ID. | Me |
| D10 | Group structure | Adding groups is allowed, for example template insertion into an enabled note. Removing a group stays blocked, with a notice explaining `google-daily: false`, except by undo or redo (3.2). A note with duplicate markers stays editable so it can be repaired. | Me |
| D11 | Closed, deleted or disabled notes | Pending work that was already authorized still completes. | Me |
| D12 | Undo of a Calendar deletion after 5 seconds | Undo is never blocked. The row disappears again at the next render, with a notice that events cannot be restored. | Me |
| D13 | Row order | Events stay chronological. Tasks keep their order in the note, and new tasks from Google are inserted at their sorted position. Renders change only lines that differ, which keeps native undo working. | Me |
| D14 | Disconnect | Still does not revoke access at Google, because the phone uses the same authorization. Documented. | Me |

## Found while planning

- **P1.** Retention of checked overdue rows is device-local since 0.9.0. Under D1 the two devices would disagree about which rows belong in a note and keep rewriting each other's version. Retention must follow the note itself: a checked overdue row that is in the note stays.
- **P2.** While a new task's `new:` key is being replaced, another device can still hold the old `new:` row. The owner replaces the key first, then removes the creation marker right away, as today. While the marker exists, including during an uncertain creation, other devices relink a foreign draft by it when exactly one task carries it: they rewrite the row and push their journaled edits to the task. A device that sees the stale row only after the marker is gone shows the task twice until Sync delivers the rewrite, and an edit made on that stale row is lost (Astra's probe for AP-3). Keeping the marker longer would close this gap but clutters Google Tasks, so the gap is accepted and documented.
- **Not an issue:** Obsidian emits a rename event for every file inside a folder renamed in the app (verified in `app.js`). Only renames made outside Obsidian need the independent outbox drain in 2.4 (A-12).

## Phase 1. Note content and edit intent (blocks the 0.9.0 release)

1.1 **Accept external changes.** Let `userEvent: "set"` transactions through the editor filter. They never count as deletions or restorations. `Controller.read()` stops forcing `view.save()` on every run: the editor text is enough, and the plugin saves only after its own writes. [O-C1, A-1, FP-5]

1.2 **Edit journal (D1).** `stage()` pushes only journal entries, and any other row difference becomes the new baseline without a request. Lands together with 1.1. [F-H3, A-6, A-4]

- A local edit is any transaction in this device's editor that is neither `userEvent: "set"` nor the plugin's own `fromSync`. Do not whitelist `input`: Vim, IME input and other plugins' editor commands must count. Verify that another plugin's `Editor.setValue()` arrives as `set`. [FP-7]
- A Reading-view checkbox click marks its note, and the single checkbox flip that reaches the file within a second counts as local, whether it arrives as a `modify` event or as a `set` transaction in another pane. Any other file change is external. [FP-4]
- The journal records title and done values per row, locally created drafts, deletions and undo decisions. It lives in its own small localStorage key written on every change; the large device state is saved after runs. [FP-8]
- Entries carry a revision, so a finished or refused request clears only the revision it sent, and a newer edit stays pending. [AP-1, AP-6]

1.3 **Retention from the note** (P1).

1.4 **Draft ownership.** `o`, `O` and Enter insert the owned `new:` marker in the same undo step as the new row. Other checkbox rows are claimed only when a local edit (1.2) other than undo or redo produces them. Drafts that arrive from elsewhere stay local rows. The owner creates a draft from the row's current text, including edits another device made before the creation. Also fixes P2. [A-7, AP-3]

1.5 **Tasks group rule** (D5), including fenced blocks. [O-M4, F-M4, A-3]

1.6 **Portable identity after late undo.** Once the replacement task exists, rewrite the row to the new task's key, and keep a local alias so native undo and redo still map. It stays in the release: without it, the two devices rewrite the row's key back and forth whenever both render that note after a late undo, not only during concurrent edits. [A-5, FP-14]

1.7 **Verified saves.** Read every save back. While saves fail, send no Google write, drop no pending work, and show a notice that an undone deletion may still run after a restart. Pruning moves to 4.8. [O-M6, F-M2, A-2, AP-1, FP-14]

1.8 **`enableNote()`**: splice by index instead of `String.replace`, and handle empty frontmatter. [F-M6, O-L12]

1.9 **Migration.** A versioned upgrade of stored state, from v1 `data.json` (0.8.2) and v2 device state (0.9.0 builds): `sent` creations become `uncertain` with the D3 clock started at load, `notes[].retained` is dropped in favor of 1.3, `restoredKey` becomes a 1.6 alias, and a record that cannot be migrated is dropped with a notice naming it instead of breaking the load. [FP-3]

Tests: an Obsidian harness case that writes one new row and one paragraph into the open note, where both survive and nothing is pushed; the same note in two panes converges; a run with nothing to change writes no file [FP-5]; a title edited locally just before an external write is still pushed [AR-3]; another plugin's editor command counts as local [FP-7]; a Reading-view click is pushed, alone and with the note also open in Live Preview, while the same flip delivered without a click is not [FP-4]; engine-level two-device tests for a stale refresh, a simultaneous unlinked draft, late-undo identity and retention; a foreign draft relinked by marker during an uncertain creation, with an edit made on the second device, which must cause no POST and reach the task; the same stale row seen after the marker is gone, which must cause no POST and leave no lasting duplicate [AP-3]; deletion and undo saved while disconnected; storage failures injected into `localStorage` itself during title edits, checkbox changes, deletion and undo, then the deadline passes and the app reloads, checking both Google and the remaining journal [AP-1]; upgrades from a 0.8.2 `data.json` and from 0.9.0 device state with pending work of each kind [FP-3]; tasks group rules; `enableNote()` cases.

## Phase 2. Sync keeps working after failures (blocks the 0.9.0 release)

2.1 **Per-operation outcomes.** Refusals of that item follow D2: 400, a 403 that concerns only that item, such as a write to a read-only calendar, 404 on creation, and the series-master guard. Which 403 reasons count as item-level, including what a summary edit on an invitation returns, is taken from the live check. The notice shows the refused value, so typed text is not lost. Account-level 403s, such as a disabled API (`accessNotConfigured`) or a missing permission (`insufficientPermissions`), are not refusals: the work stays queued and the D4 notice names the fix. Transient ones stay queued with backoff: network errors, 5xx, 429 and quota 403. A refusal never stops pulls or unrelated work, but an active backoff (2.5) or a dead authorization (2.6) pauses every request it affects. [O-H1, F-H2, A-9, F-L7, AR-2, FP-15, AP-6]

2.2 **Unreadable sources.** A calendar or list that cannot be read is skipped, its current rows are kept, and the notice names it. [O-H1]

2.3 **Creation state machine**: `prepared`, `sending`, `uncertain`, `created`, `refused`. Only a definitive answer to the POST changes state, lookup errors never downgrade `uncertain`, and every attempt reuses the same key and marker. D3 governs resends. A POST that timed out in the plugin is not cancelled and can still reach Google after a negative lookup (AR-1 reproduced the duplicate), so D3 gets these safeguards, which reduce the risk but cannot remove it. [O-H2, A-8, AR-1, AR-6, AP-4]

- The transport keeps the `requestUrl` promise that the 30-second timeout abandons; the timeout only changes the status. D3's 2 minutes start when that promise settles, or when the plugin loads again. [FP-10]
- The lookup includes completed, hidden and deleted tasks, with `updatedMin` at the saved time of the first attempt minus one day for clock differences. A task found deleted is linked, not sent again.
- If a lookup finds several tasks with the marker, one is linked and the others become ordinary tasks, with their markers removed too, so a residual duplicate shows in the note and can be deleted.
- Deleting the row cancels the creation for good: it is never resent, and its record lasts until a lookup after the D3 wait settles it, deleting the task if found.

2.4 **Independent outbox drain.** The outbox is flushed on its own schedule, regardless of which notes are open or enabled (D11). [A-12]

2.5 **Error handling.** Keep Google's error reason. Back off on 429 and quota 403, honoring `Retry-After` up to a cap. Refresh OAuth only after a 401. Read the status even when the body is not JSON. [O-L1, O-L2, F-L4, A-13]

2.6 **Dead authorization.** After `invalid_grant`, stop retrying and show "Reconnect needed" once. [F-L2]

2.7 **Visibility (D4).** Status tooltip, one-time notices, and a final status after every run, including "Not connected". The tooltip also names task rows waiting for another device to create them, so a draft orphaned by lost device state is visible. [O-L8, F-M5, F-L5, O-L9, O-L16, FP-6]

Tests: refused, account-level and transient outcomes for each operation type; a refusal does not block pulls or unrelated work, while an active backoff or a dead authorization sends nothing further [AP-6]; a newer local edit survives the refusal of an older one; a skipped source keeps its rows; creation state transitions, including lookup failures and resend timing; the AR-1 probe with the original request settling late, split into a task committed before the recovery lookup, which is linked, and one committed after the resend, the documented residual [AP-4]; several tasks with one marker; a cancelled uncertain creation is never resent and a late match is deleted; a deleted lookup match is not resent; the 2 minutes start when the abandoned request settles [FP-10]; a drain with no open note; error parsing for JSON, HTML, quota reasons and `Retry-After`; token refresh only after 401.

## Phase 3. Editor behavior (3.1 to 3.4 block the 0.9.0 release)

3.1 **Undo after creating a task** removes the whole row, including its hidden ID, and deletes the task after the normal 5-second grace. Today it skips the creation and reverts an older edit, because sync changes to the new row happen outside undo history. Record the failing transaction first to confirm the cause. Then use minimal line-level render changes plus D13 ordering, or, if that is not enough, journal creation undo explicitly, as deletions are. [O-M5, FR-2, AR-8]

3.2 **Undo and redo always apply** (D12). Required behavior: after a late Calendar undo, further undo and redo still reach unrelated edits. Undo and redo take precedence over D10 and 3.3. They change Google only through whole rows they remove or restore, and rows removed together with their group heading, as when undoing a template insertion, are not deletions. A duplicate they leave behind is collapsed by the next render. Record the failing history sequence before choosing the transaction handling: a transaction the filter rejects loses its history annotation, so a rejected undo is never popped. [F-M1, FR-3, FP-1, AP-7]

3.3 Duplicate row IDs block only edits that add duplicates, except undo and redo (3.2). Removing one copy of a duplicated row is allowed and deletes nothing in Google. Duplicate or nested markers no longer freeze the note. D10 for groups. [O-M7, F-M1, O-L11, FR-4, AR-8]

3.4 **Pasted rows.** Today Vim `p` of a synced row is silently rejected, so `ddp` deletes the task. A task row that a local edit other than undo or redo brings in with an existing hidden ID gets a new draft key in the same transaction and becomes a new task due on the note's date. So `ddp` deletes the original after its 5-second grace and creates the pasted task; `yyp` or a paste into another day's note creates a new task too. Google-only data such as recurrence is not carried over; undo keeps the original. Events are never created from the note, so pasting a calendar row is rejected with a notice that undo within 5 seconds keeps the event. [FP-2]

3.5 Allow edits that temporarily hide the groups inside an unclosed code fence, as long as every row still exists. [O-L4]

3.6 D9, by clamping deletions to the title range. [O-L10]

3.7 A rate-limited notice when an edit is blocked.

3.8 Remove the global Escape interception if `vim-mode-change` already covers title syncing. Ignore keys during IME composition, guard parsing in key handling, and use the configured tab width. [F-L1, O-L14, F-L11]

3.9 **Split guard.** Reject a user edit that inserts a line break between a synced row's start and its hidden ID, and show a notice. The plugin's own Enter already adds new rows below. Moved from Phase 1: it creates a wrong task, but loses no data. [O-M8, FP-14]

Tests in the Obsidian harness: undo after creating a task, then undo of an earlier unrelated edit, then redo after a sync; late Calendar undo followed by further undo and redo; template insertion and its undo, which deletes nothing in Google; removing a duplicated row and undoing that; `ddp` and `yyp` on a task, a task row pasted into another day's note, and `ddp` on an event; duplicate markers; a code fence above the groups; `C`/`D`/`cc`/`S`; Escape with a suggestion popup open; the split guard.

## Phase 4. Request volume, storage and CPU (4.2, 4.4 and 4.5 block the 0.9.0 release)

4.1 `fields` masks on every Google read, keeping what later steps use: page tokens, ETags, the recurrence fields of the series guard, and task notes for the creation lookup and relinking (P2). [AR-6]

4.2 Tasks: the note's day with completed tasks, earlier days with unfinished tasks only, and retained tasks by ID.

4.3 **Calendar overdue (D8).** A device-local cache of past unchecked marked events, so a sync no longer downloads the whole history. Retained events are fetched by ID, and retained tasks no longer force calendar history. [O-M1, F-H1, A]

- Choose between a `syncToken` and an `updatedMin` watermark after the live check. A sync token transfers only changes and answers 410 when a full resync is due, but cannot be combined with `timeMax`, so its first sync also expands future recurring instances. An `updatedMin` watermark comes from the largest `updated` value seen, never the device clock, advances only after every page succeeded, and overlaps its boundary. [FP-11, AP-8]
- The cache must equal a fresh full scan: define removal for deleted, completed, unmarked and rescheduled events, series edits, midnight rollover, other note dates, and calendar or time-zone setting changes. [AP-8]

4.4 `create()` skips the lookup for drafts that were never sent. [F-H1]

4.5 Only edits touching synced rows or drafts mark a note for sync, edit-triggered runs with nothing staged skip the pull, and the metadata listener reacts only to daily notes. [F-M3, O-L13]

4.6 Compute day bounds once per load, cache time-zone formatters, and index the outbox and undo lookups. [A, O-L19]

4.7 Limit the sync interval to 30 seconds through 24 hours. [O-L3]

4.8 **Pruning device state**, moved from Phase 1 and limited to records that are provably disposable. The limits are documented when it lands. [O-M6, F-M2, AR-5, AP-2, FP-9]

- A note snapshot once no outbox, journal or deletion entry refers to the note, and the note no longer exists or was not synced for 14 days. Under D1 a missing snapshot pushes nothing.
- Deletion records and 1.6 aliases once their note is open in no editor, since native history ends with the editor, and no outbox, journal or uncertain creation refers to them. A plugin reload keeps editor history, so load time alone proves nothing; verify that a restart or a note switch clears it.
- A `created` entry 14 days after its marker was removed, when nothing refers to it. An older stale copy of the note is then no longer relinked on this device.

Tests: request URLs and parameters; for 4.3, the cache equals a fresh full scan after each transition above, including an interrupted paginated refresh and an offline interval, before any request count is measured; pruning with a plugin reload followed by native undo and redo, a restoration interrupted before it is queued, reopening a pruned old note with an offline edit, and a stale draft arriving after the retention period; the interval limits.

## Phase 5. Security, dates and sign-in (5.1 blocks the 0.9.0 release)

5.1 D7 title escaping for events and tasks alike. Note text is Markdown and Google titles are plain text: pushing undoes only the escape sequences the plugin produces, so other backslashes reach Google unchanged. Checked in Live Preview and Reading view with the network intercepted, so no remote request is made. It is small, and until it lands anyone who can invite you can make your notes load remote content. [O-M2, A-10, AR-7, FP-12]

5.2 Correct day start where local midnight does not exist. [O-L5, A-11]

5.3 Sign-in: a new connect attempt replaces a pending one instead of failing for 30 minutes; missing granted scopes are reported by name; SecretStorage errors are shown; the client ID is saved on change rather than on every keystroke; expired setup packages are removed. [O-L6, O-L7, F-L6, F-L8]

Tests: escaping round trip, including titles that already contain backslashes or HTML entities [AR-7]; America/Santiago and America/Havana day boundaries; connect restart; scope check.

## Phase 6. Tests, documentation, tooling (6.1 and 6.2 block the 0.9.0 release)

6.1 Vitest `include: ['tests/**/*.test.ts']`. [O-L17, F-M7, A-14]

6.2 Documentation: where pending work lives and how to remove it; the D1 to D14 rules, including D6's effects on other people, the remaining duplicate risk under D3, and that synced rows edited outside Obsidian's editor get Google's values back at the next render [FP-16]; the stale-row gap in P2; queued work after an account switch (AP-5); replacing the `docs/behavior.md` passage that presents an unconfirmed creation as intentionally never retried [FR-7]; and "iPhone verified, Android untested" in the README. [F-L9, A-15, O-L18]

6.3 A CI workflow running lint, typecheck, unit tests and build, plus a type configuration for `src` without Node globals. [F-L10]

6.4 Every reproduction from the reviews and all remarks becomes a regression test at its actual boundary.

## Not changing

- Revoking access on Disconnect (F-L12): it would also disconnect the phone (D14).
- Two desktops migrating a version 1 outbox (O-L15, F-L3): a one-time upgrade race, already past for your devices.
- The device UUID inside the temporary creation marker (F-L13): it is random and removed right after creation.
- Keeping the creation marker in Google until every device has relinked (AP-3): it clutters the task's notes in Google Tasks. P2 documents the gap instead.
- Binding pending work to a Google account (A limits, AP-5): after an account switch, queued work runs through the new account wherever it has access, for example a shared calendar both accounts can write, and is refused elsewhere (D2). It is still the edit you made, so this is accepted and documented, not prevented.
- Consolidating the deletion bookkeeping (O-L20): only where Phase 1 already touches it.
- Suggestions not adopted: a fixed overdue window or `q=⬜` search (F-H1), because D8 keeps unlimited history and emoji search is unverified; pulling before staging (F-H3, FR-1), superseded by the journal (1.2) [FP-17]; never resending an unconfirmed task (AR-1), because you chose D3 and the project rules exclude a manual retry, so 2.3 adds safeguards instead; keeping refused edits queued (AR-2), because you chose D2, which 2.1 now limits to refusals of the item itself.

## Verification and release

- Each phase: `npm run check`, `npm run test:obsidian`, `npm run test:mobile`, plus its new tests.
- Live checks on a dedicated test calendar and task list, not personal data: refused edits (a Gmail-generated event, a read-only calendar, a summary edit on an invitation), the 403 reasons for a disabled API and a missing permission, what deleting a received invitation and a meeting you organize shows other people, whether Tasks honors `If-Match`, whether `showDeleted` returns a task deleted in Google, `updatedMin` and `syncToken` with expanded recurring events, and parent task deletion.
- Release 0.9.0 only after Phases 1 and 2, items 3.1 to 3.4, 4.2, 4.4, 4.5, 5.1, 6.1 and 6.2, and a check on the physical iPhone and Mac before the release: edit on the phone while the note is open on the Mac, and the reverse. [FP-13, AP-7]
- Before deciding on 4.3, measure a day of phone use with 4.2, 4.4 and 4.5 in place. If calendar history still dominates, 4.3 joins the release. [FP-13]
