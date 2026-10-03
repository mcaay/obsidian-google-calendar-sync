import { MarkdownView, type Plugin } from 'obsidian';

const ATTRIBUTE = 'data-gdn-own-properties';

/**
 * How to read this code:
 * 1. styles.css hides the plugin's own properties, google-daily and
 *    google-daily-date, in Live Preview and Reading view.
 * 2. markOwnProperties() gives every Markdown view the number of those
 *    properties its note has, read from the metadata cache.
 * 3. styles.css hides the properties container when Obsidian's live
 *    `data-property-count` equals that number, so the container holds nothing
 *    else. This avoids a `:has` selector, which Obsidian's review flags.
 * Ordinary: a daily note with only `google-daily: true` shows no empty
 *    properties box.
 * Tricky: a property added in the properties editor raises the live count at
 *    once, so the container appears before the metadata cache catches up.
 */
export function markOwnProperties(plugin: Plugin): void {
    const { app } = plugin;
    const mark = () => {
        for (const leaf of app.workspace.getLeavesOfType('markdown')) {
            if (!(leaf.view instanceof MarkdownView)) continue;
            const frontmatter = leaf.view.file ? app.metadataCache.getFileCache(leaf.view.file)?.frontmatter : undefined;
            const keys = Object.keys(frontmatter ?? {}).map(key => key.toLowerCase());
            // Like the old selector, only a note with google-daily qualifies.
            const own = keys.includes('google-daily') ? (keys.includes('google-daily-date') ? 2 : 1) : 0;
            if (own) leaf.view.containerEl.setAttribute(ATTRIBUTE, String(own));
            else leaf.view.containerEl.removeAttribute(ATTRIBUTE);
        }
    };
    plugin.registerEvent(app.workspace.on('layout-change', mark));
    plugin.registerEvent(app.workspace.on('file-open', mark));
    plugin.registerEvent(app.metadataCache.on('changed', mark));
    plugin.register(() => {
        for (const leaf of app.workspace.getLeavesOfType('markdown')) leaf.view.containerEl.removeAttribute(ATTRIBUTE);
    });
    mark();
}
