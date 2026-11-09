# dsh-better-session

[简体中文](README.md) | English

Session management for DeepSeek Harness: batch actions, permanent deletion, one place to manage archived sessions, and redoing a turn.

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

Right-click any session → **Delete session**, confirm the dialog, and it is gone for good.

- **Running sessions can be deleted too**: their work is stopped first, then the files are removed
- Both the session record and its local cache are removed, so the space is genuinely reclaimed

### 3. Manage archived sessions

**Settings → Session settings** lists every archived session with its title, the space it takes, and when it was last modified.

- Per session: **Restore** (back to the sidebar) or **Delete**
- In batch: select some, then **Restore selected** or **Delete selected**
- **Select all** at the top selects everything

### 4. Redo a turn

If a turn went wrong, redo it instead of starting a new session.

**How**: hover your own message and **Redo this turn** appears. Open it, edit the text if you want, and send.

**What happens**: that turn is replaced in the model's history by a summary, then your edited text is asked again.

- Turns under 600 characters are not summarized; the original is wrapped in a notice instead — faster and cheaper
- Only the history the model sees is rewritten; the original turn stays visible in the UI
- **Files already written are not reverted** — this differs from editing a file
- Only **finished** turns can be redone; the button is hidden while the agent is running

## Notes

- Archiving costs no extra space and is reversible — use it to keep a way back. Delete only when you are sure
- Every deletion asks for confirmation first

## License

MIT
