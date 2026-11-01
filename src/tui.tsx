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
} from "solid-js"
import { Switchboard } from "./rpc"
import { initialState, laterKey, projectOf, type Action, type Session, type State } from "./model"
import { liveSession, loadCatalog } from "./catalog"
import type { Attention } from "./attention"
import { HelpDialog, helpShortcuts } from "./help"
import { InboxPanel, type PanelProps } from "./panel"
import { palette } from "./palette"
import { createSelectionMemory, followRoute, navigated } from "./selection"

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
    const [issues, setIssues] = createSignal<string[]>([])
    const attention = new Map<string, Attention>()
    // Keep an opaque mutable cursor across both panel remounts and plugin reloads.
    // Map entries are not wrapped in Solid's read-only store proxies.
    const [local] = ctx.storage.memory("panel-selection", {
      initial: { cursors: new Map([["inbox", createSelectionMemory()]]) },
    })
    const selectionMemory = local.cursors.get("inbox")!
    // Per-machine and durable, so the native-tabs hint shows once, not on every open.
    const [hints, setHints] = ctx.storage.store("hints", { initial: { nativeTabs: false } })
    const [loading, setLoading] = createSignal(false)
    let enabled = false
    let stopped = false
    let mirrored: string | null | undefined
    // Set when the inbox itself navigates home (e.g. after closing a project), so the
    // home screen it lands on does not count as choosing that project.
    let mirroredHome = false
    // Set once this activation has loaded shared state; see `navigated`.
    let synced = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let membership = ""
    let refreshAgain = false
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
      setError(cause instanceof Error ? cause.message : String(cause))
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
    /** The conversation this client shows: none on, or fullscreen over, the new-session screen. */
    function viewing() {
      const route = ctx.ui.router.current()
      if (route.type === "session") return ctx.data.session.root(route.sessionID)
      if (route.type === "home" || (route.type === "plugin" && fromHome())) return null
      return state().selected
    }
    function accept(next: State) {
      // Revisions only grow; an equal one is the state already shown (e.g. a duplicate snapshot).
      if (stopped || next.revision <= state().revision) return
      const changed = navigated(synced, state(), next)
      const admitted = Object.entries(next.projects)
        .filter(([, project]) => project.open)
        .map(([id, project]) => `${id}:${project.sessions.join(",")}`)
        .join("\n")
      const membershipChanged = admitted !== membership
      membership = admitted
      setState(next)
      if (enabled && membershipChanged) void refresh()
      if (!enabled || !changed) return
      const destination = followRoute(ctx.ui.router.current(), next.selected, (id) =>
        ctx.data.session.root(id),
      )
      // Navigating to the route already shown does not notify the route effect,
      // so only mark navigations that actually change it as mirrored.
      if (destination) {
        mirrored = next.selected
        mirroredHome = destination.type === "home"
        ctx.ui.router.navigate(destination)
      }
      showPanel()
    }
    async function act(action: Action) {
      try {
        accept(await rpc.act(action, options))
        setError("")
      } catch (cause) {
        report(cause)
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
        accept(await rpc.snapshot({}, options))
        synced = true
        const result = await loadCatalog(ctx.client, state(), attention)
        if (stopped) return
        // Identical catalogs must not re-render the panel; most refreshes change nothing.
        const catalog = JSON.stringify(result.sessions)
        if (catalog !== lastCatalog) {
          lastCatalog = catalog
          setSessions(result.sessions)
        }
        setRefreshError(result.warning)
        setIssues(result.issues)
      } catch (cause) {
        logError("refresh", cause)
        if (!stopped) setRefreshError(cause instanceof Error ? cause.message : String(cause))
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
      const id = route.type === "session" ? ctx.data.session.root(route.sessionID) : state().selected
      if (!id) return
      const project = projectOf(state(), id)
      if (!project) return
      // Unfold rather than toggle: a stale state() must never fold what it means to reveal.
      if (state().collapsed.includes(project)) await act({ type: "fold", key: project, folded: false })
      if (state().sessions[id]?.placement === "later" && state().collapsed.includes(laterKey(project)))
        await act({ type: "fold", key: laterKey(project), folded: false })
      reveal(`session:${id}`)
    }
    async function openInbox() {
      const alreadyOpen = enabled && ctx.ui.panel.current()?.name === PANEL
      if (!enabled) synced = false
      enabled = true
      focusConversation = false
      if (alreadyOpen) {
        // Move the cursor synchronously, before the refresh, so the next keypress acts on it.
        focusPanel?.()
        void revealCurrent()
      } else showPanel()
      suggestDisablingTabs()
      await refresh()
      // Startup (--session) and reopening must adopt the displayed route, not the last saved selection.
      const route = ctx.ui.router.current()
      if (route.type === "session") {
        const root = ctx.data.session.root(route.sessionID)
        if (state().selected !== root || !projectOf(state(), root)) await visit(route.sessionID)
      }
      await revealCurrent()
    }
    function canCloseCurrent() {
      const id = viewing()
      return Boolean(enabled && id && projectOf(state(), id))
    }
    async function closeCurrent() {
      if (!canCloseCurrent()) return
      const id = viewing()!
      const route = ctx.ui.router.current()
      // A route change may still be committing its visit when the shortcut is pressed.
      if (state().selected !== id && route.type === "session") await visit(route.sessionID)
      if (stopped || !enabled || viewing() !== id || state().selected !== id) return
      focusConversation = true
      await act({ type: "session-remove", sessionID: id })
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
    async function visit(id: string) {
      try {
        let root = ctx.data.session.root(id)
        let observed = sessions().find((session) => session.id === root)?.idle
        if (observed === undefined) {
          let info = await ctx.client.session.get({ sessionID: id })
          while (info.parentID) info = await ctx.client.session.get({ sessionID: info.parentID })
          root = info.id
          observed = info.time.idle ?? 0
          const route = ctx.ui.router.current()
          if (stopped || !enabled || route.type !== "session" || route.sessionID !== id) return
        }
        // A subagent of the current selection is the same work context: record nothing.
        if (root !== id && root === state().selected) return
        await act({ type: "select", sessionID: root, observed })
      } catch (cause) {
        // The host navigates optimistically, before its create request commits.
        // Retry on session.created instead of showing an error for that local draft.
        if (
          typeof cause === "object" &&
          cause !== null &&
          "_tag" in cause &&
          cause._tag === "SessionNotFoundError" &&
          ctx.data.session.get(id)
        )
          return
        report(cause)
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
                [error(), refreshError(), ...issues()].filter(Boolean).join("\n\n") ||
                "All location attention reads are current.",
            })
            .then(closed),
      )
    function panel(focused: () => boolean, surface: () => "panel" | "fullscreen" = () => "fullscreen") {
      // Built once per theme or surface change: rows read the palette on every update.
      const colors = createMemo(() => palette(ctx.theme, surface()))
      return (
        <ErrorBoundary
          fallback={(cause, reset) => {
            logError("render", cause)
            return (
              <text fg={ctx.theme.text.feedback.error.base} onMouseDown={reset}>
                {`Switchboard error: ${cause instanceof Error ? cause.message : String(cause)}\n(logged to ${ERROR_LOG}; click to retry)`}
              </text>
            )
          }}
        >
          <InboxPanel
            selectionMemory={selectionMemory}
            state={state()}
            sessions={live.shown()}
            error={error() || refreshError()}
            loading={loading()}
            focused={focused()}
            current={viewing()}
            colors={colors()}
            act={(action) => void act(action)}
            open={(session) => {
              focusConversation = true
              // A remounting panel returns focus itself (see the panel slot); when nothing
              // remounts, e.g. the session was already shown, return it here.
              void act({ type: "select", sessionID: session.id, observed: session.idle }).then(() =>
                setTimeout(returnFocus, 0),
              )
            }}
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
                  { bind: "a", run: () => actions.place("active") },
                  { bind: "l", run: () => actions.place("later") },
                  { bind: "x", run: actions.remove },
                  { bind: "?,shift+?", run: help },
                  { bind: "escape", run: close },
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
            )
          })()}
        </Show>
      ),
    })
    const stopApp = ctx.ui.slot({
      append: "app",
      render: () => {
        createEffect(
          on(
            () => {
              const route = ctx.ui.router.current()
              return route.type === "session" ? route.sessionID : null
            },
            (id) => {
              if (id === mirrored) {
                mirrored = undefined
                return
              }
              if (!enabled || !id) return
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
              if (key && mirroredHome) {
                mirroredHome = false
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
    const stopEvents = rpc.events.on("changed", () => {
      if (enabled) void rpc.snapshot({}, options).then(accept).catch(report)
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
      // Use the exact deleted ID: deleting a subagent must not close its root's row.
      if (
        state().selected === id ||
        Object.values(state().projects).some((project) => project.sessions.includes(id))
      )
        void act({ type: "session-remove", sessionID: id })
    })
    const poll = () => {
      if (stopped) return
      if (enabled) void refresh()
      timer = setTimeout(poll, 15_000)
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
