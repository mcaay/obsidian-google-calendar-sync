# Development

```sh
npm ci
npm run dev          # Watch build
npm run check        # Lint, behavior tests, strict type checks, production build
npm run test:obsidian
npm run test:mobile
npm run package
```

`test:obsidian` launches the installed macOS Obsidian application with a separate temporary profile and test vault. It uses a fixture-only entry point and simulated Google responses. It does not access your actual vault or Google account. Screenshots and results are written under `output/playwright/`. Set `GDN_EDITOR_ONLY=1` to run only the editor scenarios in `scripts/test-editor-scenarios.mjs`.

Production builds enter at `src/main.ts`; test fixtures are never bundled into the installable plugin. Start reading the implementation at the `How to read this code` comment in that file.

The automated tests cover Markdown preservation, row protection, dates and DST, overdue filtering, Google request bodies and pagination, conflict handling, task reconciliation, OAuth refresh, and scheduler timing. `tests/editor.test.ts` runs the editor extension with CodeMirror's real undo history and a real sync engine; `tests/google.test.ts` checks the overdue-event list against a full reading from a simulated Calendar server. The app checks cover actual editor behavior and the settings tab, including validation, the sign-in link and settings search. A successful test run with fixtures does not establish a live connection to your Google account.

`npm run typecheck` also checks `src` without Node globals (`tsconfig.src.json`), because the mobile runtime has none. The GitHub workflow in `.github/workflows/check.yml` runs lint, both type checks, the unit tests and the production build.

`test:mobile` uses Obsidian's mobile UI emulation at phone width. It verifies metadata hiding, checkboxes, task editing and creation, Source mode, foreground refresh, and device state isolation. The mobile runtime test also loads the production bundle without Node, Electron or Buffer. Desktop-only HTTP is loaded lazily when starting desktop OAuth.

Verified here: macOS desktop and mobile UI emulation with mocked Google responses. On 26 September 2026, the user also confirmed that setup by code and independent Google sync worked on a physical iPhone with Obsidian closed on the Mac. Android is untested, and native Windows/Linux installations still need verification. The iPhone check does not cover every editing or app-suspension scenario.

The installed Obsidian 1.13.7 can emit a native-window `getZoomFactor` exception in the isolated desktop profile. It also occurs with the unchanged 0.8.2 plugin. The harness records that exact core exception separately in `hostErrors`; other renderer exceptions fail the checks.
