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
