# Project review

Reviewed on 26 September 2026. Baseline: `ff020e5`, version `0.9.0`.

**The implementation is not fully correct or secure yet.** The normal workflows have good test coverage, but targeted checks exposed note-content loss, unreliable persistence, unintended uploads, and failures when multiple devices synchronize. Fix the P1 findings before relying on the new mobile workflow for important data.

This review covers all production modules, tests, integration harnesses, build and package configuration, styles, templates, and documentation. No production source was changed. The pre-existing untracked `CLAUDE.md` was left untouched.

P1 means potential data loss, unintended disclosure, or an incorrect destructive operation. P2 means a significant correctness, security, or recovery defect. P3 means a tooling or documentation issue.

## Findings

### 1. P1: Incoming file changes can be overwritten, including unrelated note text

Locations: [src/editor.ts:159](https://github.com/mcaay/obsidian-google-calendar-sync/blob/ff020e5f4554d14167a5974e55d3dc7f54bb63ec/src/editor.ts#L159), [src/markdown.ts:164](https://github.com/mcaay/obsidian-google-calendar-sync/blob/ff020e5f4554d14167a5974e55d3dc7f54bb63ec/src/markdown.ts#L164), [src/controller.ts:60](https://github.com/mcaay/obsidian-google-calendar-sync/blob/ff020e5f4554d14167a5974e55d3dc7f54bb63ec/src/controller.ts#L60).

The transaction filter protects row identities on every document change except `fromSync`. An incoming file update containing another device's new row is therefore rejected by `permittedEdit()`. The editor retains the old document even though the new document reached disk. `Controller.read()` then calls `view.save()` before reading, writing the stale editor document over the external change. The later compare-and-swap cannot protect content already overwritten by this read.

**Reproduced in Obsidian 1.13.7:** externally wrote a task with `gdn:new:other:example` and an unrelated paragraph outside the groups. Disk contained both; the editor rejected the update. After `engine.run()`, both the task and the unrelated paragraph were gone.

**Fix:** distinguish native user edits from incoming vault changes. Allow legitimate external document updates without treating missing rows as authorized deletions. Reconcile editor and disk versions before saving during a read. Add a live integration test preserving both incoming rows and unrelated paragraphs.

### 2. P1: Device-state persistence can fail silently while Google writes continue

Locations: [src/main.ts:71](https://github.com/mcaay/obsidian-google-calendar-sync/blob/ff020e5f4554d14167a5974e55d3dc7f54bb63ec/src/main.ts#L71), [src/device-state.ts:33](https://github.com/mcaay/obsidian-google-calendar-sync/blob/ff020e5f4554d14167a5974e55d3dc7f54bb63ec/src/device-state.ts#L33), [src/sync.ts:318](https://github.com/mcaay/obsidian-google-calendar-sync/blob/ff020e5f4554d14167a5974e55d3dc7f54bb63ec/src/sync.ts#L318), [src/sync.ts:374](https://github.com/mcaay/obsidian-google-calendar-sync/blob/ff020e5f4554d14167a5974e55d3dc7f54bb63ec/src/sync.ts#L374).

`persist()` assumes `app.saveLocalStorage()` reports storage failures. In the installed Obsidian implementation, that API wraps `localStorage.setItem()` in an empty `catch`. Its return does not establish that the outbox or created Google ID was saved. Nevertheless, synchronization proceeds with task insertion and reconciliation-marker removal.

**Reproduced in the real app with controlled fault injection:** made the underlying device-state write throw `QuotaExceededError`. `plugin.persist()` resolved successfully; memory contained 366 note records and storage still contained one. This tests failure handling, not a measured desktop quota: the earlier large-state write without injection succeeded.

After a crash, unsaved deletions or undo cancellations can disappear. If a Google ID and creation phase were not saved but the reconciliation marker was removed, recovery can insert the task again.

**Fix:** use persistence with observable failure and a verified commit boundary. At minimum, verify the saved state before permitting dependent Google mutations or marker cleanup. Test the production persistence adapter, not only a mocked `save()` that rejects correctly.

### 3. P1: Ordinary text and fenced examples inside the Tasks group are uploaded

Locations: [src/markdown.ts:76](https://github.com/mcaay/obsidian-google-calendar-sync/blob/ff020e5f4554d14167a5974e55d3dc7f54bb63ec/src/markdown.ts#L76), [src/markdown.ts:148](https://github.com/mcaay/obsidian-google-calendar-sync/blob/ff020e5f4554d14167a5974e55d3dc7f54bb63ec/src/markdown.ts#L148), [src/sync.ts:230](https://github.com/mcaay/obsidian-google-calendar-sync/blob/ff020e5f4554d14167a5974e55d3dc7f54bb63ec/src/sync.ts#L230).

`draftTitle()` accepts almost every nonempty unlinked line. `regions()` includes code-fence contents in its returned lines, so `stage()` converts prose, fence delimiters, and example code into Google Tasks. This contradicts the documented preservation of unlinked text and the statement that other note content stays local.

**Reproduced:** an indented explanatory paragraph and a three-line fenced example produced four task creations, with titles `Private explanatory text`, `` ```text ``, `secret example`, and `` ``` ``.

**Fix:** restrict automatic creation to explicit task rows and editor-created drafts. Carry code-fence context through parsing. If plain Vim-created lines remain supported, identify their creation through editor intent rather than interpreting all existing text as a task.

### 4. P1: Deletion and undo intent are not persisted at the editor boundary

Locations: [src/controller.ts:145](https://github.com/mcaay/obsidian-google-calendar-sync/blob/ff020e5f4554d14167a5974e55d3dc7f54bb63ec/src/controller.ts#L145), [src/controller.ts:25](https://github.com/mcaay/obsidian-google-calendar-sync/blob/ff020e5f4554d14167a5974e55d3dc7f54bb63ec/src/controller.ts#L25), [src/sync.ts:125](https://github.com/mcaay/obsidian-google-calendar-sync/blob/ff020e5f4554d14167a5974e55d3dc7f54bb63ec/src/sync.ts#L125), [src/sync.ts:157](https://github.com/mcaay/obsidian-google-calendar-sync/blob/ff020e5f4554d14167a5974e55d3dc7f54bb63ec/src/sync.ts#L157).

Deletion and restoration callbacks update only memory and timers. Persistence depends on a subsequent sync reaching `stage()`. When disconnected, the controller returns before that point. A busy queue or immediate reload also leaves a window before the intent is durable.

**Reproduced in Obsidian:** disconnect, delete a task with Vim `dd`, then reload. There was one deletion in memory and none in storage; reconnecting restored the row instead of replaying the deletion.

**More serious, reproduced with the real engine:** persist a pending Calendar deletion, restore it after one second, then restart from the last saved state before another sync saves the cancellation. The event is deleted even though undo occurred within the promised five-second window. Disconnecting before undo provides a concrete path that prevents that follow-up save.

**Fix:** durably journal deletion, cancellation, and restoration when the editor reports them, independently of authentication, note reads, and the network queue. Do not acknowledge a safe undo while the saved state still authorizes deletion.

### 5. P1: Late-undo task identities work only on the device that recreated them

Locations: [src/sync.ts:52](https://github.com/mcaay/obsidian-google-calendar-sync/blob/ff020e5f4554d14167a5974e55d3dc7f54bb63ec/src/sync.ts#L52), [src/sync.ts:211](https://github.com/mcaay/obsidian-google-calendar-sync/blob/ff020e5f4554d14167a5974e55d3dc7f54bb63ec/src/sync.ts#L211), [src/device-state.ts:38](https://github.com/mcaay/obsidian-google-calendar-sync/blob/ff020e5f4554d14167a5974e55d3dc7f54bb63ec/src/device-state.ts#L38).

Late undo retains the old Markdown key and stores the replacement Google ID in `deletedTasks` and `created`. Those mappings are now device-local. Another device receives a row whose encoded identity names the deleted task but has no mapping to the replacement.

**Reproduced with two device states:** A deleted `task-1`, then recreated it as `created-2` by late undo. B received A's row and edited its title. B sent its PATCH to `task-1`, received 404, discarded the edit, and rendered `created-2` with the old title. Subsequent refreshes also disagree about which Markdown key to use.

**Fix:** make the current remote identity portable with the row or share a non-executable identity mapping. Keep undo history local, but ensure every device can resolve the row to the same current task. Test two devices through delete, late undo, edit, and redo.

### 6. P1: Another device's stale refresh can overwrite newer Google data

Locations: [src/sync.ts:192](https://github.com/mcaay/obsidian-google-calendar-sync/blob/ff020e5f4554d14167a5974e55d3dc7f54bb63ec/src/sync.ts#L192), [src/sync.ts:259](https://github.com/mcaay/obsidian-google-calendar-sync/blob/ff020e5f4554d14167a5974e55d3dc7f54bb63ec/src/sync.ts#L259), [src/device-state.ts:20](https://github.com/mcaay/obsidian-google-calendar-sync/blob/ff020e5f4554d14167a5974e55d3dc7f54bb63ec/src/device-state.ts#L20).

Field changes are inferred only by comparing the current file to this device's private snapshot. Once a device has a baseline, a file refresh received from another device is indistinguishable from a local user edit. ETags do not solve this: `patch()` obtains the latest ETag and intentionally overwrites the field it believes was edited.

**Reproduced:** B's baseline was `Buy coffee`; a delayed file refresh from A contained `Synced older title`; Google already contained `Newest Google title`. B automatically replaced Google's newest title with the older synced value, without a user editing that field on B. Completion states have the same issue.

**Fix:** distinguish explicit local field edits from imported snapshots. Persist local edit intent and reconcile external updates against remote state without automatically promoting every file difference to a write. Specify and test the conflict rule for two devices and delayed file delivery.

### 7. P2: Both devices can create the same unlinked draft

Locations: [src/sync.ts:188](https://github.com/mcaay/obsidian-google-calendar-sync/blob/ff020e5f4554d14167a5974e55d3dc7f54bb63ec/src/sync.ts#L188), [src/sync.ts:230](https://github.com/mcaay/obsidian-google-calendar-sync/blob/ff020e5f4554d14167a5974e55d3dc7f54bb63ec/src/sync.ts#L230), [src/google.ts:140](https://github.com/mcaay/obsidian-google-calendar-sync/blob/ff020e5f4554d14167a5974e55d3dc7f54bb63ec/src/google.ts#L140).

The ownership check works only after a draft already contains a `new:<owner>:...` marker. An ordinary task line can reach the second device through file sync before the first device's ten-second debounce assigns a marker. Each device then assigns a different UUID, and Google reconciliation sees two distinct creations.

**Reproduced with two independent engines:** the same unlinked `One intended task` row resulted in two insertions with different device-owned keys. This models delayed marker delivery; it does not claim to reproduce Obsidian Sync's server timing.

**Fix:** assign stable creation identity and ownership at the originating editor transaction, before the unlinked draft can be synchronized. Do not let receiving devices claim imported unowned drafts automatically. Include concurrent first-creation tests.

### 8. P2: A reconciliation error can re-enable an unsafe task insertion

Locations: [src/sync.ts:356](https://github.com/mcaay/obsidian-google-calendar-sync/blob/ff020e5f4554d14167a5974e55d3dc7f54bb63ec/src/sync.ts#L356), [src/google.ts:145](https://github.com/mcaay/obsidian-google-calendar-sync/blob/ff020e5f4554d14167a5974e55d3dc7f54bb63ec/src/google.ts#L145).

Any 4xx `GoogleError` during `remote.create()` resets the operation to `prepared`. That function also performs reconciliation GETs and PATCHes, so a 403 or 429 from a later lookup is incorrectly treated as proof that an earlier ambiguous POST did not succeed.

**Reproduced:** start with a `sent` operation; make reconciliation fail with 403. Its phase becomes `prepared`. A subsequent empty reconciliation response permits a new POST. If the earlier insertion exists but is temporarily absent from the listing, or its notes marker was removed, this creates a duplicate.

**Fix:** reset the phase only after a definitive rejection of that exact insertion attempt. Preserve `sent` across lookup, reconciliation PATCH, authentication, and quota failures. Carry request phase information in errors rather than inferring it from HTTP status alone.

### 9. P2: One permanently failing write prevents all note refreshes

Locations: [src/sync.ts:40](https://github.com/mcaay/obsidian-google-calendar-sync/blob/ff020e5f4554d14167a5974e55d3dc7f54bb63ec/src/sync.ts#L40), [src/sync.ts:303](https://github.com/mcaay/obsidian-google-calendar-sync/blob/ff020e5f4554d14167a5974e55d3dc7f54bb63ec/src/sync.ts#L303), [src/sync.ts:373](https://github.com/mcaay/obsidian-google-calendar-sync/blob/ff020e5f4554d14167a5974e55d3dc7f54bb63ec/src/sync.ts#L373).

`flush()` attempts unrelated mutations after a per-item 403, which is useful, but still throws before `run()` reaches `remote.load()`. Because every note flushes the global outbox, one invalid title or revoked calendar permission prevents every enabled note from refreshing indefinitely. There is no user-facing way to inspect or discard the problematic operation.

**Reproduced:** two runs with one queued 403 edit performed zero remote loads. Existing tests check that another PATCH succeeds, but do not check that unrelated pulls continue.

**Fix:** return per-operation failures, retain the failed edits, and permit safe pulls for unaffected sources. Keep pending values visible when rendering and report the outstanding failure without blocking the entire account's read path.

### 10. P2: Remote titles can load third-party content without user interaction

Locations: [src/markdown.ts:120](https://github.com/mcaay/obsidian-google-calendar-sync/blob/ff020e5f4554d14167a5974e55d3dc7f54bb63ec/src/markdown.ts#L120), [src/markdown.ts:129](https://github.com/mcaay/obsidian-google-calendar-sync/blob/ff020e5f4554d14167a5974e55d3dc7f54bb63ec/src/markdown.ts#L129), [src/items.ts:30](https://github.com/mcaay/obsidian-google-calendar-sync/blob/ff020e5f4554d14167a5974e55d3dc7f54bb63ec/src/items.ts#L30).

`cleanTitle()` escapes comment delimiters and newlines but leaves image and embed Markdown active. An event title supplied through a shared calendar or invitation can therefore become a web beacon inside a trusted local note.

**Reproduced in Obsidian:** a fixture event title containing `![image](https://example.invalid/review-pixel.png)` generated two image requests without a click. Both were intercepted and fulfilled locally; no request was sent to that host. The title sanitizer also leaves `![[Private note]]` intact, although local-note transclusion was not tested here.

**Fix:** render remote titles as literal text using reversible Markdown escaping, particularly images, embeds, and HTML. Test Live Preview and Reading view. This finding establishes unexpected network loading, not arbitrary JavaScript execution or vault exfiltration.

### 11. P2: Midnight DST transitions produce the wrong note-day boundary

Locations: [src/dates.ts:22](https://github.com/mcaay/obsidian-google-calendar-sync/blob/ff020e5f4554d14167a5974e55d3dc7f54bb63ec/src/dates.ts#L22), [src/items.ts:16](https://github.com/mcaay/obsidian-google-calendar-sync/blob/ff020e5f4554d14167a5974e55d3dc7f54bb63ec/src/items.ts#L16).

The iterative midnight calculation assumes local midnight exists. When a time zone skips midnight, its offset correction oscillates and returns an instant on the previous date after four iterations.

**Reproduced:** `dayBounds('2026-09-06', 'America/Santiago').start` returns `2026-09-06T03:00:00.000Z`, which the same runtime formats as **5 September at 23:00**. A non-task event from 23:30 to 23:45 on 5 September is consequently included in the 6 September note even with overdue events disabled.

**Fix:** explicitly resolve the first valid instant of the local date, including nonexistent or ambiguous midnight. Extend date tests beyond Warsaw's transitions to midnight changes and skipped dates.

### 12. P2: Pending requests depend on the original note remaining readable and enabled

Locations: [src/controller.ts:25](https://github.com/mcaay/obsidian-google-calendar-sync/blob/ff020e5f4554d14167a5974e55d3dc7f54bb63ec/src/controller.ts#L25), [src/controller.ts:131](https://github.com/mcaay/obsidian-google-calendar-sync/blob/ff020e5f4554d14167a5974e55d3dc7f54bb63ec/src/controller.ts#L131), [src/sync.ts:33](https://github.com/mcaay/obsidian-google-calendar-sync/blob/ff020e5f4554d14167a5974e55d3dc7f54bb63ec/src/sync.ts#L33).

The outbox is durable in design but has no independent drain path. Both controller and engine return before `flush()` when the triggering note is missing, disabled, or lacks groups. With no other enabled note open, pending requests never retry. Folder renames are another path: the rename handler updates only an exact note path, not descendant note and operation paths.

**Reproduced with the engine:** a pending title edit remained queued with zero remote calls after disabling its sole note. Missing paths follow the same early return. Folder-rename handling was inspected statically, not exercised in Obsidian.

**Fix:** schedule already-authorized outbox work independently of note rendering. Decide explicitly whether disabling a note cancels its pending work or allows it to finish. Update all affected paths for folder moves and preserve recoverable baselines.

### 13. P2: Quota errors are misclassified, and transient retries refresh OAuth unnecessarily

Locations: [src/google.ts:14](https://github.com/mcaay/obsidian-google-calendar-sync/blob/ff020e5f4554d14167a5974e55d3dc7f54bb63ec/src/google.ts#L14), [src/http.ts:11](https://github.com/mcaay/obsidian-google-calendar-sync/blob/ff020e5f4554d14167a5974e55d3dc7f54bb63ec/src/http.ts#L11), [src/sync.ts:367](https://github.com/mcaay/obsidian-google-calendar-sync/blob/ff020e5f4554d14167a5974e55d3dc7f54bb63ec/src/sync.ts#L367).

Only the HTTP status survives in `GoogleError`. Google Calendar can return quota errors as either 403 or 429, but the implementation treats every 403 as a permission failure, skips quota backoff, and continues through the outbox. Separately, `token(attempt > 0)` forces a token refresh on retries caused by 429 or 5xx, even when authentication is valid. [Google's error guidance](https://developers.google.com/workspace/calendar/api/guides/errors).

**Reproduced with the transport:** a `403 rateLimitExceeded` received one immediate attempt and a permission error. A 503 followed by success called the token provider with `[false, true]`, forcing refresh for the server failure.

**Fix:** preserve and classify Google's error reason, back off for both quota statuses, and refresh credentials specifically after 401. Apply account-level backoff across queued notes, with jitter, rather than restarting short retries independently for each note.

### 14. P3: Default test discovery includes obsolete ignored copies

Location: [package.json:11](https://github.com/mcaay/obsidian-google-calendar-sync/blob/ff020e5f4554d14167a5974e55d3dc7f54bb63ec/package.json#L11).

There is no Vitest include/exclude configuration. `npm run check` discovered tests under the pre-existing ignored `output/diagnostics/desktop-baseline/` directory as well as current tests. It reported **252 tests in 15 files**, whereas restricting the run to current sources produced **133 tests in 9 files**.

This makes local verification depend on leftover artifacts and can introduce stale failures or misleading coverage totals.

**Fix:** explicitly include `tests/**/*.test.ts` and exclude generated output. Keep reproduction artifacts outside normal test discovery. The existing ignored diagnostic directory was not deleted during this review.

### 15. P3: Recovery documentation still points to the old outbox location

Locations: [docs/behavior.md:56](https://github.com/mcaay/obsidian-google-calendar-sync/blob/ff020e5f4554d14167a5974e55d3dc7f54bb63ec/docs/behavior.md#L56), [docs/index.md:27](https://github.com/mcaay/obsidian-google-calendar-sync/blob/ff020e5f4554d14167a5974e55d3dc7f54bb63ec/docs/index.md#L27), [docs/privacy.md](https://github.com/mcaay/obsidian-google-calendar-sync/blob/ff020e5f4554d14167a5974e55d3dc7f54bb63ec/docs/privacy.md).

The behavior guide says to preserve `data.json` because it contains pending work. Version 0.9 stores that work in device-local storage and excludes it from `data.json`. The homepage also describes synchronization state as stored in the vault. The privacy policy identifies local storage, but its removal instructions do not explain how to clear that device state.

**Fix:** document the actual backup, recovery, and removal procedure for device-local pending work. Make clear that copying or deleting `data.json` does not back up or clear the current outbox. Reconcile the user documentation with the chosen persistence fix.

## Performance and design

The architecture is generally appropriate: a small lifecycle module, separate API and editor responsibilities, strict TypeScript, and one serialized scheduler. A framework rewrite would add little value. The following focused improvements would address the main inefficiencies:

1. **Avoid fetching all history for each open note and each new task.** [GoogleClient.load()](https://github.com/mcaay/obsidian-google-calendar-sync/blob/ff020e5f4554d14167a5974e55d3dc7f54bb63ec/src/google.ts#L64) expands all historical Calendar instances by default, separately per note. Even with overdue events disabled, a retained Google Task key sets `includeHistory` for every calendar; this was reproduced. [create()](https://github.com/mcaay/obsidian-google-calendar-sync/blob/ff020e5f4554d14167a5974e55d3dc7f54bb63ec/src/google.ts#L140) also scans the entire task list before every fresh insertion. Reuse per-source results and durable reconciliation indexes; distinguish task retention from calendar retention. Preserve the promised full overdue history rather than adding an arbitrary cutoff.
2. **Bound or reorganize device-state growth.** Every persistence call clones and serializes all note snapshots, creation records, and deletion records, including historical and removed notes. A fixture containing 365 notes with 100 rows each serialized to about **12 MB**. This is a size measurement, not a claimed app quota. Keep pending operations and required undo bindings safe while reducing obsolete baselines, using explicit retention rules and storage suited to the volume.
3. **Cache repeated lookups in large refreshes.** [SyncEngine.run()](https://github.com/mcaay/obsidian-google-calendar-sync/blob/ff020e5f4554d14167a5974e55d3dc7f54bb63ec/src/sync.ts#L52) searches all deleted-task bindings for each loaded item; pending-deletion checks repeatedly scan the outbox. [eventItem()](https://github.com/mcaay/obsidian-google-calendar-sync/blob/ff020e5f4554d14167a5974e55d3dc7f54bb63ec/src/items.ts#L10) recalculates day bounds per event, and [inZone()](https://github.com/mcaay/obsidian-google-calendar-sync/blob/ff020e5f4554d14167a5974e55d3dc7f54bb63ec/src/dates.ts#L13) creates a formatter on every call. Precompute the day's bounds and lookup maps and reuse formatters. Real-account latency and memory consumption were not benchmarked.

## Security controls that held up

- OAuth uses random state, PKCE with S256, a random loopback port bound to `127.0.0.1`, and HTTPS Google endpoints. The local callback test rejects incorrect state. These mechanisms match [Google's installed-app guidance](https://developers.google.com/identity/protocols/oauth2/native-app).
- Setup transfer uses a cryptographically random 100-bit code, AES-GCM with a fresh IV, and authenticated expiry metadata. Wrong codes, tampering, and expiry were tested. Documentation correctly explains that the 30-minute import limit does not revoke the underlying token or erase historical ciphertext.
- Tokens and client secrets are excluded from shared runtime snapshots. The reviewed source has no telemetry, remote code evaluation, or production logging of tokens. A targeted scan of tracked files found no Google OAuth tokens, GitHub tokens, or private-key blocks; this was not a full Git-history secret audit.
- Calendar deletion checks for a recurrence master and refuses whole-series deletion. Existing tests cover occurrence targeting and preservation of unedited fields. Task due-date and recurrence limitations agree with the [Tasks resource reference](https://developers.google.com/workspace/tasks/reference/rest/v1/tasks).
- `npm audit --json` reported **zero known vulnerabilities** for the locked dependency graph. This is an advisory lookup, not proof that the dependencies are vulnerability-free.

## Verification performed

| Check | Result |
| --- | --- |
| `npm run check` | Passed after allowing the mocked OAuth server to bind loopback. Includes lint, tests, strict TypeScript checking, and production build. Its test total was contaminated as described in finding 14. |
| `npm test -- --exclude 'output/**'` | 133 current tests passed in 9 files. |
| `npm run test:obsidian` | Passed against isolated Obsidian 1.13.7 with mocked Google responses. Covered Vim movement and editing, checkbox shortcuts, task creation, templates, indentation, reading-view toggles, deletion grace periods, undo/redo, reload, and switching notes during sync. |
| `npm run test:mobile` | Passed phone-width mobile UI emulation, including editing, checkboxes, foreground refresh, device-state isolation, and setup-code import. |
| Visual inspection | Inspected narrow desktop, phone note, and phone settings screenshots. No additional layout defect identified in those views. |
| Focused engine/API reproductions | Confirmed the edge cases described above using controlled fixtures and the production engine/API modules. |
| Focused real-app reproductions | Confirmed incoming-file content loss, disconnected deletion loss, undetected injected storage failure, and remote-title image loading. |
| Dependency audit | Zero reported vulnerabilities. The initial sandboxed network attempt failed; the permitted retry completed. |
| Packaging | Packaged the verified production build and inspected the ZIP. Required assets are at the plugin-folder root; no test fixture was included. Bundle size: 51,748 bytes. |

The existing desktop harness recorded its documented Obsidian-core `getZoomFactor` exception separately; there were no additional renderer errors in the standard desktop or mobile runs. A focused reproduction initially needed a fixture reconnection correction after disconnect/reload. A natural large-state write succeeded on desktop, so storage failure was subsequently tested through explicit fault injection, as disclosed in finding 2.

Reproduction scripts and results are saved under the ignored `output/review-astra` directory. Standard UI results are in `output/playwright/result.json` and `output/playwright/mobile-result.json`. These artifacts use synthetic data.

## Remaining verification limits

- No live Google account was used or changed. Actual authorization consent, API eventual consistency, quota behavior, shared-calendar permissions, assigned tasks, and recurring Google Tasks require separate controlled live verification.
- Two-device failures were reproduced with independent engine states and simulated file delivery. Obsidian Sync transport, merge behavior, and simultaneous physical-device sessions were not exercised.
- No physical iPhone or Android test was performed in this review. The project's earlier user-reported iPhone success is useful history but does not cover these newly identified cases.
- Native Windows/Linux behavior and the declared minimum Obsidian version 1.11.4 were not run. Current installed API typings confirm the SecretStorage version requirement, but do not prove compatibility of private editor integrations with that minimum version.
- Google-account switching during queued work or token refresh, concurrent setup imports, legacy migration on two desktops, and abrupt OS termination remain targeted gaps. Pending operations are not bound to a verified Google account identity, so account-switch behavior deserves explicit tests before broader use.

Suggested repair order: preserve incoming note content; establish reliable persistence and undo journaling; restrict task creation and remote-title rendering; make identities and edit intent safe across devices; then fix recovery, date boundaries, and quota handling. Add each reproduction as a regression test at its actual integration boundary.
