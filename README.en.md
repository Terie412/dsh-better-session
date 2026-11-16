# dsh-better-session

[简体中文](README.md) | English

Session management for DeepSeek Harness: batch actions, permanent deletion, and one place to manage archived sessions.

> ⚠️ **Deletion cannot be undone.** Sessions are removed from disk, not moved to a recycle bin — that is what actually frees the space.

## Install

```sh
dsh plugin --profile web add git@github.com:Terie412/dsh-better-session.git
```

Replace `web` with the profile you use. Then check **Settings → Plugins** that it is enabled.

## Features

### 1. Batch session actions

Right-click any session → **Select multiple** to enter multi-select:

- Every session gets a checkbox on its left; click to select
- A bar appears at the sidebar foot: **Select all / Archive selected / Delete selected / Exit**
- **Esc** leaves multi-select

> While a session is running, its checkbox slot is taken by the status dot. Use **Select multiple** from the context menu to pick it instead.

### 2. Delete a session

Right-click any session → **Delete session**, then confirm to attempt permanent deletion. Loaded sessions require restarting Harness and retrying.

- **Loaded sessions are not deleted from disk**: their work is stopped and they stay archived. Restart DeepSeek Harness, then retry from **Settings → Session settings** without opening or restoring them first.
- Failures are reported rather than claiming a loaded session was deleted. Successful deletion removes the session record and local cache.

### 3. Manage archived sessions

**Settings → Session settings** lists every archived session with its title, the space it takes, and when it was last modified.

- Per session: **Restore** (back to the sidebar) or **Delete**
- In batch: select some, then **Restore selected** or **Delete selected**
- **Select all** at the top selects everything

### 4. Switch sessions with the keyboard

- **Alt + ←**: previous session; **Alt + →**: next session
- Follows the sidebar's current order, including pins, manual ordering and workspace groups — not visit history
- Skips archived rows, collapsed groups and rows not yet revealed by **Show more**; rendered rows outside the scroll viewport remain reachable
- Stops at either end without wrapping; does nothing when the current session is absent from the list; works in text inputs, but not behind dialogs
- Listed in the shortcut reference; customizable on Windows/macOS Desktop, fixed on Web/Linux and overrides browser back/forward

### 5. Background completion notifications

Enable under **Settings → Session settings → Completion notifications**, then allow system notifications. Disabled by default; the preference is device-local browser storage.

- Ordinary sessions notify when a turn completes normally. Unfinished long-running goals suppress intermediate turns; a completed goal notifies after its final successful reply ends.
- No alert while you are viewing the session in a focused window. Other sessions, unfocused windows and minimized windows can notify.
- No alerts for cancellations, failures, subagents or archived sessions. Live events only: reloads and reconnects do not replay missed notifications.
- Clicking tries to focus the window and open the session. **Test notification** checks permission without enabling completion alerts.
- The app must remain running and connected. Window activation, placement, sound and Do not disturb are controlled by the desktop environment.
- Web requires a secure context (HTTPS or localhost). Same-origin windows deduplicate and suppress alerts for a session viewed in another window on a best-effort basis. Busy/suspended windows or missing Web Locks/browser storage can prevent cross-window arbitration. Separate browsers/devices notify independently.

## Notes

- Archiving costs no extra space and is reversible — use it to keep a way back. Delete only when you are sure
- Every deletion asks for confirmation first

## License

MIT
