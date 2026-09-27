# Review - Opus 5.5

Date: 2026-09-26. Scope: whole repository at commit `ff020e5` (v0.9.0, unreleased mobile build). Severity order: Critical, High, Medium, Low.

## Verdict

The core design is sound: per-note snapshots, a durable outbox, compare-and-swap note writes, marker-based creation reconciliation, and a 5-second deletion grace period with native undo. The unit suite is strong for the deletion and undo state machine. The weak points are at the boundaries: note changes that arrive from outside the editor, operations Google permanently rejects, uncertain creations, and request volume. C1 silently loses user-written note text in the new phone plus desktop setup and should block the 0.9.0 release.

| ID | Severity | Finding |
| --- | --- | --- |
| C1 | Critical | External note changes (Obsidian Sync, split panes) are rejected by the editor filter, then the stale editor text overwrites the newer file |
| H1 | High | One permanently rejected operation or one unavailable source stops all note refreshes |
| H2 | High | An uncertain task creation is never resolved and cannot be cancelled |
| M1 | Medium | Every sync downloads the full event and completed-task history |
| M2 | Medium | Untrusted event and task titles are inserted as live Markdown and HTML |
| M3 | Medium | Row deletions and title edits silently affect other people and products |
| M4 | Medium | Non-task lines inside the tasks group become Google Tasks and are rewritten |
| M5 | Medium | Undo is stuck after creating a task |
| M6 | Medium | Device state grows without bound in localStorage, and write failures are silent |
| M7 | Medium | A duplicated row ID blocks all typing in the note while offline |
| M8 | Medium | Splitting a synced row duplicates the task and renames the original |
| L1 to L20 | Low | Listed below |

## Critical

### C1. External note changes are dropped, then overwrite the newer file

Where: filter in `src/editor.ts:159-168`, rejection rules in `src/markdown.ts:160` and `:169`, `view.save()` in `src/controller.ts:63`.

Obsidian 1.13.7 applies a changed file to an open editor as an ordinary CodeMirror transaction, `dispatch({changes, userEvent: "set"})`, after setting `lastSavedData` to the new disk text (verified in the installed `app.js`). The plugin's transaction filter runs `permittedEdit()` on it with no deleted or restored keys, so it rejects any external version that adds, removes or reorders a row ID, changes the line count of an event group, or touches a row this device has no snapshot for. The editor keeps the old text. `TextFileView.save()` then sees editor text that differs from `lastSavedData` and writes the old text back. `Controller.read()` calls `view.save()` at the start of every sync, so this happens within 120 seconds even if the user types nothing.

Reproduced in an isolated vault with the fixture plugin:

- External version with one new synced task row and one journal paragraph: not applied to the editor. After the desktop's next sync the paragraph was gone from disk; the task row came back from Google.
- Control, an external change outside the groups only: applied normally.
- Same note open in two panes: after a sync added an event, the inactive pane never showed it and diverged from disk. Saving that pane later writes its stale text.

Typical trigger in 0.9.0: one device adds, deletes or newly renders a row while the other has that daily note open, in either direction. Any text written on the other device in the same Sync update is lost (only Sync history keeps it). The same applies to iCloud, Dropbox, git and popout windows.

Fix: let `userEvent: "set"` transactions through the filter (deletion journaling already ignores them), and treat their row changes as remote: adopt them as the note baseline, or skip staging for that run, so another device's older checkbox states are not pushed back as local edits. Add a harness test that writes the open note externally with a row change.

## High

### H1. One rejected operation or unavailable source stops all refreshes

Where: `src/sync.ts:366-373` throws after the flush loop, so `run()` never reaches `load()` at `src/sync.ts:51`. `load()` also fails as a whole on any single source error.

Probe: one 403 on a title patch, then five runs: `load()` was never called and the patch was retried every time. A 404 on a queued creation behaves the same.

Realistic triggers:

- Renaming a Gmail-generated event such as a flight or hotel. Google does not allow summary changes on `fromGmail` events.
- Losing write access to a shared calendar. `writable` stays cached until **Refresh sources**.
- Deleting a task list in Google while a new task for it is queued, or while it is still the default list.
- A task title longer than 1,024 characters, the Tasks API limit.
- A selected calendar or list that was deleted or unshared, so `load()` gets 404 or 403.

Result: no daily note receives new events or tasks again, the failing request repeats every sync, and the user only sees `GCal: ✕` because the reason is in `aria-description`. There is no way to discard the operation. The test `does not let a denied calendar edit block an unrelated task update` asserts that `run()` rejects, which is this behavior.

Fix: pull even when item-level operations fail. Resolve permanent 4xx responses (400, 403 other than rate limits, 404 on creation) with a documented rule such as "Google wins, local edit dropped", and show the reason. Name a failing source and skip it while keeping its existing rows.

### H2. An uncertain task creation is never resolved

Where: `src/google.ts:151`, `src/sync.ts:311-326` and `:362-364`.

A network error or the 30-second timeout on the insert request leaves `phase: 'sent'`. Every later run searches for the marker, finds nothing and returns without inserting. Probe with the real `GoogleClient`: one failed POST, then three runs that all returned `Waiting to confirm a task creation with Google` with no further POST. Deleting the row afterwards left the entry in the outbox. The status shows `↻`, the same as normal syncing, so the task silently never reaches Google. This is most likely on phones, for example when the app is suspended right after a task is added. The test `persists an in-flight creation before sending it` expects the waiting state to persist.

Fix: the marker lookup already makes a retry safe. When a sent creation is not found, optionally after a minute, return it to `prepared` and insert again. Let row deletion cancel it, and delete the task if a later lookup finds it.

## Medium

### M1. Every sync downloads the full history

Where: `src/google.ts:69-74`, `:80-84` and `:145`.

With the default settings (`markers` and `overdueEvents` on), events are listed with no `timeMin`, so every sync downloads every expanded instance of every selected calendar up to the note's day. Tasks are listed with `showCompleted`, `showHidden` and only `dueMax`, so every dated task ever completed is downloaded, 100 per sequential request. No `fields` masks are used, so full resources including descriptions, attendees and conference data are transferred. This repeats every 120 seconds for each open daily note and after edits, and `create()` scans the whole list again before every insert. The cost grows with account age: slower syncs, mobile data and battery use, and on slow networks large pages can exceed the 30-second request timeout, which fails the whole sync. It also transfers more Google data than the features use.

Fix, without changing documented behavior: `fields` masks; split the task query into the note's day with completed tasks plus earlier days with `showCompleted=false`; fetch retained items by ID; refresh the full history at most daily or incrementally; scope the creation lookup with `updatedMin`.

### M2. Untrusted titles become live Markdown

Where: `src/markdown.ts:120-123`. `cleanTitle()` only handles line breaks and comment delimiters.

Anyone can place an event in the primary calendar by sending an invitation, unless the account restricts which invitations are added, and `showAssigned` includes tasks assigned by collaborators. A title such as `![](https://tracker.example/p.png)`, `<img src=...>` or `<iframe src=...>` loads remote content whenever the daily note renders, revealing when and from where it is viewed. Links render as ordinary note content. Plugins that execute inline code from notes, such as DataviewJS inline queries when enabled, would run attacker text.

Fix: escape HTML and image embeds in event titles (`<` to `&lt;`, `![` to `\![`) and reverse it in `googleTitle()`, at least for events the user did not organize.

### M3. Deletions and edits affect other people and products

Where: `src/google.ts:131` and `:175`.

- `dd` on a meeting the user organizes cancels it for every guest with `sendUpdates=none`: no cancellation email, and guests outside Google keep a stale event. Title and ✅/⬜️ edits likewise rename the shared event for all guests.
- For tasks assigned from Docs or Chat, Google deletes "both the assigned task and the original task (in Docs, Chat Spaces)" (Tasks API reference).

Neither is documented. Decide explicitly whether to refuse, notify or document, and update `docs/behavior.md`.

### M4. Non-task lines in the tasks group are uploaded and rewritten

Where: `src/sync.ts:230-257` and `src/markdown.ts:148-153`. Fenced lines are included in regions at `src/markdown.ts:76-83`.

Probe: a fenced block under the tasks heading created three tasks, one per line including both fences. A nested sub-list under a Google task became separate top-level tasks, and its lines were rewritten at the group's indentation. `docs/setup.md` says unlinked text inside groups is preserved.

Fix: treat only direct-child list items as drafts; skip fenced blocks and deeper-indented children.

### M5. Undo is stuck after creating a task

Probe in real Obsidian: Vim `o`, a title, Escape. The sync linked the row to its Google ID and re-sorted it. Pressing `u` twice changed nothing and queued nothing, so all older history is unreachable too. Likely cause: the ID is added and rewritten outside the undo history, and `replaceEditorText()` moves the row with one group-wide replacement, so the undo can no longer be mapped and the filter rejects it. Undo of a pending deletion still worked when another row changed at the same time.

Fix: apply row-level minimal changes in `replaceEditorText()`, and do not move a row the user just created.

### M6. Device state grows without bound and fails silently

Where: `src/main.ts:72` and `src/device-state.ts`. Nothing prunes `notes`, `created` or `deletedTasks`.

Measured: the user's own backup averages 621 characters per row, about 4.6 KB per daily note. A simulated year at 8 rows a day is 1.6 million characters. localStorage has one per-origin quota, roughly 5 to 10 MB depending on the engine, shared by all vaults and, on desktop, by Obsidian's SecretStorage. Obsidian's `saveLocalStorage()` swallows errors (`try{localStorage.setItem(...)}catch(e){}`), so once the quota is full the outbox and new Google IDs silently stop persisting; after a restart queued edits are lost and creations can be repeated. Every save also clones and serializes the whole state, several times per sync.

Fix: prune note snapshots without pending work after some days, `created` entries once cleaned and unreferenced, and `deletedTasks` once undo is no longer possible. Detect failed writes by reading back.

### M7. A duplicated row ID freezes typing while offline

Where: `src/markdown.ts:169` rejects every transaction while any group contains a duplicate ID, including edits outside the groups.

Probe in real Obsidian: with Google unreachable, typing on a plain line of such a note was rejected. Duplicates arise from merges of concurrent renders through Sync or git, and will reach the editor more often once C1 is fixed.

Fix: reject only edits that add duplicates.

### M8. Splitting a synced row duplicates the task

The hidden ID stays on the last line of a split, and `permittedEdit()` allows it (probe). The next sync uploads the text left on the first line as a new task, while the original keeps the ID and takes the last line's title, or its Google title if that line is empty. Uncommon trigger: pasting several indented list lines at the end of a synced task row.

Fix: reject a user transaction that inserts a line break between a keyed row's start and its ID.

## Low

- L1. `src/main.ts:41` parses every response as JSON. A non-JSON error body, such as Google's HTML page for a 502 or 503, throws `SyntaxError` and loses the status, which skips retries and the 404, 410 and 412 handling.
- L2. `src/google.ts:19` forces an OAuth refresh on every retry, including 429 and 5xx (probe: `[false, true, true]`). Calendar also reports rate limits as 403 (`rateLimitExceeded`, `userRateLimitExceeded`, `quotaExceeded`); these are neither retried nor distinguished from "Google denied access".
- L3. The sync interval has no maximum. From 2,147,484 seconds the delay overflows `setTimeout` and fires after 1 ms, causing back-to-back syncs (`src/scheduler.ts:57`, `src/settings.ts:89`).
- L4. Typing a code fence above the groups is rejected: the unclosed fence hides the markers until it is closed, so the third backtick or tilde is dropped (probe).
- L5. `src/dates.ts:22-33`: where local midnight does not exist (America/Santiago 2026-09-06, America/Havana 2026-03-08), the day starts one hour early (probe).
- L6. `src/auth.ts:63`: after **Connect Google**, selecting **Use another browser** or clicking again fails with "already open" for up to 30 minutes. Abort the previous flow instead.
- L7. If the user unticks Calendar or Tasks on Google's granular consent screen, **Refresh sources** fails as a whole with a generic 403 because `sources()` uses `Promise.all`. Check the granted `scope` in the token response.
- L8. Error details and the stuck waiting state are visible only to screen readers. The settings tab could show the last status message without adding UI elsewhere.
- L9. `src/controller.ts:26`: when the connection disappears, for example after a client ID change arriving through Sync, runs return silently and the status can stay `✓`.
- L10. Vim `C`, `D`, `cc` and `S` on a synced row would remove the hidden ID, so the filter rejects them while Vim still enters insert mode (code reading).
- L11. Group markers cannot be deleted, cut or moved on their own while the note is enabled; the edit is silently rejected. Document the escape hatch: set `google-daily: false` first.
- L12. `enableNote()` throws "Close the existing frontmatter" for an empty but closed `---` block (`src/markdown.ts:51`, probe).
- L13. `src/controller.ts:126-130` requests a sync, and therefore a forced `view.save()`, on every metadata change of any opened non-daily note.
- L14. `src/editor.ts:128-129` handles Enter without checking `event.isComposing`, so committing IME input on a task row inserts a new row.
- L15. `src/device-state.ts:23`: two desktops that both load an old version 1 `data.json` before Sync updates it both adopt the unowned outbox, which can duplicate creations.
- L16. A `new:` draft owned by a device that later lost its local state is never created by any device and stays in the note without any indication.
- L17. `npm test` has no include pattern and also runs six stale copies under the ignored `output/diagnostics/desktop-baseline/tests`, reporting 15 files and 252 tests. The real suite is 9 files and 133 tests. Use `vitest run --dir tests` or an `include` setting.
- L18. The README advertises experimental Android support while `docs/development.md` says Android is unverified. The project rules say not to claim unverified support.
- L19. Each keystroke in a daily note re-parses the whole document about ten times (filter, view plugin, decorations). Measured 0.3 ms at 16 KB and 3.4 ms at 353 KB on this Mac: fine for normal notes, possibly noticeable on phones with very large notes.
- L20. The deletion, undo and recreation bookkeeping (`deletedTasks`, `restoredKey`, `deletionKey`, `replaces`, `created`) is correct in the tested paths but hard to reason about. Consolidating it into one per-row record would reduce regression risk.

## Checked and sound

- OAuth: PKCE S256, 256-bit state, loopback-only listener without reflected input. Scopes match the implemented features.
- Secrets: tokens and the client secret are in SecretStorage. None are in `data.json`, fixtures, logs, tracked files or git history (scanned).
- Setup code transfer: uniform 100-bit code, AES-GCM with a random IV, expiry bound as additional data, only ciphertext synced.
- The shipped bundle contains only first-party code (esbuild metafile). The local `main.js` is identical to a fresh production build.
- Compare-and-swap note writes, outbox ordering, marker-based creation reconciliation and marker cleanup.
- 5-second deletion grace, native undo and redo, deadlines across reloads and late task undo, covered by unit tests and a GUI probe with a concurrent render.
- `minAppVersion` 1.11.4 matches the newest API used (`secretStorage`).

## Not verified

- Whether the Tasks API enforces `If-Match`. Its documentation does not say; if the header is ignored, task conflict protection does nothing. Calendar documents it.
- Real Obsidian Sync timing for C1 (the probe used a direct file write, which Obsidian handles through the same path), title edits on attendee copies of events, and whether deleting a parent task also deletes its subtasks.
- All probes used simulated Google responses. No live Google data or personal vault was touched.

## Verification performed

- `npm run lint` and `npm run typecheck`: clean. `npx vitest run --dir tests`: 9 files, 133 tests pass. Production build to a scratch path: identical to `main.js`.
- `output/playwright/result.json` and `mobile-result.json` show passing desktop and mobile harness runs at 15:02 and 15:04 today. They were not rerun for this review.
- Unit probes run outside the repository against the real source: H1, H2, M4, M6 sizing, M7, M8, L2, L4, L5, L12 and L19.
- Probes in an isolated Obsidian 1.13.7 instance with a temporary profile, a temporary vault and the fixture plugin: C1, split panes, M5, M7, and deletion undo during a concurrent render.
- Obsidian internals read from the installed `app.js`: `saveLocalStorage()`, SecretStorage persistence, the `requestUrl` JSON getter, keymap listener order, external change application and `TextFileView.save()`.

## Suggested order

C1, then H1 and H2, then M1 (starting with `fields` masks) and M6, then the rest.
