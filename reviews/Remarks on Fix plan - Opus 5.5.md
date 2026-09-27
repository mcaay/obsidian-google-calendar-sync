# Remarks on Fix plan - Opus 5.5

Date: 2026-09-26. Reviewed the revised `Fix plan - Opus 5.5.md` against baseline `ff020e5` and the earlier reproductions.

The plan addresses most earlier objections. I would keep its overall direction, but change the eight points below before implementation. D1 to D4 are treated as the user decisions recorded in the plan, including automatic resends and dropping definitively refused edits.

## 1. Persistence failure must stop every affected mutation

[Item 1.8](<Fix plan - Opus 5.5.md>) stops creations and marker cleanup after a failed save. That leaves updates, deletions and cancellation of deletions unspecified.

If native undo restores a row but saving that cancellation fails, a previously persisted deletion can still execute after reload. A visible restored row does not make the cancellation durable.

**Change:** require verified persistence of the corresponding intent before any remote mutation. If cancellation cannot be saved, stop the affected deletion in the current session and report the recovery limitation. Do not acknowledge or discard pending work after an unsuccessful save. Serialize saves and version journal entries so completion of an older request cannot erase a newer edit.

**Test:** fail storage during title edits, checkbox changes, deletion and undo; let the deadline pass and reload. Check both the remote result and the remaining journal. Read-back detects the demonstrated swallowed storage error; it should not be described as a guarantee against every disk or process crash.

## 2. The proposed pruning rules are too aggressive

[Item 1.8](<Fix plan - Opus 5.5.md>) deletes `deletedTasks` and aliases at load, or after 24 hours without an outbox reference. Neither condition proves that they are disposable. Plugin reload need not clear the editor's native history, and restoration intent may exist in the journal before it becomes an outbox operation.

Likewise, 14 days of `created` retention cannot guarantee that a later stale note copy will relink. The plan establishes no maximum delay for another device returning online.

**Change:** distinguish rebuildable snapshots from recovery records. Pruning must account for journal entries, restoration drafts, alias chains, uncertain creations and cancellation records. Keep aliases while surviving native history can reference them. If a time limit intentionally ends recovery, document that limit rather than promising unrestricted relinking.

**Test:** plugin reload followed by native undo/redo, restoration interrupted before enqueueing, and a delayed draft arriving after the proposed retention period.

## 3. Rewriting the key before marker cleanup does not finish the device handoff

[P2 and item 1.4](<Fix plan - Opus 5.5.md>) assume that another device can match the foreign draft through Google's temporary marker. The following order remains possible:

1. Device A creates the task, rewrites its local row and removes Google's marker.
2. Device B receives an older note containing the owned `new:` row before it receives the canonical rewrite.
3. Google returns the canonical task without its marker. B cannot associate the two identities.

A focused probe against the current engine produces two displayed copies in exactly this state. It does not prove that the proposed implementation will fail, but it identifies a case that local write ordering alone cannot solve.

**Change:** specify how a delayed device obtains the creation-ID-to-task-ID mapping after marker cleanup. A portable, non-executable identity record is one option. Do not depend on delivery order across Google and Obsidian Sync, or match by title.

**Test:** remove the marker before B opens the stale draft, then edit on B before the canonical rewrite arrives. Require no extra POST, no persistent duplicate row and preservation of the local edit.

## 4. Make the creation tests consistent with the chosen resend policy

[Item 2.3 and its tests](<Fix plan - Opus 5.5.md>) acknowledge the duplicate risk, yet require the timed-out insert that commits late to be linked instead of duplicated.

Those statements need qualification. A local timeout or plugin reload does not establish that Google has finished the original POST. Under D3, the original request can commit after the successful negative lookup and the resend. Waiting two minutes reduces risk; it cannot eliminate this ordering.

**Change:** keep D3, but separate the acceptance cases. A task committed before the recovery lookup must be linked. A task committed after the resend is the residual duplicate case. Specify what happens if later searches find multiple exact creation-marker matches. Preserve the same creation identity across attempts, the retry deadline and durable cancellation intent. A cancelled uncertain creation must never be resent, and its recovery record must survive long enough to handle a late match.

The test should expose the remaining limitation or verify an explicitly designed reconciliation rule. It must not claim unconditional duplicate prevention.

## 5. Correct the reason for excluding account binding

[The account-binding exclusion](<Fix plan - Opus 5.5.md>) says another account returns 404. That is not generally true: two accounts can both write the same shared calendar. Google's [calendar-sharing documentation](https://developers.google.com/workspace/calendar/api/concepts/sharing) explicitly supports granting multiple users write access.

A mocked transport probe confirms that the current client performs GET and PATCH with the replacement account's token and the queued calendar/event IDs. There is no local account check. The mock demonstrates client behavior, not a live Google result.

**Change:** either bind pending work to its account and suspend it on an unverified account change, or explicitly accept that queued work may execute through a different account with access to the same target. Do not dismiss the issue as guaranteed 404 handling. Test a shared calendar writable by both accounts.

## 6. Qualify “The pull always runs”

[Item 2.1](<Fix plan - Opus 5.5.md>) should preserve progress after an item refusal, but unconditional pulling conflicts with quota backoff and stopping retries after `invalid_grant` in 2.5 and 2.6.

**Change:** continue independent work and readable sources, while honoring the relevant account/API cooldown or authorization stop. A refusal should acknowledge only the journal revision actually sent; an edit made while the request was in flight remains pending.

**Test:** an item refusal allows unrelated pulls; an authorization failure or active quota cooldown does not trigger more affected requests; a newer local edit survives rejection of the older one.

## 7. Fix the undo wording and release dependencies

[Item 3.2](<Fix plan - Opus 5.5.md>) currently describes blocking all older history as the outcome of its proposed fix. Rewrite it around the required behavior: late Calendar undo leaves history traversable, and subsequent undo/redo still reaches unrelated edits. Choose the transaction handling after recording the actual failing history sequence.

[The release gate](<Fix plan - Opus 5.5.md>) excludes Phase 3 even though Phase 1 changes draft insertion, canonical keys and aliases. Those changes depend on correct native undo. Minimal line diffs can help, but do not by themselves prove history correctness.

**Change:** make creation undo, late Calendar undo, duplicate repair and their interaction with the new identities release requirements. Include the behavior documentation and correct test discovery. Run the physical iPhone/Mac cross-device acceptance check before release, rather than afterward. Performance work and CI setup can remain separately scheduled.

## 8. Specify cache correctness before implementing the optimization

[Item 4.3](<Fix plan - Opus 5.5.md>) sketches a useful optimization, but request parameters and request counts are insufficient acceptance tests for a cache that controls which rows exist.

**Change:** define invalidation and removal rules for deleted, completed, unmarked and rescheduled events; recurring-series edits; midnight rollover; different note dates; and changed calendar/time-zone settings. Advance the refresh watermark only after all pages succeed, and specify overlap at its boundary. Verify the proposed expanded-recurring-event behavior before relying on it.

**Test:** compare the incremental result with a fresh full scan after each transition, including an interrupted paginated refresh and an offline interval. Measure request reduction only after these results agree.

## Scope and evidence

The correction about in-app folder renames appropriately narrows A-12; I would not repeat the earlier folder-rename allegation. The independent drain still addresses closed, disabled, deleted and externally renamed notes.

For these remarks I read the revised plan, checked the relevant implementation and ran two additional mocked probes. Their source and results are in `output/review-astra/fix-plan-probes.ts` and `output/review-astra/fix-plan-results.json`. Earlier project verification is recorded in `Review - Astra.md`. No production code, original plan, personal notes or live Google data were changed. These remarks assess a proposed design; they do not certify fixes that have not yet been implemented.
