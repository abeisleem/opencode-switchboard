# opencode-switchboard

Know which OpenCode sessions are running, which need you, and park the rest for later, across all your
projects.

<!-- DEMO: add the demo video or GIF here before the launch post. -->

With several agent sessions open across a few projects, it gets hard to tell what is still working, what is
waiting on an approval or an answer, and what finished while you were elsewhere. The switchboard is a TUI
panel that groups your sessions by project, marks the state of each one, and lets you move work to **Later**
without losing it.

- **Grouped by project.** Each open project lists its sessions, including those in worktrees. Agent activity
  never reorders the list.
- **State at a glance.** Every row shows whether the session needs approval, has a question, is running,
  failed, or finished unread.
- **Active and Later.** Park a session under its project's Later fold and bring it back with one key.
- **Nothing is deleted.** Closing a session or a project only hides it from the panel.
- **Shared by every client.** The switchboard lives on the OpenCode server, so each TUI connected to it sees
  the same projects, sessions, and unread marks.

> **Status:** early preview (0.x). Requires OpenCode 2.2.0. The panel opens in the session side panel;
> replacing the native tab rail is planned.

## Install

The plugin has two parts: a **server part**, which stores your switchboard, and a **panel** shown in the TUI.
Where you list the package depends on where your TUI runs.

| Your setup                                            | `opencode.json(c)` on the server machine | `cli.json` on the TUI machine |
| ----------------------------------------------------- | ---------------------------------------- | ----------------------------- |
| TUI and server on the same machine (plain `opencode`) | Required                                 | Not needed                    |
| TUI on another machine (`opencode --server …`)        | Required                                 | Required                      |

`cli.json` alone is never enough: the server part only loads from `opencode.json(c)`.

**1. On the machine that runs the OpenCode server**, add the package to your global
`~/.config/opencode/opencode.json(c)`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-switchboard"],
}
```

Use the global config: the switchboard spans all your projects, and a project's `.opencode/opencode.jsonc`
only loads it inside that project.

**2. On each machine that runs a TUI connected to a remote server**, also add it to
`~/.config/opencode/cli.json`:

```json
{
  "plugins": ["opencode-switchboard"]
}
```

As of OpenCode 2.2.0, a TUI connected to a remote server only shows a server plugin's panel when the package
is already installed on the TUI's own machine; it does not download it. Listing it in `cli.json` installs it
there. Listing it in both files on one machine is safe: the entries resolve to a single copy.

OpenCode installs npm plugins automatically. If `/switchboard` does not appear, see
[Troubleshooting](#troubleshooting).

## Use

### Open the panel

Run `/switchboard`, press **Ctrl+X, then I** (`<leader>i`), or pick **Open switchboard** in the command
palette.

- The first time you open it from a conversation, it adds that conversation's project.
- Pressing it again while the panel is open moves the cursor to the conversation you are viewing.
- **Esc** closes the panel. Until you open it again, the switchboard does not track the sessions you open.

### Add work

While the panel is open:

- Pick a project or session in OpenCode's **Ctrl+O** menu. A new project starts empty; a saved project comes
  back with its sessions.
- Open any session, and it is added to its project.

### Read the panel

Projects are listed by name. Under each one come its Active sessions, then a **Later** fold. The conversation
you are viewing has a bold title. A session in a worktree or another folder of the project shows that folder's
name on a second line.

| Indicator | Meaning                                                                            |
| --------- | ---------------------------------------------------------------------------------- |
| `!`       | Waiting for your approval                                                          |
| `?`       | Waiting for your answer to a question                                              |
| Spinner   | Running or queued                                                                  |
| `×`       | The last run failed                                                                |
| `•`       | Unread: finished since you last looked, or marked unread                           |
| `~`       | Approvals and questions for this workspace could not be read; press `d` for detail |

A folded project or Later heading sums up what it hides: `? 2` waiting on you, `⠿ 1` running, `• 3` unread.

Unread is independent of placement: mark a session unread to come back to it, whether it is Active or Later.

### Keys

| Key       | Action                                                 |
| --------- | ------------------------------------------------------ |
| ↑/↓, j/k  | Move                                                   |
| Enter     | Open session, or fold/unfold heading                   |
| `u`       | Toggle read/unread                                     |
| `a` / `l` | Move to Active / Later                                 |
| `x`       | Close session or project (keeps its saved state)       |
| `r`       | Refresh                                                |
| `d`       | Show details of the last refresh, including any errors |
| `?`       | Help                                                   |
| Esc       | Close the panel                                        |

With the mouse:

- Click a session to open it, or a heading to fold or unfold it.
- Hover a row to show its `✕`, and click it to close that session or project.
- Click **? help** at the bottom for the key reference.

Opening a session, with Enter or a click, moves focus to its conversation so you can type right away. Press
**Ctrl+X, then I** to return to the panel.

**The switchboard never deletes, archives, or stops sessions.** Closing removes a session from the panel;
opening it again brings it back. A closed project keeps its sessions for when you reopen it. Delete sessions
through OpenCode's native session list.

## How state is shared

Open projects, their sessions, Active/Later placement, unread marks, the selected session, and folds are
stored by the server part and shared by every client of that server. When two TUIs have the panel open,
opening a session in one switches the other to it. Cursor and scroll position are per client.

OpenCode's desktop and mobile apps do not show the panel. Viewing a finished session there still counts as
reading it, but does not clear a session you marked unread.

## Troubleshooting

**`/switchboard` is missing in a TUI connected to a remote server.** Add the package to
`~/.config/opencode/cli.json` on the TUI's machine, then restart the TUI. The server machine also needs it in
`opencode.json(c)`; see [Install](#install).

**`/switchboard` is missing right after you added the plugin.** OpenCode installs npm plugins automatically,
which can take a moment. Restart the TUI.

**npm refuses a new release because of `min-release-age`.** If your npm config sets `min-release-age`, a
version published more recently than that window does not install. Exempt this package in your `.npmrc`:

```ini
min-release-age-exclude[]=opencode-switchboard
```

Only this package is exempt; its dependency (Zod) still follows your policy.

**The panel shows "Switchboard error".** Click the message to retry. The full error is appended to
`opencode-switchboard-errors.log` in the TUI machine's temp directory (`$TMPDIR`, often `/tmp`). Please
include it when you [open an issue](https://github.com/abeisleem/opencode-switchboard/issues).

**A `~` indicator, or "Attention needs refresh" at the bottom.** The switchboard could not read approvals or
questions for a workspace, or the workspace no longer exists. Press `d` for details and `r` to retry.

## Contributing

Bug reports and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, checks, and the
release process.

## License

[MIT](LICENSE)
