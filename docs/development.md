# Development

```sh
npm ci
npm run dev          # Watch build
npm run check        # Lint, behavior tests, strict type check, production build
npm run test:obsidian
npm run package
```

`test:obsidian` launches the installed macOS Obsidian application with a separate temporary profile and test vault. It uses a fixture-only entry point and simulated Google responses. It does not access your actual vault or Google account. Screenshots and results are written under `output/playwright/`.

Production builds enter at `src/main.ts`; test fixtures are never bundled into the installable plugin. Start reading the implementation at the `How to read this code` comment in that file.

The automated tests cover Markdown preservation, row protection, dates and DST, overdue filtering, Google request bodies and pagination, conflict handling, task reconciliation, OAuth refresh, and scheduler timing. The app checks cover actual editor behavior. A successful test run with fixtures does not establish a live connection to your Google account.
