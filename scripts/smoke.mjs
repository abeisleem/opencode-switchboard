// Exercise the installed CLI in a real PTY against private config/state/database.
import pty from "@lydell/node-pty"
import xterm from "@xterm/headless"
import { execFileSync } from "node:child_process"
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { fileURLToPath, pathToFileURL } from "node:url"

const plugin = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "")
const root = await mkdtemp("/tmp/opencode/switchboard-pty-")
const directory = `${root}/project`
await mkdir(`${directory}/.opencode`, { recursive: true })
await mkdir(`${plugin}/artifacts`, { recursive: true })
const bundled = process.argv.includes("bundled")
const autoOpen = process.argv.includes("auto")
const scoped = process.argv.includes("scoped")
const shortcut = process.argv.includes("key")
const activation = process.argv.includes("activate")
let clientPlugin = plugin
if (bundled) {
  clientPlugin = `${root}/workstation-client`
  await cp(`${plugin}/artifacts/client`, clientPlugin, { recursive: true })
  // The backend deliberately has NO TUI export. The test cannot accidentally
  // succeed by loading the server's TypeScript sources instead of the client build.
  await writeFile(
    `${directory}/package.json`,
    JSON.stringify({
      name: "switchboard-smoke-server",
      type: "module",
      exports: { ".": "./server.ts" },
    }),
  )
  await writeFile(
    `${directory}/server.ts`,
    `export { default } from ${JSON.stringify(pathToFileURL(`${plugin}/src/server.ts`).href)}\n`,
  )
  await writeFile(`${directory}/.opencode/opencode.json`, JSON.stringify({ plugins: ["../"] }))
} else {
  await writeFile(`${directory}/.opencode/opencode.json`, JSON.stringify({ plugins: [plugin] }))
}
const wide = process.argv.includes("session")
const cols = wide ? 150 : 100
const terminal = new xterm.Terminal({ cols, rows: 38, allowProposedApi: true })
const env = {
  ...process.env,
  TERM: "xterm-256color",
  COLORTERM: "truecolor",
  XDG_CONFIG_HOME: `${root}/config`,
  XDG_DATA_HOME: `${root}/data`,
  XDG_STATE_HOME: `${root}/state`,
  XDG_CACHE_HOME: `${root}/cache`,
  OPENCODE_DB: `${root}/test.db`,
  OPENCODE_CONFIG_CONTENT: "{}",
  OPENCODE_CLI_CONFIG_CONTENT: JSON.stringify({
    ...(scoped
      ? {}
      : { plugins: [{ package: clientPlugin, options: { backendDirectory: directory, autoOpen } }] }),
    highlights: false,
    animations: false,
    mouse: true,
  }),
}
let session
if (wide) {
  const result = JSON.parse(
    execFileSync(
      "opencode",
      [
        "api",
        "--standalone",
        "session.create",
        "--data",
        JSON.stringify({ title: "Isolated panel smoke", location: { directory } }),
      ],
      { cwd: directory, env, encoding: "utf8" },
    ),
  )
  session = result.id ?? result.data?.id
  if (!session) throw new Error("Private session creation did not return an ID")
  if (activation) {
    for (const title of ["Activate target", "Another session"]) {
      execFileSync(
        "opencode",
        [
          "api",
          "--standalone",
          "session.create",
          "--data",
          JSON.stringify({ title, location: { directory } }),
        ],
        { cwd: directory, env, encoding: "utf8" },
      )
    }
  }
}
const child = pty.spawn("opencode", ["--standalone", ...(session ? ["--session", session] : []), directory], {
  name: "xterm-256color",
  cols,
  rows: 38,
  // Explicit directory must work even when the invoking shell is elsewhere.
  cwd: scoped ? root : directory,
  env,
})
child.onData((data) => terminal.write(data))
terminal.onData((data) => child.write(data))
function screen() {
  return Array.from(
    { length: 38 },
    (_, index) =>
      terminal.buffer.active.getLine(terminal.buffer.active.viewportY + index)?.translateToString(true) ?? "",
  ).join("\n")
}
async function wait(predicate) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (predicate(screen())) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(screen())
}
let passed = false
try {
  if (!autoOpen) {
    await wait((text) => text.includes("Ask") || text.includes("Build ·"))
    child.write("/switchboard")
    await wait((text) => text.includes("Open switchboard"))
    child.write(shortcut ? "\x15\x18i" : "\r")
  }
  // Headings render before their sessions load; wait for the session row itself.
  await wait((text) =>
    session ? /▾ project[^]*Isolated panel smoke/.test(text) : text.includes("No open projects"),
  )
  if (activation) {
    const panel = (text, title) => new RegExp(`▾ project[^]*${title}`).test(text)
    // Ctrl+O adds a session to its project's list. Newest additions go first.
    for (const title of ["Activate target", "Another session"]) {
      child.write("\x0f")
      await wait((text) => text.includes("Search sessions and projects"))
      child.write(title)
      await wait((text) => text.includes(title))
      child.write("\r")
      await wait((text) => !text.includes("Search sessions and projects") && panel(text, title))
    }
    // Ctrl+X I focuses the open panel on the current conversation; `u` proves where the cursor is.
    child.write("\x18i")
    child.write("u")
    await wait((text) => /•\s+Another session/.test(text))
    // Enter keeps the cursor on the session it opened.
    child.write("\x1b[B\r")
    await wait((text) => text.split("\n")[0].includes("Activate target"))
    child.write("u")
    await wait((text) => /•\s+Activate target/.test(text))
    if (terminal.modes.mouseTrackingMode === "none") throw new Error("Mouse reporting is not enabled")
    const lines = screen().split("\n")
    const y = lines.findLastIndex((line, index) => index > 1 && line.includes("Isolated panel smoke"))
    if (y < 0) throw new Error("Session row not visible for mouse test")
    const x = lines[y].indexOf("Isolated panel smoke") + 3
    child.write(`\x1b[<0;${x + 1};${y + 1}M\x1b[<0;${x + 1};${y + 1}m`)
    child.write("u")
    await wait((text) => /•\s+Isolated panel smoke/.test(text))
  } else if (session) {
    child.write("\x1b[Bu")
    await wait((text) => /•\s+Isolated panel smoke/.test(text))
    child.write("l")
    await wait((text) => text.includes("▾ Later") && /•\s+Isolated panel smoke/.test(text))
    child.write("a")
    await wait((text) => !text.includes("▾ Later") && /•\s+Isolated panel smoke/.test(text))
    // Closing the project keeps its saved session set (reopening via Ctrl+O is not yet scripted).
    child.write("\x1b[Ax")
    await wait((text) => text.includes("No open projects"))
  }
  const frame = screen()
  await writeFile(
    `${plugin}/artifacts/opencode-${bundled ? "bundled-" : ""}${session ? "panel" : "home"}-smoke.txt`,
    frame,
  )
  console.log(
    `${bundled ? "Bundled " : ""}${session ? "side panel" : "home route"} smoke passed (${cols} columns${autoOpen ? ", auto-open" : ""}${scoped ? ", project discovery only" : ""}${shortcut ? ", leader+i" : ""}${activation ? ", keyboard/mouse activation" : ""})`,
  )
  passed = true
} finally {
  child.kill()
  terminal.dispose()
  if (passed) await rm(root, { recursive: true, force: true })
  else console.error("Private failure logs retained at", root)
}
