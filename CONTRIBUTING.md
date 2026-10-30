# Contributing

Bug reports and pull requests are welcome. For a bug, include your OpenCode version, whether the TUI connects
to a remote server, and the steps to reproduce. If the panel showed "Switchboard error", attach
`opencode-switchboard-errors.log` from the TUI machine's temp directory (`$TMPDIR`, often `/tmp`).

Coding agents working in this repo follow [AGENTS.md](AGENTS.md).

## Setup

Requires Bun 1.4 and OpenCode 2.2.0. The integration test and smoke runs start the `opencode` on your `PATH`.

```sh
git clone https://github.com/abeisleem/opencode-switchboard.git
cd opencode-switchboard
bun install
```

## Run from source

Run `opencode` in the repo. It loads the plugin from source through `.opencode/plugins/switchboard/`.

- The server part reloads on edit. A running TUI does not re-import the panel when its source changes, so
  restart the TUI to test panel changes.
- If the published package is also installed globally, the source copy still wins inside this directory:
  plugins discovered under `.opencode/plugins/` load before configured packages, and the first copy of a
  plugin ID wins. Elsewhere, the published version loads.

`bun run demo` renders the panel with fixture data. It needs no server.

## Checks

Run these on every change:

```sh
bun run typecheck
bun test test/model.test.ts test/selection.test.tsx test/panel.test.tsx test/attention.test.ts
bun run format
```

Name the test files: a bare `bun test` also runs the integration test below. Add a regression test with each
fix.

Slower checks, run before a release:

| Command                             | What it checks                                                          |
| ----------------------------------- | ----------------------------------------------------------------------- |
| `bun test test/integration.test.ts` | The server part against a private OpenCode server                       |
| `bun run smoke`                     | The plugin from source in a real TUI, in a PTY                          |
| `bun run smoke:client`              | A self-contained client bundle in a real TUI                            |
| `bun run smoke:package`             | The packed tarball, installed with npm into a clean directory, in a TUI |
| `bun run pack:dry-run`              | The published file list                                                 |
| `bun run bench`                     | Panel update cost (a benchmark, not a pass/fail check)                  |

## How the package fits together

| Export  | Part                         | Ships as                              |
| ------- | ---------------------------- | ------------------------------------- |
| `.`     | Server part: storage and RPC | TypeScript source (`src/server.ts`)   |
| `./tui` | The panel                    | Solid-compiled bundle (`dist/tui.js`) |
| `./rpc` | Typed contract for both      | TypeScript source (`src/rpc.ts`)      |

- `bun run build` writes `dist/tui.js` and also runs on pack. OpenCode does not compile `.tsx` files inside
  `node_modules`, so the panel ships compiled.
- OpenCode provides `@opencode/plugin`, `solid-js`, and `@opentui/*` at runtime and refuses to load
  `@opencode/plugin` from a plugin's own `node_modules`. They are optional peer dependencies, pinned as dev
  dependencies for type-checking, and never bundled. Zod is the only runtime dependency.
- Saved state is versioned (`stateSchema.version` in `src/model.ts`). A change to its shape needs a migration
  in `src/migrate.ts` and a test, and must keep the user's organization.
- The plugin ID `opencode-switchboard` namespaces saved state. Changing it would orphan every user's
  switchboard.
- The switchboard never deletes, archives, or stops sessions. Deletion belongs to OpenCode's native session
  list.

Historical design notes are in [`docs/design`](docs/design).

## Releasing

Maintainers follow the checklist in [AGENTS.md](AGENTS.md#releasing). In short: bump the version for any
user-visible change, run the fast and slower checks above, confirm that `bun run pack:dry-run` lists no tests,
fixtures, artifacts, or design notes, then publish.
