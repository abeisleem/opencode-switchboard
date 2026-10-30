import { test } from "bun:test"
import { createSignal } from "solid-js"
import { testRender } from "@opentui/solid"
import { InboxPanel } from "../src/panel"
import { initialState, type Session, type State } from "../src/model"

function fixture() {
  const sessions: Session[] = []
  const state = initialState()
  for (const project of ["alpha", "beta", "gamma"]) {
    state.projects[project] = { name: project, open: true, sessions: [] }
    for (let i = 0; i < 20; i++) {
      const id = `${project}-${i}`
      sessions.push({
        id,
        title: `A fairly long session title number ${i} for ${project}`,
        project,
        projectName: project,
        directory: `/${project}`,
        detail: i % 3 ? "main" : `/${project}/wt-${i}`,
        idle: 0,
        viewed: 0,
        running: i === 0,
        status: i === 0 ? "Running" : "Idle",
      })
      state.projects[project]!.sessions.push(id)
    }
  }
  return { sessions, state }
}

test("panel update cost (benchmark, not a pass/fail check)", async () => {
  const data = fixture()
  let setSessions!: (s: Session[]) => void
  let setState!: (s: State) => void
  const app = await testRender(
    () => {
      const [sessions, s1] = createSignal(data.sessions)
      const [state, s2] = createSignal(data.state)
      setSessions = s1
      setState = s2
      return (
        <InboxPanel
          state={state()}
          sessions={sessions()}
          loading={false}
          error=""
          focused
          colors={{
            text: "#ffffff",
            muted: "#999999",
            detail: "#777777",
            background: "#000000",
            hover: "#222222",
            unread: "#ff9900",
            attention: "#ff9900",
            running: "#00aaff",
            error: "#ff0000",
          }}
          act={() => {}}
          open={() => {}}
          refresh={() => {}}
          close={() => {}}
          help={() => {}}
          diagnostics={() => {}}
        />
      )
    },
    { width: 50, height: 60 },
  )
  await app.renderOnce()
  const refresh = async (n: number) => {
    let reactive = 0,
      render = 0
    for (let i = 0; i < n; i++) {
      const s = structuredClone(data.sessions),
        st = structuredClone(data.state)
      let t = performance.now()
      setSessions(s)
      setState(st)
      reactive += performance.now() - t
      t = performance.now()
      await app.renderOnce()
      render += performance.now() - t
    }
    console.log(`  reactive ${(reactive / n).toFixed(2)} ms, render ${(render / n).toFixed(2)} ms`)
    return (reactive + render) / n
  }
  const idle = async (n: number) => {
    const t = performance.now()
    for (let i = 0; i < n; i++) await app.renderOnce()
    return (performance.now() - t) / n
  }
  console.log(`refresh (identical data): ${(await refresh(30)).toFixed(2)} ms/update`)
  console.log(`render with no change:    ${(await idle(30)).toFixed(2)} ms/frame`)
  await app.dispose()
})
