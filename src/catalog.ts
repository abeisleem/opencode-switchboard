import type { OpenCodeClient, SessionInfo } from "@opencode/client"
import type { Plugin } from "@opencode/plugin/tui"
import type { Session, State } from "./model"
import { readAttention, type Attention } from "./attention"

/**
 * Whether a row runs, by the native tabs' rule: a session in its family runs or holds a prompt that has not
 * started. OpenCode updates this from live events, while the catalog updates only when it refreshes, so the
 * catalog decides only for families OpenCode has not loaded.
 */
export function liveRunning(data: Plugin.Context["data"]["session"], session: Session) {
  const family = data.family(session.id)
  return (
    [session.id, ...family].some(
      (id) =>
        data.status(id) === "running" || data.pending.list(id).some((item) => item.type !== "synthetic"),
    ) ||
    (family.length === 0 && session.running)
  )
}

export async function loadCatalog(
  client: OpenCodeClient,
  state: State,
  attention = new Map<string, Attention>(),
) {
  const [projects, active] = await Promise.all([client.project.list(), client.session.active()])
  const known = new Map<string, SessionInfo>()
  const roots = new Map<string, SessionInfo>()
  // Hydrate saved working sets in pages, not one HTTP request per saved session.
  for (const [project, roster] of Object.entries(state.projects)) {
    if (!roster.open) continue
    let projectCursor: string | undefined
    do {
      const result = await client.session.list(
        projectCursor
          ? { cursor: projectCursor, limit: 100 }
          : {
              ...(project.startsWith("/") ? { directory: project } : { project }),
              parentID: null,
              archived: false,
              limit: 100,
            },
      )
      for (const session of result.data) {
        known.set(session.id, session)
        roots.set(session.id, session)
      }
      projectCursor = result.cursor.next ?? undefined
    } while (projectCursor)
  }
  async function root(id: string): Promise<SessionInfo> {
    const session = known.get(id) ?? (await client.session.get({ sessionID: id }))
    known.set(id, session)
    if (session.parentID) return root(session.parentID)
    roots.set(session.id, session)
    return session
  }
  const running = new Set<string>()
  for (const id of Object.keys(active)) running.add((await root(id)).id)
  const members = Object.values(state.projects)
    .filter((project) => project.open)
    .flatMap((project) => project.sessions)
  if (state.selected && !known.has(state.selected)) await root(state.selected).catch(() => {})
  const questions = new Set<string>()
  const approvals = new Set<string>()
  const issues: string[] = []
  let stale = 0
  const tracked = new Set(members)
  const directories = [
    ...new Set(
      [...roots.values()]
        .filter((session) => tracked.has(session.id))
        .map((session) => session.location.directory),
    ),
  ]
  // Bound concurrent location reads; never fetch transcripts just to render a row.
  let index = 0
  await Promise.all(
    Array.from({ length: Math.min(4, directories.length) }, async () => {
      while (index < directories.length) {
        const directory = directories[index++]!
        const result = await readAttention(
          () => client.permission.request.list({ location: { directory } }),
          () => client.form.list({ location: { directory } }),
          attention.get(directory),
        )
        attention.set(directory, result)
        if (result.unavailable === "stale") stale++
        if (result.errors.length) issues.push(`${directory}\n${result.errors.join("\n")}`)
        for (const [requests, target] of [
          [result.approvals, approvals],
          [result.questions, questions],
        ] as const) {
          for (const id of requests) {
            try {
              target.add((await root(id)).id)
            } catch (error) {
              if (
                typeof error === "object" &&
                error !== null &&
                "_tag" in error &&
                error._tag === "SessionNotFoundError"
              )
                continue
              stale++
              issues.push(
                `${directory}\nSession ${id}: ${error instanceof Error ? error.message : String(error)}`,
              )
            }
          }
        }
      }
    }),
  )
  const sessions: Session[] = [...roots.values()]
    .filter((session) => !session.time.archived)
    .map((session) => {
      const project = projects.find((project) => project.id === session.projectID)
      const directory = session.location.directory
      const base = project?.canonical ?? directory
      const projectKey = session.projectID === "global" ? directory : session.projectID
      function status(): Session["status"] {
        if (approvals.has(session.id)) return "Approval"
        if (questions.has(session.id)) return "Question"
        if (running.has(session.id)) return "Running"
        if (session.outcome === "failed") return "Error"
        if (session.outcome === "interrupted") return "Interrupted"
        if (session.outcome === "succeeded") return "Ready"
        return "Idle"
      }
      return {
        id: session.id,
        title: session.title || "Untitled session",
        project: projectKey,
        projectName:
          project?.name ||
          (session.projectID === "global" ? directory : base).split("/").filter(Boolean).at(-1) ||
          directory,
        directory,
        detail: directory === base ? "main" : directory,
        idle: session.time.idle ?? 0,
        viewed: session.time.viewed ?? 0,
        running: running.has(session.id),
        status: status(),
        attention: attention.get(directory)?.unavailable,
      }
    })
  return {
    sessions,
    issues,
    warning: stale ? "Attention needs refresh · d details · r retry" : "",
  }
}
