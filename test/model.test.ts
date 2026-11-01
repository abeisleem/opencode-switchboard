import { expect, test } from "bun:test"
import {
  actionSchema,
  initialState,
  parkedKey,
  reduce,
  rows,
  unread,
  stateSchema,
  workingSet,
  type Session,
} from "../src/model"
import { createInboxStore } from "../src/store"
import { createClientState, defaultClientState, readClientState } from "../src/client"
import { readState, steps } from "../src/migrate"
import { createSessionHistory, fallbackSession, recordShown } from "../src/selection"

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

/** `openState()` with the shared-selection fields that versions 1 to 3 required. */
function legacyState() {
  return { ...openState(), navigation: 0, selected: null, recent: [] as string[] }
}

test("all unread/placement combinations are independent, including never-run sessions", () => {
  for (const place of ["active", "parked"] as const) {
    let state = reduce(initialState(), { type: "place", sessionID: "b", placement: place })
    state = reduce(state, { type: "unread", sessionID: "b" })
    expect(unread({ ...session, idle: 0 }, state)).toBe(true)
    state = reduce(state, { type: "read", sessionID: "b", observed: 10 })
    expect(state.sessions.b?.placement).toBe(place)
    expect(unread(session, state)).toBe(false)
  }
})

test("a project without parked sessions has no redundant subgroup", () => {
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
    state = reduce(state, { type: "place", sessionID: item.id, placement: "parked" })
  state = reduce(state, { type: "collapse", key: parkedKey("p") })
  // A folded Parked stays quiet; its sessions still count toward the folded project.
  expect(rows(sessions, state)[1]).toMatchObject({ title: "Parked · 2", badges: [] })
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

test("closing a project hides it without losing membership, unread or parked sessions", () => {
  let state = reduce(openState(), { type: "place", sessionID: "b", placement: "parked" })
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
    { type: "visit", sessionID: "b", observed: 10 },
    { project: "p", name: "Project", sessions: ["b"] },
  )
  expect(workingSet([session], state)).toEqual([session])
})

test("closing a project or removing a session changes only shared data, never a selection", () => {
  let state = reduce(openState(), { type: "visit", sessionID: "b", observed: 0 })
  state = reduce(state, { type: "session-remove", sessionID: "b" })
  expect(state.projects.p?.sessions).toEqual(["a"])
  state = reduce(state, { type: "project-close", project: "p" })
  expect(state.projects.p).toEqual({ name: "Project", open: false, sessions: ["a"] })
  expect(Object.keys(state).sort()).toEqual(["collapsed", "projects", "revision", "sessions", "version"])
})

test("a visit marks the session read and admits it without recording a selection", () => {
  let state = reduce(openState(), { type: "unread", sessionID: "c" })
  state = reduce(
    state,
    { type: "visit", sessionID: "c", observed: 7 },
    { project: "p", name: "Project", sessions: ["c"] },
  )
  expect(state.sessions.c).toEqual({ placement: "active", unread: false, seen: 7 })
  expect(state.projects.p?.sessions).toEqual(["c", "a", "b"])
  expect(state).not.toHaveProperty("selected")
  expect(state).not.toHaveProperty("recent")
  expect(state).not.toHaveProperty("navigation")
})

test("the visit action still accepts select from older TUIs and hands the server a visit", () => {
  const action = actionSchema.parse({ type: "select", sessionID: "b", observed: 3 })
  expect(action).toEqual({ type: "visit", sessionID: "b", observed: 3 })
  expect(actionSchema.parse({ type: "visit", sessionID: "b", observed: 3 })).toEqual(action)
  expect(reduce(openState(), action).sessions.b).toEqual({ placement: "active", unread: false, seen: 3 })
  expect(() => actionSchema.parse({ type: "select", sessionID: "b", observed: -1 })).toThrow()
})

test("closing the current project falls back to an open session in another project, else nowhere", () => {
  let state = openState()
  state.projects.other = { name: "Other", open: true, sessions: ["c"] }
  state = reduce(state, { type: "project-close", project: "p" })
  expect(fallbackSession(state, ["b", "a"], "b")).toBe("c")
  state = reduce(state, { type: "project-close", project: "other" })
  expect(fallbackSession(state, ["c", "b", "a"], "c")).toBeNull()
})

test("closing the current session uses an open member when recent history has no survivor", () => {
  const state = reduce(openState(), { type: "session-remove", sessionID: "b" })
  expect(fallbackSession(state, ["b"], "b")).toBe("a")
  expect(
    fallbackSession(reduce(state, { type: "session-remove", sessionID: "a" }), ["a", "b"], "a"),
  ).toBeNull()
})

test("close fallback prefers recent open members over roster order and skips closed projects", () => {
  let state = openState()
  state.projects.other = { name: "Other", open: true, sessions: ["c", "d"] }
  state.projects.closed = { name: "Closed", open: false, sessions: ["hidden"] }
  state = reduce(state, { type: "session-remove", sessionID: "b" })
  expect(fallbackSession(state, ["b", "hidden", "removed", "d", "a", "c"], "b")).toBe("d")
  // The closed session is never its own fallback, even while its removal is still in flight.
  expect(fallbackSession(openState(), ["b", "a"], "b")).toBe("a")
})

test("closing a session's row unparks it, so it comes back unparked with its unread mark", () => {
  let state = reduce(openState(), { type: "place", sessionID: "b", placement: "parked" })
  state = reduce(state, { type: "read", sessionID: "b", observed: 4 })
  state = reduce(state, { type: "unread", sessionID: "b" })
  state = reduce(state, { type: "session-remove", sessionID: "b" })
  expect(state.sessions.b).toEqual({ placement: "active", unread: true, seen: 4 })
  expect(state.projects.p?.sessions).toEqual(["a"])
  // Opening it again (any visit or place admission) lists it unparked.
  state = reduce(
    state,
    { type: "visit", sessionID: "b", observed: 2 },
    { project: "p", name: "Project", sessions: ["b"] },
  )
  expect(state.projects.p?.sessions).toEqual(["b", "a"])
  expect(state.sessions.b).toEqual({ placement: "active", unread: false, seen: 4 })
  expect(shape([session, { ...session, id: "a" }], state)).toEqual([
    ["Project", 0],
    ["b", 1],
    ["a", 1],
  ])
  // Removing a session the switchboard never organized records nothing for it.
  expect(reduce(openState(), { type: "session-remove", sessionID: "a" }).sessions).toEqual({})
})

test("closing a project keeps its parked sessions parked for when it reopens", () => {
  let state = reduce(openState(), { type: "place", sessionID: "b", placement: "parked" })
  state = reduce(state, { type: "unread", sessionID: "b" })
  state = reduce(state, { type: "project-close", project: "p" })
  expect(state.sessions.b).toEqual({ placement: "parked", unread: true })
  state = reduce(state, { type: "project-open", project: "p", name: "Project" })
  expect(state.sessions.b).toEqual({ placement: "parked", unread: true })
  expect(shape([{ ...session, id: "a" }, session], state)).toEqual([
    ["Project", 0],
    ["a", 1],
    ["Parked", 1],
    ["b", 2],
  ])
})

test("this TUI's history is bounded, newest first, and moves a revisited session to the front", () => {
  const history = createSessionHistory()
  for (let index = 0; index < 60; index++) recordShown(history, `s${index}`)
  recordShown(history, "s30")
  expect(history.current).toBe("s30")
  expect(history.recent).toHaveLength(50)
  expect(history.recent.slice(0, 3)).toEqual(["s30", "s59", "s58"])
  expect(history.recent.filter((id) => id === "s30")).toHaveLength(1)
})

test("older saved state loads without turning on every project", () => {
  const { projects, ...old } = openState()
  expect(stateSchema.parse(old).projects).toEqual({})
  expect(rows([session], stateSchema.parse(old))).toEqual([])
})

test("a session moved to another project is not retained as a member of both", () => {
  let state = reduce(
    openState(),
    { type: "visit", sessionID: "b", observed: 0 },
    { project: "destination", name: "Destination", sessions: ["b"] },
  )
  expect(state.projects.p?.sessions).toEqual(["a"])
  expect(state.projects.destination?.sessions).toEqual(["b"])
})

test("newly admitted sessions come first; revisiting a member never reorders it", () => {
  let state = reduce(
    openState(),
    { type: "visit", sessionID: "c", observed: 0 },
    { project: "p", name: "Project", sessions: ["c"] },
  )
  expect(state.projects.p?.sessions).toEqual(["c", "a", "b"])
  state = reduce(
    state,
    { type: "visit", sessionID: "b", observed: 0 },
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

const shape = (sessions: Session[], state: ReturnType<typeof openState>) =>
  rows(sessions, state).map((row) => [row.kind === "heading" ? row.title : row.session.id, row.depth])

test("unparked sessions sit under the project; Parked is one fold after them", () => {
  let state = reduce(openState(), { type: "place", sessionID: "b", placement: "parked" })
  const sessions = [{ ...session, id: "a" }, session]
  expect(shape(sessions, state)).toEqual([
    ["Project", 0],
    ["a", 1],
    ["Parked", 1],
    ["b", 2],
  ])
  state = reduce(state, { type: "collapse", key: parkedKey("p") })
  expect(shape(sessions, state)).toEqual([
    ["Project", 0],
    ["a", 1],
    ["Parked · 1", 1],
  ])
})

test("parking and unparking keeps unread and membership", () => {
  let state = reduce(openState(), { type: "unread", sessionID: "b" })
  state = reduce(state, { type: "place", sessionID: "b", placement: "parked" })
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

test("opening a session starts a new project with only that session and unfolds its Parked fold", () => {
  let state = reduce(openState(), { type: "place", sessionID: "b", placement: "parked" })
  state = reduce(state, { type: "collapse", key: parkedKey("p") })
  state = reduce(
    state,
    { type: "visit", sessionID: "b", observed: 0 },
    { project: "p", name: "Project", sessions: ["b"] },
  )
  expect(state.collapsed).not.toContain(parkedKey("p"))
  state = reduce(
    state,
    { type: "visit", sessionID: "n", observed: 0 },
    { project: "new", name: "New", sessions: ["n"] },
  )
  expect(state.projects.new?.sessions).toEqual(["n"])
})

test("switching between unparked sessions leaves the project's folded Parked folded", () => {
  let state = reduce(
    initialState(),
    { type: "project-open", project: "p", name: "Project" },
    { project: "p", name: "Project", sessions: ["a", "b", "c"] },
  )
  state = reduce(state, { type: "place", sessionID: "c", placement: "parked" })
  state = reduce(state, { type: "collapse", key: parkedKey("p") })
  // The server attaches an admission to every select, parked or not.
  for (const id of ["a", "b"])
    state = reduce(
      state,
      { type: "visit", sessionID: id, observed: 0 },
      { project: "p", name: "Project", sessions: [id] },
    )
  expect(state.collapsed).toContain(parkedKey("p"))
})

test("fold sets a heading's state instead of toggling it, and a repeat changes nothing", () => {
  const start = openState()
  let state = reduce(start, { type: "fold", key: "p", folded: true })
  const folded = state
  state = reduce(state, { type: "fold", key: "p", folded: true })
  expect(state.collapsed).toEqual(["p"])
  // A no-op returns the same state, so the store skips the write and the revision stays put.
  expect(state).toBe(folded)
  state = reduce(state, { type: "fold", key: parkedKey("p"), folded: true })
  state = reduce(state, { type: "fold", key: "p", folded: false })
  expect(state.collapsed).toEqual([parkedKey("p")])
  const unfolded = reduce(start, { type: "fold", key: "p", folded: false })
  expect(unfolded).toBe(start)
  expect(unfolded.collapsed).toEqual([])
})

test("the store does not save an action that changes nothing", async () => {
  let saved: unknown = reduce(openState(), { type: "fold", key: "p", folded: true })
  let writes = 0
  const store = createInboxStore({
    get: async () => saved,
    set: async (_key, value) => {
      writes++
      saved = value
    },
  })
  const before = (await store.snapshot()).revision
  await store.act({ type: "fold", key: "p", folded: true })
  expect(writes).toBe(0)
  await store.act({ type: "fold", key: "p", folded: false })
  expect(writes).toBe(1)
  expect((await store.snapshot()).revision).toBe(before + 1)
  expect((await store.snapshot()).collapsed).toEqual([])
})

test("version 1 and 2 state migrates: History closes, Focus becomes Active, filters drop", () => {
  const legacy = (version: number, placement: string) => ({
    ...legacyState(),
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
  expect(fromFocus.version).toBe(4)
  expect(fromFocus.projects.p?.sessions).toEqual(["a", "b"])
  expect(fromFocus.sessions.b?.placement).toBe("active")
  expect(fromFocus.sessions.a?.placement).toBe("parked")
  expect(fromFocus.collapsed).toEqual(["parked:p"])
  expect(fromFocus).not.toHaveProperty("view")
  expect(fromFocus).not.toHaveProperty("query")
  expect(readState(fromFocus)).toEqual(fromFocus)
})

test("step 2 → 3 keeps Later and its fold, retires the other placements' folds", () => {
  const step = steps.find((candidate) => candidate.from === 2)!
  const v2 = {
    ...legacyState(),
    version: 2,
    collapsed: ["p", "p/history", "p/focus", "p/active", "p/later"],
    sessions: { a: { placement: "later" }, b: { placement: "focus", unread: true } },
  }
  expect(step.up(step.schema.parse(v2) as never)).toEqual({
    ...legacyState(),
    version: 3,
    collapsed: ["p", "p/later"],
    sessions: { a: { placement: "later", unread: false }, b: { placement: "active", unread: true } },
  })
})

/** Version 3 state, as 0.1.4 saved it. */
function v3State() {
  return {
    ...legacyState(),
    version: 3,
    navigation: 4,
    selected: "b",
    recent: ["b", "a"],
    projects: {
      p: { name: "Project", open: true, sessions: ["a", "b"] },
      "/home/notes": { name: "notes", open: false, sessions: ["c"] },
    },
    collapsed: ["p", "p/later", "/home/notes/later", "x/later", "/home/notes"],
    sessions: {
      a: { placement: "later", unread: true, seen: 3 },
      b: { placement: "active", unread: false },
      c: { placement: "later", unread: false, seen: 1 },
    },
  }
}

test("step 3 → 4 renames Later to Parked, moves only saved projects' Later folds, and drops the selection", () => {
  const step = steps.find((candidate) => candidate.from === 3)!
  expect(step.to).toBe(4)
  const migrated = step.up(step.schema.parse(v3State()) as never)
  // The current session became per TUI (#52): the shared selection, its history, and its counter go.
  const { selected: _selected, recent: _recent, navigation: _navigation, ...kept } = v3State()
  expect(migrated).toEqual({
    ...kept,
    version: 4,
    // A project fold keeps its key; "x/later" names no saved project, so it is left alone.
    collapsed: ["p", "parked:p", "parked:/home/notes", "x/later", "/home/notes"],
    sessions: {
      a: { placement: "parked", unread: true, seen: 3 },
      b: { placement: "active", unread: false },
      c: { placement: "parked", unread: false, seen: 1 },
    },
  })
  expect(readState(v3State())).toEqual(stateSchema.parse(migrated))
})

test("step 3 → 4 unparks a Later session no project lists, keeping its unread mark and seen time", () => {
  // d was closed while it sat in Later; a stays listed in an open project, c in a closed one.
  const v3 = {
    ...v3State(),
    sessions: { ...v3State().sessions, d: { placement: "later", unread: true, seen: 9 } },
  }
  const migrated = readState(v3)
  expect(migrated.sessions.d).toEqual({ placement: "active", unread: true, seen: 9 })
  expect(migrated.sessions.a).toEqual({ placement: "parked", unread: true, seen: 3 })
  expect(migrated.sessions.c).toEqual({ placement: "parked", unread: false, seen: 1 })
  expect(migrated.projects).toEqual(v3.projects)
})

test("version 1 state migrates through every step to the current version without losing organization", () => {
  const v1 = {
    version: 1,
    revision: 7,
    navigation: 2,
    selected: "a",
    recent: ["a", "b"],
    collapsed: ["q", "p/later", "p/history"],
    projects: {
      p: { name: "Project", open: true, sessions: ["a", "b", "c"] },
      q: { name: "Q", open: false, sessions: ["d"] },
    },
    sessions: {
      a: { placement: "focus", unread: true, seen: 4 },
      b: { placement: "later", unread: false, seen: 2 },
      c: { placement: "history", unread: true },
      d: { placement: "active", unread: true },
    },
  }
  const migrated = readState(v1)
  expect(migrated).toEqual({
    version: 4,
    revision: 7,
    collapsed: ["q", "parked:p"],
    projects: {
      // History closes membership; everything else, open or closed, is kept.
      p: { name: "Project", open: true, sessions: ["a", "b"] },
      q: { name: "Q", open: false, sessions: ["d"] },
    },
    sessions: {
      a: { placement: "active", unread: true, seen: 4 },
      b: { placement: "parked", unread: false, seen: 2 },
      c: { placement: "active", unread: true },
      d: { placement: "active", unread: true },
    },
  })
})

test("reading state is idempotent from every saved version", () => {
  const saved = [
    { ...legacyState(), version: 1, sessions: { b: { placement: "history" } } },
    { ...legacyState(), version: 2, collapsed: ["p/later"], sessions: { b: { placement: "later" } } },
    v3State(),
    reduce(openState(), { type: "place", sessionID: "b", placement: "parked" }),
  ]
  for (const value of saved) expect(readState(readState(value))).toEqual(readState(value))
})

test("the place action still accepts Later from older TUIs and stores it as parked", () => {
  const action = actionSchema.parse({ type: "place", sessionID: "b", placement: "later" })
  expect(action).toEqual({ type: "place", sessionID: "b", placement: "parked" })
  expect(reduce(openState(), action).sessions.b?.placement).toBe("parked")
  expect(() => actionSchema.parse({ type: "place", sessionID: "b", placement: "focus" })).toThrow()
})

test("migration does not close the currently viewed legacy History session", () => {
  const migrated = readState({
    ...legacyState(),
    version: 1,
    selected: "b",
    sessions: { b: { placement: "history", unread: true } },
  })
  expect(migrated.projects.p?.sessions).toContain("b")
  expect(migrated.sessions.b).toEqual({ placement: "active", unread: true })
})

test("version 4 state saved before the selection became per TUI still loads, without it", () => {
  // Unreleased builds of 0.2.0 saved version 4 with the shared selection; the object schema strips it.
  const saved = { ...openState(), navigation: 3, selected: "b", recent: ["b", "a"] }
  const state = readState(saved)
  expect(state).toEqual(openState())
  expect(state).not.toHaveProperty("selected")
  expect(readState(state)).toEqual(state)
})

test("the migration steps form one chain that ends at the current version", () => {
  expect(steps.map((step) => [step.from, step.to])).toEqual(steps.map((_, index) => [index + 1, index + 2]))
  expect(steps.at(-1)?.to).toBe(stateSchema.shape.version.value)
})

test("step 1 → 2 only renumbers, stripping retired fields", () => {
  const [step] = steps
  const v1 = { ...legacyState(), version: 1, keepSelected: true, sessions: { b: { placement: "history" } } }
  expect(step!.up(step!.schema.parse(v1) as never)).toEqual({
    ...legacyState(),
    version: 2,
    sessions: { b: { placement: "history", unread: false } },
  })
})

test("a saved version newer than this release fails and names both versions", () => {
  const current = stateSchema.shape.version.value
  expect(() => readState({ ...openState(), version: current + 1 })).toThrow(
    `Saved switchboard state is version ${current + 1}; this release reads up to ${current}. Update opencode-switchboard.`,
  )
})

test("a version without a migration step, or no version, fails instead of resetting", () => {
  expect(() => readState({ ...openState(), version: 0 })).toThrow("version 0, which has no migration")
  expect(() => readState({ ...openState(), version: undefined })).toThrow("no version")
  expect(() => readState(null)).toThrow("no version")
})

test("client state reads a missing, corrupt, or foreign saved default as the defaults", () => {
  const defaults = defaultClientState()
  for (const saved of [undefined, null, "projects", 42, [], {}, { version: 1 }, { view: 7 }])
    expect(readClientState(saved)).toEqual(defaults)
  // A view this release does not know, e.g. saved by a newer release, falls back to the projects view.
  expect(readClientState({ version: 1, view: "board" })).toEqual(defaults)
  // Unknown keys are ignored; a known value is kept.
  expect(readClientState({ version: 1, view: "projects", sort: "recent", future: { a: 1 } })).toEqual(
    defaults,
  )
  // A breaking version this release does not know yields the defaults rather than a misread.
  expect(readClientState({ version: 2, view: "projects" })).toEqual(defaults)
})

test("client state reads the saved default once, keeps the view in memory, and saves only a change", async () => {
  let file: Record<string, unknown> = { version: 1, view: "projects", future: true }
  const memories = new Map<string, unknown>()
  let writes = 0
  const storage = {
    store: <Value extends object>(_key: string, _options: { readonly initial: Value }) =>
      [
        file as Value,
        async (mutation: (draft: Value) => void) => {
          const draft = structuredClone(file) as Value
          mutation(draft)
          file = draft as Record<string, unknown>
          writes++
        },
      ] as const,
    memory: <Value extends object>(key: string, options: { readonly initial: Value }) => {
      if (!memories.has(key)) memories.set(key, options.initial)
      const value = memories.get(key) as Value
      return [value, (mutation: (draft: Value) => void) => mutation(value)] as const
    },
  }
  const client = createClientState(storage)
  expect(client.state).toEqual({ version: 1, view: "projects" })
  await client.setView("projects")
  expect(writes).toBe(0)
  // Another TUI on this machine saves a different default; this TUI, even after a plugin reload, keeps its own.
  file = { version: 1, view: "board" }
  expect(createClientState(storage).state.view).toBe("projects")
  // Saving keeps keys a newer release wrote.
  file = { version: 1, view: "projects", future: true }
  memories.set("client", { state: { version: 1, view: "board" } })
  await createClientState(storage).setView("projects")
  expect(writes).toBe(1)
  expect(file).toEqual({ version: 1, view: "projects", future: true })
})
