---
layout: default
title: Terms of use
---

# Terms of use

Updated: 19 September 2026

These terms describe use of **Google Calendar Sync by mcaay**, a desktop Obsidian plugin.

## Authorized use

Use the plugin only with Google accounts, calendars, task lists, and Obsidian vaults you are authorized to access. You control the Google OAuth client, consent grant, source selections, and local installation. Google's services and Obsidian remain subject to their respective terms.

## Synchronization behavior

Edits to linked rows can update data in your Google account. An edited local title or completion state takes priority for that field; fields you did not edit retain Google's current values. Offline or failed edits may be retried automatically after connectivity returns. A remote deletion takes priority over an older local row.

The plugin supports title changes, completion changes, creation of dated Google Tasks, and deletion of linked tasks or individual calendar occurrences. Row deletions have a five-second undo window before they are sent to Google. Later native undo recreates a deleted Google Task with a new ID, but cannot restore its recurrence or native reminder time. Deleting all recurring-task occurrences cannot be guaranteed through the public Tasks API. Calendar scheduling and recurrence are managed in Google. Native Google Tasks reminder times are not available through the public Tasks API.

## Availability and responsibility

The plugin is provided as available, without a promise of uninterrupted synchronization or compatibility with every future Google or Obsidian update. Review important changes and maintain backups of your vault. Protect your device, OAuth credentials, and any services used to sync or back up your vault. Nothing in these terms limits rights that applicable law does not allow to be limited.

## Ending use

You can disconnect or disable the plugin at any time. Disconnecting does not erase existing notes or Google data. The [privacy policy](privacy.html) explains authorization revocation, local storage, and removal of local copies.

This is an independent plugin and is not affiliated with or endorsed by Google or Obsidian. For questions, use the repository linked on the [app homepage](index.html).

[Home](index.html) · [Privacy policy](privacy.html)
