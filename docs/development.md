# Development

```sh
npm ci
npm run dev            # watch build
npm run check          # lint, tests, type checks, production build
npm run test:obsidian  # real Obsidian, desktop
npm run test:mobile    # real Obsidian, mobile emulation
```

The Obsidian checks start the installed macOS Obsidian with a temporary profile, a test vault and simulated Google responses. They never touch your vault or Google account. Results go to `output/playwright/`.

Start reading at the `How to read this code` comment in `src/main.ts`.

## Release

Set the new version in `manifest.json`, `package.json` and `package-lock.json`, add it to `versions.json`, commit, then:

```sh
git tag -a 0.9.3 -m "Release notes"
git push origin main 0.9.3
```

`.github/workflows/release.yml` tests and builds the plugin, attests `main.js`, `manifest.json` and `styles.css`, and publishes only those files with the tag message as notes.

## Verified

macOS desktop and mobile emulation with simulated Google responses, and a physical iPhone (setup code and sync, 26 September 2026). Android, Windows and Linux are untested.
