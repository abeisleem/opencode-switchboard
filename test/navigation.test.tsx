import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/tui"
import { RGBA, TextAttributes } from "@opentui/core"
import { MouseButtons } from "@opentui/core/testing"
import { testRender } from "@opentui/solid"
import { createSignal, getOwner, onCleanup, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { actionSchema, initialState, type Action, type State } from "../src/model"
import server from "../src/server"
import plugin from "../src/tui"
import { legacyCatalog } from "./legacy-catalog"

type Route = ReturnType<Plugin.Context["ui"]["router"]["current"]>
type Layer = ReturnType<Parameters<Plugin.Context["keymap"]["layer"]>[0]>

/** A focusable renderable and the renderer's record of which one has focus. */
type FakeFocus = { current: unknown; events: string[] }

function fakeFocus(): FakeFocus & { node: object } {
  const focus = { current: null as unknown, events: [] as string[], node: {} }
  focus.node = {
    isDestroyed: false,
    blur: () => {
      focus.events.push("blur")
      focus.current = null
    },
    focus: () => {
      focus.events.push("focus")
      focus.current = focus.node
    },
  }
  focus.current = focus.node
  return focus
}

type LiveSession = Pick<
  Plugin.Context["data"]["session"],
  "family" | "status" | "pending" | "permission" | "form" | "get"
>

async function harness(
  options: {
    route?: Route
    members?: string[]
    visitGate?: Promise<void>
    /** Holds every snapshot read until it settles. */
    snapshotGate?: Promise<void>
    live?: Partial<LiveSession>
    active?: () => Record<string, unknown>
    approvals?: () => string[]
    focus?: FakeFocus
    shortcuts?: (id: string) => readonly string[]
    /** Sessions that belong to a second open project, "other", instead of "work". */
    other?: string[]
    /** What the switchboard's RPC calls reject with, instead of reaching the server part. */
    fail?: unknown
    /** Render the side panel beside the session, with host focus, instead of the fullscreen route. */
    sidePanel?: boolean
    /** OpenCode's synced projects, as `ctx.data.project.get` returns them; none by default. */
    synced?: Record<string, { canonical: string }>
    /** The server's project list; by default "work" at /work and "other" at /other. */
    projects?: { id: string; name: string; canonical: string }[]
    /** The sessions belong to the global project, so their project is keyed by their directory, /work. */
    global?: boolean
    /** The server lists no sessions, so the catalog has no rows. */
    unlisted?: boolean
    /** The server part answers the catalog method, as 0.2.2 and later do; otherwise it lacks it. */
    catalog?: boolean
    /** The location this TUI shows (`ctx.location`); /work by default. */
    location?: () => { directory: string }
    /** The current git branch of a location, as the host's VCS info reports it. */
    branch?: (directory: string) => string | undefined
  } = {},
) {
  // What the switchboard's RPC calls reject with; a test can change it while the TUI runs.
  const failures: { snapshot?: unknown; act?: unknown } = { snapshot: options.fail, act: options.fail }
  let saved = initialState()
  saved.revision = 1
  saved.projects[options.global ? "/work" : "work"] = {
    name: "Work",
    open: true,
    sessions: options.members ?? ["a", "b"],
  }
  if (options.other) saved.projects.other = { name: "Other", open: true, sessions: options.other }
  let sessionCreates = 0
  const sessions = ["a", "b", "c"].map((id) => ({
    id,
    title: `Task ${id}`,
    projectID: options.other?.includes(id) ? "other" : options.global ? "global" : "work",
    location: { directory: "/work" },
    time: {},
  }))
  const get = async ({ sessionID }: { sessionID: string }) =>
    sessionID === "child"
      ? { ...sessions[1]!, id: "child", parentID: "b" }
      : sessions.find((item) => item.id === sessionID)!
  const noop = () => {}
  let activeReads = 0
  let sessionLists = 0
  let catalogCalls = 0
  let snapshots = 0
  // What OpenCode would remember as the focus target when each dialog opened; see `modal` in src/tui.tsx.
  const dialogs: { saved: unknown; close: () => void; render?: () => JSX.Element; message?: string }[] = []
  // This TUI's `changed` listener; the fake server calls it, as OpenCode does, before `act` replies.
  let changed: ((event: { data: { revision: number } }) => void) | undefined
  let rpc!: {
    snapshot: () => Promise<State>
    act: (action: Action) => Promise<State>
    catalog: (input: { sessions: string[]; roots?: string[] }) => Promise<unknown>
  }
  await server.setup({
    storage: {
      get: async () => saved,
      set: async (_key: string, value: State) => {
        saved = value
      },
    },
    session: {
      get,
      // The server part's in-process list, which the catalog method uses.
      list: async () => ({ data: options.unlisted ? [] : sessions }),
    },
    rpc: {
      register: async (_contract: unknown, handlers: typeof rpc) => {
        rpc = handlers
        return {
          events: {
            emit: async (_name: string, data: { revision: number }) => {
              changed?.({ data })
            },
          },
        }
      },
    },
  } as unknown as Parameters<typeof server.setup>[0])
  const [route, navigate] = createSignal<Route>(options.route ?? { type: "session", sessionID: "b" })
  // The side panel the host shows beside a session, by name. Only a session view has one.
  const [panel, setPanel] = createSignal<string>()
  const layers: (() => Layer)[] = []
  // OpenCode's input-mode stack, as `keymap.mode.push` leaves it.
  const modes: string[] = []
  const actions: Action[] = []
  const dispatched: string[] = []
  // Toasts the switchboard showed, in order.
  const toasts: { message: string; variant?: string; sessionID?: string }[] = []
  let render!: () => JSX.Element
  let renderApp!: () => JSX.Element
  let renderPanel: ((input: object) => JSX.Element) | undefined
  // Whether the host's side panel has focus: its `focus` gives it focus; focusing anything else takes it away.
  const [panelFocused, setPanelFocused] = createSignal(false)
  const panelNode = {
    isDestroyed: false,
    focus: () => panelInput.focus(),
    blur: () => setPanelFocused(false),
  }
  if (options.focus) {
    const focusNode = (options.focus as FakeFocus & { node: { focus: () => void } }).node
    const original = focusNode.focus
    focusNode.focus = () => {
      original()
      setPanelFocused(false)
    }
  }
  const panelInput = {
    get name() {
      return panel()
    },
    get focused() {
      return panelFocused()
    },
    presentation: "panel" as const,
    focus: () => {
      options.focus?.events.push("panel")
      if (options.focus) options.focus.current = panelNode
      setPanelFocused(true)
    },
  }
  let cleanup!: ReturnType<typeof plugin.setup>
  const color = RGBA.fromHex("#c0caf5")
  const context = {
    options: {},
    get location() {
      return options.location?.() ?? { directory: "/work" }
    },
    client: {
      rpc: () => ({
        snapshot: async () => {
          snapshots++
          await options.snapshotGate
          return failures.snapshot === undefined ? rpc.snapshot() : Promise.reject(failures.snapshot)
        },
        act: async (action: Action) => {
          actions.push(action)
          if (failures.act !== undefined) throw failures.act
          if (action.type === "visit") await options.visitGate
          return rpc.act(action)
        },
        // An older server part by default: the catalog reads sessions itself, as these tests expect.
        catalog: async (input: Parameters<typeof rpc.catalog>[0]) => {
          catalogCalls++
          return options.catalog ? rpc.catalog(input) : legacyCatalog()
        },
        events: {
          on: (_type: string, listener: typeof changed) => {
            changed = listener
            return noop
          },
        },
      }),
      project: {
        list: async () =>
          options.projects ?? [
            { id: "work", name: "Work", canonical: "/work" },
            { id: "other", name: "Other", canonical: "/other" },
          ],
      },
      session: {
        get,
        // The switchboard never creates a session up front; see `newSession` in src/tui.tsx.
        create: async () => {
          sessionCreates++
          throw new Error("unexpected session.create")
        },
        active: async () => {
          activeReads++
          return options.active?.() ?? {}
        },
        list: async () => {
          sessionLists++
          return { data: options.unlisted ? [] : sessions, cursor: {} }
        },
      },
      permission: {
        request: {
          list: async () => ({ data: (options.approvals?.() ?? []).map((sessionID) => ({ sessionID })) }),
        },
      },
      form: { list: async () => ({ data: [] }) },
    },
    data: {
      location: {
        vcs: {
          info: (location: { directory: string }) => {
            const current = options.branch?.(location.directory)
            return current ? { branch: { current } } : undefined
          },
        },
      },
      on: () => noop,
      session: {
        root: (id: string) => (id === "child" ? "b" : id),
        get: () => undefined,
        family: () => [],
        status: () => "idle",
        pending: { list: () => [] },
        permission: { list: () => undefined },
        form: { list: () => undefined },
        ...options.live,
      },
      project: { get: (id: string) => options.synced?.[id] },
    },
    storage: {
      memory: (_key: string, input: { initial: unknown }) => [input.initial, noop],
      store: (_key: string, input: { initial: unknown }) => [input.initial, noop],
    },
    theme: {
      text: { base: color, muted: color, feedback: { error: { base: color } } },
      background: {
        base: color,
        raised: { base: color, high: color },
        action: { primary: { hovered: color } },
      },
      hue: { accent: { 200: color }, interactive: { 200: color } },
      // The dialog surface: the help dialog's tokens, and the side panel's palette.
      surface: () => ({
        text: {
          base: color,
          muted: color,
          action: { primary: { focused: color } },
          feedback: { error: { base: color } },
        },
        background: {
          base: color,
          raised: { base: color, high: color },
          action: { primary: { focused: color, hovered: color } },
        },
        hue: { accent: { 200: color }, interactive: { 200: color } },
      }),
    },
    ui: {
      // As the host: the home directory shortened to `~`.
      format: { path: (value: string) => value.replace(/^\/home\/me(?=\/|$)/, "~") },
      router: {
        current: route,
        navigate,
        register: (page: { render: () => JSX.Element }) => {
          render = page.render
          return noop
        },
      },
      slot: (slot: { append: string; render: (input: object) => JSX.Element }) => {
        if (slot.append === "app") renderApp = () => slot.render({})
        if (slot.append === "session.panel") renderPanel = slot.render
        return noop
      },
      panel: {
        open: (name: string) => {
          if (route().type !== "session") return false
          setPanel(name)
          return true
        },
        // Reported as closed, as before this field was modeled, so opening the switchboard always remounts it.
        current: () => undefined,
        close: () => setPanel(undefined),
      },
      tabs: { enabled: () => false },
      toast: { show: (toast: { message: string }) => toasts.push(toast) },
      dialog: {
        show: (render: () => JSX.Element, onClose?: () => void) =>
          dialogs.push({ saved: options.focus?.current ?? null, close: onClose ?? noop, render }),
        alert: (input: { message: string }) =>
          new Promise<void>((resolve) =>
            dialogs.push({ saved: options.focus?.current ?? null, close: resolve, message: input.message }),
          ),
        clear: noop,
      },
    },
    keymap: {
      dispatch: (command: string) => {
        dispatched.push(command)
        // As the host's `pane.focus.left`: the conversation pane, here the fake composer, takes focus.
        if (options.sidePanel && command === "pane.focus.left")
          (options.focus as (FakeFocus & { node: { focus: () => void } }) | undefined)?.node.focus()
      },
      shortcuts: options.shortcuts ?? (() => []),
      // As in OpenCode, a layer ends with the component or reactive owner that registered it.
      layer: (factory: () => Layer) => {
        layers.push(factory)
        if (getOwner()) onCleanup(() => void layers.splice(layers.indexOf(factory), 1))
      },
      mode: {
        push: (mode: string) => {
          modes.push(mode)
          return () => void modes.splice(modes.lastIndexOf(mode), 1)
        },
      },
    },
    renderer: {
      get currentFocusedRenderable() {
        return options.focus?.current ?? null
      },
    },
  } as unknown as Plugin.Context
  const app = await testRender(
    () => {
      cleanup = plugin.setup(context)
      renderApp()
      return options.sidePanel ? renderPanel!(panelInput) : render()
    },
    { width: 60, height: 20 },
  )
  const commands = () => layers.flatMap((factory) => factory().commands ?? [])
  const command = (id: string) => commands().find((item) => item.id === id)!
  return {
    app,
    route,
    navigate,
    /** The side panel the host shows, if any. */
    panel,
    panelFocused,
    /** Focuses the side panel, as a click on it or the host's pane keys do. */
    focusPanel: () => panelInput.focus(),
    /**
     * Opens a session the way OpenCode's Ctrl+O menu or session list does: the new session view replaces the
     * old one and its side panel, showing the native sidebar until a plugin opens its panel again.
     */
    hostOpen(sessionID: string) {
      setPanel(undefined)
      navigate({ type: "session", sessionID })
    },
    /** Closes the side panel without leaving the session, as the host can. */
    hostClosePanel() {
      setPanel(undefined)
    },
    actions,
    modes,
    /** The commands of the newest layer registered for an input mode. */
    modeCommands: (mode: string) =>
      layers
        .map((factory) => factory())
        .filter((layer) => layer.mode === mode)
        .at(-1)?.commands ?? [],
    dispatched,
    /** The messages of the toasts the switchboard showed, in order. */
    toasts: () => toasts.map((toast) => toast.message),
    toastOptions: toasts,
    rpc,
    failures,
    saved: () => saved,
    sessions,
    /** Catalog loads: each reads the active sessions once. */
    activeReads: () => activeReads,
    sessionLists: () => sessionLists,
    catalogCalls: () => catalogCalls,
    /** `snapshot` RPCs this TUI sent. */
    snapshots: () => snapshots,
    /** `session.create` calls this TUI made. */
    sessionCreates: () => sessionCreates,
    dialogs,
    open: () => command("opencode-switchboard.open").run(),
    close: () => command("opencode-switchboard.close-current"),
    binds: () => commands().flatMap((item) => (typeof item.bind === "string" ? [item.bind] : [])),
    key: (bind: string) =>
      commands()
        .find((item) => item.bind === bind)!
        .run(),
    async frame() {
      await app.renderOnce()
      await app.renderOnce()
    },
    bold(title: string) {
      return app
        .captureSpans()
        .lines.some((line) =>
          line.spans.some(
            (span) => span.text.includes(title) && Boolean(span.attributes & TextAttributes.BOLD),
          ),
        )
    },
    async dispose() {
      const stop = await cleanup
      await stop?.()
      await app.dispose()
    },
  }
}

test("startup shows --session as this TUI's current session", async () => {
  const run = await harness()
  try {
    await run.open()
    await run.frame()
    expect(run.route()).toEqual({ type: "session", sessionID: "b" })
    expect(run.actions).toContainEqual({ type: "visit", sessionID: "b", observed: 0 })
    expect(run.bold("Task b")).toBe(true)
    expect(run.bold("Task a")).toBe(false)
    await run.key("u")
    expect(run.actions.at(-1)).toEqual({ type: "unread", sessionID: "b" })
  } finally {
    await run.dispose()
  }
})

test("the current marker follows the displayed route while its visit is pending", async () => {
  const gate = Promise.withResolvers<void>()
  const run = await harness({ visitGate: gate.promise })
  const opening = run.open()
  try {
    await run.frame()
    expect(run.saved().sessions.b).toBeUndefined()
    expect(run.bold("Task b")).toBe(true)
    expect(run.bold("Task a")).toBe(false)
  } finally {
    gate.resolve()
    await opening
    await run.dispose()
  }
})

test("startup admits an unlisted session and preserves a displayed subagent route", async () => {
  const run = await harness({ route: { type: "session", sessionID: "child" }, members: ["a"] })
  try {
    await run.open()
    await run.frame()
    expect(run.route()).toEqual({ type: "session", sessionID: "child" })
    expect(run.saved().projects.work?.sessions).toEqual(["b", "a"])
    expect(run.bold("Task b")).toBe(true)
  } finally {
    await run.dispose()
  }
})

test("another client's visit changes shared data but never this TUI's route or current marker", async () => {
  const run = await harness()
  try {
    await run.open()
    await run.frame()
    const actions = run.actions.length
    // Another TUI opens c: it is admitted and read for everyone, but this TUI keeps showing b.
    await run.rpc.act({ type: "visit", sessionID: "c", observed: 0 })
    expect(await until(() => run.app.captureCharFrame().includes("Task c"))).toBe(true)
    await run.frame()
    expect(run.saved().projects.work?.sessions).toEqual(["c", "a", "b"])
    expect(run.route()).toEqual({ type: "session", sessionID: "b" })
    expect(run.bold("Task b")).toBe(true)
    expect(run.bold("Task c")).toBe(false)
    // This TUI sent nothing in response.
    expect(run.actions.slice(actions)).toEqual([])
    // Its <leader>w still closes the conversation it shows.
    await run.close().run()
    expect(run.actions.filter((action) => action.type === "session-remove")).toEqual([
      { type: "session-remove", sessionID: "b" },
    ])
  } finally {
    await run.dispose()
  }
})

test("an older TUI's select still visits, without moving this TUI", async () => {
  const run = await harness()
  try {
    await run.open()
    await run.frame()
    // OpenCode parses RPC input before the handler runs, so the server receives the parsed visit.
    await run.rpc.act(actionSchema.parse({ type: "select", sessionID: "c", observed: 0 }))
    expect(await until(() => run.app.captureCharFrame().includes("Task c"))).toBe(true)
    expect(run.saved().sessions.c).toEqual({ placement: "active", unread: false, seen: 0 })
    expect(run.route()).toEqual({ type: "session", sessionID: "b" })
  } finally {
    await run.dispose()
  }
})

test("another client closing this TUI's current session removes its row but keeps the conversation open", async () => {
  const run = await harness()
  try {
    await run.open()
    await run.frame()
    await run.rpc.act({ type: "session-remove", sessionID: "b" })
    expect(await until(() => !run.app.captureCharFrame().includes("Task b"))).toBe(true)
    expect(run.route()).toEqual({ type: "session", sessionID: "b" })
    // With no row left for it, <leader>w has nothing to close.
    const enabled = run.close().enabled
    expect(typeof enabled === "function" && enabled()).toBe(false)
    // Closing its project elsewhere does not move this TUI either.
    await run.rpc.act({ type: "project-close", project: "work" })
    expect(await until(() => !run.app.captureCharFrame().includes("Task a"))).toBe(true)
    expect(run.route()).toEqual({ type: "session", sessionID: "b" })
  } finally {
    await run.dispose()
  }
})

test("reopening adopts this client's route after another client visited elsewhere", async () => {
  const run = await harness()
  try {
    await run.open()
    await run.key("escape")
    await run.rpc.act({ type: "visit", sessionID: "c", observed: 0 })
    run.navigate({ type: "session", sessionID: "a" })
    await run.open()
    await run.frame()
    expect(run.route()).toEqual({ type: "session", sessionID: "a" })
    expect(run.actions.at(-1)).toEqual({ type: "visit", sessionID: "a", observed: 0 })
    expect(run.bold("Task a")).toBe(true)
  } finally {
    await run.dispose()
  }
})

test("leader-w closes the viewed session rather than the panel cursor and keeps the session intact", async () => {
  const run = await harness()
  try {
    await run.open()
    await run.frame()
    await run.key("up,k") // Cursor on a; conversation remains b.
    const close = run.close()
    expect(close?.bind).toBe("<leader>w")
    expect(typeof close.enabled === "function" && close.enabled()).toBe(true)
    await close.run()
    await run.frame()
    expect(run.saved().projects.work?.sessions).toEqual(["a"])
    expect(run.route()).toEqual({ type: "session", sessionID: "a" })
    expect(run.bold("Task a")).toBe(true)
    expect(run.sessions.map((item) => item.id)).toEqual(["a", "b", "c"])
    expect(run.actions.filter((action) => action.type === "session-remove")).toEqual([
      { type: "session-remove", sessionID: "b" },
    ])
  } finally {
    await run.dispose()
  }
})

/** The command that hands keyboard focus from the panel to the conversation; see `returnFocus` in src/tui.tsx. */
const FOCUS_CONVERSATION = "pane.focus.left"

test("x on the current session's row goes back but keeps focus in the panel", async () => {
  const run = await harness()
  try {
    await run.open()
    await run.frame()
    run.dispatched.length = 0
    run.actions.length = 0
    await run.key("x") // The cursor starts on the current session, b.
    expect(await until(() => JSON.stringify(run.route()) === '{"type":"session","sessionID":"a"}')).toBe(true)
    await Bun.sleep(10) // Let any deferred focus hand-off run.
    expect(run.dispatched).not.toContain(FOCUS_CONVERSATION)
    // The fallback is still visited: recorded as current and marked read.
    expect(run.actions).toContainEqual({ type: "visit", sessionID: "a", observed: 0 })
    await run.frame()
    expect(run.bold("Task a")).toBe(true)
    // Focus stayed in the panel, so x closes the next row too.
    await run.key("x")
    expect(await until(() => run.saved().projects.work?.sessions.length === 0)).toBe(true)
  } finally {
    await run.dispose()
  }
})

test("closing the project holding the current session goes back but keeps focus in the panel", async () => {
  const run = await harness({ other: ["c"] })
  try {
    await run.open()
    await run.frame()
    run.dispatched.length = 0
    run.actions.length = 0
    await run.key("up,k")
    await run.key("up,k") // Cursor on the Work heading; the conversation remains b.
    await run.key("x")
    expect(await until(() => JSON.stringify(run.route()) === '{"type":"session","sessionID":"c"}')).toBe(true)
    await Bun.sleep(10)
    expect(run.saved().projects.work?.open).toBe(false)
    expect(run.dispatched).not.toContain(FOCUS_CONVERSATION)
    expect(run.actions).toContainEqual({ type: "visit", sessionID: "c", observed: 0 })
  } finally {
    await run.dispose()
  }
})

test("leader-w goes back and hands focus to the conversation", async () => {
  const run = await harness()
  try {
    await run.open()
    await run.frame()
    run.dispatched.length = 0
    await run.close().run()
    expect(JSON.stringify(run.route())).toBe('{"type":"session","sessionID":"a"}')
    expect(await until(() => run.dispatched.includes(FOCUS_CONVERSATION))).toBe(true)
    expect(run.dispatched.filter((command) => command === FOCUS_CONVERSATION)).toHaveLength(1)
  } finally {
    await run.dispose()
  }
})

test("opening a session from the panel hands focus to its conversation", async () => {
  const run = await harness()
  try {
    await run.open()
    await run.frame()
    run.dispatched.length = 0
    await run.key("up,k")
    await run.key("return")
    expect(JSON.stringify(run.route())).toBe('{"type":"session","sessionID":"a"}')
    expect(await until(() => run.dispatched.includes(FOCUS_CONVERSATION))).toBe(true)
  } finally {
    await run.dispose()
  }
})

test("a session OpenCode opens itself ends with the switchboard panel shown again", async () => {
  const run = await harness({ members: ["a", "b", "c"] })
  try {
    await run.open()
    await run.frame()
    expect(run.panel()).toBe("switchboard")
    run.hostOpen("c")
    // Shown again in the same tick as the route change, so the host mounts it with the new session view.
    expect(run.panel()).toBe("switchboard")
    expect(await until(() => run.actions.at(-1)?.type === "visit")).toBe(true)
    expect(run.actions.at(-1)).toEqual({ type: "visit", sessionID: "c", observed: 0 })
    // Going back after closing the current row keeps the panel too, without handing focus over.
    await run.open() // Moves the cursor to the current session, c.
    run.dispatched.length = 0
    await run.key("x")
    expect(await until(() => JSON.stringify(run.route()) === '{"type":"session","sessionID":"b"}')).toBe(true)
    await Bun.sleep(10)
    expect(run.panel()).toBe("switchboard")
    expect(run.dispatched).not.toContain(FOCUS_CONVERSATION)
  } finally {
    await run.dispose()
  }
})

test("a session OpenCode opens shows the panel and hands focus to it before its visit lands", async () => {
  const visit = Promise.withResolvers<void>()
  const focus = fakeFocus()
  const options: Parameters<typeof harness>[0] = { members: ["a", "b", "c"], focus, sidePanel: true }
  const run = await harness(options)
  try {
    await run.open()
    await run.frame()
    options.visitGate = visit.promise
    run.dispatched.length = 0
    run.hostOpen("c")
    expect(run.panel()).toBe("switchboard")
    expect(await until(() => run.actions.at(-1)?.type === "visit")).toBe(true)
    // The conversation gets focus while the visit is still on its way.
    expect(await until(() => run.dispatched.includes(FOCUS_CONVERSATION))).toBe(true)
    expect(run.saved().sessions.c).toBeUndefined()
    // Closed by the host while the visit is on its way, the panel is shown again once it lands, without a second
    // focus handoff.
    run.hostClosePanel()
    visit.resolve()
    expect(await until(() => run.panel() === "switchboard")).toBe(true)
    expect(run.saved().sessions.c).toBeDefined()
    await Bun.sleep(10)
    expect(run.dispatched.filter((command) => command === FOCUS_CONVERSATION)).toHaveLength(1)
  } finally {
    visit.resolve()
    await run.dispose()
  }
})

test("another client's change never opens the panel here", async () => {
  const run = await harness({ members: ["a", "b", "c"] })
  try {
    await run.open()
    await run.frame()
    run.hostOpen("c")
    expect(await until(() => run.saved().sessions.c !== undefined)).toBe(true)
    await Bun.sleep(10)
    expect(run.panel()).toBe("switchboard")
    // The host closes the side panel while the switchboard stays enabled; another TUI then changes shared state.
    run.hostClosePanel()
    await run.rpc.act({ type: "visit", sessionID: "a", observed: 0 })
    await run.rpc.act({ type: "session-remove", sessionID: "b" })
    await run.rpc.act({ type: "place", sessionID: "c", placement: "parked" })
    await Bun.sleep(20)
    expect(run.saved().projects.work?.sessions).toEqual(["a", "c"])
    expect(run.panel()).toBeUndefined()
    expect(run.route()).toEqual({ type: "session", sessionID: "c" })
  } finally {
    await run.dispose()
  }
})

test("closing the current session goes back through this TUI's own recent sessions", async () => {
  const run = await harness({ members: ["a", "b", "c"] })
  try {
    await run.open()
    // This TUI shows c, then b. Another client visiting a leaves this TUI's history alone.
    run.navigate({ type: "session", sessionID: "c" })
    await run.frame()
    run.navigate({ type: "session", sessionID: "b" })
    await run.frame()
    await run.rpc.act({ type: "visit", sessionID: "a", observed: 0 })
    await run.close().run()
    await run.frame()
    expect(run.route()).toEqual({ type: "session", sessionID: "c" })
    expect(run.bold("Task c")).toBe(true)
    // x on the current row goes back the same way: c's most recent survivor is gone, so the first open, a.
    await run.key("x")
    expect(await until(() => JSON.stringify(run.route()) === '{"type":"session","sessionID":"a"}')).toBe(true)
    expect(run.saved().projects.work?.sessions).toEqual(["a"])
  } finally {
    await run.dispose()
  }
})

test("x on a row this TUI is not showing never navigates it", async () => {
  const run = await harness()
  try {
    await run.open()
    await run.frame()
    await run.key("up,k") // Cursor on a; conversation remains b.
    await run.key("x")
    expect(await until(() => run.saved().projects.work?.sessions.join() === "b")).toBe(true)
    await run.frame()
    expect(run.route()).toEqual({ type: "session", sessionID: "b" })
  } finally {
    await run.dispose()
  }
})

test("closing the project holding the current session goes home", async () => {
  const run = await harness()
  try {
    await run.open()
    await run.frame()
    await run.key("up,k")
    await run.key("up,k") // Cursor on the project heading.
    await run.key("x")
    expect(await until(() => run.route().type === "plugin")).toBe(true)
    expect(run.saved().projects.work?.open).toBe(false)
  } finally {
    await run.dispose()
  }
})

test("closing the last viewed root from a subagent returns home and disables close", async () => {
  const run = await harness({ route: { type: "session", sessionID: "child" }, members: ["b"] })
  try {
    await run.open()
    expect(run.close()).toBeDefined()
    await run.close().run()
    await run.frame()
    expect(run.saved().projects.work?.sessions).toEqual([])
    expect(run.route().type).toBe("plugin")
    const enabled = run.close().enabled
    expect(typeof enabled === "function" && enabled()).toBe(false)
  } finally {
    await run.dispose()
  }
})

test("startup at home does not select saved work and inactive Switchboard leaves the shortcut disabled", async () => {
  const run = await harness({ route: { type: "home" } })
  try {
    expect(run.close()).toBeDefined()
    const enabled = () => {
      const value = run.close().enabled
      return typeof value === "function" && value()
    }
    expect(enabled()).toBe(false)
    await run.open()
    await run.frame()
    expect(run.actions.some((action) => action.type === "visit")).toBe(false)
    expect(run.bold("Task a")).toBe(false)
    expect(enabled()).toBe(false)
    run.navigate({ type: "session", sessionID: "b" })
    await run.frame()
    expect(enabled()).toBe(true)
    await run.key("escape")
    expect(enabled()).toBe(false)
  } finally {
    await run.dispose()
  }
})

/** OpenCode's live session store, as `ctx.data.session` exposes it, with setters for the test. */
function liveStore(family: Record<string, string[]>) {
  const [live, setLive] = createStore({
    family,
    active: {} as Record<string, "idle" | "running">,
    pending: {} as Record<string, { type: string }[]>,
    permission: {} as Record<string, { id: string }[]>,
    form: {} as Record<string, { id: string }[]>,
    info: {} as Record<string, { outcome?: string; time: { idle?: number; viewed?: number } }>,
  })
  const session = {
    family: (id: string) => live.family[id] ?? [],
    status: (id: string) => live.active[id] ?? "idle",
    pending: { list: (id: string) => live.pending[id] ?? [] },
    permission: { list: (id: string) => live.permission[id] },
    form: { list: (id: string) => live.form[id] },
    get: (id: string) => live.info[id],
  } as unknown as LiveSession
  return { session, setLive }
}

const spinning = (screen: string, title: string) => new RegExp(`[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] ${title}`).test(screen)
/** The row's left indicator: "!", "?", "×", "•", or "" for none. */
const mark = (screen: string, title: string) => screen.match(new RegExp(`(\\S?) ${title}`))?.[1] ?? ""

async function until(condition: () => boolean) {
  // Capturing a frame while the renderer is still writing one fails with OutputBusy; that frame is not ready.
  const ready = () => {
    try {
      return condition()
    } catch (cause) {
      if (cause instanceof Error && cause.message.includes("OutputBusy")) return false
      throw cause
    }
  }
  let done = ready()
  for (let i = 0; i < 100 && !done; i++) {
    await Bun.sleep(5)
    done = ready()
  }
  return done
}

test("native running status starts and stops row spinners without waiting for the catalog poll", async () => {
  const { session, setLive } = liveStore({ a: ["a"], b: ["b", "child"] })
  const run = await harness({ live: session })
  try {
    await run.open()
    await run.frame()
    const screen = () => run.app.captureCharFrame()
    expect(screen()).toContain("Task a")
    expect(spinning(screen(), "Task a")).toBe(false)
    const reads = run.activeReads()

    setLive("active", "a", "running")
    await run.frame()
    expect(spinning(screen(), "Task a")).toBe(true)
    expect(run.activeReads()).toBe(reads)

    // A running subagent spins its root's row, as in the native tabs.
    setLive("active", "child", "running")
    await run.frame()
    expect(spinning(screen(), "Task b")).toBe(true)
    setLive("active", "child", "idle")
    // A sent prompt spins before execution starts; synthetic context does not.
    setLive("pending", "b", [{ type: "synthetic" }])
    await run.frame()
    expect(spinning(screen(), "Task b")).toBe(false)
    setLive("pending", "b", [{ type: "synthetic" }, { type: "user" }])
    await run.frame()
    expect(spinning(screen(), "Task b")).toBe(true)

    // Stopping clears the spinner at once, then refreshes the catalog's unread and error marks.
    setLive("active", "a", "idle")
    await run.frame()
    expect(spinning(screen(), "Task a")).toBe(false)
    expect(await until(() => run.activeReads() > reads)).toBe(true)
  } finally {
    await run.dispose()
  }
})

test("the catalog's running state applies only to families OpenCode has not loaded", async () => {
  const { session, setLive } = liveStore({})
  const run = await harness({ live: session, active: () => ({ a: {} }) })
  try {
    await run.open()
    await run.frame()
    const screen = () => run.app.captureCharFrame()
    expect(await until(() => spinning(screen(), "Task a"))).toBe(true)
    // Once OpenCode tracks the family, its live idle status wins over the polled catalog.
    setLive("family", "a", ["a"])
    await run.frame()
    expect(spinning(screen(), "Task a")).toBe(false)
  } finally {
    await run.dispose()
  }
})

test("approval and question marks follow OpenCode's live requests", async () => {
  const { session, setLive } = liveStore({ a: ["a"], b: ["b", "child"] })
  const run = await harness({ live: session })
  try {
    await run.open()
    await run.frame()
    const screen = () => run.app.captureCharFrame()
    expect(screen()).toContain("Task a")
    const reads = run.activeReads()

    // A subagent's request marks its root, over the running spinner, without a catalog read.
    setLive("active", "child", "running")
    setLive("permission", "child", [{ id: "approval" }])
    await run.frame()
    expect(mark(screen(), "Task b")).toBe("!")
    setLive("form", "a", [{ id: "question" }])
    await run.frame()
    expect(mark(screen(), "Task a")).toBe("?")
    expect(run.activeReads()).toBe(reads)

    // Answering clears the mark at once and refreshes the catalog for sessions OpenCode has not loaded.
    setLive("permission", "child", [])
    await run.frame()
    expect(spinning(screen(), "Task b")).toBe(true)
    setLive("form", "a", [])
    await run.frame()
    expect(mark(screen(), "Task a")).toBe("")
    expect(await until(() => run.activeReads() > reads)).toBe(true)
  } finally {
    await run.dispose()
  }
})

test("error and unread marks follow OpenCode's live session outcome and times", async () => {
  const { session, setLive } = liveStore({ a: ["a"], b: ["b"] })
  const run = await harness({ live: session })
  try {
    await run.open()
    await run.frame()
    const screen = () => run.app.captureCharFrame()
    expect(mark(screen(), "Task a")).toBe("")
    // OpenCode reloads a session's info when its run ends, then when a client views it.
    setLive("info", "a", { outcome: "succeeded", time: { idle: 50, viewed: 0 } })
    await run.frame()
    expect(mark(screen(), "Task a")).toBe("•")
    setLive("info", "a", { outcome: "succeeded", time: { idle: 50, viewed: 60 } })
    await run.frame()
    expect(mark(screen(), "Task a")).toBe("")
    setLive("info", "a", { outcome: "failed", time: { idle: 70, viewed: 80 } })
    await run.frame()
    expect(mark(screen(), "Task a")).toBe("×")
  } finally {
    await run.dispose()
  }
})

test("catalog requests apply only until OpenCode loads the request lists", async () => {
  const { session, setLive } = liveStore({ a: ["a"] })
  const run = await harness({ live: session, approvals: () => ["a"] })
  try {
    await run.open()
    await run.frame()
    const screen = () => run.app.captureCharFrame()
    expect(await until(() => mark(screen(), "Task a") === "!")).toBe(true)
    setLive("permission", "a", [])
    await run.frame()
    expect(mark(screen(), "Task a")).toBe("")
  } finally {
    await run.dispose()
  }
})

test("the panel binds no manual refresh or details keys", async () => {
  const run = await harness()
  try {
    await run.open()
    await run.frame()
    // Polling and events keep the catalog current; the error line opens the details.
    const binds = run.binds().flatMap((bind) => bind.split(","))
    expect(binds).toContain("x")
    expect(binds).not.toContain("r")
    expect(binds).not.toContain("d")
  } finally {
    await run.dispose()
  }
})

test("the panel folds headings with ← and →", async () => {
  const run = await harness()
  try {
    await run.open()
    await run.frame()
    const binds = run.binds().flatMap((bind) => bind.split(","))
    expect(binds).toContain("left")
    expect(binds).toContain("right")
  } finally {
    await run.dispose()
  }
})

test("revealing the viewed session unfolds its project without toggling", async () => {
  const run = await harness({ route: { type: "session", sessionID: "a" } })
  try {
    await run.open()
    await run.frame()
    // Another client folds the project. Reopening sends no visit for the session this TUI already shows,
    // whose admission would unfold the project itself.
    await run.rpc.act({ type: "fold", key: "work", folded: true })
    run.actions.length = 0
    await run.open()
    await run.frame()
    expect(run.actions).toEqual([{ type: "fold", key: "work", folded: false }])
    expect(run.actions.some((action) => action.type === "collapse")).toBe(false)
    expect(run.saved().collapsed).toEqual([])
  } finally {
    await run.dispose()
  }
})

test("help shows the keymap's shortcuts exactly, and no ctrl+x for unbound commands", async () => {
  for (const [bound, expected] of [
    [
      {
        "opencode-switchboard.open": ["ctrl+a i"],
        "pane.focus.left": ["ctrl+a ←"],
        "pane.focus.right": ["ctrl+a →"],
        "opencode-switchboard.close-current": ["ctrl+a w"],
      },
      [
        "Open with ctrl+a i or /switchboard",
        "Switch panes with ctrl+a ← and ctrl+a →",
        "Close the current session with ctrl+a w",
      ],
    ],
    // The user unbound everything in cli.json.
    [{}, ["Open with /switchboard"]],
  ] as const) {
    const run = await harness({ shortcuts: (id) => (bound as Record<string, readonly string[]>)[id] ?? [] })
    try {
      await run.open()
      await run.frame()
      await run.key("?,shift+?")
      const dialog = await testRender(run.dialogs.at(-1)!.render!, { width: 60, height: 20 })
      try {
        await dialog.renderOnce()
        const screen = dialog.captureCharFrame()
        const lines = screen.split("\n").map((line) => line.trim())
        const start = lines.findIndex((line) => line.startsWith("Open with"))
        expect(lines.slice(start, start + expected.length)).toEqual([...expected])
        expect(lines[start + expected.length]).toBe("")
        expect(screen).not.toContain("ctrl+x")
      } finally {
        await dialog.dispose()
      }
    } finally {
      await run.dispose()
    }
  }
})

test("our dialogs leave OpenCode no focus to restore, then refocus the panel once on close", async () => {
  const focus = fakeFocus()
  // A failed refresh puts an error line in the footer; the footer's resting location opens nothing.
  const run = await harness({ focus, fail: { type: "rpc.internal", message: "RPC call failed" } })
  try {
    await run.open()
    await run.frame()
    for (const [open, label] of [
      [() => run.key("?,shift+?"), "help"],
      // The details dialog opens from the error line at the bottom of the panel.
      [() => run.app.mockMouse.click(2, 19), "refresh details"],
    ] as const) {
      focus.events.length = 0
      await open()
      // OpenCode refocuses what it saw focused on every later dialog clear, so it must see nothing.
      expect(run.dialogs.at(-1)?.saved, label).toBeNull()
      expect(focus.events, label).toEqual(["blur"])
      run.dialogs.at(-1)!.close()
      expect(await until(() => focus.events.length === 2), label).toBe(true)
      expect(focus.events, label).toEqual(["blur", "focus"])
      expect(focus.current, label).toBe(focus.node)
    }
  } finally {
    await run.dispose()
  }
})

test("failed RPC calls show a readable message in the footer, and once in the details dialog", async () => {
  // OpenCode's RPC client rejects with a plain object, not an Error, for an undeclared handler failure.
  const run = await harness({ fail: { type: "rpc.internal", message: "RPC call failed" } })
  try {
    await run.open()
    await run.frame()
    // Both the snapshot and the visit failed.
    expect(run.actions.some((action) => action.type === "visit")).toBe(true)
    const screen = run.app.captureCharFrame()
    expect(screen).toContain("! rpc.internal: RPC call failed")
    expect(screen).not.toContain("[object Object]")
    await run.app.mockMouse.click(2, 19)
    const message = run.dialogs.at(-1)?.message ?? ""
    expect(message.split("rpc.internal: RPC call failed").length - 1).toBe(1)
    expect(message).not.toContain("[object Object]")
    run.dialogs.at(-1)!.close()
  } finally {
    await run.dispose()
  }
})

test("an unloaded server part is named in the footer, with a hint in the details dialog", async () => {
  const run = await harness({
    fail: { type: "rpc.unavailable", message: "RPC is unavailable: opencode-switchboard" },
  })
  try {
    await run.open()
    await run.frame()
    expect(run.app.captureCharFrame()).toContain("! Switchboard server part not loaded")
    await run.app.mockMouse.click(2, 19)
    expect(run.dialogs.at(-1)?.message).toContain('"failed to load plugin"')
    run.dialogs.at(-1)!.close()
  } finally {
    await run.dispose()
  }
})

/** The host client's rejection when the connection drops, shaped as OpenCode 2.2.5's `ClientError`. */
function transportError() {
  const cause = new TypeError("ECONNRESET: The socket connection was closed unexpectedly")
  return Object.assign(new Error(`Transport: ${cause.message}`, { cause }), {
    name: "ClientError",
    reason: "Transport",
  })
}

/** Records the delays the switchboard schedules its catalog poll with, without letting the poll run. */
function capturePolls() {
  const original = globalThis.setTimeout
  const delays: number[] = []
  globalThis.setTimeout = ((handler: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    if (handler.name !== "poll") return original(handler, delay, ...args)
    delays.push(delay ?? 0)
    return original(() => {}, delay)
  }) as typeof setTimeout
  return { delays, restore: () => (globalThis.setTimeout = original) }
}

test("a lost connection shows a muted Reconnecting… line, retries sooner, and clears on the next refresh", async () => {
  const polls = capturePolls()
  const run = await harness()
  try {
    await run.open()
    await run.frame()
    const footer = () => run.app.captureCharFrame().split("\n").at(-2)!
    expect(footer()).not.toContain("!")
    expect(polls.delays).toEqual([15_000])

    run.failures.snapshot = transportError()
    await run.open()
    await run.frame()
    expect(footer()).toContain("Reconnecting…")
    expect(footer()).not.toContain("!")
    expect(footer()).not.toContain("ECONNRESET")
    // The details dialog keeps the client's full message.
    await run.app.mockMouse.click(2, 19)
    expect(run.dialogs.at(-1)?.message).toContain("Transport: ECONNRESET: The socket connection was closed")
    run.dialogs.at(-1)!.close()
    // While refreshes keep failing, the next one comes after 2, 4, and 8 seconds, then at the usual 15.
    for (let i = 0; i < 4; i++) await run.open()
    expect(polls.delays.slice(1)).toEqual([2_000, 4_000, 8_000, 15_000, 15_000])

    run.failures.snapshot = undefined
    await run.open()
    await run.frame()
    expect(footer()).not.toContain("Reconnecting")
    expect(footer()).not.toContain("!")
    // A later drop starts the backoff over.
    run.failures.snapshot = transportError()
    await run.open()
    expect(polls.delays.at(-1)).toBe(2_000)
  } finally {
    polls.restore()
    await run.dispose()
  }
})

test("an older server part's missing catalog method is asked once, and again after a reconnect", async () => {
  const run = await harness()
  try {
    await run.open()
    await run.frame()
    expect(run.catalogCalls()).toBe(1)
    await run.open()
    expect(run.catalogCalls()).toBe(1)
    // The server may come back upgraded: the first refresh after the connection returns asks again.
    run.failures.snapshot = transportError()
    await run.open()
    run.failures.snapshot = undefined
    await run.open()
    expect(run.catalogCalls()).toBe(2)
    await run.open()
    expect(run.catalogCalls()).toBe(2)
    expect(run.app.captureCharFrame()).toContain("Task a")
  } finally {
    await run.dispose()
  }
})

test("a change made without a connection says it was not saved", async () => {
  const run = await harness()
  try {
    await run.open()
    await run.frame()
    run.failures.act = transportError()
    await run.key("u")
    await run.frame()
    const screen = run.app.captureCharFrame()
    expect(screen).toContain("! Not saved: no connection to the server")
    expect(screen).not.toContain("Reconnecting")
  } finally {
    await run.dispose()
  }
})

test("the first open loads the catalog once", async () => {
  const run = await harness()
  try {
    await run.open()
    await run.frame()
    expect(run.app.captureCharFrame()).toContain("Task a")
    // The opening refresh accepts the saved membership and loads the catalog for it; that change queues no
    // second load.
    await Bun.sleep(20)
    expect(run.activeReads()).toBe(1)
  } finally {
    await run.dispose()
  }
})

test("with the server part's catalog method, rows load without listing any project's sessions", async () => {
  // The server lists nothing, so only the catalog method can show these rows.
  const run = await harness({ catalog: true, unlisted: true })
  try {
    await run.open()
    expect(await until(() => run.app.captureCharFrame().includes("Task a"))).toBe(true)
    expect(run.app.captureCharFrame()).toContain("Task b")
    expect(run.sessionLists()).toBe(0)
  } finally {
    await run.dispose()
  }
})

test("a membership change from this TUI's action still refreshes the catalog", async () => {
  const run = await harness()
  try {
    await run.open()
    await run.frame()
    const reads = run.activeReads()
    // Opening c from the host's session list admits it to its project.
    run.hostOpen("c")
    expect(await until(() => run.activeReads() > reads)).toBe(true)
    expect(await until(() => run.app.captureCharFrame().includes("Task c"))).toBe(true)
  } finally {
    await run.dispose()
  }
})

test("this TUI's own action reads no snapshot, while another TUI's change still does", async () => {
  const run = await harness()
  try {
    await run.open()
    await run.frame()
    await Bun.sleep(20)
    const snapshots = run.snapshots()
    const revision = run.saved().revision
    await run.key("u")
    expect(run.actions.at(-1)).toEqual({ type: "unread", sessionID: "b" })
    expect(await until(() => run.saved().revision > revision)).toBe(true)
    await Bun.sleep(20)
    // The server announced the action, but its reply already carried that revision.
    expect(run.snapshots()).toBe(snapshots)

    // Another TUI's change has a revision this TUI has not seen: it reads and shows it.
    await run.rpc.act({ type: "fold", key: "work", folded: true })
    expect(await until(() => !run.app.captureCharFrame().includes("Task a"))).toBe(true)
    expect(run.snapshots()).toBe(snapshots + 1)
  } finally {
    await run.dispose()
  }
})

test("a fullscreen switchboard's right-click menu runs in OpenCode's menu mode and never moves focus, the route, or the cursor", async () => {
  const focus = fakeFocus()
  const run = await harness({ focus })
  try {
    await run.open()
    await run.frame()
    const route = run.route()
    const focusEvents = [...focus.events]
    const sent = run.actions.length
    const rowOf = (text: string) =>
      run.app
        .captureCharFrame()
        .split("\n")
        .findIndex((line) => line.includes(text))
    const menuOpen = () => /Mark (un)?read +u/.test(run.app.captureCharFrame())
    await run.app.mockMouse.click(10, rowOf("Task a"), MouseButtons.RIGHT)
    await run.frame()
    expect(menuOpen()).toBe(true)
    // The menu mode turns off the panel's own keys until the menu closes.
    expect(run.modes).toEqual(["menu"])
    const bind = (key: string) => run.modeCommands("menu").find((command) => command.bind === key)!
    await bind("escape,ctrl+c").run()
    await run.frame()
    expect(menuOpen()).toBe(false)
    expect(run.modes).toEqual([])
    expect(run.actions.length).toBe(sent)
    // An item's key runs it on the right-clicked row.
    await run.app.mockMouse.click(10, rowOf("Task a"), MouseButtons.RIGHT)
    await run.frame()
    const label = run.app.captureCharFrame().includes("Mark read") ? "read" : "unread"
    await bind("u").run()
    await Bun.sleep(0)
    await run.frame()
    expect(run.actions.at(-1)).toMatchObject({ type: label, sessionID: "a" })
    expect(run.modes).toEqual([])
    expect(menuOpen()).toBe(false)
    expect(run.route()).toEqual(route)
    expect(focus.events).toEqual(focusEvents)
    // The panel cursor did not follow the right-click: `u` from the panel acts on the row it was on.
    await run.key("u")
    expect(run.actions.at(-1)).toMatchObject({ sessionID: "b" })
  } finally {
    await run.dispose()
  }
})

/** Right-clicks a row of the harness's panel and waits for the menu. */
async function openMenu(run: Awaited<ReturnType<typeof harness>>, title: string) {
  const y = run.app
    .captureCharFrame()
    .split("\n")
    .findIndex((line) => line.includes(title))
  await run.app.mockMouse.click(10, y, MouseButtons.RIGHT)
  await run.frame()
  expect(run.app.captureCharFrame()).toMatch(/Mark (un)?read +u/)
}

const menuCommand = (run: Awaited<ReturnType<typeof harness>>, bind: string) =>
  run.modeCommands("menu").find((command) => command.bind === bind)!

test("from the composer, a right-click menu focuses the side panel while open and returns focus on close", async () => {
  const focus = fakeFocus()
  const run = await harness({ focus, sidePanel: true })
  try {
    await run.open()
    await run.frame()
    // The composer has focus; the panel does not.
    expect(run.panel()).toBe("switchboard")
    expect(run.panelFocused()).toBe(false)
    const route = run.route()
    const sent = run.actions.length
    const closed = async (how: () => unknown) => {
      focus.events.length = 0
      await how()
      await Bun.sleep(0)
      await run.frame()
      expect(run.app.captureCharFrame()).not.toMatch(/Mark (un)?read +u/)
      expect(run.modes).toEqual([])
      // Focus is back in the composer, through the host's pane command.
      expect(run.dispatched.at(-1)).toBe("pane.focus.left")
      expect(run.panelFocused()).toBe(false)
      expect(focus.current).toBe(focus.node)
      expect(focus.events).toEqual(["focus"])
    }
    // The panel takes focus for the menu, so OpenCode enables its keys there and the composer gets none.
    focus.events.length = 0
    await openMenu(run, "Task a")
    expect(run.panelFocused()).toBe(true)
    expect(focus.events).toEqual(["panel"])
    expect(run.modes).toEqual(["menu"])
    // Esc closes it without acting.
    await closed(() => menuCommand(run, "escape,ctrl+c").run())
    expect(run.actions.length).toBe(sent)
    // An outside click closes it without acting.
    await openMenu(run, "Task a")
    await closed(() => run.app.mockMouse.click(1, 0))
    expect(run.actions.length).toBe(sent)
    // An item's key acts on the right-clicked row, then focus returns.
    await openMenu(run, "Task a")
    const label = run.app.captureCharFrame().includes("Mark read") ? "read" : "unread"
    await closed(() => menuCommand(run, "u").run())
    expect(run.actions.at(-1)).toMatchObject({ type: label, sessionID: "a" })
    expect(run.route()).toEqual(route)
    // The panel cursor never moved: its `u` acts on the session it was on.
    await run.key("u")
    expect(run.actions.at(-1)).toMatchObject({ sessionID: "b" })
  } finally {
    await run.dispose()
  }
})

test("a right-click menu in an already focused side panel leaves focus in the panel", async () => {
  const focus = fakeFocus()
  const run = await harness({ focus, sidePanel: true })
  try {
    await run.open()
    await run.frame()
    run.focusPanel()
    await run.frame()
    focus.events.length = 0
    await openMenu(run, "Task a")
    expect(run.modes).toEqual(["menu"])
    const dispatched = run.dispatched.length
    await menuCommand(run, "escape,ctrl+c").run()
    await run.frame()
    expect(run.modes).toEqual([])
    expect(run.panelFocused()).toBe(true)
    expect(focus.events).toEqual([])
    expect(run.dispatched.length).toBe(dispatched)
  } finally {
    await run.dispose()
  }
})

const HOME_AT_WORK = { type: "home", location: { directory: "/canon/work" } }

test("n opens the new-session screen of the cursor's project from its heading, rows, and Parked fold", async () => {
  const run = await harness({ members: ["a", "b", "c"], synced: { work: { canonical: "/canon/work" } } })
  try {
    await run.open()
    await run.frame()
    await run.rpc.act({ type: "place", sessionID: "c", placement: "parked" })
    await run.frame()
    // From the current row, b: the project heading, a session row, the Parked heading, and a parked session.
    for (const [label, moves] of [
      ["project heading", ["up,k", "up,k"]],
      ["session row", ["up,k"]],
      ["Parked heading", ["down,j"]],
      ["parked session", ["down,j", "down,j"]],
    ] as const) {
      run.navigate({ type: "session", sessionID: "b" })
      await run.frame()
      await run.open()
      await run.frame()
      for (const move of moves) await run.key(move)
      run.dispatched.length = 0
      await run.key("n")
      expect(await until(() => run.route().type === "home"), label).toBe(true)
      // The project's main directory, never a session's worktree; no session exists until the first message.
      expect(run.route(), label).toEqual(HOME_AT_WORK as Route)
      await Bun.sleep(20)
      // Nothing covers the new-session screen's composer or sends focus back to a conversation no longer shown.
      expect(run.route(), label).toEqual(HOME_AT_WORK as Route)
      expect(run.dispatched, label).not.toContain(FOCUS_CONVERSATION)
    }
    expect(run.sessionCreates()).toBe(0)
  } finally {
    await run.dispose()
  }
})

test("n from the fullscreen switchboard over the new-session screen opens the project's screen, not the switchboard", async () => {
  const run = await harness({ route: { type: "home" }, synced: { work: { canonical: "/canon/work" } } })
  try {
    await run.open()
    await run.frame()
    expect(run.route().type).toBe("plugin")
    await run.key("down,j")
    await run.key("n")
    expect(await until(() => run.route().type === "home")).toBe(true)
    await Bun.sleep(20)
    expect(run.route()).toEqual(HOME_AT_WORK as Route)
  } finally {
    await run.dispose()
  }
})

test("without a synced project, n uses the project's main checkout from the catalog", async () => {
  const run = await harness()
  try {
    await run.open()
    await run.frame()
    await run.key("n")
    expect(await until(() => run.route().type === "home")).toBe(true)
    expect(run.route()).toEqual({ type: "home", location: { directory: "/work" } } as Route)
  } finally {
    await run.dispose()
  }
})

test("a project known only to the server's project list opens at its canonical directory", async () => {
  // Its rows are a worktree, /work, of /listed/work: no main-checkout row to read the directory from.
  const run = await harness({ projects: [{ id: "work", name: "Work", canonical: "/listed/work" }] })
  try {
    await run.open()
    await run.frame()
    await run.key("n")
    expect(await until(() => run.route().type === "home")).toBe(true)
    expect(run.route()).toEqual({ type: "home", location: { directory: "/listed/work" } } as Route)
  } finally {
    await run.dispose()
  }
})

test("a directory-keyed project opens its new-session screen at its key", async () => {
  const run = await harness({ global: true, synced: { global: { canonical: "/" } } })
  try {
    await run.open()
    await run.frame()
    expect(run.saved().projects["/work"]?.open).toBe(true)
    await run.key("up,k")
    await run.key("up,k")
    await run.key("n")
    expect(await until(() => run.route().type === "home")).toBe(true)
    expect(run.route()).toEqual({ type: "home", location: { directory: "/work" } } as Route)
  } finally {
    await run.dispose()
  }
})

test("a project with no known directory says so in the footer and stays put", async () => {
  // No synced project, no catalog row to read a directory from, and no listed project.
  const run = await harness({ route: { type: "home" }, members: [], projects: [], unlisted: true })
  try {
    await run.open()
    await run.frame()
    const route = run.route()
    await run.key("n")
    expect(await until(() => run.app.captureCharFrame().includes("! No directory found for Work"))).toBe(true)
    expect(run.route()).toEqual(route)
    expect(run.sessionCreates()).toBe(0)
  } finally {
    await run.dispose()
  }
})

test("from the composer, a project heading's menu offers New session, which opens the project's screen", async () => {
  const focus = fakeFocus()
  const run = await harness({ focus, sidePanel: true, synced: { work: { canonical: "/canon/work" } } })
  try {
    await run.open()
    await run.frame()
    expect(run.panelFocused()).toBe(false)
    const screen = () => run.app.captureCharFrame()
    const y = screen()
      .split("\n")
      .findIndex((line) => line.includes("Work/"))
    await run.app.mockMouse.click(10, y, MouseButtons.RIGHT)
    await run.frame()
    // One item, with the panel key that does the same.
    expect(screen()).toMatch(/New session +n/)
    expect(screen()).not.toMatch(/Mark (un)?read|Park/)
    expect(run.panelFocused()).toBe(true)
    expect(run.modes).toEqual(["menu"])
    expect(run.modeCommands("menu").map((command) => command.bind)).toContain("n")
    await menuCommand(run, "n").run()
    expect(await until(() => run.route().type === "home")).toBe(true)
    expect(run.route()).toEqual(HOME_AT_WORK as Route)
    expect(run.modes).toEqual([])
    expect(run.sessionCreates()).toBe(0)
    // Closing the menu returned focus to the conversation before it left; the home screen's composer then takes it.
    await Bun.sleep(20)
    expect(run.route()).toEqual(HOME_AT_WORK as Route)
  } finally {
    await run.dispose()
  }
})

test("a fullscreen project heading's New session item runs on a click, and the Parked heading has no menu", async () => {
  const run = await harness({ members: ["a", "b", "c"], synced: { work: { canonical: "/canon/work" } } })
  try {
    await run.open()
    await run.frame()
    await run.rpc.act({ type: "place", sessionID: "c", placement: "parked" })
    await run.frame()
    const lines = () => run.app.captureCharFrame().split("\n")
    const rowOf = (text: string) => lines().findIndex((line) => line.includes(text))
    await run.app.mockMouse.click(10, rowOf("Parked"), MouseButtons.RIGHT)
    await run.frame()
    expect(run.app.captureCharFrame()).not.toContain("New session")
    expect(run.modes).toEqual([])
    await run.app.mockMouse.click(10, rowOf("Work/"), MouseButtons.RIGHT)
    await run.frame()
    const item = rowOf("New session")
    expect(item).toBeGreaterThanOrEqual(0)
    await run.app.mockMouse.click(lines()[item]!.indexOf("New session"), item)
    expect(await until(() => run.route().type === "home")).toBe(true)
    expect(run.route()).toEqual(HOME_AT_WORK as Route)
  } finally {
    await run.dispose()
  }
})

// A toast when the viewed conversation loses its row (#57).

const NOT_LISTED = "Not in the switchboard. Press ctrl+x i to add it back"
const openKey = (key: string) => (id: string) => (id === "opencode-switchboard.open" ? [key] : [])

/** Another TUI changes something unrelated, and this TUI has applied it: a refresh that leaves the row missing. */
async function unrelatedChange(run: Awaited<ReturnType<typeof harness>>) {
  await run.rpc.act({ type: "unread", sessionID: "a" })
  expect(await until(() => run.app.captureCharFrame().includes("• Task a"))).toBe(true)
  await run.frame()
}

test("another TUI closing the viewed row toasts once with the open key, and the open command adds it back", async () => {
  const run = await harness({ shortcuts: openKey("ctrl+x i") })
  try {
    await run.open()
    await run.frame()
    expect(run.toasts()).toEqual([])
    await run.rpc.act({ type: "session-remove", sessionID: "b" })
    expect(await until(() => run.toasts().length === 1)).toBe(true)
    expect(run.toastOptions).toEqual([{ variant: "info", message: NOT_LISTED }])
    expect(await until(() => !run.app.captureCharFrame().includes("Task b"))).toBe(true)
    expect(run.route()).toEqual({ type: "session", sessionID: "b" })
    // The footer stays for lasting states only.
    expect(run.app.captureCharFrame()).not.toContain("Not in the switchboard")
    // Later refreshes while it is still missing say nothing more.
    await unrelatedChange(run)
    expect(run.toasts()).toEqual([NOT_LISTED])
    // <leader>i lists it again, quietly.
    await run.open()
    await run.frame()
    expect(run.app.captureCharFrame()).toContain("Task b")
    expect(run.bold("Task b")).toBe(true)
    expect(run.toasts()).toEqual([NOT_LISTED])
    // Losing it again is a new event.
    await run.rpc.act({ type: "session-remove", sessionID: "b" })
    expect(await until(() => run.toasts().length === 2)).toBe(true)
    expect(run.toasts()).toEqual([NOT_LISTED, NOT_LISTED])
  } finally {
    await run.dispose()
  }
})

test("the toast names a custom leader's key, and with the open command unbound, no key", async () => {
  for (const [shortcuts, message] of [
    [openKey("ctrl+a i"), "Not in the switchboard. Press ctrl+a i to add it back"],
    [() => [], "Not in the switchboard. Open the switchboard to add it back"],
  ] as const) {
    const run = await harness({ shortcuts })
    try {
      await run.open()
      await run.frame()
      await run.rpc.act({ type: "session-remove", sessionID: "b" })
      expect(await until(() => run.toasts().length === 1)).toBe(true)
      expect(run.toasts()).toEqual([message])
    } finally {
      await run.dispose()
    }
  }
})

test("another TUI closing the viewed conversation's project toasts too", async () => {
  const run = await harness({ shortcuts: openKey("ctrl+x i") })
  try {
    await run.open()
    await run.frame()
    await run.rpc.act({ type: "project-close", project: "work" })
    expect(await until(() => run.toasts().length === 1)).toBe(true)
    expect(run.toasts()).toEqual([NOT_LISTED])
    await run.open()
    await run.frame()
    expect(run.saved().projects.work?.open).toBe(true)
    expect(run.app.captureCharFrame()).toContain("Task b")
  } finally {
    await run.dispose()
  }
})

test("this TUI's own close of the viewed row, by leader-w, x, or its project, goes back without a toast", async () => {
  const run = await harness({ shortcuts: openKey("ctrl+x i"), other: ["c"] })
  try {
    await run.open()
    await run.frame()
    await run.close().run()
    await run.frame()
    expect(run.route()).toEqual({ type: "session", sessionID: "a" })
    // The cursor follows the conversation shown; `x` closes its row.
    await run.open()
    await run.key("x")
    await run.frame()
    expect(run.app.captureCharFrame()).not.toContain("Task a")
    // c is the only row left; closing its project from the heading goes home (the fullscreen switchboard over it).
    run.navigate({ type: "session", sessionID: "c" })
    expect(await until(() => run.bold("Task c"))).toBe(true)
    await run.open()
    await run.key("up,k")
    await run.key("x")
    expect(await until(() => run.route().type === "plugin")).toBe(true)
    expect(run.saved().projects.other?.open).toBe(false)
    await run.frame()
    expect(run.toasts()).toEqual([])
  } finally {
    await run.dispose()
  }
})

test("no toast at startup, while a new route's visit lands, or after a failed first visit", async () => {
  const visit = Promise.withResolvers<void>()
  const options: Parameters<typeof harness>[0] = { members: ["a"], shortcuts: openKey("ctrl+x i") }
  const run = await harness(options)
  try {
    // Startup lists the conversation shown, which had no row.
    await run.open()
    await run.frame()
    expect(run.app.captureCharFrame()).toContain("Task b")
    // Opening an unlisted session elsewhere: no toast while its visit is held, nor after it lands.
    options.visitGate = visit.promise
    run.hostOpen("c")
    expect(await until(() => run.actions.at(-1)?.type === "visit")).toBe(true)
    await run.frame()
    expect(run.toasts()).toEqual([])
    visit.resolve()
    expect(await until(() => run.app.captureCharFrame().includes("Task c"))).toBe(true)
    expect(run.toasts()).toEqual([])
  } finally {
    visit.resolve()
    await run.dispose()
  }
  // A first visit that fails leaves the conversation unlisted: the footer has the error, and no toast fires.
  const failing = await harness({ members: ["a"], shortcuts: openKey("ctrl+x i") })
  try {
    failing.failures.act = { type: "rpc.internal", message: "RPC call failed" }
    await failing.open()
    await failing.frame()
    expect(failing.app.captureCharFrame()).toContain("! rpc.internal: RPC call failed")
    expect(failing.toasts()).toEqual([])
  } finally {
    await failing.dispose()
  }
})

test("from a subagent, the parent's row closing elsewhere toasts, and the open command lists the parent", async () => {
  const run = await harness({
    route: { type: "session", sessionID: "child" },
    shortcuts: openKey("ctrl+x i"),
  })
  try {
    await run.open()
    await run.frame()
    await run.rpc.act({ type: "session-remove", sessionID: "b" })
    expect(await until(() => run.toasts().length === 1)).toBe(true)
    await run.open()
    await run.frame()
    expect(run.app.captureCharFrame()).toContain("Task b")
    expect(run.route()).toEqual({ type: "session", sessionID: "child" })
    expect(run.actions.at(-1)).toEqual({ type: "visit", sessionID: "b", observed: 0 })
    expect(run.toasts()).toEqual([NOT_LISTED])
  } finally {
    await run.dispose()
  }
})

test("over the fullscreen switchboard, the covered conversation losing its row toasts, and opening lists it", async () => {
  const run = await harness({ shortcuts: openKey("ctrl+x i") })
  try {
    await run.open()
    await run.frame()
    run.navigate({ type: "plugin", id: "opencode-switchboard", name: "switchboard" })
    await run.rpc.act({ type: "session-remove", sessionID: "b" })
    expect(await until(() => run.toasts().length === 1)).toBe(true)
    await run.open()
    expect(await until(() => run.app.captureCharFrame().includes("Task b"))).toBe(true)
    expect(run.actions.at(-1)).toEqual({ type: "visit", sessionID: "b", observed: 0 })
    expect(run.route()).toEqual({ type: "plugin", id: "opencode-switchboard", name: "switchboard" })
    expect(run.toasts()).toEqual([NOT_LISTED])
  } finally {
    await run.dispose()
  }
})

test("with the switchboard closed, another TUI's close of the viewed row does not toast", async () => {
  const run = await harness({ shortcuts: openKey("ctrl+x i") })
  try {
    await run.open()
    await run.frame()
    await run.key("escape")
    await run.rpc.act({ type: "session-remove", sessionID: "b" })
    await run.frame()
    expect(run.toasts()).toEqual([])
    // Opening it lists the conversation again, without a toast.
    await run.open()
    await run.frame()
    expect(run.app.captureCharFrame()).toContain("Task b")
    expect(run.toasts()).toEqual([])
  } finally {
    await run.dispose()
  }
})

test("the footer shows the location this TUI shows, home as ~, with its branch, and follows both", async () => {
  const [location, setLocation] = createSignal({ directory: "/home/me/work" })
  const [branch, setBranch] = createSignal<string | undefined>("main")
  const run = await harness({ location, branch: () => branch() })
  try {
    await run.open()
    await run.frame()
    await run.frame()
    const footer = () => run.app.captureCharFrame().split("\n").at(-2)!
    expect(footer()).toMatch(/^ ~\/work:main +\? help/)
    // The host reloads the branch on `vcs.branch.updated`.
    setBranch("feature")
    await run.frame()
    expect(footer()).toMatch(/^ ~\/work:feature +\? help/)
    // Another conversation's location, outside the home directory and without git: the path alone.
    setLocation({ directory: "/srv/other" })
    setBranch(undefined)
    await run.frame()
    expect(footer()).toMatch(/^ \/srv\/other +\? help/)
  } finally {
    await run.dispose()
  }
})
