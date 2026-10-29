import { expect, test } from "bun:test"
import { readAttention } from "../src/attention"

test("removed workspaces are distinguished from transient request failures", async () => {
  const missing = Object.assign(new Error("Location not found: /removed"), { _tag: "LocationNotFoundError" })
  const result = await readAttention(
    () => Promise.reject(missing),
    () => Promise.reject(missing),
  )
  expect(result.unavailable).toBe("missing")
  expect(result.errors).toHaveLength(2)
})

test("partial refresh preserves the failed side while accepting the successful side", async () => {
  const previous = { approvals: ["blocked"], questions: ["old"], errors: [] }
  const stale = await readAttention(
    () => Promise.reject(new Error("timeout")),
    async () => ({ data: [{ sessionID: "new" }] }),
    previous,
  )
  expect(stale.approvals).toEqual(["blocked"])
  expect(stale.questions).toEqual(["new"])
  expect(stale.unavailable).toBe("stale")
  const recovered = await readAttention(
    async () => ({ data: [] }),
    async () => ({ data: [] }),
    stale,
  )
  expect(recovered).toEqual({ approvals: [], questions: [], errors: [] })
})
