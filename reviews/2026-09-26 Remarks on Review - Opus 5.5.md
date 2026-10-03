# Remarks on the Opus 5.5 review

26 September 2026. Reviewed against the unchanged implementation at `ff020e5`.

**The review is useful, but several proposed fixes need correction before implementation.** I agree with treating C1 as a release blocker. Its split-pane investigation and additional editor cases are valuable. The largest problem is H2: its proposed retry policy would defeat the existing duplicate-prevention safeguard.

## 1. Replace H2's proposed fix

Reference: [H2](<2026-09-26 Review - Opus 5.5.md>).

An empty marker search does **not** prove that an earlier POST failed. The client timeout in [src/main.ts:37](https://github.com/mcaay/obsidian-google-calendar-sync/blob/ff020e5f4554d14167a5974e55d3dc7f54bb63ec/src/main.ts#L37) stops waiting without cancelling the underlying request. That request can finish after the search. A marker can also have been removed. Waiting one minute does not establish either request failure or atomicity between search and insertion. The documented [Tasks insert API](https://developers.google.com/workspace/tasks/reference/rest/v1/tasks/insert) offers no insertion idempotency parameter.

I tested the proposed policy against the production `GoogleClient` with a delayed server outcome: the first POST timed out, the search returned no match, the retried POST succeeded, and the first POST subsequently committed. **Two tasks were created.** This is a controlled counterexample, not a claim about observed Google server timing.

The finding should distinguish a recovery/visibility limitation from an intentional safety rule. “Never resolved” is also too broad: the current code resolves the operation if a later search finds its marker. A deleted uncertain draft already retains deletion intent and will delete the task if reconciliation eventually finds it.

Suggested replacement:

> An uncertain creation can remain unresolved indefinitely when its marker cannot be found. Preserve that uncertainty and expose a useful status. Do not automatically repeat the POST based only on a negative search or elapsed time. Keep cancellation intent durable so a subsequently discovered task can be deleted.

Also add the actual unsafe transition already present: [src/sync.ts:362](https://github.com/mcaay/obsidian-google-calendar-sync/blob/ff020e5f4554d14167a5974e55d3dc7f54bb63ec/src/sync.ts#L362) resets `sent` to `prepared` after any creation-path 4xx, including a failure of the reconciliation GET. Only a definitive rejection of the insertion itself can justify that reset.

## 2. Keep H1, but do not solve it by dropping edits indiscriminately

Reference: [H1](<2026-09-26 Review - Opus 5.5.md>).

The diagnosis is correct. Pulls should continue for unaffected sources while a particular write fails. However, “Google wins, local edit dropped” is a product-policy change, not a necessary technical fix. A non-quota 403 can become recoverable after reconnecting, enabling an API, or restoring permission. A rejected title is still user-authored text worth preserving.

Recommend preserving the failed edit or recoverable draft, distinguishing failures by operation and error reason, and documenting any terminal policy. Never represent an unavailable source as an empty successful result: that would make rendering remove its existing rows. The review correctly mentions preserving those rows; make that an explicit regression requirement.

## 3. Strengthen C1's remedy and separate stale-field propagation

Reference: [C1](<2026-09-26 Review - Opus 5.5.md>).

Allowing legitimate incoming document replacements through the filter addresses the demonstrated content loss. But “adopt them as the baseline, or skip staging for that run” is incomplete:

- Skipping one run does not prevent the next run from treating the same imported difference as a local edit.
- Replacing the entire baseline can hide genuine local edits already present in the document or still awaiting staging.
- Imported title or checkbox changes can already pass the current filter without changing row IDs. They can overwrite newer Google values even before C1 is fixed.

The fix needs explicit distinction between local user edit intent and imported file state. Require tests with an incoming row addition, an unrelated paragraph, a locally edited field, and a newer Google value, including two panes. Keep external disappearance of a row separate from authorized remote deletion.

## 4. Add the missing recovery and multi-device findings

These were reproduced in the earlier [Astra review](<2026-09-26 Review - Astra.md>), with evidence in `output/review-astra/repro-results.json`. They deserve explicit entries rather than being implied by C1 or described as generally sound bookkeeping.

| Missing issue | Why it matters | Suggested severity |
| --- | --- | --- |
| Deletion and undo callbacks do not persist independently of sync | Disconnecting can prevent an accepted undo from being saved. After restart, the previously saved Calendar deletion can still execute. This failure does not require storage exhaustion. | High |
| Late-undo replacement IDs are device-local | Another device sees the original Markdown key, writes to the deleted Google task, receives 404, and loses its edit. | High |
| Both devices can claim an unlinked draft | Before the first device adds an ownership marker, another device can receive the plain row and create a second task with a different reconciliation key. L15's legacy migration case does not cover this normal-use race. | Medium |
| Reconciliation 4xx can reset an uncertain creation | This re-enables a duplicate POST, as discussed above. | Medium |
| Outbox retries depend on an enabled, readable note | Removing or disabling the only relevant note can strand pending requests. Folder renames also leave descendant paths unchanged. | Medium |
| Recovery documentation names the old storage location | Preserving `data.json` no longer backs up the device-local outbox. | Low |

## 5. Split M6 into a high-priority persistence defect and a growth concern

Reference: [M6](<2026-09-26 Review - Opus 5.5.md>).

Silent failure at the persistence boundary compromises deletion recovery and duplicate prevention, so it deserves **High** priority independently of growth. I confirmed it in Obsidian by injecting a storage-write failure: `persist()` resolved while the saved state remained unchanged.

Qualify the quota estimate. In the earlier isolated desktop probe, a device-state write containing about 12 million serialized characters succeeded. The review's generic 5 to 10 MB figure therefore does not establish the installed app's actual threshold. Report measured payload size, observed failure behavior, and platform assumptions separately.

The pruning recommendation needs a correctness condition stronger than age and an empty outbox. I tested removal of a note baseline before an unstaged title edit was synchronized. On the next run, the edit was overwritten by Google's title and no PATCH occurred. Creation mappings and deletion records can also remain necessary for stale rows, late undo, and replacement identity resolution.

Recommend verified persistence first. Define what makes each record safely disposable before adding pruning, and test reopening old notes with offline edits. Do not assume successful marker cleanup alone makes every related identity record expendable.

## 6. Constrain M1's optimizations to preserve correctness

Reference: [M1](<2026-09-26 Review - Opus 5.5.md>).

`fields` masks and shared per-source fetches are good starting points. The remaining proposals need qualifications:

- Refreshing history only daily changes the effective 120-second freshness of overdue items unless incremental updates cover those older items between full refreshes.
- A moving `updatedMin` window can permanently exclude a creation that remains uncertain across a long offline period. Any reconciliation lower bound must cover the original attempt, survive restart, and account for clock differences. A narrowed search still cannot authorize an otherwise unsafe retry.
- Splitting task queries must retain both statuses on the note's date, unfinished overdue tasks, and completed items explicitly retained in that note.
- A retained Google Task currently disables `timeMin` for every calendar. This independently reproduced, unnecessary history fetch is a straightforward optimization worth adding.

For `fields` masks, explicitly preserve pagination tokens, IDs, ETags, and fields used by recurrence-master guards and reconciliation.

## 7. Tighten the security findings and preserve the requested workflow

**M2:** Keep the remote-content finding. External image loading was independently demonstrated in Obsidian with locally intercepted requests. Label iframe behavior and third-party inline-code execution as conditional risks requiring their own reproduction, rather than presenting them as equally verified effects. Escape remote titles consistently across events and tasks; organizer ownership alone is not a useful text-safety boundary. Require reversible literal-text rendering, including existing backslashes and entities, rather than assuming two substitutions cover every case.

**M3:** The documentation gap is useful. Google's [Tasks deletion reference](https://developers.google.com/workspace/tasks/reference/rest/v1/tasks/delete) confirms that deleting an assigned task also deletes its source task. The [Calendar deletion reference](https://developers.google.com/workspace/calendar/api/v3/reference/events/delete) documents notification suppression. Phrase stale external guest copies as a risk of suppressing notifications, not an independently verified outcome for every external calendar client. The current project instructions explicitly authorize row deletion without confirmation, so documentation should be the default recommendation; refusal or new prompts would change that workflow.

**M4:** Raise this to **High** because ordinary note text can be sent to Google without task-creation intent. “Direct-child list items” remains broader than explicit task rows and could capture local explanatory bullets. Preserve the supported plain-line Vim workflow through editor intent, while excluding existing prose, examples, and nested notes.

## 8. Separate observed symptoms from proposed editor fixes

**M5:** Keep the reported undo failure, but retain “likely” for its cause and make the remedy a hypothesis. Two unsuccessful undo attempts do not establish that every older history entry is unreachable in every case. Require a recorded failing transaction and regression cases for undoing the newly created row, undoing an earlier unrelated edit, and redo after synchronization. Smaller diffs are plausible; suppressing sorting alone is not proof of a fix.

**M7:** Allowing unrelated typing despite an existing duplicate is sensible. Also require a safe way to repair the duplicate without deleting the Google item. Removing only the duplicate-set check does not resolve the separate ID-sequence comparison in `permittedEdit()`.

The additional code-fence, empty-frontmatter, IME, and multiline-paste cases are useful additions. They should remain focused regression cases rather than reasons for a broad editor rewrite.

## 9. Adjust evidence wording and repair priority

- Replace the Tasks `If-Match` statement with: “Google's Tasks performance guide discusses ETag/If-Match conditional writes, using generic examples; endpoint behavior was not verified live.” Keep the unresolved endpoint question, but cite the existing [official guidance](https://developers.google.com/workspace/tasks/performance#using-patch-in-a-read-modify-write-cycle). Its generic examples do not substitute for a live endpoint check.
- Change “Checked and sound” to “Controls verified in the tested scenarios.” Unqualified approval of outbox ordering, marker cleanup, and undo conflicts with the persistence and multi-device failures. `SecretStorage` establishes the public API minimum, not compatibility of private editor integrations on Obsidian 1.11.4.
- Promote L5's incorrect day selection and L2's quota handling to Medium. Keep personal preference and maintainability observations, such as L20, separate from confirmed functional defects.
- Add direct links to saved reproduction scripts and results. Preserve the existing distinction between reused harness results, newly run probes, and unverified live behavior.

Recommended order: **C1; reliable persistence and undo journaling; unintended uploads and remote-title rendering; multi-device identity and edit-intent handling; isolated error recovery; date correctness and safe performance improvements.** H2's automatic-retry proposal should be removed before this review is used as an implementation guide.

## Basis of these remarks

I re-read the Opus review, the relevant current source, and the saved evidence from this task's earlier review. I checked the cited Google API documentation and ran two new controlled probes for the proposed H2 retry and M6 baseline pruning. Their source (`output/review-astra/opus-remarks-probes.ts`) and results (`output/review-astra/opus-remarks-results.json`) are saved locally. I did not rerun the full suite or independently repeat Opus's new GUI probes in this pass. The original review and production source were left unchanged.
