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

/** The switchboard `catalog` RPC; `get` reads one session and rejects with a not-found error if it is gone. */
export async function readCatalog(
  get: (sessionID: string) => Promise<SessionRecord>,
  input: { sessions: string[]; roots?: string[] },
) {
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
  const [sessions, roots] = await Promise.all([
    Promise.all([...new Set(input.sessions)].map(async (id) => [id, await read(id)] as const)),
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
