# Contributing

Bug reports and pull requests are welcome. For a bug, include your OpenCode version, whether the TUI connects
to a remote server, and the steps to reproduce. If the panel showed "Switchboard error", attach
`opencode-switchboard-errors.log` from the TUI machine's temp directory (`$TMPDIR`, often `/tmp`).

Coding agents working in this repo follow [AGENTS.md](AGENTS.md).

## How to contribute

Fork the repo and make your change on a branch, with a regression test for a fix. Make sure the
[fast checks](#checks) pass, then open a pull request against `main`. The maintainer reviews and merges.

## Setup

Requires Bun 1.4 and OpenCode 2.2.0. The integration test and smoke runs start the `opencode` on your `PATH`.

```sh
git clone https://github.com/abeisleem/opencode-switchboard.git
cd opencode-switchboard
bun install
```

## Run from source

Run `bun run dev` in the checkout. It starts `opencode` with the plugin loaded from source through
`.opencode/plugins/switchboard/`.

- Plain `opencode` also works, but only if your `~/.config/opencode/cli.json` does not list
  `opencode-switchboard`. In the TUI, later plugin sources replace earlier ones, so a published copy listed
  there replaces the source copy, even inside this repo. `bun run dev` leaves it out for that run only.
- The server part reloads on edit. A running TUI does not re-import the panel when its source changes, so
  restart the TUI to test panel changes.

`bun run demo` renders the panel with fixture data. It needs no server.

## Checks

Run these on every change:

```sh
bun run typecheck
bun test test/model.test.ts test/selection.test.tsx test/panel.test.tsx test/attention.test.ts test/palette.test.ts test/session-creation.test.tsx test/deletion.test.tsx test/navigation.test.tsx
bun run test:releases
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

Bump the version and update `CHANGELOG.md` in a pull request. After it merges, tag `vX.Y.Z` on `main`, push
the tag, and publish from the checkout with `npm publish`. Check `gh auth status` before publishing: the
`postpublish` hook uses the authenticated GitHub CLI to dispatch **Sync npm releases**. The full validation
and approval checklist is in [AGENTS.md](AGENTS.md#releasing).

The workflow creates or updates release notes from `CHANGELOG.md` for versions that exist on npm and have
a pushed source tag. It marks GitHub's latest release from npm's `latest` dist-tag and marks prereleases
separately. Keep notes in `CHANGELOG.md`; a sync replaces the GitHub release body but preserves assets.
The original untagged `0.0.0-stage` npm placeholder is not a repository release.

Synchronization also runs on tag pushes, relevant changes to `main`, and hourly to recover from missed
dispatches or delayed npm processing. It uses the workflow's `GITHUB_TOKEN`; no npm publishing secret is
needed. Check the workflow result and the npm/GitHub release before declaring publishing complete.

If npm accepted a publish but registry processing or the post-publish dispatch failed, retry synchronization
instead of publishing the same version again:

```sh
gh workflow run sync-releases.yml --ref main -f version=X.Y.Z
```

The version input waits up to 15 minutes for npm visibility. Omit it to reconcile all currently published
tagged versions. For a local read-only preview, run `bun run release:sync --dry-run`; `bun run release:sync`
applies the same synchronization using your GitHub CLI credentials.
