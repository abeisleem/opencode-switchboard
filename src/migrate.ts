import { z } from "zod"
import { stateSchema, type State } from "./model"

/**
 * One version's upgrade. `schema` is a frozen copy of the `from` version's shape, written out here and never
 * derived from the live `stateSchema`, so later edits to the model cannot change how old state parses.
 */
type Step = { from: number; to: number; schema: z.ZodType; up: (state: never) => unknown }

function step<S extends z.ZodType>(definition: {
  from: number
  to: number
  schema: S
  up: (state: z.infer<S>) => unknown
}): Step {
  return definition
}

const projectKey = z
  .string()
  .min(1)
  .refine((key) => !Object.hasOwn(Object.prototype, key), "Invalid project key")

// Versions 1 and 2. They differ only in fields the switchboard no longer reads (History in v1; view, search,
// and filter fields in v2), which the object schema strips.
const legacySchema = <V extends 1 | 2>(version: V) =>
  z.object({
    version: z.literal(version),
    revision: z.number(),
    navigation: z.number(),
    selected: z.string().nullable(),
    recent: z.array(z.string()),
    collapsed: z.array(z.string()),
    projects: z
      .record(projectKey, z.object({ name: z.string(), open: z.boolean(), sessions: z.array(z.string()) }))
      .default({}),
    sessions: z.record(
      z.string(),
      z.object({
        placement: z.enum(["focus", "active", "later", "history"]).default("active"),
        unread: z.boolean().default(false),
        seen: z.number().optional(),
      }),
    ),
  })

const v3Schema = z.object({
  version: z.literal(3),
  revision: z.number(),
  navigation: z.number(),
  selected: z.string().nullable(),
  recent: z.array(z.string()),
  collapsed: z.array(z.string()),
  projects: z
    .record(projectKey, z.object({ name: z.string(), open: z.boolean(), sessions: z.array(z.string()) }))
    .default({}),
  sessions: z.record(
    z.string(),
    z.object({
      placement: z.enum(["active", "later"]).default("active"),
      unread: z.boolean().default(false),
      seen: z.number().optional(),
    }),
  ),
})

/** Every upgrade, in order. A new version adds one step here and bumps `stateSchema.version`. */
export const steps: Step[] = [
  step({
    from: 1,
    to: 2,
    schema: legacySchema(1),
    up: (state) => ({ ...state, version: 2 }),
  }),
  // History becomes closed membership; Focus becomes Active.
  step({
    from: 2,
    to: 3,
    schema: legacySchema(2),
    up: (old) => {
      const histories = new Set(
        Object.entries(old.sessions)
          .filter(([, item]) => item.placement === "history")
          .map(([id]) => id),
      )
      // Don't close the conversation the user is currently viewing during migration.
      histories.delete(old.selected ?? "")
      const retired = new Set(
        Object.keys(old.projects).flatMap((id) => [`${id}/history`, `${id}/focus`, `${id}/active`]),
      )
      return {
        ...old,
        version: 3,
        projects: Object.fromEntries(
          Object.entries(old.projects).map(([id, project]) => [
            id,
            { ...project, sessions: project.sessions.filter((session) => !histories.has(session)) },
          ]),
        ),
        sessions: Object.fromEntries(
          Object.entries(old.sessions).map(([id, item]) => [
            id,
            { ...item, placement: item.placement === "later" ? "later" : "active" },
          ]),
        ),
        collapsed: old.collapsed.filter((key) => !retired.has(key)),
      }
    },
  }),
  // The Later section became Parked (0.1.5): the "later" placement becomes "parked". Its fold key also moved
  // from a "<project>/later" suffix to a "parked:<project>" prefix. A session outside a git repository uses its
  // directory as the project key, so "/a/later" could be both Later's fold under "/a" and the fold of a project
  // at "/a/later". Directory keys start with "/", so a prefixed key cannot equal a project key. Only keys whose
  // project is saved are mapped; every other key, including project folds, stays as it was.
  // The same release made the current session per TUI (issue #52): `selected`, `recent`, and `navigation` are
  // dropped here rather than in a step of their own, because no release saved version 4 with them.
  // It also made closing a session's row unpark it, so a session no project lists, open or closed, becomes
  // unparked here too; its unread mark and seen time stay.
  step({
    from: 3,
    to: 4,
    schema: v3Schema,
    up: ({ selected: _selected, recent: _recent, navigation: _navigation, ...old }) => {
      const listed = new Set(Object.values(old.projects).flatMap((project) => project.sessions))
      return {
        ...old,
        version: 4,
        sessions: Object.fromEntries(
          Object.entries(old.sessions).map(([id, item]) => [
            id,
            { ...item, placement: item.placement === "later" && listed.has(id) ? "parked" : "active" },
          ]),
        ),
        collapsed: old.collapsed.map((key) => {
          const project = key.endsWith("/later") ? key.slice(0, -"/later".length) : undefined
          return project !== undefined && Object.hasOwn(old.projects, project) ? `parked:${project}` : key
        }),
      }
    },
  }),
]

const current = stateSchema.shape.version.value

function versionOf(value: unknown) {
  if (typeof value === "object" && value !== null && "version" in value && typeof value.version === "number")
    return value.version
  throw new Error("Saved switchboard state has no version.")
}

/** Upgrades saved state from any earlier version. It never resets the user's organization; it fails instead. */
export function readState(value: unknown): State {
  let version = versionOf(value)
  if (version > current)
    throw new Error(
      `Saved switchboard state is version ${version}; this release reads up to ${current}. Update opencode-switchboard.`,
    )
  let state = value
  while (version < current) {
    const next = steps.find((candidate) => candidate.from === version)
    if (!next) throw new Error(`Saved switchboard state is version ${version}, which has no migration.`)
    state = next.up(next.schema.parse(state) as never)
    version = next.to
  }
  return stateSchema.parse(state)
}
