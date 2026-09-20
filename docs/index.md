---
layout: default
title: Calendar Sync by mcaay
---

# Calendar Sync by mcaay

Calendar Sync by mcaay is a desktop Obsidian plugin that brings Google Calendar events and scheduled Google Tasks into daily notes as ordinary, editable Markdown rows.

## What it does

- Displays calendar events and dated tasks for the daily note's date, with optional unfinished items from earlier days.
- Lets you edit titles and complete tasks using the keyboard, including Vim mode and Cmd+Enter.
- Treats calendar event titles beginning with ⬜️ or ✅ as optional checkboxes. Completing a recurring event updates that occurrence.
- Creates simple Google Tasks from task rows, using the daily note's date.
- Syncs automatically, every 120 seconds by default and after edits.

Calendar scheduling and recurrence stay in Google. Deleting a synced row in Obsidian deletes its Google task or individual calendar occurrence after a five-second undo window. Late undo recreates a deleted Google Task as a new one-off task. The plugin cannot create calendar events or delete whole calendar series. It cannot guarantee deletion of every occurrence of a recurring Google Task because the public Tasks API provides no series-deletion control. Google's public Tasks API exposes due dates, but not native task times or recurrence details; a typed `📅 13:00` remains part of the title.

## How it connects

You install the plugin in your own Obsidian vault, configure a Google desktop OAuth client, and authorize access through Google. You choose which calendars and task lists appear in your notes.

The plugin runs on your device and communicates directly with Google. It has no hosted synchronization service, telemetry, or advertising. Synced rows and synchronization state are stored in your vault. Credentials use Obsidian's local SecretStorage.

## Policies and contact

- [Privacy policy](privacy.html)
- [Terms of use](terms.html)
- [GitHub repository and contact]({{ site.github.repository_url }})

For support or privacy questions, open an issue in the linked repository. Do not include credentials, private notes, or calendar data in public issues.

This is an independent plugin and is not affiliated with or endorsed by Google or Obsidian.
