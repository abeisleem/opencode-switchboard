// Cost of (re)mounting the panel, which the host does on every session switch (the session.panel slot lives
// inside the per-session frame, as of OpenCode 2.2.5), and of one spinner tick. Test renderer, not a terminal.
// From the measurements in #10. Run with `bun run bench`.
import { test } from "bun:test"
import { createSignal, Show } from "solid-js"
import { testRender } from "@opentui/solid"
import { RGBA } from "@opentui/core"
import { InboxPanel, type Palette } from "../src/panel"
import { initialState, type Session, type State } from "../src/model"

function fixture(projects: number, tracked: number, untracked: number, running = false) {
  const sessions: Session[] = []
  const state = initialState()
  for (let p = 0; p < projects; p++) {
    const project = `project-${p}`
    state.projects[project] = { name: project, open: true, sessions: [] }
    for (let i = 0; i < tracked + untracked; i++) {
      const id = `${project}-${i}`
      sessions.push({
        id,
        title: `A fairly long session title number ${i} for ${project}`,
        project,
        projectName: project,
        directory: `/${project}`,
        detail: i % 4 === 3 ? `/${project}-wt` : "main",
        idle: 1,
        viewed: 1,
        running: running && p === 0 && i === 0,
        status: running && p === 0 && i === 0 ? "Running" : "Ready",
      })
      if (i < tracked) state.projects[project]!.sessions.push(id)
    }
  }
  return { sessions, state }
}

// The host passes RGBA theme colors, never hex strings.
const colors = Object.fromEntries(
  Object.entries({
    text: "#ffffff",
    muted: "#999999",
    detail: "#777777",
    background: "#000000",
    hover: "#222222",
    target: "#223344",
    unread: "#ff9900",
    attention: "#ff9900",
    running: "#00aaff",
    error: "#ff0000",
  }).map(([name, hex]) => [name, RGBA.fromHex(hex)]),
) as Omit<Palette, "menu">
const palette: Palette = {
  ...colors,
  menu: {
    background: RGBA.fromHex("#111111"),
    selected: RGBA.fromHex("#333333"),
    text: RGBA.fromHex("#ffffff"),
    hint: RGBA.fromHex("#999999"),
  },
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!

for (const [label, projects, tracked, untracked] of [
  ["3 projects x 15 tracked (+15 untracked)", 3, 15, 15],
  ["6 projects x 15 tracked (+150 untracked)", 6, 15, 150],
] as const) {
  test(`mount: ${label}`, async () => {
    const data = fixture(projects, tracked, untracked)
    let setShown!: (value: boolean) => void
    const app = await testRender(
      () => {
        const [shown, set] = createSignal(false)
        setShown = set
        return (
          <Show when={shown()}>
            <InboxPanel
              state={data.state}
              sessions={data.sessions}
              loading={false}
              error=""
              focused
              colors={palette}
              act={() => {}}
              open={() => {}}
              current={null}
              close={() => {}}
              help={() => {}}
              diagnostics={() => {}}
            />
          </Show>
        )
      },
      { width: 60, height: 45 },
    )
    await app.renderOnce()
    // Warm up the JIT, so the first case is not slower for running first.
    for (let i = 0; i < 20; i++) {
      setShown(true)
      await app.renderOnce()
      setShown(false)
      await app.renderOnce()
    }
    const mount: number[] = []
    const solid: number[] = []
    for (let i = 0; i < 15; i++) {
      const t = performance.now()
      setShown(true)
      solid.push(performance.now() - t)
      await app.renderOnce()
      mount.push(performance.now() - t)
      setShown(false)
      await app.renderOnce()
    }
    console.log(
      `  ${label}: mount + first frame median ${median(mount).toFixed(1)} ms (min ${Math.min(...mount).toFixed(1)}, max ${Math.max(...mount).toFixed(1)}, n=${mount.length}); Solid mount alone ${median(solid).toFixed(1)} ms`,
    )
    app.renderer.destroy()
  })
}

test("spinner tick: one running row", async () => {
  const data = fixture(3, 15, 15, true)
  const app = await testRender(
    () => (
      <InboxPanel
        state={data.state}
        sessions={data.sessions}
        loading={false}
        error=""
        focused
        colors={palette}
        act={() => {}}
        open={() => {}}
        current={null}
        close={() => {}}
        help={() => {}}
        diagnostics={() => {}}
      />
    ),
    { width: 60, height: 45 },
  )
  await app.renderOnce()
  // Let the 80 ms spinner interval fire, then time the frame it requests.
  const frames: number[] = []
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 85))
    const t = performance.now()
    await app.renderOnce()
    frames.push(performance.now() - t)
  }
  console.log(
    `  spinner frame (test renderer): median ${median(frames).toFixed(2)} ms per tick, ticks/s 12.5`,
  )
  app.renderer.destroy()
})
