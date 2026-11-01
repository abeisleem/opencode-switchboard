import { expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import type { Plugin } from "@opencode/plugin/tui"
import { initialState, type Action, type State } from "../src/model"
import server from "../src/server"
import tui from "../src/tui"

type Route = ReturnType<Plugin.Context["ui"]["router"]["current"]>

async function backend(ids = ["a", "b", "c"]) {
  let state = initialState()
  state.revision = 1
  state.projects.work = { name: "Work", open: true, sessions: ids }
  state.sessions.a = { placement: "parked", unread: true }
  const existing = new Set(ids)
  const reads: string[] = []
  let rpc!: { snapshot: () => Promise<State>; act: (action: Action) => Promise<State> }
  await server.setup({
    storage: {
      get: async () => state,
      set: async (_key: string, next: State) => {
        state = next
      },
    },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        reads.push(sessionID)
        if (!existing.has(sessionID)) throw new Error("SessionNotFoundError")
        return { id: sessionID, projectID: "work", location: { directory: "/work" }, time: {} }
      },
    },
    rpc: {
      register: async (_contract: unknown, handlers: typeof rpc) => {
        rpc = handlers
        return { events: { emit: async () => {} } }
      },
    },
  } as unknown as Parameters<typeof server.setup>[0])
  return { rpc, existing, reads }
}

test("removing an already deleted session only changes Switchboard membership", async () => {
  const host = await backend()
  host.existing.delete("b")
  const next = await host.rpc.act({ type: "session-remove", sessionID: "b" })
  expect(host.reads).toEqual([])
  expect(next.projects.work?.sessions).toEqual(["a", "c"])
  expect(next.sessions.a).toEqual({ placement: "parked", unread: true })
  expect([...host.existing]).toEqual(["a", "c"])
})

async function harness(ids?: string[]) {
  const host = await backend(ids)
  const listeners = new Map<string, (event: { data: { sessionID: string } }) => void>()
  const [route, setRoute] = createSignal<Route>({ type: "session", sessionID: "b" })
  const dispatched: string[] = []
  let open!: () => Promise<void>
  let cleanup!: ReturnType<typeof tui.setup>
  const noop = () => {}
  const context = {
    options: {},
    location: { directory: "/work" },
    client: {
      rpc: () => ({ ...host.rpc, events: { on: () => noop } }),
      project: { list: async () => [{ id: "work", name: "Work", canonical: "/work" }] },
      session: {
        active: async () => ({}),
        list: async () => ({
          data: [...host.existing].map((id) => ({
            id,
            projectID: "work",
            title: id,
            location: { directory: "/work" },
            time: {},
          })),
          cursor: {},
        }),
      },
      permission: { request: { list: async () => ({ data: [] }) } },
      form: { list: async () => ({ data: [] }) },
    },
    data: {
      session: {
        root: (id: string) => id,
        family: () => [],
        status: () => "idle",
        pending: { list: () => [] },
        permission: { list: () => undefined },
        form: { list: () => undefined },
        get: () => undefined,
      },
      on: (type: string, listener: (event: { data: { sessionID: string } }) => void) => {
        listeners.set(type, listener)
        return () => listeners.delete(type)
      },
    },
    storage: {
      memory: (_key: string, options: { initial: unknown }) => [options.initial, noop],
      store: (_key: string, options: { initial: unknown }) => [options.initial, noop],
    },
    ui: {
      router: {
        current: route,
        navigate: (destination: Parameters<Plugin.Context["ui"]["router"]["navigate"]>[0]) =>
          setRoute(
            destination.type === "plugin" ? { id: "opencode-switchboard", ...destination } : destination,
          ),
        register: () => noop,
      },
      slot: (claim: { append: string; render: () => unknown }) => {
        if (claim.append === "app") claim.render()
        return noop
      },
      panel: { open: () => route().type === "session", current: () => undefined },
      tabs: { enabled: () => false },
    },
    keymap: {
      dispatch: (command: string) => dispatched.push(command),
      layer: (factory: () => { commands: { id?: string; run: () => Promise<void> }[] }) => {
        open = factory().commands.find((command) => command.id === "opencode-switchboard.open")!.run
      },
    },
  } as unknown as Plugin.Context
  const dispose = createRoot((dispose) => {
    cleanup = tui.setup(context)
    return dispose
  })
  await open()
  return {
    ...host,
    route,
    setRoute,
    listeners,
    dispatched,
    delete(id: string) {
      host.existing.delete(id)
      listeners.get("session.deleted")?.({ data: { sessionID: id } })
    },
    async close() {
      await (
        await cleanup
      )?.()
      expect(listeners.has("session.deleted")).toBe(false)
      dispose()
    },
  }
}

for (const order of ["before", "after"] as const)
  test(`native deletion goes to this TUI's recent open work when the host goes home ${order} the event`, async () => {
    const host = await harness()
    try {
      // This TUI showed c, then b. Without that history it would fall back to the first open session, a.
      host.setRoute({ type: "session", sessionID: "c" })
      await Bun.sleep(0)
      host.setRoute({ type: "session", sessionID: "b" })
      await Bun.sleep(0)
      if (order === "before") host.setRoute({ type: "home" })
      host.delete("b")
      if (order === "after") host.setRoute({ type: "home" })
      await Bun.sleep(0) // Drain the in-memory RPC and route effects.
      expect(host.route()).toEqual({ type: "session", sessionID: "c" })
      expect((await host.rpc.snapshot()).projects.work?.sessions).toEqual(["a", "c"])
    } finally {
      await host.close()
    }
  })

test("native deletion of background work preserves the current session", async () => {
  const host = await harness()
  try {
    host.delete("c")
    await Bun.sleep(0)
    expect((await host.rpc.snapshot()).projects.work?.sessions).toEqual(["a", "b"])
    expect(host.route()).toEqual({ type: "session", sessionID: "b" })
    const revision = (await host.rpc.snapshot()).revision
    host.delete("child-not-in-switchboard")
    await Bun.sleep(0)
    expect((await host.rpc.snapshot()).revision).toBe(revision)
    expect(host.route()).toEqual({ type: "session", sessionID: "b" })
  } finally {
    await host.close()
  }
})

test("native deletion of the final open session goes home and preserves its project", async () => {
  const host = await harness(["b"])
  try {
    host.delete("b")
    host.setRoute({ type: "home" })
    await Bun.sleep(0)
    // As with closing the last row, Switchboard stays fullscreen over the new-session screen.
    expect(host.route()).toEqual({ type: "plugin", id: "opencode-switchboard", name: "switchboard" })
    expect((await host.rpc.snapshot()).projects.work).toEqual({ name: "Work", open: true, sessions: [] })
  } finally {
    await host.close()
  }
})

test("native deletion without recent history goes to the first open session", async () => {
  const host = await harness()
  try {
    host.delete("b")
    host.setRoute({ type: "home" })
    await Bun.sleep(0)
    expect(host.route()).toEqual({ type: "session", sessionID: "a" })
  } finally {
    await host.close()
  }
})

test("native deletion of a session this TUI has left does not navigate it", async () => {
  const host = await harness()
  try {
    // This TUI showed b, then moved to c; another client deletes b.
    host.setRoute({ type: "session", sessionID: "c" })
    await Bun.sleep(0)
    host.delete("b")
    await Bun.sleep(0)
    expect(host.route()).toEqual({ type: "session", sessionID: "c" })
    expect((await host.rpc.snapshot()).projects.work?.sessions).toEqual(["a", "c"])
  } finally {
    await host.close()
  }
})

test("native deletion of the current session goes back but leaves keyboard focus where it is", async () => {
  const host = await harness()
  try {
    host.dispatched.length = 0
    host.delete("b")
    await Bun.sleep(10) // Drain the RPC, the route effect, and any deferred focus hand-off.
    expect(host.route()).toEqual({ type: "session", sessionID: "a" })
    expect(host.dispatched).not.toContain("pane.focus.left")
  } finally {
    await host.close()
  }
})
