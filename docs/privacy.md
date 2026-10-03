---
layout: default
title: Privacy policy
---

# Privacy policy

Updated: 3 October 2026

This policy covers **Calendar Sync by mcaay**, an Obsidian plugin.

## What it reads and why

With your permission, the plugin reads your calendar and task list names. For the calendars and lists you select, it reads event and task titles, IDs, dates, times, status and recurrence instances, and task notes, only to recognize tasks it created. Before deleting an event, it checks whether you organize it and whether it has guests. It uses this data only to show and sync items in your daily notes.

- `calendar.calendarlist.readonly`: list your calendars.
- `calendar.events`: read events, change their titles and ⬜️ / ✅ markers, delete single events or occurrences. It never creates events or deletes whole series.
- `tasks`: read, rename, complete, create and delete tasks.

## What it sends

Only requests to Google, over HTTPS: the IDs, titles and status of items you edit, deletions, and new task titles and dates. New tasks carry a short tag in their notes until linked. Other note text, file names and vault contents are never sent. Sign-in returns to a temporary listener on your own device.

There is no developer server, telemetry or advertising, and Google data is never sold, shared, sent to AI services or used for model training. Calendar Sync by mcaay's use and transfer of information received from Google APIs adheres to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements.

## Where data is stored

- **Synced rows:** in your notes. Their hidden IDs include calendar IDs, which are often email addresses.
- **Settings and calendar IDs:** the plugin's `data.json`.
- **Pending edits, snapshots and undo records:** each device's Obsidian local storage. Pending work stays until sent; the rest is removed when no longer needed.
- **Tokens and client secret:** Obsidian SecretStorage. Other installed plugins can read it, and a desktop without an operating system keychain stores it unencrypted.

Your sync service, backups and other plugins decide who else can read your vault.

## Connecting another device

**Create setup code** encrypts the connection with a random 100-bit code (AES-GCM) into `data.json`, for Obsidian Sync to carry. The code is never saved; type it on the other device. The package is removed after import or 30 minutes, but Sync history and backups may keep encrypted copies.

## Disconnecting and deleting

**Disconnect** revokes access at Google and removes the tokens, which signs out every device connected with a setup code. You can also revoke access in your [Google account connections](https://myaccount.google.com/connections). To remove the rest, delete the plugin's rows, its `data.json` and its client secret in Obsidian's keychain, and [clear its device state](behavior.md#device-state). Nothing in Google is deleted.

## Contact

Open an issue in the [GitHub repository](https://github.com/mcaay/obsidian-google-calendar-sync), without private data. GitHub hosts this site under [its privacy statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement); the site has no analytics.

[Home](index.html) · [Terms of use](terms.html)
