import { expect, test } from "bun:test"
import type { Plugin as ServerPlugin } from "@opencode/plugin"
import type { Plugin } from "@opencode/plugin/tui"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { createSignal, type JSX } from "solid-js"
import { initialState, type Action, type State } from "../src/model"
import server from "../src/server"
import plugin from "../src/tui"

async function fixture(projectID: string) {
  const directory = "/new-project"
  const info = {
    id: "new-session",
    projectID,
    title: "First conversation",
    location: { directory },
    time: { created: 1, updated: 1 },
  }
  let created = false
  let misses = 0
  let saved = initialState()
  saved.revision = 1
  saved.projects.parked = { name: "Keep my name", open: false, sessions: ["saved"] }
  saved.sessions.saved = { placement: "later", unread: true, seen: 0 }
  const original = structuredClone(saved)
  const noop = () => {}
  let rpc!: { snapshot: () => Promise<State>; act: (action: Action) => Promise<State> }
  const get = async () => {
    if (!created) {
      misses++
      throw Object.assign(new Error("Session not found"), { _tag: "SessionNotFoundError" })
    }
    return info
  }
  // Real server admission/reducer, with only persistence and authoritative session lookup replaced.
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
        return { events: { emit: async () => {} } }
      },
    },
  } as unknown as ServerPlugin.Context)
  type Route = { type: "home" } | { type: "session"; sessionID: string }
  const [route, navigate] = createSignal<Route>({ type: "home" })
  const listeners = new Map<string, (event: { data: { sessionID: string } }) => void>()
  let open!: () => Promise<void>
  let render!: () => JSX.Element
  let renderApp!: () => JSX.Element
  let cleanup!: ReturnType<typeof plugin.setup>
  const color = RGBA.fromHex("#c0caf5")
  const context = {
    options: { backendDirectory: "/backend" },
    location: { directory, project: { id: projectID, canonical: directory } },
    client: {
      rpc: () => ({ ...rpc, events: { on: () => noop } }),
      project: { list: async () => [{ id: projectID, canonical: projectID === "global" ? "/" : directory }] },
      session: {
        get,
        active: async () => ({}),
        list: async () => ({ data: created ? [info] : [], cursor: {} }),
      },
      permission: { request: { list: async () => ({ data: [] }) } },
      form: { list: async () => ({ data: [] }) },
    },
    data: {
      on: (type: string, listener: (event: { data: { sessionID: string } }) => void) => {
        listeners.set(type, listener)
        return () => listeners.delete(type)
      },
      session: { root: (id: string) => id, get: () => info },
      project: { get: () => undefined },
    },
    storage: {
      memory: (_key: string, options: { initial: unknown }) => [options.initial, noop],
      store: (_key: string, options: { initial: unknown }) => [options.initial, noop],
    },
    theme: {
      text: { base: color, muted: color, feedback: { error: { base: color } } },
      background: { base: color, raised: { base: color }, action: { primary: { hovered: color } } },
      hue: { accent: { 200: color }, interactive: { 200: color } },
      decrease: (value: RGBA) => value,
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
      panel: { open: () => true, current: () => undefined, close: noop },
      tabs: { enabled: () => false },
    },
    keymap: {
      dispatch: noop,
      layer: (factory: () => { commands: { id?: string; run: () => Promise<void> }[] }) => {
        for (const command of factory().commands)
          if (command.id === "opencode-switchboard.open") open = command.run
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
  return {
    app,
    open,
    navigate,
    original,
    saved: () => saved,
    misses: () => misses,
    create(id = info.id) {
      created = true
      listeners.get("session.created")?.({ data: { sessionID: id } })
    },
    async dispose() {
      await (
        await cleanup
      )?.()
      expect(listeners.has("session.created")).toBe(false)
      await app.dispose()
    },
  }
}

for (const projectID of ["global", "git-project"]) {
  test(`optimistic creation admits a new ${projectID} project without another navigation`, async () => {
    const run = await fixture(projectID)
    try {
      await run.open()
      run.navigate({ type: "session", sessionID: "new-session" })
      await run.app.renderOnce()
      expect(run.misses()).toBe(1)
      expect(run.saved().selected).toBeNull()
      expect(run.app.captureCharFrame()).not.toContain("Session not found")
      run.create()
      await run.app.renderOnce()
      await run.app.renderOnce()
      expect(run.saved().selected).toBe("new-session")
      const key = projectID === "global" ? "/new-project" : projectID
      expect(run.saved().projects[key]).toEqual({
        name: "new-project",
        open: true,
        sessions: ["new-session"],
      })
      expect(run.saved().projects.parked).toEqual(run.original.projects.parked)
      expect(run.saved().sessions.saved).toEqual(run.original.sessions.saved)
      expect(run.app.captureCharFrame()).toContain("First conversation")
      expect(run.app.captureCharFrame()).not.toContain("Session not found")
    } finally {
      await run.dispose()
    }
  })
}

test("a creation event does not admit a session after leaving its optimistic route", async () => {
  const run = await fixture("global")
  try {
    await run.open()
    run.navigate({ type: "session", sessionID: "new-session" })
    await run.app.renderOnce()
    run.navigate({ type: "home" })
    await run.app.renderOnce()
    const before = structuredClone(run.saved())
    run.create()
    await run.app.renderOnce()
    expect(run.saved()).toEqual(before)
  } finally {
    await run.dispose()
  }
})

test("creation before navigation is admitted by the route and unrelated events are ignored", async () => {
  const run = await fixture("global")
  try {
    await run.open()
    run.create()
    await run.app.renderOnce()
    expect(run.saved().selected).toBeNull()
    run.navigate({ type: "session", sessionID: "new-session" })
    await run.app.renderOnce()
    await run.app.renderOnce()
    expect(run.saved().selected).toBe("new-session")
    const before = structuredClone(run.saved())
    run.create("another-client-session")
    await run.app.renderOnce()
    expect(run.saved()).toEqual(before)
    expect(run.misses()).toBe(0)
  } finally {
    await run.dispose()
  }
})
