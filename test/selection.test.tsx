import { expect, test } from "bun:test"
import { createSignal, Show } from "solid-js"
import { testRender } from "@opentui/solid"
import { InboxPanel, type PanelProps } from "../src/panel"
import { initialState, reduce, type Action, type Session, type State } from "../src/model"
import { createSelectionMemory } from "../src/selection"

type Controls = Parameters<NonNullable<PanelProps["keys"]>>[0]

function fixture(ids = ["a", "b", "c"], neighbors = true) {
  const sessions: Session[] = [
    ...(neighbors ? [["before", "Before"]] : []),
    ...ids.map((id) => [id, "Work"]),
    ...(neighbors ? [["after", "Z after"]] : []),
  ].map(([id, project]) => ({
    id: id!,
    project: project!,
    projectName: project!,
    title: `Task ${id}`,
    directory: `/${project}`,
    detail: "main",
    idle: 0,
    viewed: 0,
    running: false,
    status: "Idle",
  }))
  const state = initialState()
  for (const session of sessions) {
    const project = (state.projects[session.project] ??= {
      name: session.projectName,
      open: true,
      sessions: [],
    })
    project.sessions.push(session.id)
  }
  return { sessions, state }
}

async function harness(input: { sessions: Session[]; state: State }, height = 28) {
  let controls!: Controls
  let dispatch!: (action: Action) => void
  let mount!: (value: boolean) => void
  let replace!: (value: boolean) => void
  let catalog!: (sessions: Session[]) => void
  const memory = createSelectionMemory()
  const calls: Action[] = []
  const app = await testRender(
    () => {
      const [state, setState] = createSignal(input.state)
      const [mounted, setMounted] = createSignal(true)
      const [replacement, setReplacement] = createSignal(false)
      const [sessions, setSessions] = createSignal(input.sessions)
      mount = setMounted
      replace = setReplacement
      catalog = setSessions
      dispatch = (action) => {
        calls.push(action)
        setState(reduce(state(), action))
      }
      const View = () => (
        <InboxPanel
          selectionMemory={memory}
          state={state()}
          sessions={sessions()}
          loading={false}
          error=""
          colors={{
            text: "#c0caf5",
            muted: "#737aa2",
            detail: "#545c7e",
            background: "#1f2335",
            hover: "#292e42",
            unread: "#ff9e64",
            attention: "#ff9e64",
            running: "#7aa2f7",
            error: "#f7768e",
          }}
          act={dispatch}
          open={(session) => dispatch({ type: "visit", sessionID: session.id, observed: session.idle })}
          focused
          current={null}
          close={() => {}}
          help={() => {}}
          diagnostics={() => {}}
          keys={(value) => {
            controls = value
          }}
        />
      )
      return (
        <>
          <Show when={mounted()}>
            <View />
          </Show>
          <Show when={replacement()}>
            <View />
          </Show>
        </>
      )
    },
    { width: 60, height },
  )
  await app.renderOnce()
  return {
    app,
    get controls() {
      return controls
    },
    dispatch,
    calls,
    mount,
    replace,
    catalog,
  }
}

test("activation is remembered before the old panel is disposed", async () => {
  const run = await harness(fixture())
  try {
    for (let i = 0; i < 4; i++) run.controls.next()
    run.controls.enter()
    // The destination panel can mount before the old host frame finishes cleanup.
    run.replace(true)
    run.mount(false)
    await run.app.renderOnce()
    run.controls.unread()
    expect(run.calls.at(-1)).toEqual({ type: "unread", sessionID: "b" })
  } finally {
    await run.app.dispose()
  }
})

test("activated session remains anchored while a remounted panel awaits metadata", async () => {
  const input = fixture()
  const run = await harness(input)
  try {
    for (let i = 0; i < 4; i++) run.controls.next()
    run.controls.enter()
    run.mount(false)
    run.catalog([])
    run.mount(true)
    await run.app.renderOnce()
    run.catalog(input.sessions)
    await run.app.renderOnce()
    run.controls.unread()
    expect(run.calls.at(-1)).toEqual({ type: "unread", sessionID: "b" })
  } finally {
    await run.app.dispose()
  }
})

for (const [position, steps, expected] of [
  ["first", 3, "b"],
  ["middle", 4, "c"],
  ["last", 5, "b"],
] as const) {
  test(`removing the ${position} session keeps selection beside it within its project`, async () => {
    const { app, controls, calls } = await harness(fixture())
    try {
      for (let i = 0; i < steps; i++) controls.next()
      controls.remove()
      // Read immediately, without waiting for a paint: rapid repeated keys must be safe too.
      controls.unread()
      expect(calls.at(-1)).toEqual({ type: "unread", sessionID: expected })
    } finally {
      await app.dispose()
    }
  })
}

test("rapid removals select the next survivor, then the previous survivor at the edge", async () => {
  const { app, controls, calls } = await harness(fixture())
  try {
    for (let i = 0; i < 4; i++) controls.next()
    controls.remove()
    controls.remove()
    controls.unread()
    expect(calls.slice(-3)).toEqual([
      { type: "session-remove", sessionID: "b" },
      { type: "session-remove", sessionID: "c" },
      { type: "unread", sessionID: "a" },
    ])
  } finally {
    await app.dispose()
  }
})

test("← folds and → unfolds the highlighted heading, and neither ever toggles", async () => {
  const input = fixture()
  // Rows: Before, before, Work, a, b, Parked, c, Z after, after.
  input.state.sessions.c = { placement: "parked", unread: false }
  const { app, controls, calls } = await harness(input)
  try {
    const folds = () => calls.filter((call) => call.type === "fold")
    for (let i = 0; i < 2; i++) controls.next()
    // Already unfolded: → only ever asks to unfold.
    for (let i = 0; i < 3; i++) controls.fold(false)
    expect(folds()).toEqual(Array(3).fill({ type: "fold", key: "Work", folded: false }))
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("▾ Work/")
    calls.length = 0
    for (let i = 0; i < 3; i++) controls.fold(true)
    expect(folds()).toEqual(Array(3).fill({ type: "fold", key: "Work", folded: true }))
    expect(calls.some((call) => call.type === "collapse")).toBe(false)
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("▸ Work/")
    controls.fold(false)
    await app.renderOnce()
    expect(app.captureCharFrame()).toMatch(/▾ Work\/[^]*Task a[^]*▾ Parked[^]*Task c/)
    // The project's Parked heading folds the same way.
    for (let i = 0; i < 3; i++) controls.next()
    calls.length = 0
    controls.fold(true)
    controls.fold(true)
    expect(folds()).toEqual(Array(2).fill({ type: "fold", key: "parked:Work", folded: true }))
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("▸ Parked · 1")
    expect(app.captureCharFrame()).not.toContain("Task c")
  } finally {
    await app.dispose()
  }
})

test("← and → do nothing on a session row", async () => {
  const { app, controls, calls } = await harness(fixture())
  try {
    for (let i = 0; i < 3; i++) controls.next()
    calls.length = 0
    controls.fold(true)
    controls.fold(false)
    expect(calls).toEqual([])
  } finally {
    await app.dispose()
  }
})

test("the final session falls back to its own project header, not another project", async () => {
  const { app, controls, calls } = await harness(fixture(["a"]))
  try {
    for (let i = 0; i < 3; i++) controls.next()
    controls.remove()
    controls.enter()
    expect(calls.at(-1)).toEqual({ type: "collapse", key: "Work" })
    controls.remove()
    controls.enter()
    expect(calls.at(-1)).toEqual({ type: "collapse", key: "Z after" })
    controls.remove()
    controls.enter()
    expect(calls.at(-1)).toEqual({ type: "collapse", key: "Before" })
  } finally {
    await app.dispose()
  }
})

test("removing a section's final session handles disappearing and flattened group headings", async () => {
  const input = fixture()
  // Rows: Before, before, Work, a, b, Parked, c — removing c also removes the Parked heading.
  input.state.sessions.c = { placement: "parked", unread: false }
  const { app, controls, calls } = await harness(input)
  try {
    for (let i = 0; i < 6; i++) controls.next()
    controls.remove()
    controls.unread()
    expect(calls.at(-1)).toEqual({ type: "unread", sessionID: "b" })
  } finally {
    await app.dispose()
  }
})

test("removing another row above the selector preserves the selected session", async () => {
  const { app, controls, dispatch, calls } = await harness(fixture())
  try {
    for (let i = 0; i < 4; i++) controls.next()
    dispatch({ type: "session-remove", sessionID: "a" })
    controls.unread()
    expect(calls.at(-1)).toEqual({ type: "unread", sessionID: "b" })
  } finally {
    await app.dispose()
  }
})

test("empty lists tolerate navigation and regain a valid selection when reopened", async () => {
  const { app, controls, dispatch, calls } = await harness(fixture(["a"], false))
  try {
    controls.next()
    controls.remove()
    controls.remove()
    calls.length = 0
    controls.previous()
    controls.next()
    controls.enter()
    controls.remove()
    controls.unread()
    expect(calls).toEqual([])
    dispatch({ type: "project-open", project: "Work", name: "Work" })
    controls.enter()
    expect(calls.at(-1)).toEqual({ type: "collapse", key: "Work" })
  } finally {
    await app.dispose()
  }
})

test("selector and scroll position survive the host remounting its panel after navigation", async () => {
  const ids = Array.from({ length: 25 }, (_, index) => `item${String(index).padStart(2, "0")}`)
  const run = await harness(fixture(ids, false), 12)
  try {
    for (let i = 0; i < 24; i++) {
      run.controls.next()
      await run.app.renderOnce()
    }
    run.controls.remove()
    run.mount(false)
    await run.app.renderOnce()
    run.mount(true)
    await run.app.renderOnce()
    await run.app.waitForFrame((text) => text.includes("Task item24"))
    run.controls.unread()
    expect(run.calls.at(-1)).toEqual({ type: "unread", sessionID: "item24" })
    expect(run.app.captureCharFrame()).toContain("Task item24")
    expect(run.app.captureCharFrame()).not.toContain("Task item00")
  } finally {
    await run.app.dispose()
  }
})

for (const mixed of [false, true])
  test(`bottom removal retains the viewport with ${mixed ? "mixed-height" : "single-line"} rows`, async () => {
    const ids = Array.from({ length: 25 }, (_, index) => `item${String(index).padStart(2, "0")}`)
    const input = fixture(ids, false)
    if (mixed)
      input.sessions.forEach((session, index) => {
        if (index % 2) session.detail = `worktree-${index}`
      })
    const { app, controls, calls } = await harness(input, 12)
    try {
      for (let i = 0; i < 25; i++) {
        controls.next()
        await app.renderOnce()
      }
      expect(app.captureCharFrame()).toContain("Task item24")
      controls.remove()
      await app.renderOnce()
      controls.unread()
      expect(calls.at(-1)).toEqual({ type: "unread", sessionID: "item23" })
      expect(app.captureCharFrame()).toContain("Task item23")
      expect(app.captureCharFrame()).not.toContain("Task item00")
    } finally {
      await app.dispose()
    }
  })
