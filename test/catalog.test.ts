import { expect, test } from "bun:test"
import type { OpenCodeClient } from "@opencode/client"
import { loadCatalog, type CatalogMemory, type RootCounts } from "../src/catalog"
import { readCatalog } from "../src/sessions"
import { initialState, rows, type State } from "../src/model"

type Fake = {
  id: string
  title?: string
  projectID: string
  parentID?: string
  location: { directory: string }
  outcome?: "succeeded" | "failed" | "interrupted"
  time: { idle?: number; viewed?: number; archived?: number; updated?: number }
}

/**
 * A fake server holding `sessions`. Like the real one, its list returns a cursor after every page but an empty one,
 * filters by project or exact directory, and orders by last update, newest first. It records every request and
 * the most requests ever in flight at once.
 */
function server(
  sessions: Fake[],
  options: {
    projects?: { id: string; name: string; canonical: string }[]
    active?: string[]
    approvals?: Record<string, string[]>
    questions?: Record<string, string[]>
    /**
     * The server part's `catalog` method: the real one over these sessions, missing (an older server part), or
     * failing with an RPC error or a lost connection.
     */
    rpc?: "catalog" | "legacy" | "internal" | "transport"
  } = {},
) {
  const calls: { method: string; input: unknown }[] = []
  let inFlight = 0
  let maxInFlight = 0
  async function call<T>(method: string, input: unknown, answer: () => T): Promise<T> {
    calls.push({ method, input })
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    // Let every request started in the same turn overlap, as on a real connection.
    await new Promise((resolve) => setTimeout(resolve, 1))
    inFlight--
    return answer()
  }
  const ordered = sessions.toSorted((a, b) => (b.time.updated ?? 0) - (a.time.updated ?? 0))
  const filters = new Map<string, Fake[]>()
  const fake = {
    rpc: () => ({
      catalog: (input: { sessions: string[]; roots?: string[] }, rpcOptions: unknown) =>
        call("rpc.catalog", { input, options: rpcOptions }, () => {
          if (options.rpc === "legacy")
            throw {
              type: "rpc.method_not_found",
              message: "Unknown RPC method: opencode-switchboard.catalog",
            }
          if (options.rpc === "internal") throw { type: "rpc.internal", message: "RPC call failed" }
          if (options.rpc === "transport")
            throw Object.assign(new Error("ECONNRESET"), { reason: "Transport" })
          // As in-process on the server: a missing session rejects with the server's own not-found tag.
          return readCatalog(async (id) => {
            const session = sessions.find((session) => session.id === id)
            if (!session) throw { _tag: "Session.NotFoundError", sessionID: id }
            return session
          }, input)
        }),
    }),
    project: { list: () => call("project.list", undefined, () => options.projects ?? []) },
    session: {
      active: () =>
        call("session.active", undefined, () =>
          Object.fromEntries((options.active ?? []).map((id) => [id, { type: "running" }])),
        ),
      get: (input: { sessionID: string }) =>
        call("session.get", input, () => {
          const session = sessions.find((session) => session.id === input.sessionID)
          if (!session) throw Object.assign(new Error("not found"), { _tag: "SessionNotFoundError" })
          return session
        }),
      list: (input: {
        cursor?: string
        limit: number
        project?: string
        directory?: string
        parentID?: null
        archived?: false
      }) =>
        call("session.list", input, () => {
          const key = input.cursor?.split("@")[0] ?? JSON.stringify(input)
          const start = input.cursor ? Number(input.cursor.split("@")[1]) : 0
          if (!input.cursor)
            filters.set(
              key,
              ordered.filter(
                (session) =>
                  !session.parentID &&
                  !session.time.archived &&
                  (input.project !== undefined
                    ? session.projectID === input.project
                    : session.location.directory === input.directory),
              ),
            )
          const data = filters.get(key)!.slice(start, start + input.limit)
          return { data, cursor: { next: data.length ? `${key}@${start + input.limit}` : null } }
        }),
    },
    permission: {
      request: {
        list: (input: { location: { directory: string } }) =>
          call("permission.request.list", input, () => ({
            data: (options.approvals?.[input.location.directory] ?? []).map((sessionID) => ({ sessionID })),
          })),
      },
    },
    form: {
      list: (input: { location: { directory: string } }) =>
        call("form.list", input, () => ({
          data: (options.questions?.[input.location.directory] ?? []).map((sessionID) => ({ sessionID })),
        })),
    },
  }
  return {
    client: fake as unknown as OpenCodeClient,
    calls,
    count: (method: string) => calls.filter((call) => call.method === method).length,
    maxInFlight: () => maxInFlight,
    reset() {
      calls.length = 0
      maxInFlight = 0
    },
  }
}

/** `total` root sessions of one project, `<project>-0` the most recently updated. */
function roots(total: number, project = "work", directory = "/work"): Fake[] {
  return Array.from({ length: total }, (_, index) => ({
    id: `${project}-${index}`,
    title: `Task ${index}`,
    projectID: project,
    location: { directory },
    time: { updated: total - index },
  }))
}

function tracking(sessions: Record<string, string[]>): State {
  const state = initialState()
  for (const [key, members] of Object.entries(sessions))
    state.projects[key] = { name: key, open: true, sessions: members }
  return state
}

const WORK = [{ id: "work", name: "Work", canonical: "/work" }]

test("a short page is a project's last: no request follows it", async () => {
  const fake = server(roots(30), { projects: WORK })
  const result = await loadCatalog(fake.client, tracking({ work: ["work-0"] }))
  expect(fake.count("session.list")).toBe(1)
  expect(fake.count("session.get")).toBe(0)
  expect(result.sessions.map((session) => session.id)).toContain("work-0")
})

test("an unknown project lists one page, then reads the tracked roots it did not show", async () => {
  const fake = server(roots(150), { projects: WORK })
  const counts: RootCounts = new Map()
  const result = await loadCatalog(fake.client, tracking({ work: ["work-0", "work-120"] }), undefined, null, {
    counts,
  })
  expect(fake.calls.filter((call) => call.method === "session.list").map((call) => call.input)).toEqual([
    { project: "work", parentID: null, archived: false, limit: 100 },
  ])
  expect(fake.calls.filter((call) => call.method === "session.get").map((call) => call.input)).toEqual([
    { sessionID: "work-120" },
  ])
  expect(counts.get("work")).toBe(101)
  expect(result.sessions.map((session) => session.id)).toContain("work-120")
})

test("a project of exactly one full page costs no empty request", async () => {
  const fake = server(roots(100), { projects: WORK })
  await loadCatalog(fake.client, tracking({ work: ["work-0"] }))
  expect(fake.count("session.list")).toBe(1)
})

test("a project with few of its roots tracked reads each tracked root, not its list", async () => {
  const fake = server(roots(300), { projects: WORK })
  const counts: RootCounts = new Map()
  const state = tracking({ work: ["work-0", "work-150", "work-299"] })
  await loadCatalog(fake.client, state, undefined, null, { counts })
  fake.reset()
  const result = await loadCatalog(fake.client, state, undefined, null, { counts })
  expect(fake.count("session.list")).toBe(0)
  expect(fake.count("session.get")).toBe(3)
  expect(
    rows(result.sessions, state).flatMap((row) => (row.kind === "session" ? [row.session.id] : [])),
  ).toEqual(["work-0", "work-150", "work-299"])
})

test("a listing that stops early is not repeated: the next refresh reads each tracked root", async () => {
  const fake = server(roots(1000), { projects: WORK })
  const counts: RootCounts = new Map()
  const state = tracking({ work: Array.from({ length: 50 }, (_, index) => `work-${index + 900}`) })
  await loadCatalog(fake.client, state, undefined, null, { counts })
  expect([fake.count("session.list"), fake.count("session.get")]).toEqual([1, 50])
  fake.reset()
  await loadCatalog(fake.client, state, undefined, null, { counts })
  expect([fake.count("session.list"), fake.count("session.get")]).toEqual([0, 50])
})

test("a project with most of its roots tracked lists them in full", async () => {
  const fake = server(roots(150), { projects: WORK })
  const state = tracking({ work: Array.from({ length: 80 }, (_, index) => `work-${index}`) })
  const counts: RootCounts = new Map([["work", 150]])
  await loadCatalog(fake.client, state, undefined, null, { counts })
  expect(fake.count("session.list")).toBe(2)
  expect(fake.count("session.get")).toBe(0)
  expect(counts.get("work")).toBe(150)
})

test("projects load in parallel, and never more than 8 requests are in flight", async () => {
  const names = ["a", "b", "c"]
  const sessions = names.flatMap((project) => roots(300, project, `/${project}`))
  const projects = names.map((id) => ({ id, name: id, canonical: `/${id}` }))
  const state = tracking(
    Object.fromEntries(names.map((project) => [project, roots(20, project).map((session) => session.id)])),
  )
  const counts: RootCounts = new Map(names.map((project) => [project, 300]))
  const fake = server(sessions, { projects })
  const result = await loadCatalog(fake.client, state, undefined, null, { counts })
  expect(fake.count("session.get")).toBe(60)
  expect(fake.maxInFlight()).toBe(8)
  expect(rows(result.sessions, state).filter((row) => row.kind === "session")).toHaveLength(60)
})

test("a tracked session that no longer exists is left out, as a listing leaves it out", async () => {
  const fake = server(roots(300), { projects: WORK })
  const state = tracking({ work: ["work-0", "deleted"] })
  const result = await loadCatalog(fake.client, state, undefined, null, { counts: new Map([["work", 300]]) })
  expect(result.sessions.map((session) => session.id)).toEqual(["work-0"])
  expect(result.issues).toEqual([])
})

test("an unchanged catalog compares equal however its reads finish", async () => {
  const fake = server(roots(300), { projects: WORK })
  const state = tracking({ work: ["work-5", "work-1", "work-9"] })
  const counts: RootCounts = new Map([["work", 300]])
  const first = await loadCatalog(fake.client, state, undefined, null, { counts })
  const second = await loadCatalog(fake.client, state, undefined, null, { counts })
  expect(JSON.stringify(second.sessions)).toBe(JSON.stringify(first.sessions))
})

/**
 * A representative state: two open projects, one with a worktree, plus a directory project; archived, deleted,
 * and subagent sessions; running subagents of a tracked and an untracked root; an approval and a question; and a
 * current session not yet tracked. The expected rows are what the catalog produced when it listed every root
 * (checked against the implementation before 0.2.2).
 */
function representative(rpc?: "catalog" | "legacy" | "internal" | "transport") {
  const sessions: Fake[] = [
    ...roots(40, "work", "/work"),
    {
      id: "tree-1",
      title: "Worktree task",
      projectID: "work",
      location: { directory: "/work-tree" },
      time: {},
    },
    {
      id: "done",
      title: "Archived",
      projectID: "work",
      location: { directory: "/work" },
      time: { archived: 1 },
    },
    { id: "child-1", projectID: "work", parentID: "work-3", location: { directory: "/work" }, time: {} },
    { id: "child-2", projectID: "work", parentID: "work-39", location: { directory: "/work" }, time: {} },
    { id: "child-3", projectID: "work", parentID: "tree-1", location: { directory: "/work-tree" }, time: {} },
    ...roots(5, "play", "/play").map((session, index) => ({
      ...session,
      outcome: (["failed", "interrupted", "succeeded", undefined, undefined] as const)[index],
      time: { ...session.time, idle: 10 + index, viewed: index },
    })),
    { id: "scratch-1", title: "", projectID: "global", location: { directory: "/scratch" }, time: {} },
    {
      id: "scratch-2",
      title: "Untracked",
      projectID: "global",
      location: { directory: "/scratch" },
      time: {},
    },
    { id: "other-1", title: "Shown here", projectID: "other", location: { directory: "/other" }, time: {} },
  ]
  const state = tracking({
    work: ["work-3", "tree-1", "work-30", "done", "deleted"],
    play: ["play-0", "play-1", "play-2", "play-3"],
    "/scratch": ["scratch-1"],
  })
  state.projects.closed = { name: "closed", open: false, sessions: ["other-1"] }
  return {
    state,
    fake: server(sessions, {
      projects: [
        { id: "work", name: "Work", canonical: "/work" },
        { id: "play", name: "", canonical: "/play" },
        { id: "other", name: "Other", canonical: "/other" },
      ],
      active: ["child-1", "child-2"],
      approvals: { "/work-tree": ["child-3"] },
      questions: { "/play": ["play-2"] },
      rpc,
    }),
  }
}

const EXPECTED_ROWS = [
  // [id, title, project name, detail, status, running, idle, viewed]
  ["scratch-1", "Untitled session", "scratch", "main", "Idle", false, 0, 0],
  ["play-0", "Task 0", "play", "main", "Error", false, 10, 0],
  ["play-1", "Task 1", "play", "main", "Interrupted", false, 11, 1],
  ["play-2", "Task 2", "play", "main", "Question", false, 12, 2],
  ["play-3", "Task 3", "play", "main", "Idle", false, 13, 3],
  ["work-3", "Task 3", "Work", "main", "Running", true, 0, 0],
  ["tree-1", "Worktree task", "Work", "/work-tree", "Approval", false, 0, 0],
  ["work-30", "Task 30", "Work", "main", "Idle", false, 0, 0],
]

function rowValues(sessions: Awaited<ReturnType<typeof loadCatalog>>["sessions"], state: State) {
  return rows(sessions, state).flatMap((row) =>
    row.kind === "session"
      ? [
          [
            row.session.id,
            row.session.title,
            row.session.projectName,
            row.session.detail,
            row.session.status,
            row.session.running,
            row.session.idle,
            row.session.viewed,
          ],
        ]
      : [],
  )
}

/** Root counts that make every project of `representative` read its tracked sessions one by one. */
const many = (): RootCounts =>
  new Map([
    ["work", 1000],
    ["play", 1000],
    ["/scratch", 1000],
  ])

const LOCATION = { directory: "/work" }

/** Each way of loading the catalog: listing, reading each session, the RPC, and the RPC's fallback. */
const MODES: [string, Parameters<typeof representative>[0], () => CatalogMemory][] = [
  ["listing", undefined, () => ({})],
  ["reading", undefined, () => ({ counts: many() })],
  ["rpc", "catalog", () => ({ location: LOCATION })],
  ["older server part", "legacy", () => ({ location: LOCATION })],
  ["failing rpc", "internal", () => ({ location: LOCATION })],
]

for (const [mode, rpc, memory] of MODES)
  test(`rows are the same however the catalog loads: ${mode}`, async () => {
    const { state, fake } = representative(rpc)
    const result = await loadCatalog(fake.client, state, undefined, "other-1", memory())
    expect(rowValues(result.sessions, state)).toEqual(EXPECTED_ROWS)
    expect(
      rows(result.sessions, state)
        .filter((row) => row.kind === "heading")
        .map((row) => row.title),
    ).toEqual(["scratch", "play", "Work"])
    // The session this TUI shows loads before its project lists it.
    expect(result.sessions.some((session) => session.id === "other-1")).toBe(true)
    // Attention reads only the directories of rows.
    expect(
      fake.calls
        .filter((call) => call.method === "form.list")
        .map((call) => (call.input as { location: { directory: string } }).location.directory)
        .toSorted(),
    ).toEqual(["/play", "/scratch", "/work", "/work-tree"])
    expect(result.issues).toEqual([])
    expect(result.warning).toBe("")
  })

test("reading tracked sessions skips the untracked roots: no lists, one read per session needed", async () => {
  const listing = representative()
  await loadCatalog(listing.fake.client, listing.state, undefined, "other-1")
  expect(listing.fake.count("session.list")).toBe(3)
  const reading = representative()
  await loadCatalog(reading.fake.client, reading.state, undefined, "other-1", { counts: many() })
  expect(reading.fake.count("session.list")).toBe(0)
  // work 5 tracked (one archived, one deleted), play 4, scratch 1, two running subagents, an approval's subagent,
  // the untracked root of a running subagent, and the current session.
  expect(reading.fake.count("session.get")).toBe(15)
})

test("with the server part's catalog method, the tracked sessions and every root take one RPC each", async () => {
  const { state, fake } = representative("catalog")
  await loadCatalog(fake.client, state, undefined, "other-1", { location: LOCATION })
  expect(fake.count("session.list")).toBe(0)
  expect(fake.count("session.get")).toBe(0)
  const inputs = fake.calls
    .filter((call) => call.method === "rpc.catalog")
    .map((call) => call.input as { input: unknown; options: unknown })
  expect(inputs).toEqual([
    {
      // Tracked sessions of open projects, then the current one; the closed project's are not read.
      input: {
        sessions: [
          "work-3",
          "tree-1",
          "work-30",
          "done",
          "deleted",
          "play-0",
          "play-1",
          "play-2",
          "play-3",
        ].concat(["scratch-1", "other-1"]),
      },
      options: { location: LOCATION },
    },
    // The running subagents' roots, then the roots of sessions with requests that are not known roots.
    { input: { sessions: [], roots: ["child-1", "child-2"] }, options: { location: LOCATION } },
    { input: { sessions: [], roots: ["child-3"] }, options: { location: LOCATION } },
  ])
  // Snapshot aside: projects, active sessions, 3 RPCs, and 2 attention reads for each of 4 directories.
  expect(fake.calls).toHaveLength(13)
})

test("a tracked session that is gone is asked for once; an archived one keeps being read", async () => {
  for (const [rpc, memory] of [
    ["catalog", { location: LOCATION }],
    [undefined, { counts: many() }],
  ] as const) {
    const { state, fake } = representative(rpc)
    const kept: CatalogMemory = { ...memory }
    await loadCatalog(fake.client, state, undefined, "other-1", kept)
    expect([...kept.gone!]).toEqual(["deleted"])
    fake.reset()
    await loadCatalog(fake.client, state, undefined, "other-1", kept)
    const asked = fake.calls.flatMap((call) =>
      call.method === "session.get"
        ? [(call.input as { sessionID: string }).sessionID]
        : call.method === "rpc.catalog"
          ? (call.input as { input: { sessions: string[] } }).input.sessions
          : [],
    )
    expect(asked).toContain("done")
    expect(asked).not.toContain("deleted")
  }
})

test("an older server part answers once: later refreshes skip the method", async () => {
  const { state, fake } = representative("legacy")
  const memory: CatalogMemory = { location: LOCATION }
  await loadCatalog(fake.client, state, undefined, "other-1", memory)
  expect(fake.count("rpc.catalog")).toBe(1)
  expect(memory.legacy).toBe(true)
  fake.reset()
  const result = await loadCatalog(fake.client, state, undefined, "other-1", memory)
  expect(fake.count("rpc.catalog")).toBe(0)
  expect(rowValues(result.sessions, state)).toEqual(EXPECTED_ROWS)
})

test("another RPC failure falls back for that refresh only", async () => {
  const { state, fake } = representative("internal")
  const memory: CatalogMemory = { location: LOCATION }
  await loadCatalog(fake.client, state, undefined, "other-1", memory)
  expect(memory.legacy).toBeUndefined()
  fake.reset()
  await loadCatalog(fake.client, state, undefined, "other-1", memory)
  expect(fake.count("rpc.catalog")).toBeGreaterThan(0)
})

test("a lost connection fails the refresh, as any other read would", async () => {
  const { state, fake } = representative("transport")
  const memory: CatalogMemory = { location: LOCATION }
  await expect(loadCatalog(fake.client, state, undefined, "other-1", memory)).rejects.toMatchObject({
    reason: "Transport",
  })
  expect(memory.legacy).toBeUndefined()
})
