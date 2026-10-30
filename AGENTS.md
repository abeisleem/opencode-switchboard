OpenCode plugin, one npm package with three parts: `.` (server: storage + RPC), `./tui` (panel), and `./rpc`
(the typed contract both share). Targets OpenCode 2.2.0.

# Commands

| Task       | Command                                                                                                               |
| ---------- | --------------------------------------------------------------------------------------------------------------------- |
| Install    | `bun install`                                                                                                         |
| Typecheck  | `bun run typecheck`                                                                                                   |
| Fast tests | `bun test test/model.test.ts test/selection.test.tsx test/panel.test.tsx test/attention.test.ts test/palette.test.ts test/session-creation.test.tsx test/deletion.test.tsx` |
| Format     | `bun run format`                                                                                                      |
| Build      | `bun run build` (writes `dist/tui.js`; also runs on pack)                                                             |
| Pack check | `bun run pack:dry-run`                                                                                                |

Name test files explicitly: a bare `bun test` (or `bun run test`) also runs `test/integration.test.ts`, a
gated check.

# Checks

- Each iteration: typecheck plus the fast tests that cover the change.
- Add a regression test with every fix. Running it can wait.
- Gated checks run only when the user explicitly asks: the smoke scripts (`smoke`, `smoke:client`,
  `smoke:package`), the private-server integration test, and any ad-hoc real-TUI or PTY terminal check.
- After a significant navigation or lifecycle change, or at a release checkpoint, suggest a gated run and wait
  for the user's decision.
- When you report, say which checks ran and which remain deferred.

# Dependencies

- The host provides `@opencode/plugin`, `effect`, `solid-js`, and `@opentui/*` at runtime, and OpenCode
  refuses to load `@opencode/plugin` from a plugin's own `node_modules`. Declare them as optional
  `peerDependencies` and pin them in `devDependencies` for type-checking (currently `@opencode/plugin` 2.2.0).
  Keep them out of the bundle.
- `dependencies` holds only real runtime dependencies (Zod). Host packages there once installed ~200 unused
  packages and broke installs under npm `min-release-age`.

# Build and loading

- The TUI part ships as a Solid-compiled `dist/tui.js` (`scripts/build.ts`), because the host does not
  Solid-compile `.tsx` inside `node_modules`. The server and RPC parts ship as TypeScript source.
- Development loads source via `.opencode/plugins/switchboard/`; start it with `bun run dev`. In the TUI,
  later plugin sources win (discovered `.opencode/plugins/`, then the server's list, then `cli.json`), so a
  published `opencode-switchboard` in the global `cli.json` replaces the source copy even in this repo. Plain
  `opencode` is fine only when `cli.json` does not list it.
- The server part reloads on edit; a running TUI keeps the old panel code until it restarts.

# Saved state

- The plugin ID `opencode-switchboard` (`src/server.ts`, `src/tui.tsx`, `src/rpc.ts`) namespaces server
  storage and the RPC. Keep it: a new ID orphans every user's saved state.
- State is versioned (`stateSchema.version` in `src/model.ts`). Every shape change gets a migration in
  `src/migrate.ts` plus a test. Migrations carry the user's organization forward; never reset it.

# Sessions

The switchboard never deletes, archives, or stops sessions. Closing removes a row from the panel only;
deletion belongs to OpenCode's native session list.

# Git

Changes reach `main` only through a pull request; direct pushes are rejected. Work on a branch, push it, and
open a PR (`gh pr create`) for the maintainer to merge.

# Releasing

Follow https://opencode.ai/v2/docs/build/plugins#publish and, for Effect,
https://opencode.ai/v2/docs/build/plugins/effect#publish.

1. On a branch, bump the version for any user-visible change, and add the release's user-visible changes to
   `CHANGELOG.md` with the release date.
2. Run typecheck and the fast tests.
3. Ask the user to approve the gated checks: the integration test, `smoke`, `smoke:client`, and
   `smoke:package` (packs the tarball, installs it with npm into a clean directory, and runs the real-TUI
   smoke against it).
4. Run `bun run pack:dry-run` and check the file list: no tests, fixtures, artifacts, or design notes.
5. Open the release PR. Only after it merges, tag `vX.Y.Z` on `main`.
6. Confirm with the user before pushing the release tag or running `npm publish`. Both are outward-facing.

# Planned

- The server part moves to the Effect API (`@opencode/plugin/effect`). `effect` stays a host-provided peer
  dependency, never bundled, pinned as a dev dependency to the version `@opencode/plugin` uses.
- Releases move to Changesets and npm trusted publishing from GitHub Actions, following
  https://github.com/vimtor/opencode-plugins.
