---
layout: default
title: Privacy policy
---

# Privacy policy

Updated: 19 September 2026

This policy describes **Google Calendar Sync by mcaay**, a desktop Obsidian plugin.

## Google data accessed and used

After you authorize access, the plugin retrieves calendar names, identifiers, and access permissions, and Google Tasks list names and identifiers so you can select sources. For selected sources, it requests event and task records to display scheduled items in daily notes and synchronize edits. It uses event titles, identifiers, start and end dates and times, status, and recurrence instance information, plus task titles, identifiers, due dates, completion status, and notes used to recognize tasks it created. Google API responses can contain additional fields that the plugin does not use or persist.

The plugin requests these Google permissions:

- `calendar.calendarlist.readonly`: list available calendars and their access permissions.
- `calendar.events`: read events, update edited titles and title-based completion markers, and delete individual events or recurring occurrences when their rows are deleted in Obsidian. The plugin does not create events, delete whole recurring calendar series, or change scheduling or recurrence.
- `tasks`: read, rename, complete, reopen, create, and delete tasks.

These Google permissions allow broader operations than the plugin implements. The plugin uses Google data only to provide its visible calendar and task synchronization features.

## Data sent to Google

The plugin sends authorization credentials to Google's OAuth endpoints and authenticated requests to Google's Calendar and Tasks APIs. Synchronization requests include the relevant calendar, list, event, or task identifiers; edited titles and completion status; deletion requests; and new task titles and due dates. New tasks briefly receive a unique reconciliation tag in their Google task notes to help prevent duplicate creation. The tag is removed once the Google task ID is saved locally, preserving user descriptions.

The plugin does not send other note text, vault filenames, or the contents of your vault to Google. Google processes API requests under its own policies. Communication with Google uses HTTPS; the browser sign-in callback uses a temporary HTTP listener restricted to your own device's loopback interface.

## Local storage and retention

Synced rows are stored in your Markdown notes. The plugin's local `data.json` stores source selections, item identifiers and snapshots, note paths, synchronization state, pending edits, and deleted-task snapshots and replacement IDs for native undo. OAuth tokens and the OAuth client secret are stored through Obsidian SecretStorage, separately from `data.json`. This is Obsidian-managed storage; the plugin does not provide its own encryption of your vault or guarantee that every storage location is encrypted.

Local notes and plugin state remain until you remove them. There is no automatic age-based deletion of stored notes or synchronization state. Your own vault synchronization, backups, publishing settings, other plugins, and device access can affect who can access local files. Those services and settings are outside this plugin's control.

## Sharing and other uses

The plugin has no developer-operated synchronization server and does not transmit Google user data to its maintainer. It has no telemetry or advertising. It does not sell Google user data, use it for advertising, or send it to AI services or use it for model training.

Google Calendar Sync by mcaay's use and transfer of information received from Google APIs adheres to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements.

## Disconnecting and deleting data

Select **Disconnect** in the plugin settings to remove locally stored OAuth tokens and stop authenticated synchronization. This does not remove the OAuth client secret, existing Markdown rows, cached synchronization state, pending edits, or data in Google.

To revoke the Google authorization, remove the app from your [Google account connections](https://myaccount.google.com/connections). To remove local copies, disable the plugin, remove its synced Markdown rows and plugin data, and clear its client secret from Obsidian SecretStorage. Remove copies from your backups or other vault storage services if desired. Removing local data while the plugin is disabled does not delete events or tasks from Google. While enabled, explicitly deleting a synced row in Obsidian sends a deletion request to Google.

## This documentation site and contact

GitHub hosts these public documentation pages. Visits to the site are subject to [GitHub's privacy statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement). The site adds no analytics or advertising scripts and has no Google account connection of its own.

For questions, contact the maintainer through the GitHub repository linked on the [app homepage](index.html). Public issue reports are visible to others, so do not include private data or credentials. This policy will be updated when the plugin's data practices change.

[Home](index.html) · [Terms of use](terms.html)
