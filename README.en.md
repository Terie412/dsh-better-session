# dsh-better-session

[简体中文](README.md) | English

Better session management for DeepSeek Harness: batch archive, permanent deletion, and one place to manage every archived session.

> ⚠️ **Deletion cannot be undone.** Sessions are removed from disk rather than moved to a recycle bin, so the space is genuinely reclaimed. Every deletion asks for confirmation first.

## Why you might want this

Harness has archiving built in, but archiving only hides a session from the list — the file stays on disk. As sessions pile up, the ones actually taking up space never get cleaned out, and the built-in UI offers no batch actions.

This plugin adds three things:

- **Multi-select** sessions in the sidebar to archive or delete a batch at once
- A dedicated **settings page** that gathers every archived session for one-by-one or batch restore
- An entry point that **actually deletes** a session

## Install

Run this in a terminal, replacing `web` with the profile you actually use (for example `desktop`):

```sh
dsh plugin --profile web add git@github.com:Terie412/dsh-better-session.git
```

The HTTPS address works just as well:

```sh
dsh plugin --profile web add https://github.com/Terie412/dsh-better-session.git
```

Once installed, open **Settings → Plugins** and check that `dsh-better-session` is turned on. If it has not appeared in the list yet, restart Harness once.

## How to use it

### Sidebar context menu

Right-click any session and the bottom of the menu gains a few extra entries:

| Entry | What it does |
| --- | --- |
| Select multiple | Enters multi-select mode with this session already selected |
| Archive session | Built-in Harness behaviour |
| Delete session | Permanently deletes this session |

### Multi-select mode

Once you are in multi-select:

- Every session gets a **checkbox** on its left; click to select
- A bar appears at the foot of the sidebar: **Select all**, the selected count, **Archive selected**, **Delete selected**, and **Exit**
- Press **Esc** at any time to leave multi-select

When you are done, use **Archive selected** to file the batch away, or **Delete selected** to clear it out for good.

> If a session is busy (running, or holding unread messages), its checkbox slot is taken by the status dot. Use **Select multiple** from the context menu to pick it instead.

### Settings → Session settings

This page lists every **archived** session with its title, the space it takes, and when it was last modified.

- Per session: **Restore** (puts it back in the sidebar list) or **Delete** (removes it permanently)
- In batch: select several, then use **Restore selected** or **Delete selected**
- **Select all** at the top selects every archived session at once

Deletion always asks for confirmation first, and says clearly that it cannot be undone.

## Things to know

- **A running session can be deleted too.** Its work is stopped first through the same cancel path your own stop button uses, then the files are removed, so you do not have to close it beforehand.
- **What gets removed** is the session's own record together with its local cache, which is why the space is really freed.
- Archiving never goes to a recycle bin and costs no extra space, so use it when you want to keep a way back.

## License

MIT
