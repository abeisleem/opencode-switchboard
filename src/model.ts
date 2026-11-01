import { z } from "zod"

export const placement = z.enum(["active", "parked"])
export const sessionStateSchema = z.object({
  placement: placement.default("active"),
  unread: z.boolean().default(false),
  seen: z.number().optional(),
})
const projectKey = z
  .string()
  .min(1)
  .refine((key) => !Object.hasOwn(Object.prototype, key), "Invalid project key")
export const stateSchema = z.object({
  version: z.literal(4),
  revision: z.number(),
  navigation: z.number(),
  selected: z.string().nullable(),
  recent: z.array(z.string()),
  collapsed: z.array(z.string()),
  projects: z
    .record(
      projectKey,
      z.object({
        name: z.string(),
        open: z.boolean(),
        sessions: z.array(z.string()),
      }),
    )
    .default({}),
  sessions: z.record(z.string(), sessionStateSchema),
})
export type State = z.infer<typeof stateSchema>
export type Placement = z.infer<typeof placement>

export const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("select"), sessionID: z.string(), observed: z.number().nonnegative() }),
  z.object({ type: z.literal("read"), sessionID: z.string(), observed: z.number().nonnegative() }),
  z.object({ type: z.literal("unread"), sessionID: z.string() }),
  z.object({
    type: z.literal("place"),
    sessionID: z.string(),
    // Also accepts "later", the placement's name before Parked, from TUIs older than 0.1.5. OpenCode hands the
    // handler the parsed value, so "later" is never stored. Remove the alias in the release after 0.1.5.
    placement: z
      .enum([...placement.options, "later"])
      .transform((value): Placement => (value === "later" ? "parked" : value)),
  }),
  z.object({ type: z.literal("collapse"), key: z.string() }),
  // Sets a fold instead of toggling it, so key repeat or a second client can never cycle a heading.
  z.object({ type: z.literal("fold"), key: z.string(), folded: z.boolean() }),
  z.object({ type: z.literal("project-open"), project: projectKey, name: z.string().min(1) }),
  z.object({ type: z.literal("project-close"), project: projectKey }),
  z.object({ type: z.literal("session-remove"), sessionID: z.string() }),
])
export type Action = z.infer<typeof actionSchema>

export type Session = {
  id: string
  title: string
  project: string
  projectName: string
  directory: string
  detail: string
  idle: number
  viewed: number
  running: boolean
  attention?: "missing" | "stale"
  status: "Running" | "Queued" | "Question" | "Approval" | "Ready" | "Interrupted" | "Error" | "Idle"
}

export function initialState(): State {
  return {
    version: 4,
    revision: 0,
    navigation: 0,
    selected: null,
    recent: [],
    collapsed: [],
    sessions: {},
    projects: {},
  }
}

export type Admission = { project: string; name: string; sessions: string[] }

/** A project's Parked fold. The prefix keeps it from equaling a project key, which may be a directory path. */
export const parkedKey = (project: string) => `parked:${project}`

export function workingSet(sessions: Session[], state: State) {
  const catalog = new Map(sessions.map((session) => [session.id, session]))
  return Object.entries(state.projects).flatMap(([key, project]) =>
    !project.open
      ? []
      : project.sessions.flatMap((id) => {
          const session = catalog.get(id)
          return session?.project === key ? [session] : []
        }),
  )
}

/** The open project listing a session, if any. */
export function projectOf(state: State, sessionID: string) {
  return Object.entries(state.projects).find(
    ([, project]) => project.open && project.sessions.includes(sessionID),
  )?.[0]
}

export function reduce(state: State, action: Action, admission?: Admission): State {
  // A fold already in the requested state changes nothing: return the same state, which the store does not save.
  if (action.type === "fold" && action.folded === state.collapsed.includes(action.key)) return state
  const next = structuredClone(state)
  next.revision++
  if (admission) {
    const admitted = new Set(admission.sessions)
    for (const [key, project] of Object.entries(next.projects)) {
      if (key !== admission.project) project.sessions = project.sessions.filter((id) => !admitted.has(id))
    }
    const project = (next.projects[admission.project] ??= { name: admission.name, open: true, sessions: [] })
    project.open = true
    project.name = admission.name
    // Newly admitted work goes first. Existing members never move, so revisiting
    // a row does not reorder its section.
    const members = new Set(project.sessions)
    project.sessions = [...new Set(admission.sessions.filter((id) => !members.has(id))), ...project.sessions]
    next.collapsed = next.collapsed.filter((key) => key !== admission.project)
  }
  function goBack(exclude: string) {
    const open = new Set(
      Object.values(next.projects)
        .filter((project) => project.open)
        .flatMap((project) => project.sessions),
    )
    open.delete(exclude)
    // History is bounded; an open session can outlive its entry in recent.
    next.selected = next.recent.find((id) => open.has(id)) ?? open.values().next().value ?? null
    if (next.selected)
      next.recent = [next.selected, ...next.recent.filter((id) => id !== next.selected)].slice(0, 50)
    next.navigation++
  }
  if (action.type === "project-open") {
    const project = next.projects[action.project]
    if (project) project.open = true
    next.collapsed = next.collapsed.filter((key) => key !== action.project)
    return next
  }
  if (action.type === "project-close") {
    const project = next.projects[action.project]
    if (!project) return next
    project.open = false
    if (next.selected && project.sessions.includes(next.selected)) goBack(next.selected)
    return next
  }
  if (action.type === "session-remove") {
    for (const project of Object.values(next.projects))
      project.sessions = project.sessions.filter((id) => id !== action.sessionID)
    if (next.selected === action.sessionID) goBack(action.sessionID)
    return next
  }
  if (action.type === "collapse") {
    next.collapsed = next.collapsed.includes(action.key)
      ? next.collapsed.filter((key) => key !== action.key)
      : [...next.collapsed, action.key]
    return next
  }
  if (action.type === "fold") {
    const others = next.collapsed.filter((key) => key !== action.key)
    next.collapsed = action.folded ? [...others, action.key] : others
    return next
  }
  const item = (next.sessions[action.sessionID] ??= { placement: "active", unread: false })
  if (action.type === "place") item.placement = action.placement
  if (action.type === "unread") item.unread = true
  if (action.type === "read" || action.type === "select") {
    item.unread = false
    item.seen = Math.max(item.seen ?? 0, action.observed)
  }
  if (action.type === "select") {
    // Opening a session inside a folded Parked section reveals it.
    // The server admits every selection, so check placement: an unparked selection leaves Parked folded.
    if (admission && item.placement === "parked")
      next.collapsed = next.collapsed.filter((key) => key !== parkedKey(admission.project))
    next.selected = action.sessionID
    next.recent = [action.sessionID, ...next.recent.filter((id) => id !== action.sessionID)].slice(0, 50)
    next.navigation++
  }
  return next
}

export function unread(session: Session, state: State) {
  const item = state.sessions[session.id]
  // A native view acknowledgment (a client displayed the result) also reads a
  // completion, so the conversation being watched does not turn unread. It never
  // clears the manual mark, which only a deliberate read/visit acknowledges.
  return Boolean(item?.unread || session.idle > Math.max(item?.seen ?? 0, session.viewed))
}

export function section(session: Session, state: State): Placement {
  return state.sessions[session.id]?.placement ?? "active"
}

export type Badge = { kind: "attention" | "running" | "unread"; count: number }

export type Row =
  | { kind: "heading"; key: string; title: string; closed: boolean; depth: number; badges: Badge[] }
  | { kind: "session"; session: Session; depth: number }

export function badges(sessions: Session[], state: State): Badge[] {
  const running = sessions.filter((session) => session.running || session.status === "Queued").length
  const unseen = sessions.filter((session) => unread(session, state)).length
  const blocked = sessions.filter(
    (session) => session.status === "Question" || session.status === "Approval",
  ).length
  return (
    [
      ["attention", blocked],
      ["running", running],
      ["unread", unseen],
    ] as const
  ).flatMap(([kind, count]) => (count ? [{ kind, count }] : []))
}

export function rowDetail(row: Row) {
  if (row.kind === "heading") return ""
  return row.session.detail === "main" ? "" : (row.session.detail.split("/").filter(Boolean).at(-1) ?? "")
}

/** Project → its unparked sessions, then one Parked fold. Projects show even before their sessions load. */
export function rows(sessions: Session[], state: State): Row[] {
  const working = workingSet(sessions, state)
  return Object.keys(state.projects)
    .filter((project) => state.projects[project]!.open)
    .sort((a, b) => state.projects[a]!.name.localeCompare(state.projects[b]!.name))
    .flatMap((project): Row[] => {
      const members = working.filter((session) => session.project === project)
      const closed = state.collapsed.includes(project)
      const result: Row[] = [
        {
          kind: "heading",
          key: project,
          closed,
          title: members[0]?.projectName ?? state.projects[project]!.name,
          depth: 0,
          badges: closed ? badges(members, state) : [],
        },
      ]
      if (closed) return result
      const parked = members.filter((session) => section(session, state) === "parked")
      result.push(
        ...members
          .filter((session) => section(session, state) === "active")
          .map((session): Row => ({ kind: "session", session, depth: 1 })),
      )
      if (!parked.length) return result
      const folded = state.collapsed.includes(parkedKey(project))
      result.push({
        kind: "heading",
        key: parkedKey(project),
        closed: folded,
        title: folded ? `Parked · ${parked.length}` : "Parked",
        depth: 1,
        // Parked work stays quiet; a folded project's badges still count it.
        badges: [],
      })
      if (!folded) result.push(...parked.map((session): Row => ({ kind: "session", session, depth: 2 })))
      return result
    })
}
