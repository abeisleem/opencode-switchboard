// Published TUI part: a Solid-compiled bundle of src/tui.tsx. A .tsx file inside
// node_modules is not compiled for Solid by the host, so the package ships dist/tui.js.
// Host-provided packages and regular dependencies stay external.
import solid from "@opentui/solid/bun-plugin"
import { rm } from "node:fs/promises"
import path from "node:path"

const root = path.resolve(import.meta.dir, "..")
await rm(path.join(root, "dist"), { recursive: true, force: true })
const result = await Bun.build({
  entrypoints: [path.join(root, "src/tui.tsx")],
  outdir: path.join(root, "dist"),
  naming: "tui.js",
  target: "bun",
  format: "esm",
  plugins: [solid],
  external: ["@opencode/*", "@opentui/*", "solid-js", "solid-js/*", "zod"],
})
if (!result.success) throw new AggregateError(result.logs, "Build failed")
console.log(`Built dist/tui.js (${result.outputs[0]?.size} bytes)`)
