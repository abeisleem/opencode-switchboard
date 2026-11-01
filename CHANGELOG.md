# Changelog

## 0.1.5 (unreleased)

Update the plugin on the server and on every TUI machine together. An older server rejects ←, →, parking with
`p`, and opening a session. A TUI older than this release hides parked sessions until it updates, may jump to
the new-session screen once, and its `<leader>w` does nothing; nothing is lost.

- Each TUI keeps its own current session. Opening a session in one TUI no longer switches every other TUI to
  it; projects, sessions, parked sessions, unread marks, and folds are still shared. Closing the current
  session's row returns to the session you viewed most recently in that TUI. When another TUI closes the row of
  the session you are viewing, the row disappears but the conversation stays open.
- Later is now Parked: each project lists its sessions, then a Parked fold (`▸ Parked · 3` when folded). Saved
  state migrates automatically and keeps your parked sessions and folds.
- `p` parks the highlighted session, and unparks a parked one. It replaces `a` and `l`.
- Fixed: switching between two unparked sessions in a project no longer unfolds its folded Parked section.
  Opening a parked session still unfolds it.
- The help dialog (`?`) shows your configured shortcuts, including a custom leader, and lists the shortcut
  that closes the current session's row. A command you have unbound is left out instead of showing Ctrl+X.
- ← folds and → unfolds the highlighted heading, as in tree views. Pressing either one again leaves the heading
  as it is.

## 0.1.4 (2026-10-31)

- Session and project indicators update as soon as OpenCode reports a change, as in its native tabs. Spinners,
  approval, question, error, and unread marks no longer lag by up to 15 seconds.
- The `r` (refresh) and `d` (refresh details) keys are gone: the panel keeps itself current. Click the error
  line at the bottom of the panel for details.
- The help dialog (`?`) lists one key per line, styled like OpenCode's command palette, and shows how to open
  the switchboard and switch panes.
- Fixed: after a Switchboard dialog closed, OpenCode commands that move focus (such as Ctrl+X, then ↓) sent
  focus straight back to the panel.
- Up/Down and j/k highlight the whole row, out to the panel's right edge, while the panel has keyboard focus.
- Project headings are clearer: names are underlined and end in `/`, fold triangles stay dim until hovered or
  selected, and folded projects use the session rows' spinner and badge colors.
- A folded Later shows how many sessions it holds, as `Later · 3`.

## 0.1.3 (2026-10-30)

- Starting a TUI with `--server` and `--session`, or reopening the panel, synchronizes the current-session
  marker and working-set selection with the displayed conversation instead of the previously saved selection.
- Ctrl+X, then W (`<leader>w`) closes the current conversation's Switchboard row from either pane and returns
  to another open session. It uses the viewed session rather than the panel cursor and never deletes the session.

## 0.1.2 (2026-10-30)

- The current session is bold without a row background, even while hovered. Other rows highlight only on
  mouse hover; the keyboard cursor still brightens their text and exposes the close control.
- Renaming a session from OpenCode's session list refreshes its title in the panel immediately, without waiting
  for the next poll or a manual refresh.
- Deleting the current session from OpenCode's session list removes its panel row and returns to the most
  recently visited open session. Deleting a background session leaves the current conversation in place.
- Closing the current row or project falls back to another open session even when none is in recent history.
- Sessions opened before their creation finishes are added to the panel when creation completes. This also
  adds their new project without a second navigation or a transient “Session not found” error.
- Collapsed project and Later headings use a vertically balanced running indicator.
- Row close controls have a padded cell after the ×, keeping hovered non-current rows' buttons clear of the
  highlight edge.
- Install troubleshooting documents the working OpenCode 2.2 override for npm `min-release-age`.

## 0.1.1 (2026-10-30)

- The plugin uses OpenCode's own `@opencode/plugin` instead of installing a copy. It is now an optional peer
  dependency, so an install pulls in 2 packages instead of 218 and its dependencies no longer fail npm
  `min-release-age`.
- Opening a session from the panel, with Enter or a click, moves focus to its conversation. Previously Enter
  kept focus in the panel.
- Opening a session elsewhere while the panel is open, such as from the Ctrl+O menu or the session list, also
  moves focus to its conversation.
- Opening the switchboard from the new-session screen marks no session as current and puts the cursor on that
  screen's project, adding the project if needed. Closing it returns to the new-session screen.
- Opening the switchboard right after starting a TUI no longer jumps to the last selected session. The first
  state a TUI loads only syncs it; selections made later in other clients still move it.
- Hovered and current rows use the native tab rail's fills, and the current row keeps its fill when hovered. In
  the side panel these come from the theme's raised-surface colors, so the hover fill shows in every theme
  instead of matching the panel background.
- The first time you open the panel on a machine with OpenCode's native tabs still on, a one-time tip explains
  how to turn them off.
- The panel has a row of space at the top, and its text is no longer selected when you drag across it.
- Install docs cover TUIs connected to a remote server: list the package in the global `opencode.json(c)` on the
  server machine and in `cli.json` on the TUI machine. They also cover turning off the native tabs and exempting
  the package from npm `min-release-age`.

## 0.1.0 (2026-10-29)

First preview.

- A project-grouped switchboard panel in the session side panel, opened with `/switchboard` or `<leader>i`.
- Active sessions and a Later fold per project. Unread marks are independent of placement.
- Approval, question, running, error, and unread indicators on each row.
- Closing a session or project hides it without deleting, archiving, or stopping anything.
- State is stored by the server part and shared by every client of the server.
