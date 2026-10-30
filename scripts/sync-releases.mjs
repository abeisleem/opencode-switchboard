import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { setTimeout as delay } from "node:timers/promises"
import { pathToFileURL } from "node:url"

export function releaseNotes(changelog) {
  const notes = new Map()
  for (const section of changelog.split(/^## /m).slice(1)) {
    const newline = section.indexOf("\n")
    const version = section.slice(0, newline).match(/^(\d+\.\d+\.\d+(?:-[\w.-]+)?)\s/)?.[1]
    if (!version) continue
    const body = section.slice(newline + 1).trim()
    if (!body || notes.has(version)) throw new Error(`Empty or duplicate changelog entry: ${version}`)
    notes.set(version, body)
  }
  return notes
}

export function releasePlan(name, registry, notes, tags) {
  return Object.keys(registry.versions).flatMap((version) => {
    const tag = `v${version}`
    // npm's initial staging placeholder has no source tag and is not a repository release.
    if (!tags.has(tag)) return []
    if (!notes.has(version)) throw new Error(`Missing changelog entry for published tag ${tag}`)
    return [
      {
        tag,
        body: `${notes.get(version)}\n\n---\n\nnpm: [${name}@${version}](https://www.npmjs.com/package/${name}/v/${version})\n`,
        prerelease: version.includes("-"),
        latest: registry["dist-tags"].latest === version,
      },
    ]
  })
}

export async function publishedRegistry(read, version, { attempts = 61, wait = () => delay(15_000) } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const registry = await read()
    if (!version || Object.hasOwn(registry.versions, version)) return registry
    if (attempt + 1 < attempts) await wait()
  }
  throw new Error(`npm has not exposed ${version} yet. Retry release sync; do not publish again.`)
}

export function syncReleases(plan, existing, gh) {
  for (const release of plan) {
    const current = existing.find((item) => item.tag_name === release.tag)
    if (
      current?.name === release.tag &&
      current.body === release.body &&
      current.prerelease === release.prerelease &&
      !current.draft
    )
      continue
    gh(
      [
        "release",
        current ? "edit" : "create",
        release.tag,
        "--verify-tag",
        "--title",
        release.tag,
        "--notes-file",
        "-",
        `--prerelease=${release.prerelease}`,
        "--latest=false",
        ...(current ? ["--draft=false"] : []),
      ],
      release.body,
    )
  }
  const latest = plan.find((release) => release.latest && !release.prerelease)
  if (latest) gh(["release", "edit", latest.tag, "--verify-tag", "--latest"])
}

function command(program, args, input) {
  return execFileSync(program, args, { encoding: "utf8", input, stdio: ["pipe", "pipe", "inherit"] })
}

async function main() {
  const { name } = JSON.parse(readFileSync("package.json", "utf8"))
  const notes = releaseNotes(readFileSync("CHANGELOG.md", "utf8"))
  const tags = new Set(command("git", ["tag", "--list"]).trim().split("\n"))
  const version = (process.env.RELEASE_VERSION ?? "").replace(/^v/, "")
  if (version && (!tags.has(`v${version}`) || !notes.has(version)))
    throw new Error(`Push tag v${version} and merge its changelog entry before synchronizing releases`)
  const registry = await publishedRegistry(async () => {
    const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`, {
      headers: { "Cache-Control": "no-cache" },
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status}`)
    return response.json()
  }, version)
  const plan = releasePlan(name, registry, notes, tags)
  if (process.argv.includes("--dry-run")) {
    console.log(JSON.stringify(plan, null, 2))
    return
  }
  const repo =
    process.env.GH_REPO ||
    command("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]).trim()
  const existing = JSON.parse(
    command("gh", ["api", "--paginate", "--slurp", `repos/${repo}/releases?per_page=100`]),
  ).flat()
  syncReleases(plan, existing, (args, body) => {
    console.log(command("gh", [...args, "--repo", repo], body).trim() || args.join(" "))
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
