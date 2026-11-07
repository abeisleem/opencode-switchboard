import { expect, test } from "bun:test"
import { limiter, notFound, readCatalog, type SessionRecord } from "../src/sessions"

const session = (id: string, extra: Partial<SessionRecord> = {}): SessionRecord => ({
  id,
  projectID: "work",
  location: { directory: "/work" },
  time: {},
  ...extra,
})

/** An in-process session reader over `sessions`, as the server part's `ctx.session.get`, counting reads. */
function reader(sessions: SessionRecord[]) {
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
  return { get, reads, maxInFlight: () => maxInFlight }
}

test("returns the row fields of root sessions, in request order, and nothing else", async () => {
  const { get } = reader([
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
  const { get } = reader([session("root"), session("child", { parentID: "root" })])
  const result = await readCatalog(get, { sessions: ["root", "gone", "child"] })
  expect(result.sessions.map((session) => session.id)).toEqual(["root"])
  expect(result.missing).toEqual(["gone", "child"])
})

test("resolves roots through parent chains, leaving out broken chains", async () => {
  const { get, reads } = reader([
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
  const { get } = reader([session("a", { parentID: "b" }), session("b", { parentID: "a" })])
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
  const { get, reads, maxInFlight } = reader(sessions)
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
