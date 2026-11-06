import type { OpenCodeClient, SessionInfo } from "@opencode/client"
import type { Plugin } from "@opencode/plugin/tui"
import type { Session, State } from "./model"
import { readAttention, type Attention } from "./attention"

/** Sessions per list request. A shorter page is the last: the server still returns a cursor after it. */
const PAGE = 100
/** Session reads the catalog keeps in flight at once, as many as the attention reads. */
const CONCURRENCY = 8
const SETTLED: Session["status"][] = ["Error", "Interrupted", "Ready", "Idle"]

/**
 * Each project's root-session count as last listed, or one more than listed once a listing stopped early. It
 * decides whether listing the project's roots or reading each tracked one costs less, so callers keep it across
 * refreshes.
 */
export type RootCounts = Map<string, number>

/** Runs at most `max` tasks at once; a finished task hands its slot to the next one waiting. */
function limiter(max: number) {
  let active = 0
  const waiting: (() => void)[] = []
  return async function run<T>(task: () => Promise<T>): Promise<T> {
    if (active < max) active++
    else await new Promise<void>((resolve) => waiting.push(resolve))
    try {
      return await task()
    } finally {
      const next = waiting.shift()
      if (next) next()
      else active--
    }
  }
}

function notFound(error: unknown) {
  return (
    typeof error === "object" && error !== null && "_tag" in error && error._tag === "SessionNotFoundError"
  )
}

function settled(outcome: SessionInfo["outcome"]): Session["status"] {
  if (outcome === "failed") return "Error"
  if (outcome === "interrupted") return "Interrupted"
  if (outcome === "succeeded") return "Ready"
  return "Idle"
}

/**
 * Whether a session family has a pending request: true or false once OpenCode tracks every member's list,
 * otherwise undefined. OpenCode adds a request to a member's list on its event, even before loading the list.
 */
function requested(members: string[], list: (id: string) => readonly unknown[] | undefined) {
  const lists = members.map(list)
  if (lists.some((items) => (items?.length ?? 0) > 0)) return true
  return lists.every((items) => items !== undefined) ? false : undefined
}

/**
 * A row with its indicators read as the native tabs read them, from OpenCode's live session store: requests
 * and activity across the session's family, and its outcome and idle and viewed times. OpenCode updates the
 * store from server events, while the catalog updates only when it refreshes, so catalog values remain only
 * where OpenCode has not loaded the data.
 */
export function liveSession(data: Plugin.Context["data"]["session"], session: Session): Session {
  const family = data.family(session.id)
  const members = [session.id, ...family]
  const info = data.get(session.id)
  const running =
    members.some(
      (id) =>
        data.status(id) === "running" || data.pending.list(id).some((item) => item.type !== "synthetic"),
    ) ||
    (family.length === 0 && session.running)
  const approval = requested(members, (id) => data.permission.list(id)) ?? session.status === "Approval"
  const question = requested(members, (id) => data.form.list(id)) ?? session.status === "Question"
  const status = approval
    ? "Approval"
    : question
      ? "Question"
      : running
        ? "Running"
        : info
          ? settled(info.outcome)
          : SETTLED.includes(session.status)
            ? session.status
            : "Idle"
  const idle = info ? (info.time.idle ?? 0) : session.idle
  const viewed = info ? (info.time.viewed ?? 0) : session.viewed
  if (
    running === session.running &&
    status === session.status &&
    idle === session.idle &&
    viewed === session.viewed
  )
    return session
  return { ...session, running, status, idle, viewed }
}

export async function loadCatalog(
  client: OpenCodeClient,
  state: State,
  attention = new Map<string, Attention>(),
  /** The session this TUI shows, loaded even before its project lists it. */
  current: string | null = null,
  /** Root counts from earlier refreshes; see `RootCounts`. Without them, each project lists one page first. */
  counts: RootCounts = new Map(),
) {
  const run = limiter(CONCURRENCY)
  const known = new Map<string, SessionInfo>()
  const roots = new Map<string, SessionInfo>()
  const reading = new Map<string, Promise<SessionInfo>>()
  /** One session, read once per refresh however many callers want it. */
  function read(id: string): Promise<SessionInfo> {
    const session = known.get(id)
    if (session) return Promise.resolve(session)
    let pending = reading.get(id)
    if (!pending) {
      pending = run(() => client.session.get({ sessionID: id })).then((session) => {
        known.set(id, session)
        return session
      })
      reading.set(id, pending)
    }
    return pending
  }
  function listed(session: SessionInfo) {
    known.set(session.id, session)
    roots.set(session.id, session)
  }
  /**
   * Loads a project's tracked roots: by listing the project's roots in pages while at least half of them are
   * tracked, otherwise by reading each tracked root. A project whose root count is unknown lists one page first.
   * A complete listing is authoritative, as it always was: a tracked session it lacks is archived, moved, or gone.
   */
  async function hydrate(key: string, wanted: string[]) {
    const count = counts.get(key)
    const budget = count === undefined || count <= 2 * wanted.length ? Math.max(PAGE, 2 * wanted.length) : 0
    let total = 0
    let cursor: string | undefined
    while (total < budget) {
      const result = await run(() =>
        client.session.list(
          cursor
            ? { cursor, limit: PAGE }
            : {
                ...(key.startsWith("/") ? { directory: key } : { project: key }),
                parentID: null,
                archived: false,
                limit: PAGE,
              },
        ),
      )
      for (const session of result.data) listed(session)
      total += result.data.length
      cursor = result.cursor.next ?? undefined
      if (!cursor || result.data.length < PAGE) {
        counts.set(key, total)
        return
      }
    }
    // More roots than listed: unless more are tracked by then, the next refresh reads each tracked root instead.
    if (budget) counts.set(key, Math.max(total + 1, count ?? 0))
    await Promise.all(
      wanted
        .filter((id) => !known.has(id))
        .map((id) =>
          read(id).then(
            (session) => {
              // A listing would show only this project's unarchived roots; the rows check the rest.
              if (!session.parentID) roots.set(session.id, session)
            },
            (error) => {
              if (!notFound(error)) throw error
            },
          ),
        ),
    )
  }
  const open = Object.entries(state.projects).filter(([, roster]) => roster.open)
  // Load projects in parallel; `run` bounds the requests in flight.
  const [projects, active] = await Promise.all([
    run(() => client.project.list()),
    run(() => client.session.active()),
    ...open.map(([key, roster]) =>
      roster.sessions.length ? hydrate(key, [...new Set(roster.sessions)]) : null,
    ),
  ])
  async function root(id: string): Promise<SessionInfo> {
    const session = await read(id)
    if (session.parentID) return root(session.parentID)
    roots.set(session.id, session)
    return session
  }
  const running = new Set<string>()
  await Promise.all(Object.keys(active).map(async (id) => running.add((await root(id)).id)))
  if (current && !known.has(current)) await root(current).catch(() => {})
  const questions = new Set<string>()
  const approvals = new Set<string>()
  const issues: string[] = []
  let stale = 0
  /** The open project whose key a root belongs under, whether or not that project lists it. */
  const projectKey = (session: SessionInfo) =>
    session.projectID === "global" ? session.location.directory : session.projectID
  /** Whether a root has a row: tracked and unarchived, in its own open project. */
  function shown(session: SessionInfo) {
    const roster = state.projects[projectKey(session)]
    return !session.time.archived && Boolean(roster?.open && roster.sessions.includes(session.id))
  }
  const directories = [
    ...new Set([...roots.values()].filter(shown).map((session) => session.location.directory)),
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
              if (notFound(error)) continue
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
  // Sorted, as parallel reads finish in any order: an unchanged catalog must compare equal across refreshes.
  const sessions: Session[] = [...roots.values()]
    .filter((session) => !session.time.archived)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((session) => {
      const project = projects.find((project) => project.id === session.projectID)
      const directory = session.location.directory
      const base = project?.canonical ?? directory
      function status(): Session["status"] {
        if (approvals.has(session.id)) return "Approval"
        if (questions.has(session.id)) return "Question"
        if (running.has(session.id)) return "Running"
        return settled(session.outcome)
      }
      return {
        id: session.id,
        title: session.title || "Untitled session",
        project: projectKey(session),
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
    warning: stale ? "Attention unavailable · click for details" : "",
  }
}
