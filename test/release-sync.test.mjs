import { test } from "node:test"
import assert from "node:assert/strict"
import { publishedRegistry, releaseNotes, releasePlan, syncReleases } from "../scripts/sync-releases.mjs"

const changelog = `# Changelog

## 0.1.2 (2026-10-30)

- New fixes.

### Details

Keep this subsection.

## 0.1.1 (2026-10-30)

- Older fixes.
`
const notes = releaseNotes(changelog)
const registry = {
  versions: { "0.0.0-stage": {}, "0.1.1": {}, "0.1.2": {}, "0.2.0-beta.1": {} },
  "dist-tags": { latest: "0.1.2", next: "0.2.0-beta.1" },
}
const tags = new Set(["v0.1.1", "v0.1.2", "v0.1.3"])

test("extracts each complete section and rejects ambiguous or empty notes", () => {
  assert.equal(notes.get("0.1.1"), "- Older fixes.")
  assert.match(notes.get("0.1.2"), /### Details\n\nKeep this subsection\.$/)
  assert.throws(() => releaseNotes(changelog + "\n## 0.1.2 (2026-10-30)\nDuplicate"), /duplicate/)
  assert.throws(() => releaseNotes("## 0.1.2 (2026-10-30)\n"), /Empty/)
})

test("only publishes versions present on npm with source tags and notes", () => {
  const plan = releasePlan("opencode-switchboard", registry, notes, tags)
  assert.deepEqual(
    plan.map((release) => release.tag),
    ["v0.1.1", "v0.1.2"],
  )
  assert.equal(plan[0].latest, false)
  assert.equal(plan[1].latest, true)
  assert.match(plan[1].body, /npmjs.com\/package\/opencode-switchboard\/v\/0.1.2/)
  assert.throws(() => releasePlan("pkg", registry, new Map(), tags), /Missing changelog/)
})

test("keeps prereleases separate from npm latest", () => {
  const plan = releasePlan(
    "pkg",
    registry,
    new Map([["0.2.0-beta.1", "Preview"]]),
    new Set(["v0.2.0-beta.1"]),
  )
  assert.equal(plan[0].prerelease, true)
  assert.equal(plan[0].latest, false)
})

test("waits for npm processing without invoking another publication", async () => {
  let reads = 0
  let waits = 0
  const result = await publishedRegistry(async () => (++reads === 1 ? { versions: {} } : registry), "0.1.2", {
    attempts: 2,
    wait: async () => {
      waits++
    },
  })
  assert.equal(result, registry)
  assert.equal(waits, 1)
  await assert.rejects(
    publishedRegistry(async () => ({ versions: {} }), "0.1.2", { attempts: 1 }),
    /do not publish again/,
  )
})

test("creates missing releases, repairs stale notes, and pins latest to npm", () => {
  const plan = releasePlan("pkg", registry, notes, tags)
  const calls = []
  syncReleases(plan, [{ tag_name: "v0.1.1", body: "old" }], (args, body) => calls.push({ args, body }))
  assert.deepEqual(calls[0].args.slice(0, 3), ["release", "edit", "v0.1.1"])
  assert.ok(calls[0].args.includes("--draft=false"))
  assert.deepEqual(calls[1].args.slice(0, 3), ["release", "create", "v0.1.2"])
  assert.ok(calls[1].args.includes("--verify-tag"))
  assert.equal(calls[1].body, plan[1].body)
  assert.deepEqual(calls[2].args, ["release", "edit", "v0.1.2", "--verify-tag", "--latest"])
})

test("leaves matching release notes and unrelated releases alone on repeated runs", () => {
  const plan = releasePlan("pkg", registry, notes, tags)
  const existing = plan.map((release) => ({
    tag_name: release.tag,
    name: release.tag,
    body: release.body,
    prerelease: release.prerelease,
    draft: false,
  }))
  existing.push({ tag_name: "unrelated", name: "Custom", body: "Keep", prerelease: false, draft: false })
  const calls = []
  syncReleases(plan, existing, (args) => calls.push(args))
  assert.deepEqual(calls, [["release", "edit", "v0.1.2", "--verify-tag", "--latest"]])
})
