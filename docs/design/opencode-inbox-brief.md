# OpenCode project inbox — interaction brief and text wireframes

Updated 2026-10-29. User requirements and target interaction design are recorded
below. A working prototype exists; see the README for implemented behavior and
remaining host/UI integration work.

## Confirmed needs

- Build our own panel and state model, backed by a storage system we control.
- The intended final panel is always available and replaces native tabs. The
  first preview uses a supported side/full-screen panel; native placement follows
  getting the client interface working reliably.
- Show an inbox of work, not just explicitly opened tabs.
- Make running background work, requests for attention, and project scope obvious.
- Group sessions from a project and its worktrees together.
- Show a saved set of open projects rather than all projects. Closing a project
  hides it while preserving session membership and per-session state. Reopening
  restores that membership; explicit session removal stays removed until revisited.
- Opening a session reopens its project and admits the session into that saved set.
- Share selected session, views, search, filters, and organization across clients
  of this single-user server. Clients are interfaces to the same work state.
- `/unread` marks unread and returns to the previous session. It does not move
  the session to Later, lower its priority, finish it, or archive it.
- Later and unread are independent: a Later session can be read or unread.
- Keep high-priority active work prominent, Later work within its project, and
  quiet/historical work out of the way without losing it.
- Typical topology: one TUI on a workstation connecting to this host with
  `opencode --server`; occasionally another workstation or the official mobile app. The
  server's terminal is rarely the actual client.

## Persistence and installation recommendation

Use a server companion and client adapters with shared schemas/RPC definitions.
The companion stores our per-session organization overrides through server plugin
`ctx.storage`, in the existing server database. This storage is namespaced by
plugin ID, not by location. The TUI calls it through `context.client.rpc` using its
existing connection. No new database service is needed.

Server-owned shared state includes:

- Selected root session and recent explicit navigation (including the previous
  session needed by `/unread`).
- Selected view, project scope, applied search query, filters, and expanded groups.
- Per-session placement, stable order, read progress, and manual unread marks.

Only device mechanics remain local: terminal/pixel dimensions, responsive panel
width, scroll layout, hover, input-method composition, and the provisional keyboard
cursor before Enter. These do not create a different saved inbox or selection.
The same shared state may render differently on a narrow phone and a wide terminal.

### Shared selection: one work context, several interfaces

An explicit selection on one connected, supported client updates the server and
the other clients follow it. That can switch the workstation conversation when
the user selects another session on their phone; it is the chosen behavior.

The necessary guardrails are causal, not per-user infrastructure:

- Client startup/reconnect first reads the current server snapshot. It must not
  publish its old route/filter as a new user action.
- Applying a received selection does not publish it again, advance recent
  navigation, clear unread, or take OS keyboard focus.
- Only deliberate activation/read actions acknowledge a manual unread mark.
  Restoring/mirroring a route or highlighting a row is not proof of reading.
- Ordered server revisions keep stale responses from reverting newer state.
- Prompt drafts remain attached to their original sessions through a route change;
  never transplant text between sessions. Existing client draft behavior needs a
  live interaction check before synchronized navigation ships.

No multi-user model is in scope. Different users can be addressed if that becomes
a real requirement.

The server KV API exposes get/set/remove/scan, not TUI storage's locked draft
mutation API. Do not transfer transaction guarantees from one API to the other.
RPC handlers are location-scoped although storage is shared; establish explicit
RPC routing/activation during implementation. RPC events are live-only, so fetch
a fresh snapshot on connection/reconnection.

The server companion must be configured on this server. The TUI package and any
required host UI extension must be available on the workstations actually running
the client. Editing only this server's `cli.json` will not configure those TUIs.
Each supported client needs an adapter to publish/apply our shared selection and
filters. Unmodified clients do not gain that behavior just because data is stored
on the server. Native read receipts are not evidence of a deliberate visit in our
model and must not erase a manual unread mark.

## Project-first, with two optional cross-project lenses

1. **All — default:** projects contain Focus, Active, and Later.
   Focus is the short list of top-priority work. Active is the
   ordinary working set, including paused/idle work the user still wants nearby.
   Later stays inside the project and does not mean read. Empty sections vanish.
2. **Needs you:** a filtered cross-project view for unread results/reminders and
   unresolved human requests or unacknowledged failures/interruption. Preserve
   project and placement labels; a Later item can appear here without moving.
3. **Running:** currently running/queued root families in the open working set,
   including Later. Preserve project and placement labels.

These are projections of one collection, not copies with independent state.
Their scope is the shared open-project working set; parked projects are available
through the project opener. Closing a project is distinct from folding a header,
moving a session to Later, or stopping execution. The first open imports existing
nonarchived roots; subsequent opens restore saved membership rather than reimporting.
Needs you and Running are convenient filters, not extra lifecycle states.
All three views retain the same project/section hierarchy. `[` and `]` cycle
through them, wrapping at both ends, while the panel owns keyboard focus. Do not
turn an old acknowledged failure into a permanent alarm.

## Work hypotheses and resulting rules

These are design hypotheses, not claims of a user study:

| Hypothesis | Rule implemented | Check |
| --- | --- | --- |
| People alternate dispatching, monitoring, and responding. | All/Needs you/Running are filters of one stable hierarchy. | View-cycle/model tests preserve placement and navigation. |
| Priority differs from execution. | Focus/Active/Later are user choices; completion changes status, not placement. | Running Later stays Later. |
| Reading is not prioritization. | Unread and Later remain independent. | Read/unread tests preserve placement. |
| Putting work away needs one concept. | Close removes membership; opening the session restores it. History is retired. | Membership and legacy-migration tests. |
| Spatial/context stability reduces switching effort. | No navigation rewrites filters; the selected row remains as context; rows keep their section/depth across views; new work enters at the top and existing rows never move. | Selection/filter-preservation, hierarchy, and admission-order tests. |

T3 inspiration: saved manual ordering and separate priority/working concepts. Its
automatic settlement and activity-driven ordering are not adopted. Raw sources:
[thread sidebar](https://github.com/pingdotgg/t3code/blob/1316d48b0c68151afd8b47eb0c11a114cf0b4daa/docs/user/thread-sidebar.md),
our reducer (`src/model.ts`), and existing terminal captures. Actual usability of
the revised layout and bracket bindings still needs an explicitly requested live
walkthrough; focused model tests cannot establish that.

Use server `session.projectID` as the repository grouping key. Use the project's
canonical directory/name as presentation and the session's location as the
checkout/worktree context. Identity can span clones of the same remote, so a
canonical directory is not itself the identity. For `projectID=global` (including
unversioned directories), use directory-based grouping rather than merging all
unrelated directories into one project. Directory overrides can be discussed if
the native grouping does not match the user's project boundaries.

## Independent dimensions, simple rows

| Dimension | Values | Who changes it? |
| --- | --- | --- |
| Placement | Focus, Active, Later | User actions. It does not follow every execution update. |
| Read | Read or unread | Deliberate reading, explicit read/unread commands, or new unseen results. A native view acknowledgment reads a completion, never a manual mark. |
| Execution | Working, waiting for input, or idle; outcome retained | OpenCode facts, aggregated across the root session's family. |

Rows show symbols for Running, Queued, Question, Approval, Interrupted, or Error.
Ready/Idle use no row decoration; the highlighted row's footer explains the status.
These labels explain execution; they are not
eight user-managed workflow states. Ready means a run ended successfully, not
that the project task is finished. Reading an Error does not make execution
successful; it only acknowledges the unread/attention aspect.

A question/approval takes priority in the status label when a family also has
running work; the running count still includes that family. User placement and
read state never imply that a process stopped. Shutdown/superseded interruptions
must not be treated as fresh errors merely because an event says interrupted.

Keep a dedicated unread column, a title, and a status symbol. Project/checkout
context occupies a subordinate line when width allows. Use semantic theme colors
in implementation, but labels and marks must remain sufficient in monochrome.

## Compact layout sketch

This is a design sketch, not a fresh captured render. `>` marks the current
conversation and `●` unread. Only collapsed headings need summary counts.

```text
Inbox                                  + [p]
[All]  Needs you  Running
All open [f]                  / Search
▾ dotfiles
  ▾ Focus
    > Inbox panel                         ↻
      ● Choose behavior                   ?
  ▾ Active
      ● Review provider config
        Index files                       ↻
        indexer
  ▸ Later (2)                           ● 1
▾ api-server
      ● Diagnose reconnect                !
        Service notes
Unread · Question                 [] views ?
```

Needs you and Running filter these rows without flattening the hierarchy. A read
question still qualifies until answered. Opening a matching row retains its
context until another selection/filter action; it never clears filters merely
because the result became read. Selection, scope, and fold choices stay shared.

## Actions and transitions

| Action | Read state | Placement | Navigation |
| --- | --- | --- | --- |
| `/unread` | Set unread, even with no completed run | Unchanged | Return to previous available session; home if none. |
| Mark unread from another row's menu | Set unread | Unchanged | Keep the current conversation. |
| Deliberately open a row | Mark observed content read; clear manual mark | Unchanged, including Later | Select it across supported clients. |
| Mark read | Acknowledge currently observed result/manual mark | Unchanged | Stay. Questions/permissions remain unresolved. |
| Move to Focus | Unchanged | Focus | Keep selection. |
| Move to Active | Unchanged | Active | Keep selection. |
| Move to Later / `/later` | Unchanged | Later | Keep selection; add the session to its project if unlisted. |
| Close session | Unchanged | Removed from saved membership | Return to previous available session. Opening it normally restores it. |
| Background completion/question/error | Mark new unseen information as appropriate | Unchanged | No automatic session switch. |

`/later` is not an alias for `/unread`. Opening a Later session does not remove
Later. Closing removes it from the main working set, not from its real project,
and does not archive/delete/interrupt the underlying session. History is not a
separate destination; no replacement Closed section is added to the panel.

**Permanent boundary:** this panel must never delete sessions or offer deletion
through a menu, shortcut, or RPC action. Session deletion belongs exclusively to
OpenCode's native session-list viewer. “Remove from panel” changes only our saved
membership; the conversation remains available through the native session list.

All four combinations are valid and visible:

```text
Active + read       = in my working set; already checked
Active + unread     = in my working set; come back to this
Later  + read       = understood; deliberately parked
Later  + unread     = parked; still needs reading/thought
```

Unread is not a reason to close a row. Reading is not a reason
to move it to Later or declare the work finished. No automatic Later-to-Active
promotion is proposed: new urgency changes badges/counts and the Needs-you lens.

## Smoothness and boundary behavior

- Stable order within sections; status changes do not reorder any view. Newly
  admitted sessions enter at the top of their project (matching the newest-first
  first import); revisiting an existing row never moves it.
- Move-to commands put the row in its destination once. Explicit
  manual reordering can be added without changing these semantics.
- Focus always remains visible when its project is expanded. Quiet means read,
  idle, nonblocking ordinary Active rows; optional quiet folding is a derived
  presentation setting, not another persisted placement. Never fold unread,
  running, blocked, or Focus rows into Quiet automatically.
- Search includes Later in the working set; closed sessions are reopened through
  the native session viewer. An empty filter
  result explains the filter and offers Clear filters rather than looking broken.
- Any navigation, inbox or native, reveals the selected session's project/section
  and keeps it visible as context even outside the current filters; it never
  rewrites the shared view, search, or scope. Filter changes are shared actions.
- Root sessions are the list unit; child attention rolls up to the root. A child
  drill-down creates no inbox item or selection, and a client already showing the
  selected family (root or subagent) is not redirected.
- A newly connected client shows Loading/Connecting until the snapshot arrives,
  not an empty inbox that could overwrite server state. Failed writes are visible
  and must not be reported as saved.

## GUI plugin opportunity and limits

The [GUI plugin guide](https://opencode.ai/v2/docs/build/plugins/gui), read on
2026-10-28, documents the experimental `./gui-experimental` entry beside `./tui`
and the server entry. One package can therefore share its state/actions and have
different renderers. The GUI SDK includes panels, commands, tab navigation, and
narrow-screen panel presentations.

Important integration facts from that guide:

- Desktop loads GUI bundles from its own background server; this is not a promise
  that installing a plugin only on the server injects it into every remote client.
- GUI `ctx.client` addresses the desktop's own server. For this remote inbox use
  the connected the server server's client (`session.server.client` or the appropriate
  live `ctx.servers.get(id).client`), not the sidecar by accident.
- GUI `Store.global` is app-global, not shared-server storage. Desktop uses IPC
  storage and web uses localStorage. Our shared selection/filter/inbox authority
  therefore remains the server companion's RPC/storage.
- Public GUI Panels contribute to a session's side region. The documented slots
  do not expose replacement of the application's project/session navigation
  sidebar. A custom inbox panel is supported; identical left-rail placement in
  all clients is not established by this API.
- `mobile` is documented as narrow-screen panel presentation. The page does not
  establish that the official native mobile app loads third-party GUI bundles;
  verify that separately before committing native-mobile parity. The guide also
  describes web APIs while its loading instructions are desktop-specific.

The TUI's missing independent tab-region slot remains a separate host integration
requirement. UI adapters can share all domain state without sharing render code.

## Baseline to confirm

Shared server-backed selection, filters, read state, and organization; project-first
panel; Focus/Active/Later placement and one Close action; independent unread and execution;
optional Needs-you/Running lenses; `/unread` mark-and-return; separate Later
action; search/project filtering; keyboard and mouse actions; native conversation
UI retained. One state/action contract supports TUI and future GUI adapters.

Initialization adopts only the currently viewed project, not every recent project.
The first explicit open saves that project's nonarchived root sessions. Subsequent
opens restore the saved set, including placement and unread marks. Explicitly
visiting another session admits it; polling never resurrects closed projects or
removed membership. Legacy History migrates to closed membership with unread
preserved; reopening uses Active. An already-viewed History session remains open
as Active to avoid a migration-driven route switch.

The user prefers project-local Focus versus Active; both remain. Native mobile
and GUI sidebar replacement remain capability checks, not assumed features.

## Evidence

At OpenCode `ed74ec82ce1fe3a36da6c0815a935473ef4bb0fb`:

- [Server storage namespace](https://github.com/anomalyco/opencode/blob/ed74ec82ce1fe3a36da6c0815a935473ef4bb0fb/packages/core/src/plugin/host.ts#L644) and [database-backed global KV](https://github.com/anomalyco/opencode/blob/ed74ec82ce1fe3a36da6c0815a935473ef4bb0fb/packages/core/src/kv.ts).
- [Plugin RPC guide](https://opencode.ai/v2/docs/build/plugins/rpc) documents TUI-to-server calls, live events, and location scope.
- [Session schema](https://github.com/anomalyco/opencode/blob/ed74ec82ce1fe3a36da6c0815a935473ef4bb0fb/packages/schema/src/session.ts), [project discovery](https://github.com/anomalyco/opencode/blob/ed74ec82ce1fe3a36da6c0815a935473ef4bb0fb/packages/core/src/project.ts), and [linked-worktree test](https://github.com/anomalyco/opencode/blob/ed74ec82ce1fe3a36da6c0815a935473ef4bb0fb/packages/core/test/project.test.ts#L701).

Prior verification on 2026-10-27, from `packages/core`:
`TMPDIR=/tmp/opencode bun test test/kv.test.ts test/project.test.ts --test-name-pattern 'KV|linked worktree returns' --timeout 30000`.
Result: **4 passed, 0 failed**, 28 unrelated cases filtered out. Tests verify JSON
KV operations/scans and linked-worktree project resolution. They do not establish
mobile support, deployed RPC connectivity, or replacement-panel behavior.

2026-10-28: read the full GUI guide and plugin loading guide; reconciled shared
selection/filter requirements and checked the wireframes/action table against
the independent unread/Later cases. Whitespace checks reported no errors. These
are text design examples, not renders from a running plugin.
