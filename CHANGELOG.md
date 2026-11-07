# Changelog

## Unreleased

Update the plugin on the server machine too, not only on TUI machines, to get the full gain; mixed versions keep
working, and are never worse than 0.2.1.

- Refreshes load only the sessions the switchboard tracks, not every past session of every open project. The
  server part now reads them in one request, and the panel loads the open projects in parallel. With 6 projects
  of 1,000 past sessions and 90 tracked, a refresh transfers 35 KB instead of 420 KB in 18 requests instead
  of 32, and takes 144 ms instead of 576 ms over a link with 20 ms of latency. With 3 projects of 30 sessions
  and 45 tracked, it transfers 18 KB instead of 44 KB in 12 requests instead of 14, and takes 98 ms instead of
  184 ms. Against a 0.2.1 server part, the panel makes the same requests as 0.2.1 (plus one, once, to find
  the new method missing), now loading the projects in parallel: 287 ms instead of 576 ms in the first case,
  and 95 ms instead of 184 ms in the second.

## 0.2.1 (2026-11-06)

Only the panel changed: the server part, its RPC, and saved state are the same as in 0.2.0. Update the plugin
on each TUI machine to get these; a 0.2.0 server and other 0.2.0 TUIs keep working alongside it.

- When another TUI closes the row of the conversation you are viewing, or its project, a toast says so once:
  `Not in the switchboard. Press ctrl+x i to add it back`, with your `<leader>i`. Press it and the conversation
  is listed in its project again. With the open command unbound, the toast says to open the switchboard
  instead. Closing a row yourself shows no toast.
- Fixed: from a subagent's view, `<leader>i` did not add back its parent conversation once that row was closed.
- `n` opens the new-session screen of the project under the cursor: its heading, one of its sessions, or its
  Parked section. Right-click a project heading for the same **New session** item. It opens in the project's
  main directory, with focus in the message box, and creates no session until you send the first message; the
  new session then appears under that project.
- Right-click a session row for **Mark read**/**Mark unread** and **Park**/**Unpark**. Each item shows its key
  (`u`, `p`), which runs it while the menu is open. The menu acts on the session you right-clicked, which stays
  highlighted while the menu is open, and never moves the cursor. Focus returns to where it was, such as the
  message box, when the menu closes. Esc, a click outside, or a right-click on the menu closes it.
- When the connection to the server drops, the footer shows a muted `Reconnecting…` instead of the raw
  connection error, and the panel retries sooner (after 2, 4, and 8 seconds) until it is back. A change made
  while disconnected says `Not saved: no connection to the server`. Click the footer for the full error.
- Fixed: a right-click or middle-click on a row no longer opens the session or folds the heading. The same
  goes for the close `✕`, the footer's error line, and `? help`: only a left-click acts on them.
- Fixed: errors in the panel footer and the details dialog showed `[object Object]`. They now show a readable
  message, and the details dialog lists each message once. When the switchboard's server part is not loaded,
  the footer says so, and the details dialog says where to look.
- The panel makes fewer requests: each refresh skips an empty page per project, the first open loads sessions
  once instead of twice, and a change you make no longer triggers an extra state read.

## 0.2.0 (2026-11-01)

Update the plugin on the server and on every TUI machine together. An older server rejects ←, →, parking with
`p`, and opening a session. A TUI older than this release hides parked sessions until it updates, may jump to
the new-session screen once, and its `<leader>w` does nothing; nothing is lost.

- Each TUI keeps its own current session. Opening a session in one TUI no longer switches every other TUI to
  it; projects, sessions, parked sessions, unread marks, and folds are still shared. Closing the current
  session's row returns to the session you viewed most recently in that TUI. When another TUI closes the row of
  the session you are viewing, the row disappears but the conversation stays open.
- Closing a session's row unparks it, so it comes back unparked when you open it again. Closing a project keeps
  its parked sessions.
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
