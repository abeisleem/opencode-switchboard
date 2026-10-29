import solid from "@opentui/solid/bun-plugin"
import { mkdir } from "node:fs/promises"
import path from "node:path"

const root = path.resolve(import.meta.dir, "..")
const destination = path.join(root, "artifacts/client")
await mkdir(destination, { recursive: true })

// A self-contained TUI bundle (no node_modules) used by `smoke:client` to test a packaged client.
// Share the host's renderer/reactivity; bundle everything else (including Zod).
const result = await Bun.build({
  entrypoints: [path.join(root, "src/tui.tsx")],
  outdir: destination,
  naming: "tui.js",
  target: "bun",
  format: "esm",
  plugins: [solid],
  external: [
    "@opencode/plugin/tui",
    "@opentui/core",
    "@opentui/solid",
    "@opentui/solid/*",
    "solid-js",
    "solid-js/*",
  ],
})
if (!result.success) throw new AggregateError(result.logs, "Client bundle failed")
await Bun.write(
  path.join(destination, "package.json"),
  JSON.stringify(
    {
      name: "opencode-inbox-client",
      version: "0.1.0",
      private: true,
      type: "module",
      exports: { "./tui": "./tui.js" },
    },
    null,
    2,
  ) + "\n",
)
console.log(`Client package ready: ${destination} (${result.outputs[0]?.size} bytes of bundled code)`)
