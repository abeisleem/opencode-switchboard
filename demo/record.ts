// Records the switchboard demo in a private OpenCode with a simulated model. Run `bun run record`; see README.md.
import { mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
// The repository's pinned client, whose RPC protocol matches the released OpenCode; the drive bundles a dev build.
import { OpenCode } from "../node_modules/@opencode/client/dist/promise/index.js"
import { Service } from "../node_modules/@opencode/client/dist/promise/service.js"
import { Cause, Deferred, Effect, Stream } from "effect"
import { Llm, OpenCodeDriver } from "opencode-drive"
import { parkedKey } from "../src/model"
import { Switchboard } from "../src/rpc"
import { CURRENT, projects, type DemoProject, type DemoSession } from "./fixture"

// The drive compiles this script into a temporary directory, so locate the repository from the working directory.
const repo = resolve(process.cwd(), "..")
export const COLS = 132
export const ROWS = 36
/** About a quarter of the window: side tabs, not a second pane. */
const PANEL_COLS = 32
/** Pause between keys, like a person reading the screen as they go. */
const STEP = "550 millis"

type Span = { readonly text: string; readonly bg: readonly number[]; readonly width: number }
type Frame = { readonly lines: readonly { readonly spans: readonly Span[] }[] }
const screen = (frame: Frame) =>
  frame.lines
    .map((line) =>
      line.spans
        .map((span) => span.text)
        .join("")
        .trimEnd(),
    )
    .join("\n")

/** The background color of the cell at column `x`. */
const background = (line: Frame["lines"][number], x: number) => {
  let left = 0
  for (const span of line.spans) {
    if (x < left + span.width) return span.bg.join(",")
    left += span.width
  }
  return ""
}

/**
 * The panel's rows, top to bottom, and which one holds the cursor. Rows are separated by blank lines (a
 * worktree line follows its row directly). The cursor row shows the ✕, or the highlight fill once the
 * keyboard has moved it; Parked headings have no ✕.
 */
function panelRows(frame: Frame) {
  const start = COLS - PANEL_COLS
  const texts = screen(frame)
    .split("\n")
    .map((line) => Array.from(line).slice(start).join(""))
  const surface = background(frame.lines[0]!, COLS - 2)
  const rows = texts
    .map((text, y) => ({ text, y }))
    .filter(({ text, y }) => text.trim() && !texts[y - 1]?.trim() && !text.includes("? help"))
  const cursor = rows.findIndex(
    ({ text, y }) => text.includes("✕") || background(frame.lines[y]!, COLS - 2) !== surface,
  )
  return { rows: rows.map((row) => row.text), cursor }
}

const git = (cwd: string, ...args: string[]) => {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Demo",
      GIT_AUTHOR_EMAIL: "demo@example.com",
      GIT_COMMITTER_NAME: "Demo",
      GIT_COMMITTER_EMAIL: "demo@example.com",
    },
  })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`)
}

export default OpenCodeDriver.use(
  {
    // Run through `bun run record`, which drops inherited OPENCODE_* variables: an inherited CLI config
    // would add the recording machine's own TUI plugins to the demo.
    opencode: { command: ["opencode"] },
    project: { name: "orbit-web", git: true, files: { "README.md": "# orbit-web\n" } },
    config: {
      plugins: [repo],
      model: "simulation/opus-5-5",
      providers: { simulation: { name: "Anthropic", models: { "opus-5-5": { name: "Opus 5.5" } } } },
      // Approvals need a rule that asks; the simulation otherwise allows commands.
      permissions: [{ action: "shell", resource: "*", effect: "ask" }],
    } as never,
    tuiConfig: {
      plugins: [{ package: repo }],
      tabs: { mode: "off" },
      // The switchboard takes the right side; OpenCode's own sidebar would compete for it.
      session: { sidebar: "hide" },
      theme: { name: "tokyonight", mode: "dark" },
      mouse: true,
    } as never,
    tui: { viewport: { cols: COLS, rows: ROWS }, recording: true, keypressOverlay: true },
    // Set to true to keep the sandbox (logs, config, projects) for debugging a take.
    keepArtifacts: false,
  },
  (driver) =>
    Effect.gen(function* () {
      // Running replies stay open until `stop`; release them however the script ends, so the drive can settle.
      const stop = yield* Deferred.make<void>()
      yield* script(driver, stop).pipe(
        Effect.tapCause((cause) =>
          Effect.sync(() => console.error("Demo script failed:\n" + Cause.pretty(cause))),
        ),
        Effect.ensuring(Deferred.succeed(stop, undefined)),
      )
    }),
)

function script(
  { ui, llm, tui, directory, environment }: Parameters<Parameters<typeof OpenCodeDriver.use>[1]>[0],
  stop: Deferred.Deferred<void>,
) {
  return Effect.gen(function* () {
    const root = resolve(directory, "..")
    const location = (project: DemoProject, session?: DemoSession) =>
      session?.worktree ? join(root, ".worktrees", project.name, session.worktree) : join(root, project.name)
    const step = Effect.sleep(STEP)
    const hold = (duration: Parameters<typeof Effect.sleep>[0]) => Effect.sleep(duration)
    const press = (key: string, modifiers?: { ctrl?: boolean }) =>
      ui.press(key, modifiers).pipe(Effect.andThen(step))
    /** Walks the panel cursor to the first row containing `title` (after the row containing `after`). */
    const moveTo = (title: string, after?: string) =>
      Effect.gen(function* () {
        const { rows, cursor } = panelRows(yield* ui.capture())
        const from = after ? rows.findIndex((row) => row.includes(after)) : -1
        const target = rows.findIndex((row, index) => index > from && row.includes(title))
        if (cursor < 0 || target < 0)
          return yield* Effect.die(
            new Error(`Cannot move to "${title}" (cursor ${cursor}):\n${rows.join("\n")}`),
          )
        for (let index = 0; index < Math.abs(target - cursor); index++)
          yield* ui.arrow(target > cursor ? "down" : "up").pipe(Effect.andThen(step))
      })
    const mark = (label: string) => tui.recording!.mark(label)
    // `ui.waitFor` matches whole elements; poll the screen for text anywhere on it.
    const expect = (text: string) =>
      Effect.gen(function* () {
        const deadline = Date.now() + 10_000
        for (;;) {
          const frame = screen(yield* ui.capture())
          if (frame.includes(text)) return
          if (Date.now() > deadline)
            return yield* Effect.die(new Error(`"${text}" never appeared:\n${frame}`))
          yield* Effect.sleep("100 millis")
        }
      })

    // The simulated model answers each session by its prompt. Running replies stay open until `stop`.
    const all = projects.flatMap((project) => project.sessions)
    yield* llm.serve((request) => {
      const body = JSON.stringify(request)
      if (body.includes("You name conversations")) return Stream.make(Llm.text("Untitled"))
      const session = all.reduce<DemoSession | undefined>(
        (found, item) =>
          body.lastIndexOf(item.prompt) > (found ? body.lastIndexOf(found.prompt) : -1) ? item : found,
        undefined,
      )
      if (!session) return Stream.make(Llm.text("Done."))
      if (session.behavior === "running")
        return Stream.concat(
          Stream.make(Llm.text(session.reply, { delay: 30, chunkSize: 6 })),
          Stream.fromEffect(Deferred.await(stop).pipe(Effect.as(Llm.finish("stop")))),
        )
      if (session.behavior === "failed")
        return Stream.make(
          Llm.raw({
            error: { message: "Model overloaded", type: "invalid_request_error", code: "overloaded" },
          }),
        )
      return Stream.make(Llm.text(session.reply, { delay: 10, chunkSize: 24 }))
    })

    // Repositories and the worktree, beside the drive's own project directory.
    for (const project of projects) {
      const path = location(project)
      if (project.name !== "orbit-web") {
        mkdirSync(path, { recursive: true })
        git(path, "init", "-q", "-b", "main")
        writeFileSync(join(path, "README.md"), `# ${project.name}\n`)
        git(path, "add", "-A")
        git(path, "commit", "-q", "-m", "init")
      }
      for (const session of project.sessions)
        if (session.worktree) {
          mkdirSync(join(root, ".worktrees", project.name), { recursive: true })
          git(path, "worktree", "add", "-q", "-b", session.worktree, location(project, session))
        }
    }

    const registrations = join(environment.XDG_STATE_HOME!, "opencode")
    const endpoint = yield* Effect.promise(async () => {
      for (const name of ["service-local.json", "service.json", ...readdirSync(registrations)]) {
        const found = await Service.discover({ file: join(registrations, name) }).catch(() => undefined)
        if (found) return found
      }
      throw new Error(`No OpenCode service registration in ${registrations}`)
    })
    const client = OpenCode.make({
      baseUrl: endpoint.url,
      headers: endpoint.auth
        ? { authorization: `Basic ${btoa(`${endpoint.auth.username}:${endpoint.auth.password}`)}` }
        : {},
    })
    const rpc = client.rpc(Switchboard)
    const ids = new Map<string, string>()
    /** Switchboard project keys by project name. */
    const keys = new Map<string, string>()
    const act = (action: Parameters<typeof rpc.act>[0], directory: string) =>
      Effect.promise(() => rpc.act(action, { location: { directory } }))

    // Sessions, their replies, and the questions and approvals they wait on.
    yield* Effect.promise(async () => {
      for (const project of projects)
        for (const session of project.sessions) {
          const created = await client.session.create({
            title: session.title,
            location: { directory: location(project, session) },
          })
          ids.set(session.title, created.id)
          await client.session.prompt({ sessionID: created.id, text: session.prompt })
        }
      await Bun.sleep(3000)
      for (const project of projects)
        for (const session of project.sessions) {
          const sessionID = ids.get(session.title)!
          if (session.behavior === "question")
            await client.session.form.create({
              sessionID,
              title: session.title,
              fields: [
                {
                  key: "choice",
                  type: "string",
                  title: "Your call",
                  options: [
                    { value: "a", label: "Option A" },
                    { value: "b", label: "Option B" },
                  ],
                },
              ],
            } as never)
          if (session.behavior === "approval")
            await client.permission.create({ sessionID, action: "shell", resources: ["pnpm db:migrate"] })
        }
    })

    // The switchboard as it looks after a day of work. `place` lists a session without opening it,
    // and new arrivals go first, so each project is listed bottom-up.
    for (const project of projects) {
      for (const session of [...project.sessions].reverse()) {
        const sessionID = ids.get(session.title)!
        const directory = location(project, session)
        yield* act({ type: "place", sessionID, placement: session.parked ? "parked" : "active" }, directory)
        if (session.behavior === "read") {
          const info = yield* Effect.promise(() => client.session.get({ sessionID }))
          yield* act({ type: "read", sessionID, observed: info.time.idle ?? 0 }, directory)
        }
      }
      const snapshot = yield* Effect.promise(() =>
        rpc.snapshot({}, { location: { directory: location(project) } }),
      )
      const key = Object.keys(snapshot.projects).find((key) => snapshot.projects[key]!.name === project.name)!
      if (project.folded) yield* act({ type: "collapse", key }, location(project))
      keys.set(project.name, key)
    }
    // Pre-roll, trimmed from the video. A newly started TUI does not follow remote selections, so open the
    // starting session through Ctrl+O, narrow the panel to side-tab width, then close it.
    yield* ui.press("o", { ctrl: true })
    yield* expect("Search")
    yield* ui.type(CURRENT)
    yield* hold("800 millis")
    yield* ui.press("return")
    yield* expect("The flake is gone.")
    // Focus returns to the conversation just after the dialog closes; a leader key pressed sooner is lost.
    yield* hold("2 seconds")
    yield* ui.press("x", { ctrl: true })
    yield* ui.press("i")
    yield* expect("nebula-api/")
    const divider = COLS - Math.floor(COLS / 2) - 1
    yield* ui.mouse({ action: "down", x: divider, y: 10, button: "left" })
    yield* ui.mouse({ action: "move", x: COLS - PANEL_COLS - 1, y: 10 })
    yield* ui.mouse({ action: "up", x: COLS - PANEL_COLS - 1, y: 10, button: "left" })
    // Park the pointer off the panel so it does not hover a row.
    yield* ui.mouse({ action: "move", x: 0, y: ROWS - 1 })
    yield* hold("400 millis")
    yield* ui.press("escape")
    // Fold the Parked sections that start folded. Setting the fold, rather than toggling it, leaves it
    // folded whether or not opening the starting session changed it.
    for (const project of projects)
      if (project.parkedFolded)
        yield* act({ type: "fold", key: parkedKey(keys.get(project.name)!), folded: true }, location(project))
    yield* hold("1500 millis")

    // 1. Open it: projects grouped, every state, a folded project's badges, and the Parked count.
    yield* mark("open")
    yield* hold("1 second")
    yield* press("x", { ctrl: true })
    yield* press("i")
    yield* hold("2500 millis")

    // 2. Park a session (the Parked count goes up), open Parked, and unpark one.
    yield* mark("parked")
    yield* moveTo("Bump Next.js to 16")
    yield* hold("300 millis")
    yield* press("p")
    yield* hold("1300 millis")
    yield* moveTo("Parked", "orbit-web/")
    yield* press("return")
    yield* hold("1300 millis")
    yield* moveTo("Audit bundle size")
    yield* press("p")
    yield* hold("1500 millis")

    // 3. Mark a session unread, then read again.
    yield* mark("unread")
    yield* moveTo(CURRENT)
    yield* press("u")
    yield* hold("1200 millis")
    yield* press("u")
    yield* hold("1000 millis")

    // 4. Fold a project: its sessions' states roll up into badges.
    yield* mark("folded")
    yield* moveTo("nebula-api/")
    yield* press("return")
    yield* hold("2200 millis")
    yield* press("return")
    yield* hold("1500 millis")
    yield* mark("end")

    yield* Deferred.succeed(stop, undefined)
    yield* Effect.promise(async () => {
      for (const session of all)
        if (session.behavior === "running")
          await client.session.interrupt({ sessionID: ids.get(session.title)! })
    })
  })
}
