# Fix plan - Opus 5.5 - remarks by Fable 5.1

Read on 2026-09-26, the revision that already includes FR and AR. Basis: my review, my reproductions of O-C1, O-H2 and O-M5 in an isolated Obsidian 1.13.7, Obsidian's `app.js`, and Google's `events.list` and `tasks.list` references.

## Verdict

The plan is sound. D1 to D14 stay inside the project rules (no confirmations, no manual sync, deletion authority only from explicit editor deletions), every finding from the three reviews and both remark sets is mapped, and the release gate removes both data-loss paths. Before work starts it needs two contradictions resolved, a migration item, and a handful of implementation details pinned down. The gate should also take three cheap Phase 4 items.

## Contradictions to resolve

1. **3.2 against D10 and 3.3.** "Undo and redo are never dropped" conflicts with "removing a group stays blocked" and "duplicates block only edits that add duplicates". Undoing a template insertion removes a group; undoing the removal of a duplicated copy re-adds a duplicate. Either exempt undo and redo from both rules and let the next render repair the note, or the undo wall from F-M1 returns. Write the precedence down.
2. **D13 against the ID-order check.** "Tasks keep their order in the note" invites `dd` then `p` to move a task. Today `dd` journals a deletion and `p` is rejected, because the key reappears in an event that is not undo or redo. Define a move: a key that disappears and reappears within the grace period cancels the pending deletion. Otherwise keep the order check for tasks and say that order is Google's.

## Missing items

3. **Migration.** The plan changes every stored format (journal, aliases, creation states, retention derived from the note) but has no migration item. 0.8.2 users carry v1 `data.json` outboxes with `create.phase` `prepared` or `sent` and `deletedTasks` records; your own devices carry v2 localStorage state. Add a versioned step: `sent` becomes `uncertain` with the D3 clock started at load, `notes[].retained` is dropped in favor of 1.3, `restoredKey` becomes a 1.7 alias, and unknown records are discarded instead of crashing `restoreDeviceState()`.
4. **Reading view rule.** Under D1 a `modify` event while the note is open in Reading view is the only signal for a checkbox click, and it is indistinguishable from a Sync-delivered file whose only difference is that checkbox. State the rule (a lone checkbox flip on a synced row counts as local, anything else is external) and document the residual: a flip that arrived from the other device is pushed again, a no-op unless Google changed in between.
5. **Forced saves.** `Controller.read()` calls `view.save()` for every open Markdown view on every run. After 1.1 it no longer overwrites external text, but it still writes files Obsidian would not have written, and a pending save is what turned the rejected version into an immediate overwrite in my probe. Under 1.2 the plugin only needs the editor text; save only before its own `vault.process` write to a note without a view.
6. **Orphaned drafts (O-L16).** 1.4 keeps foreign drafts as local rows, but an own draft becomes foreign after local state loss and stays a silent `new:` row forever. Strip a marker no device claims after some days, or name the row in the 2.7 notice.

## Details that decide whether Phase 1 works

7. **What counts as a local edit (1.1, 1.2).** Define it as any transaction in this editor that is neither `userEvent: "set"` nor `fromSync`. Do not whitelist `input`: the Vim adapter dispatches `input.type.compose`, Obsidian's own bulk writes use `set` (two sites in `app.js`), and other plugins' `replaceRange` calls may carry no tag at all. The Tasks plugin toggle that the harness optionally covers must still count as a local edit. Verify that `Editor.setValue()` from another plugin arrives as `set` before relying on it.
8. **"Saved immediately" (1.2).** `persist()` clones and stringifies the whole device state on every call, and 1.8's read-back doubles that. A journal written on every keystroke through that path is jank on a phone. Keep the journal in its own small localStorage key, write it on each change, and save the large snapshot only after runs.
9. **Pruning `deletedTasks` at load (1.8)** is harmless only if Obsidian does not restore editor history after a restart. Verify that, because a 24 h prune while running would otherwise break a same-day late undo.
10. **"Once the original request has ended on this device" (2.3, D3)** is implementable only if the transport keeps the abandoned `requestUrl` promise and awaits it before the two minutes start. Today the race drops it. Keep the 30 s timeout as a status signal only. After a reload the promise is gone, which the plan already treats as ended.
11. **Incremental calendar history (4.3).** Consider `syncToken` instead of a self-managed `updatedMin` cache. Google forbids `orderBy`, `timeMin`, `timeMax`, `q` and `updatedMin` with a sync token but not `singleEvents`. The initial sync is the full scan the plan already does once a day; afterwards each sync transfers only changes, cancellations arrive as `cancelled` instances, and a 410 means one full resync. That removes the daily multi-megabyte rescan on the phone and the clock-skew question. If `updatedMin` stays, derive it from the largest `updated` value seen, never from the device clock.
12. **Escaping (5.1)** must be undone in `googleTitle()` only for sequences the plugin produced; a backslash the user typed in Obsidian must reach Google unchanged. The AR-7 round-trip test covers this, keep it.

## Release gate

13. **Move 4.2, 4.4 and 4.5 into the gate.** They are small, and without them the phone still downloads every completed task ever on every sync, lists the whole task list before every insert, and pulls after every Escape in Vim. 4.3 is the only large Phase 4 item; measure a day of phone use before deciding whether it can wait.
14. **Consider deferring 1.6, 1.7 and the pruning half of 1.8.** None of them loses data on the tested paths, and 1.7 only matters when one device late-undoes a deletion that the other device is editing at the same time. The verified-save half of 1.8 stays in the gate.

## Smaller remarks

15. 2.1 lists `forbiddenForNonOrganizer` as an item refusal. Google documents it for the `guestsCan*` properties; whether a summary edit on an invitation is refused is unknown, so classify it after the live check, not before.
16. 6.2 should also state D1's consequence for text edited outside Obsidian: the edit is discarded at the next render, with the 2.7 notice as the only trace.
17. "Not changing" rejects pull-before-stage because of A-6. Comparing against both the snapshot and the remote value would stop that case too, but the point is moot once 1.2 exists.
18. The plan has no en or em dashes and reads well. A rough effort estimate per phase would make 13 and 14 easier to decide.

## Bottom line

Fix items 1 to 3 in the plan text, decide 13 and 14, and treat 7, 8 and 10 as acceptance criteria for Phase 1 and 2. Everything else is fine to leave as written.
