# Security audit - Fable 5.1

**Model:** Claude Fable 5.1 (`claude-fable-5-1`) with Max effort.
**Date:** 2026-10-03. **Tree:** commit `047be77`, plugin version 0.9.1.

## Prompt

> Please perform a fresh security audit of this plugin. Write the results into a new markdown file in this reviews folder, with filename beginning with date in ISO format. At the top, clearly state which AI model you are (Fable 5.1 with Max effort). Then quote this prompt. Then write a super concise TLDR section at the top, in which you are not allowed to use more than 1000 characters. Afterwards, write your detailed security audit.

## TLDR

Verdict: safe to connect to your Google account. No exfiltration, telemetry or remote code. The bundle has no runtime dependencies and talks only to Google (OAuth, Calendar v3, Tasks v1) plus a 127.0.0.1 sign-in callback. A fresh build from source is byte-identical to the shipped main.js and to the installed vault copy. Tokens and the client secret live in Obsidian SecretStorage, never in data.json or git. OAuth uses PKCE S256, a random state and a loopback port; the phone transfer is AES-GCM under a random 100-bit code. Titles from Google are escaped, so an invitation cannot embed HTML, images or code in a note. No high or medium findings. Low: a row key planted in a note from outside the editor can aim your own edit or deletion at any of your task lists; keys named like Object.prototype members wedge that note's sync; Markdown links in remote titles stay clickable with any URL scheme. Info: no token revocation on disconnect, unpinned CI actions, locally built release zip.

## Scope and method

- Read every file under `src/` (17 files), the tests, scripts, docs, manifest, build, lint, CI and packaging configuration at commit 047be77.
- Built a fresh production bundle with the repository's esbuild settings and inspected it for hosts, `require()` calls and risky APIs.
- Ran scripted reproductions against the real `SyncEngine` and `checkEdit` for the two behavioral findings.
- Inspected the installed Obsidian 1.13.7 bundle to confirm how `SecretStorage` and `Notice` behave.
- Scanned the whole git history for secret-shaped strings. Ran `npm audit`.
- The 2026-09-26 reviews were not re-litigated; this is an independent pass focused on security.

## Verification performed

| Check | Result |
| --- | --- |
| `npm run lint`, `npm run typecheck` | clean |
| `npm test` | 279 tests in 10 files pass |
| Fresh production build (Node 24.16.0, esbuild 0.28.2) | 82,818 bytes, SHA-256 `a929ae70cae8db973227aecd0b5bf7c59f8750713e02480058b8dd0da06184fd` |
| Shipped `main.js` in the working tree and the copy installed in the vault (0.9.1) | same SHA-256, byte for byte |
| Hosts referenced by the bundle | `accounts.google.com`, `oauth2.googleapis.com`, `www.googleapis.com`, `tasks.googleapis.com`, `http://127.0.0.1` (sign-in callback), `developers.google.com` (a help link in settings) |
| `require()` in the bundle | `obsidian`, `@codemirror/state`, `@codemirror/view`, `@codemirror/commands`, `node:http` (desktop sign-in only) |
| `innerHTML`, `eval`, `new Function`, `fetch`, `XMLHttpRequest`, `WebSocket`, `sendBeacon`, `child_process`, `process.env` in the bundle | none; `sessionStorage` appears twice for a restart flag |
| Runtime dependencies (`npm ls --omit=dev`) | none |
| `npm audit` | 2 moderate advisories in `moment`, pulled in by the `obsidian` typings package; development only, not bundled |
| Git: tracked artifacts and secrets | no tracked `main.js` or `data.json`; zero secret-shaped strings (client secrets, access or refresh tokens, real client IDs) in any commit |
| Obsidian 1.13.7 internals | desktop `SecretStorage` encrypts with `window.electron.remote.safeStorage`; `Notice` renders a string through `createDiv({ text })`, never as HTML |

Not verified: the GitHub release asset was not downloaded, so compare its `main.js` against the hash above; Android, Windows and Linux; a live Google account; the mobile `SecretStorage` backend (the desktop bundle only references Keychain and SecureStorage by name).

## Data flows

**Leaves the device.** Token requests to `oauth2.googleapis.com` carry the client ID, client secret, authorization code with PKCE verifier, or the refresh token. API requests carry a Bearer token and field masks (`src/google.ts:11-12`). Writes send only: event `summary`; task `title`, `status`, `completed`; new task `title`, `due`, `status` and a reconciliation marker in `notes`; `DELETE` by ID. Note text, file names and vault names never appear in a request body or URL.

**Stored locally.** SecretStorage: `google-daily-notes-oauth` (client ID, access token, refresh token, expiry) and `google-daily-notes-client-secret`. Per-vault `localStorage`, plaintext: the journal (pending edits, deletions, undo records) and the device state (row snapshots with titles, created IDs, the overdue-event cache). `data.json`: settings (client ID, calendar IDs, which are usually email addresses, task list IDs) and, during a device transfer, the encrypted package. `sessionStorage`: one flag.

**Can influence the plugin.** Google data from the user's own account; anyone who can place an event invitation or an assigned task in that account (titles only, escaped); anything that can write the note file outside Obsidian's editor (Obsidian Sync, other plugins, a shared vault); local processes that can reach the loopback callback (guarded by a 256-bit `state`).

## Findings

No High or Medium findings.

### L1. A row key planted in a note can aim the user's own edit or deletion at any of their task lists

A row's hidden comment encodes `[kind, source, id]` (`parseItemKey`, `src/markdown.ts:121`). `foreignTask()` (`src/sync.ts:221`) builds a writable task item from such a key alone, and both `target()` (`src/sync.ts:329`) and `queueDeletions()` (`src/sync.ts:423`) accept it. Nothing checks that `source` is a task list enabled, or even listed, in settings.

Reproduced against the real engine: a row keyed to list `NOT_ENABLED_LIST`, task `task-123`, followed by a checkbox toggle and a rename, produced `PATCH list=NOT_ENABLED_LIST id=task-123 done=true title=renamed`; deleting the row produced `DELETE task list=NOT_ENABLED_LIST id=task-123` after the 5-second window. The same key pointed at a calendar event sent nothing, because events need a snapshot.

Preconditions limit this to Low: the row has to arrive from outside this device's editor (the editor re-keys pasted rows and refuses unknown keys), for example through Obsidian Sync from a device without the plugin, another plugin that writes notes, or a shared vault; the user then has to edit or delete that specific row; and the request runs with the user's own token, so only their own lists are reachable.

Fix: in `foreignTask()` require `source` to be an enabled list in `settings.taskLists`, and add a test. Optionally also require that the key appeared in a snapshot the plugin rendered.

### L2. Row keys named like `Object.prototype` members wedge sync for that note and cannot be removed in the editor

`ROW_ID` (`src/markdown.ts:8`) accepts `[A-Za-z0-9_:-]+`, so `<!-- gdn:constructor -->`, `__proto__`, `toString` or `hasOwnProperty` are valid keys. `resolve()` (`src/sync.ts:192`) looks them up in plain objects (`aliases`, `created`), receives an inherited function or `Object.prototype`, and returns it as the current key. `retained()` (`src/sync.ts:178-179`) then calls `.startsWith` on it and throws; `run()` catches this as a load failure, so the status bar shows `GCal: ✕` with `key.startsWith is not a function` and the note is never rendered again. In the editor, `checkEdit` reads `snapshots[key]` (`src/markdown.ts:377`, `:411`) from a plain object too, gets `Object` or `Object.prototype`, sees `writable` undefined and refuses both deletion and title edits as `BLOCKED.readOnly`.

Reproduced for all four names; a normal key behaved. Typing such a key in the editor is already refused (`BLOCKED.event`), so the same external write paths as in L1 are needed. Pending pushes still flush; only pulls for that note stop until the key is removed outside Obsidian or `google-daily` is turned off.

Fix: look up note-derived keys with `Object.hasOwn` (a small `own(record, key)` helper at the lookup sites in `sync.ts`, `editor.ts` and `markdown.ts`), or give the keyed records a null prototype when state is restored. `resolve()` should also accept only string aliases.

### L3. Markdown links in titles from Google stay clickable with any URL scheme

`cleanTitle` (`src/markdown.ts:167`) escapes `<`, backticks and `![`, and deliberately keeps links. An invitation or an assigned task titled `[Join](file:///Applications/Calculator.app)` or `[Agenda](obsidian://new?name=x&content=y)` therefore renders as a plain-looking link whose destination is hidden in Live Preview and Reading view. Nothing runs on render; a click hands the destination to Obsidian's link handling, which includes `obsidian://` actions and any URI handlers other plugins register. `%%` in a title also opens an Obsidian comment that hides the rest of the note in preview, and `$...$` renders as math. Both are cosmetic.

Fix: escape `](` in `cleanTitle` (and undo it in `googleTitle`) so remote titles cannot form Markdown links while bare `https://` URLs still autolink; or allow only `http` and `https` destinations. Mention the choice in `docs/behavior.md`.

### I1. Disconnect does not revoke the token at Google

`disconnect()` (`src/auth.ts:168`) clears the local token only. `docs/behavior.md` explains why: every device shares one refresh token, so revoking it would disconnect them all. Two small gaps: changing the client ID without disconnecting first leaves the old token in SecretStorage (`read()` filters by client ID, nothing clears it), and a user who wants a true sign-out has to visit Google account connections. Consider clearing the stored token when the client ID changes.

### I2. An expired transfer package lingers until the next load

`src/main.ts:100` removes an expired `connectionTransfer` only when the plugin loads; `Cancel setup` removes it manually. The ciphertext is AES-GCM under a random 100-bit code and the 30-minute limit is client-side anyway, as `docs/privacy.md` says. A timer set when the code is created would remove it on time.

### I3. Supply chain and release provenance

`.github/workflows/check.yml` pins `actions/checkout@v4` and `actions/setup-node@v4` by tag, not by commit SHA. The workflow holds no secrets and publishes nothing, so a compromised action could only affect CI results. The release zip is built on the maintainer's machine by `npm run package`; builds are reproducible (the fresh build matched the shipped file exactly), so publishing the SHA-256 next to each release, or building the asset in a tagged CI run, would let users verify without rebuilding. The two `npm audit` advisories sit in `moment`, a dependency of the `obsidian` typings package, and never reach the bundle.

### I4. Local plaintext state

Row snapshots, the overdue-event cache and pending work live in Obsidian's `localStorage` in plaintext, and `data.json` holds calendar IDs that are usually email addresses. Both are disclosed in `docs/privacy.md` and `docs/behavior.md`. Backups of the Obsidian profile and the vault contain them. No change needed beyond the existing disclosure.

## Reviewed and found sound

- **OAuth sign-in** (`src/auth.ts:91-139`): PKCE S256 with a 32-byte verifier, a 32-byte `state` checked on every callback, loopback bound to `127.0.0.1` on an OS-chosen port, plain-text callback page (no reflected HTML), 30-minute timeout, server closed in `finally`, a generation counter so a superseded attempt cannot store tokens, granted scopes verified after the exchange, a refresh token required, tokens bound to the client ID, one in-flight refresh at a time, and `invalid_grant` latching into "Reconnect needed" instead of retry loops. Token-endpoint errors are reported generically, so no response body is surfaced.
- **Device transfer** (`src/connection-transfer.ts`): random 20-character base32 code (uniform `byte & 31`, 100 bits), key = SHA-256 of the code, AES-GCM with a fresh 12-byte IV per package, AAD binding version and expiry, strict validation of the decrypted payload, Google validates the token before anything is stored, and a failed import leaves the existing connection intact. Tests cover wrong code, tampered expiry, truncated ciphertext and expiry.
- **Secrets at rest**: only SecretStorage holds tokens and the client secret; `sharedSnapshot()` (`src/device-state.ts:89`) writes nothing but settings and the transfer package to `data.json`; `.gitignore` excludes `data.json`, `main.js`, `.env*` and `output/`; no secret has ever been committed.
- **Network layer**: constant base URLs, every path segment through `encodeURIComponent`, query strings through `URLSearchParams`, field masks on every read, `If-Match` ETags on writes with one re-read on 412, `sendUpdates=none`, no blind retry of a POST, and a guard that refuses to delete a whole recurring series (`src/google.ts:357`).
- **Rendering safety**: notices, tooltips and settings use Obsidian's text APIs; no `innerHTML` anywhere; `cleanTitle` neutralizes HTML, embeds, inline code and line breaks, with a round-trip test suite (`tests/markdown.test.ts:120-136`, `tests/items.test.ts:76`).
- **Note integrity**: compare-and-swap writes in the editor and in `vault.process` (`src/controller.ts:102-123`); only managed regions are rewritten; changes that reach a note outside Obsidian's editor never produce a Google request; only an explicit whole-row deletion deletes, with a 5-second undo window; notes with duplicate markers are left alone and reported.
- **Permissions**: three scopes, and `calendar.events` is the narrowest scope that allows a title `PATCH` on shared calendars.
- **Mobile build**: `Platform.isDesktop` guards the `node:http` import, which esbuild emits as a lazy `require`; `tsconfig.src.json` proves `src/` needs no Node globals.
- **Robustness**: regexes are linear on realistic input; the line diff caps its LCS table at four million cells; settings keys written with `Object.assign` come from plugin-defined controls, not from notes.

## Recommendations in order

1. Restrict `foreignTask()` to enabled task lists (L1).
2. Use `Object.hasOwn` for note-derived keys and make `resolve()` string-only (L2).
3. Escape `](` in remote titles or limit link schemes (L3).
4. Drop an expired transfer package on a timer (I2).
5. Pin GitHub Actions by SHA and publish release checksums (I3).

## What a user accepts by connecting

The plugin can rename, complete, reopen and delete the user's own events, occurrences and tasks under the documented rules, and a crafted note could make one of those actions hit a different item of the user's own. It cannot reach other accounts, create events, send data anywhere but Google, or run code it did not ship with.
