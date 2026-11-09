# dsh-better-session

Batch session management for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): multi-select archive and permanent delete in the sidebar, plus an archived-session manager in Settings.

> **Deletion is permanent.** Sessions are removed from disk, not moved to a recycle bin, so the space is actually reclaimed. Every destructive action goes through a confirmation dialog saying so.

## Features

### Sidebar session menu

Right-click any session row for three extra actions, grouped beneath the built-in menu:

| Action | What it does |
| --- | --- |
| **批量操作 / Select multiple** | Enters multi-select mode, preselecting that session |
| **归档会话 / Archive session** | Built-in Harness action |
| **删除会话 / Delete session** | Permanently deletes this session |

### Multi-select mode

- A checkbox appears in each session row's leading cell
- A bar at the sidebar foot offers **全选 (Select all)**, a selected count, **批量归档**, **批量删除** and **退出**
- **Esc** leaves multi-select mode

### Settings → 会话设置 / Session settings

Lists every archived session with its title, on-disk size and last-write time, each with **恢复 (Restore)** and **删除 (Delete)**, plus select-all, **批量恢复** and **批量删除**.

## How deletion works

The shipped Harness exposes archiving but no way to delete a session log. This plugin's Host half owns that one destructive operation:

1. Refuses while a live Agent still owns the session
2. Drops the archive and pin entries and detaches Workspace accounting
3. Removes the session directory (`$DSH_HOME/sessions/<workspace>/<id>`) and its projection-cache file
4. Announces the removal so the sidebar list refreshes

A client action reaches the Host through one fenced `POST /better-session/api` route; the browser never touches the filesystem.

## Install

Add the package to a DSH profile:

```sh
dsh plugin install https://github.com/Terie412/dsh-better-session
```

Or from a local checkout, point the profile at the directory:

```sh
dsh plugin install /path/to/dsh-better-session
```

Then enable the bundle in the profile's plugin list.

## Layout

```
index.js           Host half — the fenced API route and permanent deletion
client.js          Client half — menu rows, multi-select bar, settings page
cordis.patch.yml   Bundle patch inserting the plugin row
locale/            Display metadata (zh, en)
icon.svg           Plugin artwork
```

## License

MIT
