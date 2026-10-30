# Iteration cadence

- Run smoke/real-TUI/PTY tests only when the user explicitly requests them. This
  includes the smoke scripts, the private-server integration test, and equivalent
  ad-hoc terminal checks.
- At a significant navigation/lifecycle change or release checkpoint, suggest a
  smoke run and wait for the user's decision.
- Add regression tests alongside fixes; execution can be deferred. Prefer focused,
  fast checks (`bun run typecheck`, model/selection/panel tests) on each iteration.
- State which checks ran and which remain deferred.

# Package shape

- One npm package with three parts: `.` (server: storage + RPC), `./tui` (panel),
  `./rpc` (typed contract shared by both). The plugin `id` (`opencode-switchboard`)
  namespaces server storage and the RPC; changing it orphans saved user state.
- `@opencode/plugin`, `effect`, `solid-js`, and `@opentui/*` are provided by the host
  at runtime; OpenCode refuses to load `@opencode/plugin` from a plugin's own
  `node_modules`. Declare them as optional `peerDependencies` and pin them in
  `devDependencies` for type-checking (currently `@opencode/plugin` 2.2.0); never put
  them in `dependencies` (that installed ~200 unused packages and broke installs under
  `min-release-age`) and never bundle them. Only real runtime dependencies (Zod) go in
  `dependencies`.
- The TUI part ships as `dist/tui.js` (`scripts/build.ts`, run on pack): the host
  does not Solid-compile `.tsx` inside `node_modules`. Development loads source via
  `.opencode/plugins/switchboard/`. The server and RPC parts ship as TS source.
- Persisted state is versioned (`stateSchema.version`). Any shape change needs a
  migration in `src/migrate.ts` plus a test; never reset user organization.

# Releasing

- Follow https://opencode.ai/v2/docs/build/plugins (Publish) and, for Effect,
  https://opencode.ai/v2/docs/build/plugins/effect#publish.
- Before publishing: typecheck, fast tests, then ask the user to approve the
  integration test and smoke runs; `bun run pack:dry-run` and check the file list
  (no tests, fixtures, artifacts, or design notes). Run `bun run smoke:package`,
  which installs the packed tarball from npm into a clean OpenCode config.
- Bump the version for any user-visible change. Publishing is outward-facing:
  confirm with the user before `npm publish` or pushing release tags.
- Planned: Changesets + npm trusted publishing from GitHub Actions, following
  https://github.com/vimtor/opencode-plugins.

# Direction

- Planned migration of the server part to the Effect API
  (`@opencode/plugin/effect`): `effect` stays a peer dependency (host-provided,
  never bundled), pinned as a dev dependency to the version `@opencode/plugin` uses.
- The switchboard never deletes, archives, or stops sessions. Deletion belongs to
  OpenCode's native session list.
