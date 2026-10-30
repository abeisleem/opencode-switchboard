# Changelog

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
