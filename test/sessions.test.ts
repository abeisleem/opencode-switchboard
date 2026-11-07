import { expect, test } from "bun:test"
import { limiter, notFound, readCatalog, type ListMemory, type SessionRecord } from "../src/sessions"

const session = (id: string, extra: Partial<SessionRecord> = {}): SessionRecord => ({
  id,
  projectID: "work",
  location: { directory: "/work" },
  time: {},
  ...extra,
})

/** An in-process session reader over `sessions`, as the server part's `ctx.session.get`, counting reads. */
function fakeReader(sessions: SessionRecord[]) {
  const reads: string[] = []
  let inFlight = 0
  let maxInFlight = 0
  async function get(id: string) {
    reads.push(id)
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    await new Promise((resolve) => setTimeout(resolve, 1))
    inFlight--
    const found = sessions.find((session) => session.id === id)
    if (!found) throw { _tag: "Session.NotFoundError", sessionID: id }
    return found
  }
  const lists: { project?: string; directory?: string; limit: number }[] = []
  async function list(input: { project?: string; directory?: string; parentID: null; limit: number }) {
    lists.push({ project: input.project, directory: input.directory, limit: input.limit })
    const data = sessions.filter(
      (session) =>
        !session.parentID &&
        (input.project !== undefined
          ? session.projectID === input.project
          : session.location.directory === input.directory),
    )
    return { data: data.slice(0, input.limit) }
  }
  return { get, list, reads, lists, maxInFlight: () => maxInFlight }
}

/** `total` roots of project "work", "work-0" first. */
const work = (total: number) => Array.from({ length: total }, (_, index) => session(`work-${index}`))

test("returns the row fields of root sessions, in request order, and nothing else", async () => {
  const { get } = fakeReader([
    session("a", {
      title: "A",
      outcome: "failed",
      time: { idle: 3, viewed: 2, archived: 1, updated: 9 } as SessionRecord["time"],
      location: { directory: "/work-tree" },
    }),
    session("b", { projectID: "global", location: { directory: "/scratch" } }),
  ])
  const result = await readCatalog(get, { sessions: ["b", "a"] })
  // Absent fields are left out, not undefined: OpenCode's RPC fails a response with an undefined value.
  expect(Object.keys(result.sessions[0]!)).toEqual(["id", "projectID", "directory"])
  expect(result.sessions).toEqual([
    { id: "b", projectID: "global", directory: "/scratch" },
    {
      id: "a",
      title: "A",
      projectID: "work",
      directory: "/work-tree",
      outcome: "failed",
      idle: 3,
      viewed: 2,
      archived: 1,
    },
  ])
  // Only the row fields cross the wire: no `updated`, no location object.
  expect(JSON.stringify(result.sessions)).not.toContain("updated")
  expect(result.missing).toEqual([])
  expect(result.roots).toEqual({})
})

test("reports deleted sessions and subagents as missing, so the TUI can stop asking", async () => {
  const { get } = fakeReader([session("root"), session("child", { parentID: "root" })])
  const result = await readCatalog(get, { sessions: ["root", "gone", "child"] })
  expect(result.sessions.map((session) => session.id)).toEqual(["root"])
  expect(result.missing).toEqual(["gone", "child"])
})

test("resolves roots through parent chains, leaving out broken chains", async () => {
  const { get, reads } = fakeReader([
    session("root"),
    session("child", { parentID: "root" }),
    session("grandchild", { parentID: "child" }),
    session("orphan", { parentID: "deleted-parent" }),
  ])
  const result = await readCatalog(get, {
    sessions: ["root"],
    roots: ["grandchild", "child", "root", "orphan", "gone"],
  })
  expect(result.roots).toEqual({ grandchild: "root", child: "root", root: "root" })
  // Each session is read once, however many chains pass through it.
  expect(reads.toSorted()).toEqual(["child", "deleted-parent", "gone", "grandchild", "orphan", "root"])
})

test("a parent cycle ends instead of looping", async () => {
  const { get } = fakeReader([session("a", { parentID: "b" }), session("b", { parentID: "a" })])
  expect((await readCatalog(get, { sessions: [], roots: ["a"] })).roots).toEqual({})
})

test("a read that fails for another reason fails the call", async () => {
  const get = async () => {
    throw new Error("database is locked")
  }
  await expect(readCatalog(get, { sessions: ["a"] })).rejects.toThrow("database is locked")
})

test("bounds its reads in flight and reads a repeated ID once", async () => {
  const sessions = Array.from({ length: 100 }, (_, index) => session(`s${index}`))
  const { get, reads, maxInFlight } = fakeReader(sessions)
  const ids = sessions.map((session) => session.id)
  const result = await readCatalog(get, { sessions: [...ids, ...ids] })
  expect(result.sessions).toHaveLength(100)
  expect(reads).toHaveLength(100)
  expect(maxInFlight()).toBe(16)
})

test("not-found errors are recognized over HTTP and in-process, and nothing else is", () => {
  expect(notFound({ _tag: "SessionNotFoundError" })).toBe(true)
  expect(notFound({ _tag: "Session.NotFoundError" })).toBe(true)
  expect(notFound({ _tag: "MessageNotFoundError" })).toBe(false)
  expect(notFound({ _tag: "Message.NotFoundError" })).toBe(false)
  expect(notFound({ _tag: "LocationNotFoundError" })).toBe(false)
  expect(notFound(new Error("not found"))).toBe(false)
})

test("the limiter never runs more than its bound", async () => {
  const run = limiter(3)
  let active = 0
  let most = 0
  await Promise.all(
    Array.from({ length: 20 }, () =>
      run(async () => {
        active++
        most = Math.max(most, active)
        await new Promise((resolve) => setTimeout(resolve, 1))
        active--
      }),
    ),
  )
  expect(most).toBe(3)
})

test("a project of mostly tracked roots is listed in-process, not read session by session", async () => {
  const sessions = [
    ...work(8),
    session("child", { parentID: "work-0" }),
    session("old", { time: { archived: 5 } }),
  ]
  const reader = fakeReader(sessions)
  const tracked = ["work-0", "work-1", "old", "deleted", "child"]
  const result = await readCatalog(reader, { sessions: tracked }, [["work", tracked]])
  // At most 4 roots per tracked session: one list of up to 21 roots.
  expect(reader.lists).toEqual([{ project: "work", directory: undefined, limit: 21 }])
  // Only what the list lacks is read: the deleted session and the subagent.
  expect(reader.reads.toSorted()).toEqual(["child", "deleted"])
  // An archived root is returned, not missing: it can be unarchived.
  expect(result.sessions.map((session) => session.id)).toEqual(["work-0", "work-1", "old"])
  expect(result.missing).toEqual(["deleted", "child"])
})

test("a project with many more roots than tracked is read session by session from then on", async () => {
  const reader = fakeReader(work(100))
  const memory: ListMemory = new Map()
  const call = (tracked: string[]) => readCatalog(reader, { sessions: tracked }, [["work", tracked]], memory)
  await call(["work-50", "work-60"])
  // The list of 9 roots finds more than 4 per tracked session: remember it, and read what it lacked.
  expect(reader.lists).toHaveLength(1)
  expect(reader.reads.toSorted()).toEqual(["work-50", "work-60"])
  expect(memory.get("work")).toBe(2)
  reader.lists.length = 0
  reader.reads.length = 0
  const result = await call(["work-50", "work-60"])
  expect(reader.lists).toHaveLength(0)
  expect(reader.reads).toHaveLength(2)
  expect(result.sessions.map((session) => session.id)).toEqual(["work-50", "work-60"])
  // More tracked sessions than when it overflowed: list it again.
  await call(Array.from({ length: 30 }, (_, index) => `work-${index}`))
  expect(reader.lists).toEqual([{ project: "work", directory: undefined, limit: 121 }])
  expect(memory.has("work")).toBe(false)
})

test("a directory project is listed by its directory; untracked and unrequested IDs are not listed", async () => {
  const reader = fakeReader([session("g", { projectID: "global", location: { directory: "/scratch" } })])
  await readCatalog(reader, { sessions: ["g"] }, [
    ["/scratch", ["g"]],
    ["other", ["x"]],
  ])
  expect(reader.lists).toEqual([{ project: undefined, directory: "/scratch", limit: 5 }])
})
