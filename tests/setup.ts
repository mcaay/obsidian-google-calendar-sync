// Obsidian runs plugins in a browser window, where `window` is the global
// object. Node has no `window`, so plugin code calling window.setTimeout needs it.
Object.assign(globalThis, { window: globalThis });
