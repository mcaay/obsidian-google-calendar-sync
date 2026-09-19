# Google Calendar Sync by mcaay

## Instruction precedence and sources

- Follow the user's current instructions first. Within this file, the project-specific rules below take precedence over the imported Obsidian guidance.
- Preferences are adapted from the user's `ekspertyzy-szkolenia/AGENTS.md`, read on 2026-09-19. Its prohibition on tests is explicitly replaced here. Django, database, website, and production-server instructions do not apply.
- The official Obsidian sample-plugin instructions are reproduced unchanged below the upstream heading. Source: [obsidianmd/obsidian-sample-plugin/AGENTS.md](https://github.com/obsidianmd/obsidian-sample-plugin/blob/f8667cee6b35a068b98fb717626893b911247ff6/AGENTS.md), retrieved 2026-09-19.
- The imported file describes a sample repository. Statements about existing scripts, linting, or CI are reference guidance, not evidence that this project already has those files or capabilities.

## Communication and intent

- Maximize signal to noise. Keep responses concise, concrete, and in plain language.
- Never use en dash or em dash characters in human-facing text, including UI strings, documentation, and responses.
- Understand the intended workflow before implementing the literal wording. Resolve routine choices yourself. Ask only when a material ambiguity cannot be resolved from the request or available context.
- Before substantial implementation, briefly explain the approach and why it fits. This is not a separate approval step.
- Before handoff, reflect on whether the result fits the user's preferences and fix mismatches. Briefly state what changed, what was verified, and any remaining limitation.

## Environment and language

- Development currently takes place on the user's personal macOS. Resolve paths from the project root; do not hardcode personal absolute paths into code or scripts.
- The user delegates language selection. Use TypeScript with strict checking, bundled to JavaScript, to match Obsidian's plugin API.
- Use npm and esbuild unless a concrete requirement justifies changing them.
- Use 4-space indentation in new TypeScript, JavaScript, HTML, and CSS. Preserve existing style when editing established code.
- Decide desktop and mobile support explicitly. Keep `isDesktopOnly` and `minAppVersion` accurate; do not claim support that has not been verified.

## Implementation preferences

- Prefer straightforward code and meaningful names. Avoid abstractions for single-use logic and excessive helper functions.
- Keep `main.ts` focused on plugin lifecycle. Separate distinct responsibilities, such as Google API access, Markdown synchronization, and editor integration, into focused modules. Module boundaries should serve the workflow, not create layers for their own sake.
- Handle failures that can happen in practice, including expired authorization, offline operation, concurrent changes, and API errors. Do not add speculative error handling for impossible states.
- Do not add unrequested features, flexibility, settings, or adjacent refactors.
- Do not refactor working unrelated code or change unrelated comments and formatting.
- Mention unrelated dead code if useful; do not delete it as part of another task. Remove imports, variables, and functions made unused by your own changes.
- Ask whether a senior engineer would find the design overcomplicated. If so, simplify it.

## Comments and reading guides

- Capture user intent, predetermined behavior, and non-obvious decisions beside the code that implements them.
- For new or substantially changed nontrivial flows, include a concise `How to read this code` comment at the main entry point for that flow.
- Give a numbered reading order using actual function names and repository-relative paths for other files. Explain the important inputs, outputs, side effects, and branches, including how each step feeds the next.
- Include one ordinary example and one tricky example when they clarify behavior. Keep the guide focused; do not narrate every helper or split code merely to fit a guide.
- Keep guides accurate as implementation changes. Before handoff, confirm named functions, call order, and examples match the actual code.
- When explaining how to understand or review code, start with the reading order. Build and test commands are separate verification guidance.

## Product constraints

- Optimize for working in Obsidian with Vim and the keyboard. Synced items must be real editable Markdown rows, not a rendered task-query block.
- Preserve the user's control over where events, calendar-based recurring tasks, and Google Tasks appear in a daily note.
- Use the daily note's date as the default date context. Do not show unscheduled Google Tasks.
- Calendar events may have their titles edited. Marker-based events may also have their done status toggled. Explicit row deletion deletes that event or recurring occurrence, never the whole series. Do not create Google Calendar events from Obsidian or modify their scheduling and recurrence from the note.
- Explicit Google Task row deletion deletes the Google task without a confirmation, including recurring tasks, as requested on 2026-09-19. The public Tasks API does not expose recurrence, so do not pretend to detect it or add automatic recurrence markers.
- Row deletions wait five seconds before reaching Google. Native Vim `u` or Cmd+Z within that window cancels deletion; redo starts a fresh window. Preserve pending deadlines across reloads.
- Support creating simple Google Tasks from task rows with the daily note's date. Do not expose recurrence configuration in Obsidian.
- Preserve normal cursor movement and Cmd+Enter checkbox behavior. Avoid surprising remapping of Vim keys.
- Sync automatically on daily-note creation and every 120 seconds by default. Sync status toggles immediately, title edits on returning to Vim normal mode, and non-Vim edits after 10 seconds of inactivity in that note. Reset the periodic timer after an edit-triggered sync.
- Use predetermined, documented conflict and recovery rules. Do not introduce decision popups or a manual sync button.
- Verify Google API capabilities before promising features. Clearly disclose any limits affecting requested task times or recurrence behavior.
- Keep settings and other UI minimal, clean, and consistent with Obsidian.

## Testing and verification

- Automated tests are explicitly required in this project. The source project's `Do not implement tests at all` instruction does not apply.
- Test behavior and affected integration boundaries, not implementation details. Use the smallest sufficient set of meaningful checks.
- Cover Markdown preservation and row identity; daily-note dates, time zones, and overdue filtering; recurring event instance updates; title and checkbox synchronization; task creation; timing and debounce rules; retries, duplicate prevention, conflicts, and offline recovery where implemented.
- Use controlled fixtures or mocked Google responses for automated tests. Use a separate test vault for Obsidian integration checks. Do not overwrite personal notes or modify unrelated Google data while testing.
- Run the relevant automated tests, TypeScript checks, linting, and production build once configured. Fix failures caused by your changes and rerun affected checks.
- Verify editor behavior inside Obsidian when it changes, including Vim movement and mode changes, Cmd+Enter, task-row creation, cursor preservation, and plugin unload/reload as relevant. Unit tests alone do not prove editor integration works.
- For appearance changes, inspect the affected UI visually at relevant window sizes. Check mobile only if mobile support is claimed. Do not tour unrelated UI.
- Documentation-only changes need content and static checks, not an application launch.
- Do not repeat passing checks without a new change, failure, or unresolved concern that warrants them.
- Report exactly what was tested and what could not be verified. Do not claim a live Google or Obsidian check from mocked tests alone. If required verification is blocked, state what is missing and do not claim completion.
- Close only temporary apps, services, and windows started for verification. Preserve the user's existing sessions and work.

## Data safety and Git

- Preserve note content outside managed regions and local edits during synchronization. An explicit full-row deletion in the Obsidian editor authorizes remote deletion. Missing rows from external file changes or plugin refreshes alone do not.
- Keep secrets and access tokens out of source control, logs, fixtures, and responses. Request only the Google permissions needed for the authorized functionality.
- Do not modify unrelated systems or production services.
- Normal source edits and local Git operations are allowed. Pushing, pulling, and rewriting existing commits require an explicit user instruction or permission. Write commit messages in English.
- Never edit Git internals manually or use destructive cleanup to discard the user's work.

## Official Obsidian guidance (upstream)

# Obsidian community plugin

## Project overview

- Target: Obsidian Community Plugin (TypeScript → bundled JavaScript).
- Entry point: `src/main.ts` compiled to `main.js` and loaded by Obsidian.
- Required release artifacts: `main.js`, `manifest.json`, and optional `styles.css`.

## Environment & tooling

- Node.js: use current LTS (Node 18+ recommended).
- **Package manager: npm** (required for this sample - `package.json` defines npm scripts and dependencies).
- **Bundler: esbuild** (required for this sample - `esbuild.config.mjs` and build scripts depend on it). Alternative bundlers like Rollup or webpack are acceptable for other projects if they bundle all external dependencies into `main.js`.
- Types: `obsidian` type definitions.

**Note**: This sample project has specific technical dependencies on npm and esbuild. If you're creating a plugin from scratch, you can choose different tools, but you'll need to replace the build configuration accordingly.

### Install

```bash
npm install
```

### Dev (watch)

```bash
npm run dev
```

### Production build

```bash
npm run build
```

## Linting

- ESLint is preconfigured with `eslint-plugin-obsidianmd` for Obsidian-specific rules.
- Run `npm run lint` to lint the project.
- A GitHub Action automatically lints every commit on all branches.

## File & folder conventions

- **Organize code into multiple files**: Split functionality across separate modules rather than putting everything in `main.ts`.
- Source lives in `src/`. Keep `main.ts` small and focused on plugin lifecycle (loading, unloading, registering commands).
- **Example file structure**:
    ```
    src/
      main.ts           # Plugin entry point, lifecycle management
      settings.ts       # Settings interface and defaults
      commands/         # Command implementations
        command1.ts
        command2.ts
      ui/              # UI components, modals, views
        modal.ts
        view.ts
      utils/           # Utility functions, helpers
        helpers.ts
        constants.ts
      types.ts         # TypeScript interfaces and types
    ```
- **Do not commit build artifacts**: Never commit `node_modules/`, `main.js`, or other generated files to version control.
- Keep the plugin small. Avoid large dependencies. Prefer browser-compatible packages.
- Generated output should be placed at the plugin root or `dist/` depending on your build setup. Release artifacts must end up at the top level of the plugin folder in the vault (`main.js`, `manifest.json`, `styles.css`).

## Manifest rules (`manifest.json`)

- Must include (non-exhaustive):
    - `id` (plugin ID; for local dev it should match the folder name)
    - `name`
    - `version` (Semantic Versioning `x.y.z`)
    - `minAppVersion`
    - `description`
    - `isDesktopOnly` (boolean)
    - Optional: `author`, `authorUrl`, `fundingUrl` (string or map)
- Never change `id` after release. Treat it as stable API.
- Keep `minAppVersion` accurate when using newer APIs.
- Canonical requirements are coded here: https://github.com/obsidianmd/obsidian-releases/blob/master/.github/workflows/validate-plugin-entry.yml

## Testing

- Manual install for testing: copy `main.js`, `manifest.json`, `styles.css` (if any) to:
    ```
    <Vault>/.obsidian/plugins/<plugin-id>/
    ```
- Reload Obsidian and enable the plugin in **Settings → Community plugins**.

## Commands & settings

- Any user-facing commands should be added via `this.addCommand(...)`.
- If the plugin has configuration, provide a settings tab and sensible defaults.
- Persist settings using `this.loadData()` / `this.saveData()`.
- Use stable command IDs; avoid renaming once released.

## Versioning & releases

- Bump `version` in `manifest.json` (SemVer) and update `versions.json` to map plugin version → minimum app version.
- Create a GitHub release whose tag exactly matches `manifest.json`'s `version`. Do not use a leading `v`.
- Attach `manifest.json`, `main.js`, and `styles.css` (if present) to the release as individual assets.
- After the initial release, follow the process to add/update your plugin in the community catalog as required.

## Security, privacy, and compliance

Follow Obsidian's **Developer Policies** and **Plugin Guidelines**. In particular:

- Default to local/offline operation. Only make network requests when essential to the feature.
- No hidden telemetry. If you collect optional analytics or call third-party services, require explicit opt-in and document clearly in `README.md` and in settings.
- Never execute remote code, fetch and eval scripts, or auto-update plugin code outside of normal releases.
- Minimize scope: read/write only what's necessary inside the vault. Do not access files outside the vault.
- Clearly disclose any external services used, data sent, and risks.
- Respect user privacy. Do not collect vault contents, filenames, or personal information unless absolutely necessary and explicitly consented.
- Avoid deceptive patterns, ads, or spammy notifications.
- Register and clean up all DOM, app, and interval listeners using the provided `register*` helpers so the plugin unloads safely.

## UX & copy guidelines (for UI text, commands, settings)

- Prefer sentence case for headings, buttons, and titles.
- Use clear, action-oriented imperatives in step-by-step copy.
- Use **bold** to indicate literal UI labels. Prefer "select" for interactions.
- Use arrow notation for navigation: **Settings → Community plugins**.
- Keep in-app strings short, consistent, and free of jargon.

## Performance

- Keep startup light. Defer heavy work until needed.
- Avoid long-running tasks during `onload`; use lazy initialization.
- Batch disk access and avoid excessive vault scans.
- Debounce/throttle expensive operations in response to file system events.

## Coding conventions

- TypeScript with `"strict": true` preferred.
- **Keep `main.ts` minimal**: Focus only on plugin lifecycle (onload, onunload, addCommand calls). Delegate all feature logic to separate modules.
- **Split large files**: If any file exceeds ~200-300 lines, consider breaking it into smaller, focused modules.
- **Use clear module boundaries**: Each file should have a single, well-defined responsibility.
- Bundle everything into `main.js` (no unbundled runtime deps).
- Avoid Node/Electron APIs if you want mobile compatibility; set `isDesktopOnly` accordingly.
- Prefer `async/await` over promise chains; handle errors gracefully.

## Mobile

- Where feasible, test on iOS and Android.
- Don't assume desktop-only behavior unless `isDesktopOnly` is `true`.
- Avoid large in-memory structures; be mindful of memory and storage constraints.

## Agent do/don't

**Do**

- Add commands with stable IDs (don't rename once released).
- Provide defaults and validation in settings.
- Write idempotent code paths so reload/unload doesn't leak listeners or intervals.
- Use `this.register*` helpers for everything that needs cleanup.

**Don't**

- Introduce network calls without an obvious user-facing reason and documentation.
- Ship features that require cloud services without clear disclosure and explicit opt-in.
- Store or transmit vault contents unless essential and consented.

## Common tasks

### Organize code across multiple files

**main.ts** (minimal, lifecycle only):

```ts
import { Plugin } from 'obsidian';
import { MySettings, DEFAULT_SETTINGS } from './settings';
import { registerCommands } from './commands';

export default class MyPlugin extends Plugin {
	settings!: MySettings;

	async onload() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<MySettings>,
		);
		registerCommands(this);
	}
}
```

**settings.ts**:

```ts
export interface MySettings {
	enabled: boolean;
	apiKey: string;
}

export const DEFAULT_SETTINGS: MySettings = {
	enabled: true,
	apiKey: '',
};
```

**commands/index.ts**:

```ts
import { Plugin } from 'obsidian';
import { doSomething } from './my-command';

export function registerCommands(plugin: Plugin) {
	plugin.addCommand({
		id: 'do-something',
		name: 'Do something',
		callback: () => doSomething(plugin),
	});
}
```

### Add a command

```ts
this.addCommand({
	id: 'your-command-id',
	name: 'Do the thing',
	callback: () => this.doTheThing(),
});
```

### Persist settings

```ts
interface MySettings { enabled: boolean }
const DEFAULT_SETTINGS: MySettings = { enabled: true };

async onload() {
  this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<MySettings>);
  await this.saveData(this.settings);
}
```

### Register listeners safely

```ts
this.registerEvent(
	this.app.workspace.on('file-open', (f) => {
		/* ... */
	}),
);
this.registerDomEvent(activeWindow, 'resize', () => {
	/* ... */
});
this.registerInterval(
	window.setInterval(() => {
		/* ... */
	}, 1000),
);
```

## Troubleshooting

- Plugin doesn't load after build: ensure `main.js` and `manifest.json` are at the top level of the plugin folder under `<Vault>/.obsidian/plugins/<plugin-id>/`.
- Build issues: if `main.js` is missing, run `npm run build` or `npm run dev` to compile your TypeScript source code.
- Commands not appearing: verify `addCommand` runs after `onload` and IDs are unique.
- Settings not persisting: ensure `loadData`/`saveData` are awaited and you re-render the UI after changes.
- Mobile-only issues: confirm you're not using desktop-only APIs; check `isDesktopOnly` and adjust.

## References

- Obsidian sample plugin: https://github.com/obsidianmd/obsidian-sample-plugin
- API documentation: https://docs.obsidian.md
- Developer policies: https://docs.obsidian.md/Developer+policies
- Plugin guidelines: https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines
- Style guide: https://help.obsidian.md/style-guide
