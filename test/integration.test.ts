import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { pathToFileURL } from "node:url"
import { OpenCode } from "@opencode/client"
import { Switchboard } from "../src/rpc"
import { loadCatalog } from "../src/catalog"

test("real private server loads only in its sandbox, shares actions, and persists on restart", async () => {
  const root = await mkdtemp("/tmp/opencode/inbox-integration-")
  const directory = `${root}/project`
  const elsewhere = `${root}/elsewhere`
  await mkdir(`${directory}/.opencode`, { recursive: true })
  await mkdir(elsewhere)
  // Exercise the same relative-directory registration as the actual sandbox.
  await Bun.write(`${directory}/.opencode/opencode.json`, JSON.stringify({ plugins: ["../"] }))
  await Bun.write(
    `${directory}/package.json`,
    JSON.stringify({ name: "inbox-registration-test", type: "module", exports: { ".": "./server.ts" } }),
  )
  await Bun.write(
    `${directory}/server.ts`,
    `export { default } from ${JSON.stringify(pathToFileURL(`${process.cwd()}/src/server.ts`).href)}\n`,
  )
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const port = reservation.port
  reservation.stop(true)
  const client = OpenCode.make({
    baseUrl: `http://127.0.0.1:${port}`,
    headers: { authorization: `Basic ${Buffer.from("opencode:inbox-test").toString("base64")}` },
  })
  const rpc = client.rpc(Switchboard)
  let processHandle: ReturnType<typeof Bun.spawn> | undefined
  async function start() {
    processHandle = Bun.spawn(["opencode", "serve", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: directory,
      env: {
        ...process.env,
        OPENCODE_PASSWORD: "inbox-test",
        OPENCODE_SERVER_PASSWORD: "inbox-test",
        OPENCODE_DB: `${root}/test.db`,
        XDG_CONFIG_HOME: `${root}/config`,
        XDG_DATA_HOME: `${root}/data`,
        XDG_STATE_HOME: `${root}/state`,
        XDG_CACHE_HOME: `${root}/cache`,
        OPENCODE_CONFIG_CONTENT: "{}",
      },
      stdout: Bun.file(`${root}/server.log`),
      stderr: Bun.file(`${root}/server-error.log`),
    })
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      try {
        await client.server.info()
        return
      } catch {
        await Bun.sleep(100)
      }
    }
    throw new Error(
      `Private server failed: ${await Bun.file(`${root}/server.log`).text()} ${await Bun.file(`${root}/server-error.log`).text()}`,
    )
  }
  async function stop() {
    processHandle?.kill()
    if (processHandle) await processHandle.exited
  }
  try {
    await start()
    const options = { location: { directory } }
    const before = await rpc.snapshot({}, options)
    expect(before.revision).toBe(0)
    const a = await client.session.create({ title: "Inbox integration A", location: { directory } })
    const b = await client.session.create({ title: "Inbox integration B", location: { directory } })
    await rpc.act({ type: "visit", sessionID: a.id, observed: 0 }, options)
    await rpc.act({ type: "visit", sessionID: b.id, observed: 0 }, options)
    await rpc.act({ type: "place", sessionID: b.id, placement: "parked" }, options)
    const marked = await rpc.act({ type: "unread", sessionID: b.id }, options)
    // Marking unread does not change placement, and the server records no current session.
    expect(marked).not.toHaveProperty("selected")
    expect(marked.sessions[b.id]?.unread).toBe(true)
    expect(marked.sessions[b.id]?.placement).toBe("parked")
    const catalog = await loadCatalog(client, marked)
    expect(catalog.sessions.map((s) => s.id)).toContain(b.id)
    expect(catalog.warning).toBe("")
    const project = a.projectID === "global" ? directory : a.projectID
    expect(marked.projects[project]?.sessions).toContain(a.id)
    expect(marked.projects[project]?.sessions).toContain(b.id)
    await rpc.act({ type: "session-remove", sessionID: a.id }, options)
    await rpc.act({ type: "project-close", project }, options)
    // This session belongs to the project but was never in its saved working set.
    const c = await client.session.create({ title: "Created while parked", location: { directory } })
    await expect(rpc.snapshot({}, { location: { directory: elsewhere } })).rejects.toThrow()
    await stop()
    await start()
    expect((await rpc.snapshot({}, options)).projects[project]?.open).toBe(false)
    const restored = await rpc.act({ type: "project-open", project, name: "Project" }, options)
    expect(restored.sessions[b.id]?.unread).toBe(true)
    expect(restored.sessions[b.id]?.placement).toBe("parked")
    expect(restored.projects[project]?.sessions).toEqual([b.id])
    expect((await client.session.get({ sessionID: a.id })).time.archived).toBeUndefined()
    await rpc.act({ type: "project-close", project }, options)
    const visited = await rpc.act({ type: "visit", sessionID: c.id, observed: 0 }, options)
    expect(visited.projects[project]?.open).toBe(true)
    // Newly admitted work comes first; existing members keep their order.
    expect(visited.projects[project]?.sessions).toEqual([c.id, b.id])
    // Organizing a session that was never visited also admits it.
    const d = await client.session.create({ title: "Postponed without a visit", location: { directory } })
    const placed = await rpc.act({ type: "place", sessionID: d.id, placement: "parked" }, options)
    expect(placed.projects[project]?.sessions).toEqual([d.id, c.id, b.id])
    // A newly opened project starts empty rather than importing its history.
    const fresh = await rpc.act({ type: "project-open", project: elsewhere, name: "Elsewhere" }, options)
    expect(fresh.projects[elsewhere]?.sessions).toEqual([])
    // Push this project's saved work out of the global newest-100 window.
    for (let i = 0; i < 101; i++)
      await client.session.create({ title: `Other project ${i}`, location: { directory: elsewhere } })
    expect((await client.session.list({ parentID: null, limit: 100 })).data.some((s) => s.id === b.id)).toBe(
      false,
    )
    expect((await loadCatalog(client, visited)).sessions.some((s) => s.id === b.id)).toBe(true)
  } finally {
    await stop()
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)
