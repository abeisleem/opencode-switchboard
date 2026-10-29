import { z } from "zod"
import { sessionStateSchema, stateSchema, type State } from "./model"

// Versions 1 and 2 add History (v1), Focus, and view/search/filter fields, which
// the object schema strips. History becomes closed membership; Focus becomes Active.
const legacySchema = stateSchema.extend({
  version: z.union([z.literal(1), z.literal(2)]),
  sessions: z.record(
    z.string(),
    sessionStateSchema.extend({
      placement: z.enum(["focus", "active", "later", "history"]).default("active"),
    }),
  ),
})

export function readState(value: unknown): State {
  if (typeof value === "object" && value !== null && "version" in value && value.version === 3)
    return stateSchema.parse(value)
  const old = legacySchema.parse(value)
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
  return stateSchema.parse({
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
  })
}
