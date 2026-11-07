import { Plugin } from "@opencode/plugin/tui"
import { appendFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createEffect,
  createMemo,
  createRoot,
  createSignal,
  ErrorBoundary,
  on,
  onCleanup,
  onMount,
  Show,
  untrack,
} from "solid-js"
import { Switchboard } from "./rpc"
import { createClientState } from "./client"
import { actionErrorText, errorDetails, errorText, isTransportError, RECONNECTING } from "./error-text"
import { initialState, parkedKey, projectOf, type Action, type Session, type State } from "./model"
import { liveSession, loadCatalog, type CatalogMemory } from "./catalog"
import type { Attention } from "./attention"
import { HELP_COMMANDS, HelpDialog, helpShortcuts } from "./help"
import { InboxPanel, type PanelProps } from "./panel"
import { palette } from "./palette"
import { createSelectionMemory, createSessionHistory, fallbackSession, recordShown } from "./selection"

/** The host's plugin boundary only toasts render crashes; keep the stack for diagnosis. */
const ERROR_LOG = join(tmpdir(), "opencode-switchboard-errors.log")
function logError(where: string, cause: unknown) {
  let detail = cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)
  if (typeof cause === "object" && cause !== null) {
    try {
      detail += `\n${JSON.stringify(cause, Object.getOwnPropertyNames(cause))}`
    } catch {}
  }
  try {
    appendFileSync(ERROR_LOG, `${new Date().toISOString()} ${where}\n${detail}\n\n`)
  } catch {}
}

const PANEL = "switchboard"
/** How often the open switchboard refreshes its catalog. */
const POLL = 15_000
/** While the connection is down, the first retry waits this long, then doubles up to `POLL`. */
const RETRY = 2_000

type Controls = Parameters<NonNullable<PanelProps["keys"]>>[0]
type LocationProject = { directory: string; project: { id: string; canonical: string } }

/** The host supplies synced location info, though the plugin API types it as a bare LocationRef. */
function locationProject(value: unknown): LocationProject | undefined {
  if (typeof value !== "object" || value === null || !("project" in value) || !("directory" in value)) return
  const project = value.project
  if (typeof project !== "object" || project === null || !("id" in project) || !("canonical" in project))
    return
  if (
    typeof project.id !== "string" ||
    typeof project.canonical !== "string" ||
    typeof value.directory !== "string"
  )
    return
  return { directory: value.directory, project: { id: project.id, canonical: project.canonical } }
}

export default Plugin.define({
  id: "opencode-switchboard",
  setup(ctx) {
    const directory =
      typeof ctx.options.backendDirectory === "string"
        ? ctx.options.backendDirectory
        : (ctx.location ?? ctx.data.location.default()).directory
    const rpc = ctx.client.rpc(Switchboard)
    const options = { location: { directory } }
    const [state, setState] = createSignal(initialState())
    const [sessions, setSessions] = createSignal<Session[]>([])
    const [error, setError] = createSignal("")
    const [refreshError, setRefreshError] = createSignal("")
    // The last refresh failed for lack of a connection: the footer says it is reconnecting, not the raw error.
    const [reconnecting, setReconnecting] = createSignal(false)
    const [issues, setIssues] = createSignal<string[]>([])
    const attention = new Map<string, Attention>()
    // The catalog reads tracked sessions through this location's server part, which also answers the RPC.
    const catalogMemory: CatalogMemory = { location: options.location }
    // Keep an opaque mutable cursor across both panel remounts and plugin reloads.
    // Map entries are not wrapped in Solid's read-only store proxies.
    const [local] = ctx.storage.memory("panel-selection", {
      initial: { cursors: new Map([["inbox", createSelectionMemory()]]) },
    })
    const selectionMemory = local.cursors.get("inbox")!
    // This TUI's current session and the sessions it showed recently. Per TUI and in memory, like OpenCode's tab
    // history: it survives plugin reloads and is forgotten on restart. Another TUI never changes it.
    const [sessionMemory] = ctx.storage.memory("session-history", {
      initial: { tuis: new Map([["tui", createSessionHistory()]]) },
    })
    const history = sessionMemory.tuis.get("tui")!
    // `history.current`, readable reactively: the fullscreen switchboard marks it as the current row.
    const [shown, setShown] = createSignal(history.current)
    function show(id: string | null) {
      if (id) recordShown(history, id)
      else history.current = null
      setShown(id)
    }
    // How this TUI shows the switchboard; only the "projects" view exists so far (#53).
    createClientState(ctx.storage)
    // Per-machine and durable, so the native-tabs hint shows once, not on every open.
    const [hints, setHints] = ctx.storage.store("hints", { initial: { nativeTabs: false } })
    const [loading, setLoading] = createSignal(false)
    // Whether a server state has arrived since this TUI started; until then every conversation looks unlisted.
    const [synced, setSynced] = createSignal(false)
    // Opens of the switchboard still running: each lists the conversation shown once its refresh lands.
    const [opening, setOpening] = createSignal(0)
    // Visits on their way, by the route's session ID. A draft session keeps its entry until `session.created`
    // visits it again.
    const [arriving, setArriving] = createSignal<ReadonlySet<string>>(new Set())
    function arrive(id: string, pending: boolean) {
      const next = new Set(arriving())
      if (pending) next.add(id)
      else next.delete(id)
      setArriving(next)
    }
    // Conversations whose rows this TUI itself takes away: a row it is closing, or a session it saw deleted. Their
    // rows go on purpose, so they never count as missing.
    const [leaving, setLeaving] = createSignal<ReadonlySet<string>>(new Set())
    function leave(id: string, gone: boolean) {
      const next = new Set(leaving())
      if (gone) next.add(id)
      else next.delete(id)
      setLeaving(next)
    }
    let enabled = false
    let stopped = false
    // Set when the switchboard itself navigates home (e.g. after closing a project), so the
    // home screen it lands on does not count as choosing that project.
    let navigatedHome = false
    // The session the switchboard itself went back to after closing the current row. The route effect still
    // visits it, but leaves keyboard focus where it is: in the panel, so `x` can close the next row.
    let wentBack: string | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    // Refreshes failed in a row for lack of a connection; sets how soon the next one retries.
    let retries = 0
    let membership = ""
    let refreshAgain = false
    // Settles once every action this TUI has sent so far has returned and been accepted.
    let acting: Promise<void> = Promise.resolve()
    let lastCatalog = ""
    // The mounted side panel's controls and the host's focus function for it.
    let controls: Controls | undefined
    let focusPanel: (() => void) | undefined
    // A session was opened from the panel: hand focus to its conversation
    // (the composer) once the route settles and the panel remounts beside it.
    let focusConversation = false
    // Whether the fullscreen switchboard covers the new-session screen, and that screen's project.
    const [fromHome, setFromHome] = createSignal(false)
    let homeLocation: LocationProject | undefined
    // Rows take their indicators from OpenCode's live session store, as the native tabs do; see `liveSession`.
    const live = createRoot((dispose) => {
      const shown = createMemo(
        () => sessions().map((session) => liveSession(ctx.data.session, session)),
        [],
        { equals: (a, b) => a.length === b.length && a.every((session, index) => session === b[index]) },
      )
      // Once a row's run and requests end, refresh the catalog values kept where OpenCode has not loaded the session.
      createEffect(
        on(
          () =>
            shown().flatMap((session) =>
              session.running || session.status === "Approval" || session.status === "Question"
                ? [session.id]
                : [],
            ),
          (now, before = []) => {
            if (enabled && before.some((id) => !now.includes(id))) void refresh()
          },
          { defer: true },
        ),
      )
      return { shown, dispose }
    })

    function returnFocus() {
      if (!focusConversation) return
      focusConversation = false
      ctx.keymap.dispatch("pane.focus.left")
    }
    function report(cause: unknown) {
      logError("action", cause)
      if (stopped) return
      setError(actionErrorText(cause))
    }
    /** A refresh, or a snapshot read for one, failed; while disconnected, retry sooner than the poll. */
    function refreshFailed(where: string, cause: unknown) {
      logError(where, cause)
      if (stopped) return
      setRefreshError(errorText(cause))
      const lost = isTransportError(cause)
      setReconnecting(lost)
      if (!lost) return
      // The server may come back with a newer server part: ask it for the catalog method again.
      catalogMemory.legacy = false
      clearTimeout(timer)
      timer = setTimeout(poll, Math.min(RETRY * 2 ** retries++, POLL))
    }
    function showPanel() {
      if (ctx.ui.panel.open(PANEL)) return
      // No side panel here (e.g. the new-session screen): show the switchboard fullscreen.
      const route = ctx.ui.router.current()
      if (route.type === "plugin") return
      setFromHome(route.type === "home")
      homeLocation = route.type === "home" ? locationProject(ctx.location) : undefined
      ctx.ui.router.navigate({ type: "plugin", name: "switchboard" })
    }
    /**
     * The conversation this TUI shows: its route, or the session it showed last when the fullscreen switchboard
     * covers it. None on, or fullscreen over, the new-session screen.
     */
    function viewing() {
      const route = ctx.ui.router.current()
      if (route.type === "session") return ctx.data.session.root(route.sessionID)
      if (route.type === "home" || (route.type === "plugin" && fromHome())) return null
      return shown()
    }
    /** The root of the session this TUI's route shows, or null. */
    function routeRoot() {
      const route = ctx.ui.router.current()
      return route.type === "session" ? ctx.data.session.root(route.sessionID) : null
    }
    /**
     * Shows a session, or home, beside the panel. A route already showing that conversation family stays, so a
     * subagent stays open; navigating to the route already shown would not notify the route effect anyway.
     */
    function navigate(id: string | null) {
      const moved = routeRoot() !== id
      if (moved) {
        navigatedHome = id === null
        ctx.ui.router.navigate(id ? { type: "session", sessionID: id } : { type: "home" })
      }
      showPanel()
      return moved
    }
    /**
     * Leaves a session whose row this TUI closed or saw deleted: to the most recent session still open, else the
     * first open one, else home. Only the TUI that closes a row leaves it; others keep showing the conversation.
     */
    function goBack(closed: string) {
      const destination = fallbackSession(state(), history.recent, closed)
      show(destination)
      wentBack = destination ?? undefined
      if (!navigate(destination)) wentBack = undefined
    }
    /** Applies an action from this TUI; if it closed the row of the session shown here, goes back. */
    async function change(action: Action) {
      const id = viewing()
      const listed = id !== null && projectOf(state(), id) !== undefined
      if (listed) leave(id, true)
      try {
        await act(action)
        if (listed && enabled && viewing() === id && !projectOf(state(), id)) goBack(id)
      } finally {
        if (listed) leave(id, false)
      }
    }
    /**
     * Shows a newer state. A membership change refreshes the catalog, unless `loading` says the caller is about to
     * load it for this state anyway (the snapshot that starts a refresh).
     */
    function accept(next: State, loading = false) {
      if (stopped) return
      setSynced(true)
      // Revisions only grow; an equal one is the state already shown (e.g. a duplicate snapshot).
      // Another TUI's change updates rows here, but never this TUI's route.
      if (next.revision <= state().revision) return
      const admitted = Object.entries(next.projects)
        .filter(([, project]) => project.open)
        .map(([id, project]) => `${id}:${project.sessions.join(",")}`)
        .join("\n")
      const membershipChanged = admitted !== membership
      membership = admitted
      setState(next)
      if (enabled && membershipChanged && !loading) void refresh()
    }
    /** Sends an action to the server; resolves whether it succeeded. */
    function act(action: Action) {
      const done = send(action)
      // Resolve to nothing, so the chain does not keep every earlier result.
      acting = Promise.all([acting, done]).then(() => {})
      return done
    }
    async function send(action: Action) {
      try {
        accept(await rpc.act(action, options))
        setError("")
        return true
      } catch (cause) {
        report(cause)
        return false
      }
    }
    async function refresh() {
      if (stopped) return
      if (loading()) {
        refreshAgain = true
        return
      }
      setLoading(true)
      try {
        // The catalog loads for this state next, so its membership change needs no second refresh.
        accept(await rpc.snapshot({}, options), true)
        const result = await loadCatalog(ctx.client, state(), attention, history.current, catalogMemory)
        if (stopped) return
        // Identical catalogs must not re-render the panel; most refreshes change nothing.
        const catalog = JSON.stringify(result.sessions)
        if (catalog !== lastCatalog) {
          lastCatalog = catalog
          setSessions(result.sessions)
        }
        setRefreshError(result.warning)
        setReconnecting(false)
        retries = 0
        setIssues(result.issues)
      } catch (cause) {
        refreshFailed("refresh", cause)
      } finally {
        if (!stopped) {
          setLoading(false)
          if (refreshAgain && enabled) {
            refreshAgain = false
            void refresh()
          }
        }
      }
    }
    /** Put the cursor on a row, including before the panel mounts. */
    function reveal(key: string) {
      selectionMemory.key = key
      controls?.reveal(key)
    }
    /** Unfold whatever hides the current conversation's row, then put the cursor on it. */
    async function revealCurrent() {
      const route = ctx.ui.router.current()
      // Over the new-session screen, no session is current: start on its project instead.
      if (viewing() === null && route.type !== "session") {
        if (homeLocation) await openLocationProject(homeLocation)
        return
      }
      const id = route.type === "session" ? ctx.data.session.root(route.sessionID) : history.current
      if (!id) return
      const project = projectOf(state(), id)
      if (!project) return
      // Unfold rather than toggle: a stale state() must never fold what it means to reveal.
      if (state().collapsed.includes(project)) await act({ type: "fold", key: project, folded: false })
      if (state().sessions[id]?.placement === "parked" && state().collapsed.includes(parkedKey(project)))
        await act({ type: "fold", key: parkedKey(project), folded: false })
      reveal(`session:${id}`)
    }
    async function openInbox() {
      setOpening((count) => count + 1)
      try {
        const alreadyOpen = enabled && ctx.ui.panel.current()?.name === PANEL
        enabled = true
        focusConversation = false
        if (alreadyOpen) {
          // Move the cursor synchronously, before the refresh, so the next keypress acts on it.
          focusPanel?.()
          void revealCurrent()
        } else showPanel()
        suggestDisablingTabs()
        await refresh()
        // Startup (--session), and reopening after navigating while the switchboard was closed, adopt the route.
        await listViewing()
      } finally {
        setOpening((count) => count - 1)
      }
    }
    /**
     * Lists the conversation this TUI shows if it has no row, or is not yet this TUI's current session, then puts the
     * cursor on it. The open command does this; it is how a conversation whose row went (see `missing`) comes back.
     */
    async function listViewing() {
      const route = ctx.ui.router.current()
      if (route.type === "session") {
        const root = ctx.data.session.root(route.sessionID)
        if (history.current !== root || !projectOf(state(), root)) await visit(route.sessionID)
      } else if (route.type === "plugin") {
        // The fullscreen switchboard covers the conversation it shows; none over the new-session screen.
        const id = viewing()
        if (id && !projectOf(state(), id)) await visit(id)
      }
      await revealCurrent()
    }
    /**
     * Whether the conversation this TUI shows has no row. Not before the first server state, nor while an open or a
     * visit is about to list it, nor while this TUI takes the row away itself. A route this TUI has not adopted yet is
     * on its way: the route effect visits it right after the route changes.
     */
    function missing() {
      const id = viewing()
      if (
        id === null ||
        id !== shown() ||
        !synced() ||
        opening() ||
        leaving().has(id) ||
        projectOf(state(), id)
      )
        return false
      const route = ctx.ui.router.current()
      return !arriving().has(route.type === "session" ? route.sessionID : id)
    }
    function canCloseCurrent() {
      const id = viewing()
      return Boolean(enabled && id && projectOf(state(), id))
    }
    async function closeCurrent() {
      if (!canCloseCurrent()) return
      const id = viewing()!
      const route = ctx.ui.router.current()
      // A route change may still be committing its visit when the shortcut is pressed; let it land first, so
      // it cannot list the session again after the removal.
      if (history.current !== id && route.type === "session") await visit(route.sessionID)
      if (stopped || !enabled || viewing() !== id) return
      focusConversation = true
      await change({ type: "session-remove", sessionID: id })
      setTimeout(returnFocus, 0)
    }
    /** The switchboard is meant to replace the native tabs; say once how to turn them off. */
    function suggestDisablingTabs() {
      if (hints.nativeTabs || !ctx.ui.tabs.enabled()) return
      void setHints((draft) => {
        draft.nativeTabs = true
      })
      ctx.ui.toast.show({
        variant: "info",
        title: "Switchboard replaces session tabs",
        message: 'To hide the native tabs, set "tabs": { "mode": "off" } in ~/.config/opencode/cli.json.',
        duration: 10_000,
      })
    }
    function close() {
      enabled = false
      ctx.ui.panel.close()
      if (ctx.ui.router.current().type === "plugin") {
        const selected = viewing()
        ctx.ui.router.navigate(selected ? { type: "session", sessionID: selected } : { type: "home" })
      }
    }
    /**
     * Whether a visit to the route's session ends with the panel shown: a session this TUI shows, unless it is a
     * subagent of the current session, whose visit records nothing.
     */
    function visitShowsPanel(id: string) {
      const route = ctx.ui.router.current()
      if (stopped || !enabled || route.type !== "session" || route.sessionID !== id) return false
      const root = ctx.data.session.root(id)
      return !(root !== id && root === history.current && projectOf(state(), root))
    }
    async function visit(id: string) {
      // A navigation OpenCode drove (Ctrl+O, its session list) can replace the session view and close the side
      // panel, showing the native sidebar instead. While the switchboard is open, a visit shows it again at once,
      // in the tick the route changes: the host then mounts the destination and the panel together, as a switch
      // from the panel does. Only this TUI's own visits do this; another TUI's changes never open anything here.
      arrive(id, true)
      if (visitShowsPanel(id)) showPanel()
      // A draft session stays arriving: its `session.created` visits it again.
      let draft = false
      try {
        let root = ctx.data.session.root(id)
        let observed = sessions().find((session) => session.id === root)?.idle
        if (observed === undefined) {
          let info = await ctx.client.session.get({ sessionID: id })
          while (info.parentID) info = await ctx.client.session.get({ sessionID: info.parentID })
          root = info.id
          observed = info.time.idle ?? 0
          // Still showing it: the same route, or the fullscreen switchboard over its conversation.
          const route = ctx.ui.router.current()
          const here = route.type === "session" ? route.sessionID === id : viewing() === root
          if (stopped || !enabled || !here) return
        }
        // A subagent of the current session is the same work context: record nothing, unless its row is gone.
        if (root !== id && root === history.current && projectOf(state(), root)) return
        show(root)
        if (!(await act({ type: "visit", sessionID: root, observed }))) return
        // Ends with it shown too, in case the host closed it meanwhile.
        if (!stopped && enabled && ctx.ui.router.current().type === "session") showPanel()
      } catch (cause) {
        // The host navigates optimistically, before its create request commits.
        // Retry on session.created instead of showing an error for that local draft.
        if (
          typeof cause === "object" &&
          cause !== null &&
          "_tag" in cause &&
          cause._tag === "SessionNotFoundError" &&
          ctx.data.session.get(id)
        ) {
          draft = true
          return
        }
        report(cause)
      } finally {
        if (!draft) arrive(id, false)
      }
    }
    /** A project's home screen (e.g. picked in Ctrl+O) opens that project; a saved one keeps its sessions. */
    async function openLocationProject(location: LocationProject) {
      const global = location.project.id === "global"
      const key = global ? location.directory : location.project.id
      if (!state().projects[key]?.open) {
        const name =
          state().projects[key]?.name ||
          (global ? undefined : ctx.data.project.get(location.project.id)?.name) ||
          (global ? location.directory : location.project.canonical).split("/").filter(Boolean).at(-1) ||
          key
        await act({ type: "project-open", project: key, name })
      } else if (state().collapsed.includes(key)) await act({ type: "fold", key, folded: false })
      reveal(`heading:${key}`)
    }
    /**
     * A project's main directory: a directory key is one already; otherwise the project's canonical directory,
     * from OpenCode's synced projects, else a main-checkout row in the catalog, else the server's project list.
     * Never a worktree.
     */
    async function projectDirectory(key: string) {
      if (key.startsWith("/")) return key
      return (
        ctx.data.project.get(key)?.canonical ??
        sessions().find((session) => session.project === key && session.detail === "main")?.directory ??
        (await ctx.client.project.list()).find((project) => project.id === key)?.canonical
      )
    }
    /**
     * Opens a project's new-session screen, as picking the project in Ctrl+O does: no session exists until the first
     * message, which the route and `session.created` handling then admit under that project. Not `showPanel`: on
     * the new-session screen that would cover the composer with the fullscreen switchboard. The home screen's
     * composer takes focus as it mounts, and the location effect below puts the cursor on the project's heading.
     */
    async function newSession(key: string) {
      try {
        const directory = await projectDirectory(key)
        if (stopped) return
        if (!directory) {
          setError(`No directory found for ${state().projects[key]?.name || key}`)
          return
        }
        // This home screen is a project choice: let the location effect reveal it, even after an earlier
        // navigation home that it never saw land.
        navigatedHome = false
        openHome(directory)
      } catch (cause) {
        report(cause)
      }
    }
    /**
     * The home route with a location. The plugin API's `Route` type has no `location` on home
     * (https://github.com/anomalyco/opencode/issues/62322), but the host passes the destination through to its
     * router and the home route applies `route.location`. Drop the cast once the type has it.
     */
    function openHome(directory: string) {
      ctx.ui.router.navigate({ type: "home", location: { directory } } as Parameters<
        typeof ctx.ui.router.navigate
      >[0])
    }
    /**
     * Opens one of our dialogs without leaving OpenCode a stale focus target. OpenCode 2.2.5 remembers what had
     * focus when a dialog opens and refocuses it on every later `dialog.clear()`, even with no dialog open. Its
     * Select terminal command (ctrl+x ↓) clears dialogs before focusing the composer, so focus snapped back to the
     * panel. Blur first so OpenCode remembers nothing, then restore focus once when the dialog closes.
     * Remove once OpenCode ships the fix for anomalyco/opencode#60881; tracked in #36.
     */
    function modal(open: (closed: () => void) => void) {
      const previous = ctx.renderer.currentFocusedRenderable
      previous?.blur()
      open(() =>
        setTimeout(() => {
          if (previous && !previous.isDestroyed) previous.focus()
        }, 0),
      )
    }
    const help = () =>
      modal((closed) =>
        ctx.ui.dialog.show(() => {
          const close = () => ctx.ui.dialog.clear()
          // As in OpenCode's own help dialog; the layer ends when the dialog closes.
          ctx.keymap.layer(() => ({
            mode: "modal",
            commands: [
              { title: "Close help", bind: "return", run: close },
              { title: "Close help", bind: "escape", run: close },
            ],
          }))
          return (
            <HelpDialog
              theme={ctx.theme.surface("dialog")}
              shortcuts={helpShortcuts((id) => ctx.keymap.shortcuts(id))}
              close={close}
            />
          )
        }, closed),
      )
    const diagnostics = () =>
      modal(
        (closed) =>
          void ctx.ui.dialog
            .alert({
              title: "Switchboard refresh details",
              message:
                errorDetails([error(), refreshError(), ...issues()]) ||
                "All location attention reads are current.",
            })
            .then(closed),
      )
    /**
     * As OpenCode's sidebar footer: the location this TUI shows (the viewed conversation's, else the home screen's),
     * with its branch. The host keeps the branch current.
     */
    function locationLabel() {
      const location = ctx.location
      if (!location) return undefined
      const value = ctx.ui.format.path(location.directory)
      const branch = ctx.data.location.vcs.info(location)?.branch.current
      return branch ? `${value}:${branch}` : value
    }
    function panel(
      focused: () => boolean,
      surface: () => "panel" | "fullscreen" = () => "fullscreen",
      /** The host's focus function for a side panel; a fullscreen switchboard always has focus. */
      focus?: () => void,
    ) {
      // Built once per theme or surface change: rows read the palette on every update.
      const colors = createMemo(() => palette(ctx.theme, surface()))
      return (
        <ErrorBoundary
          fallback={(cause, reset) => {
            logError("render", cause)
            return (
              <text fg={ctx.theme.text.feedback.error.base} onMouseDown={reset}>
                {`Switchboard error: ${errorText(cause)}\n(logged to ${ERROR_LOG}; click to retry)`}
              </text>
            )
          }}
        >
          <InboxPanel
            selectionMemory={selectionMemory}
            state={state()}
            sessions={live.shown()}
            error={error() || (reconnecting() ? "" : refreshError())}
            notice={reconnecting() ? RECONNECTING : ""}
            location={locationLabel()}
            loading={loading()}
            focused={focused()}
            current={viewing()}
            colors={colors()}
            act={(action) => void change(action)}
            open={(session) => {
              focusConversation = true
              // Already shown, e.g. from its subagent: no route change visits it, so visit it here.
              if (routeRoot() === session.id) {
                show(session.id)
                // When nothing remounts, return focus here; a remounting panel returns it itself (see the panel slot).
                void act({ type: "visit", sessionID: session.id, observed: session.idle }).then(() =>
                  setTimeout(returnFocus, 0),
                )
                showPanel()
              } else navigate(session.id) // The route effect visits it.
            }}
            newSession={(project) => void newSession(project)}
            close={close}
            help={() => void help()}
            diagnostics={() => void diagnostics()}
            keys={(actions) => {
              controls = actions
              onCleanup(() => {
                if (controls === actions) controls = undefined
              })
              ctx.keymap.layer(() => ({
                enabled: focused,
                commands: [
                  { bind: "down,j", run: actions.next },
                  { bind: "up,k", run: actions.previous },
                  { bind: "return", run: actions.enter },
                  { bind: "left", run: () => actions.fold(true) },
                  { bind: "right", run: () => actions.fold(false) },
                  { bind: "u", run: actions.unread },
                  { bind: "p", run: actions.park },
                  { bind: "x", run: actions.remove },
                  { bind: "n", run: actions.newSession },
                  { bind: "?,shift+?", run: help },
                  { bind: "escape", run: close },
                ],
              }))
            }}
            menuKeys={(menu) => {
              // The host enables a side panel's keymap layers and modes only while the panel has focus, so an
              // unfocused panel takes focus for the menu's lifetime (as OpenCode's diff viewer does for its file
              // menu); otherwise the composer would take the menu's keys. Focus returns where it was when the
              // menu closes. The cursor stays put: focusing reveals nothing.
              if (!focused() && focus) {
                focus()
                // An unfocused side panel means the conversation pane had focus; the host's command returns it there.
                onCleanup(() => ctx.keymap.dispatch("pane.focus.left"))
              }
              // As OpenCode's own right-click menus: the `menu` mode turns off the panel's and the host's base keys
              // until the menu closes.
              onCleanup(ctx.keymap.mode.push("menu"))
              ctx.keymap.layer(() => ({
                mode: "menu",
                commands: [
                  { bind: "escape,ctrl+c", run: menu.close },
                  { bind: "return", run: menu.run },
                  { bind: "down,j", run: () => menu.move(1) },
                  { bind: "up,k", run: () => menu.move(-1) },
                  // The keys each item shows also run it here.
                  ...menu.items().map((item) => ({ bind: item.hint, run: item.run })),
                ],
              }))
            }}
          />
        </ErrorBoundary>
      )
    }
    const stopRoute = ctx.ui.router.register({ name: "switchboard", render: () => panel(() => true) })
    const stopPanel = ctx.ui.slot({
      append: "session.panel",
      render: (input) => (
        <Show when={input.name === PANEL}>
          {(() => {
            focusPanel = input.focus
            onCleanup(() => {
              if (focusPanel === input.focus) focusPanel = undefined
            })
            onMount(() => {
              // The host focuses a newly mounted panel; return focus after it does.
              if (focusConversation) setTimeout(returnFocus, 0)
            })
            return panel(
              () => input.focused,
              () => input.presentation,
              input.focus,
            )
          })()}
        </Show>
      ),
    })
    /** Says that the conversation shown lost its row, and how to add it back with the open command's key. */
    function tellMissing() {
      const key = ctx.keymap.shortcuts(HELP_COMMANDS.open)[0]
      ctx.ui.toast.show({
        variant: "info",
        // No `sessionID`: for the conversation shown it adds nothing, and over the fullscreen switchboard it would
        // add an Open action that leaves the switchboard instead of adding the row back.
        message: key
          ? `Not in the switchboard. Press ${key} to add it back`
          : "Not in the switchboard. Open the switchboard to add it back",
      })
    }
    const stopApp = ctx.ui.slot({
      append: "app",
      render: () => {
        // When another TUI closes the row of the conversation shown here (or its project), say so once: the row had
        // been there while this TUI showed it, and now it is missing. A conversation that never had a row here, a new
        // route, and this TUI's own close never toast. A row that comes back and goes again toasts again.
        let had: string | null = null
        createEffect(() => {
          const id = viewing()
          if (id !== null && projectOf(state(), id)) had = id
          else if (id !== had) had = null
          else if (missing()) {
            had = null
            if (enabled) untrack(tellMissing)
          }
        })
        createEffect(
          on(
            () => {
              const route = ctx.ui.router.current()
              return route.type === "session" ? route.sessionID : null
            },
            (id) => {
              const quiet = id !== null && id === wentBack
              wentBack = undefined
              if (!enabled || !id) return
              // Going back after a close moves focus only if the closer asked for it (see `closeCurrent`).
              if (quiet) {
                void visit(id)
                return
              }
              // Opened elsewhere, e.g. the native session list: the panel remounts beside it and
              // the host focuses the panel, so hand focus to the conversation as a panel open does.
              focusConversation = true
              void visit(id).then(() => setTimeout(returnFocus, 0))
            },
            { defer: true },
          ),
        )
        createEffect(
          on(
            () => {
              const location =
                ctx.ui.router.current().type === "home" ? locationProject(ctx.location) : undefined
              return location ? `${location.project.id}\n${location.directory}` : null
            },
            (key) => {
              const location = locationProject(ctx.location)
              if (key && navigatedHome) {
                navigatedHome = false
                return
              }
              if (!enabled || !key || !location) return
              void openLocationProject(location)
            },
            { defer: true },
          ),
        )
        return null
      },
    })
    ctx.keymap.layer(() => ({
      mode: "global",
      priority: 10,
      commands: [
        {
          id: "opencode-switchboard.open",
          title: "Open switchboard",
          bind: "<leader>i",
          palette: true,
          slash: { name: "switchboard" },
          run: openInbox,
        },
        {
          id: "opencode-switchboard.close-current",
          title: "Close current switchboard session",
          bind: "<leader>w",
          palette: true,
          enabled: canCloseCurrent,
          run: closeCurrent,
        },
      ],
      bindings: ["opencode-switchboard.open", "opencode-switchboard.close-current"],
    }))
    const stopEvents = rpc.events.on("changed", (event) => {
      if (!enabled) return
      // The server announces every action, this TUI's own included, possibly before that action's reply arrives.
      // Once this TUI's actions have returned, a revision it already has needs no snapshot.
      void acting
        .then(() => {
          if (stopped || !enabled || event.data.revision <= state().revision) return
          return rpc.snapshot({}, options).then((next) => accept(next))
        })
        .catch((cause) => (isTransportError(cause) ? refreshFailed("changed", cause) : report(cause)))
    })
    const stopRenames = ctx.data.on("session.renamed", () => {
      if (enabled) void refresh()
    })
    const stopCreated = ctx.data.on("session.created", (event) => {
      const route = ctx.ui.router.current()
      if (enabled && route.type === "session" && route.sessionID === event.data.sessionID)
        void visit(route.sessionID)
    })
    const stopDeletes = ctx.data.on("session.deleted", (event) => {
      const id = event.data.sessionID
      // A deleted session's row goes for good, so it is never reported missing.
      leave(id, true)
      // Use the exact deleted ID: deleting a subagent must not close its root's row.
      const current = history.current === id
      if (!current && !Object.values(state().projects).some((project) => project.sessions.includes(id)))
        return
      void act({ type: "session-remove", sessionID: id }).then(() => {
        // Every TUI that showed the deleted session leaves it, as native tabs do; the host may already have gone
        // home. A TUI that has since moved to another session stays there.
        if (!current || !enabled || history.current !== id) return
        const here = routeRoot()
        if (here === null || here === id) goBack(id)
      })
    })
    function poll() {
      if (stopped) return
      if (enabled) void refresh()
      timer = setTimeout(poll, POLL)
    }
    poll()
    // Only the explicit workstation launcher opts into opening on activation/reload.
    const autoOpen = ctx.options.autoOpen === true ? setTimeout(() => void openInbox(), 0) : undefined
    return () => {
      stopped = true
      clearTimeout(timer)
      clearTimeout(autoOpen)
      stopEvents()
      stopRenames()
      stopCreated()
      stopDeletes()
      stopRoute()
      stopPanel()
      stopApp()
      live.dispose()
    }
  },
})
