**AI model:** GPT-6 Astra with Extra High effort, as specified in the request. Runtime model and effort metadata were not independently available.

> Please perform a fresh security audit of this plugin. Write the results into a new markdown file in this reviews folder, with filename beginning with date in ISO format. At the top, clearly state which AI model you are (GPT-6 Astra with Extra High effort). Then quote this prompt. Then write a super concise TLDR section at the top, in which you are not allowed to use more than 1000 characters. Afterwards, write your detailed security audit.

## TLDR

Four medium-severity issues reproduced with synthetic data: forged draft markers can create Google Tasks without a local edit; forged task rows can target disabled lists; a crafted calendar row can update a recurring series; and a delayed token refresh can overwrite an imported connection. No high or critical vulnerability was confirmed. OAuth PKCE, transfer encryption, title escaping and deletion safeguards provide useful protection. All 279 existing tests, lint, type checks and production build passed. npm reports one Moment advisory through the development-only Obsidian dependency; Moment is absent from the plugin bundle. Fix the four trust-boundary issues before treating externally modified notes and account replacement as safe. No live Google or Obsidian UI security testing was performed.

## Security audit

### Scope and method

- **Date:** 2026-10-03, Europe/Warsaw.
- **Plugin:** Calendar Sync by mcaay, version 0.9.1.
- **Commit:** `047be77ca2db2d04efbe4d73a681aa08e55747ba`. The tracked working tree was clean before the audit.
- **Reviewed:** all 18 source modules, authentication and device transfer, editor-to-sync authorization, Google request construction, persistence, dependencies, build/package configuration, CI, relevant tests and privacy/behavior documentation.
- **Freshness:** findings were derived from current code and new probes, without reading earlier reviews.
- **Changes:** this report and ignored local reproduction files only. No implementation or dependency fixes were applied.

The main assets are Google credentials, calendar/task integrity, and private note content. Relevant untrusted inputs include invitation/task titles and Markdown arriving through synchronization, restoration or external file edits. OAuth responses and installed application code are trusted for this assessment. A malicious installed plugin or an attacker controlling executable files already has a much broader foothold; none of S1 through S3 requires changing plugin code or stealing OAuth credentials.

The three Markdown findings require an attacker or faulty external tool to supply note content. S1 additionally requires a disclosed draft-owner identifier. S2 and S3 require known Google resource identifiers and subsequent user interaction. These are not unauthenticated internet attacks. S4 is a connection-lifecycle race that can occur without an attacker.

Severity reflects these prerequisites and the resulting Google-side effects. The probes confirm the plugin's behavior and outgoing request selection using mocks, not execution against real accounts.

### Findings

| ID | Severity | Finding | Evidence |
| --- | --- | --- | --- |
| S1 | Medium | Public draft-owner prefix authorizes new task creation | Reproduced without an editor event or existing outbox entry |
| S2 | Medium | Foreign task metadata authorizes writes to an unselected list | Reproduced through CodeMirror deletion and the sync engine |
| S3 | Medium | Retained calendar metadata permits recurring-series updates | Reproduced through loading, editor interaction and request construction |
| S4 | Medium | An old refresh can overwrite newly imported credentials | Reproduced with controlled asynchronous token responses |
| D1 | Informational for this plugin | Known Moment advisory in development dependencies | Live npm audit; bundle inspection found no Moment code |

#### S1. A forged draft marker creates a task without a local editor decision

**Evidence:** [owns()](../src/sync.ts:182), [draftKey()](../src/sync.ts:204), [stage()](../src/sync.ts:293).

`owns()` accepts any key beginning with `new:<runtimeOwner>:`. The owner UUID is included in draft rows that can be synchronized or backed up. It identifies a device but cannot authenticate a new creation request. `stage()` turns matching rows into task creations even when the device has never issued that exact key and its edit journal is empty.

**Reproduction:** an enabled daily note contained this externally supplied row under its Google Tasks heading:

```markdown
    - [ ] Injected from external file <!-- gdn:new:public-owner-from-a-synced-draft:invented -->
```

With the corresponding owner identifier and a configured default list, an ordinary `engine.run(path, true)` invoked `Remote.insert()` once. The journal, outbox and created-ID map were initially empty. No editor input, paste, deletion or undo occurred. The arbitrary `invented` suffix also bypassed age checking because it contained no recognized timestamp. A correctly formatted fresh suffix would still exploit the ownership check.

**Impact and prerequisites:** someone able to read a pending draft marker and write synchronized Markdown can make the connected device create arbitrary Google Tasks during automatic sync. An accidental marker copy can have the same effect. The device identifier is not present in every completed row, so this attack requires obtaining it from a draft or another exposed copy. It does not expose OAuth tokens or create Calendar events.

**Fix:** record each exact locally issued draft key durably when the editor creates it. Require that record before permitting the first POST. Preserve the intended ability to edit an already authorized draft from another device. Tightening key syntax or making the owner UUID longer does not establish authorization.

**Regression criterion:** externally injected keys with a known owner and valid fresh syntax must remain local; genuine locally issued drafts must still survive reloads and synchronize once.

#### S2. An unverified task row can delete or edit a task in a disabled list

**Evidence:** [editorRows()](../src/editor.ts:87), [foreignTask()](../src/sync.ts:220), [target()](../src/sync.ts:319), [queueDeletions()](../src/sync.ts:409), [GoogleClient.remove()](../src/google.ts:345).

For a row without a trusted local snapshot, the editor decodes the hidden base64 identity and constructs a task with `writable: true`. The sync engine has the same fallback. Neither checks that the encoded list is selected or that the visible row corresponds to a task previously fetched from Google. Task deletion then sends DELETE directly to the supplied list/task IDs.

**Reproduction:** a synthetic daily note contained a harmless-looking checkbox whose identity encoded `['task', 'disabled-list', 'unrelated-task']`. That list was explicitly disabled, and no local snapshot existed. A normal whole-row CodeMirror deletion passed the plugin filters. After advancing the five-second deadline, the engine invoked `Remote.remove()` for the disabled list and unrelated task. No remote load or identity verification had occurred. Title and checkbox edits reach the same foreign-task fallback through `target()`.

**Impact and prerequisites:** a person or tool supplying Markdown can redirect a user's apparent row action to another known task accessible to the Google account. Google-side permissions still apply. The user must act before a successful refresh replaces or removes the forged row; an offline or delayed refresh makes that window longer. The hidden marker makes the redirected target difficult to notice in Live Preview.

**Fix:** treat foreign identities as unresolved until an automatic fetch verifies the item through an enabled source and establishes a local snapshot. Apply the same rule in the editor and engine. Preserve already authorized queued operations when a source is later disabled; this finding concerns granting new authority to unverified content, not the documented completion of existing pending work.

**Regression criterion:** deleting, renaming or toggling an unverified row for a disabled source must send nothing. A legitimate row from another device should become editable after verification.

#### S3. A crafted retained row can update a recurring Calendar series

**Evidence:** [retained()](../src/sync.ts:175), [retained-event fetching](../src/google.ts:142), [eventItem()](../src/items.ts:12), [patch()](../src/google.ts:280). Compare the existing [series-deletion guard](../src/google.ts:352).

Normal calendar listings use `singleEvents=true`. However, checked Markdown rows can also request events directly by ID. That route accepts a parent recurring event. `eventItem()` does not reject a record with `recurrence` and no `recurringEventId`, so the parent becomes a writable daily-note row. The PATCH preflight fetch omits recurrence fields and has no corresponding series guard.

**Reproduction:** a checked row encoded a known series-master ID in an enabled writable calendar. The mocked daily listing returned no items; the retained-ID fetch returned a weekly series beginning before the note date. The engine rendered it and stored a writable snapshot. A normal title edit then emitted:

```text
PATCH https://www.googleapis.com/calendar/v3/calendars/calendar/events/series-master?sendUpdates=none
{"summary":"⬜️ Changed series title"}
```

**Impact and prerequisites:** a crafted or corrupted note can turn a daily-row title edit or completion marker change into a series-level modification. This requires a known master ID and user interaction after the crafted row is loaded. Whole-series effects are inferred from Google's documented resource model; the probe confirmed the parent-ID PATCH, not a live series change. Google distinguishes parent recurrence resources from individual instances and requires the instance ID for an instance-only change. [Google recurring-event documentation](https://developers.google.com/workspace/calendar/api/guides/recurringevents), [Events.patch reference](https://developers.google.com/workspace/calendar/api/v3/reference/events/patch).

The existing DELETE guard correctly rejects a series master. This finding concerns updates, not a demonstrated whole-series deletion.

**Fix:** reject series masters when converting fetched records into daily rows. Also request `recurrence,recurringEventId` in the PATCH preflight and reject parent resources there, protecting against stale or forged stored state.

**Regression criterion:** retained master IDs must never produce writable rows or PATCH requests; ordinary events and individual recurring instances must continue to work.

#### S4. A delayed refresh overwrites an imported Google connection

**Evidence:** [exchange()](../src/auth.ts:52), [token()](../src/auth.ts:82), [importConnection()](../src/auth.ts:147), [dispose()](../src/auth.ts:174).

Refresh operations capture `generation` and check it before storing credentials. Disconnect advances that generation, but a successful imported connection does not. A refresh started under connection A can therefore finish after importing B and still pass the guard. When its response omits a replacement refresh token, `exchange()` combines A's access token with the refresh token currently in storage, which now belongs to B.

**Reproduction:** using one OAuth client ID, the probe started a refresh with synthetic A credentials, held its response, imported a valid encrypted B package, and confirmed that `token()` returned B. It then released A's successful response. Stored credentials became:

```text
access = late-access-a
refresh = refresh-b
```

Subsequent `token()` calls returned A's access token while the connection remained reported as connected.

**Impact and prerequisites:** replacing an existing connection while a refresh is outstanding can cause subsequent requests to use the previous Google authorization until that access token expires. Different accounts must use the same OAuth client ID for the cross-account variant. Shared calendars accessible to both accounts can receive writes under the wrong principal; other resources may fail authorization. Actual cross-account writes were not tested.

**Fix:** make successful connection replacement an atomic generation change before storing the new credentials. Detach the old refresh promise and prevent its completion or cleanup from affecting the new generation. Capture the old refresh token at request start instead of borrowing one from mutable storage. Keep the existing connection intact when import validation fails.

**Regression criterion:** delayed success and `invalid_grant` responses from A must neither overwrite B nor mark B disconnected after import. Failed imports must preserve A.

#### D1. Moment advisory is present but has no identified plugin execution path

The live `npm audit --json` result reported **two moderate package entries from one underlying advisory**: `moment` and its direct dependent `obsidian`. The installed chain is `obsidian@1.13.1 -> moment@2.29.4`; both belong to the development dependency tree. See [locked Moment version](../package-lock.json:2408).

The maintainer advisory, **GHSA-4p3w-j4w9-5jqw / CVE-2026-17495**, describes path traversal when Node-side `moment.locale()` receives a crafted non-string value. It affects versions before 2.31.0 in the listed range and is fixed in 2.31.0. [Moment security advisory](https://github.com/moment/moment/security/advisories/GHSA-4p3w-j4w9-5jqw).

The production-equivalent esbuild dependency graph contained only the 18 plugin source files, with Obsidian, CodeMirror and `node:http` external. Moment was absent, and the plugin has no Moment locale call. This is therefore dependency maintenance work, not a confirmed exploitable vulnerability in the shipped plugin. The host application's own dependency security was outside scope.

**Action:** update the development dependency chain when compatible, or evaluate a tested Moment override. Do not run the suggested forced audit fix blindly: npm proposed downgrading Obsidian typings to 0.14.5, incompatible with the API version this project targets.

### Controls that held up under review

- **OAuth:** a temporary listener binds to `127.0.0.1` on an ephemeral port; callback requests require GET, the expected path and a random state. The verifier and state each use 32 random bytes, with S256 PKCE. Tests cover rejection of wrong state, missing scopes and stale refresh completion after disconnect. This matches the relevant structure of [Google's installed-app OAuth guidance](https://developers.google.com/identity/protocols/oauth2/native-app). The imported-connection race remains S4.
- **Credential storage and transfer:** raw tokens use Obsidian SecretStorage, not shared `data.json`. Transfer uses AES-GCM, a random 96-bit IV and a generated 100-bit code. Version/expiry are authenticated as additional data. Tests reject wrong codes, modified ciphertext/expiry and expired transfers. This review does not establish the host's encryption-at-rest properties.
- **Network destinations and payloads:** production requests use fixed Google OAuth, Calendar and Tasks endpoints. Resource identifiers are encoded; bearer credentials go in headers. Request bodies contain authorized item fields or task-creation markers. No telemetry endpoint, dynamic remote code execution or transmission of whole notes was found in the reviewed source.
- **Remote-title handling:** `cleanTitle()` flattens CR/LF and escapes HTML openings, embeds and backticks. Existing tests cover injection of comment markers, images and inline code. UI construction uses text-oriented APIs; no direct `innerHTML`, `eval()` or `new Function()` sink was found in production source. Host rendering and third-party Markdown processors were not tested live.
- **Deletion and recovery:** full-row editor deletion is distinguished from external file disappearance; pending deletions retain five-second deadlines and undo decisions. Calendar DELETE checks for series masters. Uncertain task POSTs use persisted reconciliation markers. Tests cover these behaviors, but they do not establish that a row's identity was trustworthy; S1 through S3 address that boundary.
- **Data preservation:** compare-and-swap note writes, serialized sync, conditional PATCH requests, source-failure preservation and storage read-back checks reduce accidental loss. Tests cover offline recovery, conflicting edits and native-history logic with mocked host integration.
- **Packaging:** all 199 locked package entries had integrity metadata and npm registry URLs. The package script uses a fixed file allowlist. No real credential-shaped match was found in the focused current-source, test, script and documentation scan. That scan was not a full Git-history secret audit.

### Accepted limitations and further hardening

These observations are separate from the four reproduced findings:

- The 30-minute transfer expiry is enforced by this client, not by destruction of the encrypted refresh token. Anyone retaining both ciphertext and code can decrypt outside that check. The privacy policy already explains this, and **Disconnect** is documented as local credential removal rather than Google revocation. [Current disclosure](../docs/privacy.md:36).
- Calendar/task OAuth scopes grant broader account access than selected sources. Local selection is not a Google-issued capability restriction. Keep write authorization checks explicit within the plugin.
- Pending work and cached state are not bound to a verified Google account identity. Beyond S4, account replacement deserves separate tests for retained queues and shared calendars. No independent end-to-end exploit of queue migration between accounts was established here.
- Persisted settings and legacy state receive limited runtime validation. In particular, legacy desktop migration intentionally trusts pending operations in old shared data. Protecting against hostile settings files would require a defined migration trust policy. Malformed or oversized persisted data remains an availability-hardening area.
- Cached overdue-event data is not pruned with the 14-day note-snapshot rule, and disconnect retains caches. This is a retention consideration, not a token leak. CI also uses mutable action tags and lacks an advisory-check step; immutable action references and dependency monitoring would improve build hygiene.

### Verification and limits

| Check | Result |
| --- | --- |
| ESLint, via `npm run check` | Passed |
| Maintained automated suite | 279 tests passed across 10 files |
| Both TypeScript configurations | Passed through `npm run build` |
| Production build | Passed |
| New security probes | Four passed by reproducing S1 through S4, not by proving them fixed |
| Live npm advisory query | One underlying Moment advisory, two moderate package entries |
| Production dependency graph | No bundled Moment or other third-party package code |
| Focused credential-pattern scan | No matches; current selected files only |
| Report/static checks | Prompt quoted, TLDR below 1,000 characters, file references checked |

The initial sandboxed test run passed 276 tests and failed three OAuth tests solely because binding a localhost socket was denied. Re-running the maintained suite with localhost permission passed all 279. The initial npm audit failed DNS resolution; the subsequent permitted registry query succeeded. These were environment restrictions, not plugin failures.

The additional [probe source](../output/security-audit-2026-10-03/probes.test.ts) and [configuration](../output/security-audit-2026-10-03/vitest.config.mts) remain in ignored local output. From the repository root, reproduce them with:

```sh
node node_modules/vitest/vitest.mjs run --config output/security-audit-2026-10-03/vitest.config.mts --reporter verbose
```

These probes use production modules, real CodeMirror state transitions where relevant, synthetic notes and mocked Google transports. They do not belong to the maintained suite and will not accompany a clone unless copied separately. Each finding above includes its reproduction sequence and a regression criterion for the eventual fix.

No personal notes, Google accounts, live OAuth grants or user credentials were accessed for the probes. No live Google mutations, Obsidian UI security checks, mobile-device checks, host SecretStorage inspection, full-history secret scan or published-release binary comparison was performed. The audit establishes the documented code paths and local reproductions; it does not certify the plugin or its host as vulnerability-free.
