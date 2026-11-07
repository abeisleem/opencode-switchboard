import type { CatalogSession } from "./rpc"

/** Runs at most `max` tasks at once; a finished task hands its slot to the next one waiting. */
export function limiter(max: number) {
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

/**
 * Whether a session read failed because the session does not exist: `SessionNotFoundError` over HTTP,
 * `Session.NotFoundError` in-process on the server.
 */
export function notFound(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    (error._tag === "SessionNotFoundError" || error._tag === "Session.NotFoundError")
  )
}

/** The session fields `catalog` reads, as both OpenCode's server and its client return them. */
export type SessionRecord = {
  id: string
  parentID?: string
  projectID: string
  title?: string
  outcome?: CatalogSession["outcome"]
  location: { directory: string }
  time: { idle?: number; viewed?: number; archived?: number }
}

/**
 * A session's row fields. Absent ones are left out, not set to undefined: OpenCode's RPC encodes only JSON
 * values, and fails the whole response on an undefined one.
 */
export function catalogSession(session: SessionRecord): CatalogSession {
  const row: CatalogSession = {
    id: session.id,
    projectID: session.projectID,
    directory: session.location.directory,
  }
  if (session.title !== undefined) row.title = session.title
  if (session.outcome !== undefined) row.outcome = session.outcome
  if (session.time.idle !== undefined) row.idle = session.time.idle
  if (session.time.viewed !== undefined) row.viewed = session.time.viewed
  if (session.time.archived !== undefined) row.archived = session.time.archived
  return row
}

/** Server reads in flight at once: each is one in-process database read. */
const CONCURRENCY = 16
/** Parent links followed at most, so a corrupt chain cannot loop. */
const DEPTH = 64
/**
 * In-process, one session read costs about as much as listing 7 more rows. A project is listed while it has at
 * most this many roots per tracked session; past that, its tracked sessions are read one by one.
 */
const LIST_RATIO = 4

/** How the server part reads sessions in-process: `ctx.session` of the server plugin. */
export type SessionReader = {
  /** Rejects with a not-found error if the session is gone. */
  get: (sessionID: string) => Promise<SessionRecord>
  list?: (input: {
    project?: string
    directory?: string
    parentID: null
    limit: number
  }) => Promise<{ data: readonly SessionRecord[] }>
}

/**
 * For each project key, the number of tracked sessions it had when listing it found more roots than
 * `LIST_RATIO` allows. The project is read session by session until it has more tracked sessions than that.
 */
export type ListMemory = Map<string, number>

/**
 * The switchboard `catalog` RPC. `projects` groups the requested sessions by the project key that tracks them
 * (from the saved state); a project of mostly tracked roots is listed, the rest are read one by one.
 */
export async function readCatalog(
  reader: SessionReader | SessionReader["get"],
  input: { sessions: string[]; roots?: string[] },
  projects: [key: string, sessions: string[]][] = [],
  memory: ListMemory = new Map(),
) {
  const { get, list } = typeof reader === "function" ? { get: reader, list: undefined } : reader
  const run = limiter(CONCURRENCY)
  const reads = new Map<string, Promise<SessionRecord | undefined>>()
  function read(id: string) {
    let pending = reads.get(id)
    if (!pending) {
      pending = run(() => get(id)).catch((error: unknown) => {
        if (notFound(error)) return undefined
        throw error
      })
      reads.set(id, pending)
    }
    return pending
  }
  async function root(id: string) {
    let session = await read(id)
    for (let depth = 0; session?.parentID && depth < DEPTH; depth++) session = await read(session.parentID)
    return session && !session.parentID ? session : undefined
  }
  const wanted = [...new Set(input.sessions)]
  if (list) {
    const requested = new Set(wanted)
    await Promise.all(
      projects.map(async ([key, members]) => {
        const tracked = [...new Set(members)].filter((id) => requested.has(id))
        if (!tracked.length || (memory.get(key) ?? 0) >= tracked.length) return
        // One more than allowed tells a project with too many roots apart; archived roots count, and are kept.
        const limit = LIST_RATIO * tracked.length + 1
        const page = await run(() =>
          list({ ...(key.startsWith("/") ? { directory: key } : { project: key }), parentID: null, limit }),
        )
        if (page.data.length >= limit) memory.set(key, tracked.length)
        else memory.delete(key)
        // Listed sessions need no read; tracked ones the list lacks are read, and reported missing if gone.
        for (const session of page.data)
          if (!reads.has(session.id)) reads.set(session.id, Promise.resolve(session))
      }),
    )
  }
  const [sessions, roots] = await Promise.all([
    Promise.all(wanted.map(async (id) => [id, await read(id)] as const)),
    Promise.all([...new Set(input.roots ?? [])].map(async (id) => [id, await root(id)] as const)),
  ])
  return {
    sessions: sessions.flatMap(([, session]) =>
      session && !session.parentID ? [catalogSession(session)] : [],
    ),
    missing: sessions.flatMap(([id, session]) => (session && !session.parentID ? [] : [id])),
    roots: Object.fromEntries(roots.flatMap(([id, session]) => (session ? [[id, session.id]] : []))),
  }
}
