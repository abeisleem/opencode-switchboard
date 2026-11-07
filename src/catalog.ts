import type { OpenCodeClient, SessionInfo } from "@opencode/client"
import type { Plugin } from "@opencode/plugin/tui"
import type { Session, State } from "./model"
import { readAttention, type Attention } from "./attention"
import { Switchboard, type CatalogSession } from "./rpc"
import { catalogSession, limiter, notFound } from "./sessions"

/** Sessions per list request. A shorter page is the last: the server still returns a cursor after it. */
const PAGE = 100
/** Requests the catalog keeps in flight at once, as many as the attention reads. */
const CONCURRENCY = 8
const SETTLED: Session["status"][] = ["Error", "Interrupted", "Ready", "Idle"]

/** What one refresh leaves for the next. The caller passes the same object to every refresh. */
export type CatalogMemory = {
  /**
   * Where the switchboard's server part answers its RPC. With it, one `catalog` call reads the tracked sessions;
   * without it, the catalog lists each open project's roots, as 0.2.1 did.
   */
  location?: { directory: string }
  /** The server part has no `catalog` method (older than 0.2.2). Clear it to ask again, e.g. after a reconnect. */
  legacy?: boolean
  /**
   * Tracked IDs that name no root session: deleted, or a subagent. Neither ever becomes a root again, so later
   * refreshes stop asking for them. Their rows were never shown.
   */
  gone?: Set<string>
}

/** A session as the catalog keeps it: the row fields, and its parent while it is a subagent. */
type Info = CatalogSession & { parentID?: string }

function info(session: SessionInfo): Info {
  return { ...catalogSession(session), parentID: session.parentID }
}

function rpcFailure(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("type" in error) || typeof error.type !== "string")
    return
  return error.type.startsWith("rpc.") ? error.type : undefined
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
  memory: CatalogMemory = {},
) {
  const gone = (memory.gone ??= new Set())
  const run = limiter(CONCURRENCY)
  /** Sessions read this refresh, roots or not. */
  const known = new Map<string, Info>()
  /** The root sessions the catalog returns. */
  const roots = new Map<string, Info>()
  /** Requested IDs the server part reported as no root session: deleted, never created, or a subagent. */
  const missing = new Set<string>()
  const open = Object.entries(state.projects).filter(([, roster]) => roster.open)
  const tracked = [...new Set(open.flatMap(([, roster]) => roster.sessions))].filter((id) => !gone.has(id))
  const trackedSet = new Set(tracked)

  /**
   * Calls the server part's `catalog` method; undefined when it cannot answer. An older server part lacks the
   * method, which `memory` then remembers. Any other RPC failure falls back for this call only; a lost connection
   * rejects, as every other read would.
   */
  async function remote(input: { sessions: string[]; roots?: string[] }) {
    const location = memory.location
    if (!location || memory.legacy) return
    try {
      return await run(() => client.rpc(Switchboard).catalog(input, { location }))
    } catch (error) {
      const failure = rpcFailure(error)
      if (!failure) throw error
      if (failure === "rpc.method_not_found") memory.legacy = true
      return
    }
  }

  const reading = new Map<string, Promise<Info>>()
  /** One session through OpenCode's session API, read once per refresh however many callers want it. */
  function read(id: string): Promise<Info> {
    const session = known.get(id)
    if (session) return Promise.resolve(session)
    let pending = reading.get(id)
    if (!pending) {
      pending = run(() => client.session.get({ sessionID: id })).then((session) => {
        const result = info(session)
        known.set(id, result)
        return result
      })
      reading.set(id, pending)
    }
    return pending
  }
  async function root(id: string): Promise<Info> {
    const session = await read(id)
    if (session.parentID) return root(session.parentID)
    roots.set(session.id, session)
    return session
  }
  function add(session: Info) {
    known.set(session.id, session)
    roots.set(session.id, session)
  }

  /**
   * Without the RPC, lists a project's roots in pages, as 0.2.1 did; a short page is the last. The listing is
   * authoritative: a tracked session it lacks is archived, moved, or gone, and has no row.
   */
  async function list(key: string) {
    let cursor: string | undefined
    for (;;) {
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
      for (const session of result.data) add(info(session))
      cursor = result.cursor.next ?? undefined
      if (!cursor || result.data.length < PAGE) return
    }
  }
  /** The tracked sessions of open projects and the current one: in one RPC, else by listing each project. */
  async function load() {
    const wanted = current && !trackedSet.has(current) ? [...tracked, current] : tracked
    const result = wanted.length ? await remote({ sessions: wanted }) : undefined
    if (result) {
      for (const session of result.sessions) add(session)
      for (const id of result.missing) {
        missing.add(id)
        if (trackedSet.has(id)) gone.add(id)
      }
      return
    }
    // Load projects in parallel; `run` bounds the requests in flight. A project tracking nothing has no rows.
    await Promise.all(open.map(([key, roster]) => (roster.sessions.length ? list(key) : null)))
  }
  /**
   * The root session ID of each of `ids`, leaving out an ID whose session is gone, and the errors of reads that
   * failed otherwise. Sessions this refresh already read as roots cost nothing; the rest take one RPC.
   */
  async function rootsOf(ids: string[]) {
    const result = new Map<string, string>()
    const failed = new Map<string, unknown>()
    const unknown: string[] = []
    for (const id of new Set(ids)) {
      const session = known.get(id)
      if (session && !session.parentID) result.set(id, id)
      else if (!missing.has(id)) unknown.push(id)
    }
    if (!unknown.length) return { result, failed }
    let answer: Awaited<ReturnType<typeof remote>>
    try {
      answer = await remote({ sessions: [], roots: unknown })
    } catch (error) {
      for (const id of unknown) failed.set(id, error)
      return { result, failed }
    }
    if (answer) {
      for (const [id, rootID] of Object.entries(answer.roots)) result.set(id, rootID)
      return { result, failed }
    }
    await Promise.all(
      unknown.map(async (id) => {
        try {
          result.set(id, (await root(id)).id)
        } catch (error) {
          if (!notFound(error)) failed.set(id, error)
        }
      }),
    )
    return { result, failed }
  }

  const [projects, active] = await Promise.all([
    run(() => client.project.list()),
    run(() => client.session.active()),
    load(),
  ])
  const actives = await rootsOf(Object.keys(active))
  if (actives.failed.size) throw actives.failed.values().next().value
  const running = new Set(actives.result.values())
  if (current && !known.has(current) && !missing.has(current)) await root(current).catch(() => {})
  const questions = new Set<string>()
  const approvals = new Set<string>()
  const issues: string[] = []
  let stale = 0
  /** The open project whose key a root belongs under, whether or not that project lists it. */
  const projectKey = (session: Info) =>
    session.projectID === "global" ? session.directory : session.projectID
  /** Whether a root has a row: tracked and unarchived, in its own open project. */
  function shown(session: Info) {
    const roster = state.projects[projectKey(session)]
    return !session.archived && Boolean(roster?.open && roster.sessions.includes(session.id))
  }
  const directories = [...new Set([...roots.values()].filter(shown).map((session) => session.directory))]
  // Bound concurrent location reads; never fetch transcripts just to render a row.
  const reads: [string, Attention][] = []
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
        reads.push([directory, result])
        if (result.unavailable === "stale") stale++
        if (result.errors.length) issues.push(`${directory}\n${result.errors.join("\n")}`)
      }
    }),
  )
  // The sessions with requests are often subagents: resolve all their roots at once.
  const requesters = await rootsOf(reads.flatMap(([, result]) => [...result.approvals, ...result.questions]))
  for (const [directory, result] of reads) {
    for (const [requests, target] of [
      [result.approvals, approvals],
      [result.questions, questions],
    ] as const) {
      for (const id of requests) {
        const rootID = requesters.result.get(id)
        if (rootID) target.add(rootID)
        const error = requesters.failed.get(id)
        if (error === undefined) continue
        stale++
        issues.push(`${directory}\nSession ${id}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  // Sorted, as parallel reads finish in any order: an unchanged catalog must compare equal across refreshes.
  const sessions: Session[] = [...roots.values()]
    .filter((session) => !session.archived)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((session) => {
      const project = projects.find((project) => project.id === session.projectID)
      const directory = session.directory
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
        idle: session.idle ?? 0,
        viewed: session.viewed ?? 0,
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
