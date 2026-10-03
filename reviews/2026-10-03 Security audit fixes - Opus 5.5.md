# Security audit fixes - Opus 5.5

**Implemented by Opus 5.5 with Max effort.**

This note summarizes how the three independent audits of 2026-10-03 were addressed:

- [Fable 5.1](<2026-10-03 Security audit - Fable 5.1.md>)
- [GPT-6 Astra](<2026-10-03 Security audit - GPT-6 Astra.md>)
- [Opus 5.5](<2026-10-03 Security audit - Opus 5.5.md>)

Thanks to all three: they overlapped where it mattered and each found something the others did not.

## Result

Every finding was reproduced before it was fixed. Each has a regression test that failed on the old code and passes now. The fixes shipped in release 0.9.3 (commit `8480220`), with release provenance in 0.9.2 (commit `0f873ed`).

| Finding | Raised by | Resolution |
| --- | --- | --- |
| Titles from other people could add clickable `obsidian://` or `file://` links, math or `%%` comments | Opus M1, I1; Fable L3 | Titles escape links, math and comments. Bare web addresses still link. |
| A forged new-task key could create a task | Astra S1 | Only draft keys this device issued become tasks. |
| A planted row could edit or delete tasks in a list that is not enabled | Fable L1, Astra S2 | Rows without a local snapshot work only in enabled lists. |
| Keys named like `constructor` stopped a note's sync | Fable L2 | Only the plugin's own key forms count; others stay plain text. |
| A retained key could turn a recurring series master into an editable row | Astra S3 | Series masters never become rows, and changes to them are refused. |
| A late token refresh could overwrite a newly imported connection | Astra S4 | A new connection takes over at once; old refreshes cannot store anything. |
| Disconnect left the authorization valid; a changed client ID left the old token | Opus L1, Fable I1 | Disconnect revokes access at Google; a client ID change removes the old token. |
| An expired setup package stayed until the next start | Fable I2 | It is removed within a minute. |
| Deleting a meeting you organize cancelled it silently for guests | Opus L3 | Guests now receive Google's cancellation email. |
| Cached data was kept indefinitely | Astra | Overdue-event lists and draft keys expire after 14 days; Disconnect clears the list. |
| Release and build supply chain | Opus I4, Fable I3, Astra D1 | Releases are built and attested in CI. Actions are pinned by commit, CI is read-only and runs `npm audit`, and `moment` is updated. |
| Trust boundaries were not documented | Opus L4, I2, I3 | The privacy policy notes that other plugins can read SecretStorage, that Linux needs a keyring, that row IDs contain identifiers, and that the setup code should be typed. |

## Not changed, by design

- **Waiting for Obsidian Sync before writing (Opus L2):** this would rely on undocumented Obsidian internals. The README instead recommends Sync's **Create conflict file** setting.
- **Title and ✅ / ⬜️ changes on meetings you organize:** these stay visible to guests, as any edit to a shared event is.
- **Local device state, the client-side transfer expiry and the breadth of OAuth scopes:** these are inherent to the design and disclosed in the documentation (Fable I4, Astra limitations).

## Verification

- **Unit tests:** all 304 pass.
- **Real Obsidian:** the desktop and mobile checks pass. They include a new check that a crafted invitation produces no `obsidian:` or `file:` link and no math in Live Preview or Reading view.
- **CI:** passes, and `npm audit` reports no vulnerabilities.
- **Release 0.9.3:** its files carry GitHub artifact attestations, and its `main.js` matches a local build byte for byte.

## Changes users will notice

- Disconnect now signs out every device that shares the connection.
- Deleting a meeting you organize emails its guests.
- Markdown links in Google titles appear as plain text.
