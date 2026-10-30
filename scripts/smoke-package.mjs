// Test what users install: pack the tarball, install its dependencies from the
// registry into a clean directory, then run the real-TUI smoke against that copy.
import { execFileSync } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { fileURLToPath } from "node:url"

const repo = fileURLToPath(new URL("..", import.meta.url))
const root = await mkdtemp("/tmp/opencode/switchboard-package-")
const run = (command, args, options = {}) => execFileSync(command, args, { stdio: "inherit", ...options })
let passed = false
try {
  run("bun", ["run", "build"], { cwd: repo })
  run("bun", ["pm", "pack", "--destination", root, "--quiet"], { cwd: repo })
  // Install the tarball as a dependency of a fresh project, as npm does for a user.
  run("sh", ["-c", "npm init -y >/dev/null && npm install --no-audit --no-fund --loglevel=error ./*.tgz"], {
    cwd: root,
  })
  for (const args of [[], ["session"], ["session", "delete"], ["session", "navigation"]])
    run("node", [`${repo}/scripts/smoke.mjs`, ...args], {
      env: { ...process.env, SWITCHBOARD_PLUGIN: `${root}/node_modules/opencode-switchboard` },
    })
  console.log("Packed package smoke passed")
  passed = true
} finally {
  if (passed) await rm(root, { recursive: true, force: true })
  else console.error("Package smoke files retained at", root)
}
