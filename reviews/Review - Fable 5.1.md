# Review - Fable 5.1

Scope: every file under `src/`, `tests/`, `scripts/`, `docs/`, plus build, lint, manifest and packaging config at commit ff020e5 (v0.9.0, unreleased). Reviewed for correctness, security and efficiency. Line numbers refer to the current tree.

## Verification performed

| Check | Result |
| --- | --- |
| `npm run lint`, `npm run typecheck` | clean |
| `npm test` (Vitest) | 252 tests pass, but 6 of the 15 files are stale copies under `output/` (M7) |
| `npm run build` | 50.5 kB `main.js`; the bundle requires only `obsidian` and `@codemirror/*` |
| `npm audit` | 0 vulnerabilities, no runtime dependencies |
| `npm run test:obsidian` (Obsidian 1.13.7, isolated profile, Vim) | all 20 checks pass, no renderer exceptions |
| `npm run test:mobile` (mobile UI emulation) | all 6 checks pass |
| Obsidian typings 1.13.1 | every API used exists at `minAppVersion` 1.11.4 (`secretStorage` is `@since 1.11.4`) |
| Scratch reproductions against a bundle of `src/` | confirm H1, H3, M1, M4 and M6 below |

Not verified: a live Google account, Android, Windows and Linux hosts, and the in-app behavior described in L1.

## High

### H1. Every sync downloads the full history of every calendar and task list
`src/google.ts:69-73` omits `timeMin` whenever `markers && overdueEvents` (both default to true) or `retained` is non-empty, so `events.list` returns every expanded instance since the calendar was created. `src/google.ts:81-84` sends `showCompleted=true&showHidden=true` without `dueMin`, so `tasks.list` returns every completed task ever, 100 per page. Reproduced request URLs with default settings:

```
GET .../calendars/primary/events?singleEvents=true&orderBy=startTime&maxResults=2500&timeMax=2026-09-19T22:00:00.000Z&timeZone=Europe/Warsaw
GET .../lists/list/tasks?maxResults=100&showCompleted=true&showHidden=true&showAssigned=true&dueMax=2026-09-20T00:00:00.000Z
```

This runs every 120 s, on every note open, every settings change, every foreground resume on the phone, and after every edit (M3). A multi-year calendar with recurring series means megabytes per sync and dozens of pages per task list: a battery and data problem on mobile and a quota risk everywhere. `create()` (`src/google.ts:145`) also lists the whole task list before every insert, even for `phase: 'prepared'` drafts where no POST can have been sent yet.

Fix: query by date (`dueMin`/`dueMax` around the note date, plus a separate `showCompleted=false` query with `dueMax` for overdue tasks), fetch retained items by ID with `events.get` and `tasks.get`, and find overdue marked events with `q=⬜` or a documented, bounded `timeMin` (for example 90 days). Skip the marker lookup in `create()` unless `phase === 'sent'`.

### H2. One permanently rejected request blocks Google to note updates for all notes
`flush()` (`src/sync.ts:303-374`) rethrows the first failure and `run()` awaits it before `load()` (`src/sync.ts:42-52`), so nothing is pulled or rendered in any note while any outbox entry keeps failing. A 400 (invalid value), a 403 on a read-only or organizer-only item (Google's `forbiddenForNonOrganizer`), or the plain `Error` from `src/google.ts:173` is retried on every run forever: no attempt limit, no way to discard the entry from the UI, and the reason is readable only through `aria-description` (M5). `tests/sync.test.ts:603` shows unrelated items still flush, but the run still throws before rendering.

Fix: after a permanent 4xx (anything except 401, 404, 410, 429), park or drop the entry with a Notice and let the next render restore the row from Google. Let `run()` continue to `load()` after a failed flush and report the failure through status only.

### H3. Per-device baselines turn the other device's rendered changes into local edits
`stage()` compares each row with this device's snapshot (`src/sync.ts:259-276`), but the note text is shared through Obsidian Sync. When the desktop renders a title or checkbox changed in Google, the phone's snapshot still holds the old value, so the phone stages a "local edit" and PATCHes it. Reproduced: snapshot `A`, note text `B`, Google `C` produces `patch {title: "B"}`, overwriting the newer Google value. In the common case Google still has `B`, which still costs one GET and one PATCH per changed row every time the second device wakes up. This is the headline v0.9.0 feature and no test covers it.

Fix: pull before staging (`load`, then `stage`, then `flush`, then render) and treat a field as edited only when it differs from both the local snapshot and the freshly loaded remote value.

## Medium

### M1. Malformed or section-less notes freeze the editor, and a blocked undo walls off history
`permittedEdit` returns false on any exception (`src/markdown.ts:195`) and `regions()` throws on duplicate markers (`src/markdown.ts:87`). Reproduced: with two `<!-- gdn:tasks -->` markers, typing outside the sections and deleting the duplicate line are both rejected, so the note cannot be repaired inside Obsidian. Pasting the template into a note that already has `google-daily: true` is rejected as well (`src/markdown.ts:160`), so template plugins silently do nothing; only the plugin command works. A native undo of a calendar deletion after the 5 s window is rejected too. CodeMirror builds the replacement for a filtered transaction from the returned specs only (`@codemirror/state` `resolveTransaction`), so the history annotation is lost, the undo entry is never popped, and every later `u` retries the same blocked step: nothing older can be undone. All of this is silent.

Fix: fail open when `regions(before)` throws (sync already refuses such notes), allow undo transactions that re-insert rows with a known snapshot (the next render removes what Google no longer has), and show a Notice whenever an edit is rejected.

### M2. Device state grows without bound and localStorage failures are silent
`data.notes`, `data.created` and `data.deletedTasks` are never pruned. `persist()` (`src/main.ts:71-82`) clones and stringifies all of it on every save, and `flush()` saves several times per run. `run()` also scans every `created` entry against the note text on each render (`src/sync.ts:79-83`). Obsidian's `saveLocalStorage` is `localStorage.setItem` inside a try/catch that swallows `QuotaExceededError` (verified in obsidian-1.13.7.asar), and the `app://obsidian.md` origin quota (roughly 5 to 10 MB) is shared by every vault and plugin. At roughly 0.4 kB per row snapshot, daily use adds a few MB per year; once the quota is hit, pending deletions, creations and baselines silently stop persisting and are lost at the next restart.

Fix: prune `notes` entries whose file no longer exists or is older than a window and has no pending work, drop `created` entries once `markerRemoved` and no note still carries the `new:` key, drop resolved `deletedTasks`, and read back after `saveLocalStorage` to detect failure.

### M3. Any edit anywhere in an enabled note triggers a full Google fetch
`update()` in `src/editor.ts:226-253` marks the note dirty for every document change, including text outside the managed groups. `SyncScheduler.normal` then requests an edit sync, the controller runs it with `render = true`, and `run()` calls `remote.load()` (the H1 payload). In Vim this happens on every Escape; without Vim after every 10 s pause.

Fix: mark dirty only when a transaction touches a managed region or `hasLocalEdits()` is true, and skip `load()` for edit-triggered runs that staged nothing. The periodic timer already refreshes.

### M4. Nested notes and plain lines under the tasks group are created as Google Tasks
`draftTitle` (`src/markdown.ts:148-153`) accepts any non-empty unlinked line and `stage()` (`src/sync.ts:231-258`) creates a task for it at any indentation. Reproduced: a sub-bullet `- note about this task` under a task row and a plain line `some plain line` both became Google Tasks. `docs/setup.md` promises that unlinked text inside groups is preserved, and the product rule limits creation to task rows.

Fix: treat only `- [ ]` and `- [x]` rows at exactly `region.indent` as drafts and preserve everything else.

### M5. Sync errors are invisible
`setStatus` (`src/controller.ts:98-105`) shows only `GCal: ✕`; the message lives in `aria-description`. An expired refresh token (the 7-day Testing limit), a 403, a quota error and a duplicate marker all look the same and cannot be read without a screen reader.

Fix: set `title` or open a Notice on click, and raise a Notice for terminal failures.

### M6. `enableNote` corrupts two kinds of frontmatter
`src/markdown.ts:56-58` uses `String.replace` with string arguments. Reproduced: an empty frontmatter (`---\n\n---`) yields `\ngoogle-daily: true---\n\n---\n`, and a value containing `$'` (likewise `` $` ``, `$&`, `$$`) is rewritten because replacement patterns are interpreted: `title: cost $' more` became `title: cost \n---\n more\ngoogle-daily: true`.

Fix: splice by index or pass a function as the replacement.

### M7. `npm test` runs stale copies from an ignored directory
Without a Vitest config, `vitest run` picks up `output/diagnostics/desktop-baseline/tests/*.test.ts` (6 of the 15 reported files, testing the old `src` copy next to them). Results depend on a gitignored folder and any edit there breaks `npm test`.

Fix: add `vitest.config.ts` with `include: ['tests/**/*.test.ts']`.

## Low

- **L1. Escape is intercepted globally.** `src/editor.ts:107-112` with the capture listener at `src/editor.ts:186-194` forwards Escape, Ctrl+[ and Ctrl+c to Vim and stops propagation for every other listener (editor suggestion popups, for example) while an enabled note is in insert or visual mode. The `vim-mode-change` handler at `src/editor.ts:181` already flushes titles, so the interception looks redundant. Not verified in the app.
- **L2. Dead refresh tokens retry forever.** A rejected refresh (`invalid_grant` after revocation or the 7-day Testing expiry) leaves `connected()` true and repeats the token request every interval (`src/auth.ts:53-60`). `request()` also forces a refresh on every retry, not only after a 401 (`src/google.ts:19`).
- **L3. Two desktops can both migrate a v1 outbox.** `src/device-state.ts:22-27` cannot tell which desktop is the original; the notes marker prevents most duplicate inserts but not a race.
- **L4. `Retry-After` is ignored** and backoff is 0.5 s then 1 s (`src/google.ts:28-30`).
- **L5. Status stays "Syncing"** for an enabled note without sections, because `run()` returns `''` and `src/controller.ts:36` keeps the previous text.
- **L6. Secret storage edge cases.** `setSecret` throws "Secure storage is not available" on hosts without it; `src/settings.ts:23` and `src/auth.ts:138` do not handle that. The client ID field persists `data.json` on every keystroke (`src/settings.ts:18-20`), which churns Sync history.
- **L7. The series-master guard is a plain Error** (`src/google.ts:173`), so `flush()` treats it as a network failure and stops the whole outbox (H2). Practically unreachable, but it should be a permanent failure.
- **L8. Expired setup packages linger.** `connectionTransfer` stays in `data.json` until imported or cancelled; clear expired packages on load.
- **L9. Stale documentation.** `docs/behavior.md` still says pending work lives in `data.json`; `docs/index.md` says sync state is stored in the vault; `docs/setup.md` contradicts M4.
- **L10. Housekeeping.** No CI workflow; `eslint-plugin-obsidianmd` is not used; `tsconfig.json` type-checks `src/` with Node globals, so only the mobile runtime test guards against stray Node APIs; `CLAUDE.md` is an untracked symlink.
- **L11. Malformed-note paths in key handling.** `handleKey` calls `regions()` without try/catch (`src/editor.ts:134`), and `regions()` counts a tab as four columns regardless of tab size (`src/markdown.ts:69`).
- **L12. Disconnect does not revoke at Google** (documented); a best-effort call to the revoke endpoint would be cheap.
- **L13. The reconciliation marker carries the device `runtimeOwner` UUID** into Google task notes until cleanup (`src/sync.ts:190`, `src/google.ts:142`).

## Security assessment

Sound: PKCE S256 with a random `state`, a loopback listener bound to 127.0.0.1 answering in plain text (`src/auth.ts:61-108`); tokens and the client secret in SecretStorage; the device transfer uses AES-GCM with a 100-bit random code, AAD-bound expiry and non-distinguishing error messages (`src/connection-transfer.ts`); `cleanTitle` escapes comment delimiters and newlines so a remote title cannot inject markers or row IDs (`src/markdown.ts:120-123`); conditional PATCH with `If-Match`; only IDs, titles, status and dates leave the vault; no console logging; no runtime dependencies beyond Obsidian and CodeMirror. Residual: SecretStorage guarantees are Obsidian's (secrets are held in memory and persisted by its adapter), transfer ciphertext remains in Sync history (documented), and L13.

## Suggested order

H1 with M3 (largest user-visible cost, mostly `src/google.ts` and `src/editor.ts`), then H2 with M5 (recovery and visibility), then H3 (cross-device correctness), then M1, M4, M6, M2, M7.
