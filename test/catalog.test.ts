import { expect, test } from "bun:test"
import type { OpenCodeClient } from "@opencode/client"
import { loadCatalog } from "../src/catalog"
import { initialState } from "../src/model"

/**
 * A client whose project has `total` root sessions. Like the server, it returns a cursor after every page but an
 * empty one, so a short last page is followed by an empty request unless the caller stops.
 */
function client(total: number) {
  const lists: unknown[] = []
  const all = Array.from({ length: total }, (_, index) => ({
    id: `s${index}`,
    title: `Task ${index}`,
    projectID: "work",
    location: { directory: "/work" },
    time: {},
  }))
  const fake = {
    project: { list: async () => [{ id: "work", name: "Work", canonical: "/work" }] },
    session: {
      active: async () => ({}),
      list: async (input: { cursor?: string; limit: number }) => {
        lists.push(input)
        const start = input.cursor ? Number(input.cursor) : 0
        const data = all.slice(start, start + input.limit)
        return { data, cursor: { next: data.length ? String(start + input.limit) : null } }
      },
    },
    permission: { request: { list: async () => ({ data: [] }) } },
    form: { list: async () => ({ data: [] }) },
  }
  return { client: fake as unknown as OpenCodeClient, lists }
}

function state() {
  const state = initialState()
  state.projects.work = { name: "Work", open: true, sessions: ["s0"] }
  return state
}

test("a short page is a project's last: no request follows it", async () => {
  const { client: fake, lists } = client(30)
  const result = await loadCatalog(fake, state())
  expect(lists).toHaveLength(1)
  expect(result.sessions).toHaveLength(30)
})

test("a full page still fetches the next one", async () => {
  const { client: fake, lists } = client(150)
  const result = await loadCatalog(fake, state())
  expect(lists).toEqual([
    { project: "work", parentID: null, archived: false, limit: 100 },
    { cursor: "100", limit: 100 },
  ])
  expect(result.sessions).toHaveLength(150)
})

test("a project of exactly one full page costs one empty request", async () => {
  const { client: fake, lists } = client(100)
  expect((await loadCatalog(fake, state())).sessions).toHaveLength(100)
  expect(lists).toHaveLength(2)
})
