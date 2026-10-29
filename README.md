# opencode-inbox

An OpenCode plugin that turns the session tab panel into a project-grouped work
inbox: see which sessions are running, which need you, and park work for later
without losing it.

> Status: early preview (0.x). Requires OpenCode 2.2.0. The panel currently opens
> in the session side panel; replacing the native left tab rail is planned.

## Install

Add the package to your OpenCode config (`~/.config/opencode/opencode.json(c)` or a
project's `.opencode/opencode.jsonc`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-inbox"],
}
```

One entry loads both parts. The server part stores the inbox; every TUI connected
to that server (including remote `opencode --server …` clients) loads the panel.

## Use

Open it with `/inbox` or **Ctrl+X, then I** (`<leader>i`). Pressing it again while
the panel is open focuses the panel on the current conversation.

- **Projects → sessions.** Active sessions sit under their project; **Later** is one
  fold after them. Agent activity never reorders your list.
- **Indicators** (left column): `!` approval, `?` question, spinner running,
  `×` error, `•` unread. The conversation you are viewing has a bold title.
- **Adding work:** pick a project or session in OpenCode's **Ctrl+O** menu. A new
  project starts empty; a saved one comes back with its sessions. Opening any
  session adds it to its project.
- **Unread** is independent of placement: mark a session unread to revisit it,
  whether it is Active or Later.

| Key       | Action                                       |
| --------- | -------------------------------------------- |
| ↑/↓, j/k  | Move                                         |
| Enter     | Open session / fold heading                  |
| `u`       | Toggle read/unread                           |
| `a` / `l` | Move to Active / Later                       |
| `x`       | Close session or project (keeps saved state) |
| `r` / `d` | Refresh / refresh diagnostics                |
| `?` / Esc | Help / close panel                           |

Clicking a row while the panel is unfocused opens it and keeps focus in the
conversation.

**The inbox never deletes, archives, or stops sessions.** Closing only removes a
session from the panel; opening it again brings it back. Delete sessions through
OpenCode's native session list.

## How state is shared

Open projects, membership, placement, unread marks, selection, and folds are stored
by the server part and shared by every client of that server. Cursor and scroll
position are per client. Native GUI/mobile clients do not show the panel; their
view acknowledgments still count as reading completed results.

## Development

Requires Bun 1.4 and OpenCode 2.2.0.

```sh
bun install
bun run typecheck
bun test test/model.test.ts test/selection.test.tsx test/panel.test.tsx
bun run demo          # fixture panel, no server needed
```

Running `opencode` in this directory loads the plugin from source through
`.opencode/opencode.jsonc`. The server part reloads on edit; a running TUI does not
re-import the TUI part when only its source changes, so restart the TUI to test
panel changes.

Slower checks, run before releases:

```sh
bun test test/integration.test.ts   # private OpenCode server
bun run smoke && bun run smoke:client   # real TUI in a PTY
bun run pack:dry-run
```

Render errors are appended to `$TMPDIR/opencode-inbox-errors.log`, since OpenCode's
own plugin boundary only shows a toast.

Design notes live in [`docs/design`](docs/design).

## License

MIT
