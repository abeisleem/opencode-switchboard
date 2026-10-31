import { expect, test } from "bun:test"
import {
  initialState,
  laterKey,
  reduce,
  rows,
  unread,
  stateSchema,
  workingSet,
  type Session,
} from "../src/model"
import { createInboxStore } from "../src/store"
import { readState } from "../src/migrate"
import { followRoute } from "../src/selection"

const session: Session = {
  id: "b",
  title: "B",
  project: "p",
  projectName: "Project",
  directory: "/p",
  detail: "main",
  idle: 10,
  viewed: 0,
  running: false,
  status: "Ready",
}

function openState() {
  return reduce(
    initialState(),
    { type: "project-open", project: "p", name: "Project" },
    { project: "p", name: "Project", sessions: ["a", "b"] },
  )
}

test("all unread/placement combinations are independent, including never-run sessions", () => {
  for (const place of ["active", "later"] as const) {
    let state = reduce(initialState(), { type: "place", sessionID: "b", placement: place })
    state = reduce(state, { type: "unread", sessionID: "b" })
    expect(unread({ ...session, idle: 0 }, state)).toBe(true)
    state = reduce(state, { type: "read", sessionID: "b", observed: 10 })
    expect(state.sessions.b?.placement).toBe(place)
    expect(unread(session, state)).toBe(false)
  }
})

test("a project containing only Active sessions has no redundant subgroup", () => {
  const result = rows([session], openState())
  expect(result).toHaveLength(2)
  expect(result[0]).toMatchObject({ kind: "heading", title: "Project", depth: 0 })
  expect(result[1]).toMatchObject({ kind: "session", depth: 1 })
})

test("collapsed headings expose activity counts alongside attention and unread counts", () => {
  const sessions = [
    { ...session, id: "a", running: true, status: "Running" as const, idle: 0 },
    { ...session, status: "Question" as const },
  ]
  let state = reduce(openState(), { type: "collapse", key: "p" })
  const badges = [
    { kind: "attention", count: 1 },
    { kind: "running", count: 1 },
    { kind: "unread", count: 1 },
  ]
  expect(rows(sessions, state)[0]).toMatchObject({ badges })
  state = reduce(state, { type: "collapse", key: "p" })
  expect(rows(sessions, state)[0]).toMatchObject({ badges: [] })
  for (const item of sessions)
    state = reduce(state, { type: "place", sessionID: item.id, placement: "later" })
  state = reduce(state, { type: "collapse", key: laterKey("p") })
  // A folded Later stays quiet; its sessions still count toward the folded project.
  expect(rows(sessions, state)[1]).toMatchObject({ title: "Later · 2", badges: [] })
  state = reduce(state, { type: "collapse", key: "p" })
  expect(rows(sessions, state)[0]).toMatchObject({ badges })
})

test("collapsed groups count queued sessions as activity like session-row spinners", () => {
  const state = reduce(openState(), { type: "collapse", key: "p" })
  expect(rows([{ ...session, running: false, status: "Queued", idle: 0 }], state)[0]).toMatchObject({
    badges: [{ kind: "running", count: 1 }],
  })
})

test("invalid persisted state fails visibly rather than resetting user organization", async () => {
  const store = createInboxStore({
    get: async () => ({ version: 99 }),
    set: async () => {
      throw new Error("must not write")
    },
  })
  await expect(store.snapshot()).rejects.toThrow()
})

test("closing a project hides it without losing membership, unread or Later", () => {
  let state = reduce(openState(), { type: "place", sessionID: "b", placement: "later" })
  state = reduce(state, { type: "unread", sessionID: "b" })
  const before = structuredClone(state.sessions)
  state = reduce(state, { type: "project-close", project: "p" })
  expect(rows([session], state)).toEqual([])
  expect(state.projects.p?.sessions).toEqual(["a", "b"])
  state = reduce(state, { type: "project-open", project: "p", name: "Project" })
  expect(state.sessions).toEqual(before)
  expect(rows([session], state).some((row) => row.kind === "session")).toBe(true)
  expect(workingSet([session, { ...session, id: "a" }], state).map((s) => s.id)).toEqual(["a", "b"])
})

test("removed sessions stay removed after project reopening, but explicit navigation restores them", () => {
  let state = reduce(openState(), { type: "session-remove", sessionID: "b" })
  state = reduce(state, { type: "project-close", project: "p" })
  state = reduce(state, { type: "project-open", project: "p", name: "Project" })
  expect(workingSet([session], state)).toEqual([])
  state = reduce(state, { type: "project-close", project: "p" })
  state = reduce(
    state,
    { type: "select", sessionID: "b", observed: 10 },
    { project: "p", name: "Project", sessions: ["b"] },
  )
  expect(workingSet([session], state)).toEqual([session])
})

test("closing the selected project chooses an open project instead of reopening a closed one", () => {
  let state = openState()
  state = reduce(
    state,
    { type: "select", sessionID: "c", observed: 0 },
    { project: "other", name: "Other", sessions: ["c"] },
  )
  state = reduce(state, { type: "select", sessionID: "b", observed: 0 })
  state = reduce(state, { type: "project-close", project: "p" })
  expect(state.selected).toBe("c")
  state = reduce(state, { type: "project-close", project: "other" })
  expect(state.selected).toBeNull()
  expect(state.projects.p?.open).toBe(false)
})

test("closing the current session uses an open member when recent history has no survivor", () => {
  let state = reduce(openState(), { type: "select", sessionID: "b", observed: 0 })
  state = reduce(state, { type: "session-remove", sessionID: "b" })
  expect(state.selected).toBe("a")
  expect(state.recent[0]).toBe("a")
  state = reduce(state, { type: "session-remove", sessionID: "a" })
  expect(state.selected).toBeNull()
})

test("close fallback prefers recent open members over roster order and skips closed projects", () => {
  let state = openState()
  state.projects.other = { name: "Other", open: true, sessions: ["c", "d"] }
  state.projects.closed = { name: "Closed", open: false, sessions: ["hidden"] }
  state.recent = ["b", "hidden", "removed", "d", "a", "c"]
  state.selected = "b"
  state = reduce(state, { type: "session-remove", sessionID: "b" })
  expect(state.selected).toBe("d")
  expect(state.projects.closed?.open).toBe(false)
  const navigation = state.navigation
  state = reduce(state, { type: "session-remove", sessionID: "a" })
  expect(state.selected).toBe("d")
  expect(state.navigation).toBe(navigation)
})

test("closing a selected project falls back to an open member outside recent history", () => {
  let state = reduce(openState(), { type: "select", sessionID: "b", observed: 0 })
  state.projects.other = { name: "Other", open: true, sessions: ["c"] }
  state = reduce(state, { type: "project-close", project: "p" })
  expect(state.selected).toBe("c")
  expect(state.projects.p?.sessions).toEqual(["a", "b"])
})

test("fallback to a member outside the bounded history keeps history bounded", () => {
  let state = reduce(openState(), { type: "select", sessionID: "b", observed: 0 })
  state.recent = ["b", ...Array.from({ length: 49 }, (_, index) => `closed-${index}`)]
  state = reduce(state, { type: "session-remove", sessionID: "b" })
  expect(state.selected).toBe("a")
  expect(state.recent[0]).toBe("a")
  expect(state.recent).toHaveLength(50)
})

test("older saved state loads without turning on every project", () => {
  const { projects, ...old } = openState()
  expect(stateSchema.parse(old).projects).toEqual({})
  expect(rows([session], stateSchema.parse(old))).toEqual([])
})

test("a session moved to another project is not retained as a member of both", () => {
  let state = reduce(
    openState(),
    { type: "select", sessionID: "b", observed: 0 },
    { project: "destination", name: "Destination", sessions: ["b"] },
  )
  expect(state.projects.p?.sessions).toEqual(["a"])
  state = reduce(state, { type: "project-close", project: "p" })
  expect(state.selected).toBe("b")
})

test("newly admitted sessions come first; revisiting a member never reorders it", () => {
  let state = reduce(
    openState(),
    { type: "select", sessionID: "c", observed: 0 },
    { project: "p", name: "Project", sessions: ["c"] },
  )
  expect(state.projects.p?.sessions).toEqual(["c", "a", "b"])
  state = reduce(
    state,
    { type: "select", sessionID: "b", observed: 0 },
    { project: "p", name: "Project", sessions: ["b"] },
  )
  expect(state.projects.p?.sessions).toEqual(["c", "a", "b"])
})

test("a native view acknowledgment reads a completion but never a manual unread mark", () => {
  let state = reduce(initialState(), { type: "read", sessionID: "b", observed: 5 })
  // The conversation was on screen when its run finished.
  expect(unread({ ...session, viewed: 10 }, state)).toBe(false)
  state = reduce(state, { type: "unread", sessionID: "b" })
  expect(unread({ ...session, viewed: 10 }, state)).toBe(true)
})

test("shared selection is followed without leaving its conversation family", () => {
  const root = (id: string) => (id === "child" ? "b" : id)
  expect(followRoute({ type: "session", sessionID: "child" }, "b", root)).toBeUndefined()
  expect(followRoute({ type: "session", sessionID: "b" }, "b", root)).toBeUndefined()
  expect(followRoute({ type: "home" }, null, root)).toBeUndefined()
  expect(followRoute({ type: "session", sessionID: "child" }, "a", root)).toEqual({
    type: "session",
    sessionID: "a",
  })
  expect(followRoute({ type: "plugin", id: "opencode-switchboard", name: "inbox" }, "a", root)).toEqual({
    type: "session",
    sessionID: "a",
  })
  expect(followRoute({ type: "session", sessionID: "b" }, null, root)).toEqual({ type: "home" })
})

const shape = (sessions: Session[], state: ReturnType<typeof openState>) =>
  rows(sessions, state).map((row) => [row.kind === "heading" ? row.title : row.session.id, row.depth])

test("Active sessions sit under the project; Later is one fold after them", () => {
  let state = reduce(openState(), { type: "place", sessionID: "b", placement: "later" })
  const sessions = [{ ...session, id: "a" }, session]
  expect(shape(sessions, state)).toEqual([
    ["Project", 0],
    ["a", 1],
    ["Later", 1],
    ["b", 2],
  ])
  state = reduce(state, { type: "collapse", key: laterKey("p") })
  expect(shape(sessions, state)).toEqual([
    ["Project", 0],
    ["a", 1],
    ["Later · 1", 1],
  ])
})

test("moving between Active and Later keeps unread and membership", () => {
  let state = reduce(openState(), { type: "unread", sessionID: "b" })
  state = reduce(state, { type: "place", sessionID: "b", placement: "later" })
  state = reduce(state, { type: "place", sessionID: "b", placement: "active" })
  expect(state.sessions.b).toEqual({ placement: "active", unread: true })
  expect(state.projects.p?.sessions).toEqual(["a", "b"])
})

test("a newly opened project is empty and still shows its heading", () => {
  const state = reduce(
    initialState(),
    { type: "project-open", project: "q", name: "Q" },
    { project: "q", name: "Q", sessions: [] },
  )
  expect(state.projects.q).toEqual({ name: "Q", open: true, sessions: [] })
  expect(shape([], state)).toEqual([["Q", 0]])
})

test("opening a session starts a new project with only that session and unfolds its Later", () => {
  let state = reduce(openState(), { type: "place", sessionID: "b", placement: "later" })
  state = reduce(state, { type: "collapse", key: laterKey("p") })
  state = reduce(
    state,
    { type: "select", sessionID: "b", observed: 0 },
    { project: "p", name: "Project", sessions: ["b"] },
  )
  expect(state.collapsed).not.toContain(laterKey("p"))
  state = reduce(
    state,
    { type: "select", sessionID: "n", observed: 0 },
    { project: "new", name: "New", sessions: ["n"] },
  )
  expect(state.projects.new?.sessions).toEqual(["n"])
})

test("version 1 and 2 state migrates: History closes, Focus becomes Active, filters drop", () => {
  const legacy = (version: number, placement: string) => ({
    ...openState(),
    version,
    keepSelected: true,
    query: "x",
    project: "p",
    view: "running",
    selected: null,
    collapsed: ["p/history", "p/focus", "p/later"],
    sessions: { b: { placement, unread: true, seen: 5 }, a: { placement: "later", unread: false } },
  })
  const fromHistory = readState(legacy(1, "history"))
  expect(fromHistory.projects.p?.sessions).toEqual(["a"])
  expect(fromHistory.sessions.b).toEqual({ placement: "active", unread: true, seen: 5 })
  const fromFocus = readState(legacy(2, "focus"))
  expect(fromFocus.version).toBe(3)
  expect(fromFocus.projects.p?.sessions).toEqual(["a", "b"])
  expect(fromFocus.sessions.b?.placement).toBe("active")
  expect(fromFocus.sessions.a?.placement).toBe("later")
  expect(fromFocus.collapsed).toEqual(["p/later"])
  expect(fromFocus).not.toHaveProperty("view")
  expect(fromFocus).not.toHaveProperty("query")
  expect(readState(fromFocus)).toEqual(fromFocus)
})

test("migration does not close the currently viewed legacy History session", () => {
  const migrated = readState({
    ...openState(),
    version: 1,
    selected: "b",
    sessions: { b: { placement: "history", unread: true } },
  })
  expect(migrated.projects.p?.sessions).toContain("b")
  expect(migrated.sessions.b).toEqual({ placement: "active", unread: true })
})
