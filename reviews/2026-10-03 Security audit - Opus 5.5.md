# Security audit - Opus 5.5

**Model: Opus 5.5 with Max effort.**

## Prompt

> Please perform a fresh security audit of this plugin. Write the results into a new markdown file in this `reviews` folder, with filename beginning with date in ISO format. At the top, clearly state which AI model you are (Opus 5.5 with Max effort). Then quote this prompt. Then write a super concise TLDR section at the top, in which you are not allowed to use more than 1000 characters. Afterwards, write your detailed security audit.

## TLDR

No critical or high severity issues. Google tokens stay on your devices in Obsidian's keychain, the plugin talks only to Google, sign-in uses PKCE with a local callback, and the setup package for a second device is strongly encrypted.

Fix first (Medium): invitations and assigned tasks are written by other people, and their titles keep working Markdown links. A crafted invitation can put a disguised `obsidian://` or phishing link into your daily note, and one click can, for example, create or overwrite a note. Show other people's titles as plain text.

Low: Disconnect does not revoke Google access, and all devices share one refresh token. A desktop without an OS keychain stores it unencrypted, and any other installed plugin can read it. Deleting a meeting you organize silently cancels it for guests (documented). Writes made before Obsidian Sync catches up can help a stale phone copy win.

## Detailed audit

### Scope and method

- **Code:** commit `047be77`. The plugin code is identical to release 0.9.1; the only later commit renamed review files and edited the README.
- **Read in full:** `src/auth.ts`, `src/connection-transfer.ts`, `src/device-connection-settings.ts`, `src/google.ts`, `src/http.ts`, `src/items.ts`, `src/markdown.ts`, `src/sync.ts`, `src/controller.ts`, `src/editor.ts`, `src/main.ts`, `src/device-state.ts` and `src/settings.ts`, plus `docs/privacy.md`, `docs/setup.md`, `docs/behavior.md`, `.github/workflows/check.yml`, `esbuild.config.mjs`, `package.json` and the test harness in `scripts/test-obsidian.mjs`.
- **Platform behavior:** checked in the installed Obsidian 1.13.7 application bundle where the plugin depends on it: SecretStorage, MathJax link filtering, Obsidian Sync conflict resolution and plugin updates.
- **Probes and scans:** malicious titles run through the real `cleanTitle()`, `renderRow()` and `rowKey()`, bundled from `src/` with esbuild. Also scanned the shipped `main.js`, the full git history and `npm audit`, and ran the security-relevant unit tests. Details are under [Verification performed](#verification-performed).

### Threat model

| Actor | Can do | Relevant findings |
| --- | --- | --- |
| Anyone who knows your email address | Send a calendar invitation whose title appears in your daily note | M1, I1 |
| Colleagues | Assign you Google Tasks from Docs or Chat; the plugin requests assigned tasks (`showAssigned`, `src/google.ts:163`) | M1, I1 |
| Another installed Obsidian plugin | Runs with the same privileges as this plugin | L4 |
| Someone with a copy of your vault, backups or Sync history | Reads `data.json` and notes | I2, I3 |
| A stale copy of a note on another device | Competes with your current note in Obsidian Sync | L2 |
| Network attacker | Sees HTTPS traffic to Google only | none found |

Out of scope: a compromised operating system, Google itself, and vulnerabilities inside Obsidian.

### Findings

#### M1. Other people's titles can put active links into your notes (Medium)

`cleanTitle()` (`src/markdown.ts:158-177`) escapes HTML, image and note embeds, inline code and backslashes, but intentionally keeps links working. Event and task titles pass through it in `src/items.ts:32` and `src/items.ts:48`. Probe results:

| Title from Google | Written to the note | Effect |
| --- | --- | --- |
| `![x](https://evil.example/p.png)` | `\![x](...)` | Neutralized, no remote load |
| `<img src=x onerror=alert(1)>` | `\<img ...>` | Neutralized |
| `` `$= dv.el("p", "x")` `` | escaped backticks | Neutralized, no Dataview inline JS |
| `x <!-- gdn:... -->` | `\<!-- gdn:... -->` | Neutralized, `rowKey()` still returns the real key |
| `[Join meeting](obsidian://new?file=Inbox&content=pwned&overwrite=true)` | unchanged | **Clickable link with attacker-chosen text** |
| `[Docs](file:///etc/passwd)` | unchanged | Clickable link |

In Google Calendar an event title is plain text; this plugin renders it as Markdown inside your own trusted note, where a link labelled "Join meeting" looks like your own content. Obsidian's URI `new` action accepts `content` and `overwrite` parameters (Obsidian Help, "Obsidian URI"), so one click can create or overwrite a note. Other community plugins can register further `obsidian://` actions. Plain `https://` phishing links work the same way.

- **Attacker cost:** low. Anyone with your address can send an invitation, and Google adds invitations to the calendar automatically unless the account's invitation setting restricts them. Assigned tasks give colleagues the same channel.
- **Limits:** a click is required. Images, HTML and inline code are already blocked. Obsidian's MathJax configuration refuses `javascript:` in `\href` (`safeProtocols` in 1.13.7), so the math route does not run code.
- **Docs:** `docs/behavior.md:39` correctly says titles cannot load remote content or run inline code, and that links still work. It does not mention that those links can come from other people.
- **Recommendation:** treat titles you did not write as plain text. Escape `[` and `]` and break autolinks for events where you are not the organizer (`organizer.self`, which needs adding to the `EVENT` field mask) and for assigned tasks. At minimum, neutralize every scheme other than `http`, `https` and `mailto` in all titles. Add the payloads above as tests.

#### L1. Disconnect does not revoke access, and devices share one grant (Low)

`disconnect()` (`src/auth.ts:168-172`) only overwrites the local token entry. Google is never asked to revoke it, so the refresh token stays valid until it is revoked in the Google account.

`shareConnection()` and `importConnection()` (`src/auth.ts:141-166`) copy the same refresh token to every device. As a result:

- A lost phone can only be cut off by revoking the whole grant, which disconnects every device.
- A token copied earlier, for example from a keychain backup or by another plugin (L4), keeps working after Disconnect.
- Uninstalling the plugin without disconnecting leaves the token in Obsidian's keychain.

`docs/privacy.md` documents that Disconnect does not revoke and links to Google's connections page, which lowers the severity.

- **Recommendation:** offer **Disconnect and revoke**, which posts the token to `https://oauth2.googleapis.com/revoke` and warns that this disconnects all devices. Mention the revocation link in the Disconnect row as well.

#### L2. Writes before Obsidian Sync catches up can let a stale copy win (Low, integrity)

The plugin writes rows as soon as a note opens or is created, and again when a phone returns to the foreground (`src/main.ts:94`). A device that has not synced for a while may hold an outdated copy, for example a daily note just created from an old template.

In Obsidian 1.13.7, "Automatically merge" does not merge a Markdown file whose versions share no history. If the local copy is younger than 3 minutes, the remote copy wins; otherwise the copy with the newer modification time wins. A plugin write updates the modification time of the stale copy.

On 2026-09-30 a phone copy created from an outdated template replaced a newer desktop version of a daily note, after the plugin had filled the phone copy with Google rows. Whether the plugin's write tipped the decision could not be determined from the desktop alone. The text was recoverable from File Recovery and Sync history.

- **Recommendation:** keep the new README advice to use **Create conflict file**; in that mode Sync keeps the remote copy and saves the local one beside it. Optionally, after startup or resume, hold note writes until Obsidian Sync reports that it is synced. That needs Obsidian's undocumented Sync status, so if it is missing the plugin should fall back to today's behavior.

#### L3. Meeting changes reach other people silently (Low, documented design)

Event PATCH and DELETE requests use `sendUpdates=none` (`src/google.ts:309`, `src/google.ts:361`). Deleting the row of a meeting you organize, with a plain Vim `dd` and a 5 second undo window, cancels it for every guest without notification. Title edits and ✅ / ⬜️ markers on such meetings are visible to guests. Deleting a task assigned from Docs or Chat removes the assignment there.

All of this is disclosed in `docs/behavior.md:84-88` and the README, and it follows the project's explicit-deletion rule. It remains the plugin's largest effect on people other than the user.

- **Recommendation:** fetch `organizer` and `attendees`, and either refuse note deletion of organized meetings with guests or send notifications for them.

#### L4. Token protection depends on the platform and on other plugins (Low)

Obsidian's SecretStorage, as checked in 1.13.7, protects secrets as follows:

- **Desktop:** encrypted with Electron `safeStorage` (macOS Keychain, Windows DPAPI, Linux keyring) and kept in Obsidian's local storage. When `safeStorage` reports that encryption is unavailable, typically Linux without a keyring service, the secrets are stored as plain JSON and Obsidian shows only a dismissible warning.
- **Mobile:** uses the native secure storage plugin.

The public API (`obsidian.d.ts`) does not expose whether encryption is available, so the plugin cannot detect the plaintext case. SecretStorage is also not isolated per plugin: any installed plugin can call `getSecret('google-daily-notes-oauth')` or `listSecrets()`. With the `calendar.events` and `tasks` scopes, that token can read and change all calendars and task lists, not only the selected ones. This is inherent to Obsidian's plugin model, but it is the main path for token theft.

- **Recommendation:** in the README or setup guide, say that the connection is only as safe as the other plugins in the vault, and that Linux desktops need a keyring.

#### I1. Other active syntax in third-party titles (Informational)

The probe confirmed that Obsidian comments (`%%`), math (`$...$`), tags, Tasks plugin date and recurrence emoji, and Dataview inline fields pass through unescaped. They can change how a row renders or how other plugins read it, for example as a recurring task in Tasks queries. No code execution was found. The M1 fix, plain text for other people's titles, covers this as well.

#### I2. Row comments carry account identifiers (Informational)

Each synced row ends in a key that is base64url JSON of kind, calendar or list ID, and item ID. Calendar IDs are often email addresses, and Tasks list IDs embed a numeric account identifier. Publishing, exporting to HTML or sharing a daily note copies these comments into the output source.

- **Recommendation:** mention this in the docs next to the advice about bug reports.

#### I3. Setup package lifetime (Informational)

The device setup design is sound:

- The code has 100 bits of CSPRNG entropy. The mapping is uniform because 256 is a multiple of 32.
- The key is SHA-256 of the code, which is adequate for a random 100-bit secret.
- The package uses AES-GCM with a random 96-bit IV, with the version and expiry bound as additional data.
- The receiving device validates the connection with Google before replacing an existing one.

The package itself holds a long-lived refresh token and the client secret. Copies outlive the 30-minute limit in Sync history and in any vault backup, including git-versioned vaults. The settings tab pre-selects the code for copying, so it can also land in clipboard history. Security then rests on the code staying private for the lifetime of the grant. `docs/privacy.md` already states the first part.

- **Recommendation:** suggest typing the code rather than copying it. Revoke and reconnect if a code may have leaked.

#### I4. Build and supply chain (Informational)

- **Bundle:** there are no runtime dependencies. `main.js` contains only plugin code, with `obsidian`, `@codemirror/*` and `node:http` external. A scan of the shipped `main.js` found only Google endpoints and `127.0.0.1`, and no `eval`, `new Function`, `innerHTML` or console logging in `src/`.
- **Release integrity:** the 0.9.1 release asset `main.js` is byte-identical to a local build, and the community directory rebuilds and compares on its own.
- **npm audit:** two moderate advisories, both for `moment`, a transitive dev dependency of the `obsidian` types package. It is not in the bundle.
- **CI:** `.github/workflows/check.yml` uses actions pinned by tag (`@v4`), not by commit SHA, and declares no `permissions:` block. CI does not publish releases, which limits the impact. Pin by SHA and add `permissions: contents: read`.

### Controls verified as sound

- **OAuth:** each user brings their own Desktop client, so there is no shared client and no developer server. Sign-in uses PKCE S256 and a 256-bit `state`. The callback listener is bound to `127.0.0.1` on a random port, with exact checks for method, path and state, a `text/plain` response, a 30-minute timeout and closure after the flow (`src/auth.ts:91-139`). Granted scopes are verified, and phones cannot start OAuth.
- **Tokens:** access token, refresh token and client secret live only in SecretStorage. `sharedSnapshot()`, `deviceSnapshot()` and `journalSnapshot()` (`src/device-state.ts:81-92`) contain no secrets. Tokens are bound to the client ID, never logged, and sent only to fixed Google hosts. Item IDs are URL-encoded.
- **Data minimization:** field masks limit what Google returns. Calendars and lists start disabled, and only selected sources are read.
- **Deletion authority:**
  - Only whole-row removals from the user's own editor input, deletion, undo or redo reach Google.
  - Sync, git and other file changes arrive as `set` transactions and never delete.
  - Pasted rows with existing IDs become new drafts.
  - Event rows need a local snapshot.
  - Deleting a whole recurring series is refused after re-reading the event from Google.
- **Concurrency:** note writes are compare-and-swap. PATCH uses `If-Match` ETags, and POST is never retried.
- **Docs:** the privacy policy, setup guide and behavior reference match the code on storage locations, scopes, fields, telemetry (none) and effects on other people.

### Recommendations by priority

1. Render links in other people's titles as plain text, or at least block non-web schemes (M1, I1).
2. Add **Disconnect and revoke** and point to Google's connections page (L1).
3. Hold note writes after startup or resume until Obsidian Sync is synced, and keep recommending **Create conflict file** (L2).
4. Protect organized meetings with guests from silent cancellation (L3).
5. Document the plugin and keychain trust boundary, the identifiers in row comments, and careful handling of setup codes (L4, I2, I3).
6. Pin CI actions by SHA and restrict workflow permissions (I4).

### Verification performed

- **Title probe:** ran 10 malicious titles through `cleanTitle()`, `renderRow()` and `rowKey()`. The results are in the M1 table and in I1. Every title round-tripped through `googleTitle()` unchanged.
- **Unit tests:** `npx vitest run` on `tests/auth.test.ts`, `tests/connection-transfer.test.ts`, `tests/markdown.test.ts`, `tests/google.test.ts` and `tests/items.test.ts`: 149 tests passed.
- **Secret scan:** the full git history contains no Google client secrets, access tokens, refresh tokens, API keys or private keys. Tracked files contain no local paths or personal data.
- **Bundle scan:** checked the shipped `main.js` for endpoints and dangerous sinks.
- **Dependencies:** ran `npm audit`.
- **Obsidian 1.13.7 internals:** read the code for SecretStorage, MathJax `safeProtocols`, Obsidian Sync conflict resolution, and plugin updates. Community plugins are never updated automatically, and the optional update check only notifies.

### Limitations

- No live Google requests.
- No click-through of the M1 payload in a running Obsidian.
- No tests on phones.
- No review of Obsidian's own code beyond the parts named above.

Severity reflects a single user running the plugin in a personal vault.
