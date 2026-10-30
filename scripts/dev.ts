// Starts OpenCode in this checkout with the switchboard loaded from source.
//
// The TUI keeps one plugin per id and later sources win: discovered `.opencode/plugins`,
// then the server's list, then `cli.json`. A published `opencode-switchboard` in the global
// `cli.json` therefore replaces the dev copy. OPENCODE_CLI_CONFIG_CONTENT replaces the
// `plugins` array for this run only, so it repeats the global list without that entry.
import { homedir } from "node:os"
import { join } from "node:path"

// The runtime has Bun.JSONC; the pinned @types/bun predates it.
const { JSONC } = Bun as unknown as { JSONC: { parse(text: string): { plugins?: unknown } } }
const NAME = "opencode-switchboard"
const file = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode", "cli.json")
const source = Bun.file(file)
const config = (await source.exists()) ? JSONC.parse(await source.text()) : {}
const entries: unknown[] = Array.isArray(config?.plugins) ? config.plugins : []
const name = (entry: unknown) =>
  typeof entry === "string" ? entry : ((entry as { package?: string } | null)?.package ?? "")
// Drops the bare name and pinned versions (`opencode-switchboard@0.1.0`).
const plugins = entries.filter((entry) => name(entry).replace(/(?<=.)@.*$/, "") !== NAME)

const child = Bun.spawn(["opencode", ...process.argv.slice(2)], {
  cwd: join(import.meta.dir, ".."),
  env: { ...process.env, OPENCODE_CLI_CONFIG_CONTENT: JSON.stringify({ plugins }) },
  stdio: ["inherit", "inherit", "inherit"],
})
process.exit(await child.exited)
