# Review - Opus 5.5 - remarks by Fable 5.1

Read on 2026-09-26 against commit ff020e5. I did not take the review's claims on trust: I reproduced the major ones in an isolated Obsidian 1.13.7 instance with the fixture plugin, in scratch harnesses bundled from `src/`, and by reading the installed Obsidian internals. Line numbers below refer to the current tree.

## Verdict

The review is accurate, and more complete than mine. Its Critical rating for C1 is justified, and H2, M5, M8, L4, L5, L14 and L16 are real findings my review missed. I would keep it and apply the modifications below, mostly additions of two findings it lacks, one corrected description (M5), and a few merges.

## What I confirmed independently

| Finding | Check | Result |
| --- | --- | --- |
| C1 | External file write with a new synced row and a journal paragraph while the note is open | Editor rejected both; `lastSavedData` took the new text while the editor kept the old; a change outside the groups applied normally. In one run the file lost the paragraph within 4 s (a pending 2 s debounced save fired); in another it stayed armed until the next save. Confirmed |
| H1 | Code reading, same as my H2 | Confirmed, including that `load()` fails as a whole on one bad source |
| H2 | Scratch harness: one network failure on the insert, then four runs, then row deletion | Phase stays `sent`; every run only re-lists and never posts; status stays `↻`; after deleting the row the entry remains with `remove: true` forever. Confirmed |
| M4, M7, M8, L4, L5, L12, L17 | Scratch harness | All confirmed. Santiago 2026-09-06 starts at 03:00Z instead of 04:00Z, Havana 2026-03-08 at 04:00Z instead of 05:00Z |
| M5 | Isolated Obsidian, Vim `o`, title, Escape, wait for the Google ID, then `u` three times | Partly confirmed; see modification 2 |
| M2, M3, L3, L7, L14 | Code reading only | Plausible; not executed |
| fromGmail summary edits (H1 trigger) | Google docs | Only state that such events cannot be moved; the summary restriction is unverified |

## Modifications I would make

1. **C1: add the closed-note path and the stale-baseline consequence.** Sync usually delivers a daily note while it is closed on the other device. No `set` transaction is involved then, the file is read from disk, and `stage()` (`src/sync.ts:259-276`) compares it with this device's old snapshot. Reproduced: snapshot `A`, note text `B` rendered by the other device, Google now `C` produces `patch {title: "B"}`, overwriting the newer Google value; when Google still has `B` it costs one GET and one PATCH per changed row. The C1 fix as written ("adopt as baseline or skip staging for that run") only covers the open-note path. Pull before staging, or compare against both the snapshot and the freshly loaded remote value, on every run. I would list it as its own High item (my review, H3) because it survives the C1 fix and is the more common path.

2. **M5: correct the description.** In my run `u` after a linked creation did not stall. It skipped the creation and undid the previous edit instead (the earlier text edit disappeared, the task stayed, nothing was queued), and further presses did nothing because history was exhausted. The creation's history entries are lost when the sync appends the ID and moves the row outside history, so undo can never remove a created task and lands on something older. "All older history is unreachable" is not what happens. The proposed fix (row-level changes, no move of a fresh row) is still the right direction; journaling creation undo explicitly, as deletions already are, is the alternative.

3. **Name the shared mechanism once for M7, L10, L11 and the late calendar undo.** A transaction the filter rejects is rebuilt from the returned specs (`@codemirror/state`, `resolveTransaction`), so its history annotation is dropped and the undo entry is never popped: a blocked undo repeats forever. Stating it once shortens the fix list and explains why silent rejection is worse than it looks.

4. **M7: widen to duplicate section markers.** `regions()` throws on a second `<!-- gdn:tasks -->` (`src/markdown.ts:87`) and `permittedEdit` returns false from its catch (`:195`), so every edit is rejected online or offline, and the sync run fails too, so nothing repairs the note. Reproduced. The fix should fail open when the before state already throws.

5. **Add the `enableNote` corruption.** L12 covers the throwing variant only. An empty frontmatter with a blank line yields `\ngoogle-daily: true---\n\n---`, and `$'`, `` $` ``, `$&` or `$$` inside a property value are interpreted as replacement patterns (`src/markdown.ts:56-58`): `title: cost $' more` became `title: cost \n---\n more\ngoogle-daily: true`. Silent corruption is the worse case (my review, M6).

6. **M1: two additions.** Edits outside the managed groups also trigger the fetch (`src/editor.ts:251`, then `SyncScheduler.normal`), so in Vim every Escape after journaling costs a full pull. And `create()` can skip the lookup entirely for `phase: 'prepared'`, because `beforeInsert` saves `sent` before any POST, which is simpler than `updatedMin`.

7. **H2: mention the documentation.** `docs/behavior.md` currently presents the waiting state as intended ("An ambiguous creation is not blindly retried"), so the fix changes documented behavior and the text must follow.

8. **M2: one addition.** `showAssigned=true` is hard-coded (`src/google.ts:82`), so the assigned-task vector is not something the user can switch off; and the escaping must stay symmetric in `googleTitle()`.

9. **M3: rate as a documentation decision.** The constraint file authorizes occurrence deletion, and Google's semantics apply to any client; what is missing is a sentence in `docs/behavior.md`. `sendUpdates=none` deserves an explicit product decision, not a defect rating.

10. **Severity of L4.** Typing a code fence above the groups is an everyday action and the rejection is silent; I would put it next to M7 rather than in the low list.

11. **Optional additions from my review.** Escape, Ctrl+[ and Ctrl+c are intercepted at window capture in insert mode (`src/editor.ts:107-112`, unverified in the app); expired `connectionTransfer` packages are never removed; disconnect does not revoke at Google; the reconciliation marker carries the device `runtimeOwner` UUID into task notes.

12. **Verification section.** The Obsidian desktop and mobile suites were rerun today at 15:16 and both pass; citing a rerun is stronger than citing existing result files.

## Coverage compared with my review

Absent from mine: C1, H2, M2, M3, M5, M8, L3, L4, L7, L14, L16, L18. Absent from theirs: the stale-baseline push (my H3) and the `enableNote` corruption (my M6). The rest overlaps with matching conclusions. The review contains no en or em dashes and follows the project's style.

## Bottom line

Keep the review. Add the stale-baseline finding as High, rewrite M5, fold the undo mechanism into one paragraph, widen M7, and add the `enableNote` corruption. With those changes it is the document to plan the 0.9.0 fixes from.
