import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/tui"
import { RGBA, TextAttributes } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { createSignal, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { initialState, type Action, type State } from "../src/model"
import server from "../src/server"
import plugin from "../src/tui"

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
    selectGate?: Promise<void>
    live?: Partial<LiveSession>
    active?: () => Record<string, unknown>
    approvals?: () => string[]
    focus?: FakeFocus
    shortcuts?: (id: string) => readonly string[]
  } = {},
) {
  let saved = initialState()
  saved.revision = 1
  saved.selected = "a"
  saved.recent = ["a", "b"]
  saved.projects.work = { name: "Work", open: true, sessions: options.members ?? ["a", "b"] }
  const sessions = ["a", "b", "c"].map((id) => ({
    id,
    title: `Task ${id}`,
    projectID: "work",
    location: { directory: "/work" },
    time: {},
  }))
  const get = async ({ sessionID }: { sessionID: string }) =>
    sessionID === "child"
      ? { ...sessions[1]!, id: "child", parentID: "b" }
      : sessions.find((item) => item.id === sessionID)!
  const noop = () => {}
  let activeReads = 0
  // What OpenCode would remember as the focus target when each dialog opened; see `modal` in src/tui.tsx.
  const dialogs: { saved: unknown; close: () => void; render?: () => JSX.Element }[] = []
  let changed: (() => void) | undefined
  let rpc!: { snapshot: () => Promise<State>; act: (action: Action) => Promise<State> }
  await server.setup({
    storage: {
      get: async () => saved,
      set: async (_key: string, value: State) => {
        saved = value
      },
    },
    session: { get },
    rpc: {
      register: async (_contract: unknown, handlers: typeof rpc) => {
        rpc = handlers
        return {
          events: {
            emit: async () => {
              changed?.()
            },
          },
        }
      },
    },
  } as unknown as Parameters<typeof server.setup>[0])
  const [route, navigate] = createSignal<Route>(options.route ?? { type: "session", sessionID: "b" })
  const layers: (() => Layer)[] = []
  const actions: Action[] = []
  let render!: () => JSX.Element
  let renderApp!: () => JSX.Element
  let cleanup!: ReturnType<typeof plugin.setup>
  const color = RGBA.fromHex("#c0caf5")
  const context = {
    options: {},
    location: { directory: "/work" },
    client: {
      rpc: () => ({
        snapshot: rpc.snapshot,
        act: async (action: Action) => {
          actions.push(action)
          if (action.type === "select") await options.selectGate
          return rpc.act(action)
        },
        events: {
          on: (_type: string, listener: () => void) => {
            changed = listener
            return noop
          },
        },
      }),
      project: { list: async () => [{ id: "work", name: "Work", canonical: "/work" }] },
      session: {
        get,
        active: async () => {
          activeReads++
          return options.active?.() ?? {}
        },
        list: async () => ({ data: sessions, cursor: {} }),
      },
      permission: {
        request: {
          list: async () => ({ data: (options.approvals?.() ?? []).map((sessionID) => ({ sessionID })) }),
        },
      },
      form: { list: async () => ({ data: [] }) },
    },
    data: {
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
    },
    storage: {
      memory: (_key: string, input: { initial: unknown }) => [input.initial, noop],
      store: (_key: string, input: { initial: unknown }) => [input.initial, noop],
    },
    theme: {
      text: { base: color, muted: color, feedback: { error: { base: color } } },
      background: { base: color, action: { primary: { hovered: color } } },
      hue: { accent: { 200: color }, interactive: { 200: color } },
      surface: () => ({
        text: { base: color, muted: color, action: { primary: { focused: color } } },
        background: { action: { primary: { focused: color } } },
      }),
    },
    ui: {
      router: {
        current: route,
        navigate,
        register: (page: { render: () => JSX.Element }) => {
          render = page.render
          return noop
        },
      },
      slot: (slot: { append: string; render: () => JSX.Element }) => {
        if (slot.append === "app") renderApp = slot.render
        return noop
      },
      panel: { open: () => route().type === "session", current: () => undefined, close: noop },
      tabs: { enabled: () => false },
      dialog: {
        show: (render: () => JSX.Element, onClose?: () => void) =>
          dialogs.push({ saved: options.focus?.current ?? null, close: onClose ?? noop, render }),
        alert: () =>
          new Promise<void>((resolve) =>
            dialogs.push({ saved: options.focus?.current ?? null, close: resolve }),
          ),
        clear: noop,
      },
    },
    keymap: {
      dispatch: noop,
      shortcuts: options.shortcuts ?? (() => []),
      layer: (factory: () => Layer) => {
        layers.push(factory)
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
      return render()
    },
    { width: 60, height: 20 },
  )
  const commands = () => layers.flatMap((factory) => factory().commands ?? [])
  const command = (id: string) => commands().find((item) => item.id === id)!
  return {
    app,
    route,
    navigate,
    actions,
    rpc,
    saved: () => saved,
    sessions,
    activeReads: () => activeReads,
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

test("startup adopts --session instead of the previously saved selection", async () => {
  const run = await harness()
  try {
    await run.open()
    await run.frame()
    expect(run.route()).toEqual({ type: "session", sessionID: "b" })
    expect(run.saved().selected).toBe("b")
    expect(run.saved().recent.slice(0, 2)).toEqual(["b", "a"])
    expect(run.bold("Task b")).toBe(true)
    expect(run.bold("Task a")).toBe(false)
    await run.key("u")
    expect(run.actions.at(-1)).toEqual({ type: "unread", sessionID: "b" })
  } finally {
    await run.dispose()
  }
})

test("the current marker follows the displayed route while selection synchronization is pending", async () => {
  const gate = Promise.withResolvers<void>()
  const run = await harness({ selectGate: gate.promise })
  const opening = run.open()
  try {
    await run.frame()
    expect(run.saved().selected).toBe("a")
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
    expect(run.saved().selected).toBe("b")
    expect(run.saved().projects.work?.sessions).toEqual(["b", "a"])
    expect(run.bold("Task b")).toBe(true)
  } finally {
    await run.dispose()
  }
})

test("later selections from another client still synchronize the route and marker", async () => {
  const run = await harness()
  try {
    await run.open()
    await run.rpc.act({ type: "select", sessionID: "c", observed: 0 })
    await run.frame()
    expect(run.route()).toEqual({ type: "session", sessionID: "c" })
    expect(run.bold("Task c")).toBe(true)
    expect(run.bold("Task b")).toBe(false)
  } finally {
    await run.dispose()
  }
})

test("reopening adopts this client's route after another client changed the saved selection", async () => {
  const run = await harness()
  try {
    await run.open()
    await run.key("escape")
    await run.rpc.act({ type: "select", sessionID: "c", observed: 0 })
    run.navigate({ type: "session", sessionID: "a" })
    await run.open()
    await run.frame()
    expect(run.route()).toEqual({ type: "session", sessionID: "a" })
    expect(run.saved().selected).toBe("a")
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

test("closing the last viewed root from a subagent returns home and disables close", async () => {
  const run = await harness({ route: { type: "session", sessionID: "child" }, members: ["b"] })
  try {
    await run.open()
    expect(run.close()).toBeDefined()
    await run.close().run()
    await run.frame()
    expect(run.saved().selected).toBeNull()
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
    expect(run.saved().selected).toBe("a")
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
  for (let i = 0; i < 100 && !condition(); i++) await Bun.sleep(5)
  return condition()
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
  const run = await harness({ focus })
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
