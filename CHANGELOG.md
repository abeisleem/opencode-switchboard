# Changelog

## 0.1.1 (unreleased)

- The plugin uses OpenCode's own `@opencode/plugin` instead of installing a copy. It is now an optional peer
  dependency, so an install pulls in 2 packages instead of 218 and works under npm `min-release-age`.
- Opening a session from the panel, with Enter or a click, moves focus to its conversation.
- The first time you open the panel with OpenCode's native tabs still on, a one-time tip explains how to turn
  them off.
- The panel has a row of space at the top, and its text is no longer selected when you drag across it.
- Install docs cover TUIs connected to a remote server: list the package in `opencode.json(c)` on the server
  machine and in `cli.json` on the TUI machine.

## 0.1.0 (2026-10-29)

First preview.

- A project-grouped switchboard panel in the session side panel, opened with `/switchboard` or `<leader>i`.
- Active sessions and a Later fold per project. Unread marks are independent of placement.
- Approval, question, running, error, and unread indicators on each row.
- Closing a session or project hides it without deleting, archiving, or stopping anything.
- State is stored by the server part and shared by every client of the server.
