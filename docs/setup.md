# Google setup

You need your own Google OAuth client. This setup connects Obsidian directly to Google.

1. Open [Google Cloud Console](https://console.cloud.google.com/) and create or select a project.
2. Enable **Google Calendar API** and **Google Tasks API** for that project.
3. Configure **Google Auth Platform → Branding** and **Audience**. For an external app in Testing, add your own Google account as a test user.
4. In **Clients**, create an OAuth client with application type **Desktop app**. Copy the client ID and client secret into this plugin's settings. A web application client is not interchangeable with a desktop client.
5. Select **Connect Google** and finish Google's consent screen in your browser.
   To use a different browser from your system default, select **Use another browser** and copy the displayed sign-in link into that browser.
6. Assign each calendar to **Google events**, **Recurring**, or **Hidden**. Enable the desired task lists and choose the list for new tasks.

Google may expire refresh tokens after seven days while an external app remains in Testing. Use an appropriate production consent configuration for lasting personal use, subject to your account's Google policies. See [Google's OAuth documentation](https://developers.google.com/identity/protocols/oauth2/native-app) and [token expiration rules](https://developers.google.com/identity/protocols/oauth2#expiration).

## Daily-note template

Add this to your daily-note template. Keep your existing frontmatter properties, adding `google-daily: true` to them rather than adding a second frontmatter block.

```markdown
---
google-daily: true
---

- [ ] google events <!-- gdn:events -->
- [ ] recurring <!-- gdn:recurring -->
- [ ] google tasks <!-- gdn:tasks -->
```

You can also run **Calendar Sync by mcaay: Insert Google daily sections** from the command palette. Use the command in the note or template where you want the groups.

The filename supplies the date: `2026-09-19.md`. For a different naming scheme, add an explicit ISO date property:

```yaml
google-daily: true
google-daily-date: 2026-09-19
```

Use your template system's date substitution to populate that property. The plugin never substitutes today's date for an older daily note.

Place each marked parent row wherever you want. Its indented child rows form that group; the next nonblank row at the parent level ends it. Parent checkbox labels are yours to rename, for example `cykliczne`. You may omit groups you do not need. Each group may appear only once. The plugin preserves content outside the groups and unlinked text inside them. Generated rows follow Obsidian's **Indent using tabs** and **Indent visual width** settings.

The generated rows look like this in Live Preview:

```markdown
- [ ] google events
    - 📅 13:00 (90 min) Planning meeting
- [ ] recurring
    - [ ] 90 min Weekly review
    - [x] 30 min Monthly report
- [ ] google tasks
    - [ ] Buy coffee
    - [ ] 📅 12:00 Call Sam
```

Each synced row also contains an HTML comment identifying the Google item. The editor hides that comment and keeps the cursor out of it. It remains present in the Markdown file, so renaming a row cannot lose its identity. Keep the section markers and row comments intact when editing outside Obsidian.
