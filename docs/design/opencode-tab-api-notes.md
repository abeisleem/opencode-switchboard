# OpenCode tab plugin: API findings and discussion options

Investigated 2026-10-26; deepened 2026-10-27; requirements reconciled 2026-10-28.
Feature selection is pending; this is not an implementation specification.

**Current direction:** the user selected an inbox and clarified that TUIs run on
workstations connected to this host through `--server`, with occasional mobile
use. See [the current inbox brief and wireframes](opencode-inbox-brief.md).
Selection, filters, search, view, navigation history, and organization are shared
server state. Only device-specific rendering/input mechanics stay local. Unread
and Later are independent: `/unread` must not change placement. The local-storage
investigation below establishes backend mechanics, not a recommendation to keep
shared inbox state on a workstation.

## Source baseline

`/home/abe/repos/opencode-v2` is on local `dev`, tracking `upstream/dev`, at
`ed74ec82ce1fe3a36da6c0815a935473ef4bb0fb`. The checkout was clean after fetching and
fast-forward pulling. Added `dev` to the upstream fetch refspec; retained the old
`v2` and `server-tab-state` branches. Upstream `v2` remains at the October 10 commit
`4617210822bdbb31e5749751afbfb4584ccedac8`, so pulling that branch alone does not
obtain current development code.

Installed CLI: v2.1.4, release commit `68bc26b7da1990ce10ffecfbc1e09eb13aa5d824`.
There is no diff between that release and the inspected development commit in
`packages/plugin/src/tui/context.ts` or `packages/tui/src/plugin/api.tsx`.
The installed binary was not changed.

## Verified capabilities

The native tabs already provide horizontal/vertical layouts, a resizable vertical
rail with a compact mode, drag reordering, status/unread indicators,
project/branch/worktree context, rename/copy-ID/close context actions, and recently
closed tabs. The vertical rail's search button dispatches the session-list dialog;
it is not an inline rail filter. These are baseline behaviors to preserve rather
than new plugin features. Sources:
[tab component](https://github.com/anomalyco/opencode/blob/ed74ec82ce1fe3a36da6c0815a935473ef4bb0fb/packages/tui/src/component/session-tabs.tsx),
[rail search](https://github.com/anomalyco/opencode/blob/ed74ec82ce1fe3a36da6c0815a935473ef4bb0fb/packages/tui/src/component/session-tabs-rail.tsx),
[layout sizing](https://github.com/anomalyco/opencode/blob/ed74ec82ce1fe3a36da6c0815a935473ef4bb0fb/packages/tui/src/ui/layout.ts).

| Capability | Current support |
| --- | --- |
| Commands | Plugin-owned slash commands, palette entries, keymap layers, dispatch of registered host commands. |
| Session navigation | Reactive current route, navigation to home/session/plugin routes. |
| Existing tabs | Reactive list with active/busy/attention/unread; open, focus, move, close. Mutating tab methods require tabs enabled. |
| Session data | Session hierarchy, status, messages, pending work, permissions, forms; location/project/VCS metadata. |
| Persistence | Plugin-namespaced JSON storage shared by TUI processes using the same local storage directory/channel; separate in-process memory. Not cross-machine synchronization. |
| Custom UI | Routes, dialogs, footer/sidebar slots, and a session-specific side panel. |
| Session operations | Generated client supports create, rename/update, archive/unarchive, fork, move, and interrupt. |

Sources: [plugin types](https://github.com/anomalyco/opencode/blob/ed74ec82ce1fe3a36da6c0815a935473ef4bb0fb/packages/plugin/src/tui/context.ts),
[host adapter](https://github.com/anomalyco/opencode/blob/ed74ec82ce1fe3a36da6c0815a935473ef4bb0fb/packages/tui/src/plugin/api.tsx),
[storage](https://github.com/anomalyco/opencode/blob/ed74ec82ce1fe3a36da6c0815a935473ef4bb0fb/packages/tui/src/context/storage.tsx),
[session HTTP contract](https://github.com/anomalyco/opencode/blob/ed74ec82ce1fe3a36da6c0815a935473ef4bb0fb/packages/protocol/src/groups/session.ts).

## Important limits

- No published tab-region replacement slot or per-tab decoration API. The app
  mounts both native tab layouts directly. The `app` slot is below the routed
  content inside its column; it is not a wrapper around the application. A clean,
  persistent left-panel replacement needs a host extension. An existing
  `session.panel` or dialog can prototype the content but has different placement
  and lifecycle.
- Unread is derived from the root session's idle/viewed timestamps. The public
  tab API exposes it read-only. `session.view` acknowledges activity; it cannot
  undo acknowledgment. A custom panel can display plugin-owned manual unread
  marks, but native indicators/navigation will not inherit those marks without
  an extension.
- Tab history commands remain in keybinding configuration but are not registered
  in app commands. Track visited root sessions in plugin memory for MRU return.
- Existing session-list pinning is hidden when native tabs are enabled. It is
  not a pinned section for the tab rail.
- Server session-list search matches titles. Project/directory/archive filters
  and cursor pagination exist. T3-style full-message search requires additional
  indexing/API work; do not treat the local session cache as the full catalog.

Sources: [app layout and commands](https://github.com/anomalyco/opencode/blob/ed74ec82ce1fe3a36da6c0815a935473ef4bb0fb/packages/tui/src/app.tsx),
[tab state](https://github.com/anomalyco/opencode/blob/ed74ec82ce1fe3a36da6c0815a935473ef4bb0fb/packages/tui/src/context/session-tabs.tsx),
[session view](https://github.com/anomalyco/opencode/blob/ed74ec82ce1fe3a36da6c0815a935473ef4bb0fb/packages/core/src/session/session.ts),
[session-list pinning](https://github.com/anomalyco/opencode/blob/ed74ec82ce1fe3a36da6c0815a935473ef4bb0fb/packages/tui/src/component/dialog-session-list.tsx),
[list filtering](https://github.com/anomalyco/opencode/blob/ed74ec82ce1fe3a36da6c0815a935473ef4bb0fb/packages/core/src/session/store.ts).

## Design direction to discuss

The user requires a replacement panel with its own state/storage layer. Native tab
membership/order must not be a second source of truth. Use the public router for
session activation; native tab methods require native tabs enabled and are not
the foundation of this replacement. Prefer a vertical-first panel with stable
ordering, distinct unread and execution indicators, pins, project filtering, and
quick search. A tab-region slot independent of native tab enablement is a proposed
host extension; its contract and deployment require agreement. Native UI can be
the fallback when the plugin is disabled, but restoring it must not silently
overwrite either system's saved list.

Unread is owned by our shared model in the replacement panel. `/unread` marks the
root unread and selects the previous available session, with home as fallback.
Its Focus/Active/Later placement stays unchanged. A subsequent deliberate
visit can clear the manual mark; passive mirrored navigation, reconnect, and
native server viewed events must not do so.

Candidate features: pins and reordering; unread-and-return; MRU navigation;
status indicators; project/worktree filters; title search; close/reopen; park/done
shelf with undo; keyboard selection and actions; optional working shelf;
snooze; batch actions; subagent expansion; horizontal compact view; PR summaries.

The current recommendation is a server companion with TUI and future GUI adapters.
Core archive is not equivalent to Later or removing panel membership. An alternative
per-session persistence mechanism is the existing metadata API, but metadata is
inherited by children/forks and does not by itself cover shared view/navigation.
That alternative is not the selected direction. See
[metadata schema](https://github.com/anomalyco/opencode/blob/ed74ec82ce1fe3a36da6c0815a935473ef4bb0fb/packages/schema/src/session-metadata.ts).

The TUI entry is configured on each workstation that runs the client. The server
entry is configured on the server. The experimental GUI has its own host loading rules
documented in the current brief. Code belongs in a plugin package rather than in
JSON configuration. No runtime configuration has been edited.

## Deeper brief and ownership

Design a replacement tab panel with its own state model and persistence, using
either `ctx.storage` or a separate local backend. Before agreeing on features,
define opening, closing, revisiting, unread, ordering, and restoration through
explicit user journeys. Evaluate T3's actual transitions, compare storage against
demonstrated needs, and identify the minimum host integration. Implementation
remains gated on feature agreement.

| Fact | Authority | Persistence proposal |
| --- | --- | --- |
| Sessions, titles, project/location, execution, permissions, questions | OpenCode server | Read through the client/cache; do not duplicate as plugin-owned truth. |
| Focus/Active/Later placement, ordering, manual unread | Our shared model | Server-side plugin storage; read state and placement are independent. |
| Newly completed work | Server idle/outcome facts + our observed-result watermark | Shared read progress, separate from manual unread; passive native viewed events are not proof of explicit activation. |
| Selected session, MRU, view, search, filters, group expansion | Our shared model | Server-side state; client route/renderers follow explicit selections without echoing them back as new actions. |
| Provisional keyboard highlight, hover, geometry | Each interface | Ephemeral device mechanics; highlighting is not activation. |

The user selected an inbox of active work rather than explicitly opened tabs.
It needs rules for which sessions enter and leave the list. Do not let the client
cache accidentally decide membership.

## Persistence evaluation

**Current recommendation:** use server plugin `ctx.storage` for inbox and shared
selection/filter/navigation state. TUI `ctx.storage` may hold device-specific
rendering mechanics only. These are different APIs and backends. The
following findings concern TUI storage only. If using it for a local document,
use the mutation's freshly loaded draft rather than saving a stale snapshot.

The inspected implementation prefixes plugin keys, rereads disk under a file
lock, writes a temporary file then renames it, and watches the containing
directory. The reactive local store updates after the write completes. Memory is
memoized above plugin reloads. These are useful mechanisms already present.

Limits: no plugin-schema validation/migration; malformed or unreadable JSON falls
back to the caller's initial value; storage is local and channel-scoped, not
automatically server-scoped. Watch failure degrades synchronization. Atomic rename
is not a demonstrated power-loss durability guarantee. These are boundaries of
the backend, not reasons to build speculative recovery infrastructure now.

A separate local JSON backend would require reimplementing locking, watching,
atomic updates, and path ownership without a current user benefit. SQLite becomes
worth evaluating if independently accessible tooling, indexed history, or more
substantial transactions become actual requirements. None is selected yet.

The user explicitly wants one shared work context, including navigation. Startup
reads current server state rather than writing an old client snapshot back.
Passive clients apply updates without recording new visits/history or clearing
unread. Current scope is one user and one server; do not introduce multi-user
scoping. Do not key session organization by title or working directory alone.

## Behavioral acceptance scenarios (proposed, not implemented)

| Scenario | Expected result |
| --- | --- |
| Visit A, then B; run `/unread` in B | B stays in the collection and gets a durable manual mark; A becomes current; visual order stays put. |
| B has never completed a run | Manual marking still works; no fabricated server idle/viewed timestamps. |
| No previously visited available session exists | Mark B and navigate home; keep B in its project section. |
| Highlight B with arrow keys | Neither route nor read state changes until activation. |
| B completes while A is current | B gains new-result attention; its position and the current route do not change. |
| Server emits a view acknowledgment for B | It may affect native completion unread; it does not erase our manual reminder. |
| Return deliberately to B | Clear its manual mark; acknowledge the result actually observed under the chosen read policy. Pending permissions/questions remain pending. |
| Move B to Later | Preserve its read state; keep the selection and reveal B under Later. |
| Open a Later session | Mark observed content read, but leave placement as Later. |
| Close current B | Remove panel membership, retain project attribution/read state; return to previous available session or home; do not stop/archive/delete it. |
| Previous session A was removed, then `/unread` in B | Skip A in recent navigation; do not recreate it. |
| Restart/reconnect | Restore the current server selection, filters, and organization; do not write stale client state back. |
| Another instance already displays B when it is marked unread | A storage refresh alone does not count as a new deliberate visit and erase the mark. |
| Explicit navigation from another supported client | Follow the shared selection without sending a second visit/history/read action. |
| Navigate from an external command to a session outside a filter | Reveal the destination/current session instead of silently leaving an invisible active row; update shared filters as an explicit navigation consequence. |

Implement `/unread` as an explicit action rather than a continuously running
"current session is read" effect. Await the persistence result before reporting
success/navigating. Handle write errors visibly. No proposed behavior here has
been verified in a replacement panel yet.

## Integration findings beyond placement

- Native tab disablement does not disable server view acknowledgments. Our manual
  unread must remain separate from those acknowledgments.
- Native tab membership contributes to background prefetch and retention. With
  our own membership, explicitly load the lightweight metadata and pending
  attention required by rows; refresh after reconnect. The public cache is not
  the full session catalog.
- More precisely, retention evicts transcript and queued-item caches, not session
  metadata, active status, permissions, or forms. Do not infer that every offscreen
  session vanishes. Root/child metadata and initial request snapshots still need
  deliberate loading; public plugin `session.sync` does not expose the host's
  optional `children` argument.
- Native command dispatch for next/close/reopen and attention traversal follows
  native membership. Our panel needs commands that act on its own model and
  deliberately chosen shortcut bindings.
- A slot tied to `tabs.enabled` or native list length would not be sufficient for
  an independent replacement. Its lifetime must also cover home/empty state and
  have an agreed narrow-terminal fallback.

Sources:
[route](https://github.com/anomalyco/opencode/blob/ed74ec82ce1fe3a36da6c0815a935473ef4bb0fb/packages/tui/src/context/route.tsx),
[retention](https://github.com/anomalyco/opencode/blob/ed74ec82ce1fe3a36da6c0815a935473ef4bb0fb/packages/client/src/solid/retention.ts),
[cache eviction and event handling](https://github.com/anomalyco/opencode/blob/ed74ec82ce1fe3a36da6c0815a935473ef4bb0fb/packages/client/src/solid/data.ts),
[atomic write](https://github.com/anomalyco/opencode/blob/ed74ec82ce1fe3a36da6c0815a935473ef4bb0fb/packages/tui/src/util/persistence.ts),
[T3 local mark-unread](https://github.com/pingdotgg/t3code/blob/1316d48b0c68151afd8b47eb0c11a114cf0b4daa/apps/web/src/uiStateStore.ts).

## Checks run on 2026-10-27

The first upstream test attempt could not load: stale OpenTUI 0.5.14 dependencies
lacked `NativeError`. Ran `bun install --frozen-lockfile --ignore-scripts --filter
'@opencode/tui'` in the checkout to synchronize the focused dependency set. The
source and lockfile remained unchanged; the installed global CLI was untouched.

From `packages/tui`, with `TMPDIR=/tmp/opencode`:

`bun test test/context/storage.test.ts test/context/session-tabs-model.test.ts test/context/session-tabs.test.tsx --timeout 30000`

Result: **59 passed, 0 failed**, including native viewed/focus behavior, tabs-off
acknowledgment, tab history/ordering models, and graceful storage watcher failure.
The logged ENOSPC warning is intentionally injected by the passing watcher test.

Two isolated contract probes in `/tmp/opencode/tab-storage-contract.test.ts`
imported the actual production `createStorage`. Both passed: concurrent mutations
from two independent storage instances preserved both edits and synchronized their
views; reconstruction preserved durable state and reset memory, while reacquiring
memory within one instance preserved it. These are same-process instances, not
an OS-process crash test. The first reconstruction probe reused a mutated initial
object; corrected it to construct fresh initial state, as a restart would.

These checks validate existing primitives and inform the recommendation. They do
not establish replacement-panel usability, power-loss recovery, or the proposed
behavioral scenarios. Those require model tests and real-TUI interaction tests
after the feature set is agreed.
