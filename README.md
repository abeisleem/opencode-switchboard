# opencode-switchboard

An OpenCode plugin that turns the session tab panel into a project-grouped
switchboard: see which sessions are running, which need you, and park work for later
without losing it.

> Status: early preview (0.x). Requires OpenCode 2.2.0. The panel currently opens
> in the session side panel; replacing the native left tab rail is planned.

## Install

The plugin has two parts: a **server part**, which stores your switchboard, and a
**panel** shown in the TUI. Where you list the package depends on where your TUI runs.

| Your setup                                            | `opencode.json(c)` on the server machine | `cli.json` on the TUI machine |
| ----------------------------------------------------- | ---------------------------------------- | ----------------------------- |
| TUI and server on the same machine (plain `opencode`) | Required                                 | Not needed                    |
| TUI on another machine (`opencode --server …`)        | Required                                 | Required                      |

`cli.json` alone is never enough: the server part only loads from `opencode.json(c)`.

**1. On the machine that runs the OpenCode server**, add it to your global
`~/.config/opencode/opencode.json(c)`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-switchboard"],
}
```

Use the global config: the switchboard spans all your projects, and a project's
`.opencode/opencode.jsonc` only loads it inside that project.

**2. On every other machine you connect a TUI from**, also add it to
`~/.config/opencode/cli.json`:

```json
{
  "plugins": ["opencode-switchboard"]
}
```

As of OpenCode 2.2.0, a TUI connected to a remote server only shows a server plugin's
panel when the package is already installed on the TUI's own machine; it does not
download it. Listing it in `cli.json` installs it there.

Listing it in both files on one machine is safe: the entries resolve to a single copy.
OpenCode installs npm plugins automatically; restart the TUI if `/switchboard` does not
appear.

## Use

Open it with `/switchboard` or **Ctrl+X, then I** (`<leader>i`). Pressing it again while
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

**The switchboard never deletes, archives, or stops sessions.** Closing only removes a
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
`.opencode/plugins/switchboard/`. The server part reloads on edit; a running TUI
does not re-import the TUI part when only its source changes, so restart the TUI to
test panel changes.

If the published package is also installed globally, the source copy still wins inside
this directory: plugins discovered under `.opencode/plugins/` load before configured
packages, and the first copy of a plugin ID wins. Elsewhere, the published version loads.

The published package exports a Solid-compiled `dist/tui.js` (`bun run build`, also
run on pack), because OpenCode does not compile `.tsx` files inside `node_modules`.

Slower checks, run before releases:

```sh
bun test test/integration.test.ts   # private OpenCode server
bun run smoke && bun run smoke:client   # real TUI in a PTY
bun run smoke:package                   # packed tarball installed from npm, in a real TUI
bun run pack:dry-run
```

Render errors are appended to `$TMPDIR/opencode-switchboard-errors.log`, since OpenCode's
own plugin boundary only shows a toast.

Design notes live in [`docs/design`](docs/design).

## License

MIT
